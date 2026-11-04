import {
  ALL_TECHNIQUE_DEFINITIONS,
  CLASS_IDS,
  CLASS_CURVE_VERSION,
  CLASS_MAX_RANK,
  LAUNCH_CLASS_IDS,
  LAUNCH_CLASS_TITLES,
  isLaunchClassId,
  isLaunchSubclassId,
  isLaunchTechniqueId,
  CURRENT_LEVEL_CAP,
  professionMaxRank,
  SUBCLASS_CLASS_IDS,
  SUBCLASS_IDS,
  SUBCLASS_RESET_DEFINITIONS,
  TECHNIQUE_BY_ID,
  WARRIOR_MAX_RANK,
  WARRIOR_SLOT_MILESTONES,
  availableTechniqueIds,
  classEquipmentAffinitySnapshot,
  classEquipmentCompatibility,
  classInitialResource,
  classLevelXp,
  classLevelForXp,
  classResourceDisplayName,
  classResourceId,
  classWeaponMode,
  requireEquipmentDefinition,
  requireTechniqueDefinition,
  subclassBelongsToClass,
  totalXpForLevel,
  unlockedNormalSlots,
  unlockedPassiveTierSlots,
  unlockedResetSlots,
  type ClassId,
  type LaunchClassId,
  type ClassLoadoutView,
  type ClassProgressView,
  type ClassResourceId,
  type ClassResourceView,
  type ClassSnapshot,
  type ClassWeaponMode,
  type DevProgressionType,
  type EquipmentSnapshot,
  type PassiveTier,
  type MasterySnapshot,
  type ProfessionId,
  type SubclassId
} from "@ash-atlas/shared";
import type pg from "pg";
import type { MasteryService } from "../masteries.js";

type Queryable = Pick<pg.Pool, "query">;

type ProfileRow = {
  active_class_id: ClassId;
  active_subclass_id: SubclassId | null;
  selected_subclasses: Partial<Record<ClassId, SubclassId | null>>;
  revision: string | number;
};
type ClassProgressRow = {
  class_id: ClassId;
  mastery_xp: number;
  mastery_rank: number;
  curve_version: number;
  completed_at: Date | string | null;
};
type SubclassProgressRow = { class_id: ClassId; subclass_id: SubclassId; unlocked: boolean };
type LoadoutRow = {
  reset_active_ids: Array<string | null>;
  normal_active_ids: Array<string | null>;
  passive_tier_ids: Array<string | null>;
  ultimate_active_id: string | null;
};
type SavedSubclassLoadoutRow = {
  reset_id: string | null;
  reset_slot_index: number | null;
  active_id: string | null;
};
type ResourceRow = {
  class_id: ClassId;
  resource_id: ClassResourceId;
  current_value: number;
  reserved_value: number;
  cooldown_ends_at: Record<string, number>;
  last_combat_at: Date | string | null;
  updated_at: Date | string;
};
type RuntimeRow = {
  queued_ability_id: string | null;
  queued_target_entity_id: string | null;
  queued_at_tick: string | number | null;
  status_effects: unknown[];
  counters: Record<string, unknown>;
  combat_generation: string | number;
  runtime_version: string | number;
};

export type CombatMasteryGrantResult = {
  playerId: string;
  classId: ClassId;
  requestedXp: number;
  grantedXp: number;
  previousLevel: number;
  resultingLevel: number;
  warriorPreviousLevel: number;
  warriorResultingLevel: number;
  warriorPreviousRank: number;
  warriorResultingRank: number;
  subclassId: null;
  subclassPreviousRank: null;
  subclassResultingRank: null;
  replayed: boolean;
  snapshot: ClassSnapshot;
};

export type ClassMutationResult = { replayed: boolean; snapshot: ClassSnapshot };
export type DevProgressionMutationResult = ClassMutationResult & {
  characterXpDelta: number;
  masteries?: MasterySnapshot;
};

export type PersistedClassRuntime = {
  /** Monotonic combat dirty-version, durably backed by player_class_runtime.revision. */
  version: number;
  activeClassId: ClassId;
  resourceId: ClassResourceId;
  resourceCurrent: number;
  resourceReserved: number;
  rage: number;
  rageReserved: number;
  queuedAbilityId: string | null;
  queuedTargetEntityId: string | null;
  queuedAtTick: number | null;
  cooldownEndsAt: Record<string, number>;
  statusEffects: unknown[];
  counters: Record<string, unknown>;
  combatGeneration: number;
  lastCombatAt: number | null;
  savedAt?: number;
};

export class ClassRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ClassRequestError";
  }
}

export function assertLaunchClassSelection(classId: ClassId): void {
  if (!isLaunchClassId(classId)) {
    throw new ClassRequestError("CLASS_NOT_LAUNCH_ENABLED", "This class is not available at launch");
  }
}

export function assertLaunchSubclassSelection(subclassId: SubclassId): void {
  if (!isLaunchSubclassId(subclassId)) {
    throw new ClassRequestError("CLASS_NOT_LAUNCH_ENABLED", "This class is not available at launch");
  }
}

export type SubclassUnlockRequirement = {
  subclassId: SubclassId;
  classId: ClassId;
  warriorLevel: number;
  classLevel: number;
  unlocked: boolean;
  warriorLevelEligible: boolean;
  classLevelEligible: boolean;
  satisfied: boolean;
  productionUnlockAvailable: false;
  reason: "warrior_level_25_required" | "class_level_25_required" | "already_unlocked" | "challenge_unavailable";
};

export function resolveSubclassUnlockRequirement(input: {
  subclassId: SubclassId;
  warriorLevel?: number;
  classId?: ClassId;
  classLevel?: number;
  unlocked: boolean;
}): SubclassUnlockRequirement {
  if (!SUBCLASS_IDS.includes(input.subclassId)) throw new ClassRequestError("SUBCLASS_UNKNOWN", "Unknown subclass");
  const classId = input.classId ?? SUBCLASS_CLASS_IDS[input.subclassId];
  if (!subclassBelongsToClass(input.subclassId, classId)) {
    throw new ClassRequestError("SUBCLASS_CLASS_INVALID", "Subclass does not belong to this class");
  }
  const classLevel = input.classLevel ?? input.warriorLevel ?? 0;
  if (!Number.isInteger(classLevel) || classLevel < 0 || classLevel > 25) {
    throw new ClassRequestError("SUBCLASS_LEVEL_INVALID", "Class Level must be between 0 and 25");
  }
  const eligible = classLevel >= 25;
  return {
    subclassId: input.subclassId,
    classId,
    warriorLevel: classId === "warrior" ? classLevel : input.warriorLevel ?? 0,
    classLevel,
    unlocked: input.unlocked,
    warriorLevelEligible: classId === "warrior" && eligible,
    classLevelEligible: eligible,
    satisfied: eligible && input.unlocked,
    productionUnlockAvailable: false,
    reason: !eligible
      ? classId === "warrior" ? "warrior_level_25_required" : "class_level_25_required"
      : input.unlocked ? "already_unlocked" : "challenge_unavailable"
  };
}

export class ClassService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly masteries?: MasteryService
  ) {}

  async getOrCreate(playerId: string): Promise<ClassSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureRows(client, playerId);
      const profile = await this.lockProfile(client, playerId);
      const progress = await this.lockClassProgress(client, playerId, profile.active_class_id);
      await this.reconcileLoadout(client, playerId, profile.active_class_id, canonicalClassRank(progress), null);
      const snapshot = await this.snapshot(client, playerId);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async grantCombatMastery(
    playerId: string,
    classId: ClassId,
    requestedXp: number,
    operationKey: string
  ): Promise<CombatMasteryGrantResult> {
    if (!Number.isSafeInteger(requestedXp) || requestedXp < 0) {
      throw new ClassRequestError("CLASS_XP_INVALID", "Class XP must be a nonnegative integer");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureRows(client, playerId);
      const profile = await this.lockProfile(client, playerId);
      const classOperationKey = `${operationKey}:${classId}`;
      const reserved = await client.query(
        `INSERT INTO class_progression_operations (
           operation_key, player_id, class_id, subclass_id, requested_xp, granted_xp,
           previous_rank, resulting_rank, result
         ) VALUES ($1,$2,$3,NULL,$4,0,0,0,'{}'::jsonb)
         ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key`,
        [classOperationKey, playerId, classId, requestedXp]
      );
      if (!reserved.rowCount) {
        const existing = await client.query<{
          player_id: string; class_id: ClassId; requested_xp: number; result: CombatMasteryGrantResult;
        }>(`SELECT player_id, class_id, requested_xp, result
            FROM class_progression_operations WHERE operation_key = $1`, [classOperationKey]);
        const row = requireRow(existing.rows[0], "Class progression operation does not exist");
        if (row.player_id !== playerId || row.class_id !== classId || Number(row.requested_xp) !== requestedXp) {
          throw new ClassRequestError("CLASS_XP_OPERATION_CONFLICT", "Class XP operation conflicts with another award");
        }
        const snapshot = await this.snapshot(client, playerId);
        await client.query("COMMIT");
        return { ...row.result, replayed: true, snapshot };
      }
      const progress = await this.lockClassProgress(client, playerId, classId);
      if (isLaunchClassId(classId) && Number(progress.curve_version) !== CLASS_CURVE_VERSION) {
        throw new ClassRequestError("CLASS_CURVE_UNSUPPORTED", "Launch class progression requires the canonical curve version");
      }
      const previousLevel = canonicalClassRank(progress);
      const previousXp = Number(progress.mastery_xp);
      const thresholds = classLevelXp(classId);
      const maximumRank = isLaunchClassId(classId) ? CLASS_MAX_RANK : thresholds.length - 1;
      const resultingXp = Math.min(thresholds[maximumRank]!, previousXp + requestedXp);
      const grantedXp = resultingXp - previousXp;
      const resultingLevel = classLevelForXp(resultingXp, classId);
      const isMastered = resultingLevel === maximumRank;
      await client.query(
        `UPDATE player_class_progress
         SET mastery_xp = $3::integer, mastery_rank = $4::integer,
             training_points_earned = 0, training_points_spent = 0,
             completed_at = CASE WHEN $5::boolean THEN COALESCE(completed_at, now()) ELSE completed_at END
         WHERE player_id = $1 AND class_id = $2`,
        [playerId, classId, resultingXp, resultingLevel, isMastered]
      );
      if (isMastered && isLaunchClassId(classId)) {
        const title = LAUNCH_CLASS_TITLES[classId];
        await client.query(
          `INSERT INTO player_mastery_achievements (player_id, achievement_id, title, badge_id, completed_at)
           VALUES ($1,$2,$3,$2,now()) ON CONFLICT (player_id, achievement_id) DO NOTHING`,
          [playerId, `master_${classId}`, title]
        );
      }
      if (classId === "warrior" && resultingLevel === WARRIOR_MAX_RANK && this.masteries) {
        await this.masteries.recordWarriorMastery(client, playerId);
      }
      await this.reconcileLoadout(client, playerId, classId, resultingLevel, selectedSubclass(profile, classId));
      await this.autoEquipNewlyUnlockedWarriorActives(client, playerId, classId, previousLevel, resultingLevel);
      await client.query(`UPDATE player_class_profiles SET revision = revision + 1 WHERE player_id = $1`, [playerId]);
      const snapshot = await this.snapshot(client, playerId);
      const result: CombatMasteryGrantResult = {
        playerId, classId, requestedXp, grantedXp, previousLevel, resultingLevel,
        warriorPreviousLevel: previousLevel,
        warriorResultingLevel: resultingLevel,
        warriorPreviousRank: previousLevel,
        warriorResultingRank: resultingLevel,
        subclassId: null, subclassPreviousRank: null, subclassResultingRank: null,
        replayed: false, snapshot
      };
      await client.query(
        `UPDATE class_progression_operations
         SET granted_xp = $2, previous_rank = $3, resulting_rank = $4, result = $5::jsonb
         WHERE operation_key = $1`,
        [classOperationKey, grantedXp, previousLevel, resultingLevel, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async learnTechnique(_playerId: string, _techniqueId: string, _requestId: string): Promise<ClassMutationResult> {
    void _playerId;
    void _techniqueId;
    void _requestId;
    throw new ClassRequestError("TECHNIQUE_LEARNING_REMOVED", "Class techniques unlock automatically");
  }

  async updateLoadout(
    playerId: string,
    loadout: ClassLoadoutView,
    requestId: string,
    options: { inCombat: boolean; equipment: EquipmentSnapshot }
  ): Promise<ClassMutationResult> {
    if (options.inCombat) throw new ClassRequestError("LOADOUT_COMBAT_LOCKED", "Loadout cannot change during combat or unresolved actions");
    validateLoadoutShape(loadout);
    return this.mutate(playerId, `class:${playerId}:loadout:${requestId}`, "loadout", loadout, async (client) => {
      const profile = await this.lockProfile(client, playerId);
      const classId = profile.active_class_id;
      const progress = await this.lockClassProgress(client, playerId, classId);
      const subclasses = await this.subclassRows(client, playerId, true);
      validateLoadout(loadout, classId, canonicalClassRank(progress), profile.active_subclass_id, subclasses);
      validateClassEquipment(classId, profile.active_subclass_id, options.equipment, false);
      await client.query(
        `UPDATE player_class_loadouts
         SET reset_active_ids = $3, normal_active_ids = $4, passive_tier_ids = $5,
             ultimate_active_id = $6, revision = revision + 1
         WHERE player_id = $1 AND class_id = $2`,
        [playerId, classId, loadout.resetActives, loadout.normalActives, loadout.passiveTiers, loadout.ultimateActive]
      );
    });
  }

  async activateSubclass(
    playerId: string,
    subclassId: SubclassId | null,
    requestId: string,
    options: { restricted: boolean; equipment?: EquipmentSnapshot }
  ): Promise<ClassMutationResult> {
    if (options.restricted) throw new ClassRequestError("CLASS_SWITCH_RESTRICTED", "Subclass cannot change during combat or unresolved actions");
    if (subclassId !== null && !SUBCLASS_IDS.includes(subclassId)) throw new ClassRequestError("SUBCLASS_UNKNOWN", "Unknown subclass");
    if (subclassId !== null) assertLaunchSubclassSelection(subclassId);
    return this.mutate(
      playerId,
      `class:${playerId}:switch-subclass:${requestId}`,
      "switch_subclass",
      { subclassId },
      async (client) => {
        const profile = await this.lockProfile(client, playerId);
        const classId = profile.active_class_id;
        if (subclassId && !subclassBelongsToClass(subclassId, classId)) {
          throw new ClassRequestError("SUBCLASS_CLASS_INVALID", "Subclass does not belong to the active class");
        }
        const progress = await this.lockClassProgress(client, playerId, classId);
        const loadout = await this.lockLoadout(client, playerId, classId);
        const resetActives = normalizeSlots(loadout.reset_active_ids, 2);
        const normalActives = normalizeSlots(loadout.normal_active_ids, 2);
        if (profile.active_subclass_id) {
          await saveSubclassTechniques(client, playerId, profile.active_subclass_id, resetActives);
        }
        clearSubclassTechniques(resetActives);
        clearSubclassTechniques(normalActives);
        if (subclassId) {
          const subclass = await this.lockSubclassProgress(client, playerId, subclassId);
          const requirement = resolveSubclassUnlockRequirement({
            subclassId, classId, classLevel: canonicalClassRank(progress), unlocked: subclass.unlocked
          });
          if (!requirement.classLevelEligible) throw new ClassRequestError("SUBCLASS_LEVEL_REQUIRED", "Subclass activation requires Class Level 25");
          if (!requirement.satisfied) throw new ClassRequestError("SUBCLASS_LOCKED", "Subclass challenge is not unlocked");
          if (options.equipment) validateClassEquipment(classId, subclassId, options.equipment, false);
          const saved = await this.savedSubclassLoadout(client, playerId, subclassId);
          const expectedId = SUBCLASS_RESET_DEFINITIONS[subclassId].id;
          if (saved.reset_id === expectedId && saved.reset_slot_index !== null) {
            const preferred = Number(saved.reset_slot_index);
            const available = resetActives[preferred] === null ? preferred : resetActives.indexOf(null);
            if (available >= 0) resetActives[available] = expectedId;
          }
        }
        const selected = normalizedSelectedSubclasses(profile.selected_subclasses);
        selected[classId] = subclassId;
        await client.query(
          `UPDATE player_class_profiles
           SET active_subclass_id = $2, selected_subclasses = $3::jsonb
           WHERE player_id = $1`,
          [playerId, subclassId, JSON.stringify(selected)]
        );
        await client.query(
          `UPDATE player_class_loadouts
           SET reset_active_ids = $3, normal_active_ids = $4, revision = revision + 1
           WHERE player_id = $1 AND class_id = $2`,
          [playerId, classId, resetActives, normalActives]
        );
      }
    );
  }

  async setOwnDevelopmentSubclassUnlock(
    playerId: string,
    subclassId: SubclassId,
    unlocked: boolean,
    operationId: string,
    options: { restricted: boolean }
  ): Promise<ClassMutationResult> {
    if (options.restricted) throw new ClassRequestError("DEV_PROGRESSION_RESTRICTED", "Subclass state cannot change during combat or unresolved actions");
    if (!SUBCLASS_IDS.includes(subclassId)) throw new ClassRequestError("SUBCLASS_UNKNOWN", "Unknown subclass");
    assertLaunchSubclassSelection(subclassId);
    return this.mutate(
      playerId,
      `class:${playerId}:dev-subclass:${operationId}`,
      "unlock_subclass",
      { subclassId, unlocked },
      async (client) => {
        const profile = await this.lockProfile(client, playerId);
        const classId = SUBCLASS_CLASS_IDS[subclassId];
        await this.lockSubclassProgress(client, playerId, subclassId);
        // Until production challenges exist, this development-only mutation is
        // the authoritative challenge-completion lifecycle used by fixtures.
        await client.query(
          `UPDATE player_subclass_progress
           SET unlocked = $3,
               completed_at = CASE WHEN $3 THEN COALESCE(completed_at, now()) ELSE NULL END
           WHERE player_id = $1 AND subclass_id = $2`,
          [playerId, subclassId, unlocked]
        );
        if (!unlocked) {
          const loadout = await this.lockLoadout(client, playerId, classId);
          const resets = normalizeSlots(loadout.reset_active_ids, 2)
            .map((id) => id === SUBCLASS_RESET_DEFINITIONS[subclassId].id ? null : id);
          const normals = normalizeSlots(loadout.normal_active_ids, 2);
          const selected = normalizedSelectedSubclasses(profile.selected_subclasses);
          if (selected[classId] === subclassId) selected[classId] = null;
          await client.query(
            `UPDATE player_class_profiles
             SET active_subclass_id = CASE WHEN active_class_id = $2 THEN NULL ELSE active_subclass_id END,
                 selected_subclasses = $3::jsonb
             WHERE player_id = $1`,
            [playerId, classId, JSON.stringify(selected)]
          );
          await client.query(
            `UPDATE player_class_loadouts
             SET reset_active_ids = $3, normal_active_ids = $4, revision = revision + 1
             WHERE player_id = $1 AND class_id = $2`,
            [playerId, classId, resets, normals]
          );
          await client.query(
            `UPDATE player_subclass_loadouts
             SET reset_id = NULL, reset_slot_index = NULL, active_id = NULL, revision = revision + 1
             WHERE player_id = $1 AND subclass_id = $2`, [playerId, subclassId]
          );
        }
      }
    );
  }

  async activateClass(
    playerId: string,
    classId: ClassId,
    requestId: string,
    options: { restricted: boolean; equipment?: EquipmentSnapshot }
  ): Promise<ClassMutationResult> {
    if (LAUNCH_CLASS_IDS.includes(classId as LaunchClassId)) throw new ClassRequestError("CLASS_SELECTION_MOVED", "Choose your class in Skills & Professions");
    if (options.restricted) throw new ClassRequestError("CLASS_SWITCH_RESTRICTED", "Class cannot change during combat or unresolved actions");
    if (!CLASS_IDS.includes(classId)) throw new ClassRequestError("CLASS_LOCKED", "Class is not unlocked");
    assertLaunchClassSelection(classId);
    if (options.equipment) validateClassEquipment(classId, null, options.equipment, false);
    return this.mutate(
      playerId,
      `class:${playerId}:switch-class:${requestId}`,
      "switch_class",
      { classId },
      async (client) => {
        if (classId !== "warrior") {
          const unlocked = await client.query(
            `SELECT 1 FROM player_class_unlocks WHERE player_id = $1 AND class_id = $2 FOR SHARE`,
            [playerId, classId]
          );
          if (!unlocked.rowCount) throw new ClassRequestError("CLASS_LOCKED", "Class must be permanently unlocked first");
        }
        const profile = await this.lockProfile(client, playerId);
        const classChanged = profile.active_class_id !== classId;
        const targetProgress = await this.lockClassProgress(client, playerId, classId);
        const selected = normalizedSelectedSubclasses(profile.selected_subclasses);
        let targetSubclass = selected[classId];
        if (targetSubclass) {
          const progress = await this.lockSubclassProgress(client, playerId, targetSubclass);
          if (!progress.unlocked || canonicalClassRank(targetProgress) < 25) targetSubclass = null;
          if (options.equipment && targetSubclass) {
            try { validateClassEquipment(classId, targetSubclass, options.equipment, false); }
            catch { targetSubclass = null; }
          }
        }
        await this.reconcileLoadout(client, playerId, classId, canonicalClassRank(targetProgress), targetSubclass);
        await client.query(
          `UPDATE player_class_profiles SET active_class_id = $2, active_subclass_id = $3 WHERE player_id = $1`,
          [playerId, classId, targetSubclass]
        );
        if (classChanged) {
          await client.query(
            `UPDATE player_class_runtime
             SET queued_ability_id = NULL, queued_target_entity_id = NULL, queued_at_tick = NULL,
                 counters = '{}'::jsonb,
                 combat_generation = combat_generation + 1, revision = revision + 1
             WHERE player_id = $1`, [playerId]
          );
        }
      }
    );
  }

  async unlockClass(
    playerId: string,
    classId: LaunchClassId,
    requestId: string
  ): Promise<ClassMutationResult> {
    if (classId !== "warrior" && classId !== "ranger") throw new ClassRequestError("CLASS_SELECTION_MOVED", "Choose your class in Skills & Professions");
    assertLaunchClassSelection(classId);
    if (classId === "warrior") return { replayed: true, snapshot: await this.getOrCreate(playerId) };
    const operationKey = `class-unlock:${playerId}:${classId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureRows(client, playerId);
      const existing = await client.query<{ unlock_operation_key: string }>(
        `SELECT unlock_operation_key FROM player_class_unlocks WHERE player_id = $1 AND class_id = $2 FOR UPDATE`,
        [playerId, classId]
      );
      if (existing.rowCount) {
        const replayed = existing.rows[0]!.unlock_operation_key === operationKey;
        const snapshot = await this.snapshot(client, playerId);
        await client.query("COMMIT");
        return { replayed, snapshot };
      }
      await client.query(
        `INSERT INTO player_class_unlocks (player_id, class_id, unlock_operation_key, gold_paid)
         VALUES ($1,$2,$3,0)`,
        [playerId, classId, operationKey]
      );
      await client.query(`UPDATE player_class_profiles SET revision = revision + 1 WHERE player_id = $1`, [playerId]);
      const snapshot = await this.snapshot(client, playerId);
      await client.query("COMMIT");
      return { replayed: false, snapshot };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async adjustOwnDevelopmentProgression(
    playerId: string,
    progressionType: DevProgressionType,
    targetLevel: number,
    operationId: string,
    options: { restricted: boolean }
  ): Promise<DevProgressionMutationResult> {
    const professionId = professionIdForProgressionType(progressionType);
    const maximumTarget = professionId !== null
      ? professionMaxRank(professionId)
      : progressionType === "character_level"
        ? CURRENT_LEVEL_CAP
        : progressionType === "hunter_level" ? 25 : CLASS_MAX_RANK;
    if (!Number.isInteger(targetLevel) || targetLevel < 0 || targetLevel > maximumTarget) {
      throw new ClassRequestError("DEV_PROGRESSION_RANGE_INVALID", `${progressionType} must be between 0 and ${maximumTarget}`);
    }
    if (progressionType === "character_level" && targetLevel > CURRENT_LEVEL_CAP) {
      throw new ClassRequestError("DEV_PROGRESSION_RANGE_INVALID", "Character level exceeds the current cap");
    }
    if (options.restricted) throw new ClassRequestError("DEV_PROGRESSION_RESTRICTED", "Progression cannot change during combat or unresolved actions");
    if (professionId !== null && !this.masteries) {
      throw new ClassRequestError("DEV_PROGRESSION_UNAVAILABLE", "Profession progression is unavailable");
    }
    const client = await this.pool.connect();
    const operationKey = `dev-progression:${playerId}:${operationId}`;
    try {
      await client.query("BEGIN");
      await this.ensureRows(client, playerId);
      await client.query(`INSERT INTO player_progression_profiles (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [playerId]);
      const reserved = await client.query(
        `INSERT INTO dev_progression_operations (operation_key, player_id, progression_type, target_rank)
         VALUES ($1,$2,$3,$4) ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key`,
        [operationKey, playerId, progressionType, targetLevel]
      );
      if (!reserved.rowCount) {
        const existing = await client.query<{
          player_id: string; progression_type: string; target_rank: number; character_xp_delta: number;
        }>(`SELECT player_id, progression_type, target_rank, character_xp_delta
            FROM dev_progression_operations WHERE operation_key = $1`, [operationKey]);
        const row = requireRow(existing.rows[0], "Development progression operation does not exist");
        if (row.player_id !== playerId || row.progression_type !== progressionType || Number(row.target_rank) !== targetLevel) {
          throw new ClassRequestError("DEV_PROGRESSION_OPERATION_CONFLICT", "Operation ID conflicts with another adjustment");
        }
        await this.lockProfile(client, playerId);
        const snapshot = await this.snapshot(client, playerId);
        const masteries = this.masteries ? await this.masteries.snapshotInTransaction(client, playerId) : undefined;
        await client.query("COMMIT");
        return {
          replayed: true,
          snapshot,
          characterXpDelta: Number(row.character_xp_delta),
          ...(masteries ? { masteries } : {})
        };
      }
      const profile = await this.lockProfile(client, playerId);
      const runtime = await client.query<{ queued_ability_id: string | null }>(
        `SELECT queued_ability_id FROM player_class_runtime WHERE player_id = $1 FOR UPDATE`, [playerId]
      ).then((result) => requireRow(result.rows[0], "Class runtime does not exist"));
      if (runtime.queued_ability_id !== null) throw new ClassRequestError("DEV_PROGRESSION_RESTRICTED", "Queued abilities must resolve first");
      let characterXpDelta = 0;
      if (professionId !== null) {
        await this.masteries!.adjustProfessionForDevelopmentInTransaction(client, playerId, professionId, targetLevel);
      } else if (progressionType === "character_level") {
        const progression = await client.query<{ total_xp: number }>(
          `SELECT total_xp FROM player_progression_profiles WHERE player_id = $1 FOR UPDATE`, [playerId]
        ).then((result) => requireRow(result.rows[0], "Progression profile does not exist"));
        const targetXp = totalXpForLevel(targetLevel);
        characterXpDelta = targetXp - Number(progression.total_xp);
        await client.query(
          `UPDATE player_progression_profiles
           SET total_xp = $2, level = $3, persistence_version = persistence_version + 1
           WHERE player_id = $1`, [playerId, targetXp, targetLevel]
        );
      } else {
        const classId = classIdForProgressionType(progressionType);
        const previous = await this.lockClassProgress(client, playerId, classId);
        const thresholds = classLevelXp(classId);
        await client.query(
          `UPDATE player_class_progress
           SET mastery_xp = $3::integer, mastery_rank = $4::integer, training_points_earned = 0, training_points_spent = 0,
               completed_at = CASE WHEN $4::integer = $5::integer THEN COALESCE(completed_at, now()) ELSE NULL END
           WHERE player_id = $1 AND class_id = $2`,
          [playerId, classId, thresholds[targetLevel], targetLevel, isLaunchClassId(classId) ? CLASS_MAX_RANK : 25]
        );
        await this.reconcileLoadout(client, playerId, classId, targetLevel, selectedSubclass(profile, classId));
        await this.autoEquipNewlyUnlockedWarriorActives(
          client, playerId, classId, canonicalClassRank(previous), targetLevel
        );
        if (targetLevel < canonicalClassRank(previous)) {
          await client.query(
            `UPDATE player_class_runtime
             SET queued_ability_id = NULL, queued_target_entity_id = NULL, queued_at_tick = NULL,
                 rage_reserved = 0, status_effects = '[]'::jsonb, counters = '{}'::jsonb,
                 combat_generation = combat_generation + 1, revision = revision + 1
             WHERE player_id = $1`,
            [playerId]
          );
          await client.query(
            `UPDATE player_class_resources
             SET reserved_value = 0, cooldown_ends_at = '{}'::jsonb
             WHERE player_id = $1 AND class_id = $2`,
            [playerId, classId]
          );
        }
        if (classId === "warrior" && this.masteries) {
          await this.masteries.reconcileDevelopmentMasteryAchievement(
            client, playerId, "warrior", targetLevel === WARRIOR_MAX_RANK
          );
        }
      }
      await client.query(`UPDATE player_class_profiles SET revision = revision + 1 WHERE player_id = $1`, [playerId]);
      const snapshot = await this.snapshot(client, playerId);
      const masteries = this.masteries ? await this.masteries.snapshotInTransaction(client, playerId) : undefined;
      await client.query(
        `UPDATE dev_progression_operations SET character_xp_delta = $2, result = $3::jsonb, completed_at = now()
         WHERE operation_key = $1`, [operationKey, characterXpDelta, JSON.stringify(snapshot)]
      );
      await client.query("COMMIT");
      return {
        replayed: false,
        snapshot,
        characterXpDelta,
        ...(masteries ? { masteries } : {})
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadRuntime(playerId: string): Promise<PersistedClassRuntime> {
    await this.ensureRows(this.pool, playerId);
    const result = await this.pool.query<ResourceRow & RuntimeRow & { active_class_id: ClassId }>(
      `SELECT profile.active_class_id, resource.class_id, resource.resource_id,
              resource.current_value, resource.reserved_value, resource.cooldown_ends_at,
              resource.last_combat_at, resource.updated_at,
              runtime.queued_ability_id, runtime.queued_target_entity_id, runtime.queued_at_tick,
              runtime.status_effects, runtime.counters, runtime.combat_generation,
              runtime.revision AS runtime_version
       FROM player_class_profiles profile
       JOIN player_class_resources resource
         ON resource.player_id = profile.player_id AND resource.class_id = profile.active_class_id
       JOIN player_class_runtime runtime ON runtime.player_id = profile.player_id
       WHERE profile.player_id = $1`, [playerId]
    );
    const row = requireRow(result.rows[0], "Class runtime does not exist");
    const current = Number(row.current_value);
    const reserved = Number(row.reserved_value);
    return {
      version: Number(row.runtime_version),
      activeClassId: row.active_class_id,
      resourceId: row.resource_id,
      resourceCurrent: current,
      resourceReserved: reserved,
      rage: row.active_class_id === "warrior" ? current : 0,
      rageReserved: row.active_class_id === "warrior" ? reserved : 0,
      queuedAbilityId: row.queued_ability_id,
      queuedTargetEntityId: row.queued_target_entity_id,
      queuedAtTick: row.queued_at_tick === null ? null : Number(row.queued_at_tick),
      cooldownEndsAt: row.cooldown_ends_at ?? {},
      statusEffects: Array.isArray(row.status_effects) ? row.status_effects : [],
      counters: row.counters ?? {},
      combatGeneration: Number(row.combat_generation),
      lastCombatAt: row.last_combat_at ? new Date(row.last_combat_at).getTime() : null,
      savedAt: new Date(row.updated_at).getTime()
    };
  }

  async persistRuntime(playerId: string, runtime: PersistedClassRuntime): Promise<void> {
    const current = clampResource(runtime.resourceCurrent ?? runtime.rage);
    const reserved = Math.min(100 - current, clampResource(runtime.resourceReserved ?? runtime.rageReserved));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureRows(client, playerId);
      const profile = await this.lockProfile(client, playerId);
      const persistedRuntime = await client.query<{
        combat_generation: string | number;
        runtime_version: string | number;
      }>(
        `SELECT combat_generation, revision AS runtime_version
         FROM player_class_runtime WHERE player_id = $1 FOR UPDATE`,
        [playerId]
      ).then((result) => requireRow(result.rows[0], "Class runtime does not exist"));
      const storedGeneration = Number(persistedRuntime.combat_generation);
      const storedVersion = Number(persistedRuntime.runtime_version);
      if (
        profile.active_class_id !== runtime.activeClassId ||
        !Number.isSafeInteger(runtime.combatGeneration) ||
        runtime.combatGeneration < storedGeneration ||
        !Number.isSafeInteger(runtime.version) ||
        runtime.version < 0 ||
        runtime.version < storedVersion
      ) {
        throw new ClassRequestError(
          "CLASS_RUNTIME_STALE",
          "Class runtime persistence no longer matches the authoritative class generation or version"
        );
      }
      // Equal versions are retries of the same immutable combat snapshot. They
      // are idempotent no-ops; only a strictly newer dirty-version may mutate
      // resource/runtime rows, so an older periodic flush cannot win a race.
      if (runtime.version === storedVersion) {
        await client.query("COMMIT");
        return;
      }
      await client.query(
        `UPDATE player_class_resources
         SET current_value = $3, reserved_value = $4, cooldown_ends_at = $5::jsonb,
             last_combat_at = $6, revision = revision + 1
         WHERE player_id = $1 AND class_id = $2`,
        [playerId, runtime.activeClassId, current, reserved, JSON.stringify(runtime.cooldownEndsAt),
          runtime.lastCombatAt === null ? null : new Date(runtime.lastCombatAt)]
      );
      await client.query(
        `UPDATE player_class_runtime
         SET rage = CASE WHEN $2 = 'warrior' THEN $3 ELSE rage END,
             rage_reserved = CASE WHEN $2 = 'warrior' THEN $4 ELSE rage_reserved END,
             queued_ability_id = $5, queued_target_entity_id = $6, queued_at_tick = $7,
             cooldown_ends_at = $8::jsonb, status_effects = $9::jsonb, counters = $10::jsonb,
             combat_generation = $11, last_combat_at = $12, revision = $13
         WHERE player_id = $1`,
        [playerId, runtime.activeClassId, current, reserved, runtime.queuedAbilityId,
          runtime.queuedTargetEntityId, runtime.queuedAtTick, JSON.stringify(runtime.cooldownEndsAt),
          JSON.stringify(runtime.statusEffects), JSON.stringify(runtime.counters), runtime.combatGeneration,
          runtime.lastCombatAt === null ? null : new Date(runtime.lastCombatAt), runtime.version]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async mutate(
    playerId: string,
    operationKey: string,
    action: "loadout" | "switch_subclass" | "switch_class" | "unlock_subclass",
    payload: unknown,
    apply: (client: pg.PoolClient) => Promise<void>
  ): Promise<ClassMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.ensureRows(client, playerId);
      const reserved = await client.query(
        `INSERT INTO class_operations (operation_key, player_id, action, payload)
         VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key`,
        [operationKey, playerId, action, JSON.stringify(payload)]
      );
      if (!reserved.rowCount) {
        const existing = await client.query<{ player_id: string; action: string; payload: unknown }>(
          `SELECT player_id, action, payload FROM class_operations WHERE operation_key = $1`, [operationKey]
        );
        const row = requireRow(existing.rows[0], "Class operation does not exist");
        if (row.player_id !== playerId || row.action !== action || JSON.stringify(row.payload) !== JSON.stringify(payload)) {
          throw new ClassRequestError("CLASS_OPERATION_CONFLICT", "Class operation key conflicts with another request");
        }
        await this.lockProfile(client, playerId);
        const snapshot = await this.snapshot(client, playerId);
        await client.query("COMMIT");
        return { replayed: true, snapshot };
      }
      await this.lockProfile(client, playerId);
      await apply(client);
      await client.query(`UPDATE player_class_profiles SET revision = revision + 1 WHERE player_id = $1`, [playerId]);
      const snapshot = await this.snapshot(client, playerId);
      await client.query(
        `UPDATE class_operations SET result = $2::jsonb, completed_at = now() WHERE operation_key = $1`,
        [operationKey, JSON.stringify(snapshot)]
      );
      await client.query("COMMIT");
      return { replayed: false, snapshot };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureRows(queryable: Queryable, playerId: string): Promise<void> {
    await queryable.query(`INSERT INTO player_class_profiles (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [playerId]);
    for (const classId of CLASS_IDS) {
      await queryable.query(
        `INSERT INTO player_class_progress (
           player_id, class_id, mastery_xp, mastery_rank, curve_version,
           training_points_earned, training_points_spent
         ) VALUES ($1,$2,0,0,$3,0,0) ON CONFLICT DO NOTHING`,
        [playerId, classId, classId === "hunter" ? 1 : CLASS_CURVE_VERSION]
      );
      await queryable.query(
        `INSERT INTO player_class_loadouts (player_id, class_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [playerId, classId]
      );
      await queryable.query(
        `INSERT INTO player_class_resources (player_id, class_id, resource_id, current_value)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [playerId, classId, classResourceId(classId), classInitialResource(classId)]
      );
    }
    for (const subclassId of SUBCLASS_IDS) {
      await queryable.query(
        `INSERT INTO player_subclass_progress (
           player_id, class_id, subclass_id, training_points_earned, training_points_spent
         ) VALUES ($1,$2,$3,0,0) ON CONFLICT DO NOTHING`,
        [playerId, SUBCLASS_CLASS_IDS[subclassId], subclassId]
      );
      await queryable.query(
        `INSERT INTO player_subclass_loadouts (player_id, subclass_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [playerId, subclassId]
      );
    }
    await queryable.query(`INSERT INTO player_class_runtime (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [playerId]);
    await queryable.query(
      `INSERT INTO player_class_unlocks (player_id, class_id, unlock_operation_key, gold_paid)
       VALUES ($1,'warrior',$2,0), ($1,'ranger',$3,0) ON CONFLICT DO NOTHING`,
      [playerId, `launch-default-warrior:${playerId}`, `launch-default-ranger:${playerId}`]
    );
    const fallback = await queryable.query(
      `UPDATE player_class_profiles
       SET active_class_id = CASE WHEN active_class_id = ANY($2::text[]) THEN active_class_id ELSE 'warrior' END,
           active_subclass_id = NULL,
           revision = revision + 1
       WHERE player_id = $1
         AND (NOT (active_class_id = ANY($2::text[])) OR active_subclass_id IS NOT NULL)
       RETURNING player_id`,
      [playerId, [...LAUNCH_CLASS_IDS]]
    );
    if (fallback.rowCount) {
      await queryable.query(
        `UPDATE player_class_runtime
         SET queued_ability_id = NULL, queued_target_entity_id = NULL, queued_at_tick = NULL,
             rage_reserved = 0, status_effects = '[]'::jsonb, counters = '{}'::jsonb,
             combat_generation = combat_generation + 1
         WHERE player_id = $1`,
        [playerId]
      );
    }
  }

  private async reconcileLoadout(
    queryable: Queryable,
    playerId: string,
    classId: ClassId,
    level: number,
    activeSubclassId: SubclassId | null
  ): Promise<void> {
    const loadout = await this.lockLoadout(queryable, playerId, classId);
    const subclasses = await this.subclassRows(queryable, playerId, true);
    const canonicalSubclass = level >= 25 ? activeSubclassId : null;
    const reconciled = reconciledLoadout({
      resetActives: normalizeSlots(loadout.reset_active_ids, 2),
      normalActives: normalizeSlots(loadout.normal_active_ids, 2),
      passiveTiers: normalizeSlots(loadout.passive_tier_ids, 3),
      ultimateActive: loadout.ultimate_active_id
    }, classId, level, canonicalSubclass, subclasses);
    if (level < 25 && activeSubclassId && subclassBelongsToClass(activeSubclassId, classId)) {
      const profile = await this.lockProfile(queryable, playerId);
      const selected = normalizedSelectedSubclasses(profile.selected_subclasses);
      selected[classId] = null;
      await queryable.query(
        `UPDATE player_class_profiles
         SET active_subclass_id = CASE WHEN active_class_id = $2 THEN NULL ELSE active_subclass_id END,
             selected_subclasses = $3::jsonb WHERE player_id = $1`,
        [playerId, classId, JSON.stringify(selected)]
      );
    }
    if (level < 25) {
      await queryable.query(
        `UPDATE player_subclass_loadouts loadout
         SET reset_id = NULL, reset_slot_index = NULL, active_id = NULL, revision = revision + 1
         FROM player_subclass_progress progress
         WHERE loadout.player_id = $1
           AND progress.player_id = loadout.player_id
           AND progress.subclass_id = loadout.subclass_id
           AND progress.class_id = $2
           AND (loadout.reset_id IS NOT NULL OR loadout.reset_slot_index IS NOT NULL OR loadout.active_id IS NOT NULL)`,
        [playerId, classId]
      );
    }
    const currentResetActives = normalizeSlots(loadout.reset_active_ids, 2);
    const currentNormalActives = normalizeSlots(loadout.normal_active_ids, 2);
    const currentPassiveTiers = normalizeSlots(loadout.passive_tier_ids, 3);
    const currentUltimate = loadout.ultimate_active_id;
    if (
      slotsEqual(currentResetActives, reconciled.resetActives)
      && slotsEqual(currentNormalActives, reconciled.normalActives)
      && slotsEqual(currentPassiveTiers, reconciled.passiveTiers)
      && currentUltimate === reconciled.ultimateActive
    ) return;
    await queryable.query(
      `UPDATE player_class_loadouts
       SET reset_active_ids = $3, normal_active_ids = $4, passive_tier_ids = $5,
           ultimate_active_id = $6, revision = revision + 1
       WHERE player_id = $1 AND class_id = $2`,
      [playerId, classId, reconciled.resetActives, reconciled.normalActives, reconciled.passiveTiers, reconciled.ultimateActive]
    );
  }

  private async snapshot(queryable: Queryable, playerId: string): Promise<ClassSnapshot> {
    const profileResult = await queryable.query<ProfileRow>(
        `SELECT active_class_id, active_subclass_id, selected_subclasses, revision
         FROM player_class_profiles WHERE player_id = $1`, [playerId]
      );
    const classResult = await queryable.query<ClassProgressRow>(
        `SELECT class_id, mastery_xp, mastery_rank, curve_version, completed_at
         FROM player_class_progress WHERE player_id = $1 ORDER BY class_id`, [playerId]
      );
    const subclassResult = await queryable.query<SubclassProgressRow>(
        `SELECT class_id, subclass_id, unlocked FROM player_subclass_progress
         WHERE player_id = $1 ORDER BY class_id, subclass_id`, [playerId]
      );
    const legacyResult = await queryable.query<{ legacy_id: string }>(
        `SELECT legacy_id FROM player_class_legacy_unlocks WHERE player_id = $1 ORDER BY legacy_id`, [playerId]
      );
    const runtimeResult = await queryable.query<RuntimeRow>(
        `SELECT queued_ability_id, queued_target_entity_id, queued_at_tick,
                status_effects, counters, combat_generation
         FROM player_class_runtime WHERE player_id = $1`, [playerId]
      );
    const resourceResult = await queryable.query<ResourceRow>(
        `SELECT class_id, resource_id, current_value, reserved_value, cooldown_ends_at,
                last_combat_at, updated_at
         FROM player_class_resources WHERE player_id = $1 ORDER BY class_id`, [playerId]
      );
    const professionResult = await queryable.query<{ profession_id: ProfessionId; rank: number }>(
      `SELECT profession_id, rank FROM player_profession_progress WHERE player_id = $1`, [playerId]
    );
    const unlockResult = await queryable.query<{ class_id: LaunchClassId }>(
      `SELECT class_id FROM player_class_unlocks
       WHERE player_id = $1 AND class_id = ANY($2::text[])
       ORDER BY class_id`, [playerId, [...LAUNCH_CLASS_IDS]]
    );
    const profile = requireRow(profileResult.rows[0], "Class profile does not exist");
    const runtime = requireRow(runtimeResult.rows[0], "Class runtime does not exist");
    const classes = classResult.rows.map(progressView);
    const warrior = requireRow(classes.find((entry) => entry.classId === "warrior"), "Warrior progress does not exist");
    const byClass = new Map(classes.map((entry) => [entry.classId, entry]));
    const druid = requireRow(byClass.get("druid"), "Druid progress does not exist");
    const ranger = requireRow(byClass.get("ranger"), "Ranger progress does not exist");
    const hunter = requireRow(byClass.get("hunter"), "Hunter compatibility progress does not exist");
    const knight = requireRow(byClass.get("knight"), "Knight progress does not exist");
    const ninja = requireRow(byClass.get("ninja"), "Ninja progress does not exist");
    const activeLoadout = await this.readLoadout(queryable, playerId, profile.active_class_id);
    const resources = resourceResult.rows.map(resourceView);
    const resource = requireRow(resources.find((entry) => entry.classId === profile.active_class_id), "Class resource does not exist");
    const loadout: ClassLoadoutView = {
      resetActives: normalizeSlots(activeLoadout.reset_active_ids, 2),
      normalActives: normalizeSlots(activeLoadout.normal_active_ids, 2),
      passiveTiers: normalizeSlots(activeLoadout.passive_tier_ids, 3),
      ultimateActive: activeLoadout.ultimate_active_id
    };
    return {
      playerId,
      characterLevel: await this.characterLevel(queryable, playerId),
      activeClassId: profile.active_class_id,
      unlockedClassIds: unlockResult.rows.map((row) => row.class_id),
      activeSubclassId: profile.active_subclass_id,
      equipmentAffinity: classEquipmentAffinitySnapshot(profile.active_class_id),
      warrior,
      druid, ranger, hunter, knight, ninja,
      classes,
      subclasses: subclassResult.rows.map((row) => ({
        classId: row.class_id, subclassId: row.subclass_id, unlocked: row.unlocked
      })),
      selectedSubclasses: normalizedSelectedSubclasses(profile.selected_subclasses),
      loadout,
      ...(profile.active_class_id === "hunter" ? { resource } : {}),
      resources: resources.filter((entry) => entry.classId === "hunter"),
      weaponMode: await this.activeWeaponMode(queryable, playerId, profile.active_class_id),
      legacyIds: legacyResult.rows.map((row) => row.legacy_id),
      rage: 0,
      maximumRage: 0,
      queuedAbility: runtime.queued_ability_id && runtime.queued_at_tick !== null ? {
        abilityId: runtime.queued_ability_id,
        targetEntityId: runtime.queued_target_entity_id,
        reservedRage: profile.active_class_id === "hunter" ? resource.reserved : 0,
        reservedResource: profile.active_class_id === "hunter" ? resource.reserved : 0,
        queuedAtTick: Number(runtime.queued_at_tick)
      } : null,
      cooldownEndsAt: resource.cooldownEndsAt,
      serverTime: Date.now(),
      revision: Number(profile.revision),
      professionRanks: {
        woodcutter: Number(professionResult.rows.find((row) => row.profession_id === "woodcutter")?.rank ?? 0),
        miner: Number(professionResult.rows.find((row) => row.profession_id === "miner")?.rank ?? 0),
        builder: Number(professionResult.rows.find((row) => row.profession_id === "builder")?.rank ?? 0),
        oil_worker: Number(professionResult.rows.find((row) => row.profession_id === "oil_worker")?.rank ?? 0),
        metallurgy: Number(professionResult.rows.find((row) => row.profession_id === "metallurgy")?.rank ?? 0)
      }
    };
  }

  private lockProfile(queryable: Queryable, playerId: string): Promise<ProfileRow> {
    return queryable.query<ProfileRow>(
      `SELECT active_class_id, active_subclass_id, selected_subclasses, revision
       FROM player_class_profiles WHERE player_id = $1 FOR UPDATE`, [playerId]
    ).then((result) => requireRow(result.rows[0], "Class profile does not exist"));
  }
  private lockClassProgress(queryable: Queryable, playerId: string, classId: ClassId): Promise<ClassProgressRow> {
    return queryable.query<ClassProgressRow>(
      `SELECT class_id, mastery_xp, mastery_rank, curve_version, completed_at
       FROM player_class_progress WHERE player_id = $1 AND class_id = $2 FOR UPDATE`, [playerId, classId]
    ).then((result) => requireRow(result.rows[0], "Class progress does not exist"));
  }
  private lockSubclassProgress(queryable: Queryable, playerId: string, subclassId: SubclassId): Promise<SubclassProgressRow> {
    return queryable.query<SubclassProgressRow>(
      `SELECT class_id, subclass_id, unlocked FROM player_subclass_progress
       WHERE player_id = $1 AND subclass_id = $2 FOR UPDATE`, [playerId, subclassId]
    ).then((result) => requireRow(result.rows[0], "Subclass progress does not exist"));
  }
  private subclassRows(queryable: Queryable, playerId: string, lock = false): Promise<SubclassProgressRow[]> {
    return queryable.query<SubclassProgressRow>(
      `SELECT class_id, subclass_id, unlocked FROM player_subclass_progress
       WHERE player_id = $1 ORDER BY class_id, subclass_id${lock ? " FOR UPDATE" : ""}`, [playerId]
    ).then((result) => result.rows);
  }
  private lockLoadout(queryable: Queryable, playerId: string, classId: ClassId): Promise<LoadoutRow> {
    return queryable.query<LoadoutRow>(
      `SELECT reset_active_ids, normal_active_ids, passive_tier_ids, ultimate_active_id
       FROM player_class_loadouts WHERE player_id = $1 AND class_id = $2 FOR UPDATE`, [playerId, classId]
    ).then((result) => requireRow(result.rows[0], "Class loadout does not exist"));
  }
  private readLoadout(queryable: Queryable, playerId: string, classId: ClassId): Promise<LoadoutRow> {
    return queryable.query<LoadoutRow>(
      `SELECT reset_active_ids, normal_active_ids, passive_tier_ids, ultimate_active_id
       FROM player_class_loadouts WHERE player_id = $1 AND class_id = $2`, [playerId, classId]
    ).then((result) => requireRow(result.rows[0], "Class loadout does not exist"));
  }
  private savedSubclassLoadout(queryable: Queryable, playerId: string, subclassId: SubclassId): Promise<SavedSubclassLoadoutRow> {
    return queryable.query<SavedSubclassLoadoutRow>(
      `SELECT reset_id, reset_slot_index, active_id FROM player_subclass_loadouts
       WHERE player_id = $1 AND subclass_id = $2 FOR UPDATE`, [playerId, subclassId]
    ).then((result) => requireRow(result.rows[0], "Subclass loadout does not exist"));
  }
  private async characterLevel(queryable: Queryable, playerId: string): Promise<number> {
    const result = await queryable.query<{ level: number }>(
      `SELECT level FROM player_progression_profiles WHERE player_id = $1`, [playerId]
    );
    return Number(result.rows[0]?.level ?? 0);
  }
  private async activeWeaponMode(
    queryable: Queryable,
    playerId: string,
    classId: ClassId
  ): Promise<ClassWeaponMode | null> {
    const result = await queryable.query<{ definition_id: string }>(
      `SELECT equipment.definition_id
       FROM player_equipment_state state
       JOIN equipment_instances equipment
         ON equipment.owner_player_id = state.player_id
        AND equipment.location = 'equipped'
        AND equipment.equipped_slot = state.readied_weapon_slot
       WHERE state.player_id = $1`,
      [playerId]
    );
    const id = result.rows[0]?.definition_id;
    return id ? classWeaponMode(classId, requireEquipmentDefinition(id).weaponCategory) : null;
  }

  private async autoEquipNewlyUnlockedWarriorActives(
    queryable: Queryable,
    playerId: string,
    classId: ClassId,
    previousRank: number,
    resultingRank: number
  ): Promise<void> {
    if (classId !== "warrior" || resultingRank <= previousRank) return;
    const loadout = await this.lockLoadout(queryable, playerId, classId);
    const current: ClassLoadoutView = {
      resetActives: normalizeSlots(loadout.reset_active_ids, 2),
      normalActives: normalizeSlots(loadout.normal_active_ids, 2),
      passiveTiers: normalizeSlots(loadout.passive_tier_ids, 3),
      ultimateActive: loadout.ultimate_active_id
    };
    const reconciled = reconcileLaunchWarriorLoadout(current, resultingRank, previousRank);
    if (
      slotsEqual(current.resetActives, reconciled.resetActives) &&
      slotsEqual(current.normalActives, reconciled.normalActives) &&
      slotsEqual(current.passiveTiers, reconciled.passiveTiers)
    ) return;
    await queryable.query(
      `UPDATE player_class_loadouts
       SET reset_active_ids = $3, normal_active_ids = $4, passive_tier_ids = $5, revision = revision + 1
       WHERE player_id = $1 AND class_id = $2`,
      [playerId, classId, reconciled.resetActives, reconciled.normalActives, reconciled.passiveTiers]
    );
  }
}

function validateLoadoutShape(loadout: ClassLoadoutView): void {
  if (loadout.resetActives.length !== 2 || loadout.normalActives.length !== 2 || loadout.passiveTiers.length !== 3) {
    throw new ClassRequestError("LOADOUT_SHAPE_INVALID", "Loadout has an invalid slot count");
  }
  if (loadout.ultimateActive !== null && (typeof loadout.ultimateActive !== "string" || loadout.ultimateActive.length === 0)) {
    throw new ClassRequestError("LOADOUT_SHAPE_INVALID", "Ultimate slot is invalid");
  }
}

function validateLoadout(
  loadout: ClassLoadoutView,
  classId: ClassId,
  level: number,
  activeSubclassId: SubclassId | null,
  subclasses: SubclassProgressRow[]
): void {
  const ids = [...loadout.resetActives, ...loadout.normalActives, ...loadout.passiveTiers, loadout.ultimateActive]
    .filter((id): id is string => id !== null);
  if (new Set(ids).size !== ids.length) throw new ClassRequestError("LOADOUT_DUPLICATE", "A technique cannot occupy multiple slots");
  if (isLaunchClassId(classId)) {
    assertLaunchWarriorActiveLoadout(loadout);
    const unlocked = availableTechniqueSet(classId, level, subclasses);
    validateTechniqueSlots(loadout.normalActives, "normal", unlockedNormalSlots(level), classId, level, activeSubclassId, unlocked);
    const tiers: readonly PassiveTier[] = [0, 10, 20];
    for (let index = 0; index < tiers.length; index += 1) {
      const id = loadout.passiveTiers[index];
      if (index >= unlockedPassiveTierSlots(level)) {
        if (id !== null) throw new ClassRequestError("LOADOUT_SLOT_LOCKED", `Passive tier ${tiers[index]} is locked`);
        continue;
      }
      if (!id) throw new ClassRequestError("LOADOUT_SLOT_REQUIRED", `Choose one passive for tier ${tiers[index]}`);
      const definition = definitionForLoadout(id, unlocked, classId);
      if (definition.kind !== "passive" || definition.passiveTier !== tiers[index]) {
        throw new ClassRequestError("LOADOUT_SLOT_INVALID", `Passive does not belong to tier ${tiers[index]}`);
      }
    }
    if (loadout.ultimateActive !== null) {
      throw new ClassRequestError("LOADOUT_SLOT_INVALID", "Classes do not use ultimate abilities");
    }
    return;
  }
  const unlocked = availableTechniqueSet(classId, level, subclasses);
  validateTechniqueSlots(loadout.resetActives, "reset", unlockedResetSlots(level), classId, level, activeSubclassId, unlocked);
  validateTechniqueSlots(loadout.normalActives, "normal", unlockedNormalSlots(level), classId, level, activeSubclassId, unlocked);
  const tiers: readonly PassiveTier[] = [0, 10, 20];
  for (let index = 0; index < loadout.passiveTiers.length; index += 1) {
    const id = loadout.passiveTiers[index];
    if (index >= unlockedPassiveTierSlots(level) && id !== null) throw new ClassRequestError("LOADOUT_SLOT_LOCKED", `Passive tier ${tiers[index]} is locked`);
    if (!id) continue;
    const definition = definitionForLoadout(id, unlocked, classId);
    if (definition.kind !== "passive" || definition.passiveTier !== tiers[index]) {
      throw new ClassRequestError("LOADOUT_SLOT_INVALID", `Passive does not belong to tier ${tiers[index]}`);
    }
  }
  if (loadout.ultimateActive !== null) {
    throw new ClassRequestError("LOADOUT_SLOT_INVALID", "Classes do not use ultimate abilities");
  }
}

export function assertLaunchWarriorActiveLoadout(loadout: ClassLoadoutView): void {
  if (loadout.resetActives.some((id) => id !== null)) {
    throw new ClassRequestError("LOADOUT_SLOT_INVALID", "Warrior no longer uses reset abilities");
  }
}

function validateTechniqueSlots(
  slots: readonly (string | null)[],
  kind: "reset" | "normal",
  unlockedSlots: number,
  classId: ClassId,
  _level: number,
  activeSubclassId: SubclassId | null,
  unlocked: Set<string>
): void {
  for (let index = 0; index < slots.length; index += 1) {
    const id = slots[index];
    if (index >= unlockedSlots && id !== null) throw new ClassRequestError("LOADOUT_SLOT_LOCKED", `${kind} slot ${index + 1} is locked`);
    if (!id) continue;
    const definition = definitionForLoadout(id, unlocked, classId);
    if (definition.kind !== kind) {
      throw new ClassRequestError("LOADOUT_SLOT_INVALID", `${kind} slot contains an invalid technique`);
    }
    if (definition.subclassId !== null && definition.subclassId !== activeSubclassId) {
      throw new ClassRequestError("LOADOUT_SUBCLASS_INVALID", "Subclass reset does not match the active subclass");
    }
  }
}

function definitionForLoadout(id: string, unlocked: Set<string>, classId: ClassId) {
  if (!isLaunchTechniqueId(id)) {
    throw new ClassRequestError("TECHNIQUE_NOT_LAUNCH_ENABLED", "Technique is not available at launch");
  }
  if (!unlocked.has(id)) throw new ClassRequestError("TECHNIQUE_LEVEL_REQUIRED", "Technique is not automatically unlocked yet");
  try {
    const definition = requireTechniqueDefinition(id);
    if (definition.classId !== classId) throw new Error("wrong class");
    return definition;
  } catch {
    throw new ClassRequestError("TECHNIQUE_UNKNOWN", "Unknown class technique");
  }
}

function reconciledLoadout(
  loadout: ClassLoadoutView,
  classId: ClassId,
  level: number,
  activeSubclassId: SubclassId | null,
  subclasses: SubclassProgressRow[]
): ClassLoadoutView {
  if (isLaunchClassId(classId)) return reconcileLaunchLoadout(loadout, classId, level);
  const unlocked = availableTechniqueSet(classId, level, subclasses);
  const resets = normalizeSlots([...loadout.resetActives], 2).map((id, index) => {
    const definition = id ? TECHNIQUE_BY_ID[id] : null;
    return index < unlockedResetSlots(level) && id && isLaunchTechniqueId(id) && unlocked.has(id) && definition?.kind === "reset" &&
      definition.classId === classId && (definition.subclassId === null || definition.subclassId === activeSubclassId)
      ? id : null;
  });
  const normals = normalizeSlots([...loadout.normalActives], 2).map((id, index) => {
    const definition = id ? TECHNIQUE_BY_ID[id] : null;
    return index < unlockedNormalSlots(level) && id && isLaunchTechniqueId(id) && unlocked.has(id) && definition?.kind === "normal" &&
      definition.classId === classId && (definition.subclassId === null || definition.subclassId === activeSubclassId)
      ? id : null;
  });
  const tiers: readonly PassiveTier[] = [0, 10, 20];
  const passives = normalizeSlots([...loadout.passiveTiers], 3).map((id, index) => {
    const definition = id ? TECHNIQUE_BY_ID[id] : null;
    return index < unlockedPassiveTierSlots(level) && id && isLaunchTechniqueId(id) && unlocked.has(id) && definition?.kind === "passive" &&
      definition.classId === classId && definition.passiveTier === tiers[index] ? id : null;
  });
  return { resetActives: resets, normalActives: normals, passiveTiers: passives, ultimateActive: null };
}

function validateClassEquipment(
  classId: ClassId,
  subclassId: SubclassId | null,
  equipment: EquipmentSnapshot,
  requireWeapon: boolean
): void {
  const compatibility = classEquipmentCompatibility({
    classId,
    subclassId,
    weaponCategory: equipment.weapon?.weaponCategory ?? null,
    armorCategory: equipment.chest?.armorCategory ?? null
  });
  if (!compatibility.compatible) throw new ClassRequestError(compatibility.code, compatibility.message);
  if (requireWeapon && !equipment.weapon) {
    throw new ClassRequestError("CLASS_WEAPON_REQUIRED", "The active class requires a compatible weapon");
  }
}

function clearSubclassTechniques(values: Array<string | null>): void {
  for (let index = 0; index < values.length; index += 1) {
    const id = values[index];
    if (id && TECHNIQUE_BY_ID[id]?.subclassId) values[index] = null;
  }
}
async function saveSubclassTechniques(
  queryable: Queryable,
  playerId: string,
  subclassId: SubclassId,
  resetActives: Array<string | null>
): Promise<void> {
  const id = SUBCLASS_RESET_DEFINITIONS[subclassId].id;
  const slot = resetActives.indexOf(id);
  await queryable.query(
    `UPDATE player_subclass_loadouts
     SET reset_id = $3, reset_slot_index = $4, active_id = $5, revision = revision + 1
     WHERE player_id = $1 AND subclass_id = $2`,
    [playerId, subclassId, slot >= 0 ? id : null, slot >= 0 ? slot : null, null]
  );
}
function normalizedSelectedSubclasses(
  input: Partial<Record<ClassId, SubclassId | null>> | null | undefined
): Record<ClassId, SubclassId | null> {
  const selected = {} as Record<ClassId, SubclassId | null>;
  for (const classId of CLASS_IDS) {
    const subclassId = input?.[classId];
    selected[classId] = subclassId && subclassBelongsToClass(subclassId, classId) ? subclassId : null;
  }
  return selected;
}
function classIdForProgressionType(progressionType: Exclude<DevProgressionType, "character_level">): ClassId {
  const classId = progressionType.replace(/_level$/, "") as ClassId;
  if (!CLASS_IDS.includes(classId)) {
    throw new ClassRequestError("DEV_PROGRESSION_TYPE_INVALID", "Unknown class progression type");
  }
  return classId;
}
function selectedSubclass(profile: ProfileRow, classId: ClassId): SubclassId | null {
  return normalizedSelectedSubclasses(profile.selected_subclasses)[classId];
}
function progressStub(classId: ClassId, level: number): ClassProgressView {
  return { classId, level, xp: 0, nextLevelXp: null, completedAt: null };
}
function availableTechniqueSet(
  classId: ClassId,
  level: number,
  subclasses: SubclassProgressRow[]
): Set<string> {
  const classes = CLASS_IDS.map((id) => progressStub(id, id === classId ? level : 0));
  return new Set(availableTechniqueIds({
    activeClassId: classId,
    warrior: requireRow(classes.find((entry) => entry.classId === "warrior"), "Warrior progress stub is missing"),
    classes,
    subclasses: subclasses.map((row) => ({
      classId: row.class_id,
      subclassId: row.subclass_id,
      unlocked: row.unlocked
    }))
  }));
}
function progressView(row: ClassProgressRow): ClassProgressView {
  const level = canonicalClassRank(row);
  const thresholds = classLevelXp(row.class_id);
  const maximumRank = thresholds.length - 1;
  return {
    classId: row.class_id,
    level,
    xp: Number(row.mastery_xp),
    nextLevelXp: level >= maximumRank ? null : thresholds[level + 1]!,
    completedAt: iso(row.completed_at)
  };
}
function canonicalClassRank(row: ClassProgressRow): number {
  if (!isLaunchClassId(row.class_id)) return Number(row.mastery_rank);
  if (Number(row.curve_version) !== CLASS_CURVE_VERSION) {
    throw new Error(`Unsupported launch class curve version ${row.curve_version}`);
  }
  return classLevelForXp(Number(row.mastery_xp), row.class_id);
}
function resourceView(row: ResourceRow): ClassResourceView & { cooldownEndsAt: Record<string, number> } {
  return {
    classId: row.class_id,
    resourceId: row.resource_id,
    displayName: classResourceDisplayName(row.class_id),
    current: Number(row.current_value),
    maximum: 100,
    reserved: Number(row.reserved_value),
    updatedAt: new Date(row.updated_at).toISOString(),
    cooldownEndsAt: row.cooldown_ends_at ?? {}
  };
}
function normalizeSlots(value: Array<string | null> | null, count: number): Array<string | null> {
  return Array.from({ length: count }, (_, index) => value?.[index] ?? null);
}

export function reconcileLaunchWarriorLoadout(
  loadout: ClassLoadoutView,
  rank: number,
  newlyUnlockedFromRank: number | null = null
): ClassLoadoutView {
  void newlyUnlockedFromRank;
  return reconcileLaunchLoadout(loadout, "warrior", rank);
}

export function reconcileLaunchLoadout(
  _loadout: ClassLoadoutView,
  _classId: LaunchClassId,
  _rank: number
): ClassLoadoutView {
  // Current classes grant rank effects only. General Skill actives use their own loadout.
  return { resetActives: [null, null], normalActives: [null, null], passiveTiers: [null, null, null], ultimateActive: null };
}

function professionIdForProgressionType(progressionType: DevProgressionType): ProfessionId | null {
  if (progressionType === "woodcutter_level") return "woodcutter";
  if (progressionType === "miner_level") return "miner";
  if (progressionType === "builder_level") return "builder";
  if (progressionType === "oil_worker_level") return "oil_worker";
  if (progressionType === "metallurgy_level") return "metallurgy";
  return null;
}

function slotsEqual(left: readonly (string | null)[], right: readonly (string | null)[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function clampResource(value: number): number {
  return Math.max(0, Math.min(100, Math.trunc(Number.isFinite(value) ? value : 0)));
}
function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
function requireRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}

export const CLASS_DEFINITION_COUNTS = {
  classes: CLASS_IDS.length,
  definitions: ALL_TECHNIQUE_DEFINITIONS.length,
  subclasses: SUBCLASS_IDS.length
} as const;
