import { z } from "zod";

import { SHOP_TAG_PATTERN } from "../shopProvenance.js";
import { COMBAT_STYLE_IDS } from "../attackProfiles.js";

import { CLASS_IDS, SUBCLASS_IDS, WEAPON_CATEGORIES } from "../classes.js";
import { RESOURCE_TYPES } from "../collectibles.js";
import { DOG_COMPANION_MODES, HARMFUL_STATUS_IDS, MOB_APPEARANCE_VARIANTS, MOB_ARCHETYPE_KEYS, MOB_BUFF_KINDS } from "../combat.js";
import { BOSS_HOST_KINDS, BOSS_LIFECYCLE_STATES } from "../boss.js";
import {
  COMBAT_KIT_INVALID_REASONS,
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_LOCATIONS,
  equipmentDefinitionIdSchema,
  EQUIPMENT_SLOTS,
  EQUIPMENT_UPGRADE_DISABLED_REASONS,
  MAX_EQUIPMENT_LEVEL,
  READIED_WEAPON_SLOTS
} from "../equipment.js";
import { CURRENT_LEVEL_CAP } from "../progression.js";
import { RING_QUARRY_FAMILIES, RING_TIERS, ringBonusDefinition } from "../rings.js";
import { GEAR_SCROLL_SLOTS } from "../gearScrolls.js";
import { COMPANION_SPECIES_IDS } from "../petSystem.js";
import {
  COMBAT_CONTEXTS,
  EQUIPMENT_STAT_SCOPES,
  EQUIPMENT_UTILITY_KINDS,
  MOB_CHALLENGE_TIERS
} from "../equipmentBalance.js";
import {
  inventoryServerSchema,
  requestIdSchema,
  worldViewAuthorityServerSchema
} from "./serverSchemaPrimitives.js";

const marketIntegerSchema = z.string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine(
    (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
    "Integer exceeds signed bigint range"
  );

const bossOwnershipSchema = z.object({
  bossId: z.string().min(1).max(160),
  bossRevision: z.number().int().positive(),
  encounterHandlerId: z.string().min(1).max(160),
  hostKind: z.enum(BOSS_HOST_KINDS),
  hostInstanceId: z.string().min(1).max(320),
  encounterInstanceId: z.string().min(1).max(320),
  appearanceId: z.string().min(1).max(160).optional(),
  appearanceVariant: z.enum(MOB_APPEARANCE_VARIANTS).optional(),
  lifeGeneration: z.number().int().nonnegative()
}).strict();

const bossTelegraphSchema = z.object({
  encounterId: z.string().min(1).max(320),
  bossId: z.string().min(1).max(160),
  abilityId: z.string().min(1).max(160),
  castInstanceId: z.string().min(1).max(200),
  startTime: z.number().finite(),
  resolveTime: z.number().finite(),
  durationMs: z.number().finite().nonnegative().optional(),
  remainingMs: z.number().finite().nonnegative().optional(),
  origin: z.object({
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180)
  }).strict(),
  facingDegrees: z.number().finite().optional(),
  targetEntityId: z.string().min(1).max(160).optional(),
  geometry: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("circle"),
      center: z.object({
        lat: z.number().finite().min(-90).max(90),
        lon: z.number().finite().min(-180).max(180)
      }).strict(),
      radiusM: z.number().finite().positive()
    }).strict(),
    z.object({
      kind: z.literal("cone"),
      origin: z.object({
        lat: z.number().finite().min(-90).max(90),
        lon: z.number().finite().min(-180).max(180)
      }).strict(),
      facingDegrees: z.number().finite(),
      rangeM: z.number().finite().positive(),
      angleDegrees: z.number().finite().positive().max(360)
    }).strict(),
    z.object({
      kind: z.literal("line"),
      origin: z.object({
        lat: z.number().finite().min(-90).max(90),
        lon: z.number().finite().min(-180).max(180)
      }).strict(),
      facingDegrees: z.number().finite(),
      lengthM: z.number().finite().positive(),
      widthM: z.number().finite().positive()
    }).strict()
  ]),
  lifeGeneration: z.number().int().nonnegative()
}).strict();

const bossEncounterProjectionSchema = z.object({
  encounterId: z.string().min(1).max(320),
  bossId: z.string().min(1).max(160),
  bossRevision: z.number().int().positive(),
  encounterHandlerId: z.string().min(1).max(160),
  hostKind: z.enum(BOSS_HOST_KINDS),
  hostInstanceId: z.string().min(1).max(320),
  encounterInstanceId: z.string().min(1).max(320),
  mobEntityId: z.string().min(1).max(320),
  lifecycleState: z.enum(BOSS_LIFECYCLE_STATES),
  phaseId: z.string().min(1).max(160).nullable(),
  phaseDeadlineAt: z.number().finite().nonnegative().optional(),
  lifeGeneration: z.number().int().nonnegative(),
  participation: z.object({
    policyId: z.string().min(1).max(160),
    canJoin: z.boolean(),
    participantIds: z.array(z.string().min(1).max(160))
  }).strict(),
  activeCasts: z.array(bossTelegraphSchema)
}).strict();

export const combatEntitySnapshotSchema = z.object({
  entityId: z.string().min(1).max(160),
  kind: z.enum(["player", "mob"]),
  archetypeKey: z.enum(MOB_ARCHETYPE_KEYS).nullable(),
  appearanceVariant: z.enum(MOB_APPEARANCE_VARIANTS).optional(),
  name: z.string().min(1).max(80),
  // Character level, not gear level: players reach CURRENT_LEVEL_CAP and mobs/bosses can sit above it.
  level: z.number().int().min(0).max(100),
  challengeTier: z.enum(MOB_CHALLENGE_TIERS).nullable().optional(),
  combatBalanceVersion: z.number().int().positive().nullable().optional(),
  regionCode: z.string().min(1),
  zoneId: z.string().min(1),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  maxHealth: z.number().int().positive(),
  currentHealth: z.number().int().nonnegative(),
  ward: z.number().int().nonnegative().optional(),
  invisibleUntil: z.number().int().nonnegative().nullable().optional(),
  downedUntil: z.number().int().nonnegative().nullable().optional(),
  respawnAvailableAt: z.number().int().nonnegative().nullable().optional(),
  lifeState: z.enum(["alive", "downed", "defeated", "respawning"]),
  activityState: z.enum(["idle", "chasing", "attacking", "fleeing", "returning"]),
  targetEntityId: z.string().min(1).max(160).nullable(),
  packId: z.string().min(1).max(160).nullable().optional(),
  npcFaction: z.object({
    cityId: z.string().uuid(),
    cityName: z.string().min(1).max(80),
    culture: z.literal("goblin"),
    role: z.enum(["basic", "warrior", "archer", "healer"]),
    presentationKey: z.string().min(1).max(80),
    relation: z.enum(["neutral", "enemy"]),
    protected: z.literal(true)
  }).strict().nullable().optional(),
  companion: z.object({
    ownerPlayerId: z.string().min(1).max(160),
    dogId: z.string().min(1).max(160),
    species: z.enum(COMPANION_SPECIES_IDS),
    mode: z.enum(DOG_COMPANION_MODES)
  }).strict().nullable().optional(),
  undead: z.object({
    ownerPlayerId: z.string().min(1).max(160),
    kind: z.enum(["skeleton", "lich"]),
    level: z.number().int().min(1).max(6),
    expiresAt: z.number().finite().nonnegative()
  }).strict().nullable().optional(),
  maxHealthPenalty: z.number().int().positive().optional(),
  combatStyle: z.enum(COMBAT_STYLE_IDS).optional(),
  boss: z.boolean().optional(),
  bossEventState: z.enum(["dormant", "active"]).optional(),
  bossLifecycleState: z.enum(BOSS_LIFECYCLE_STATES).optional(),
  bossOwnership: bossOwnershipSchema.optional(),
  bossEncounter: bossEncounterProjectionSchema.optional(),
  telegraphs: z.array(bossTelegraphSchema).max(32).optional(),
  mobBuffs: z.array(z.object({
    kind: z.enum(MOB_BUFF_KINDS),
    endsAt: z.number().finite().nonnegative()
  }).strict()).max(8).optional(),
  attackRangeM: z.number().finite().nonnegative().optional(),
  controlEffects: z.array(z.object({
    kind: z.literal("rooted"),
    endsAt: z.number().finite().nonnegative()
  }).strict()).optional(),
  harmfulStatusIds: z.array(z.enum(HARMFUL_STATUS_IDS)).optional(),
  revision: z.number().int().nonnegative(),
  aggressiveUntil: z.number().finite().nonnegative().nullable().optional(),
  flagArrivalProtectionUntil: z.number().finite().nonnegative().nullable().optional(),
  aiPresentation: z.object({
    phase: z.enum(["acquiring", "disengaging", "observing"]),
    intent: z.enum(["combat", "observe"]),
    deadlineAt: z.number().finite().nonnegative().nullable(),
    durationMs: z.number().finite().nonnegative().optional(),
    targetEntityId: z.string().min(1).max(160).nullable().optional()
  }).strict().nullable().optional(),
  hostility: z.enum(["passive", "aggressive", "observer"]).optional(),
  ambientSpeech: z.object({
    text: z.string().min(1).max(160),
    expiresAt: z.number().finite().nonnegative()
  }).strict().optional(),
  pveCombat: z.object({
    sessionId: z.string().min(1).max(200),
    focusTargetEntityId: z.string().min(1).max(160).nullable(),
    enemyQueue: z.array(z.string().min(1).max(160)),
    pursuingEnemyIds: z.array(z.string().min(1).max(160)),
    queueCursor: z.number().int().nonnegative(),
    phase: z.enum(["waiting_player", "enemy_pending"]),
    nextBasicAttackAt: z.number().finite().nullable(),
    resetWindowEndsAt: z.number().finite().nullable(),
    pendingNormalAbilityId: z.string().min(1).max(160).nullable(),
    pendingResetAbilityId: z.string().min(1).max(160).nullable(),
    tauntCooldownEndsAt: z.number().finite(),
    activeViewCenter: z.object({
      lat: z.number().finite().min(-90).max(90),
      lon: z.number().finite().min(-180).max(180)
    }).strict(),
    activeViewRadiusM: z.number().finite().positive(),
    activeViewGeneration: z.number().int().nonnegative(),
    lastTauntExcludedByCap: z.number().int().nonnegative()
  }).strict().nullable().optional(),
  classCombat: z.object({
    activeClassId: z.enum(CLASS_IDS).optional(),
    activeSubclassId: z.enum(SUBCLASS_IDS).nullable().optional(),
    resource: z.object({
      resourceId: z.enum(["rage", "focus"]),
      displayName: z.enum(["Rage", "Focus"]),
      current: z.number().int().min(0).max(105),
      maximum: z.number().int().min(100).max(105),
      reserved: z.number().int().min(0).max(105)
    }).strict().optional(),
    weaponMode: z.enum(["ranged", "melee"]).nullable().optional(),
    innate: z.discriminatedUnion("id", [
      z.object({ id: z.literal("warrior_unrelenting_rage"), maxHealthBonus: z.number().int().nonnegative(), damageBonus: z.number().int().min(0).max(3) }).strict(),

      z.object({ id: z.literal("ninja_way_of_the_ninja"), armorActive: z.boolean(), dodgeChance: z.number().finite().min(0).max(1), cooldownEndsAt: z.number().int().nonnegative().nullable(), invisibleEndsAt: z.number().int().nonnegative().nullable() }).strict()
    ]).optional(),
    rage: z.number().int().min(0).max(105),
    maximumRage: z.union([
      z.literal(0),
      z.number().int().min(100).max(105)
    ]),
    reservedRage: z.number().int().min(0).max(105),
    guard: z.number().int().min(0).max(100),
    bloodlust: z.number().int().min(0).max(100),
    classCounters: z.record(z.string(), z.number().finite()).optional(),
    statusIndicators: z.array(z.object({
      id: z.string().min(1).max(160),
      label: z.string().min(1).max(160),
      stacks: z.number().int().positive().optional(),
      endsAt: z.number().finite().nonnegative().optional()
    }).strict()).optional(),
    queuedAbility: z.object({
      abilityId: z.string().min(1).max(160),
      targetEntityId: z.string().min(1).max(160).nullable(),
      queuedAtTick: z.number().int().nonnegative()
    }).strict().nullable(),
    cooldownEndsAt: z.record(z.string(), z.number().finite()),
    cooldownGroupEndsAt: z.record(z.string(), z.number().finite()).optional()
  }).strict().nullable().optional(),
  weaponCombat: z.object({
    activeWeaponSlot: z.enum(READIED_WEAPON_SLOTS),
    activeWeaponInstanceId: z.string().uuid().nullable(),
    activeWeaponCategory: z.enum(WEAPON_CATEGORIES).nullable(),
    switchPolicy: z.enum([
      "melee_priority",
      "ranged_priority",
      "ranged_only"
    ]),
    switchingToSlot: z.enum(READIED_WEAPON_SLOTS).nullable(),
    switchStartedAtTick: z.number().int().nonnegative().nullable(),
    switchCompletesAtTick: z.number().int().nonnegative().nullable()
  }).strict().nullable().optional()
}).strict();

export const combatEventSchema = z.object({
  eventId: z.string().min(1).max(160),
  type: z.enum([
    "ATTACK_LANDED",
    "DAMAGE",
    "HEAL",
    "HEAL_BLOCKED",
    "DEFEATED",
    "RESPAWNED",
    "TAUNT_ACTIVATED",
    "MOB_SPAWNED",
    "MOB_REMOVED",
    "WEAPON_SWITCH_STARTED",
    "WEAPON_SWITCH_COMPLETED",
    "WEAPON_SWITCH_CANCELLED",
    "PROFESSION_OPENING_STRIKE",
    "PROFESSION_EXECUTED",
    "CLASS_ABILITY_ACTIVATED",
    "CLASS_ABILITY_ZONE_STARTED",
    "CLASS_ABILITY_ZONE_ENDED",
    "CLASS_INNATE_TRIGGERED",
    "PET_ABILITY_EFFECT",
    "SWING"
  ]),
  tick: z.number().int().nonnegative(),
  sourceEntityId: z.string().min(1).max(160).nullable(),
  targetEntityId: z.string().min(1).max(160).nullable(),
  amount: z.number().int().nonnegative().optional(),
  professionBonusAmount: z.number().int().nonnegative().optional(),
  presentationDelayMs: z.number().int().min(0).max(1_000).optional(),
  packetIndex: z.number().int().positive().optional(),
  packetCount: z.number().int().positive().optional(),
  currentHealth: z.number().int().nonnegative().optional(),
  position: z.object({
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180)
  }).strict().optional(),
  radiusM: z.number().finite().positive().optional(),
  abilityId: z.string().min(1).max(160).optional(),
  facingDegrees: z.number().finite().min(0).max(360).optional(),
  durationMs: z.number().int().positive().optional(),
  weaponSlot: z.enum(READIED_WEAPON_SLOTS).optional(),
  previousWeaponSlot: z.enum(READIED_WEAPON_SLOTS).optional(),
  harmfulStatusId: z.enum(HARMFUL_STATUS_IDS).optional(),
  innateFeedback: z.enum(["FOCUS", "DODGE", "INVISIBLE", "IMMUNE"]).optional(),
  innateId: z.string().min(1).max(160).optional()
}).strict().superRefine((event, context) => {
  if (event.type === "CLASS_INNATE_TRIGGERED") {
    if (!event.innateId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["innateId"], message: "Class innate feedback requires an innate ID" });
    if (!event.innateFeedback) context.addIssue({ code: z.ZodIssueCode.custom, path: ["innateFeedback"], message: "Class innate feedback requires a feedback kind" });
    return;
  }
  if (event.type === "PET_ABILITY_EFFECT") {
    if (!event.sourceEntityId || !event.abilityId || !event.position) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["abilityId"], message: "Pet ability effects need a source, ability and position" });
    }
    return;
  }
  if (event.type !== "CLASS_ABILITY_ACTIVATED") return;
  if (!event.sourceEntityId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceEntityId"],
      message: "Class ability activation requires a source entity"
    });
  }
  if (!event.abilityId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["abilityId"],
      message: "Class ability activation requires an ability ID"
    });
  }
  if (!event.position) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["position"],
      message: "Class ability activation requires a position"
    });
  }
});

export const combatStateBatchSchema = z.object({
  serverTick: z.number().int().nonnegative(),
  serverTime: z.number().finite(),
  sequence: z.number().int().nonnegative(),
  upserts: z.array(combatEntitySnapshotSchema),
  removedEntityIds: z.array(z.string().min(1).max(160)),
  events: z.array(combatEventSchema)
}).strict();

export const combatServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("COMBAT_SNAPSHOT"),
    state: combatStateBatchSchema,
    worldViewAuthority: worldViewAuthorityServerSchema.optional(),
    combatSnapshotGeneration: z.number().int().nonnegative().optional()
  }).strict(),
  z.object({ type: z.literal("COMBAT_DELTA"), state: combatStateBatchSchema }).strict(),
  z.object({
    type: z.literal("COMBAT_STARTED"),
    requestId: requestIdSchema,
    attackerEntityId: z.string().min(1).max(160),
    targetEntityId: z.string().min(1).max(160)
  }).strict(),
  z.object({
    type: z.literal("COMBAT_CANCELLED"),
    requestId: requestIdSchema,
    entityId: z.string().min(1).max(160)
  }).strict(),
  z.object({
    type: z.literal("DEV_MOB_SPAWNED"),
    requestId: requestIdSchema,
    mobEntityId: z.string().min(1).max(320),
    archetype: z.enum(MOB_ARCHETYPE_KEYS),
    appearanceVariant: z.enum(MOB_APPEARANCE_VARIANTS)
  }).strict(),
  z.object({
    type: z.literal("DEV_MOBS_CLEARED"),
    requestId: requestIdSchema,
    removedCount: z.number().int().nonnegative()
  }).strict()
]);

export const pveCombatStatsSchema = z.object({
  maxHealth: z.number().int().positive(),
  attackPower: z.number().int().nonnegative(),
  defense: z.number().int().nonnegative(),
  attackIntervalMs: z.number().int().positive(),
  attackRangeM: z.number().positive()
}).strict();

export const progressionSnapshotSchema = z.object({
  playerId: z.string().min(1),
  totalXp: z.number().int().min(0),
  level: z.number().int().min(0).max(CURRENT_LEVEL_CAP),
  curveVersion: z.number().int().positive(),
  persistenceVersion: z.number().int().nonnegative(),
  xpIntoLevel: z.number().int().nonnegative(),
  xpForNextLevel: z.number().int().positive().nullable(),
  nextLevelTotalXp: z.number().int().positive().nullable(),
  atCap: z.boolean(),
  pveStats: pveCombatStatsSchema
}).strict();

export const equipmentItemDerivedStatsSchema = z.object({
  instanceId: z.string().uuid(),
  definitionId: equipmentDefinitionIdSchema,
  slot: z.enum(EQUIPMENT_SLOTS),
  category: z.enum(EQUIPMENT_CATEGORIES),
  weaponCategory: z.enum(WEAPON_CATEGORIES).nullable(),
  armorCategory: z.enum(["light", "medium", "heavy"]).nullable(),
  twoHanded: z.boolean(),
  itemLevel: z.number().int().min(0).max(MAX_EQUIPMENT_LEVEL),
  maximumItemLevel: z.literal(MAX_EQUIPMENT_LEVEL),
  condition: z.number().int().min(0).max(100),
  maximumCondition: z.literal(100),
  requiredCharacterLevel: z.number().int().min(0).max(CURRENT_LEVEL_CAP),
  statScope: z.enum(EQUIPMENT_STAT_SCOPES),
  utilityKind: z.enum(EQUIPMENT_UTILITY_KINDS),
  affinityBonus: z.number().int().nonnegative(),
  effectiveItemLevel: z.number().nonnegative().finite(),
  pveLevelScaling: z.number().positive().finite(),
  pveAttackContribution: z.number().nonnegative().finite(),
  pveDefenseContribution: z.number().nonnegative().finite(),
  pvpLevelContribution: z.number().nonnegative().finite(),
  universalAttackContribution: z.number().nonnegative().finite(),
  universalDefenseContribution: z.number().nonnegative().finite(),
  bypassPveDefense: z.boolean().optional(),
  resourceMaximumBonus: z.number().int().nonnegative(),
  resourceGenerationMultiplier: z.number().positive().finite(),
  actionDurationMultiplier: z.number().positive().finite(),
  choppingDurationMultiplier: z.number().positive().finite(),
  miningDurationMultiplier: z.number().positive().finite(),
  movementSpeedMultiplier: z.number().positive().finite(),
  crowdControlDurationMultiplier: z.number().positive().finite(),
  balanceVersion: z.number().int().positive()
}).strict();

export const equipmentInstanceSchema = z.object({
  instanceId: z.string().uuid(),
  definitionId: equipmentDefinitionIdSchema,
  displayName: z.string().min(1).max(80),
  ownerPlayerId: z.string().min(1),
  location: z.enum(EQUIPMENT_LOCATIONS),
  inventorySlotIndex: z.number().int().nonnegative().optional(),
  manorId: z.string().uuid().optional(),
  manorSlotIndex: z.number().int().nonnegative().safe().optional(),
  droppable: z.boolean().optional(),
  manorStorable: z.boolean().optional(),
  equippedSlot: z.enum(EQUIPMENT_SLOTS).nullable(),
  itemLevel: z.number().int().min(0).max(MAX_EQUIPMENT_LEVEL),
  maximumItemLevel: z.literal(MAX_EQUIPMENT_LEVEL),
  condition: z.number().int().min(0).max(100),
  maximumCondition: z.literal(100),
  category: z.enum(EQUIPMENT_CATEGORIES),
  balanceVersion: z.number().int().positive(),
  enchantmentIdentity: z.string().min(1).max(160).nullable(),
  usesRemaining: z.number().int().min(0).nullable().optional(),
  inscription: z.object({
    name: z.string().min(1).max(40),
    inscriberName: z.string().min(1).max(80),
    inscribedAt: z.string(),
    kind: z.enum(["weapon", "armor"]),
    stats: z.record(z.string(), z.number())
  }).strict().nullable().optional(),
  provenance: z.object({ tag: z.string().regex(SHOP_TAG_PATTERN), originalBuyerName: z.string().min(1).max(80) }).strict().nullable().optional(),
  ring: z.object({
    tier: z.enum(RING_TIERS),
    rough: z.boolean(),
    bonuses: z.array(z.object({
      id: z.string().min(1).max(64).refine((id) => ringBonusDefinition(id) !== null, "unknown ring bonus"),
      family: z.enum(RING_QUARRY_FAMILIES as [string, ...string[]]).optional()
    }).strict()).max(3)
  }).strict().nullable().optional(),
  requiredAchievementId: z.literal("bitter_blood").nullable().optional(),
  achievementRequirementMet: z.boolean().optional(),
  attackPowerBonus: z.number().int().nonnegative(),
  defenseBonus: z.number().int().nonnegative(),
  weaponCategory: z.enum(WEAPON_CATEGORIES).nullable(),
  armorCategory: z.enum(["light", "medium", "heavy"]).nullable(),
  twoHanded: z.boolean(),
  savedKitIndices: z.array(
    z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6)
    ])
  ).max(6).refine(
    (indices) => new Set(indices).size === indices.length,
    "Saved combat-kit indices must be unique"
  ),
  derived: equipmentItemDerivedStatsSchema,
  nextUpgradeCost: marketIntegerSchema.refine(
    (value) => value !== "0",
    "Equipment upgrade cost must be positive"
  ).nullable(),
  nextUpgradeLevel: z.number().int().min(1).max(MAX_EQUIPMENT_LEVEL).nullable(),
  upgradeDisabledReason: z.enum(EQUIPMENT_UPGRADE_DISABLED_REASONS).nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
}).strict().superRefine((instance, context) => {
  if (
    instance.derived.instanceId !== instance.instanceId ||
    instance.derived.definitionId !== instance.definitionId ||
    instance.derived.itemLevel !== instance.itemLevel ||
    instance.derived.maximumItemLevel !== instance.maximumItemLevel ||
    instance.derived.category !== instance.category ||
    instance.derived.weaponCategory !== instance.weaponCategory ||
    instance.derived.armorCategory !== instance.armorCategory ||
    instance.derived.twoHanded !== instance.twoHanded ||
    instance.derived.balanceVersion !== instance.balanceVersion ||
    instance.derived.condition !== instance.condition ||
    instance.derived.maximumCondition !== instance.maximumCondition
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["derived"],
      message: "Derived equipment identity must match its authoritative instance"
    });
  }
  if ((instance.nextUpgradeLevel === null) !== (instance.nextUpgradeCost === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nextUpgradeLevel"],
      message: "Next upgrade level and cost must either both be present or both be null"
    });
  }
  if (
    instance.nextUpgradeLevel !== null &&
    instance.nextUpgradeLevel !== instance.itemLevel + 1
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nextUpgradeLevel"],
      message: "Next upgrade level must advance exactly one level"
    });
  }
});

const nullableEquipmentInstanceSchema = equipmentInstanceSchema.nullable();
const equipmentInstanceSlotRecordSchema = z.object({
  head: nullableEquipmentInstanceSchema,
  chest: nullableEquipmentInstanceSchema,
  gloves: nullableEquipmentInstanceSchema,
  boots: nullableEquipmentInstanceSchema,
  ring: nullableEquipmentInstanceSchema,
  ring_2: nullableEquipmentInstanceSchema,
  melee: nullableEquipmentInstanceSchema,
  secondary: nullableEquipmentInstanceSchema,
  // Gathering tool slots; absent on frames from servers that predate them.
  tool_axe: nullableEquipmentInstanceSchema.default(null),
  tool_pickaxe: nullableEquipmentInstanceSchema.default(null),
  tool_fishing_pole: nullableEquipmentInstanceSchema.default(null)
}).strict();
const nullableEquipmentDerivedItemSchema = equipmentItemDerivedStatsSchema.nullable();
const equipmentDerivedItemSlotRecordSchema = z.object({
  head: nullableEquipmentDerivedItemSchema,
  chest: nullableEquipmentDerivedItemSchema,
  gloves: nullableEquipmentDerivedItemSchema,
  boots: nullableEquipmentDerivedItemSchema,
  ring: nullableEquipmentDerivedItemSchema,
  ring_2: nullableEquipmentDerivedItemSchema,
  melee: nullableEquipmentDerivedItemSchema,
  secondary: nullableEquipmentDerivedItemSchema,
  tool_axe: nullableEquipmentDerivedItemSchema.default(null),
  tool_pickaxe: nullableEquipmentDerivedItemSchema.default(null),
  tool_fishing_pole: nullableEquipmentDerivedItemSchema.default(null)
}).strict();
export const equipmentCombatStatsSchema = z.object({
  balanceVersion: z.number().int().positive(),
  context: z.enum(COMBAT_CONTEXTS),
  maximumHealth: z.number().int().positive(),
  characterLevel: z.number().int().min(0).max(CURRENT_LEVEL_CAP),
  classId: z.enum(CLASS_IDS),
  classRank: z.number().int().min(0).max(CURRENT_LEVEL_CAP),
  normalizedClassPower: z.number().nonnegative().finite(),
  readiedWeaponSlot: z.enum(READIED_WEAPON_SLOTS),
  readiedWeaponCategory: z.enum(WEAPON_CATEGORIES).nullable(),
  weaponItemLevel: z.number().int().min(0).max(MAX_EQUIPMENT_LEVEL),
  effectiveWeaponLevel: z.number().nonnegative().finite(),
  weightedArmorLevel: z.number().nonnegative().finite(),
  shieldLevel: z.number().nonnegative().finite().nullable(),
  shieldGuardBonus: z.number().nonnegative().finite(),
  pvpOffense: z.number().nonnegative().finite(),
  pvpGuard: z.number().nonnegative().finite(),
  pveAttackPower: z.number().int().nonnegative(),
  pveDefense: z.number().int().nonnegative(),
  pveWeaponProficiencyMultiplier: z.number().positive().finite(),
  universalAttackPower: z.number().int().nonnegative(),
  universalDefense: z.number().int().nonnegative(),
  bypassPveDefense: z.boolean().optional(),
  weaponAttackPower: z.object({
    melee: z.number().int().nonnegative(),
    secondary: z.number().int().nonnegative()
  }).strict(),
  weaponCategories: z.object({
    melee: z.enum(WEAPON_CATEGORIES).nullable(),
    secondary: z.enum(WEAPON_CATEGORIES).nullable()
  }).strict(),
  resourceMaximumBonus: z.number().int().nonnegative(),
  resourceGenerationMultiplier: z.number().positive().finite(),
  actionDurationMultiplier: z.number().positive().finite(),
  choppingDurationMultiplier: z.number().positive().finite(),
  miningDurationMultiplier: z.number().positive().finite(),
  movementSpeedMultiplier: z.number().positive().finite(),
  crowdControlDurationMultiplier: z.number().positive().finite(),
  challengeProfile: z.object({
    balanceVersion: z.number().int().positive(),
    currentGearLevel: z.number().int().min(0).max(MAX_EQUIPMENT_LEVEL),
    unlockedGearLevel: z.number().int().min(0).max(MAX_EQUIPMENT_LEVEL),
    tier: z.enum(MOB_CHALLENGE_TIERS),
    contributors: z.object({
      melee: z.number().int().min(0).max(MAX_EQUIPMENT_LEVEL),
      chest: z.number().int().min(0).max(MAX_EQUIPMENT_LEVEL),
      secondary: z.number().int().min(0).max(MAX_EQUIPMENT_LEVEL)
    }).strict()
  }).strict(),
  ringBonuses: z.record(z.string().min(1).max(96), z.number().finite()).optional(),
  attackIntervalMs: z.number().int().positive(),
  attackRangeM: z.number().positive().finite(),
  items: equipmentDerivedItemSlotRecordSchema
}).strict();

export const combatKitSnapshotSchema = z.object({
  kitIndex: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6)
  ]),
  name: z.string().min(1).max(32),
  readiedWeaponSlot: z.enum(READIED_WEAPON_SLOTS),
  items: equipmentInstanceSlotRecordSchema,
  valid: z.boolean(),
  invalidReason: z.enum(COMBAT_KIT_INVALID_REASONS).nullable(),
  revision: z.number().int().nonnegative()
}).strict().refine(
  ({ valid, invalidReason }) => valid === (invalidReason === null),
  { message: "Combat-kit validity must match its invalid reason" }
);

export const equipmentSnapshotSchema = z.object({
  snapshotVersion: z.literal(2),
  balanceVersion: z.number().int().positive(),
  playerId: z.string().min(1),
  instances: z.array(equipmentInstanceSchema),
  active: equipmentInstanceSlotRecordSchema,
  readiedWeaponSlot: z.enum(READIED_WEAPON_SLOTS),
  activeKitIndex: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6)
  ]).nullable(),
  kits: z.array(combatKitSnapshotSchema).length(6),
  inventoryRevision: z.number().int().nonnegative(),
  activeRevision: z.number().int().nonnegative(),
  checkpointRevision: z.number().int().nonnegative(),
  derivedStats: equipmentCombatStatsSchema,
  characterLevel: z.number().int().min(0).max(CURRENT_LEVEL_CAP),
  repairMessage: z.string().min(1).max(240).nullable(),
  weapon: equipmentInstanceSchema.nullable(),
  chest: equipmentInstanceSchema.nullable(),
  totalAttackPowerBonus: z.number().int().nonnegative(),
  totalDefenseBonus: z.number().int().nonnegative()
}).strict().refine(
  ({ kits }) => new Set(kits.map(({ kitIndex }) => kitIndex)).size === 6,
  { message: "Equipment snapshot must contain each of the six combat-kit slots" }
);

export const equipmentUpgradeResultMessageSchema = z.object({
  type: z.literal("EQUIPMENT_UPGRADE_RESULT"),
  requestId: requestIdSchema,
  replayed: z.boolean(),
  instanceId: z.string().uuid(),
  levelBefore: z.number().int().min(0).max(MAX_EQUIPMENT_LEVEL - 1),
  levelAfter: z.number().int().min(1).max(MAX_EQUIPMENT_LEVEL),
  goldCost: marketIntegerSchema.refine(
    (value) => value !== "0",
    "Equipment upgrade cost must be positive"
  ),
  balanceVersion: z.number().int().positive(),
  goldBalance: marketIntegerSchema,
  equipment: equipmentSnapshotSchema
}).strict().refine(
  ({ levelBefore, levelAfter }) => levelAfter === levelBefore + 1,
  { message: "Equipment upgrades must advance exactly one level" }
);

export const equipmentAcquiredMessageSchema = z.object({
  type: z.literal("EQUIPMENT_ACQUIRED"),
  requestId: requestIdSchema,
  action: z.enum(["craft", "limited_purchase"]),
  replayed: z.boolean(),
  definitionId: equipmentDefinitionIdSchema,
  instanceId: z.string().uuid(),
  materialCosts: z.array(z.object({
    itemId: z.enum(RESOURCE_TYPES),
    quantity: z.number().int().positive()
  }).strict()).max(8),
  goldCost: marketIntegerSchema,
  walletGold: marketIntegerSchema.optional(),
  walletVersion: marketIntegerSchema.optional(),
  inventory: inventoryServerSchema,
  equipment: equipmentSnapshotSchema,
  message: z.string().min(1).max(240)
}).strict().superRefine((message, context) => {
  if ((message.walletGold === undefined) !== (message.walletVersion === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["walletGold"],
      message: "equipment acquisition wallet fields must be provided together"
    });
  }
  if (message.action === "craft" && message.goldCost !== "0") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["goldCost"],
      message: "crafted stock equipment cannot charge Gold"
    });
  }
  if (message.action === "limited_purchase" && message.goldCost === "0") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["goldCost"],
      message: "limited equipment purchases require a positive Gold cost"
    });
  }
});

export const equipmentRepairedMessageSchema = z.object({
  type: z.literal("EQUIPMENT_REPAIRED"),
  requestId: requestIdSchema,
  replayed: z.boolean(),
  instanceId: z.string().uuid(),
  conditionBefore: z.number().int().min(0).max(100),
  conditionAfter: z.number().int().min(1).max(100),
  materialCosts: z.array(z.object({
    itemId: z.enum(RESOURCE_TYPES),
    quantity: z.number().int().positive()
  }).strict()).max(8),
  inventory: inventoryServerSchema,
  equipment: equipmentSnapshotSchema,
  message: z.string().min(1).max(240)
}).strict().refine(
  ({ conditionAfter }) => conditionAfter > 0,
  { message: "A repair must leave equipment usable" }
);

const gearScrollsSnapshotSchema = z.object({
  count: z.number().int().nonnegative(),
  scrolls: z.array(z.object({
    position: z.number().int().positive(),
    items: z.array(z.object({
      slot: z.enum(GEAR_SCROLL_SLOTS),
      instanceId: z.string().uuid(),
      definitionId: z.string().max(160).nullable(),
      displayName: z.string().max(160).nullable(),
      carried: z.boolean()
    }).strict()).max(GEAR_SCROLL_SLOTS.length)
  }).strict()).max(1000),
  lastEquippedPosition: z.number().int().positive().nullable()
}).strict();

export const gearScrollsStateMessageSchema = z.object({
  type: z.literal("GEAR_SCROLLS_STATE"),
  requestId: requestIdSchema.nullable(),
  action: z.enum(["snapshot", "craft", "remember", "equip"]),
  replayed: z.boolean().optional(),
  superseded: z.boolean().optional(),
  position: z.number().int().positive().optional(),
  equipped: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().optional(),
  gearScrolls: gearScrollsSnapshotSchema.optional(),
  inventory: inventoryServerSchema.optional(),
  equipment: equipmentSnapshotSchema.optional()
}).strict();

export const ringOperationResultMessageSchema = z.object({
  type: z.literal("RING_OPERATION_RESULT"),
  requestId: requestIdSchema,
  replayed: z.boolean(),
  action: z.enum(["polish", "dump"]),
  instanceId: z.string().uuid(),
  tier: z.enum(RING_TIERS),
  oilSpent: z.number().int().nonnegative(),
  shardsGranted: z.number().int().nonnegative(),
  inventory: inventoryServerSchema,
  equipment: equipmentSnapshotSchema,
  message: z.string().min(1).max(240)
}).strict();

export const repairKitCraftedMessageSchema = z.object({
  type: z.literal("REPAIR_KIT_CRAFTED"),
  requestId: requestIdSchema,
  replayed: z.boolean(),
  quantity: z.literal(1),
  materialCosts: z.array(z.object({
    itemId: z.enum(RESOURCE_TYPES),
    quantity: z.number().int().positive()
  }).strict()).max(8),
  inventory: inventoryServerSchema,
  equipment: equipmentSnapshotSchema,
  message: z.string().min(1).max(240)
}).strict();

export const combatKitSnapshotMessageSchema = z.object({
  type: z.literal("COMBAT_KIT_SNAPSHOT"),
  requestId: requestIdSchema.optional(),
  equipment: equipmentSnapshotSchema
}).strict();

export const combatKitActivatedMessageSchema = z.object({
  type: z.literal("COMBAT_KIT_ACTIVATED"),
  requestId: requestIdSchema,
  kitIndex: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6)
  ]),
  inventoryRevision: z.number().int().nonnegative(),
  activeRevision: z.number().int().nonnegative(),
  activationTick: z.number().int().nonnegative(),
  replayed: z.boolean(),
  equipment: equipmentSnapshotSchema
}).strict();

export const combatKitInvalidatedMessageSchema = z.object({
  type: z.literal("COMBAT_KIT_INVALIDATED"),
  requestId: requestIdSchema.optional(),
  kitIndex: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6)
  ]),
  reason: z.enum(COMBAT_KIT_INVALID_REASONS),
  equipment: equipmentSnapshotSchema
}).strict();
