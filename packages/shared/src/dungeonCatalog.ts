import { z } from "zod";

import { INTERIOR_DATA } from "./data/interiors/index.js";
import { dungeonCatalogFromInterior } from "./interior/dungeonView.js";
import type { InteriorCatalog } from "./interior/interiorCatalog.js";
import { MOB_ARCHETYPE_KEYS } from "./combat.js";
import { DUNGEON_TURN_IN_IDS } from "./dungeonSkills.js";
import { DUNGEON_ELITE_MODIFIER_IDS, dungeonEliteModifierAllowed } from "./dungeonEliteModifiers.js";
import { randomDungeonPointInShape } from "./dungeonRolls.js";
import { INVENTORY_CATALOG } from "./inventoryCatalog.js";
import { CURRENT_LEVEL_CAP } from "./progression.js";
import {
  STANDARD_INDOOR_SPATIAL_PROFILE,
  findIndoorNavigationRoute,
  isIndoorNavigationPointWalkable,
  type IndoorRoomNavigation
} from "./indoor.js";

export const DUNGEON_CATALOG_SCHEMA_VERSION = 2 as const;
/** Existing harvest commodities supported by dungeon nodes, without widening world spawns. */
export const DUNGEON_RESOURCE_TYPES = ["wood", "ore", "stone", "coal", "iron", "sulfur", "flax_fiber", "balsam_resin"] as const;
export type DungeonResourceType = (typeof DUNGEON_RESOURCE_TYPES)[number];
export const DUNGEON_CHEST_RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type DungeonChestRarity = (typeof DUNGEON_CHEST_RARITIES)[number];
/** Dungeon tiers; the number is the tier's dungeon level (t00 = the Sewer). Profiles: dungeonTierProfiles.ts. */
export const DUNGEON_TIER_IDS = ["t00", "t05", "t10", "t15", "t20", "t25", "t30", "t35", "t40"] as const;
export type DungeonTierId = (typeof DUNGEON_TIER_IDS)[number];
/** Torch cap per run: rolled encounters emit one extra placement set per torch beyond the first. */
export const DUNGEON_MAX_TORCHES = 10;

/** The dungeon level used for elite modifier rules: its tier's level, or 0 without a tier. */
export function dungeonTierLevel(dungeon: Readonly<{ tier?: { id: DungeonTierId } | undefined }>): number {
  return dungeon.tier ? Number(dungeon.tier.id.slice(1)) : 0;
}

const idSchema = z.string().regex(
  /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
  "must be a safe lowercase ID"
);
const finiteNumber = z.number().finite();
const assetKeySchema = z.string().regex(
  /^apps\/client\/public\/assets\/dungeons\/[a-zA-Z0-9][a-zA-Z0-9/_-]*\.png$/,
  "must reference a PNG under apps/client/public/assets/dungeons/"
);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a six-digit hex color");
const pointSchema = z.object({ x: finiteNumber, y: finiteNumber }).strict();
const anchorSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  x: finiteNumber,
  y: finiteNumber,
  facing: finiteNumber.optional()
}).strict();
const rectangleSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  x: finiteNumber,
  y: finiteNumber,
  width: finiteNumber.positive(),
  height: finiteNumber.positive()
}).strict();
const rectangleColliderSchema = rectangleSchema.extend({ kind: z.literal("rectangle") }).strict();
const polygonColliderSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  kind: z.literal("polygon"),
  points: z.array(pointSchema).min(3)
}).strict();
const colliderSchema = z.discriminatedUnion("kind", [rectangleColliderSchema, polygonColliderSchema]);
const zonePurposeSchema = z.enum([
  "trigger", "encounter_boundary", "leash", "safe", "damage", "restricted", "heal"
]);
const rectangleZoneSchema = rectangleColliderSchema.extend({ purpose: zonePurposeSchema }).strict();
const polygonZoneSchema = polygonColliderSchema.extend({ purpose: zonePurposeSchema }).strict();
const zoneSchema = z.discriminatedUnion("kind", [rectangleZoneSchema, polygonZoneSchema]);
const layerIdSchema = z.enum([
  "background", "below_player", "actors", "above_player", "ceiling"
]);
const layerPlacementSchema = rectangleSchema.extend({
  prefabId: idSchema,
  prefabRevision: z.string().min(1),
  rotationDeg: finiteNumber,
  opacity: finiteNumber.min(0).max(1),
  flipX: z.boolean(),
  flipY: z.boolean(),
  zIndex: z.number().int()
}).strict();
const layersSchema = z.object({
  background: z.array(layerPlacementSchema),
  below_player: z.array(layerPlacementSchema),
  actors: z.array(layerPlacementSchema),
  above_player: z.array(layerPlacementSchema),
  ceiling: z.array(layerPlacementSchema)
}).strict();
const objectStateSchema = z.enum([
  "idle", "open", "closed", "on", "off", "pressed", "released",
  "intact", "destroyed", "looted"
]);
const objectSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  type: z.enum([
    "portal", "door", "ladder", "chest", "valve", "switch", "shrine",
    "harvestable", "destructible", "npc", "decoration", "exit_ladder"
  ]),
  prefabId: idSchema,
  prefabRevision: z.string().min(1),
  layerId: layerIdSchema,
  name: z.string().min(1),
  anchorId: idSchema,
  available: z.boolean(),
  initialState: objectStateSchema,
  interactionRadius: finiteNumber.positive(),
  rotationDeg: finiteNumber,
  opacity: finiteNumber.min(0).max(1),
  flipX: z.boolean(),
  flipY: z.boolean(),
  zIndex: z.number().int(),
  portalId: idSchema.optional(),
  interactionLabel: z.string().min(1).optional(),
  spawnChance: finiteNumber.min(0).max(100).optional(),
  /**
   * Random per-run pick across the dungeon: of every object sharing this group id, between `min` and
   * `max` (seeded by the run id) are present for the run. Every member repeats the same `min`/`max`.
   * Replaces `spawnChance` for the members.
   */
  spawnGroup: z.object({
    id: idSchema,
    min: z.number().int().nonnegative(),
    max: z.number().int().positive()
  }).strict().optional(),
  rewardTableId: idSchema.optional(),
  /** Token turn-in: interacting consumes the skill's tokens and unlocks it once per player (see dungeonSkills.ts). */
  skillTurnIn: z.enum(DUNGEON_TURN_IN_IDS).optional()
}).strict();
const resourceTypeSchema = z.enum(DUNGEON_RESOURCE_TYPES);
const resourceShapeSchema = z.discriminatedUnion("kind", [
  rectangleColliderSchema,
  polygonColliderSchema
]);
const dungeonResourceSpawnZoneSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  shape: resourceShapeSchema,
  resourceTypes: z.array(resourceTypeSchema).min(1),
  minCount: z.number().int().nonnegative(),
  maxCount: z.number().int().positive(),
  minYield: z.number().int().positive().optional(),
  maxYield: z.number().int().positive().optional(),
  minimumSpacing: finiteNumber.nonnegative(),
  seed: z.number().int().nonnegative(),
  respawnSeconds: finiteNumber.nonnegative().nullable(),
  resetOnRun: z.boolean(),
  interactionRadius: finiteNumber.positive(),
  prefabId: idSchema.optional()
}).strict();
const dungeonResourceNodeSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  anchorId: idSchema,
  resourceType: resourceTypeSchema,
  minYield: z.number().int().positive(),
  maxYield: z.number().int().positive(),
  respawnSeconds: finiteNumber.nonnegative().nullable(),
  resetOnRun: z.boolean(),
  available: z.boolean(),
  interactionRadius: finiteNumber.positive(),
  prefabId: idSchema.optional(),
  prefabRevision: z.string().min(1).optional()
}).strict();
const mobPlacementSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  archetype: z.enum(MOB_ARCHETYPE_KEYS),
  anchorId: idSchema,
  facing: finiteNumber,
  encounterId: idSchema,
  spawnGroupId: idSchema,
  waveIndex: z.number().int().min(1),
  leashZoneId: idSchema.optional(),
  randomSpawnZoneId: idSchema.optional(),
  summonedByMobSpawnId: idSchema.optional(),
  summonAtHealthPercent: finiteNumber.min(1).max(100).optional(),
  visualScale: finiteNumber.positive(),
  /** Rolled elite: the picked modifiers. Stats and behaviour are applied by the elite runtime. */
  elite: z.object({ modifiers: z.array(z.enum(DUNGEON_ELITE_MODIFIER_IDS)).min(1) }).strict().optional(),
  /** Torch set (2..10): spawns only when the run's torch total reaches it. Absent means set 1. */
  partySet: z.number().int().min(2).max(DUNGEON_MAX_TORCHES).optional(),
  /** Emitted by the run materializer, never authored. */
  generated: z.literal(true).optional()
}).strict();
const cameraSchema = z.object({
  mode: z.literal("fixed_center"),
  center: pointSchema,
  fitPadding: finiteNumber.nonnegative(),
  defaultZoom: finiteNumber.positive(),
  minZoom: finiteNumber.positive(),
  maxZoom: finiteNumber.positive()
}).strict();
const roomEnvironmentSchema = z.object({
  environmentId: idSchema,
  visualTreatmentId: idSchema.nullable().optional(),
  musicAssetKey: z.string().min(1).nullable(),
  ambienceAssetKey: z.string().min(1).nullable()
}).strict();
export const dungeonRoomDefinitionSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  name: z.string().min(1),
  active: z.boolean(),
  width: finiteNumber.positive(),
  height: finiteNumber.positive(),
  spatialProfileId: z.literal("standard_indoor_v1"),
  spawnAnchorId: idSchema,
  camera: cameraSchema,
  environment: roomEnvironmentSchema,
  layers: layersSchema,
  anchors: z.array(anchorSchema),
  colliders: z.array(colliderSchema),
  zones: z.array(zoneSchema),
  objects: z.array(objectSchema),
  mobs: z.array(mobPlacementSchema),
  resourceSpawnZones: z.array(dungeonResourceSpawnZoneSchema).optional(),
  resourceNodes: z.array(dungeonResourceNodeSchema).optional(),
  /**
   * The room's authored walkable floors (the interior floors): movement keeps the feet anchor inside them. Server
   * catalog data only; dungeon snapshots leave it out, so the wire shape is unchanged.
   */
  floors: z.array(z.object({ id: idSchema, retired: z.boolean(), polygon: z.array(pointSchema).min(3) }).strict()).optional()
}).strict();
const roomSchema = dungeonRoomDefinitionSchema;
const roomEndpointSchema = z.object({
  kind: z.literal("room"), roomId: idSchema, anchorId: idSchema
}).strict();
const worldEndpointSchema = z.object({ kind: z.literal("world") }).strict();
const dungeonEntranceSchema = z.object({
  id: idSchema,
  dungeonId: idSchema,
  revision: z.string().min(1),
  retired: z.boolean(),
  name: z.string().min(1),
  description: z.string().min(1),
  lat: finiteNumber.min(-90).max(90),
  lon: finiteNumber.min(-180).max(180),
  interactionRadiusM: finiteNumber.positive(),
  footprintRadiusM: finiteNumber.positive(),
  portalId: idSchema,
  portalRevision: z.string().min(1),
  interactionLabel: z.string().min(1),
  presentation: z.enum(["door", "stairs", "ladder", "hatch", "cave"]),
  assetKey: assetKeySchema.nullable(),
  preloadSceneKey: z.string().min(1).optional()
}).strict();
const dungeonRewardTableSchema = z.object({
  id: idSchema,
  revision: z.string().min(1),
  retired: z.boolean(),
  gold: z.number().int().nonnegative().optional(),
  /** Completion chest: +1 chest-loot slot per torch the run burned beyond the first. */
  torchBonusSlots: z.boolean().optional(),
  chestLoot: z.object({
    rarities: z.array(z.object({
      rarity: z.enum(DUNGEON_CHEST_RARITIES),
      chance: finiteNumber.min(0).max(100),
      slots: z.number().int().min(1).max(32),
      assetKey: assetKeySchema.optional(),
      loot: z.array(z.object({
        itemId: idSchema,
        weight: finiteNumber.positive(),
        minQuantity: z.number().int().positive(),
        maxQuantity: z.number().int().positive()
      }).strict().refine((entry) => entry.maxQuantity >= entry.minQuantity, { message: "maximum quantity must cover minimum quantity" })).min(1)
    }).strict()).length(5)
  }).strict().refine((value) => new Set(value.rarities.map((row) => row.rarity)).size === 5 &&
    Math.abs(value.rarities.reduce((sum, row) => sum + row.chance, 0) - 100) < 0.000001,
  { message: "use all five rarities exactly once with percentages totaling 100%" }).optional(),
  items: z.array(z.object({
    itemId: idSchema,
    quantity: z.number().int().positive()
  }).strict()),
  /** Rolled independently per claimant and claim seed; paid on top of fixed items, gold and chest loot. */
  chanceItems: z.array(z.object({
    itemId: idSchema,
    minQuantity: z.number().int().positive(),
    maxQuantity: z.number().int().positive(),
    chancePct: finiteNumber.gt(0).max(100),
    /** Adds the torch chance bonus (`DUNGEON_TORCH_CHANCE_BONUS_PCT` per torch beyond the first, capped). */
    torchScaling: z.boolean().optional()
  }).strict().refine((entry) => entry.maxQuantity >= entry.minQuantity, { message: "maximum quantity must cover minimum quantity" }))
    .max(16).optional()
}).strict().refine((table) => (table.gold ?? 0) > 0 || table.items.length > 0 || Boolean(table.chestLoot) ||
  (table.chanceItems?.length ?? 0) > 0, {
  message: "must grant at least one item or Gold"
}).refine((table) => new Set(table.chanceItems?.map((entry) => entry.itemId)).size === (table.chanceItems?.length ?? 0), {
  message: "chance items must list each item once"
});
const portalSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  source: z.union([roomEndpointSchema, worldEndpointSchema]),
  destination: z.union([roomEndpointSchema, worldEndpointSchema]),
  sourceApproachAnchorId: idSchema.optional(),
  sourceThresholdAnchorId: idSchema.optional(),
  destinationArrivalAnchorId: idSchema.optional(),
  reciprocalPortalId: idSchema.optional(),
  conditions: z.array(z.enum(["always", "dungeon_active", "unlocked", "boss_defeated"]))
    .min(1).max(8),
  gates: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("dungeon_flag"), flagId: idSchema, value: z.boolean() }).strict(),
    z.object({ type: z.literal("item_owned"), itemId: idSchema, quantity: z.number().int().positive() }).strict(),
    z.object({ type: z.literal("quest_flag"), flagId: idSchema, value: z.boolean() }).strict()
  ])).optional(),
  interactionLabel: z.string().min(1),
  presentation: z.enum(["door", "stairs", "ladder", "hatch", "cave"]),
  accessPolicyId: idSchema.optional(),
  preloadSceneKey: z.string().min(1).optional(),
  enabled: z.boolean()
}).strict();
const encounterWaveSchema = z.object({
  id: idSchema,
  mobSpawnIds: z.array(idSchema).min(1),
  delayMs: finiteNumber.nonnegative()
}).strict();
const formationSchema = z.enum(["scatter", "line", "wedge", "circle"]);
const minMaxSchema = (minimum: number, maximum: number) => z.object({
  min: z.number().int().min(minimum).max(maximum),
  max: z.number().int().min(minimum).max(maximum)
}).strict().refine((range) => range.min <= range.max, { message: "min must not exceed max" });
/**
 * Seeded per-run roll (Level 1). The run materializer expands it into generated placements and waves,
 * so a rolled encounter authors no waves or placements of its own. Boss encounters never roll.
 */
const encounterRollSchema = z.object({
  pool: z.array(z.object({
    archetype: z.enum(MOB_ARCHETYPE_KEYS),
    cost: z.number().int().min(1).max(100),
    min: z.number().int().nonnegative().max(20).optional(),
    max: z.number().int().positive().max(40).optional(),
    weight: finiteNumber.positive().optional(),
    /** Defaults to true when the roll has elites. */
    eliteEligible: z.boolean().optional(),
    visualScale: finiteNumber.positive().optional()
  }).strict().refine((entry) => entry.max === undefined || (entry.min ?? 0) <= entry.max,
    { message: "min must not exceed max" })).min(1),
  /** Solo points for the base set. */
  budget: minMaxSchema(1, 400),
  waves: z.object({
    min: z.number().int().min(1).max(4),
    max: z.number().int().min(1).max(4),
    /** Pause before each wave after the first. */
    delayMs: finiteNumber.nonnegative().max(60_000).optional()
  }).strict().refine((range) => range.min <= range.max, { message: "min must not exceed max" }),
  spawn: z.union([
    z.object({ zoneIds: z.array(idSchema).min(1) }).strict(),
    z.object({ anchorIds: z.array(idSchema).min(1) }).strict()
  ]),
  formations: z.array(formationSchema).min(1).optional(),
  elite: z.object({
    chancePct: finiteNumber.min(0).max(100),
    maxPerEncounter: z.number().int().nonnegative().max(40),
    modifierPool: z.array(z.enum(DUNGEON_ELITE_MODIFIER_IDS)).min(1).optional()
  }).strict().optional(),
  /** Budget of each extra torch set as a percentage of the rolled base budget (default 60). */
  partySetBudgetPct: finiteNumber.min(0).max(200).optional()
}).strict();
const encounterSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  name: z.string().min(1),
  roomId: idSchema,
  boundaryZoneId: idSchema,
  leashZoneId: idSchema,
  /** At least one, unless the encounter has a `roll` (then none: the roll generates them). */
  waves: z.array(encounterWaveSchema),
  completion: z.literal("all_spawned_mobs_defeated"),
  reset: z.object({ onPartyWipe: z.boolean(), delayMs: finiteNumber.nonnegative() }).strict(),
  retry: z.object({ allowed: z.boolean(), maxAttempts: z.number().int().min(1).nullable() }).strict(),
  lockPortalIds: z.array(idSchema),
  rewardTableId: idSchema.optional(),
  bossTemplateId: idSchema.optional(),
  /**
   * Timed rescue: clear the encounter within `timeLimitMs` of its start and every player in the room
   * gains a freed ally (a Valkyrie). Sets the dungeon flag `<encounter id>_rescued` on success.
   */
  rescue: z.object({ timeLimitMs: z.number().int().min(5_000).max(600_000) }).strict().optional(),
  groupControls: z.object({
    formation: formationSchema.default("scatter"),
    linkedAggro: z.boolean().default(false)
  }).optional(),
  roll: encounterRollSchema.optional()
}).strict();

const triggerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("room_enter"), roomId: idSchema }).strict(),
  z.object({ type: z.literal("room_exit"), roomId: idSchema }).strict(),
  z.object({ type: z.literal("zone_enter"), roomId: idSchema, zoneId: idSchema }).strict(),
  z.object({ type: z.literal("zone_exit"), roomId: idSchema, zoneId: idSchema }).strict(),
  z.object({ type: z.literal("all_players_present"), roomId: idSchema, zoneId: idSchema }).strict(),
  z.object({ type: z.literal("object_interact"), roomId: idSchema, objectId: idSchema }).strict(),
  z.object({ type: z.literal("object_state"), roomId: idSchema, objectId: idSchema,
    state: z.enum(["idle", "open", "closed", "on", "off", "pressed", "released", "intact", "destroyed", "looted"]) }).strict(),
  z.object({ type: z.literal("object_sequence"), roomId: idSchema, objectIds: z.array(idSchema).min(1) }).strict(),
  z.object({ type: z.literal("portal_used"), portalId: idSchema }).strict(),
  z.object({ type: z.literal("timer"), delayMs: finiteNumber.nonnegative() }).strict(),
  z.object({ type: z.literal("encounter_state"), encounterId: idSchema,
    state: z.enum(["idle", "active", "completed", "failed", "resetting"]) }).strict(),
  z.object({ type: z.literal("room_clear"), roomId: idSchema }).strict(),
  z.object({ type: z.literal("object_destroyed"), roomId: idSchema, objectId: idSchema }).strict(),
  z.object({ type: z.literal("player_count"), operator: z.enum(["at_least", "at_most", "exactly"]), count: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("dungeon_flag"), flagId: idSchema, value: z.boolean() }).strict()
]);
const triggerConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("encounter_state"), encounterId: idSchema,
    state: z.enum(["idle", "active", "completed", "failed", "resetting"]) }).strict(),
  z.object({ type: z.literal("object_state"), roomId: idSchema, objectId: idSchema,
    state: z.enum(["idle", "open", "closed", "on", "off", "pressed", "released", "intact", "destroyed", "looted"]) }).strict(),
  z.object({ type: z.literal("dungeon_flag"), flagId: idSchema, value: z.boolean() }).strict(),
  z.object({ type: z.literal("player_count"), operator: z.enum(["at_least", "at_most", "exactly"]), count: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("item_owned"), itemId: idSchema, quantity: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal("quest_flag"), flagId: idSchema, value: z.boolean() }).strict()
]);
/** Authored HUD message limits shared by the catalog, the runtime and the studio. */
export const DUNGEON_MESSAGE_MAX_LENGTH = 140;
export const DUNGEON_NOTICE_TONES = ["info", "success", "warning"] as const;
const triggerActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start_encounter"), encounterId: idSchema }).strict(),
  z.object({ type: z.literal("start_wave"), encounterId: idSchema, waveId: idSchema }).strict(),
  z.object({ type: z.literal("set_object_state"), roomId: idSchema, objectId: idSchema,
    state: z.enum(["idle", "open", "closed", "on", "off", "pressed", "released", "intact", "destroyed", "looted"]) }).strict(),
  z.object({ type: z.literal("set_object_available"), roomId: idSchema, objectId: idSchema,
    available: z.boolean() }).strict(),
  z.object({ type: z.literal("set_portal_locked"), portalId: idSchema, locked: z.boolean() }).strict(),
  z.object({ type: z.literal("enable_trigger"), triggerId: idSchema, enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("play_cue"), cueId: idSchema }).strict(),
  z.object({
    type: z.literal("show_message"),
    text: z.string().trim().min(1).max(DUNGEON_MESSAGE_MAX_LENGTH),
    tone: z.enum(DUNGEON_NOTICE_TONES).optional()
  }).strict(),
  z.object({ type: z.literal("set_dungeon_flag"), flagId: idSchema, value: z.boolean() }).strict(),
  z.object({ type: z.literal("grant_reward"), rewardTableId: idSchema }).strict(),
  /**
   * Pays one claim to every connected member: of the instance ("present") or of the event's room
   * ("room_present"). For instance-wide events (encounter_state, room_clear, dungeon_flag).
   */
  z.object({
    type: z.literal("grant_run_reward"),
    rewardTableId: idSchema,
    recipients: z.enum(["present", "room_present"])
  }).strict(),
  z.object({ type: z.literal("complete_dungeon") }).strict()
]);
export const dungeonTriggerSchema = z.object({
  id: idSchema,
  retired: z.boolean(),
  enabled: z.boolean(),
  scope: z.enum(["player", "party", "instance"]),
  repetition: z.enum(["once", "repeat", "cooldown"]),
  cooldownMs: finiteNumber.nonnegative(),
  event: triggerEventSchema,
  conditions: z.object({ mode: z.enum(["all", "any"]), items: z.array(triggerConditionSchema) }).strict(),
  actions: z.array(triggerActionSchema).min(1)
}).strict();
/**
 * Who may start a run from a world entrance. All fields are optional; an absent field means no
 * requirement. Enforced server-side on world to dungeon entry.
 */
export const dungeonAccessSchema = z.object({
  /** Minimum player level to enter. */
  minimumLevel: z.number().int().min(1).max(60).optional(),
  /** Items one torch costs; each member pays for the torches they burn when the run starts (torch lobby). */
  entryCost:z.array(z.object({ itemId: idSchema, quantity: z.number().int().positive().max(1000) }).strict()).max(8).optional(),
  /** Days a player is locked out of this dungeon after completing it (0 = never locked out). */
  lockoutDays: z.number().int().min(0).max(365).optional(),
  /** Hours locked out after completing; takes precedence over lockoutDays when set (Delver's Lore does not shorten it). */
  lockoutHours: z.number().int().min(1).max(168).optional(),
  /** Every entrant must be afloat (a sea dungeon entered from a raft or buoy). */
  requiresAfloat: z.boolean().optional(),
  /**
   * Leaving through the world exit before the run is complete starts the lockout, so a run cannot
   * be re-entered. Death respawns inside and a disconnect restores on reconnect; neither counts.
   */
  noReentry: z.boolean().optional()
}).strict();
export type DungeonAccessDefinition = z.infer<typeof dungeonAccessSchema>;

/**
 * Torch lobby rules (tunable). Each member burns DUNGEON_TORCH_MEMBER_MIN.. torches and pays for their own;
 * the party total must be DUNGEON_TORCH_TOTAL_MIN..DUNGEON_TORCH_TOTAL_MAX and sets the run's mob sets.
 */
export const DUNGEON_TORCH_MEMBER_MIN = 0;
export const DUNGEON_TORCH_TOTAL_MIN = 1;
export const DUNGEON_TORCH_TOTAL_MAX = 10;

/**
 * The level actually required to enter: the authored minimum, but never above the current level cap
 * (Fallen Prison is authored at level 40 while the cap is 25, so it asks for the cap).
 */
export function effectiveDungeonMinimumLevel(access: DungeonAccessDefinition | undefined): number | undefined {
  return access?.minimumLevel ? Math.min(access.minimumLevel, CURRENT_LEVEL_CAP) : undefined;
}

/** Quantity and name of each item, joined with " + ". */
export function describeDungeonEntryCost(cost: NonNullable<DungeonAccessDefinition["entryCost"]>): string {
  return cost.map((entry) => `${entry.quantity} ${INVENTORY_CATALOG[entry.itemId]?.displayName ?? entry.itemId}`).join(" + ");
}

/** Atlas Pass dungeon discount: 35% off the Glimmer Oil (refined_oil), rounded down, never below 1; other items unchanged. */
export function atlasPassDungeonEntryCost(
  cost: NonNullable<DungeonAccessDefinition["entryCost"]>
): NonNullable<DungeonAccessDefinition["entryCost"]> {
  return cost.map((entry) => entry.itemId === "refined_oil"
    ? { ...entry, quantity: Math.max(1, Math.floor(entry.quantity * 0.65)) }
    : entry);
}

/** Player-facing requirement lines for an entrance prompt; empty when the dungeon has no requirements. */
export function describeDungeonAccess(access: DungeonAccessDefinition | undefined): string[] {
  const lines: string[] = [];
  const minimumLevel = effectiveDungeonMinimumLevel(access);
  if (minimumLevel) lines.push(`Requires level ${minimumLevel}`);
  if (access?.entryCost?.length) lines.push(`Each torch: ${describeDungeonEntryCost(access.entryCost)}`);
  if (access?.lockoutHours) lines.push(`${access.lockoutHours}-hour lockout after clearing`);
  else if (access?.lockoutDays) lines.push(`${access.lockoutDays}-day lockout after clearing`);
  if (access?.requiresAfloat) lines.push("Enter from the water (afloat)");
  if (access?.noReentry) lines.push("No re-entry: leaving before the end starts the lockout");
  return lines;
}
const dungeonSchema = z.object({
  id: idSchema,
  revision: z.string().min(1),
  retired: z.boolean(),
  instancePolicy: z.enum(["shared_persistent", "party_ephemeral", "solo_ephemeral"]),
  name: z.string().min(1),
  description: z.string().min(1),
  spatialProfileId: z.literal("standard_indoor_v1"),
  entrance: z.object({
    roomId: idSchema, arrivalAnchorId: idSchema, portalId: idSchema
  }).strict(),
  escape: z.object({ portalId: idSchema }).strict(),
  deathRecovery: z.object({ roomId: idSchema, anchorId: idSchema }).strict(),
  reset: z.object({
    policy: z.enum(["when_empty", "manual", "never"]),
    revision: z.string().min(1),
    despawnAfterSeconds: finiteNumber.nonnegative().nullable(),
    resetEnemies: z.boolean(),
    resetLoot: z.boolean(),
    resetDoors: z.boolean(),
    resetBoss: z.boolean()
  }).strict(),
  environment: z.object({
    environmentId: idSchema,
    backgroundColor: colorSchema,
    floorColor: colorSchema,
    wallColor: colorSchema,
    accentColor: colorSchema,
    musicAssetKey: z.string().min(1).nullable(),
    ambienceAssetKey: z.string().min(1).nullable()
  }).strict(),
  rooms: z.array(roomSchema).min(1),
  portals: z.array(portalSchema).min(1),
  encounters: z.array(encounterSchema),
  triggers: z.array(dungeonTriggerSchema),
  rewardTableIds: z.array(idSchema),
  bossTemplateIds: z.array(idSchema),
  access: dungeonAccessSchema.optional(),
  /** Once declared, the dungeon must meet the tier profile's minimums (dungeonTierIssues). */
  tier: z.object({ id: z.enum(DUNGEON_TIER_IDS) }).strict().optional(),
  /**
   * Seeded per-run rolls outside encounters. Each flag is set true for a run with `chancePct`
   * (side-room and vault availability); portals and triggers gate on it as a dungeon flag.
   */
  runRolls: z.object({
    flags: z.array(z.object({
      flagId: idSchema,
      chancePct: finiteNumber.min(0).max(100)
    }).strict()).min(1)
  }).strict().optional()
}).strict();
const dungeonBossTemplateSchema = z.object({
  id: idSchema,
  revision: z.string().min(1),
  retired: z.boolean(),
  bossDefinitionId: idSchema,
  controllerId: idSchema,
  appearanceId: idSchema.optional(),
  rewardPolicyId: idSchema,
  displayName: z.string().min(1).optional()
}).strict();
export const dungeonPrefabDefinitionSchema = z.object({
  id: idSchema,
  revision: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["surface", "decoration", "object", "portal"]),
  retired: z.boolean(),
  defaultWidth: finiteNumber.positive(),
  defaultHeight: finiteNumber.positive(),
  defaultLayerId: layerIdSchema,
  assetKey: assetKeySchema,
  renderMode: z.enum(["sprite", "tile", "stretch"]),
  nativeWidth: z.number().int().positive(),
  nativeHeight: z.number().int().positive(),
  pivotX: finiteNumber.min(0).max(1),
  pivotY: finiteNumber.min(0).max(1),
  defaultOpacity: finiteNumber.min(0).max(1),
  defaultRotationDeg: finiteNumber,
  defaultFlipX: z.boolean(),
  defaultFlipY: z.boolean(),
  stateAssets: z.array(z.object({ stateId: objectStateSchema, assetKey: assetKeySchema }).strict()),
  defaultColliders: z.array(rectangleColliderSchema),
  interactionRadius: finiteNumber.positive().optional()
}).strict();

const catalogSchema = z.object({
  schemaVersion: z.literal(DUNGEON_CATALOG_SCHEMA_VERSION),
  catalogRevision: z.number().int().nonnegative(),
  spatialProfiles: z.array(z.literal("standard_indoor_v1")).length(1),
  prefabs: z.array(dungeonPrefabDefinitionSchema),
  entrances: z.array(dungeonEntranceSchema).default([]),
  rewardTables: z.array(dungeonRewardTableSchema).default([]),
  rewardTableIds: z.array(idSchema),
  bossTemplateIds: z.array(idSchema),
  bossTemplates: z.array(dungeonBossTemplateSchema).default([]),
  dungeons: z.array(dungeonSchema).min(1)
}).strict();

export type DungeonCatalog = z.infer<typeof catalogSchema>;
export type DungeonDefinition = z.infer<typeof dungeonSchema>;
export type DungeonRoomDefinition = z.infer<typeof roomSchema>;
export type DungeonAnchorDefinition = z.infer<typeof anchorSchema>;
export type DungeonObjectDefinition = z.infer<typeof objectSchema>;
export type DungeonPortalDefinition = z.infer<typeof portalSchema>;
export type DungeonEncounterDefinition = z.infer<typeof encounterSchema>;
export type DungeonTriggerDefinition = z.infer<typeof dungeonTriggerSchema>;
export type DungeonColliderDefinition = z.infer<typeof colliderSchema>;
export type DungeonZoneDefinition = z.infer<typeof zoneSchema>;
export type DungeonMobPlacementDefinition = z.infer<typeof mobPlacementSchema>;
export type DungeonPrefabDefinition = DungeonCatalog["prefabs"][number];
export type DungeonEntranceDefinition = DungeonCatalog["entrances"][number];
export type DungeonRewardTableDefinition = DungeonCatalog["rewardTables"][number];
export type DungeonResourceSpawnZoneDefinition = z.infer<typeof dungeonResourceSpawnZoneSchema>;
export type DungeonResourceNodeDefinition = z.infer<typeof dungeonResourceNodeSchema>;
export type DungeonBossTemplateDefinition = z.infer<typeof dungeonBossTemplateSchema>;
export type DungeonCatalogValidationIssue = Readonly<{ path: string; message: string }>;

export function dungeonCatalogValidationIssues(value: unknown): DungeonCatalogValidationIssue[] {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "$",
      message: issue.message
    }));
  }
  return semanticIssues(parsed.data);
}

export function parseDungeonCatalog(value: unknown): DungeonCatalog {
  return validateDungeonCatalog(value);
}

export function validateDungeonCatalog(value: unknown): DungeonCatalog {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(formatIssues(parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "$",
      message: issue.message
    }))));
  }
  const issues = semanticIssues(parsed.data);
  if (issues.length > 0) throw new Error(formatIssues(issues));
  return parsed.data;
}

function semanticIssues(catalog: DungeonCatalog): DungeonCatalogValidationIssue[] {
  const issues: DungeonCatalogValidationIssue[] = [];
  duplicateIssues(catalog.spatialProfiles, "spatialProfiles", (value) => value, issues);
  duplicateIssues(catalog.prefabs, "prefabs", (value) => value.id, issues);
  duplicateIssues(catalog.entrances, "entrances", (value) => value.id, issues);
  duplicateIssues(catalog.rewardTables, "rewardTables", (value) => value.id, issues);
  duplicateIssues(catalog.bossTemplates, "bossTemplates", (value) => value.id, issues);
  duplicateIssues(catalog.dungeons, "dungeons", (value) => value.id, issues);
  duplicateIssues(catalog.rewardTableIds, "rewardTableIds", (value) => value, issues);
  duplicateIssues(catalog.bossTemplateIds, "bossTemplateIds", (value) => value, issues);
  const prefabs = new Map(catalog.prefabs.map((prefab) => [prefab.id, prefab]));
  const activePrefabAssetKeys = new Set(catalog.prefabs
    .filter((prefab) => !prefab.retired)
    .map((prefab) => prefab.assetKey));
  const dungeons = new Map(catalog.dungeons.map((dungeon) => [dungeon.id, dungeon]));
  catalog.rewardTables.forEach((table, tableIndex) => {
    table.chanceItems?.forEach((entry, entryIndex) => {
      if (!INVENTORY_CATALOG[entry.itemId]?.packageGrantable) {
        issues.push({ path: `rewardTables.${tableIndex}.chanceItems.${entryIndex}.itemId`, message: "choose an existing grantable inventory item" });
      }
    });
    table.chestLoot?.rarities.forEach((rarity, rarityIndex) => {
      if (rarity.assetKey && !activePrefabAssetKeys.has(rarity.assetKey)) {
        issues.push({
          path: `rewardTables.${tableIndex}.chestLoot.rarities.${rarityIndex}.assetKey`,
          message: "references a missing active dungeon prefab asset"
        });
      }
      rarity.loot.forEach((loot, lootIndex) => {
        if (!INVENTORY_CATALOG[loot.itemId]?.packageGrantable) {
          issues.push({ path: `rewardTables.${tableIndex}.chestLoot.rarities.${rarityIndex}.loot.${lootIndex}.itemId`, message: "choose an existing grantable inventory item" });
        }
      });
    });
  });
  catalog.dungeons.forEach((dungeon, dungeonIndex) => {
    dungeon.access?.entryCost?.forEach((cost, costIndex) => {
      if (!INVENTORY_CATALOG[cost.itemId]) {
        issues.push({ path: `dungeons.${dungeonIndex}.access.entryCost.${costIndex}.itemId`, message: "choose an existing inventory item" });
      }
    });
  });
  catalog.entrances.forEach((entrance, entranceIndex) => {
    const dungeon = dungeons.get(entrance.dungeonId);
    if (!dungeon || (!entrance.retired && dungeon.retired)) {
      issues.push({ path: `entrances.${entranceIndex}.dungeonId`, message: "references an unavailable dungeon" });
      return;
    }
    const portal = dungeon.portals.find((candidate) => candidate.id === entrance.portalId);
    if (!portal || portal.source.kind !== "world" || (!entrance.retired && (portal.retired || !portal.enabled))) {
      issues.push({ path: `entrances.${entranceIndex}.portalId`, message: "must reference an active world entrance portal (or a retained portal for a retired entrance)" });
    }
  });
  // Client bundles ship without the server-only reward tables and boss templates, so there is
  // nothing to resolve the ids against there; the server and Studio catalogs carry both.
  const serverTablesPresent = catalog.rewardTables.length > 0 || catalog.bossTemplates.length > 0;
  if (serverTablesPresent) catalog.rewardTableIds.forEach((id, index) => {
    const table = catalog.rewardTables.find((candidate) => candidate.id === id && !candidate.retired);
    if (!table) issues.push({ path: `rewardTableIds.${index}`, message: "references an unavailable reward table" });
  });
  if (serverTablesPresent) catalog.bossTemplateIds.forEach((id, index) => {
    const template = catalog.bossTemplates.find((candidate) => candidate.id === id && !candidate.retired);
    if (!template) issues.push({ path: `bossTemplateIds.${index}`, message: "references an unavailable boss template" });
  });
  catalog.prefabs.forEach((prefab, prefabIndex) => {
    const prefabPath = `prefabs.${prefabIndex}`;
    duplicateIssues(prefab.stateAssets, `${prefabPath}.stateAssets`, (state) => state.stateId, issues);
    duplicateIssues(prefab.defaultColliders, `${prefabPath}.defaultColliders`, (shape) => shape.id, issues);
    prefab.defaultColliders.forEach((collider, colliderIndex) => {
      if (!geometryInBounds(collider, prefab.defaultWidth, prefab.defaultHeight)) {
        issues.push({ path: `${prefabPath}.defaultColliders.${colliderIndex}`, message: "is outside prefab bounds" });
      }
      polygonGeometryIssues(collider, `${prefabPath}.defaultColliders.${colliderIndex}`, issues);
    });
  });

  catalog.dungeons.forEach((dungeon, dungeonIndex) => {
    const dungeonPath = `dungeons.${dungeonIndex}`;
    duplicateIssues(dungeon.rooms, `${dungeonPath}.rooms`, (room) => room.id, issues);
    duplicateIssues(dungeon.portals, `${dungeonPath}.portals`, (portal) => portal.id, issues);
    duplicateIssues(dungeon.encounters, `${dungeonPath}.encounters`, (encounter) => encounter.id, issues);
    duplicateIssues(dungeon.triggers, `${dungeonPath}.triggers`, (trigger) => trigger.id, issues);
    duplicateIssues(dungeon.rewardTableIds, `${dungeonPath}.rewardTableIds`, (id) => id, issues);
    duplicateIssues(dungeon.bossTemplateIds, `${dungeonPath}.bossTemplateIds`, (id) => id, issues);
    const allMobs = dungeon.rooms.flatMap((room) => room.mobs);
    duplicateIssues(allMobs, `${dungeonPath}.mobs`, (mob) => mob.id, issues);
    const rooms = new Map(dungeon.rooms.map((room) => [room.id, room]));
    const portals = new Map(dungeon.portals.map((portal) => [portal.id, portal]));
    const encounters = new Map(dungeon.encounters.map((encounter) => [encounter.id, encounter]));
    const triggers = new Map(dungeon.triggers.map((trigger) => [trigger.id, trigger]));
    const resourceIds = new Set<string>();

    dungeon.rooms.forEach((room, roomIndex) => {
      const roomPath = `${dungeonPath}.rooms.${roomIndex}`;
      duplicateIssues(room.anchors, `${roomPath}.anchors`, (anchor) => anchor.id, issues);
      duplicateIssues(room.colliders, `${roomPath}.colliders`, (shape) => shape.id, issues);
      duplicateIssues(room.zones, `${roomPath}.zones`, (shape) => shape.id, issues);
      duplicateIssues(room.objects, `${roomPath}.objects`, (object) => object.id, issues);
      duplicateIssues(room.mobs, `${roomPath}.mobs`, (mob) => mob.id, issues);
      duplicateIssues(room.resourceSpawnZones ?? [], `${roomPath}.resourceSpawnZones`, (zone) => zone.id, issues);
      duplicateIssues(room.resourceNodes ?? [], `${roomPath}.resourceNodes`, (node) => node.id, issues);
      const placements = Object.values(room.layers).flat();
      duplicateIssues(placements, `${roomPath}.layers`, (placement) => placement.id, issues);
      if (room.retired) return;
      const anchors = new Set(room.anchors.map((anchor) => anchor.id));
      if (!anchors.has(room.spawnAnchorId) ||
        room.anchors.find((anchor) => anchor.id === room.spawnAnchorId)?.retired) {
        issues.push({ path: `${roomPath}.spawnAnchorId`, message: "references a missing anchor" });
      }
      room.anchors.forEach((anchor, anchorIndex) => {
        if (anchor.retired) return;
        if (!pointInRoom(anchor, room)) {
          issues.push({ path: `${roomPath}.anchors.${anchorIndex}`, message: "is outside room bounds" });
        }
      });
      ([...room.colliders, ...room.zones, ...placements]).filter((shape) => !shape.retired).forEach((shape) => {
        if (!geometryInBounds(shape, room.width, room.height)) {
          issues.push({ path: `${roomPath}.${shape.id}`, message: "geometry is outside room bounds" });
        }
        polygonGeometryIssues(shape, `${roomPath}.${shape.id}`, issues);
      });
      placements.forEach((placement) => {
        if (placement.retired) return;
        const prefab = prefabs.get(placement.prefabId);
        if (!prefab || prefab.retired) {
          issues.push({ path: `${roomPath}.layers.${placement.id}.prefabId`, message: "references a missing prefab" });
        } else if (placement.prefabRevision !== prefab.revision) {
          issues.push({ path: `${roomPath}.layers.${placement.id}.prefabRevision`, message: "does not match the current prefab revision" });
        } else if (prefab.type !== "surface" && prefab.type !== "decoration") {
          issues.push({ path: `${roomPath}.layers.${placement.id}.prefabId`, message: "layer placements require a surface or decoration prefab" });
        }
      });
      room.objects.forEach((object, objectIndex) => {
        if (object.retired) return;
        const objectPath = `${roomPath}.objects.${objectIndex}`;
        if (object.rewardTableId && !dungeon.rewardTableIds.includes(object.rewardTableId)) {
          issues.push({ path: `${objectPath}.rewardTableId`, message: "references an unavailable dungeon reward table" });
        }
        if (!anchors.has(object.anchorId) ||
          room.anchors.find((anchor) => anchor.id === object.anchorId)?.retired) {
          issues.push({ path: `${objectPath}.anchorId`, message: "references a missing anchor" });
        }
        const prefab = prefabs.get(object.prefabId);
        if (!prefab || prefab.retired) {
          issues.push({ path: `${objectPath}.prefabId`, message: "references a missing prefab" });
        } else if (object.prefabRevision !== prefab.revision) {
          issues.push({ path: `${objectPath}.prefabRevision`, message: "does not match the current prefab revision" });
        } else if (object.type === "portal" && prefab.type !== "portal") {
          issues.push({ path: `${objectPath}.prefabId`, message: "portal objects require a portal prefab" });
        } else if (object.type !== "portal" && prefab.type !== "object") {
          issues.push({ path: `${objectPath}.prefabId`, message: "non-portal objects require an object prefab" });
        }
        if (object.type === "portal") {
          const portal = object.portalId ? portals.get(object.portalId) : undefined;
          if (!portal || portal.retired) {
            issues.push({ path: `${objectPath}.portalId`, message: "references a missing portal" });
          } else if (portal.source.kind !== "room" || portal.source.roomId !== room.id ||
            portal.source.anchorId !== object.anchorId) {
            issues.push({ path: `${objectPath}.portalId`, message: "must reference a portal sourced from the same room and anchor" });
          }
        }
        if (object.type !== "portal" && object.portalId) {
          issues.push({ path: `${objectPath}.portalId`, message: "is only allowed for portal objects" });
        }
      });
      (room.resourceSpawnZones ?? []).forEach((zone, zoneIndex) => {
        const zonePath = `${roomPath}.resourceSpawnZones.${zoneIndex}`;
        if (zone.minCount > zone.maxCount) {
          issues.push({ path: `${zonePath}.minCount`, message: "must not exceed maxCount" });
        }
        if (zone.minYield !== undefined && zone.maxYield !== undefined && zone.minYield > zone.maxYield) {
          issues.push({ path: `${zonePath}.minYield`, message: "must not exceed maxYield" });
        }
        if (!geometryInBounds(zone.shape, room.width, room.height)) {
          issues.push({ path: `${zonePath}.shape`, message: "geometry is outside room bounds" });
        }
        polygonGeometryIssues(zone.shape, `${zonePath}.shape`, issues);
        if (zone.prefabId) {
          const prefab = prefabs.get(zone.prefabId);
          if (!prefab || prefab.retired || prefab.type !== "object") {
            issues.push({ path: `${zonePath}.prefabId`, message: "references a missing object prefab" });
          }
        }
      });
      (room.resourceNodes ?? []).forEach((node, nodeIndex) => {
        const nodePath = `${roomPath}.resourceNodes.${nodeIndex}`;
        if (resourceIds.has(node.id)) {
          issues.push({ path: `${nodePath}.id`, message: "resource node ID must be unique across the dungeon" });
        }
        resourceIds.add(node.id);
        if (node.minYield > node.maxYield) {
          issues.push({ path: `${nodePath}.minYield`, message: "must not exceed maxYield" });
        }
        if (!room.anchors.some((anchor) => anchor.id === node.anchorId && !anchor.retired)) {
          issues.push({ path: `${nodePath}.anchorId`, message: "references a missing anchor" });
        }
        if (node.prefabId) {
          const prefab = prefabs.get(node.prefabId);
          if (!prefab || prefab.retired || prefab.type !== "object") {
            issues.push({ path: `${nodePath}.prefabId`, message: "references a missing object prefab" });
          } else if (node.prefabRevision && node.prefabRevision !== prefab.revision) {
            issues.push({ path: `${nodePath}.prefabRevision`, message: "does not match the current prefab revision" });
          }
        }
      });
      room.mobs.forEach((mob, mobIndex) => {
        if (mob.retired) return;
        const mobPath = `${roomPath}.mobs.${mobIndex}`;
        if (mob.summonedByMobSpawnId) {
          const summoner = room.mobs.find((candidate) => candidate.id === mob.summonedByMobSpawnId && !candidate.retired);
          if (!summoner || summoner.id === mob.id || summoner.summonedByMobSpawnId ||
              summoner.encounterId !== mob.encounterId || summoner.waveIndex !== mob.waveIndex || mob.summonAtHealthPercent === undefined) {
            issues.push({ path: `${mobPath}.summonedByMobSpawnId`, message: "adds require a non-summoned leader in the same encounter wave and a health threshold" });
          }
        } else if (mob.summonAtHealthPercent !== undefined) {
          issues.push({ path: `${mobPath}.summonAtHealthPercent`, message: "requires a summoning leader" });
        }
        if (mob.randomSpawnZoneId && !room.zones.some((zone) => zone.id === mob.randomSpawnZoneId && !zone.retired)) {
          issues.push({ path: `${mobPath}.randomSpawnZoneId`, message: "references a missing spawnable zone" });
        }
        if (!room.anchors.some((anchor) => anchor.id === mob.anchorId && !anchor.retired)) {
          issues.push({ path: `${mobPath}.anchorId`, message: "references a missing anchor" });
        }
        if (!encounters.has(mob.encounterId) || encounters.get(mob.encounterId)?.retired) {
          issues.push({ path: `${mobPath}.encounterId`, message: "references a missing encounter" });
        }
        if (mob.leashZoneId) {
          const zone = room.zones.find((candidate) => candidate.id === mob.leashZoneId && !candidate.retired);
          if (!zone || zone.purpose !== "leash") {
            issues.push({ path: `${mobPath}.leashZoneId`, message: "references a missing leash zone" });
          }
        }
      });
      if (!pointInRoom(room.camera.center, room)) {
        issues.push({ path: `${roomPath}.camera.center`, message: "is outside room bounds" });
      }
      if (!(room.camera.minZoom <= room.camera.defaultZoom &&
        room.camera.defaultZoom <= room.camera.maxZoom)) {
        issues.push({ path: `${roomPath}.camera`, message: "zoom must satisfy minZoom <= defaultZoom <= maxZoom" });
      }
      if (room.camera.center.x !== room.width / 2 || room.camera.center.y !== room.height / 2) {
        issues.push({ path: `${roomPath}.camera.center`, message: "must equal the exact room midpoint" });
      }
      if (room.active) {
        const navigation = catalogRoomNavigation(room);
        const spawn = room.anchors.find((anchor) => anchor.id === room.spawnAnchorId && !anchor.retired);
        if (spawn && !isIndoorNavigationPointWalkable(navigation, spawn)) {
          issues.push({ path: `${roomPath}.spawnAnchorId`, message: "spawn anchor is not walkable" });
        }
        room.mobs.filter((mob) => !mob.retired).forEach((mob, mobIndex) => {
          const anchor = room.anchors.find((candidate) => candidate.id === mob.anchorId && !candidate.retired);
          if (anchor && !isIndoorNavigationPointWalkable(navigation, anchor)) {
            issues.push({ path: `${roomPath}.mobs.${mobIndex}.anchorId`, message: "mob anchor is not walkable" });
          }
        });
      }
    });

    const spawnGroups = new Map<string, Array<{ path: string; min: number; max: number; chance: boolean }>>();
    dungeon.rooms.forEach((room, roomIndex) => {
      if (room.retired) return;
      room.objects.forEach((object, objectIndex) => {
        if (object.retired || !object.spawnGroup) return;
        const members = spawnGroups.get(object.spawnGroup.id) ?? [];
        members.push({ path: `${dungeonPath}.rooms.${roomIndex}.objects.${objectIndex}.spawnGroup`,
          min: object.spawnGroup.min, max: object.spawnGroup.max, chance: object.spawnChance !== undefined });
        spawnGroups.set(object.spawnGroup.id, members);
        if (object.type === "portal") {
          issues.push({ path: `${dungeonPath}.rooms.${roomIndex}.objects.${objectIndex}.spawnGroup`, message: "portals cannot be randomly spawned" });
        }
      });
    });
    spawnGroups.forEach((members) => {
      members.forEach((member) => {
        if (member.min > member.max || member.max > members.length) {
          issues.push({ path: member.path, message: "min must not exceed max, and max must not exceed the group's object count" });
        }
        if (member.min !== members[0]!.min || member.max !== members[0]!.max) {
          issues.push({ path: member.path, message: "every object in a spawn group must repeat the same min and max" });
        }
        if (member.chance) issues.push({ path: member.path, message: "spawn groups replace spawnChance" });
      });
    });

    dungeon.rewardTableIds.forEach((id, index) => {
      if (!catalog.rewardTableIds.includes(id)) {
        issues.push({ path: `${dungeonPath}.rewardTableIds.${index}`, message: "references an unavailable reward table" });
      }
    });
    dungeon.bossTemplateIds.forEach((id, index) => {
      if (!catalog.bossTemplateIds.includes(id)) {
        issues.push({ path: `${dungeonPath}.bossTemplateIds.${index}`, message: "references an unavailable boss template" });
      }
    });

    const mobLocations = new Map(dungeon.rooms.flatMap((room) =>
      room.mobs.map((mob) => [mob.id, { mob, room }] as const)
    ));
    dungeon.encounters.forEach((encounter, encounterIndex) => {
      if (encounter.retired) return;
      const encounterPath = `${dungeonPath}.encounters.${encounterIndex}`;
      const room = rooms.get(encounter.roomId);
      if (!room || room.retired || !room.active) {
        issues.push({ path: `${encounterPath}.roomId`, message: "references a missing active room" });
        return;
      }
      if (encounter.roll) {
        encounterRollIssues(dungeon, encounter, encounter.roll, room, `${encounterPath}.roll`, issues);
      } else if (encounter.waves.length === 0) {
        issues.push({ path: `${encounterPath}.waves`, message: "needs at least one wave unless the encounter rolls its mobs" });
      }
      if (encounter.bossTemplateId) {
        room.mobs.forEach((mob) => {
          if (!mob.retired && mob.encounterId === encounter.id && mob.partySet !== undefined) {
            issues.push({ path: `${encounterPath}.bossTemplateId`, message: `boss encounters stay fixed; placement ${mob.id} cannot carry a torch set` });
          }
        });
        const bossPlacements = room.mobs.filter((mob) =>
          !mob.retired && mob.encounterId === encounter.id && !mob.summonedByMobSpawnId
        );
        if (bossPlacements.length !== 1) {
          issues.push({
            path: `${encounterPath}.bossTemplateId`,
            message: "requires exactly one non-summoned mob placement in its encounter (the boss). Move trash waves into a separate encounter and chain it: when that encounter completes, start the boss encounter."
          });
        }
      }
      const boundary = room.zones.find((zone) => zone.id === encounter.boundaryZoneId && !zone.retired);
      if (!boundary || boundary.purpose !== "encounter_boundary") {
        issues.push({ path: `${encounterPath}.boundaryZoneId`, message: "references a missing encounter boundary zone" });
      }
      const leash = room.zones.find((zone) => zone.id === encounter.leashZoneId && !zone.retired);
      if (!leash || leash.purpose !== "leash") {
        issues.push({ path: `${encounterPath}.leashZoneId`, message: "references a missing leash zone" });
      }
      duplicateIssues(encounter.waves, `${encounterPath}.waves`, (wave) => wave.id, issues);
      duplicateIssues(encounter.lockPortalIds, `${encounterPath}.lockPortalIds`, (id) => id, issues);
      const referencedMobs = new Set<string>();
      const navigation = catalogRoomNavigation(room);
      encounter.waves.forEach((wave, waveIndex) => {
        duplicateIssues(wave.mobSpawnIds, `${encounterPath}.waves.${waveIndex}.mobSpawnIds`, (id) => id, issues);
        wave.mobSpawnIds.forEach((mobId, mobIndex) => {
          const location = mobLocations.get(mobId);
          if (!location || location.mob.retired || location.room.id !== room.id ||
            location.mob.encounterId !== encounter.id || location.mob.waveIndex !== waveIndex + 1) {
            issues.push({
              path: `${encounterPath}.waves.${waveIndex}.mobSpawnIds.${mobIndex}`,
              message: "references a missing mob placement for this room, encounter, and wave"
            });
          }
          if (referencedMobs.has(mobId)) {
            issues.push({ path: `${encounterPath}.waves.${waveIndex}.mobSpawnIds.${mobIndex}`, message: "mob placement is referenced by multiple waves" });
          }
          referencedMobs.add(mobId);
        });
        const placements = wave.mobSpawnIds.map((mobId, mobIndex) => ({
          mobId,
          mobIndex,
          location: mobLocations.get(mobId)
        })).filter((entry) => entry.location && !entry.location.mob.retired &&
          entry.location.room.id === room.id && entry.location.mob.encounterId === encounter.id &&
          entry.location.mob.waveIndex === waveIndex + 1);
        for (const placement of placements) {
          const mob = placement.location!.mob;
          if (mob.randomSpawnZoneId) continue;
          const grouped = placements.filter((candidate) =>
            candidate.location!.mob.spawnGroupId === mob.spawnGroupId
          );
          const formationIndex = grouped.findIndex((candidate) => candidate.mobId === mob.id);
          const anchor = room.anchors.find((candidate) => candidate.id === mob.anchorId && !candidate.retired);
          if (!anchor || formationIndex < 0) continue;
          const offset = dungeonFormationOffset(
            encounter.groupControls?.formation ?? "scatter",
            formationIndex,
            grouped.length
          );
          const point = {
            x: Math.max(0, Math.min(room.width, anchor.x + offset.x)),
            y: Math.max(0, Math.min(room.height, anchor.y + offset.y))
          };
          if (!isIndoorNavigationPointWalkable(navigation, point)) {
            issues.push({
              path: `${encounterPath}.waves.${waveIndex}.mobSpawnIds.${placement.mobIndex}`,
              message: "formation-adjusted spawn position is not walkable"
            });
          }
        }
      });
      room.mobs.filter((mob) => !mob.retired && mob.encounterId === encounter.id).forEach((mob) => {
        if (!referencedMobs.has(mob.id)) {
          issues.push({ path: `${encounterPath}.waves`, message: `does not reference mob placement ${mob.id}` });
        }
      });
      encounter.lockPortalIds.forEach((portalId, index) => {
        if (portals.get(portalId)?.retired !== false) {
          issues.push({ path: `${encounterPath}.lockPortalIds.${index}`, message: "references a missing portal" });
        }
      });
      if (encounter.rewardTableId && !dungeon.rewardTableIds.includes(encounter.rewardTableId)) {
        issues.push({ path: `${encounterPath}.rewardTableId`, message: "references an unavailable dungeon reward table" });
      }
      if (encounter.bossTemplateId && !dungeon.bossTemplateIds.includes(encounter.bossTemplateId)) {
        issues.push({ path: `${encounterPath}.bossTemplateId`, message: "references an unavailable dungeon boss template" });
      }
    });

    dungeon.runRolls?.flags.forEach((flag, flagIndex) => {
      const flagPath = `${dungeonPath}.runRolls.flags.${flagIndex}`;
      if (dungeon.runRolls!.flags.findIndex((candidate) => candidate.flagId === flag.flagId) !== flagIndex) {
        issues.push({ path: `${flagPath}.flagId`, message: `duplicate run flag ${flag.flagId}` });
      }
      if (triggers.has(dungeonRunFlagTriggerId(flag.flagId))) {
        issues.push({ path: `${flagPath}.flagId`, message: `collides with authored trigger ${dungeonRunFlagTriggerId(flag.flagId)}` });
      }
    });

    dungeon.triggers.forEach((trigger, triggerIndex) => {
      if (trigger.retired) return;
      validateTriggerReferences(
        trigger, `${dungeonPath}.triggers.${triggerIndex}`, dungeon,
        rooms, portals, encounters, triggers, issues
      );
    });
    triggerCycleIssues(dungeon, dungeonPath, issues);

    dungeon.portals.forEach((portal, portalIndex) => {
      const portalPath = `${dungeonPath}.portals.${portalIndex}`;
      if (new Set(portal.conditions).size !== portal.conditions.length) {
        issues.push({ path: `${portalPath}.conditions`, message: "conditions must be unique" });
      }
      if (portal.retired) return;
      for (const [gateIndex, gate] of (portal.gates ?? []).entries()) {
        if (gate.type === "item_owned" && gate.quantity < 1) {
          issues.push({ path: `${portalPath}.gates.${gateIndex}.quantity`, message: "must be positive" });
        }
      }
      checkEndpoint(portal.source, `${portalPath}.source`, rooms, issues, portal.enabled);
      checkEndpoint(portal.destination, `${portalPath}.destination`, rooms, issues, portal.enabled);
      if (portal.source.kind === "room") {
        checkAnchor(portal.source.roomId, portal.sourceApproachAnchorId, `${portalPath}.sourceApproachAnchorId`, rooms, issues);
        checkAnchor(portal.source.roomId, portal.sourceThresholdAnchorId, `${portalPath}.sourceThresholdAnchorId`, rooms, issues);
      }
      if (portal.destination.kind === "room") {
        checkAnchor(portal.destination.roomId, portal.destinationArrivalAnchorId, `${portalPath}.destinationArrivalAnchorId`, rooms, issues);
      }
      if (portal.enabled) validatePortalRoomReachability(portal, portalPath, rooms, issues);
      if (portal.reciprocalPortalId) {
        const reciprocal = portals.get(portal.reciprocalPortalId);
        if (!reciprocal || reciprocal.retired) {
          issues.push({ path: `${portalPath}.reciprocalPortalId`, message: "references a missing portal" });
        } else if (reciprocal.reciprocalPortalId !== portal.id ||
          !sameEndpoint(portal.source, reciprocal.destination) ||
          !sameEndpoint(portal.destination, reciprocal.source)) {
          issues.push({ path: `${portalPath}.reciprocalPortalId`, message: "does not define a reciprocal edge" });
        }
      }
      if (portal.enabled && portal.source.kind === "room") {
        const sourceRoom = rooms.get(portal.source.roomId);
        const triggerCount = sourceRoom?.objects.filter((object) =>
          !object.retired && object.type === "portal" && object.portalId === portal.id
        ).length ?? 0;
        if (triggerCount !== 1) {
          issues.push({
            path: `${portalPath}.id`,
            message: "enabled room-source portals require exactly one non-retired source-room portal object"
          });
        } else if (!sourceRoom!.objects.find((object) =>
          !object.retired && object.type === "portal" && object.portalId === portal.id
        )!.available) {
          issues.push({
            path: `${portalPath}.id`,
            message: "enabled room-source portals require an available source-room portal object"
          });
        }
      }
    });

    if (!dungeon.retired) {
      checkAnchor(dungeon.entrance.roomId, dungeon.entrance.arrivalAnchorId,
        `${dungeonPath}.entrance.arrivalAnchorId`, rooms, issues, true);
      checkAnchor(dungeon.deathRecovery.roomId, dungeon.deathRecovery.anchorId,
        `${dungeonPath}.deathRecovery.anchorId`, rooms, issues, true);
      const entrancePortal = portals.get(dungeon.entrance.portalId);
      if (!entrancePortal || entrancePortal.retired) {
        issues.push({ path: `${dungeonPath}.entrance.portalId`, message: "references a missing portal" });
      } else if (entrancePortal.source.kind !== "world" ||
        entrancePortal.destination.kind !== "room" ||
        entrancePortal.destination.roomId !== dungeon.entrance.roomId ||
        entrancePortal.destinationArrivalAnchorId !== dungeon.entrance.arrivalAnchorId) {
        issues.push({
          path: `${dungeonPath}.entrance.portalId`,
          message: "must enter from world into the configured entrance room and arrival anchor"
        });
      }
      const escapePortal = portals.get(dungeon.escape.portalId);
      if (!escapePortal || escapePortal.retired) {
        issues.push({ path: `${dungeonPath}.escape.portalId`, message: "references a missing portal" });
      } else if (!escapePortal.enabled || escapePortal.source.kind !== "room" ||
        rooms.get(escapePortal.source.roomId)?.active !== true ||
        rooms.get(escapePortal.source.roomId)?.retired === true ||
        escapePortal.destination.kind !== "world") {
        issues.push({
          path: `${dungeonPath}.escape.portalId`,
          message: "must be an enabled portal from an active room to world"
        });
      }
      checkRoomGraph(dungeon, issues, dungeonPath);
    }
  });
  return issues;
}

function checkRoomGraph(
  dungeon: DungeonDefinition,
  issues: DungeonCatalogValidationIssue[],
  dungeonPath: string
): void {
  const activeRooms = new Set(
    dungeon.rooms.filter((room) => room.active && !room.retired).map((room) => room.id)
  );
  const graph = new Map<string, string[]>();
  for (const roomId of activeRooms) graph.set(roomId, []);
  for (const portal of dungeon.portals) {
    if (portal.retired || !portal.enabled || portal.source.kind !== "room" || portal.destination.kind !== "room") continue;
    if (!hasAvailablePortalTrigger(dungeon, portal)) continue;
    if (activeRooms.has(portal.destination.roomId)) {
      graph.get(portal.source.roomId)?.push(portal.destination.roomId);
    }
  }
  const reachable = traverseRooms(dungeon.entrance.roomId, graph);
  for (const roomId of activeRooms) {
    if (!reachable.has(roomId)) {
      issues.push({ path: `${dungeonPath}.rooms.${roomId}`, message: "active room is unreachable from the entrance" });
    }
    if (!hasWorldRecovery(roomId, dungeon, activeRooms, new Set())) {
      issues.push({ path: `${dungeonPath}.rooms.${roomId}`, message: "active room has no recovery path to world" });
    }
  }
}

function validateTriggerReferences(
  trigger: DungeonTriggerDefinition,
  path: string,
  dungeon: DungeonDefinition,
  rooms: Map<string, DungeonRoomDefinition>,
  portals: Map<string, DungeonPortalDefinition>,
  encounters: Map<string, DungeonEncounterDefinition>,
  triggers: Map<string, DungeonTriggerDefinition>,
  issues: DungeonCatalogValidationIssue[]
): void {
  if (trigger.repetition === "cooldown" && trigger.cooldownMs <= 0) {
    issues.push({ path: `${path}.cooldownMs`, message: "cooldown repetition requires a positive cooldown" });
  }
  const room = (roomId: string, refPath: string) => {
    const found = rooms.get(roomId);
    if (!found || found.retired || !found.active) {
      issues.push({ path: refPath, message: "references a missing active room" });
      return undefined;
    }
    return found;
  };
  const zone = (roomId: string, zoneId: string, refPath: string) => {
    const found = room(roomId, refPath)?.zones.find((candidate) =>
      candidate.id === zoneId && !candidate.retired
    );
    if (!found) issues.push({ path: refPath, message: "references a missing zone" });
  };
  const object = (roomId: string, objectId: string, refPath: string) => {
    const found = room(roomId, refPath)?.objects.find((candidate) =>
      candidate.id === objectId && !candidate.retired
    );
    if (!found) issues.push({ path: refPath, message: "references a missing object" });
  };
  const encounter = (encounterId: string, refPath: string) => {
    if (encounters.get(encounterId)?.retired !== false) {
      issues.push({ path: refPath, message: "references a missing encounter" });
    }
  };
  const event = trigger.event;
  if (event.type === "room_enter" || event.type === "room_exit" || event.type === "room_clear") {
    room(event.roomId, `${path}.event.roomId`);
  } else if (event.type === "zone_enter" || event.type === "zone_exit" || event.type === "all_players_present") {
    zone(event.roomId, event.zoneId, `${path}.event.zoneId`);
  } else if (event.type === "object_interact" || event.type === "object_state" || event.type === "object_destroyed") {
    object(event.roomId, event.objectId, `${path}.event.objectId`);
  } else if (event.type === "object_sequence") {
    duplicateIssues(event.objectIds, `${path}.event.objectIds`, (id) => id, issues);
    event.objectIds.forEach((objectId, index) => object(event.roomId, objectId, `${path}.event.objectIds.${index}`));
  } else if (event.type === "portal_used") {
    if (portals.get(event.portalId)?.retired !== false) {
      issues.push({ path: `${path}.event.portalId`, message: "references a missing portal" });
    }
  } else if (event.type === "encounter_state") {
    encounter(event.encounterId, `${path}.event.encounterId`);
  }
  trigger.conditions.items.forEach((condition, index) => {
    const conditionPath = `${path}.conditions.items.${index}`;
    if (condition.type === "encounter_state") encounter(condition.encounterId, `${conditionPath}.encounterId`);
    if (condition.type === "object_state") object(condition.roomId, condition.objectId, `${conditionPath}.objectId`);
  });
  trigger.actions.forEach((action, index) => {
    const actionPath = `${path}.actions.${index}`;
    if (action.type === "start_encounter") {
      encounter(action.encounterId, `${actionPath}.encounterId`);
    } else if (action.type === "start_wave") {
      const definition = encounters.get(action.encounterId);
      if (!definition || definition.retired || !definition.waves.some((wave) => wave.id === action.waveId)) {
        issues.push({ path: `${actionPath}.waveId`, message: "references a missing encounter wave" });
      }
    } else if (action.type === "set_object_state" || action.type === "set_object_available") {
      object(action.roomId, action.objectId, `${actionPath}.objectId`);
    } else if (action.type === "set_portal_locked") {
      if (portals.get(action.portalId)?.retired !== false) {
        issues.push({ path: `${actionPath}.portalId`, message: "references a missing portal" });
      }
    } else if (action.type === "enable_trigger") {
      if (triggers.get(action.triggerId)?.retired !== false) {
        issues.push({ path: `${actionPath}.triggerId`, message: "references a missing trigger" });
      }
    } else if (action.type === "grant_reward") {
      if (!dungeon.rewardTableIds.includes(action.rewardTableId)) {
        issues.push({ path: `${actionPath}.rewardTableId`, message: "references an unavailable dungeon reward table" });
      }
      if (trigger.scope === "instance" && !instanceRewardEventProvidesPlayer(event.type)) {
        issues.push({ path: actionPath, message: "instance-scoped reward trigger cannot resolve a player identity" });
      }
    } else if (action.type === "grant_run_reward") {
      if (!dungeon.rewardTableIds.includes(action.rewardTableId)) {
        issues.push({ path: `${actionPath}.rewardTableId`, message: "references an unavailable dungeon reward table" });
      }
      if (event.type !== "encounter_state" && event.type !== "room_clear" && event.type !== "dungeon_flag") {
        issues.push({ path: actionPath, message: "run rewards fire only on encounter_state, room_clear or dungeon_flag events" });
      } else if (action.recipients === "room_present" && event.type === "dungeon_flag") {
        issues.push({ path: `${actionPath}.recipients`, message: "a dungeon_flag event has no room; pay everyone present" });
      }
      if (trigger.scope !== "instance") {
        issues.push({ path: `${path}.scope`, message: "run rewards pay every member once, so the trigger must be instance-scoped" });
      }
      if (trigger.repetition !== "once") {
        issues.push({ path: `${path}.repetition`, message: "run rewards fire once per run" });
      }
    }
    if (event.type === "encounter_state" &&
      (action.type === "start_encounter" || action.type === "start_wave") &&
      action.encounterId === event.encounterId) {
      issues.push({ path: actionPath, message: "creates an encounter-state restart cycle" });
    }
  });
}

/** Trigger the run materializer emits for a run flag rolled true. */
export function dungeonRunFlagTriggerId(flagId: string): string {
  return `run_flag_${flagId}`;
}

function encounterRollIssues(
  dungeon: DungeonDefinition,
  encounter: DungeonEncounterDefinition,
  roll: NonNullable<DungeonEncounterDefinition["roll"]>,
  room: DungeonRoomDefinition,
  path: string,
  issues: DungeonCatalogValidationIssue[]
): void {
  if (encounter.bossTemplateId) {
    issues.push({ path, message: "boss encounters stay fixed; roll a separate trash encounter and chain it to the boss" });
  }
  if (encounter.waves.length > 0) {
    issues.push({ path: path.replace(/\.roll$/u, ".waves"), message: "rolled encounters generate their own waves; leave waves empty" });
  }
  const navigation = catalogRoomNavigation(room);
  if ("zoneIds" in roll.spawn) {
    roll.spawn.zoneIds.forEach((zoneId, index) => {
      const zone = room.zones.find((candidate) => candidate.id === zoneId && !candidate.retired);
      if (!zone) {
        issues.push({ path: `${path}.spawn.zoneIds.${index}`, message: "references a missing zone in the encounter room" });
      } else if (!findWalkableDungeonPointInShape(zone, navigation, `validate:${encounter.id}:${zoneId}`)) {
        issues.push({ path: `${path}.spawn.zoneIds.${index}`, message: "spawn zone has no walkable point" });
      }
    });
  } else {
    roll.spawn.anchorIds.forEach((anchorId, index) => {
      const anchor = room.anchors.find((candidate) => candidate.id === anchorId && !candidate.retired);
      if (!anchor) {
        issues.push({ path: `${path}.spawn.anchorIds.${index}`, message: "references a missing anchor in the encounter room" });
      } else if (!isIndoorNavigationPointWalkable(navigation, anchor)) {
        issues.push({ path: `${path}.spawn.anchorIds.${index}`, message: "spawn anchor is not walkable" });
      }
    });
  }
  const level = dungeonTierLevel(dungeon);
  roll.elite?.modifierPool?.forEach((modifier, index) => {
    if (!dungeonEliteModifierAllowed(modifier, level)) {
      issues.push({ path: `${path}.elite.modifierPool.${index}`, message: `${modifier} needs dungeon level 20 or higher (stat-only elites below 20)` });
    }
  });
}

function instanceRewardEventProvidesPlayer(
  eventType: DungeonTriggerDefinition["event"]["type"]
): boolean {
  return eventType !== "timer" && eventType !== "encounter_state" &&
    eventType !== "room_clear" && eventType !== "dungeon_flag" &&
    eventType !== "object_state";
}

function triggerCycleIssues(
  dungeon: DungeonDefinition,
  dungeonPath: string,
  issues: DungeonCatalogValidationIssue[]
): void {
  const graph = new Map<string, string[]>();
  dungeon.triggers.filter((trigger) => !trigger.retired).forEach((trigger) => {
    graph.set(trigger.id, trigger.actions
      .filter((action): action is Extract<typeof action, { type: "enable_trigger" }> =>
        action.type === "enable_trigger" && action.enabled
      )
      .map((action) => action.triggerId));
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (graph.get(id) ?? []).some((next) => graph.has(next) && visit(next));
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  for (const id of graph.keys()) {
    if (visit(id)) {
      issues.push({ path: `${dungeonPath}.triggers.${id}`, message: "trigger enable graph contains a cycle" });
      break;
    }
  }
  const encounterGraph = new Map<string, string[]>();
  dungeon.encounters.filter((encounter) => !encounter.retired).forEach((encounter) => {
    encounterGraph.set(encounter.id, []);
  });
  dungeon.triggers.filter((trigger) => !trigger.retired &&
    trigger.event.type === "encounter_state").forEach((trigger) => {
    if (trigger.event.type !== "encounter_state") return;
    const destinations = trigger.actions.flatMap((action) =>
      action.type === "start_encounter" || action.type === "start_wave" ? [action.encounterId] : []
    );
    encounterGraph.get(trigger.event.encounterId)?.push(...destinations);
  });
  visiting.clear();
  visited.clear();
  const visitEncounter = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (encounterGraph.get(id) ?? []).some((next) =>
      encounterGraph.has(next) && visitEncounter(next)
    );
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  for (const id of encounterGraph.keys()) {
    if (visitEncounter(id)) {
      issues.push({ path: `${dungeonPath}.triggers`, message: "encounter trigger graph contains a cycle" });
      break;
    }
  }
}

function hasWorldRecovery(
  roomId: string,
  dungeon: DungeonDefinition,
  activeRooms: ReadonlySet<string>,
  visited: Set<string>
): boolean {
  if (visited.has(roomId)) return false;
  visited.add(roomId);
  return dungeon.portals.some((portal) =>
    !portal.retired && portal.enabled && portal.source.kind === "room" &&
    hasAvailablePortalTrigger(dungeon, portal) &&
    portal.source.roomId === roomId && (portal.destination.kind === "world" ||
      (activeRooms.has(portal.destination.roomId) &&
        hasWorldRecovery(portal.destination.roomId, dungeon, activeRooms, new Set(visited)))));
}

function hasAvailablePortalTrigger(
  dungeon: DungeonDefinition,
  portal: DungeonPortalDefinition
): boolean {
  if (portal.source.kind !== "room") return true;
  const sourceRoomId = portal.source.roomId;
  const room = dungeon.rooms.find((candidate) => candidate.id === sourceRoomId);
  return room?.objects.some((object) =>
    !object.retired && object.available && object.type === "portal" && object.portalId === portal.id
  ) === true;
}

function traverseRooms(start: string, graph: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const room = pending.pop()!;
    if (visited.has(room)) continue;
    visited.add(room);
    pending.push(...(graph.get(room) ?? []));
  }
  return visited;
}

function checkEndpoint(
  endpoint: DungeonPortalDefinition["source"],
  path: string,
  rooms: Map<string, DungeonRoomDefinition>,
  issues: DungeonCatalogValidationIssue[],
  requireActive = false
): void {
  if (endpoint.kind === "room") {
    checkAnchor(endpoint.roomId, endpoint.anchorId, path, rooms, issues, requireActive);
  }
}

function checkAnchor(
  roomId: string,
  anchorId: string | undefined,
  path: string,
  rooms: Map<string, DungeonRoomDefinition>,
  issues: DungeonCatalogValidationIssue[],
  requireActive = false
): void {
  const room = rooms.get(roomId);
  if (!room || room.retired) {
    issues.push({ path, message: `references missing room ${roomId}` });
  } else if (requireActive && !room.active) {
    issues.push({ path, message: `references inactive room ${roomId}` });
  } else if (!anchorId || !room.anchors.some((anchor) => anchor.id === anchorId && !anchor.retired)) {
    issues.push({ path, message: "references a missing anchor" });
  }
}

function sameEndpoint(
  left: DungeonPortalDefinition["source"],
  right: DungeonPortalDefinition["source"]
): boolean {
  return left.kind === right.kind && (left.kind === "world" ||
    (right.kind === "room" && left.roomId === right.roomId && left.anchorId === right.anchorId));
}

function pointInRoom(point: { x: number; y: number }, room: DungeonRoomDefinition): boolean {
  return point.x >= 0 && point.x <= room.width && point.y >= 0 && point.y <= room.height;
}

/** Walkability view of a catalog room (the one the validator checks spawns against). */
export function dungeonCatalogRoomNavigation(room: DungeonRoomDefinition): IndoorRoomNavigation {
  return catalogRoomNavigation(room);
}

/** First walkable point of a seeded sequence inside the shape, or null after `attempts` tries. */
export function findWalkableDungeonPointInShape(
  shape: DungeonResourceSpawnZoneDefinition["shape"],
  navigation: IndoorRoomNavigation,
  seed: string,
  attempts = 64
): { x: number; y: number } | null {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const point = randomDungeonPointInShape(shape, `${seed}:${attempt}`);
    if (point && isIndoorNavigationPointWalkable(navigation, point)) return point;
  }
  return null;
}

function catalogRoomNavigation(room: DungeonRoomDefinition): IndoorRoomNavigation {
  return {
    roomWidth: room.width,
    roomHeight: room.height,
    playerRadius: STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius,
    colliders: room.colliders.filter((collider) => !collider.retired).map((collider) =>
      collider.kind === "polygon"
        ? { id: collider.id, kind: "polygon" as const, points: collider.points }
        : {
          id: collider.id,
          minX: collider.x,
          maxX: collider.x + collider.width,
          minY: collider.y,
          maxY: collider.y + collider.height
        }
    ),
    walkableSurfaces: (room.floors ?? []).filter((floor) => !floor.retired).map((floor) => floor.polygon)
  };
}

function validatePortalRoomReachability(
  portal: DungeonPortalDefinition,
  path: string,
  rooms: Map<string, DungeonRoomDefinition>,
  issues: DungeonCatalogValidationIssue[]
): void {
  const validate = (roomId: string, anchorId: string | undefined, anchorPath: string) => {
    const room = rooms.get(roomId);
    if (!room || room.retired || !room.active || !anchorId) return;
    const spawn = room.anchors.find((anchor) => anchor.id === room.spawnAnchorId && !anchor.retired);
    const anchor = room.anchors.find((candidate) => candidate.id === anchorId && !candidate.retired);
    if (!spawn || !anchor) return;
    if (!findIndoorNavigationRoute(catalogRoomNavigation(room), spawn, anchor)) {
      issues.push({ path: anchorPath, message: "anchor is not reachable from the room spawn" });
    }
  };
  if (portal.source.kind === "room") {
    validate(portal.source.roomId, portal.sourceApproachAnchorId, `${path}.sourceApproachAnchorId`);
  }
  if (portal.destination.kind === "room") {
    validate(portal.destination.roomId, portal.destinationArrivalAnchorId, `${path}.destinationArrivalAnchorId`);
  }
}

export function dungeonFormationOffset(
  formation: "scatter" | "line" | "wedge" | "circle",
  index: number,
  count: number
): { x: number; y: number } {
  if (count <= 1 || formation === "scatter") return { x: 0, y: 0 };
  const spacing = 36;
  const centered = index - (count - 1) / 2;
  if (formation === "line") return { x: centered * spacing, y: 0 };
  if (formation === "wedge") {
    const row = Math.floor((Math.sqrt(8 * index + 1) - 1) / 2);
    const firstInRow = row * (row + 1) / 2;
    return { x: (index - firstInRow - row / 2) * spacing, y: row * spacing };
  }
  const angle = (Math.PI * 2 * index) / count;
  const radius = spacing * Math.max(1, count) / Math.PI;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function geometryInBounds(
  geometry: { x: number; y: number; width: number; height: number } |
    { points: readonly { x: number; y: number }[] },
  width: number,
  height: number
): boolean {
  if ("points" in geometry) {
    return geometry.points.every((point) =>
      point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height
    );
  }
  return geometry.x >= 0 && geometry.y >= 0 &&
    geometry.x + geometry.width <= width && geometry.y + geometry.height <= height;
}

function polygonGeometryIssues(
  geometry: unknown,
  path: string,
  issues: DungeonCatalogValidationIssue[]
): void {
  if (!geometry || typeof geometry !== "object" || !("points" in geometry)) return;
  const points = (geometry as { points: readonly { x: number; y: number }[] }).points;
  if (Math.abs(polygonArea(points)) <= 1e-9) {
    issues.push({ path, message: "polygon must have non-zero area" });
    return;
  }
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    if (samePoint(points[first]!, points[firstNext]!)) {
      issues.push({ path, message: "polygon may not contain a zero-length edge" });
      return;
    }
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersectForValidation(
        points[first]!, points[firstNext]!, points[second]!, points[secondNext]!
      )) {
        issues.push({ path, message: "polygon must not self-intersect" });
        return;
      }
    }
  }
}

function polygonArea(points: readonly { x: number; y: number }[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

function segmentsIntersectForValidation(
  a: { x: number; y: number }, b: { x: number; y: number },
  c: { x: number; y: number }, d: { x: number; y: number }
): boolean {
  const cross = (first: typeof a, second: typeof a, third: typeof a) =>
    (second.x - first.x) * (third.y - first.y) -
    (second.y - first.y) * (third.x - first.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (Math.sign(abC) !== Math.sign(abD) && Math.sign(cdA) !== Math.sign(cdB) &&
    abC !== 0 && abD !== 0 && cdA !== 0 && cdB !== 0) return true;
  const onSegment = (point: typeof a, start: typeof a, end: typeof a) =>
    point.x >= Math.min(start.x, end.x) && point.x <= Math.max(start.x, end.x) &&
    point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y);
  return abC === 0 && onSegment(c, a, b) || abD === 0 && onSegment(d, a, b) ||
    cdA === 0 && onSegment(a, c, d) || cdB === 0 && onSegment(b, c, d);
}

function samePoint(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return left.x === right.x && left.y === right.y;
}

function duplicateIssues<T>(
  values: readonly T[],
  path: string,
  id: (value: T) => string,
  issues: DungeonCatalogValidationIssue[]
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const valueId = id(value);
    if (seen.has(valueId)) issues.push({ path: `${path}.${index}.id`, message: `duplicate ID ${valueId}` });
    seen.add(valueId);
  });
}

function formatIssues(issues: readonly DungeonCatalogValidationIssue[]): string {
  return `Invalid dungeon catalog: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export const DUNGEON_CATALOG = deepFreeze(validateDungeonCatalog(
  // Read-only view over packages/shared/src/data/interiors (the single source of truth).
  dungeonCatalogFromInterior(INTERIOR_DATA as unknown as InteriorCatalog)
));

export function dungeonDefinition(id: string): DungeonDefinition | undefined {
  return DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.id === id);
}

export function dungeonRoomDefinition(
  dungeonId: string,
  roomId: string
): DungeonRoomDefinition | undefined {
  return dungeonDefinition(dungeonId)?.rooms.find((room) => room.id === roomId);
}

export const CISTERN_WARRENS_DUNGEON = dungeonDefinition("cistern_warrens")!;

export function isCisternWarrensSpaceId(
  value: unknown,
  dungeon: DungeonDefinition = CISTERN_WARRENS_DUNGEON
): value is string {
  return typeof value === "string" && dungeon.rooms.some((room) =>
    room.id === value && room.active && !room.retired
  );
}

export function cisternWarrensRoomDefinition(
  spaceId: string,
  dungeon: DungeonDefinition = CISTERN_WARRENS_DUNGEON
): DungeonRoomDefinition {
  const room = dungeon.rooms.find((candidate) => candidate.id === spaceId);
  if (!room) throw new Error(`Unknown Cistern Warrens room: ${spaceId}`);
  return room;
}

export function dungeonAnchorDefinition(
  room: DungeonRoomDefinition,
  anchorId: string
): DungeonAnchorDefinition {
  const anchor = room.anchors.find((candidate) => candidate.id === anchorId);
  if (!anchor) throw new Error(`Unknown anchor ${anchorId} in room ${room.id}`);
  return anchor;
}

export function dungeonPortalDefinition(
  dungeon: DungeonDefinition,
  portalId: string
): DungeonPortalDefinition {
  const portal = dungeon.portals.find((candidate) => candidate.id === portalId);
  if (!portal) throw new Error(`Unknown portal ${portalId} in dungeon ${dungeon.id}`);
  return portal;
}

/** Prefix of derived developer entrance template IDs; authored IDs are colon-free so they never collide. */
export const DEVELOPER_DUNGEON_TEMPLATE_PREFIX = "dungeon:";

export type DeveloperDungeonEntranceTemplate = DungeonEntranceDefinition & Readonly<{
  /** True when derived from the dungeon itself because no active authored entrance exists. */
  synthetic: boolean;
}>;

function activeWorldPortal(dungeon: DungeonDefinition, portalId: string, requireEnabled: boolean) {
  const portal = dungeon.portals.find((candidate) => candidate.id === portalId && !candidate.retired);
  return portal && portal.source.kind === "world" && portal.destination.kind === "room" &&
    (!requireEnabled || portal.enabled) ? portal : null;
}

/**
 * Entrance templates the developer spawner can place: an active authored template when the dungeon has
 * one, otherwise a derived template from the dungeon's own world entrance portal. The derived template
 * never touches the catalog and its (possibly disabled) portal stays unbound in production.
 */
export function developerDungeonEntranceTemplates(
  catalog: DungeonCatalog
): DeveloperDungeonEntranceTemplate[] {
  const result: DeveloperDungeonEntranceTemplate[] = [];
  for (const dungeon of catalog.dungeons) {
    if (dungeon.retired) continue;
    const authored = catalog.entrances.filter((entrance) =>
      entrance.dungeonId === dungeon.id && !entrance.retired &&
      activeWorldPortal(dungeon, entrance.portalId, true));
    if (authored.length > 0) {
      for (const entrance of authored) result.push({ ...entrance, synthetic: false });
      continue;
    }
    const portal = activeWorldPortal(dungeon, dungeon.entrance.portalId, false);
    if (!portal) continue;
    result.push(syntheticDeveloperTemplate(dungeon, portal));
  }
  return result;
}

/** Resolves a stored or requested developer template ID (including derived ones) by ID. */
export function findDeveloperDungeonEntranceTemplate(
  catalog: DungeonCatalog,
  templateId: string,
  includeRetired = false
): DeveloperDungeonEntranceTemplate | null {
  const active = developerDungeonEntranceTemplates(catalog).find((candidate) => candidate.id === templateId);
  if (active) return active;
  if (templateId.startsWith(DEVELOPER_DUNGEON_TEMPLATE_PREFIX)) {
    if (!includeRetired) return null;
    const dungeon = catalog.dungeons.find((candidate) =>
      candidate.id === templateId.slice(DEVELOPER_DUNGEON_TEMPLATE_PREFIX.length));
    const portal = dungeon?.portals.find((candidate) => candidate.id === dungeon.entrance.portalId);
    return dungeon && portal ? syntheticDeveloperTemplate(dungeon, portal) : null;
  }
  if (!includeRetired) return null;
  const authored = catalog.entrances.find((candidate) => candidate.id === templateId);
  return authored ? { ...authored, synthetic: false } : null;
}

function syntheticDeveloperTemplate(
  dungeon: DungeonDefinition,
  portal: DungeonPortalDefinition
): DeveloperDungeonEntranceTemplate {
  return {
    id: `${DEVELOPER_DUNGEON_TEMPLATE_PREFIX}${dungeon.id}`,
    dungeonId: dungeon.id,
    revision: `developer-entrance:${dungeon.revision}`,
    retired: false,
    name: dungeon.name,
    description: dungeon.description,
    lat: 0,
    lon: 0,
    interactionRadiusM: 95,
    footprintRadiusM: 35,
    portalId: portal.id,
    portalRevision: `developer-portal:${portal.id}:${dungeon.revision}`,
    // Scaffolded dungeons keep a "Draft — needs world entrance binding" label on the disabled
    // authored portal; the developer-spawned entrance is a real, enabled one.
    interactionLabel: /^draft\b/i.test(portal.interactionLabel) ? `Enter ${dungeon.name}` : portal.interactionLabel,
    presentation: portal.presentation,
    assetKey: null,
    preloadSceneKey: portal.preloadSceneKey ?? `${dungeon.id}/${dungeon.entrance.roomId}`,
    synthetic: true
  };
}

/**
 * Sub-schemas the unified interior catalog (`interior/interiorCatalog.ts`)
 * extends instead of copying. Grouped under one export so the package barrel
 * does not gain a dozen generic schema names.
 */
export const dungeonCatalogSchemaParts = {
  rectangleSchema,
  rectangleColliderSchema,
  polygonColliderSchema,
  zonePurposeSchema,
  layerPlacementSchema,
  layerIdSchema,
  objectStateSchema,
  objectSchema,
  mobPlacementSchema,
  dungeonResourceSpawnZoneSchema,
  dungeonResourceNodeSchema,
  cameraSchema,
  roomEnvironmentSchema,
  portalSchema,
  worldEndpointSchema,
  encounterSchema,
  dungeonSchema,
  dungeonEntranceSchema,
  dungeonRewardTableSchema,
  dungeonBossTemplateSchema
} as const;
