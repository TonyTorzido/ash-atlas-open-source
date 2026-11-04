import {
  GENERAL_SKILL_IDS,
  SKILL_POINT_CHARACTER_LEVEL_CAP,
  SKILL_SYSTEM_V3_CLASS_TECHNIQUE_DEFINITIONS,
  TECHNIQUE_BY_ID,
  LAUNCH_SPECIALIZATION_IDS,
  SPECIALIZATION_IDS,
  WORLD_KNOWLEDGE_SKILL_IDS,
  DEFAULT_SKILL_SYSTEM_V3_RUNTIME_CAPABILITIES,
  isGeneralSkillAvailable,
  isSpecializationAvailable,
  type GeneralActiveLoadout,
  type GeneralSkillId,
  type SkillSystemV3RuntimeCapabilities,
  type SkillSystemV3Snapshot,
  type SpecializationId
} from "@ash-atlas/shared";
import type pg from "pg";

export type SkillQueryable = Pick<pg.PoolClient, "query">;

export type SkillPointStateRow = {
  player_id: string;
  total_earned: number;
  total_spent: number;
  revision: string | number;
};

type GeneralRankRow = {
  skill_id: string;
  rank: number;
  points_spent: number;
  grandfathered: boolean;
};

type SpecializationRankRow = {
  specialization_id: string;
  rank: number;
  points_spent: number;
  grandfathered: boolean;
};

type SkillOperationRow = {
  player_id: string;
  action: string;
  payload: unknown;
  result: SkillMutationResult | null;
  completed_at: Date | string | null;
};

export type SkillMutationResult = Readonly<{
  requestId: string;
  replayed: boolean;
  snapshot: SkillSystemV3Snapshot;
  replacementAudit?: Readonly<{ priorClassId: SpecializationId; refundedPoints: number }>;
}>;

export class SkillRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SkillRequestError";
  }
}

export function skillOperationKey(playerId: string, requestId: string): string {
  if (!requestId || requestId.length > 128) {
    throw new SkillRequestError("SKILL_REQUEST_ID_INVALID", "Skill request id must contain 1 through 128 characters");
  }
  return `skill:${playerId}:${requestId}`;
}

export function validateExpectedRevision(expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new SkillRequestError("SKILL_REVISION_INVALID", "Expected skill revision must be a nonnegative safe integer");
  }
}

export async function ensureSkillAuthorityRows(
  queryable: SkillQueryable,
  playerId: string
): Promise<void> {
  await queryable.query(
    `INSERT INTO player_skill_point_state (player_id, total_earned, total_spent)
     SELECT progression.player_id, LEAST(25, GREATEST(0, progression.level)), 0
     FROM player_progression_profiles AS progression
     WHERE progression.player_id = $1
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId]
  );
  await queryable.query(
    `INSERT INTO player_specialization_state (player_id)
     SELECT $1 WHERE EXISTS (SELECT 1 FROM player_skill_point_state WHERE player_id = $1)
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId]
  );
  await queryable.query(
    `INSERT INTO player_general_active_loadouts (player_id)
     SELECT $1 WHERE EXISTS (SELECT 1 FROM player_skill_point_state WHERE player_id = $1)
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId]
  );
  await queryable.query(
    `INSERT INTO player_skill_runtime (player_id)
     SELECT $1 WHERE EXISTS (SELECT 1 FROM player_skill_point_state WHERE player_id = $1)
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId]
  );
}

/**
 * Rank rows this server hides (the old combat skills and the old classes; see isGeneralSkillAvailable and
 * isSpecializationAvailable). The rows stay in the database untouched; reads ignore them, so they give no effect
 * and the Skill Points spent on them count as available. The dev flag (fullClassRosterEnabled) empties both lists,
 * which brings the rows and their spent points straight back.
 */
export function hiddenSkillRankIds(
  capabilities: SkillSystemV3RuntimeCapabilities = DEFAULT_SKILL_SYSTEM_V3_RUNTIME_CAPABILITIES
): Readonly<{ general: readonly GeneralSkillId[]; specializations: readonly SpecializationId[] }> {
  return {
    general: GENERAL_SKILL_IDS.filter((id) => !isGeneralSkillAvailable(id, capabilities)),
    specializations: SPECIALIZATION_IDS.filter((id) => !isSpecializationAvailable(id, capabilities))
  };
}

/** Skill Points spent on rank rows this server does not hide ($1 player, $2 hidden general ids, $3 hidden class ids). */
export const VISIBLE_SPENT_POINTS_SQL = `(
       COALESCE((SELECT SUM(points_spent) FROM player_skill_ranks
                 WHERE player_id = $1 AND NOT (skill_id = ANY($2::text[]))), 0)
       + COALESCE((SELECT SUM(points_spent) FROM player_specialization_ranks
                   WHERE player_id = $1 AND NOT (specialization_id = ANY($3::text[]))), 0)
     )`;

export async function lockAndReconcileSkillPointState(
  queryable: SkillQueryable,
  playerId: string,
  capabilities: SkillSystemV3RuntimeCapabilities = DEFAULT_SKILL_SYSTEM_V3_RUNTIME_CAPABILITIES
): Promise<SkillPointStateRow> {
  const locked = await queryable.query<SkillPointStateRow & { character_level: number }>(
    `SELECT state.player_id, state.total_earned, state.total_spent, state.revision,
            progression.level AS character_level
     FROM player_skill_point_state AS state
     JOIN player_progression_profiles AS progression ON progression.player_id = state.player_id
     WHERE state.player_id = $1 FOR UPDATE OF state`,
    [playerId]
  );
  const row = locked.rows[0];
  if (!row) throw new SkillRequestError("SKILL_PLAYER_NOT_FOUND", "Player skill authority does not exist");
  const levelEntitlement = Math.min(SKILL_POINT_CHARACTER_LEVEL_CAP, Math.max(0, Number(row.character_level)));
  // Points on hidden rank rows read as available (the rows themselves are kept; see hiddenSkillRankIds).
  const hidden = hiddenSkillRankIds(capabilities);
  const spent = await queryable.query<{ total_spent: string | number }>(
    `SELECT ${VISIBLE_SPENT_POINTS_SQL} AS total_spent`,
    [playerId, hidden.general, hidden.specializations]
  );
  const totalSpent = Number(spent.rows[0]?.total_spent ?? 0);
  const totalEarned = Math.max(levelEntitlement, totalSpent);
  await queryable.query(
    `UPDATE player_specialization_state AS state
     SET active_specialization_id = state.committed_specialization_id,
         revision = state.revision + 1
     WHERE state.player_id = $1
       AND state.active_specialization_id IS NULL
       AND state.committed_specialization_id = ANY($2::text[])
       AND EXISTS (
         SELECT 1 FROM player_specialization_ranks AS ranks
         WHERE ranks.player_id = state.player_id
           AND ranks.specialization_id = state.committed_specialization_id
           AND ranks.rank > 0
       )`,
    [playerId, LAUNCH_SPECIALIZATION_IDS]
  );
  if (Number(row.total_earned) !== totalEarned || Number(row.total_spent) !== totalSpent) {
    const updated = await queryable.query<SkillPointStateRow>(
      `UPDATE player_skill_point_state
       SET total_earned = $2, total_spent = $3, revision = revision + 1
       WHERE player_id = $1
       RETURNING player_id, total_earned, total_spent, revision`,
      [playerId, totalEarned, totalSpent]
    );
    return requireRow(updated.rows[0], "Skill point state reconciliation failed");
  }
  return row;
}

export async function loadSkillSnapshot(
  queryable: SkillQueryable,
  playerId: string,
  capabilities: SkillSystemV3RuntimeCapabilities & Readonly<{ fullBuildRespecAvailable: boolean }> = {
    ...DEFAULT_SKILL_SYSTEM_V3_RUNTIME_CAPABILITIES,
    fullBuildRespecAvailable: false
  }
): Promise<SkillSystemV3Snapshot> {
  const [stateResult, generalResult, specializationResult, activeResult, loadoutResult, levelResult, worldUnlockResult, runtimeResult] = await Promise.all([
    queryable.query<SkillPointStateRow>(
      `SELECT player_id, total_earned, total_spent, revision
       FROM player_skill_point_state WHERE player_id = $1`, [playerId]
    ),
    queryable.query<GeneralRankRow>(
      `SELECT skill_id, rank, points_spent, grandfathered
       FROM player_skill_ranks WHERE player_id = $1 ORDER BY skill_id`, [playerId]
    ),
    queryable.query<SpecializationRankRow>(
      `SELECT specialization_id, rank, points_spent, grandfathered
       FROM player_specialization_ranks WHERE player_id = $1 ORDER BY specialization_id`, [playerId]
    ),
    queryable.query<{ committed_specialization_id: string | null; active_specialization_id: string | null }>(
      `SELECT committed_specialization_id, active_specialization_id
       FROM player_specialization_state WHERE player_id = $1`, [playerId]
    ),
    queryable.query<{ slot_one_skill_id: string | null; slot_two_skill_id: string | null }>(
      `SELECT slot_one_skill_id, slot_two_skill_id
       FROM player_general_active_loadouts WHERE player_id = $1`, [playerId]
    ),
    queryable.query<{ level: number }>(
      `SELECT level FROM player_progression_profiles WHERE player_id = $1`, [playerId]
    ),
    queryable.query<{ skill_id: string }>(
      `SELECT skill_id FROM player_skill_world_unlocks WHERE player_id = $1`, [playerId]
    ),
    queryable.query<{ cooldown_ends_at: Record<string, unknown> }>(
      `SELECT cooldown_ends_at FROM player_skill_runtime WHERE player_id = $1`, [playerId]
    )
  ]);
  const state = requireRow(stateResult.rows[0], "Skill point state does not exist");
  const generalIdSet = new Set<string>(GENERAL_SKILL_IDS);
  const worldIdSet = new Set<string>(WORLD_KNOWLEDGE_SKILL_IDS);
  const revealedWorldIds = new Set(worldUnlockResult.rows.map((row) => row.skill_id));
  const specializationIdSet = new Set<string>(SPECIALIZATION_IDS);
  // Hidden rank rows (old combat skills, old classes) read as unlearned: no rank, no effect, no spent points.
  const hidden = hiddenSkillRankIds(capabilities);
  const hiddenIdSet = new Set<string>([...hidden.general, ...hidden.specializations]);
  const generalRows = generalResult.rows.filter((row) => generalIdSet.has(row.skill_id) && !hiddenIdSet.has(row.skill_id));
  const generalById = new Map(generalRows.map((row) => [row.skill_id, row]));
  const specializationRows = specializationResult.rows.filter((row) => specializationIdSet.has(row.specialization_id) && !hiddenIdSet.has(row.specialization_id));
  const specializationById = new Map(specializationRows.map((row) => [row.specialization_id, row]));
  const committedRaw = activeResult.rows[0]?.committed_specialization_id ?? null;
  const committedSpecializationId = committedRaw !== null && specializationIdSet.has(committedRaw)
    ? committedRaw as SpecializationId
    : null;
  const activeRaw = activeResult.rows[0]?.active_specialization_id ?? null;
  const activeSpecializationId = activeRaw !== null
    && specializationIdSet.has(activeRaw)
    && isSpecializationAvailable(activeRaw as SpecializationId, capabilities)
    ? activeRaw as SpecializationId
    : null;
  const loadout = loadoutResult.rows[0];
  const slot = (value: string | null | undefined): GeneralSkillId | null =>
    value !== null && value !== undefined && generalIdSet.has(value) && !hiddenIdSet.has(value) ? value as GeneralSkillId : null;
  const totalEarned = Number(state.total_earned);
  const totalSpent = Number(state.total_spent);
  const serverTime = Date.now();
  const cooldownEndsAt = validCooldowns(runtimeResult.rows[0]?.cooldown_ends_at);
  return {
    playerId,
    characterLevel: Number(levelResult.rows[0]?.level ?? 0),
    pointState: {
      totalEarned,
      totalSpent,
      available: totalEarned - totalSpent,
      revision: Number(state.revision)
    },
    generalSkills: GENERAL_SKILL_IDS.map((skillId) => {
      const row = generalById.get(skillId);
      return { skillId, rank: Number(row?.rank ?? 0), pointsSpent: Number(row?.points_spent ?? 0) };
    }),
    specializations: SPECIALIZATION_IDS.map((specializationId) => {
      const row = specializationById.get(specializationId);
      return {
        specializationId,
        rank: Number(row?.rank ?? 0),
        pointsSpent: Number(row?.points_spent ?? 0),
        grandfathered: row?.grandfathered ?? false,
        masteryQuestCompleted: false
      };
    }),
    committedSpecializationId,
    activeSpecializationId,
    equippedClassTechniqueId: null,
    fullBuildRespecAvailable: capabilities.fullBuildRespecAvailable,
    fullClassRosterEnabled: capabilities.fullClassRosterEnabled,
    ultimatesEnabled: capabilities.ultimatesEnabled,
    generalActiveLoadout: [slot(loadout?.slot_one_skill_id), slot(loadout?.slot_two_skill_id)] as GeneralActiveLoadout,
    // Class Ultimates and Class Techniques are removed; the wire fields stay for installed clients.
    ultimate: null,
    cooldownEndsAt,
    worldKnowledge: WORLD_KNOWLEDGE_SKILL_IDS.map((skillId) => {
      const row = generalResult.rows.find((candidate) => candidate.skill_id === skillId);
      return {
        skillId,
        revealed: worldIdSet.has(skillId) && revealedWorldIds.has(skillId),
        rank: Number(row?.rank ?? 0),
        pointsSpent: Number(row?.points_spent ?? 0)
      };
    }),
    serverTime,
    revision: Number(state.revision)
  };
}

export async function loadCompletedOperation(
  queryable: SkillQueryable,
  operationKey: string,
  playerId: string,
  action: string,
  payload: unknown
): Promise<SkillMutationResult | null> {
  const existing = await queryable.query<SkillOperationRow>(
    `SELECT player_id, action, payload, result, completed_at
     FROM skill_point_operations WHERE operation_key = $1`,
    [operationKey]
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.player_id !== playerId || row.action !== action || stableJson(row.payload) !== stableJson(payload)) {
    throw new SkillRequestError("SKILL_OPERATION_CONFLICT", "Skill request id conflicts with another operation");
  }
  if (!row.completed_at || !row.result) {
    throw new SkillRequestError("SKILL_OPERATION_INCOMPLETE", "A matching Skill Point operation is still incomplete");
  }
  return { ...row.result, replayed: true };
}

export async function reserveOperation(
  queryable: SkillQueryable,
  operationKey: string,
  playerId: string,
  action: string,
  payload: unknown
): Promise<boolean> {
  const reserved = await queryable.query(
    `INSERT INTO skill_point_operations (operation_key, player_id, action, payload)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key`,
    [operationKey, playerId, action, JSON.stringify(payload)]
  );
  return Boolean(reserved.rowCount);
}

export async function completeOperation(
  queryable: SkillQueryable,
  operationKey: string,
  result: SkillMutationResult
): Promise<void> {
  await queryable.query(
    `UPDATE skill_point_operations SET result = $2::jsonb, completed_at = now()
     WHERE operation_key = $1`,
    [operationKey, JSON.stringify(result)]
  );
}

export function assertRevision(state: SkillPointStateRow, expectedRevision: number): void {
  if (Number(state.revision) !== expectedRevision) {
    throw new SkillRequestError("SKILL_REVISION_CONFLICT", "Skill tree changed; request a fresh authoritative snapshot");
  }
}

export function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) throw new Error(message);
  return row;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/** Stored cooldown keys of removed Class Ultimates and Class Techniques are ignored. */
function isRemovedClassActiveKey(key: string): boolean {
  return key.startsWith("ultimate:")
    || SKILL_SYSTEM_V3_CLASS_TECHNIQUE_DEFINITIONS.some((definition) => definition.id === key)
    || TECHNIQUE_BY_ID[key]?.kind === "ultimate";
}

function validCooldowns(value: Record<string, unknown> | undefined): Record<string, number> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(
    (entry): entry is [string, number] =>
      entry[0].length > 0 && typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0 && !isRemovedClassActiveKey(entry[0])
  ));
}

/** Whether a discovery offering or class writ is already recorded for this player. */
export async function isUnlockRecorded(
  queryable: SkillQueryable,
  playerId: string,
  unlockKey: string,
  lock = false
): Promise<boolean> {
  const result = await queryable.query(
    `SELECT 1 FROM player_skill_world_unlocks WHERE player_id = $1 AND skill_id = $2${lock ? " FOR UPDATE" : ""}`,
    [playerId, unlockKey]
  );
  return Boolean(result.rowCount);
}
