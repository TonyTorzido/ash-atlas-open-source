import { SIEGE_ATTACK_RANGE_METERS } from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import { isSettledNow } from "./settlement.js";
import { isTrustReviewAccount, type TrustReviewConfig } from "./trustReviewAccounts.js";
import { noopTrustSignalSink, type TrustSignalSink } from "./trustService.js";

// Hostile-action gate (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md 3.4,
// owner decision 2026-10-02). A status gate, never a location check: an account
// that is not Settled cannot hit players, burn/attack other players' flags or
// give hostile military orders, and no player can hit it (two-way shield).
// TRUST_HOSTILE_GATE_MODE: shadow records signals only; enforce refuses.
// Database failures fail open, like the other trust gates.

export const HOSTILE_UNSETTLED_CODE = "HOSTILE_UNSETTLED";
// Numberless copy: thresholds are secret.
export const HOSTILE_UNSETTLED_ACTOR_MESSAGE =
  "You can't attack until you've settled in. Keep playing from your home area.";
export const HOSTILE_SHIELDED_TARGET_MESSAGE =
  "This player is still settling in and can't be attacked yet.";

export const HOSTILE_SIGNAL_WEIGHTS = {
  // Unsettled actor attempted a hostile action (per account per day).
  hostile_unsettled: 0.25,
  // A Settled player attacked a shielded (unsettled) player: review data only.
  hostile_shielded_target: 0
} as const;

const STATUS_TTL_MS = 30_000;
const MAX_CACHED_PLAYERS = 50_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Future designated PvP arenas (not built): the one place unsettled players
 * may fight. Every PvP shield check goes through here so an arena can exempt
 * itself later without touching the gate.
 */
export function isPvpArenaZone(input: Readonly<{ attackerPlayerId: string; targetPlayerId: string }>): boolean {
  void input;
  return false;
}

export type HostilePlayerStatus = Readonly<{
  accountId: string | null;
  settledAt: Date | null;
  provisionalUntil: Date | null;
  devProfile: boolean;
}>;

export type HostileMilitaryOrder =
  | "deploy"
  | "defend"
  | "fire_volley"
  | "demolish_flag"
  | "attack_group"
  | "attack_siege";

export interface HostileGateStore {
  loadPlayerStatus(playerId: string): Promise<HostilePlayerStatus | null>;
  playerOwnsFlag(playerId: string, flagId: string): Promise<boolean>;
  militaryGroupUnitType(playerId: string, groupId: string): Promise<string | null>;
  // True when another player's deployed Siege group is within Siege range of a
  // flag this player owns (defending your own flags is not hostile).
  siegeThreatensOwnFlag(playerId: string, groupId: string): Promise<boolean>;
}

export type HostileDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; code: typeof HOSTILE_UNSETTLED_CODE; message: string; role: "actor" | "target" }>;

export type HostileGateConfig = Pick<AppConfig, "TRUST_HOSTILE_GATE_MODE"> & TrustReviewConfig;

const ALLOWED: HostileDecision = { allowed: true };

type CachedStatus = { status: HostilePlayerStatus | null; loadedAtMs: number };

export class HostileActionGate {
  private readonly cache = new Map<string, CachedStatus>();
  private readonly hydrations = new Map<string, Promise<CachedStatus>>();
  private readonly sink: TrustSignalSink;
  private readonly logger: Pick<AppLogger, "warn"> | undefined;
  private readonly now: () => Date;
  private readonly devProfilesExempt: () => boolean;

  constructor(
    private readonly store: HostileGateStore,
    private readonly config: HostileGateConfig,
    options: Readonly<{
      sink?: TrustSignalSink;
      logger?: Pick<AppLogger, "warn">;
      now?: () => Date;
      // True while developer login is enabled: dev profiles are never shielded or gated.
      devProfilesExempt?: () => boolean;
    }> = {}
  ) {
    this.sink = options.sink ?? noopTrustSignalSink;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.devProfilesExempt = options.devProfilesExempt ?? (() => false);
  }

  get mode(): AppConfig["TRUST_HOSTILE_GATE_MODE"] {
    return this.config.TRUST_HOSTILE_GATE_MODE;
  }

  /** Loads a player's status into the synchronous cache (session start). */
  prime(playerId: string): void {
    if (this.mode === "off") return;
    void this.status(playerId);
  }

  /** Re-reads every cached player of the account (Settled gained or lost). */
  refreshAccount(accountId: string): void {
    for (const [playerId, entry] of this.cache) {
      if (entry.status?.accountId === accountId) {
        this.cache.delete(playerId);
        void this.status(playerId);
      }
    }
  }

  /**
   * Synchronous combat check (every PvP hit, ability and area effect): true
   * refuses player-versus-player damage in enforce. A player not yet in the
   * cache is loaded in the background and allowed meanwhile (fail open).
   */
  pvpBlocked(attackerPlayerId: string, targetPlayerId: string): boolean {
    if (this.mode !== "enforce" || attackerPlayerId === targetPlayerId) return false;
    if (isPvpArenaZone({ attackerPlayerId, targetPlayerId })) return false;
    return this.cachedShielded(attackerPlayerId) || this.cachedShielded(targetPlayerId);
  }

  /**
   * Synchronous combat check: true when this player's heals and buffs must not
   * reach another player who is fighting players (an unhittable healer would
   * otherwise decide PvP fights). PvE support is untouched.
   */
  pvpSupportRestricted(playerId: string): boolean {
    if (this.mode !== "enforce") return false;
    return this.cachedShielded(playerId);
  }

  /** Player attack (START_ATTACK or a military attack on a player). */
  async checkPvp(input: Readonly<{ attackerPlayerId: string; targetPlayerId: string }>): Promise<HostileDecision> {
    const mode = this.mode;
    if (mode === "off" || input.attackerPlayerId === input.targetPlayerId) return ALLOWED;
    if (isPvpArenaZone(input)) return ALLOWED;
    const [attacker, target] = await Promise.all([
      this.status(input.attackerPlayerId),
      this.status(input.targetPlayerId)
    ]);
    const day = this.day();
    if (attacker && this.shielded(attacker)) {
      this.signal(attacker.accountId!, "hostile_unsettled", `hostile_unsettled:${attacker.accountId}:${day}`, {
        action: "pvp",
        mode
      });
      return mode === "enforce" ? this.refusal("actor") : ALLOWED;
    }
    if (target && this.shielded(target)) {
      if (attacker?.accountId) {
        this.signal(
          attacker.accountId,
          "hostile_shielded_target",
          `hostile_shielded_target:${attacker.accountId}:${target.accountId}:${day}`,
          { targetAccountId: target.accountId, mode }
        );
      }
      return mode === "enforce" ? this.refusal("target") : ALLOWED;
    }
    return ALLOWED;
  }

  /** Flag burn/attack: unsettled accounts may only act on their own flags. */
  async checkFlagRaid(input: Readonly<{
    playerId: string;
    flagId: string;
    action: "flag_burn" | "flag_attack";
  }>): Promise<HostileDecision> {
    const mode = this.mode;
    if (mode === "off") return ALLOWED;
    try {
      const actor = await this.status(input.playerId);
      if (!actor || !this.shielded(actor)) return ALLOWED;
      if (UUID_PATTERN.test(input.flagId) && await this.store.playerOwnsFlag(input.playerId, input.flagId)) {
        return ALLOWED;
      }
      this.signal(actor.accountId!, "hostile_unsettled", `hostile_unsettled:${actor.accountId}:${this.day()}`, {
        action: input.action,
        flagId: input.flagId,
        mode
      });
      return mode === "enforce" ? this.refusal("actor") : ALLOWED;
    } catch (error) {
      this.logger?.warn({ err: error, playerId: input.playerId }, "Hostile-action gate could not check a flag raid");
      return ALLOWED;
    }
  }

  /**
   * Hostile military orders. Deploy/Defend start automatic Siege fire, so they
   * are hostile only for Siege groups; attacking a Siege is defence (allowed)
   * when it threatens one of the actor's own flags; attacks on players go
   * through checkPvp.
   */
  async checkMilitaryOrder(input: Readonly<{
    playerId: string;
    order: HostileMilitaryOrder;
    groupId: string;
  }>): Promise<HostileDecision> {
    const mode = this.mode;
    if (mode === "off") return ALLOWED;
    try {
      const actor = await this.status(input.playerId);
      if (!actor || !this.shielded(actor)) return ALLOWED;
      if (input.order === "deploy" || input.order === "defend") {
        if (!UUID_PATTERN.test(input.groupId)) return ALLOWED;
        const unitType = await this.store.militaryGroupUnitType(input.playerId, input.groupId);
        if (unitType !== "field_ballista") return ALLOWED;
      }
      if (input.order === "attack_group") return ALLOWED;
      if (input.order === "attack_siege") {
        if (!UUID_PATTERN.test(input.groupId)) return ALLOWED;
        if (await this.store.siegeThreatensOwnFlag(input.playerId, input.groupId)) return ALLOWED;
      }
      this.signal(actor.accountId!, "hostile_unsettled", `hostile_unsettled:${actor.accountId}:${this.day()}`, {
        action: `military_${input.order}`,
        mode
      });
      return mode === "enforce" ? this.refusal("actor") : ALLOWED;
    } catch (error) {
      this.logger?.warn({ err: error, playerId: input.playerId }, "Hostile-action gate could not check a military order");
      return ALLOWED;
    }
  }

  /**
   * Background Siege volleys (military reconciler): false holds the owner's
   * automatic fire in enforce while the account is not Settled, including
   * Sieges deployed before Settled was lost or the gate was enforced. Shadow
   * only signals; failures fail open.
   */
  async automaticFireAllowed(ownerPlayerId: string): Promise<boolean> {
    const mode = this.mode;
    if (mode === "off") return true;
    const owner = await this.status(ownerPlayerId);
    if (!owner || !this.shielded(owner)) return true;
    this.signal(owner.accountId!, "hostile_unsettled", `hostile_unsettled:${owner.accountId}:${this.day()}`, {
      action: "military_auto_volley",
      mode
    });
    return mode !== "enforce";
  }

  private refusal(role: "actor" | "target"): HostileDecision {
    return {
      allowed: false,
      code: HOSTILE_UNSETTLED_CODE,
      message: role === "actor" ? HOSTILE_UNSETTLED_ACTOR_MESSAGE : HOSTILE_SHIELDED_TARGET_MESSAGE,
      role
    };
  }

  private shielded(status: HostilePlayerStatus): boolean {
    if (!status.accountId) return false;
    if (status.devProfile && this.devProfilesExempt()) return false;
    if (isTrustReviewAccount(this.config, status.accountId)) return false;
    return !isSettledNow(status, this.now());
  }

  private cachedShielded(playerId: string): boolean {
    const entry = this.cache.get(playerId);
    if (!entry || this.now().getTime() - entry.loadedAtMs >= STATUS_TTL_MS) void this.status(playerId);
    return entry?.status ? this.shielded(entry.status) : false;
  }

  // Cached status; a failed read is cached as unknown (not shielded) so the
  // database is not hammered and the gate fails open.
  private async status(playerId: string): Promise<HostilePlayerStatus | null> {
    const cached = this.cache.get(playerId);
    if (cached && this.now().getTime() - cached.loadedAtMs < STATUS_TTL_MS) return cached.status;
    let pending = this.hydrations.get(playerId);
    if (!pending) {
      pending = this.store.loadPlayerStatus(playerId)
        .catch((error: unknown) => {
          this.logger?.warn({ err: error, playerId }, "Hostile-action gate could not load player status");
          return null;
        })
        .then((status) => {
          if (!this.cache.has(playerId) && this.cache.size >= MAX_CACHED_PLAYERS) this.cache.clear();
          const entry = { status, loadedAtMs: this.now().getTime() };
          this.cache.set(playerId, entry);
          return entry;
        })
        .finally(() => this.hydrations.delete(playerId));
      this.hydrations.set(playerId, pending);
    }
    return (await pending).status;
  }

  private day(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private signal(
    accountId: string,
    rule: keyof typeof HOSTILE_SIGNAL_WEIGHTS,
    dedupeKey: string,
    metadata: Record<string, unknown>
  ): void {
    void this.sink.recordSignals({
      accountId,
      signals: [{ rule, weight: HOSTILE_SIGNAL_WEIGHTS[rule], metadata: { ...metadata, dedupeKey } }]
    }).catch((error: unknown) => {
      this.logger?.warn({ err: error, accountId, rule }, "Hostile-action trust signal could not be recorded");
    });
  }
}

export class PostgresHostileGateStore implements HostileGateStore {
  constructor(private readonly pool: pg.Pool) {}

  async loadPlayerStatus(playerId: string): Promise<HostilePlayerStatus | null> {
    const result = await this.pool.query<{
      account_id: string | null;
      settled_at: Date | null;
      provisional_until: Date | null;
      dev_profile: boolean;
    }>(
      `SELECT p.account_id, st.settled_at, st.provisional_until,
              EXISTS (
                SELECT 1 FROM account_identities i
                 WHERE i.account_id = p.account_id
                   AND i.provider_subject LIKE 'ash-atlas-dev:%'
              ) AS dev_profile
         FROM players p
         LEFT JOIN account_settlement st ON st.account_id = p.account_id
        WHERE p.id = $1`,
      [playerId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      accountId: row.account_id,
      settledAt: row.settled_at,
      provisionalUntil: row.provisional_until,
      devProfile: row.dev_profile
    };
  }

  async playerOwnsFlag(playerId: string, flagId: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM flags WHERE id = $1::uuid AND owner_id = $2", [flagId, playerId]);
    return (result.rowCount ?? 0) > 0;
  }

  async militaryGroupUnitType(playerId: string, groupId: string): Promise<string | null> {
    const result = await this.pool.query<{ unit_type: string }>(
      "SELECT unit_type FROM military_unit_groups WHERE group_id = $1::uuid AND owner_player_id = $2",
      [groupId, playerId]
    );
    return result.rows[0]?.unit_type ?? null;
  }

  async siegeThreatensOwnFlag(playerId: string, groupId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
         FROM military_unit_groups g
         JOIN flags f ON f.owner_id = $2
        WHERE g.group_id = $1::uuid
          AND g.owner_player_id <> $2
          AND g.lat IS NOT NULL AND g.lon IS NOT NULL
          AND ST_DWithin(
                f.geom::geography,
                ST_SetSRID(ST_MakePoint(g.lon::double precision, g.lat::double precision), 4326)::geography,
                $3::double precision)
        LIMIT 1`,
      // Same superset as the Siege target query (ellipsoid vs sphere tolerance).
      [groupId, playerId, SIEGE_ATTACK_RANGE_METERS + 5]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
