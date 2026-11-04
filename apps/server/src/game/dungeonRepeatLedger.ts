import {
  DEFAULT_SKILL_SYSTEM_V3_RUNTIME_CAPABILITIES,
  KINGDOM_PERK_RESTLESS_HERDS_LOCKOUT_REDUCTION_DAYS,
  isGeneralSkillAvailable,
  type SkillSystemV3RuntimeCapabilities
} from "@ash-atlas/shared";
import type pg from "pg";

export type DungeonCompletion = Readonly<{
  completionKey: string;
  playerId: string;
  dungeonKey: string;
  sessionIdentity: string;
  delversLoreRank: number;
  cooldownDays: number;
  completedAt: Date;
  lockoutExpiresAt: Date;
  /**
   * A real clear, or a lockout from leaving a no-re-entry dungeon early (DROWNED_CITY_SPEC.md 2).
   * Early leaves share the table only for the lockout; they are never a clear.
   */
  kind: "clear" | "early_leave";
}>;

/** Completion keys of early-leave lockouts (the marker; no column is needed). */
export const EARLY_LEAVE_COMPLETION_PREFIX = "dungeon-left:";

type CompletionRow = {
  completion_key: string;
  player_id: string;
  dungeon_key: string;
  session_identity: string;
  delvers_lore_rank: number;
  cooldown_days: number;
  completed_at: Date;
  lockout_expires_at: Date;
};

export const DEFAULT_DUNGEON_LOCKOUT_DAYS = 6;

export class DungeonRepeatError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DungeonRepeatError";
  }
}

export class DungeonRepeatLedger {
  constructor(
    private readonly pool: pg.Pool,
    /** Delver's Lore is a hidden old skill unless the dev flag brings it back (isGeneralSkillAvailable). */
    private readonly capabilities: SkillSystemV3RuntimeCapabilities = DEFAULT_SKILL_SYSTEM_V3_RUNTIME_CAPABILITIES
  ) {}

  async recordCompletion(input: Readonly<{
    completionKey: string;
    playerId: string;
    dungeonKey: string;
    sessionIdentity: string;
    /** Lockout before Delver's Lore and Restless Herds reductions; defaults to 6 days. */
    baseCooldownDays?: number;
    /** Fixed lockout in hours; wins over baseCooldownDays and is not shortened by Delver's Lore. */
    lockoutHours?: number;
  }>): Promise<DungeonCompletion> {
    assertIdentity("completion key", input.completionKey);
    assertIdentity("player ID", input.playerId);
    assertIdentity("dungeon key", input.dungeonKey);
    assertIdentity("session identity", input.sessionIdentity);
    const baseCooldownDays = input.baseCooldownDays ?? DEFAULT_DUNGEON_LOCKOUT_DAYS;
    if (!Number.isInteger(baseCooldownDays) || baseCooldownDays < 1 || baseCooldownDays > 365) {
      throw new RangeError("Dungeon lockout must be a whole number of days between 1 and 365.");
    }
    const lockoutHours = input.lockoutHours ?? null;
    if (lockoutHours !== null && (!Number.isInteger(lockoutHours) || lockoutHours < 1 || lockoutHours > 168)) {
      throw new RangeError("Dungeon lockout must be a whole number of hours between 1 and 168.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<CompletionRow>(
        `INSERT INTO dungeon_completion_ledger (
           completion_key, player_id, dungeon_key, session_identity,
           delvers_lore_rank, cooldown_days, completed_at, lockout_expires_at
         )
         SELECT $1, $2, $3, $4, snapshot.rank,
                -- Hour lockouts store the 1-day column minimum; the expiry below is the real duration.
                CASE WHEN $6::int IS NOT NULL THEN 1
                     ELSE GREATEST(1, $5::int - GREATEST(snapshot.rank - 1, 0) - snapshot.restless_herds) END::smallint,
                now(),
                now() + CASE WHEN $6::int IS NOT NULL THEN make_interval(hours => $6::int)
                  ELSE make_interval(days =>
                    GREATEST(1, $5::int - GREATEST(snapshot.rank - 1, 0) - snapshot.restless_herds)) END
         FROM (
           SELECT COALESCE((
             SELECT rank FROM player_skill_ranks
             WHERE player_id=$2 AND skill_id='delvers_lore' AND $8::boolean
           ), 0)::smallint AS rank,
           -- Restless Herds (kingdom level 8 perk): a qualified member's day lockout is shorter.
           CASE WHEN EXISTS (
             SELECT 1 FROM kingdom_memberships membership
             JOIN kingdoms kingdom ON kingdom.id = membership.kingdom_id AND kingdom.status = 'active'
             JOIN kingdom_perk_selections_in_effect perk
               ON perk.kingdom_id = membership.kingdom_id AND perk.perk_id = 'restless_herds'
             WHERE membership.player_id = $2 AND membership.status = 'active'
               AND membership.perk_qualified_at <= now()
           ) THEN $7::int ELSE 0 END AS restless_herds
         ) snapshot
         ON CONFLICT DO NOTHING
         RETURNING completion_key, player_id, dungeon_key, session_identity,
                   delvers_lore_rank, cooldown_days, completed_at, lockout_expires_at`,
        [input.completionKey, input.playerId, input.dungeonKey, input.sessionIdentity, baseCooldownDays, lockoutHours,
          KINGDOM_PERK_RESTLESS_HERDS_LOCKOUT_REDUCTION_DAYS, isGeneralSkillAvailable("delvers_lore", this.capabilities)]
      );
      let row = inserted.rows[0];
      if (!row) {
        const keyed = await client.query<CompletionRow>(
          `${completionSelect} WHERE completion_key=$1`,
          [input.completionKey]
        );
        row = keyed.rows[0];
        if (row && !sameIdentity(row, input)) {
          throw new DungeonRepeatError(
            "DUNGEON_COMPLETION_IDENTITY_CONFLICT",
            "That dungeon completion key is already bound to a different completion."
          );
        }
        if (!row) {
          const session = await client.query<CompletionRow>(
            `${completionSelect}
             WHERE player_id=$1 AND dungeon_key=$2 AND session_identity=$3`,
            [input.playerId, input.dungeonKey, input.sessionIdentity]
          );
          row = session.rows[0];
        }
        if (!row) throw new Error("Dungeon completion conflict could not be resolved.");
      }
      await client.query("COMMIT");
      return completionFromRow(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Starts the lockout for a player who left a no-re-entry run before it was complete. Stored with
   * the early-leave key and its own session identity so it is never read as a clear.
   */
  async recordEarlyLeave(input: Readonly<{
    playerId: string;
    dungeonKey: string;
    runId: string;
    baseCooldownDays?: number;
    lockoutHours?: number;
  }>): Promise<DungeonCompletion> {
    return this.recordCompletion({
      completionKey: `${EARLY_LEAVE_COMPLETION_PREFIX}${input.runId}:${input.playerId}`,
      playerId: input.playerId,
      dungeonKey: input.dungeonKey,
      sessionIdentity: `left:${input.runId}`,
      ...(input.lockoutHours ? { lockoutHours: input.lockoutHours } : {}),
      ...(input.baseCooldownDays ? { baseCooldownDays: input.baseCooldownDays } : {})
    });
  }

  async activeLockout(playerId: string, dungeonKey: string): Promise<DungeonCompletion | null> {
    assertIdentity("player ID", playerId);
    assertIdentity("dungeon key", dungeonKey);
    const result = await this.pool.query<CompletionRow>(
      `${completionSelect}
       WHERE player_id=$1 AND dungeon_key=$2 AND lockout_expires_at > now()
       ORDER BY lockout_expires_at DESC LIMIT 1`,
      [playerId, dungeonKey]
    );
    return result.rows[0] ? completionFromRow(result.rows[0]) : null;
  }

  async authorizeEntry(playerId: string, dungeonKey: string): Promise<void> {
    const lockout = await this.activeLockout(playerId, dungeonKey);
    if (!lockout) return;
    const remaining = formatLockoutRemaining(lockout.lockoutExpiresAt.getTime() - Date.now());
    throw new DungeonRepeatError(
      "DUNGEON_REPEAT_COOLDOWN_ACTIVE",
      lockout.kind === "early_leave"
        ? `You left this dungeon before the end. You can enter again in ${remaining}.`
        : `You already cleared this dungeon. You can enter again in ${remaining}.`
    );
  }
}

export function formatLockoutRemaining(milliseconds: number): string {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

const completionSelect = `SELECT completion_key, player_id, dungeon_key, session_identity,
  delvers_lore_rank, cooldown_days, completed_at, lockout_expires_at
  FROM dungeon_completion_ledger`;

function sameIdentity(
  row: CompletionRow,
  input: Readonly<{ playerId: string; dungeonKey: string; sessionIdentity: string }>
): boolean {
  return row.player_id === input.playerId && row.dungeon_key === input.dungeonKey &&
    row.session_identity === input.sessionIdentity;
}

function completionFromRow(row: CompletionRow): DungeonCompletion {
  return {
    completionKey: row.completion_key,
    playerId: row.player_id,
    dungeonKey: row.dungeon_key,
    sessionIdentity: row.session_identity,
    delversLoreRank: Number(row.delvers_lore_rank),
    cooldownDays: Number(row.cooldown_days),
    completedAt: new Date(row.completed_at),
    lockoutExpiresAt: new Date(row.lockout_expires_at),
    kind: row.completion_key.startsWith(EARLY_LEAVE_COMPLETION_PREFIX) ? "early_leave" : "clear"
  };
}

function assertIdentity(label: string, value: string): void {
  if (value.length < 1 || value.length > 200) {
    throw new DungeonRepeatError("INVALID_DUNGEON_COMPLETION_IDENTITY", `Invalid ${label}.`);
  }
}
