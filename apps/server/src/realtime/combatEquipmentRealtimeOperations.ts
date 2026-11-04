import {
  applySkillSystemV3CombatStats,
  applyClassCombatStats,
  isEquipmentDefinitionId,
  playerPveStats,
  requireEquipmentDefinition,
  resolveV3DefenseProfileForEquipmentFamily,
  resolveV3WeaponProfileForEquipmentFamily,
  type ClassCombatState,
  type ClassSnapshot,
  type EquipmentSnapshot,
  type EquipmentSnapshotV2,
  type KingdomStatModifiers,
  type ProgressionSnapshot,
  type SkillSystemV3Snapshot
} from "@ash-atlas/shared";

import type { ClassService } from "../game/classes/classService.js";
import type { SkillService } from "../game/skills/index.js";
import {
  playerEquipmentCombatStateFromSnapshot,
  type CombatEngine,
  type EquipmentCombatUpdateKind
} from "../game/combat/combatEngine.js";
import type {
  EquipmentRuntimeContext,
  EquipmentService
} from "../game/equipment.js";
import type { KingdomService } from "../game/kingdoms.js";
import { loadMaxHealthPenaltySafely, type ProgressionService } from "../game/progression.js";
import type { ConnectionRegistry, SocketLike } from "./connectionRegistry.js";
import { safeSendServerMessage } from "./handlers/handlerExecutionContext.js";

export function createConnectionCombatEquipmentOperations(context: Readonly<{
  socket: SocketLike;
  registry: ConnectionRegistry;
  combat?: CombatEngine | undefined;
  progression?: ProgressionService | undefined;
  equipment?: EquipmentService | undefined;
}>): Readonly<{
  applyLiveClassMutationState(
    authoritativePlayerId: string,
    snapshot: ClassSnapshot,
    currentEquipment: EquipmentSnapshotV2
  ): Promise<ProgressionSnapshot | null>;
  applyLiveSkillMutationState(
    authoritativePlayerId: string,
    snapshot: SkillSystemV3Snapshot,
    currentEquipment: EquipmentSnapshotV2,
    options?: Readonly<{ preserveHealthPercentage?: boolean }>
  ): Promise<ProgressionSnapshot | null>;
}> {
  const { socket, registry, combat, progression, equipment } = context;

  async function applyLiveClassMutationState(
    authoritativePlayerId: string,
    snapshot: ClassSnapshot,
    currentEquipment: EquipmentSnapshotV2
  ): Promise<ProgressionSnapshot | null> {
    let classAwareProgression: ProgressionSnapshot | null = null;
    let canonicalEquipment = currentEquipment;
    const baseProgression = progression
      ? await progression.getOrCreate(authoritativePlayerId)
      : null;
    canonicalEquipment = equipment?.runtimeSnapshot(authoritativePlayerId)
      ? equipment.setRuntimeContext(
          authoritativePlayerId,
          equipmentRuntimeContextFor(baseProgression, snapshot)
        )
      : currentEquipment;
    if (baseProgression) {
      const equipmentAware = withEquipmentStats(baseProgression, canonicalEquipment);
      classAwareProgression = {
        ...equipmentAware,
        pveStats: applyClassCombatStats(equipmentAware.pveStats, snapshot, canonicalEquipment)
      };
      combat?.updatePlayerPveStats(authoritativePlayerId, {
        level: classAwareProgression.level,
        maxHealth: classAwareProgression.pveStats.maxHealth,
        attackPower: classAwareProgression.pveStats.attackPower,
        defense: classAwareProgression.pveStats.defense
      }, { preserveCurrentHealth: true });
    }
    combat?.updatePlayerClassState(authoritativePlayerId, snapshot, canonicalEquipment);
    combat?.syncPlayerEquipmentCombatState(
      authoritativePlayerId,
      playerEquipmentCombatStateFromSnapshot(canonicalEquipment)
    );
    if (classAwareProgression) {
      safeSendServerMessage(socket, {
        type: "PROGRESSION_SNAPSHOT",
        progression: classAwareProgression
      });
    }
    registry.send(authoritativePlayerId, {
      type: "EQUIPMENT_SNAPSHOT",
      equipment: canonicalEquipment
    });
    return classAwareProgression;
  }

  async function applyLiveSkillMutationState(
    authoritativePlayerId: string,
    snapshot: SkillSystemV3Snapshot,
    currentEquipment: EquipmentSnapshotV2,
    options: Readonly<{ preserveHealthPercentage?: boolean }> = {}
  ): Promise<ProgressionSnapshot | null> {
    const baseProgression = progression
      ? await progression.getOrCreate(authoritativePlayerId)
      : null;
    let skillAwareProgression: ProgressionSnapshot | null = null;
    if (baseProgression) {
      skillAwareProgression = withSkillSystemV3Stats(
        baseProgression,
        currentEquipment,
        snapshot
      );
      combat?.updatePlayerPveStats(authoritativePlayerId, {
        level: skillAwareProgression.level,
        maxHealth: skillAwareProgression.pveStats.maxHealth,
        attackPower: skillAwareProgression.pveStats.attackPower,
        defense: skillAwareProgression.pveStats.defense
      }, options.preserveHealthPercentage ? {} : { preserveCurrentHealth: true });
    }
    combat?.updatePlayerSkillState(authoritativePlayerId, snapshot);
    if (skillAwareProgression) {
      safeSendServerMessage(socket, { type: "PROGRESSION_SNAPSHOT", progression: skillAwareProgression });
    }
    return skillAwareProgression;
  }

  return { applyLiveClassMutationState, applyLiveSkillMutationState };
}

export function createCombatEquipmentRealtimeOperations(context: Readonly<{
  combat?: CombatEngine | undefined;
  progression?: ProgressionService | undefined;
  equipment?: EquipmentService | undefined;
  classes?: ClassService | undefined;
  skills?: SkillService | undefined;
  kingdoms?: KingdomService | undefined;
}>): Readonly<{
  refreshAuthoritativePlayerStats(playerId: string): Promise<{
    progression: ProgressionSnapshot;
    equipment: EquipmentSnapshotV2;
  }>;
  stageEquipmentSnapshot(
    playerId: string,
    requestId: string,
    kind: EquipmentCombatUpdateKind,
    snapshot: EquipmentSnapshotV2,
    options?: Readonly<{ maxHealth?: number | null }>
  ): boolean;
  /** The player's max health (before Vigor Serum and the PvP penalty) with `snapshot` worn; null when unknown. */
  resolvePveMaxHealth(playerId: string, snapshot: EquipmentSnapshotV2): Promise<number | null>;
}> {
  const { combat, progression, equipment, classes, skills, kingdoms } = context;

  const refreshAuthoritativePlayerStats = async (
    playerId: string
  ): Promise<{ progression: ProgressionSnapshot; equipment: EquipmentSnapshotV2 }> => {
    if (!progression || !equipment) throw new Error("Progression service is unavailable");
    const [baseProgression, classSnapshot, skillSnapshot, kingdomModifiers, maxHealthPenalty] = await Promise.all([
      progression.getOrCreate(playerId),
      classes?.getOrCreate(playerId),
      skills?.getOrCreate(playerId),
      kingdoms?.statModifiers(playerId),
      loadMaxHealthPenaltySafely(progression, playerId)
    ]);
    if (maxHealthPenalty !== undefined) combat?.setPlayerMaxHealthPenalty(playerId, maxHealthPenalty);
    const runtimeContext = equipmentRuntimeContextFor(baseProgression, classSnapshot ?? null);
    const runtimeSnapshot = equipment.runtimeSnapshot(playerId);
    let equipmentSnapshot: EquipmentSnapshotV2;
    if (runtimeSnapshot) {
      equipmentSnapshot = equipment.setRuntimeContext(playerId, runtimeContext);
      const pendingActivation = equipment.pendingActivation(playerId);
      if (pendingActivation && combat) {
        combat.stageEquipmentCombatUpdate(playerId, {
          requestId: pendingActivation.requestId,
          kind: "kit_activation",
          state: playerEquipmentCombatStateFromSnapshot(pendingActivation.equipment)
        });
      }
    } else {
      equipmentSnapshot = await equipment.getSnapshot(playerId, runtimeContext);
    }
    const resolvedProgression = resolveProgression(
      baseProgression,
      equipmentSnapshot,
      classSnapshot ?? null,
      skillSnapshot ?? null,
      kingdomModifiers
    );
    combat?.updatePlayerPveStats(playerId, {
      level: resolvedProgression.level,
      maxHealth: resolvedProgression.pveStats.maxHealth,
      attackPower: resolvedProgression.pveStats.attackPower,
      defense: resolvedProgression.pveStats.defense
    });
    combat?.syncPlayerEquipmentCombatState(
      playerId,
      playerEquipmentCombatStateFromSnapshot(equipmentSnapshot)
    );
    if (skillSnapshot) combat?.updatePlayerSkillState(playerId, skillSnapshot);
    return { progression: resolvedProgression, equipment: equipmentSnapshot };
  };
  const stageEquipmentSnapshot = (
    playerId: string,
    requestId: string,
    kind: EquipmentCombatUpdateKind,
    snapshot: EquipmentSnapshotV2,
    options: Readonly<{ maxHealth?: number | null }> = {}
  ): boolean => {
    if (!combat) return false;
    combat.stageEquipmentCombatUpdate(playerId, {
      requestId,
      kind,
      state: playerEquipmentCombatStateFromSnapshot(snapshot),
      ...(typeof options.maxHealth === "number" ? { maxHealth: options.maxHealth } : {})
    });
    return true;
  };

  const resolvePveMaxHealth = async (playerId: string, snapshot: EquipmentSnapshotV2): Promise<number | null> => {
    if (!progression) return null;
    const [baseProgression, classSnapshot, skillSnapshot, kingdomModifiers] = await Promise.all([
      progression.getOrCreate(playerId),
      classes?.getOrCreate(playerId),
      skills?.getOrCreate(playerId),
      kingdoms?.statModifiers(playerId)
    ]);
    return resolveProgression(baseProgression, snapshot, classSnapshot ?? null, skillSnapshot ?? null, kingdomModifiers)
      .pveStats.maxHealth;
  };

  return {
    refreshAuthoritativePlayerStats,
    stageEquipmentSnapshot,
    resolvePveMaxHealth
  };
}

/** Progression with the stats of `equipment` worn, then the skill or class adjustments. */
function resolveProgression(
  baseProgression: ProgressionSnapshot,
  equipment: EquipmentSnapshotV2,
  classSnapshot: ClassSnapshot | null,
  skillSnapshot: SkillSystemV3Snapshot | null,
  kingdomModifiers: KingdomStatModifiers | undefined
): ProgressionSnapshot {
  if (skillSnapshot) return withSkillSystemV3Stats(baseProgression, equipment, skillSnapshot, kingdomModifiers);
  const equipmentAware = withEquipmentStats(baseProgression, equipment, kingdomModifiers);
  return classSnapshot
    ? { ...equipmentAware, pveStats: applyClassCombatStats(equipmentAware.pveStats, classSnapshot, equipment) }
    : equipmentAware;
}

export function withEquipmentStats(
  progression: ProgressionSnapshot,
  equipment: EquipmentSnapshot,
  kingdom?: KingdomStatModifiers
): ProgressionSnapshot {
  if (equipment.derivedStats) {
    return {
      ...progression,
      pveStats: {
        maxHealth: equipment.derivedStats.maximumHealth,
        attackPower: Math.max(
          1,
          equipment.derivedStats.pveAttackPower + (kingdom?.attackBonus ?? 0)
        ),
        defense: Math.max(
          0,
          equipment.derivedStats.pveDefense + (kingdom?.defenseBonus ?? 0)
        ),
        attackIntervalMs: equipment.derivedStats.attackIntervalMs,
        attackRangeM: equipment.derivedStats.attackRangeM
      }
    };
  }
  return {
    ...progression,
    pveStats: playerPveStats(progression.level, {
      attackPower: equipment.totalAttackPowerBonus + (kingdom?.attackBonus ?? 0),
      defense: equipment.totalDefenseBonus + (kingdom?.defenseBonus ?? 0)
    })
  };
}

export function withSkillSystemV3Stats(
  progression: ProgressionSnapshot,
  equipment: EquipmentSnapshotV2,
  snapshot: SkillSystemV3Snapshot,
  kingdom?: KingdomStatModifiers
): ProgressionSnapshot {
  const baseStats = withEquipmentStats(progression, equipment, kingdom);
  const weapon = equipment.active[equipment.readiedWeaponSlot] ?? equipment.weapon;
  const chest = equipment.active.chest ?? equipment.chest;
  const shield = equipment.active.secondary?.category === "shield"
    ? equipment.active.secondary
    : null;
  const weaponFamily = weapon && isEquipmentDefinitionId(weapon.definitionId)
    ? requireEquipmentDefinition(weapon.definitionId).gameplayFamilyId
    : null;
  const bodyFamily = chest && isEquipmentDefinitionId(chest.definitionId)
    ? requireEquipmentDefinition(chest.definitionId).gameplayFamilyId
    : null;
  const weaponProfile = resolveV3WeaponProfileForEquipmentFamily(weaponFamily).profile ?? "unarmed";
  const bodyProfile = resolveV3DefenseProfileForEquipmentFamily(bodyFamily).profile ?? "unarmored";
  const resolved = applySkillSystemV3CombatStats({
    maxHp: baseStats.pveStats.maxHealth,
    attack: baseStats.pveStats.attackPower,
    defense: baseStats.pveStats.defense,
    movementSpeed: 0,
    attackRangeM: baseStats.pveStats.attackRangeM,
    dodgeProbability: 0,
    directHealingMultiplier: 1,
    healingOverTimeMultiplier: 1
  }, snapshot, {
    weaponProfile,
    bodyDefenseProfile: bodyProfile,
    bodyArmorFamilyId: bodyFamily,
    shieldEquipped: shield !== null,
    martialArtsDodgeEligible: shield === null &&
      bodyProfile !== "breastplate" && bodyProfile !== "chainmail"
  });
  return {
    ...baseStats,
    pveStats: {
      ...baseStats.pveStats,
      maxHealth: resolved.maxHp,
      attackPower: resolved.attack,
      defense: resolved.defense,
      attackRangeM: resolved.attackRangeM
    }
  };
}

export function equipmentRuntimeContextFor(
  progression: ProgressionSnapshot | null,
  snapshot: ClassSnapshot | null
): EquipmentRuntimeContext {
  const classId = snapshot?.activeClassId ?? "warrior";
  const listedProgress = snapshot?.classes?.find((entry) => entry.classId === classId);
  const legacyProgress = !snapshot
    ? undefined
    : classId === "warrior"
      ? snapshot.warrior
      : snapshot[classId];
  return {
    context: "pve",
    characterLevel: progression?.level ?? snapshot?.characterLevel ?? 0,
    classId,
    classRank: listedProgress?.level ?? legacyProgress?.level ?? 0
  };
}

export function withLiveClassCombatState(
  snapshot: ClassSnapshot,
  classCombat: ClassCombatState
): ClassSnapshot {
  const resource = classCombat.resource;
  if (classCombat.activeClassId !== snapshot.activeClassId) return snapshot;
  const updatedAt = new Date().toISOString();
  const projectedResource = resource ? {
    classId: snapshot.activeClassId,
    resourceId: resource.resourceId,
    displayName: resource.displayName,
    current: resource.current,
    maximum: resource.maximum,
    reserved: resource.reserved,
    updatedAt
  } : undefined;
  const resources = snapshot.resources?.flatMap((entry) =>
    entry.classId === snapshot.activeClassId ? projectedResource ? [projectedResource] : [] : [entry]
  );
  const liveSnapshot = { ...snapshot };
  delete liveSnapshot.resource;
  return {
    ...liveSnapshot,
    ...(projectedResource ? { resource: projectedResource } : {}),
    ...(resources === undefined ? {} : { resources }),
    rage: classCombat.rage,
    maximumRage: classCombat.maximumRage,
    queuedAbility: classCombat.queuedAbility
      ? {
          ...classCombat.queuedAbility,
          reservedRage: classCombat.reservedRage,
          reservedResource: resource?.reserved ?? 0
        }
      : null,
    cooldownEndsAt: { ...classCombat.cooldownEndsAt },
    serverTime: Date.now()
  };
}


