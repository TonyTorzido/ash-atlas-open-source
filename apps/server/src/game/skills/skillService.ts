import {
  GENERAL_SKILL_IDS,
  GENERAL_SKILL_OFFERINGS,
  GENERAL_ACTIVE_SLOT_COUNT,
  classWritUnlockKey,
  generalActiveSlotIndex,
  isGeneralActiveSlotId,
  LAUNCH_SPECIALIZATION_IDS,
  SPECIALIZATION_IDS,
  WORLD_KNOWLEDGE_SKILL_DEFINITIONS,
  WORLD_KNOWLEDGE_SKILL_IDS,
  costForNextGeneralSkillRank,
  fullSkillResetGlimmerFee,
  isGeneralSkillAvailable,
  requireGeneralSkillDefinition,
  requireSpecializationDefinition,
  type GeneralSkillId,
  type GeneralActiveSlotId,
  type PremiumWalletSnapshot,
  type SkillSystemV3RuntimeCapabilities,
  type SkillSystemV3Snapshot,
  type SpecializationId,
  type WorldKnowledgeSkillId
} from "@ash-atlas/shared";
import type pg from "pg";

import { hasActiveAtlasPass } from "../atlasPass.js";
import { PremiumWalletOperationError, type PremiumWalletService } from "../premiumWallet.js";
import {
  SkillRequestError,
  assertRevision,
  isUnlockRecorded,
  VISIBLE_SPENT_POINTS_SQL,
  completeOperation,
  ensureSkillAuthorityRows,
  loadCompletedOperation,
  hiddenSkillRankIds,
  loadSkillSnapshot,
  lockAndReconcileSkillPointState,
  requireRow,
  reserveOperation,
  skillOperationKey,
  validateExpectedRevision,
  type SkillMutationResult,
  type SkillQueryable
} from "./skillAuthority.js";

export type SkillServiceOptions = Readonly<{
  allowProductionRefunds?: boolean;
  fullBuildRespecAvailable?: boolean;
  fullClassRosterEnabled?: boolean;
  ultimatesEnabled?: boolean;
  /**
   * GLIMMER_SKILL_RESET_FEE_ENABLED: a full build respec costs Glimmer (560, 336 with an
   * active Atlas Pass), debited in the respec transaction. Absent = free (today's behaviour).
   */
  skillResetFee?: Readonly<{
    premiumWallet: Pick<PremiumWalletService, "debitForOperationInTransaction" | "snapshotInTransaction">;
  }>;
}>;

export type FullBuildRespecResult = SkillMutationResult & Readonly<{
  /** Glimmer charged by this respec (0 when free); absent on a replay. */
  glimmerCharged?: number;
  premiumWallet?: PremiumWalletSnapshot;
}>;

export type SkillUseRestriction = Readonly<{
  inCombat?: boolean;
  deadOrDowned?: boolean;
  hasUnresolvedAction?: boolean;
  movementRestricted?: boolean;
  locationRestricted?: boolean;
  equipmentMutationPending?: boolean;
}>;

export type SkillRuntimePersistenceInput = Readonly<{
  cooldownEndsAt: Readonly<Record<string, number>>;
  statusEffects: readonly unknown[];
  counters: Readonly<Record<string, unknown>>;
  engagedTarget: Readonly<Record<string, unknown>> | null;
  combatGeneration: number;
  revision: number;
}>;

export class SkillService {
  private readonly allowProductionRefunds: boolean;
  private readonly capabilities: SkillSystemV3RuntimeCapabilities & Readonly<{ fullBuildRespecAvailable: boolean }>;
  private readonly skillResetFee: SkillServiceOptions["skillResetFee"];

  constructor(
    private readonly pool: pg.Pool,
    options: SkillServiceOptions = {}
  ) {
    this.allowProductionRefunds = options.allowProductionRefunds ?? false;
    this.skillResetFee = options.skillResetFee;
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

  async persistRuntime(
    playerId: string,
    input: SkillRuntimePersistenceInput
  ): Promise<boolean> {
    if (!playerId) throw new SkillRequestError("SKILL_PLAYER_INVALID", "Player id is required");
    if (!Number.isSafeInteger(input.combatGeneration) || input.combatGeneration < 0) {
      throw new SkillRequestError("SKILL_RUNTIME_GENERATION_INVALID", "Combat generation must be a nonnegative safe integer");
    }
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
      throw new SkillRequestError("SKILL_RUNTIME_REVISION_INVALID", "Runtime revision must be a nonnegative safe integer");
    }
    for (const [key, value] of Object.entries(input.cooldownEndsAt)) {
      if (!key || key.length > 160 || !Number.isFinite(value) || value < 0) {
        throw new SkillRequestError("SKILL_RUNTIME_COOLDOWN_INVALID", "Cooldown keys and deadlines must be bounded, finite, and nonnegative");
      }
    }
    const cooldownEndsAt = serializeRuntimeJson(input.cooldownEndsAt, "cooldowns");
    const statusEffects = serializeRuntimeJson(input.statusEffects, "status effects");
    const counters = serializeRuntimeJson(input.counters, "counters");
    const engagedTarget = input.engagedTarget === null
      ? null
      : serializeRuntimeJson(input.engagedTarget, "engaged target");
    const persisted = await this.pool.query(
      `INSERT INTO player_skill_runtime (
         player_id, cooldown_ends_at, status_effects, counters, engaged_target,
         combat_generation, revision
       ) VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7)
       ON CONFLICT (player_id) DO UPDATE
       SET cooldown_ends_at = EXCLUDED.cooldown_ends_at,
           status_effects = EXCLUDED.status_effects,
           counters = EXCLUDED.counters,
           engaged_target = EXCLUDED.engaged_target,
           combat_generation = EXCLUDED.combat_generation,
           revision = EXCLUDED.revision
       WHERE (player_skill_runtime.combat_generation, player_skill_runtime.revision)
           < (EXCLUDED.combat_generation, EXCLUDED.revision)
       RETURNING player_id`,
      [
        playerId, cooldownEndsAt, statusEffects, counters, engagedTarget,
        input.combatGeneration, input.revision
      ]
    );
    return Boolean(persisted.rowCount);
  }

  async spendGeneralSkillPoint(
    playerId: string,
    skillId: GeneralSkillId,
    requestId: string,
    expectedRevision: number
  ): Promise<SkillMutationResult> {
    assertGeneralSkillId(skillId);
    this.assertGeneralSkillLive(skillId);
    return this.mutate(playerId, requestId, expectedRevision, "spend_general_skill", { skillId }, async (client, totalEarned, totalSpent) => {
      const definition = requireGeneralSkillDefinition(skillId);
      if (definition.status !== "implemented") {
        throw new SkillRequestError(
          "SKILL_CONTENT_UNAVAILABLE",
          "This skill is registered for future content and cannot accept Skill Points yet"
        );
      }
      if (definition.catalogVisibility !== "visible") {
        throw new SkillRequestError(
          "SKILL_CONTENT_HIDDEN",
          "This skill is retained for backend content and cannot accept player Skill Points"
        );
      }
      if (definition.worldUnlockRequirement) {
        throw new SkillRequestError("SKILL_WORLD_REVEAL_REQUIRED", "This skill must be revealed by authoritative world discovery");
      }
      const ranks = await generalRankMap(client, playerId, true);
      const currentRank = ranks.get(skillId)?.rank ?? 0;
      const cost = costForNextGeneralSkillRank(skillId, currentRank);
      if (cost === null) throw new SkillRequestError("SKILL_RANK_MAXIMUM", "General skill is already at maximum rank");
      for (const prerequisite of definition.prerequisites) {
        if ((ranks.get(prerequisite.skillId)?.rank ?? 0) < prerequisite.rank) {
          throw new SkillRequestError("SKILL_PREREQUISITE_REQUIRED", "General skill prerequisite is not satisfied");
        }
      }
      if (totalSpent + cost > totalEarned) {
        throw new SkillRequestError("SKILL_POINTS_INSUFFICIENT", "Not enough Skill Points are available");
      }
      // Rank 1 of an Advanced skill needs its one-time discovery offering; held ranks never pay.
      if (currentRank === 0 && GENERAL_SKILL_OFFERINGS[skillId] && !(await isUnlockRecorded(client, playerId, skillId))) {
        throw new SkillRequestError("SKILL_OFFERING_REQUIRED", "Make this skill's discovery offering before learning it");
      }
      await client.query(
        `INSERT INTO player_skill_ranks (
           player_id, skill_id, rank, points_spent, grandfathered, revision
         ) VALUES ($1,$2,1,$3,false,1)
         ON CONFLICT (player_id, skill_id) DO UPDATE
         SET rank = player_skill_ranks.rank + 1,
             points_spent = player_skill_ranks.points_spent + EXCLUDED.points_spent,
             revision = player_skill_ranks.revision + 1`,
        [playerId, skillId, cost]
      );
      await incrementPointState(client, playerId, cost);
    });
  }

  async refundGeneralSkillRank(
    playerId: string,
    skillId: GeneralSkillId,
    requestId: string,
    expectedRevision: number,
    options: Readonly<{ development?: boolean }> = {}
  ): Promise<SkillMutationResult> {
    assertGeneralSkillId(skillId);
    this.assertGeneralSkillLive(skillId);
    if (!this.allowProductionRefunds && !options.development) {
      throw new SkillRequestError("SKILL_REFUNDS_DISABLED", "Player-facing Skill Point refunds are pending design");
    }
    return this.mutate(playerId, requestId, expectedRevision, "refund_general_skill", { skillId }, async (client) => {
      const ranks = await generalRankMap(client, playerId, true);
      const current = ranks.get(skillId);
      if (!current || current.rank <= 0) throw new SkillRequestError("SKILL_RANK_EMPTY", "General skill has no refundable rank");
      if (current.grandfathered && current.pointsSpent <= 0) {
        throw new SkillRequestError("SKILL_RANK_GRANDFATHERED", "The migration baseline cannot be refunded");
      }
      const resultingRank = current.rank - 1;
      await assertRefundKeepsPrerequisites(client, playerId, skillId, resultingRank, ranks);
      const refund = requireGeneralSkillDefinition(skillId).rankDefinitions[current.rank - 1]?.cost;
      if (refund === undefined || refund <= 0 || refund > current.pointsSpent) {
        throw new SkillRequestError("SKILL_REFUND_INVALID", "Persisted rank spending cannot be refunded safely");
      }
      if (resultingRank === 0) {
        const equipped = await client.query(
          `SELECT 1 FROM player_general_active_loadouts
           WHERE player_id = $1 AND (slot_one_skill_id = $2 OR slot_two_skill_id = $2)`,
          [playerId, skillId]
        );
        if (equipped.rowCount) {
          throw new SkillRequestError("SKILL_REFUND_ACTIVE_EQUIPPED", "Unequip the active skill before refunding its final rank");
        }
        await client.query(
          `DELETE FROM player_skill_ranks WHERE player_id = $1 AND skill_id = $2`,
          [playerId, skillId]
        );
      } else {
        await client.query(
          `UPDATE player_skill_ranks
           SET rank = rank - 1, points_spent = points_spent - $3, revision = revision + 1
           WHERE player_id = $1 AND skill_id = $2`,
          [playerId, skillId, refund]
        );
      }
      await incrementPointState(client, playerId, -refund);
    });
  }

  async spendWorldKnowledgePoint(
    playerId: string,
    skillId: WorldKnowledgeSkillId,
    requestId: string,
    expectedRevision: number
  ): Promise<SkillMutationResult> {
    assertWorldKnowledgeSkillId(skillId);
    const knowledgeStatus: string = WORLD_KNOWLEDGE_SKILL_DEFINITIONS[skillId].status;
    if (knowledgeStatus !== "implemented") {
      throw new SkillRequestError(
        "SKILL_WORLD_KNOWLEDGE_UNAVAILABLE",
        "That world-knowledge branch is registered as future content and cannot consume Skill Points"
      );
    }
    return this.mutate(playerId, requestId, expectedRevision, "spend_world_knowledge", { skillId }, async (client, totalEarned, totalSpent) => {
      const revealed = await client.query(
        `SELECT 1 FROM player_skill_world_unlocks
         WHERE player_id = $1 AND skill_id = $2 FOR UPDATE`,
        [playerId, skillId]
      );
      if (!revealed.rowCount) {
        throw new SkillRequestError("SKILL_WORLD_REVEAL_REQUIRED", "World knowledge must be revealed by authoritative discovery before spending");
      }
      await assertWorldKnowledgeLevel(client, playerId, skillId);
      const currentResult = await client.query<{ rank: number; points_spent: number }>(
        `SELECT rank, points_spent FROM player_skill_ranks
         WHERE player_id = $1 AND skill_id = $2 FOR UPDATE`,
        [playerId, skillId]
      );
      const currentRank = Number(currentResult.rows[0]?.rank ?? 0);
      const cost = WORLD_KNOWLEDGE_SKILL_DEFINITIONS[skillId].ranks[currentRank]?.cost ?? null;
      if (cost === null) {
        throw new SkillRequestError("SKILL_RANK_MAXIMUM", "World knowledge is already at maximum rank");
      }
      if (totalSpent + cost > totalEarned) {
        throw new SkillRequestError("SKILL_POINTS_INSUFFICIENT", "Not enough Skill Points are available");
      }
      await client.query(
        `INSERT INTO player_skill_ranks (
           player_id, skill_id, rank, points_spent, grandfathered, revision
         ) VALUES ($1,$2,1,$3,false,1)
         ON CONFLICT (player_id, skill_id) DO UPDATE
         SET rank = player_skill_ranks.rank + 1,
             points_spent = player_skill_ranks.points_spent + EXCLUDED.points_spent,
             revision = player_skill_ranks.revision + 1`,
        [playerId, skillId, cost]
      );
      await incrementPointState(client, playerId, cost);
    });
  }

  async equipGeneralActive(
    playerId: string,
    slot: GeneralActiveSlotId,
    skillId: GeneralSkillId | null,
    requestId: string,
    expectedRevision: number,
    restriction: SkillUseRestriction = {}
  ): Promise<SkillMutationResult> {
    if (!isGeneralActiveSlotId(slot)) throw new SkillRequestError("SKILL_ACTIVE_SLOT_INVALID", `General active slot must be one of ${GENERAL_ACTIVE_SLOT_COUNT} current slots`);
    if (isRestricted(restriction)) {
      throw new SkillRequestError("SKILL_LOADOUT_RESTRICTED", "General active loadout cannot change during a restricted action");
    }
    if (skillId !== null) {
      assertGeneralSkillId(skillId);
      this.assertGeneralSkillLive(skillId);
    }
    return this.mutate(playerId, requestId, expectedRevision, "equip_general_active", { slot, skillId }, async (client) => {
      if (skillId !== null) {
        const definition = requireGeneralSkillDefinition(skillId);
        if (definition.kind !== "active" || definition.status !== "implemented") {
          throw new SkillRequestError("SKILL_ACTIVE_UNAVAILABLE", "Only implemented general active skills can be equipped");
        }
        const ranks = await generalRankMap(client, playerId, true);
        if ((ranks.get(skillId)?.rank ?? 0) <= 0) {
          throw new SkillRequestError("SKILL_ACTIVE_UNLEARNED", "General active skill has not been learned");
        }
      }
      const columns = ["slot_one_skill_id", "slot_two_skill_id"] as const;
      const slotIndex = generalActiveSlotIndex(slot);
      const column = columns[slotIndex];
      const otherColumn = columns[GENERAL_ACTIVE_SLOT_COUNT - slotIndex - 1];
      const duplicate = await client.query(
        `SELECT 1 FROM player_general_active_loadouts
         WHERE player_id = $1 AND $2::text IS NOT NULL AND ${otherColumn} = $2`,
        [playerId, skillId]
      );
      if (duplicate.rowCount) throw new SkillRequestError("SKILL_ACTIVE_DUPLICATE", "A general active cannot occupy both slots");
      await client.query(
        `UPDATE player_general_active_loadouts
         SET ${column} = $2, revision = revision + 1 WHERE player_id = $1`,
        [playerId, skillId]
      );
      await incrementPointState(client, playerId, 0);
    });
  }

  async confirmGeneralActiveUse(
    playerId: string,
    skillId: GeneralSkillId,
    requestId: string,
    expectedRevision: number
  ): Promise<SkillMutationResult> {
    assertGeneralSkillId(skillId);
    this.assertGeneralSkillLive(skillId);
    return this.mutate(playerId, requestId, expectedRevision, "use_general_active", { skillId }, async (client) => {
      const definition = requireGeneralSkillDefinition(skillId);
      if (definition.kind !== "active" || definition.status !== "implemented") {
        throw new SkillRequestError("SKILL_ACTIVE_UNAVAILABLE", "General active skill is not implemented");
      }
      const equipped = await client.query(
        `SELECT 1 FROM player_general_active_loadouts
         WHERE player_id = $1 AND (slot_one_skill_id = $2 OR slot_two_skill_id = $2)`,
        [playerId, skillId]
      );
      if (!equipped.rowCount) throw new SkillRequestError("SKILL_ACTIVE_NOT_EQUIPPED", "General active skill is not equipped");
    });
  }

  async revealWorldKnowledge(
    playerId: string,
    skillId: WorldKnowledgeSkillId,
    requestId: string,
    expectedRevision: number
  ): Promise<SkillMutationResult> {
    assertWorldKnowledgeSkillId(skillId);
    return this.mutate(playerId, requestId, expectedRevision, "reveal_world_knowledge", { skillId }, async (client, _earned, _spent, operationKey) => {
      await client.query(
        `INSERT INTO player_skill_world_unlocks (player_id, skill_id, operation_key)
         VALUES ($1,$2,$3) ON CONFLICT (player_id, skill_id) DO NOTHING`,
        [playerId, skillId, operationKey]
      );
      await incrementPointState(client, playerId, 0);
    });
  }

  /**
   * Discovery by authoritative in-world action (a dungeon token turn-in). Reveals the knowledge once per
   * player; `charge` runs inside the same transaction, so the tokens are consumed if and only if the
   * discovery is recorded. Rejects with SKILL_WORLD_ALREADY_REVEALED before charging when already known.
   */
  async discoverWorldKnowledge(
    playerId: string,
    skillId: WorldKnowledgeSkillId,
    requestId: string,
    charge?: (client: SkillQueryable) => Promise<void>
  ): Promise<SkillMutationResult> {
    assertWorldKnowledgeSkillId(skillId);
    return this.mutate(playerId, requestId, null, "discover_world_knowledge", { skillId }, async (client, _earned, _spent, operationKey) => {
      const known = await client.query(
        `SELECT 1 FROM player_skill_world_unlocks WHERE player_id = $1 AND skill_id = $2 FOR UPDATE`,
        [playerId, skillId]
      );
      if (known.rowCount) {
        throw new SkillRequestError("SKILL_WORLD_ALREADY_REVEALED", "That world knowledge is already discovered");
      }
      await assertWorldKnowledgeLevel(client, playerId, skillId);
      if (charge) await charge(client);
      await client.query(
        `INSERT INTO player_skill_world_unlocks (player_id, skill_id, operation_key) VALUES ($1,$2,$3)`,
        [playerId, skillId, operationKey]
      );
      await incrementPointState(client, playerId, 0);
    });
  }

  /**
   * One-time discovery offering for an Advanced General skill, recorded in the same reveal table as
   * World Knowledge. `charge` debits the offering inside this transaction, so items are spent if and
   * only if the discovery is recorded. A held rank or an earlier discovery is never charged again.
   */
  async discoverGeneralSkill(
    playerId: string,
    skillId: GeneralSkillId,
    requestId: string,
    charge: (client: SkillQueryable) => Promise<void>
  ): Promise<SkillMutationResult> {
    assertGeneralSkillId(skillId);
    this.assertGeneralSkillLive(skillId);
    return this.mutate(playerId, requestId, null, "discover_general_skill", { skillId }, async (client, _earned, _spent, operationKey) => {
      const definition = requireGeneralSkillDefinition(skillId);
      if (!GENERAL_SKILL_OFFERINGS[skillId]) {
        throw new SkillRequestError("SKILL_OFFERING_NOT_REQUIRED", "This skill needs no offering");
      }
      if (definition.status !== "implemented" || definition.catalogVisibility !== "visible") {
        throw new SkillRequestError("SKILL_CONTENT_UNAVAILABLE", "This skill is not available yet");
      }
      if (await isUnlockRecorded(client, playerId, skillId, true)) {
        throw new SkillRequestError("SKILL_WORLD_ALREADY_REVEALED", "That skill is already discovered");
      }
      const ranks = await generalRankMap(client, playerId, true);
      if ((ranks.get(skillId)?.rank ?? 0) > 0) {
        throw new SkillRequestError("SKILL_WORLD_ALREADY_REVEALED", "You already know that skill");
      }
      await charge(client);
      await client.query(
        `INSERT INTO player_skill_world_unlocks (player_id, skill_id, operation_key) VALUES ($1,$2,$3)`,
        [playerId, skillId, operationKey]
      );
      await incrementPointState(client, playerId, 0);
    });
  }

  /** Offerings already made: discovered Advanced General skills and paid class writs. */
  async unlockState(playerId: string): Promise<Readonly<{ discoveredGeneralSkills: GeneralSkillId[]; classWrits: SpecializationId[] }>> {
    const result = await this.pool.query<{ skill_id: string }>(
      `SELECT skill_id FROM player_skill_world_unlocks WHERE player_id = $1`, [playerId]
    );
    const keys = new Set(result.rows.map((row) => row.skill_id));
    return {
      discoveredGeneralSkills: GENERAL_SKILL_IDS.filter((id) => GENERAL_SKILL_OFFERINGS[id] !== undefined && keys.has(id)),
      classWrits: SPECIALIZATION_IDS.filter((id) => keys.has(classWritUnlockKey(id)))
    };
  }

  /** Glimmer price of a full build respec for this player right now, or null when the fee is off. */
  async fullBuildRespecGlimmerCost(playerId: string): Promise<number | null> {
    if (!this.skillResetFee) return null;
    return fullSkillResetGlimmerFee(await hasActiveAtlasPass(this.pool, playerId));
  }

  /**
   * With the reset fee on, `expectedGlimmerCost` must equal the live price (the client showed it on
   * the confirm), so a Pass lapsing mid-session can never charge more than the player agreed to.
   */
  async fullBuildRespec(
    playerId: string,
    requestId: string,
    expectedRevision: number,
    restriction: SkillUseRestriction = {},
    expectedGlimmerCost?: number
  ): Promise<FullBuildRespecResult> {
    if (!this.capabilities.fullBuildRespecAvailable) {
      throw new SkillRequestError("SKILL_RESPEC_UNAVAILABLE", "Full build respec is unavailable on this server");
    }
    const fee = this.skillResetFee;
    let charged: { glimmer: number; premiumWallet: PremiumWalletSnapshot } | null = null;
    const result = await this.mutate(playerId, requestId, expectedRevision, "full_build_respec", {}, async (client, _earned, _spent, operationKey) => {
      if (Object.values(restriction).some((value) => value === true)) {
        throw new SkillRequestError("SKILL_RESPEC_RESTRICTED", "Full build respec is unavailable during the current action or player state");
      }
      if (fee) charged = await chargeFullBuildRespec(client, fee.premiumWallet, playerId, requestId, operationKey, expectedGlimmerCost);
      await client.query(
       `UPDATE player_specialization_state
         SET active_specialization_id = NULL, committed_specialization_id = NULL,
             equipped_class_technique_id = NULL,
             revision = revision + 1
         WHERE player_id = $1`, [playerId]
      );
      await client.query(
        `UPDATE player_general_active_loadouts
         SET slot_one_skill_id = NULL, slot_two_skill_id = NULL, revision = revision + 1
         WHERE player_id = $1`, [playerId]
      );
      // Hidden rank rows (old combat skills, old classes) are kept as they are: their points already read as
      // available, and the dev flag can bring them back.
      const hidden = hiddenSkillRankIds(this.capabilities);
      await client.query(
        `DELETE FROM player_skill_ranks
         WHERE player_id = $1 AND skill_id = ANY($2::text[])`,
        [playerId, GENERAL_SKILL_IDS.filter((id) => !hidden.general.includes(id))]
      );
      await client.query(
        `DELETE FROM player_specialization_ranks
         WHERE player_id = $1 AND specialization_id = ANY($2::text[])`,
        [playerId, this.capabilities.fullClassRosterEnabled ? SPECIALIZATION_IDS : LAUNCH_SPECIALIZATION_IDS]
      );
      await client.query(
        `UPDATE player_skill_runtime
         SET cooldown_ends_at = '{}'::jsonb, status_effects = '[]'::jsonb,
             counters = '{}'::jsonb, engaged_target = NULL,
             combat_generation = combat_generation + 1, revision = revision + 1
         WHERE player_id = $1`, [playerId]
      );
      await client.query(
        `UPDATE player_skill_point_state AS state
         SET total_spent = retained.total_spent, revision = revision + 1
         FROM (SELECT ${VISIBLE_SPENT_POINTS_SQL} AS total_spent) AS retained
         WHERE state.player_id = $1`, [playerId, hidden.general, hidden.specializations]
      );
    });
    const paid = charged as { glimmer: number; premiumWallet: PremiumWalletSnapshot } | null;
    return paid ? { ...result, glimmerCharged: paid.glimmer, premiumWallet: paid.premiumWallet } : result;
  }

  /** Compatibility entry point; it uses the same authority and no divergent reset semantics. */
  async resetOwnDevelopmentSkillTree(
    playerId: string,
    requestId: string,
    expectedRevision: number,
    restriction: SkillUseRestriction = {}
  ): Promise<SkillMutationResult> {
    return this.fullBuildRespec(playerId, requestId, expectedRevision, restriction);
  }

  /** Hidden general skills (the old combat disciplines) take no points, offerings, loadout slots or uses. */
  private assertGeneralSkillLive(skillId: GeneralSkillId): void {
    if (!isGeneralSkillAvailable(skillId, this.capabilities)) {
      throw new SkillRequestError("SKILL_CONTENT_HIDDEN", "This skill is retired while new skills are built");
    }
  }

  private async mutate(
    playerId: string,
    requestId: string,
    expectedRevision: number | null,
    action: string,
    payload: unknown,
    apply: (
      client: SkillQueryable,
      totalEarned: number,
      totalSpent: number,
      operationKey: string
    ) => Promise<void>
  ): Promise<SkillMutationResult> {
    if (expectedRevision !== null) validateExpectedRevision(expectedRevision);
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
      if (expectedRevision !== null) assertRevision(state, expectedRevision);
      const reserved = await reserveOperation(client, operationKey, playerId, action, payload);
      if (!reserved) {
        const concurrentReplay = await loadCompletedOperation(client, operationKey, playerId, action, payload);
        if (!concurrentReplay) throw new SkillRequestError("SKILL_OPERATION_INCOMPLETE", "Skill operation could not be reserved");
        await client.query("COMMIT");
        return concurrentReplay;
      }
      await apply(client, Number(state.total_earned), Number(state.total_spent), operationKey);
      const snapshot = await loadSkillSnapshot(client, playerId, this.capabilities);
      const result: SkillMutationResult = { requestId, replayed: false, snapshot };
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

async function chargeFullBuildRespec(
  client: SkillQueryable,
  premiumWallet: Pick<PremiumWalletService, "debitForOperationInTransaction" | "snapshotInTransaction">,
  playerId: string,
  requestId: string,
  skillOperationKey: string,
  expectedGlimmerCost: number | undefined
): Promise<{ glimmer: number; premiumWallet: PremiumWalletSnapshot }> {
  const price = fullSkillResetGlimmerFee(await hasActiveAtlasPass(client, playerId));
  if (expectedGlimmerCost !== price) {
    throw new SkillRequestError("SKILL_RESPEC_PRICE_CHANGED", `A full skill reset costs ${price} Glimmer. Check the price and try again.`);
  }
  const account = await client.query<{ account_id: string | null }>(
    "SELECT account_id::text FROM players WHERE id = $1", [playerId]
  );
  const accountId = account.rows[0]?.account_id;
  if (!accountId) throw new SkillRequestError("SKILL_RESPEC_UNAVAILABLE", "Your account cannot pay Glimmer right now");
  try {
    await premiumWallet.debitForOperationInTransaction(client, {
      accountId,
      currency: "glimmer",
      amount: BigInt(price),
      operationKey: `skill-full-reset:${skillOperationKey}`,
      reason: "spend",
      actorPlayerId: playerId,
      refType: "skill_full_reset",
      refId: playerId,
      metadata: { requestId, price }
    });
  } catch (error) {
    if (error instanceof PremiumWalletOperationError && error.code === "PREMIUM_WALLET_INSUFFICIENT_FUNDS") {
      throw new SkillRequestError("SKILL_RESPEC_INSUFFICIENT_GLIMMER", `A full skill reset costs ${price} Glimmer.`);
    }
    throw error;
  }
  return { glimmer: price, premiumWallet: await premiumWallet.snapshotInTransaction(client, accountId) };
}

type GeneralRankState = { rank: number; pointsSpent: number; grandfathered: boolean };

async function generalRankMap(
  queryable: SkillQueryable,
  playerId: string,
  lock: boolean
): Promise<Map<GeneralSkillId, GeneralRankState>> {
  const result = await queryable.query<{
    skill_id: string; rank: number; points_spent: number; grandfathered: boolean;
  }>(
    `SELECT skill_id, rank, points_spent, grandfathered
     FROM player_skill_ranks WHERE player_id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [playerId]
  );
  const ids = new Set<string>(GENERAL_SKILL_IDS);
  return new Map(result.rows.filter((row) => ids.has(row.skill_id)).map((row) => [
    row.skill_id as GeneralSkillId,
    { rank: Number(row.rank), pointsSpent: Number(row.points_spent), grandfathered: row.grandfathered }
  ]));
}

async function assertRefundKeepsPrerequisites(
  queryable: SkillQueryable,
  playerId: string,
  skillId: GeneralSkillId,
  resultingRank: number,
  ranks: ReadonlyMap<GeneralSkillId, GeneralRankState>
): Promise<void> {
  for (const candidateId of GENERAL_SKILL_IDS) {
    if ((ranks.get(candidateId)?.rank ?? 0) <= 0) continue;
    const breaks = requireGeneralSkillDefinition(candidateId).prerequisites.some(
      (prerequisite) => prerequisite.skillId === skillId && prerequisite.rank > resultingRank
    );
    if (breaks) throw new SkillRequestError("SKILL_REFUND_BREAKS_PREREQUISITE", "Refund would invalidate a learned descendant skill");
  }
  const specialization = await queryable.query<{
    specialization_id: string; grandfathered: boolean;
  }>(
    `SELECT specialization_id, grandfathered FROM player_specialization_ranks
     WHERE player_id = $1 AND rank > 0 FOR UPDATE`, [playerId]
  );
  for (const row of specialization.rows) {
    if (row.grandfathered || !SPECIALIZATION_IDS.includes(row.specialization_id as never)) continue;
    const specializationDefinition = requireSpecializationDefinition(
      row.specialization_id as (typeof SPECIALIZATION_IDS)[number]
    );
    if (specializationDefinition.gatewaySkillId === skillId && resultingRank < 3) {
      throw new SkillRequestError("SKILL_REFUND_BREAKS_GATEWAY", "Refund would invalidate a purchased specialization");
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
     WHERE player_id = $1
       AND total_spent + $2 BETWEEN 0 AND total_earned
     RETURNING player_id`,
    [playerId, spentDelta]
  );
  requireRow(updated.rows[0], "Skill point state update violated its balance invariant");
}

function isRestricted(restriction: SkillUseRestriction): boolean {
  return restriction.inCombat === true || restriction.hasUnresolvedAction === true || restriction.movementRestricted === true;
}

function assertGeneralSkillId(skillId: GeneralSkillId): void {
  if (!GENERAL_SKILL_IDS.includes(skillId)) throw new SkillRequestError("SKILL_UNKNOWN", "Unknown general skill");
}

/** Some world knowledge (Edict Stride) needs a minimum character level to discover or rank up. */
async function assertWorldKnowledgeLevel(
  client: SkillQueryable,
  playerId: string,
  skillId: WorldKnowledgeSkillId
): Promise<void> {
  const minimumLevel = (WORLD_KNOWLEDGE_SKILL_DEFINITIONS[skillId] as { minimumCharacterLevel?: number }).minimumCharacterLevel;
  if (minimumLevel === undefined) return;
  const result = await client.query<{ level: number }>(
    `SELECT level FROM player_progression_profiles WHERE player_id = $1`, [playerId]
  );
  if (Number(result.rows[0]?.level ?? 0) < minimumLevel) {
    throw new SkillRequestError("SKILL_LEVEL_REQUIRED", `That world knowledge requires level ${minimumLevel}`);
  }
}

function assertWorldKnowledgeSkillId(skillId: WorldKnowledgeSkillId): void {
  if (!WORLD_KNOWLEDGE_SKILL_IDS.includes(skillId)) {
    throw new SkillRequestError("SKILL_WORLD_KNOWLEDGE_UNKNOWN", "Unknown world knowledge skill");
  }
}

function serializeRuntimeJson(value: unknown, label: string): string {
  try {
    const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
      if (
        candidate === undefined || typeof candidate === "bigint"
        || typeof candidate === "function" || typeof candidate === "symbol"
        || (typeof candidate === "number" && !Number.isFinite(candidate))
      ) {
        throw new TypeError(`${label} contains a non-JSON value`);
      }
      return candidate;
    });
    if (serialized === undefined) throw new TypeError(`${label} is not JSON serializable`);
    return serialized;
  } catch (error) {
    throw new SkillRequestError(
      "SKILL_RUNTIME_JSON_INVALID",
      `${label} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
