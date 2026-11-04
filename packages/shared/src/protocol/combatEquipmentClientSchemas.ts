import { z } from "zod";
import { UTILITY_GEAR_DEFINITION_IDS } from "../utilityGear.js";
import { GEAR_SCROLL_MEMORY_GROUPS } from "../gearScrolls.js";

import { CLASS_IDS, LAUNCH_CLASS_IDS, SUBCLASS_IDS } from "../classes.js";
import { CURRENT_LEVEL_CAP } from "../progression.js";
import {
  EQUIPMENT_GAMEPLAY_FAMILY_IDS,
  EQUIPMENT_SLOTS,
  MAX_EQUIPMENT_LEVEL,
  equipmentDefinitionIdSchema
} from "../equipment.js";

const requestIdSchema = z.string().min(1).max(128);

export const ABILITY_TARGET_MODES = ["hostile", "friendly", "self"] as const;
export type AbilityTargetMode = (typeof ABILITY_TARGET_MODES)[number];
const abilityTargetModeSchema = z.enum(ABILITY_TARGET_MODES);
const abilityTargetPositionSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180)
}).strict();

export const startAttackMessageSchema = z.object({
  type: z.literal("START_ATTACK"),
  requestId: requestIdSchema,
  targetEntityId: z.string().min(1).max(160),
  confirmNpcHostility: z.boolean().optional()
}).strict();

export const startXoralEventMessageSchema = z.object({
  type: z.literal("START_XORAL_EVENT"),
  requestId: requestIdSchema,
  xoralEntityId: z.string().min(1).max(160)
}).strict();

export const confirmXoralExitMessageSchema = z.object({
  type: z.literal("CONFIRM_XORAL_EXIT"),
  requestId: requestIdSchema
}).strict();

export const pickupXoralRingDropMessageSchema = z.object({
  type: z.literal("PICKUP_XORAL_RING_DROP"),
  requestId: requestIdSchema,
  dropId: z.string().uuid()
}).strict();

export const cancelAttackMessageSchema = z.object({
  type: z.literal("CANCEL_ATTACK"),
  requestId: requestIdSchema
}).strict();

export const requestProgressionSnapshotMessageSchema = z.object({
  type: z.literal("REQUEST_PROGRESSION_SNAPSHOT"),
  requestId: requestIdSchema
}).strict();

/** Glimmer level-up fee: pay for and apply exactly one ready level (`targetLevel` = level + 1). */
export const confirmLevelUpMessageSchema = z.object({
  type: z.literal("CONFIRM_LEVEL_UP"),
  requestId: requestIdSchema,
  targetLevel: z.number().int().min(1).max(CURRENT_LEVEL_CAP),
  expectedGlimmerCost: z.number().int().positive().max(1_000_000)
}).strict();

export const respawnPlayerMessageSchema = z.object({
  type: z.literal("RESPAWN_PLAYER"),
  requestId: requestIdSchema
}).strict();

export const equipItemMessageSchema = z.object({
  type: z.literal("EQUIP_ITEM"),
  requestId: requestIdSchema,
  instanceId: z.string().uuid(),
  slot: z.enum(EQUIPMENT_SLOTS)
}).strict();

export const unequipItemMessageSchema = z.object({
  type: z.literal("UNEQUIP_ITEM"),
  requestId: requestIdSchema,
  instanceId: z.string().uuid()
}).strict();

export const upgradeEquipmentMessageSchema = z.object({
  type: z.literal("UPGRADE_EQUIPMENT"),
  requestId: requestIdSchema,
  instanceId: z.string().uuid(),
  expectedLevel: z.number().int().min(0).max(MAX_EQUIPMENT_LEVEL),
  facilityStructureId: z.string().uuid().optional(),
  manorSessionId: z.string().uuid().optional(),
  manorMovementSequence: z.number().int().nonnegative().optional()
}).strict();

export const craftEquipmentMessageSchema = z.object({
  type: z.literal("CRAFT_EQUIPMENT"),
  requestId: requestIdSchema,
  familyId: z.enum(EQUIPMENT_GAMEPLAY_FAMILY_IDS),
  /** Set only to craft a swag weapon of this family; omitted crafts the stock item. */
  definitionId: equipmentDefinitionIdSchema.optional(),
  /**
   * Smithing Station authority. Both are omitted only for a portable craft (a starter gathering
   * tool crafted on the player); the server refuses every other craft without them.
   */
  manorSessionId: z.string().uuid().optional(),
  manorMovementSequence: z.number().int().nonnegative().optional()
}).strict();

export const craftRepairKitMessageSchema = z.object({
  type: z.literal("CRAFT_REPAIR_KIT"),
  requestId: requestIdSchema,
  manorSessionId: z.string().uuid(),
  manorMovementSequence: z.number().int().nonnegative()
}).strict();

export const repairEquipmentMessageSchema = z.object({
  type: z.literal("REPAIR_EQUIPMENT"),
  requestId: requestIdSchema,
  instanceId: z.string().uuid(),
  expectedCondition: z.number().int().min(0).max(100),
  manorSessionId: z.string().uuid(),
  manorMovementSequence: z.number().int().nonnegative()
}).strict();

/** Mending Resin: restore condition on one carried or worn piece of chest armor. */
export const mendEquipmentMessageSchema = z.object({
  type: z.literal("MEND_EQUIPMENT"),
  requestId: requestIdSchema,
  instanceId: z.string().uuid(),
  stackId: z.string().uuid().optional()
}).strict();

/** Random-roll rings: polish a Rough ring (Glimmer Oil) or dump a ring for Ring Shards. */
export const polishRingMessageSchema = z.object({
  type: z.literal("POLISH_RING"),
  requestId: requestIdSchema,
  instanceId: z.string().uuid()
}).strict();

export const dumpRingMessageSchema = z.object({
  type: z.literal("DUMP_RING"),
  requestId: requestIdSchema,
  instanceId: z.string().uuid()
}).strict();

/** Utility gear (gloves): crafted only by active Atlas Pass members; the server enforces it. */
export const craftUtilityGearMessageSchema = z.object({
  type: z.literal("CRAFT_UTILITY_GEAR"),
  requestId: requestIdSchema,
  definitionId: z.enum(UTILITY_GEAR_DEFINITION_IDS)
}).strict();

/** Loadout Scrolls: crafting is Atlas Pass only (server enforced); positions are 1-based. */
export const craftGearScrollMessageSchema = z.object({
  type: z.literal("CRAFT_GEAR_SCROLL"),
  requestId: requestIdSchema
}).strict();

export const requestGearScrollsMessageSchema = z.object({
  type: z.literal("REQUEST_GEAR_SCROLLS"),
  requestId: requestIdSchema
}).strict();

export const rememberGearScrollMessageSchema = z.object({
  type: z.literal("REMEMBER_GEAR_SCROLL"),
  requestId: requestIdSchema,
  position: z.number().int().min(1).max(100_000),
  group: z.enum(GEAR_SCROLL_MEMORY_GROUPS)
}).strict();

export const equipGearScrollMessageSchema = z.object({
  type: z.literal("EQUIP_GEAR_SCROLL"),
  requestId: requestIdSchema,
  position: z.number().int().min(1).max(100_000)
}).strict();

export const purchaseLimitedEquipmentMessageSchema = z.object({
  type: z.literal("PURCHASE_LIMITED_EQUIPMENT"),
  requestId: requestIdSchema,
  definitionId: equipmentDefinitionIdSchema,
  manorSessionId: z.string().uuid(),
  manorMovementSequence: z.number().int().nonnegative()
}).strict();

export const saveCombatKitMessageSchema = z.object({
  type: z.literal("SAVE_COMBAT_KIT"),
  requestId: requestIdSchema,
  kitIndex: z.number().int().min(1).max(6),
  expectedInventoryRevision: z.number().int().nonnegative()
}).strict();

export const renameCombatKitMessageSchema = z.object({
  type: z.literal("RENAME_COMBAT_KIT"),
  requestId: requestIdSchema,
  kitIndex: z.number().int().min(1).max(6),
  name: z.string().trim().min(1).max(32)
}).strict();

export const clearCombatKitMessageSchema = z.object({
  type: z.literal("CLEAR_COMBAT_KIT"),
  requestId: requestIdSchema,
  kitIndex: z.number().int().min(1).max(6),
  expectedInventoryRevision: z.number().int().nonnegative()
}).strict();

export const activateCombatKitMessageSchema = z.object({
  type: z.literal("ACTIVATE_COMBAT_KIT"),
  requestId: requestIdSchema,
  kitIndex: z.number().int().min(1).max(6),
  expectedInventoryRevision: z.number().int().nonnegative()
}).strict();

export const toggleReadiedWeaponMessageSchema = z.object({
  type: z.literal("TOGGLE_READIED_WEAPON"),
  requestId: requestIdSchema,
  readiedWeaponSlot: z.enum(["melee", "secondary"]),
  expectedInventoryRevision: z.number().int().nonnegative()
}).strict();

export const requestClassSnapshotMessageSchema = z.object({
  type: z.literal("REQUEST_CLASS_SNAPSHOT"),
  requestId: requestIdSchema
}).strict();

const classLoadoutSchema = z.object({
  resetActives: z.tuple([z.string().min(1).max(160).nullable(), z.string().min(1).max(160).nullable()]),
  normalActives: z.tuple([z.string().min(1).max(160).nullable(), z.string().min(1).max(160).nullable()]),
  passiveTiers: z.tuple([
    z.string().min(1).max(160).nullable(),
    z.string().min(1).max(160).nullable(),
    z.string().min(1).max(160).nullable()
  ]),
  ultimateActive: z.string().min(1).max(160).nullable()
}).strict();

export const updateClassLoadoutMessageSchema = z.object({
  type: z.literal("UPDATE_CLASS_LOADOUT"),
  requestId: requestIdSchema,
  loadout: classLoadoutSchema
}).strict();

export const activateSubclassMessageSchema = z.object({
  type: z.literal("ACTIVATE_SUBCLASS"),
  requestId: requestIdSchema,
  subclassId: z.enum(SUBCLASS_IDS).nullable()
}).strict();

export const activateClassMessageSchema = z.object({
  type: z.literal("ACTIVATE_CLASS"),
  requestId: requestIdSchema,
  classId: z.enum(CLASS_IDS)
}).strict();

export const unlockClassMessageSchema = z.object({
  type: z.literal("UNLOCK_CLASS"),
  requestId: requestIdSchema,
  classId: z.enum(LAUNCH_CLASS_IDS)
}).strict();

export const useNormalAbilityMessageSchema = z.object({
  type: z.literal("USE_NORMAL_ABILITY"),
  requestId: requestIdSchema,
  abilityId: z.string().min(1).max(160),
  targetEntityId: z.string().min(1).max(160).optional(),
  targetMode: abilityTargetModeSchema.optional(),
  targetPosition: abilityTargetPositionSchema.optional()
}).strict();

export const useUltimateAbilityMessageSchema = z.object({
  type: z.literal("USE_ULTIMATE_ABILITY"),
  requestId: requestIdSchema,
  abilityId: z.string().min(1).max(160),
  targetEntityId: z.string().min(1).max(160).optional(),
  targetMode: abilityTargetModeSchema.optional(),
  targetPosition: abilityTargetPositionSchema.optional()
}).strict();

export const useResetAbilityMessageSchema = z.object({
  type: z.literal("USE_RESET_ABILITY"),
  requestId: requestIdSchema,
  abilityId: z.string().min(1).max(160),
  targetEntityId: z.string().min(1).max(160).optional(),
  targetMode: abilityTargetModeSchema.optional()
}).strict();

export const useUniversalTauntMessageSchema = z.object({
  type: z.literal("USE_UNIVERSAL_TAUNT"),
  requestId: requestIdSchema
}).strict();
