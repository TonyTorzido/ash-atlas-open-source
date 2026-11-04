import {
  CLASS_WRITS,
  GENERAL_SKILL_IDS,
  SPECIALIZATION_IDS,
  classWritUnlockKey,
  costForNextSpecializationRank,
  gatewaySatisfied,
  levelGateForNextSpecializationRank,
  isFreeSwitchSpecializationId,
  isSpecializationAvailable,
  requireSpecializationDefinition,
  type GeneralSkillId,
  type SkillSystemV3RuntimeCapabilities,
  type SkillSystemV3Snapshot,
  type SpecializationId
} from "@ash-atlas/shared";
import type pg from "pg";

import {
  SkillRequestError,
  assertRevision,
  isUnlockRecorded,
  completeOperation,
  ensureSkillAuthorityRows,
  loadCompletedOperation,
  loadSkillSnapshot,
  lockAndReconcileSkillPointState,
  reserveOperation,
  skillOperationKey,
  validateExpectedRevision,
  type SkillMutationResult,
  type SkillQueryable
} from "./skillAuthority.js";
import { debitOfferingInTransaction, type OfferingInventory } from "./skillOfferings.js";

export type SpecializationActivationRestriction = Readonly<{
  inCombat?: boolean;
  hasUnresolvedAction?: boolean;
  movementRestricted?: boolean;
  locationRestricted?: boolean;
  equipmentActivationPending?: boolean;
}>;

export class SpecializationService {
  private readonly allowProductionRefunds: boolean;
  private readonly capabilities: SkillSystemV3RuntimeCapabilities & Readonly<{ fullBuildRespecAvailable: boolean }>;
  private readonly inventory: OfferingInventory | null;

  constructor(
    private readonly pool: pg.Pool,
    options: Readonly<{
      /** Debits class writs; without it a class that needs a writ cannot take Rank 1. */
      inventory?: OfferingInventory;
      allowProductionRefunds?: boolean;
      fullBuildRespecAvailable?: boolean;
      fullClassRosterEnabled?: boolean;
      ultimatesEnabled?: boolean;
    }> = {}
  ) {
    this.allowProductionRefunds = options.allowProductionRefunds ?? false;
    this.inventory = options.inventory ?? null;
    this.capabilities = {
      fullBuildRespecAvailable: options.fullBuildRespecAvailable ?? false,
      fullClassRosterEnabled: options.fullClassRosterEnabled ?? false,
      ultimatesEnabled: options.ultimatesEnabled ?? false
    };
  }

  async getOrCreate(playerId: string): Promise<SkillSystemV3Snapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await ensureSkillAuthorityRows(client, playerId);
      await lockAndReconcileSkillPointState(client, playerId, this.capabilities);
      const snapshot = await loadSkillSnapshot(client, playerId, this.capabilities);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async spendSpecializationPoint(
    playerId: string,
    specializationId: SpecializationId,
    requestId: string,
    expectedRevision: number,
    restriction: SpecializationActivationRestriction = {}
  ): Promise<SkillMutationResult> {
    assertSpecializationId(specializationId);
    assertAvailableSpecialization(specializationId, this.capabilities);
    return this.mutate(playerId, requestId, expectedRevision, "spend_specialization", { specializationId }, async (client, totalEarned, totalSpent, operationKey) => {
      const commitmentResult = await client.query<{ committed_specialization_id: string | null }>(
        `SELECT committed_specialization_id FROM player_specialization_state
         WHERE player_id = $1 FOR UPDATE`, [playerId]
      );
      const committedSpecializationId = commitmentResult.rows[0]?.committed_specialization_id ?? null;
      const replacingUnavailable = committedSpecializationId !== null
        && SPECIALIZATION_IDS.includes(committedSpecializationId as SpecializationId)
        && !isSpecializationAvailable(committedSpecializationId as SpecializationId, this.capabilities);
      if (committedSpecializationId !== null && committedSpecializationId !== specializationId && !replacingUnavailable) {
        throw new SkillRequestError("SPECIALIZATION_COMMITMENT_LOCKED", "Skill Points are committed to another specialization");
      }
      if ((committedSpecializationId === null || replacingUnavailable) && Object.values(restriction).some((value) => value === true)) {
        throw new SkillRequestError("SPECIALIZATION_ACTIVATION_RESTRICTED", "Specialization cannot change during a restricted action");
      }
      const previousRank = replacingUnavailable ? await client.query<{ points_spent: number }>(
        `SELECT points_spent FROM player_specialization_ranks
         WHERE player_id = $1 AND specialization_id = $2 FOR UPDATE`,
        [playerId, committedSpecializationId]
      ) : null;
      // A hidden class's points already read as available (lockAndReconcileSkillPointState skips hidden rank rows),
      // so replacing it refunds nothing more and leaves its row as it is.
      const previousPoints = Number(previousRank?.rows[0]?.points_spent ?? 0);
      const spentAfterReplacement = totalSpent;
      const rankResult = await client.query<{
        rank: number; points_spent: number; grandfathered: boolean;
      }>(
        `SELECT rank, points_spent, grandfathered
         FROM player_specialization_ranks
         WHERE player_id = $1 AND specialization_id = $2 FOR UPDATE`,
        [playerId, specializationId]
      );
      const current = rankResult.rows[0];
      const currentRank = Number(current?.rank ?? 0);
      const cost = costForNextSpecializationRank(specializationId, currentRank);
      if (cost === null) throw new SkillRequestError("SPECIALIZATION_RANK_MAXIMUM", "Specialization is already at maximum rank");
      const levelResult = await client.query<{ level: number }>(
        `SELECT level FROM player_progression_profiles WHERE player_id = $1`, [playerId]
      );
      const characterLevel = Number(levelResult.rows[0]?.level ?? 0);
      const generalResult = await client.query<{ skill_id: string; rank: number }>(
        `SELECT skill_id, rank FROM player_skill_ranks WHERE player_id = $1`, [playerId]
      );
      const rankMap: Partial<Record<GeneralSkillId, number>> = {};
      for (const row of generalResult.rows) {
        if (GENERAL_SKILL_IDS.includes(row.skill_id as GeneralSkillId)) {
          rankMap[row.skill_id as GeneralSkillId] = Number(row.rank);
        }
      }
      const levelGate = levelGateForNextSpecializationRank(currentRank);
      if (levelGate !== null && characterLevel < levelGate) {
        throw new SkillRequestError(
          "SPECIALIZATION_LEVEL_REQUIRED",
          `Class Rank ${currentRank + 1} unlocks at character level ${levelGate} (level ${characterLevel})`
        );
      }
      if (!gatewaySatisfied(specializationId, characterLevel, rankMap, current?.grandfathered ?? false)) {
        const definition = requireSpecializationDefinition(specializationId);
        if (definition.gatewaySkillId === null) {
          throw new SkillRequestError("SPECIALIZATION_GATEWAY_PENDING", "This specialization gateway is pending design");
        }
        throw new SkillRequestError("SPECIALIZATION_GATEWAY_REQUIRED", "Specialization gateway must be Rank 3");
      }
      if (spentAfterReplacement + cost > totalEarned) {
        throw new SkillRequestError("SKILL_POINTS_INSUFFICIENT", "Not enough Skill Points are available");
      }
      const writ = CLASS_WRITS[specializationId];
      if (currentRank === 0 && writ && !(await isUnlockRecorded(client, playerId, classWritUnlockKey(specializationId), true))) {
        if (!this.inventory) throw new SkillRequestError("CLASS_WRIT_UNAVAILABLE", "Class writs cannot be offered right now");
        await debitOfferingInTransaction(this.inventory, client, {
          operationKey: `class-writ:${playerId}:${specializationId}`,
          playerId,
          source: "class_writ",
          sourceEntityType: "specialization",
          sourceEntityId: specializationId,
          name: `The ${requireSpecializationDefinition(specializationId).displayName} writ`,
          parts: writ.parts
        });
        await client.query(
          `INSERT INTO player_skill_world_unlocks (player_id, skill_id, operation_key) VALUES ($1,$2,$3)`,
          [playerId, classWritUnlockKey(specializationId), operationKey]
        );
      }
      await client.query(
        `INSERT INTO player_specialization_ranks (
           player_id, specialization_id, rank, points_spent, grandfathered, revision
         ) VALUES ($1,$2,1,$3,false,1)
         ON CONFLICT (player_id, specialization_id) DO UPDATE
         SET rank = player_specialization_ranks.rank + 1,
             points_spent = player_specialization_ranks.points_spent + EXCLUDED.points_spent,
             revision = player_specialization_ranks.revision + 1`,
        [playerId, specializationId, cost]
      );
      if (committedSpecializationId === null || replacingUnavailable) {
        await client.query(
          `UPDATE player_specialization_state
           SET committed_specialization_id = $2,
               active_specialization_id = $2,
               equipped_class_technique_id = NULL,
               revision = revision + 1
           WHERE player_id = $1 AND committed_specialization_id IS NOT DISTINCT FROM $3`,
          [playerId, specializationId, committedSpecializationId]
        );
      }
      await incrementPointState(client, playerId, cost);
      if (replacingUnavailable) {
        return { priorClassId: committedSpecializationId as SpecializationId, refundedPoints: previousPoints };
      }
    });
  }

  async refundSpecializationRank(
    playerId: string,
    specializationId: SpecializationId,
    requestId: string,
    expectedRevision: number,
    options: Readonly<{ development?: boolean }> = {}
  ): Promise<SkillMutationResult> {
    assertSpecializationId(specializationId);
    if (!this.allowProductionRefunds && !options.development) {
      throw new SkillRequestError("SKILL_REFUNDS_DISABLED", "Player-facing Skill Point refunds are pending design");
    }
    return this.mutate(playerId, requestId, expectedRevision, "refund_specialization", { specializationId }, async (client) => {
      const currentResult = await client.query<{
        rank: number; points_spent: number; grandfathered: boolean;
      }>(
        `SELECT rank, points_spent, grandfathered
         FROM player_specialization_ranks
         WHERE player_id = $1 AND specialization_id = $2 FOR UPDATE`,
        [playerId, specializationId]
      );
      const current = currentResult.rows[0];
      if (!current || Number(current.rank) <= 0) {
        throw new SkillRequestError("SPECIALIZATION_RANK_EMPTY", "Specialization has no refundable rank");
      }
      const baselineResult = await client.query<{ resulting_rank: number }>(
        `SELECT resulting_rank FROM specialization_migration_audit
         WHERE player_id = $1 AND resulting_specialization_id = $2 AND grandfathered
         ORDER BY resulting_rank DESC LIMIT 1`,
        [playerId, specializationId]
      );
      const baselineRank = Number(baselineResult.rows[0]?.resulting_rank ?? 0);
      if (Number(current.rank) <= baselineRank || Number(current.points_spent) <= 0) {
        throw new SkillRequestError("SPECIALIZATION_RANK_GRANDFATHERED", "The migration baseline cannot be refunded");
      }
      const resultingRank = Number(current.rank) - 1;
      const activeResult = await client.query<{ active_specialization_id: string | null }>(
        `SELECT active_specialization_id FROM player_specialization_state
         WHERE player_id = $1 FOR UPDATE`, [playerId]
      );
      if (activeResult.rows[0]?.active_specialization_id === specializationId && resultingRank === 0) {
        throw new SkillRequestError("SPECIALIZATION_ACTIVE_REFUND", "Deactivate the specialization before refunding its final rank");
      }
      const refund = requireSpecializationDefinition(specializationId).ranks[Number(current.rank) - 1]?.cost;
      if (refund === undefined || refund > Number(current.points_spent)) {
        throw new SkillRequestError("SPECIALIZATION_REFUND_INVALID", "Persisted specialization spending cannot be refunded safely");
      }
      await client.query(
        `UPDATE player_specialization_ranks
         SET rank = rank - 1, points_spent = points_spent - $3, revision = revision + 1
         WHERE player_id = $1 AND specialization_id = $2`,
        [playerId, specializationId, refund]
      );
      if (resultingRank < 3) {
        await client.query(
          `UPDATE player_specialization_state
           SET equipped_class_technique_id = NULL, revision = revision + 1
           WHERE player_id = $1 AND equipped_class_technique_id IS NOT NULL`,
          [playerId]
        );
      }
      await incrementPointState(client, playerId, -refund);
    });
  }

  async activateSpecialization(
    playerId: string,
    specializationId: SpecializationId | null,
    requestId: string,
    expectedRevision: number,
    restriction: SpecializationActivationRestriction
  ): Promise<SkillMutationResult> {
    if (specializationId === null || isFreeSwitchSpecializationId(specializationId)) {
      return this.switchFreeClass(playerId, specializationId, requestId, expectedRevision);
    }
    assertSpecializationId(specializationId);
    assertAvailableSpecialization(specializationId, this.capabilities);
    if (Object.values(restriction).some((value) => value === true)) {
      throw new SkillRequestError("SPECIALIZATION_ACTIVATION_RESTRICTED", "Specialization cannot change during a restricted action");
    }
    return this.mutate(playerId, requestId, expectedRevision, "activate_specialization", { specializationId }, async (client) => {
      const stateResult = await client.query<{ committed_specialization_id: string | null }>(
        `SELECT committed_specialization_id, active_specialization_id FROM player_specialization_state
         WHERE player_id = $1 FOR UPDATE`, [playerId]
      );
      const committed = stateResult.rows[0]?.committed_specialization_id ?? null;
      const replacingUnavailable = committed !== null
        && SPECIALIZATION_IDS.includes(committed as SpecializationId)
        && !isSpecializationAvailable(committed as SpecializationId, this.capabilities);
      if (committed !== specializationId && !replacingUnavailable) {
        throw new SkillRequestError("SPECIALIZATION_COMMITMENT_LOCKED", "Only the committed specialization may be activated");
      }
      const learned = await client.query<{ rank: number; grandfathered: boolean }>(
        `SELECT rank, grandfathered FROM player_specialization_ranks
         WHERE player_id = $1 AND specialization_id = $2 AND rank > 0`,
        [playerId, specializationId]
      );
      if (!learned.rowCount) {
        throw new SkillRequestError("SPECIALIZATION_UNLEARNED", "Specialization must have at least one rank before activation");
      }
      if (replacingUnavailable) {
        const levelResult = await client.query<{ level: number }>(
          `SELECT level FROM player_progression_profiles WHERE player_id = $1`, [playerId]
        );
        const generalResult = await client.query<{ skill_id: string; rank: number }>(
          `SELECT skill_id, rank FROM player_skill_ranks WHERE player_id = $1`, [playerId]
        );
        const rankMap: Partial<Record<GeneralSkillId, number>> = {};
        for (const row of generalResult.rows) {
          if (GENERAL_SKILL_IDS.includes(row.skill_id as GeneralSkillId)) rankMap[row.skill_id as GeneralSkillId] = Number(row.rank);
        }
        if (!gatewaySatisfied(specializationId, Number(levelResult.rows[0]?.level ?? 0), rankMap, learned.rows[0]!.grandfathered)) {
          throw new SkillRequestError("SPECIALIZATION_GATEWAY_REQUIRED", "Replacement class gateway must be Rank 3");
        }
      }
      const oldRank = replacingUnavailable ? await client.query<{ points_spent: number }>(
        `SELECT points_spent FROM player_specialization_ranks
         WHERE player_id = $1 AND specialization_id = $2 FOR UPDATE`, [playerId, committed]
      ) : null;
      // The hidden class's points already read as available (see spendSpecializationPoint); its row stays as it is.
      const refundedPoints = Number(oldRank?.rows[0]?.points_spent ?? 0);
      await client.query(
        `UPDATE player_specialization_state
         SET committed_specialization_id = $2, active_specialization_id = $2,
             equipped_class_technique_id = NULL,
             revision = revision + 1 WHERE player_id = $1`,
        [playerId, specializationId]
      );
      await incrementPointState(client, playerId, 0);
      if (replacingUnavailable) {
        return { priorClassId: committed as SpecializationId, refundedPoints };
      }
    });
  }

  /**
   * Free class switch (Ronin, Warrior) or unequip (null): instant, no Skill Points, rank, gateway, writ, level gate,
   * cooldown or action restriction. The class needs a rank row for the state foreign keys, so a missing one is
   * added at rank 0 (no points). Committed and active both move to the choice; null clears both, so the login
   * reconcile does not re-activate a ranked Warrior the player dropped. Rank rows of hidden classes are left
   * untouched; the Skill Points spent on them read as available (lockAndReconcileSkillPointState).
   */
  private async switchFreeClass(
    playerId: string,
    specializationId: SpecializationId | null,
    requestId: string,
    expectedRevision: number
  ): Promise<SkillMutationResult> {
    if (specializationId !== null) assertSpecializationId(specializationId);
    return this.mutate(playerId, requestId, expectedRevision, "activate_specialization", { specializationId }, async (client) => {
      // mutate() already holds the player's skill point state lock, which serializes every skill mutation.
      if (specializationId !== null) {
        await client.query(
          `INSERT INTO player_specialization_ranks (player_id, specialization_id, rank, points_spent)
           VALUES ($1, $2, 0, 0)
           ON CONFLICT (player_id, specialization_id) DO NOTHING`,
          [playerId, specializationId]
        );
      }
      await client.query(
        `UPDATE player_specialization_state
         SET committed_specialization_id = $2, active_specialization_id = $2,
             equipped_class_technique_id = NULL,
             revision = revision + 1 WHERE player_id = $1`,
        [playerId, specializationId]
      );
    });
  }

  /** Class Techniques are removed; installed clients that still send the message get a clean rejection. */
  async equipClassTechnique(
    _playerId: string,
    _techniqueId: string,
    _requestId: string,
    _expectedRevision: number,
    _restriction: SpecializationActivationRestriction = {}
  ): Promise<SkillMutationResult> {
    throw new SkillRequestError("CLASS_TECHNIQUES_DISABLED", "Class techniques are not available yet");
  }

  private async mutate(
    playerId: string,
    requestId: string,
    expectedRevision: number,
    action: string,
    payload: unknown,
    apply: (
      client: SkillQueryable,
      totalEarned: number,
      totalSpent: number,
      operationKey: string
    ) => Promise<void | { priorClassId: SpecializationId; refundedPoints: number }>
  ): Promise<SkillMutationResult> {
    validateExpectedRevision(expectedRevision);
    const operationKey = skillOperationKey(playerId, requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await loadCompletedOperation(client, operationKey, playerId, action, payload);
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      await ensureSkillAuthorityRows(client, playerId);
      const state = await lockAndReconcileSkillPointState(client, playerId, this.capabilities);
      const replayAfterLock = await loadCompletedOperation(client, operationKey, playerId, action, payload);
      if (replayAfterLock) {
        await client.query("COMMIT");
        return replayAfterLock;
      }
      assertRevision(state, expectedRevision);
      const reserved = await reserveOperation(client, operationKey, playerId, action, payload);
      if (!reserved) {
        const concurrentReplay = await loadCompletedOperation(client, operationKey, playerId, action, payload);
        if (!concurrentReplay) throw new SkillRequestError("SKILL_OPERATION_INCOMPLETE", "Specialization operation could not be reserved");
        await client.query("COMMIT");
        return concurrentReplay;
      }
      const replacementAudit = await apply(client, Number(state.total_earned), Number(state.total_spent), operationKey);
      const snapshot = await loadSkillSnapshot(client, playerId, this.capabilities);
      const result: SkillMutationResult = { requestId, replayed: false, snapshot,
        ...(replacementAudit ? { replacementAudit } : {}) };
      await completeOperation(client, operationKey, result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function incrementPointState(
  queryable: SkillQueryable,
  playerId: string,
  spentDelta: number
): Promise<void> {
  const updated = await queryable.query(
    `UPDATE player_skill_point_state
     SET total_spent = total_spent + $2, revision = revision + 1
     WHERE player_id = $1 AND total_spent + $2 BETWEEN 0 AND total_earned
     RETURNING player_id`,
    [playerId, spentDelta]
  );
  if (!updated.rowCount) throw new SkillRequestError("SKILL_BALANCE_INVALID", "Skill Point balance update was rejected");
}

function assertSpecializationId(specializationId: SpecializationId): void {
  if (!SPECIALIZATION_IDS.includes(specializationId)) {
    throw new SkillRequestError("SPECIALIZATION_UNKNOWN", "Unknown specialization");
  }
}

function assertAvailableSpecialization(
  specializationId: SpecializationId,
  capabilities: SkillSystemV3RuntimeCapabilities
): void {
  if (!isSpecializationAvailable(specializationId, capabilities)) {
    throw new SkillRequestError("SPECIALIZATION_RUNTIME_UNAVAILABLE", "This specialization is unavailable on this server");
  }
}
