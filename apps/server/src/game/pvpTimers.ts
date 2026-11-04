import {
  AGGRESSIVE_FLAG_TRAVEL_LOCK_MS,
  PVP_AGGRESSOR_MARK_MS,
  PVP_DEFEAT_SAFETY_MS,
  PVP_STRIKE_BLOCK_MS,
  type PvpTimerEntry
} from "@ash-atlas/shared";
import type pg from "pg";

/**
 * Persisted kinds (holder is always the victim, other the player who hit them):
 *   aggressor:    holder may attack other (other struck holder).
 *   strike_block: other cannot attack holder (other used their one swing).
 */
type TimerKind = "aggressor" | "strike_block";

type Queryable = Pick<pg.Pool, "query">;

type Logger = { warn(object: unknown, message: string): void };

/**
 * A first strike just marked an aggressor; sent to both sides. "engaged" is
 * the attacker's side when the target was Aggressive, so the strike started a
 * fight instead of a one-swing block.
 */
export type PvpTimerNotice = Readonly<{
  kind: "struck" | "struck_by" | "engaged";
  otherPlayerId: string;
}>;

/** Persist a refreshed mark only when it moved at least this far (fights refresh on every hit). */
const MARK_PERSIST_GRANULARITY_MS = 60_000;

/**
 * Authoritative PvP strike-block rule between pairs of players.
 *
 * The combat engine asks synchronously, so timers live in memory. Strike
 * blocks and aggressor marks are also written to player_pvp_timers (writes
 * are serialized in order, off the combat tick) and reloaded on start, so a
 * restart keeps them. Fights are memory only and last as long as the combat
 * aggression timer between the pair: every landed hit extends the fight to
 * the hitter's new aggressive-until time. A restart ends every fight, which
 * can only put a strike block back in force early.
 *
 * Post-kill safety: a player killed by a player is safe from every player
 * for 20 hours (player_pvp_defeat_safety, reloaded on start). The combat
 * engine lifts it, like every 20-hour refusal, while the player is Aggressive.
 *
 * Only the strike-block rule lives here. The trust shield, the land-action guard,
 * arrival protection, and zone/region rules are checked elsewhere and are
 * never bypassed.
 */
export class PvpTimerService {
  /** Unordered pair key -> aggression expiry ms of the fight between them. */
  private readonly fights = new Map<string, number>();
  /** `${holder}|${other}` -> expiry ms. */
  private readonly timers: Record<TimerKind, Map<string, number>> = {
    aggressor: new Map(),
    strike_block: new Map()
  };
  private readonly persistedMarkExpiry = new Map<string, number>();
  /** Player id -> expiry ms of their post-kill safety. */
  private readonly defeatSafety = new Map<string, number>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly pool: Queryable,
    private readonly options: Readonly<{
      now?: () => number;
      logger?: Logger;
      /** Called with every player whose visible timers changed. */
      onChange?: (playerIds: readonly string[], notices: ReadonlyMap<string, PvpTimerNotice>) => void;
    }> = {}
  ) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  async load(): Promise<void> {
    await this.pool.query("DELETE FROM player_pvp_timers WHERE expires_at <= now()");
    const rows = await this.pool.query<{
      holder_player_id: string; other_player_id: string; kind: TimerKind; expires_ms: string;
    }>(
      `SELECT holder_player_id, other_player_id, kind,
              (extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_ms
       FROM player_pvp_timers`
    );
    for (const row of rows.rows) {
      const key = pairKey(row.holder_player_id, row.other_player_id);
      this.timers[row.kind].set(key, Number(row.expires_ms));
      if (row.kind === "aggressor") this.persistedMarkExpiry.set(key, Number(row.expires_ms));
    }
    await this.pool.query("DELETE FROM player_pvp_defeat_safety WHERE expires_at <= now()");
    const safety = await this.pool.query<{ player_id: string; expires_ms: string }>(
      `SELECT player_id, (extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_ms
       FROM player_pvp_defeat_safety`
    );
    for (const row of safety.rows) this.defeatSafety.set(row.player_id, Number(row.expires_ms));
  }

  /**
   * A landed PvP hit. aggressiveUntilMs is the attacker's combat aggression
   * expiry after this hit; a fight between the pair lasts until then.
   * targetAggressive is whether the target was Aggressive when the hit landed:
   * an Aggressive target hits back automatically, so a first strike starts a
   * fight (the attacker is still marked) instead of a one-swing block.
   */
  recordHit(attackerId: string, targetId: string, aggressiveUntilMs?: number, targetAggressive = false): void {
    if (attackerId === targetId) return;
    const now = this.now();
    const aggressionEndsAt = Math.max(now + 1, aggressiveUntilMs ?? now + AGGRESSIVE_FLAG_TRAVEL_LOCK_MS);
    const fightKey = unorderedKey(attackerId, targetId);
    const retaliating = this.remaining("aggressor", attackerId, targetId) !== null;
    if (this.fightActive(fightKey, now)) {
      this.fights.set(fightKey, Math.max(this.fights.get(fightKey)!, aggressionEndsAt));
      // The original aggressor's mark keeps running while they keep hitting.
      if (!retaliating) this.setMark(targetId, attackerId, now + PVP_AGGRESSOR_MARK_MS);
      return;
    }
    if (retaliating) {
      // The victim struck back at a marked aggressor: a real fight starts.
      this.fights.set(fightKey, aggressionEndsAt);
      this.changed([attackerId, targetId]);
      return;
    }
    if (targetAggressive) {
      // The target was already Aggressive and hits back: a fight, no strike block.
      this.fights.set(fightKey, aggressionEndsAt);
      this.setMark(targetId, attackerId, now + PVP_AGGRESSOR_MARK_MS);
      this.changed([attackerId, targetId], new Map([
        [attackerId, { kind: "engaged", otherPlayerId: targetId }],
        [targetId, { kind: "struck_by", otherPlayerId: attackerId }]
      ]));
      return;
    }
    // A first strike on a player who is not fighting back: one swing.
    this.setMark(targetId, attackerId, now + PVP_AGGRESSOR_MARK_MS);
    this.grant("strike_block", targetId, attackerId, now + PVP_STRIKE_BLOCK_MS);
    this.changed([attackerId, targetId], new Map([
      [attackerId, { kind: "struck", otherPlayerId: targetId }],
      [targetId, { kind: "struck_by", otherPlayerId: attackerId }]
    ]));
  }

  /**
   * A player death ends that player's fights. Marks and blocks keep running
   * (the marks are the revenge). A death at a player's hands also starts the
   * victim's 20-hour post-kill safety.
   */
  recordDeath(victimId: string, killerPlayerId: string | null = null): void {
    const changed = new Set<string>();
    if (killerPlayerId !== null && killerPlayerId !== victimId) {
      const expiresAt = this.now() + PVP_DEFEAT_SAFETY_MS;
      this.defeatSafety.set(victimId, expiresAt);
      this.write(
        `INSERT INTO player_pvp_defeat_safety (player_id, expires_at)
         VALUES ($1, to_timestamp($2::double precision / 1000))
         ON CONFLICT (player_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = now()`,
        [victimId, expiresAt]
      );
      changed.add(victimId);
    }
    for (const key of [...this.fights.keys()]) {
      const [a, b] = key.split("|") as [string, string];
      if (a !== victimId && b !== victimId) continue;
      this.fights.delete(key);
      changed.add(a);
      changed.add(b);
    }
    if (changed.size > 0) this.changed([...changed]);
  }

  /** Ends fights whose aggression has dropped and tells both players. Call on a short interval. */
  sweep(): void {
    const now = this.now();
    const changed = new Set<string>();
    for (const [key, expiresAt] of [...this.fights]) {
      if (expiresAt > now) continue;
      this.fights.delete(key);
      const [a, b] = key.split("|") as [string, string];
      changed.add(a);
      changed.add(b);
    }
    if (changed.size > 0) this.changed([...changed]);
  }

  /**
   * Remaining ms of the attacker's strike block against the target when it
   * refuses the attack, else null. The block yields while the two are fighting
   * and never stops the target from attacking a marked aggressor.
   */
  strikeBlockMs(attackerId: string, targetId: string): number | null {
    const block = this.remaining("strike_block", targetId, attackerId);
    if (block === null) return null;
    if (this.remaining("aggressor", attackerId, targetId) !== null) return null;
    if (this.fightActive(unorderedKey(attackerId, targetId), this.now())) return null;
    return block;
  }

  /** Remaining ms of this player's post-kill safety, else null (the engine lifts it while they are Aggressive). */
  defeatSafetyMs(playerId: string): number | null {
    const expiresAt = this.defeatSafety.get(playerId);
    if (expiresAt === undefined) return null;
    const left = expiresAt - this.now();
    if (left > 0) return left;
    this.defeatSafety.delete(playerId);
    return null;
  }

  isFighting(a: string, b: string): boolean {
    return this.fightActive(unorderedKey(a, b), this.now());
  }

  /** Every unexpired timer this player is part of, from their point of view (names filled by the caller). */
  timersFor(playerId: string): Array<Omit<PvpTimerEntry, "displayName">> {
    const entries: Array<Omit<PvpTimerEntry, "displayName">> = [];
    const now = this.now();
    for (const [key, expiresAt] of this.timers.aggressor) {
      if (expiresAt <= now) continue;
      const [holder, other] = key.split("|") as [string, string];
      if (holder === playerId) entries.push({ kind: "aggressor", playerId: other, expiresAt });
      else if (other === playerId) entries.push({ kind: "marked", playerId: holder, expiresAt });
    }
    for (const [key, expiresAt] of this.timers.strike_block) {
      if (expiresAt <= now) continue;
      const [holder, other] = key.split("|") as [string, string];
      if (other === playerId) entries.push({ kind: "cannot_attack", playerId: holder, expiresAt });
    }
    for (const [key, expiresAt] of this.fights) {
      if (expiresAt <= now) continue;
      const [a, b] = key.split("|") as [string, string];
      if (a === playerId) entries.push({ kind: "fighting", playerId: b, expiresAt });
      else if (b === playerId) entries.push({ kind: "fighting", playerId: a, expiresAt });
    }
    return entries;
  }

  /** Resolves once every queued database write has finished (tests and shutdown). */
  flush(): Promise<void> { return this.writes; }

  private fightActive(key: string, now: number): boolean {
    const expiresAt = this.fights.get(key);
    return expiresAt !== undefined && expiresAt > now;
  }

  private remaining(kind: TimerKind, holder: string, other: string): number | null {
    const key = pairKey(holder, other);
    const expiresAt = this.timers[kind].get(key);
    if (expiresAt === undefined) return null;
    const left = expiresAt - this.now();
    if (left > 0) return left;
    this.timers[kind].delete(key);
    if (kind === "aggressor") this.persistedMarkExpiry.delete(key);
    return null;
  }

  private setMark(holder: string, other: string, expiresAt: number): void {
    const key = pairKey(holder, other);
    this.timers.aggressor.set(key, expiresAt);
    const persisted = this.persistedMarkExpiry.get(key);
    if (persisted !== undefined && expiresAt - persisted < MARK_PERSIST_GRANULARITY_MS) return;
    this.persistedMarkExpiry.set(key, expiresAt);
    this.persist("aggressor", holder, other, expiresAt);
  }

  private grant(kind: TimerKind, holder: string, other: string, expiresAt: number): void {
    this.timers[kind].set(pairKey(holder, other), expiresAt);
    this.persist(kind, holder, other, expiresAt);
  }

  private persist(kind: TimerKind, holder: string, other: string, expiresAt: number): void {
    this.write(
      `INSERT INTO player_pvp_timers (holder_player_id, other_player_id, kind, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000))
       ON CONFLICT (holder_player_id, other_player_id, kind)
       DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [holder, other, kind, expiresAt]
    );
  }

  private write(sql: string, values: unknown[]): void {
    this.writes = this.writes
      .then(async () => { await this.pool.query(sql, values); })
      .catch((error: unknown) => this.options.logger?.warn({ err: error }, "failed to persist PvP timer"));
  }

  private changed(playerIds: readonly string[], notices: ReadonlyMap<string, PvpTimerNotice> = new Map()): void {
    try {
      this.options.onChange?.(playerIds, notices);
    } catch (error) {
      this.options.logger?.warn({ err: error }, "PvP timer change observer failed");
    }
  }
}

function pairKey(holder: string, other: string): string { return `${holder}|${other}`; }

function unorderedKey(a: string, b: string): string { return a < b ? `${a}|${b}` : `${b}|${a}`; }
