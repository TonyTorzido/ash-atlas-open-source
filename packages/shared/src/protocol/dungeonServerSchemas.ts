import { z } from "zod";
import { playerAppearanceSnapshotSchema } from "../appearance.js";
import { MOB_ARCHETYPE_KEYS, MOB_APPEARANCE_VARIANTS } from "../combat.js";
import { DUNGEON_CHEST_RARITIES, DUNGEON_RESOURCE_TYPES, DUNGEON_TORCH_TOTAL_MAX } from "../dungeonCatalog.js";
import { BOSS_HOST_KINDS, BOSS_LIFECYCLE_STATES } from "../boss.js";
import { dungeonSceneRevision } from "../dungeon.js";
import { FALLEN_PRISON_HUNT_BANDS, FALLEN_PRISON_HUNT_DIRECTIONS } from "../fallenPrisonHunt.js";
import {
  dungeonPrefabDefinitionSchema,
  dungeonRoomDefinitionSchema
} from "../dungeonCatalog.js";
import { inventoryServerSchema, playerSnapshotServerSchema } from "./serverSchemaPrimitives.js";

const entranceSchema = z.object({
  entranceId: z.string(), dungeonId: z.string(), instanceId: z.string().optional(),
  sewerId: z.string().optional(), structureId: z.string().optional(),
  cityId: z.string().optional(), cityName: z.string().optional(),
  portalId: z.string(), portalRevision: z.string(), interactionLabel: z.string(),
  name: z.string(), description: z.string(), regionCode: z.string(), lat: z.number(), lon: z.number(),
  interactionRadiusM: z.number().positive(), footprintRadiusM: z.number().positive(),
  presentation: z.enum(["door", "stairs", "ladder", "hatch", "cave"]),
  assetKey: z.string().nullable(),
  developerSpawned: z.boolean().optional(),
  templateId: z.string().optional(),
  placementRevision: z.number().int().positive().optional(),
  createdAt: z.string().optional(),
  dungeonRevision: z.string().optional(),
  /** Entry requirements (level, torch cost, lockout) the prompt and the torch lobby read. */
  access: z.object({
    minimumLevel: z.number().int().positive().optional(),
    entryCost: z.array(z.object({ itemId: z.string(), quantity: z.number().int().positive() })).optional(),
    lockoutDays: z.number().positive().optional(),
    lockoutHours: z.number().positive().optional(),
    requiresAfloat: z.boolean().optional(),
    noReentry: z.boolean().optional()
  }).optional()
});
const playerSchema = z.object({
  playerId: z.string(), name: z.string(), displayColor: z.string().nullable(),
  x: z.number(), y: z.number(), targetX: z.number().nullable(), targetY: z.number().nullable(),
  targetEntityId: z.string().nullable(), movementSpeed: z.number(), movementRevision: z.number(),
  currentHealth: z.number(), maxHealth: z.number(), appearance: playerAppearanceSnapshotSchema.optional()
});
const bossOwnershipSchema = z.object({
  bossId: z.string().min(1).max(160), bossRevision: z.number().int().positive(),
  encounterHandlerId: z.string().min(1).max(160), hostKind: z.enum(BOSS_HOST_KINDS),
  hostInstanceId: z.string().min(1).max(320), encounterInstanceId: z.string().min(1).max(320),
  appearanceId: z.string().min(1).max(160).optional(), appearanceVariant: z.enum(MOB_APPEARANCE_VARIANTS).optional(),
  lifeGeneration: z.number().int().nonnegative()
}).strict();
const bossCoordinateSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180)
}).strict();
const bossTelegraphSchema = z.object({
  encounterId: z.string().min(1).max(320), bossId: z.string().min(1).max(160),
  abilityId: z.string().min(1).max(160), castInstanceId: z.string().min(1).max(200),
  startTime: z.number().finite(), resolveTime: z.number().finite(),
  origin: bossCoordinateSchema,
  facingDegrees: z.number().finite().optional(), targetEntityId: z.string().min(1).max(160).optional(),
  geometry: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("circle"), center: bossCoordinateSchema, radiusM: z.number().finite().positive() }).strict(),
    z.object({ kind: z.literal("cone"), origin: bossCoordinateSchema, facingDegrees: z.number().finite(), rangeM: z.number().finite().positive(), angleDegrees: z.number().finite().positive().max(360) }).strict(),
    z.object({ kind: z.literal("line"), origin: bossCoordinateSchema, facingDegrees: z.number().finite(), lengthM: z.number().finite().positive(), widthM: z.number().finite().positive() }).strict()
  ]),
  lifeGeneration: z.number().int().nonnegative()
}).strict().refine((cast) => cast.resolveTime >= cast.startTime, {
  path: ["resolveTime"],
  message: "must be at or after startTime"
});
const bossEncounterProjectionSchema = z.object({
  encounterId: z.string().min(1).max(320), bossId: z.string().min(1).max(160), bossRevision: z.number().int().positive(),
  encounterHandlerId: z.string().min(1).max(160), hostKind: z.enum(BOSS_HOST_KINDS), hostInstanceId: z.string().min(1).max(320),
  encounterInstanceId: z.string().min(1).max(320), mobEntityId: z.string().min(1).max(320),
  lifecycleState: z.enum(BOSS_LIFECYCLE_STATES), phaseId: z.string().nullable(),
  phaseDeadlineAt: z.number().finite().nonnegative().optional(),
  lifeGeneration: z.number().int().nonnegative(),
  participation: z.object({
    policyId: z.string().min(1).max(160), canJoin: z.boolean(), participantIds: z.array(z.string().min(1).max(160))
  }).strict(),
  activeCasts: z.array(bossTelegraphSchema)
}).strict();
const snapshotFields = {
  catalogRevision: z.number().int().nonnegative(), sceneRevision: z.string(),
  dungeonId: z.string(), dungeonRevision: z.string(),
  instancePolicy: z.enum(["shared_persistent", "party_ephemeral", "solo_ephemeral"]),
  entranceId: z.string().optional(), name: z.string().optional(), description: z.string().optional(),
  portalId: z.string().optional(),
  presentation: z.enum(["door", "stairs", "ladder", "hatch", "cave"]).optional(),
  assetKey: z.string().nullable().optional(),
  sewerId: z.string().optional(), cityId: z.string().optional(), cityName: z.string().optional(), sessionId: z.string(),
  instanceId: z.string(), spaceId: z.string(),
  roomWidth: z.number(), roomHeight: z.number(), playerVisualHeight: z.number(),
  camera: z.object({
    mode: z.literal("fixed_center"), center: z.object({ x: z.number(), y: z.number() }),
    fitPadding: z.number(), defaultZoom: z.number(), minZoom: z.number(), maxZoom: z.number()
  }),
  environment: z.object({
    environmentId: z.string(), backgroundColor: z.string(), floorColor: z.string(),
    wallColor: z.string(), accentColor: z.string(),
    visualTreatmentId: z.string().nullable().optional(),
    musicAssetKey: z.string().nullable(), ambienceAssetKey: z.string().nullable()
  }),
  player: playerSchema, occupants: z.array(playerSchema),
  room: dungeonRoomDefinitionSchema,
  prefabs: z.array(dungeonPrefabDefinitionSchema),
  enemies: z.array(z.object({
    entityId: z.string(), spawnId: z.string(), encounterId: z.string(), archetype: z.enum(MOB_ARCHETYPE_KEYS),
    name: z.string(), x: z.number(), y: z.number(), currentHealth: z.number(), maxHealth: z.number(),
    lifeState: z.enum(["alive", "downed", "defeated", "respawning"]), targetEntityId: z.string().nullable(),
    visualScale: z.number(), boss: z.boolean().optional(), bossOwnership: bossOwnershipSchema.optional(),
    bossEncounter: bossEncounterProjectionSchema.optional(),
    elite: z.object({ modifiers: z.array(z.string()), shieldActive: z.boolean().optional() }).strict().optional()
  })), objects: z.array(z.object({
    id: z.string(), kind: z.enum([
      "portal", "door", "ladder", "chest", "valve", "switch", "shrine",
      "harvestable", "destructible", "npc", "decoration", "exit_ladder"
    ]),
    name: z.string(), x: z.number(), y: z.number(), available: z.boolean(),
    state: z.enum(["idle", "open", "closed", "on", "off", "pressed", "released",
      "intact", "destroyed", "looted"]),
    prefabId: z.string(), prefabRevision: z.string(),
    layerId: z.enum(["background", "below_player", "actors", "above_player", "ceiling"]),
    interactionRadius: z.number(), rotationDeg: z.number(), opacity: z.number(),
    flipX: z.boolean(), flipY: z.boolean(), zIndex: z.number(),
    rarity: z.enum(DUNGEON_CHEST_RARITIES).optional(), assetKey: z.string().optional(),
    portalId: z.string().optional(), interactionLabel: z.string().optional()
  })),
  resources: z.array(z.object({
    id: z.string(), roomId: z.string(), resourceType: z.enum(DUNGEON_RESOURCE_TYPES),
    x: z.number(), y: z.number(), quantity: z.number().int().nonnegative(),
    state: z.enum(["available", "depleted"]), availableAt: z.number().nullable(),
    interactionRadius: z.number().positive(), prefabId: z.string().optional(),
    prefabRevision: z.string().optional(), source: z.enum(["authored", "spawn_zone"])
  }).strict()).optional(),
  telegraphs: z.array(bossTelegraphSchema),
  encounters: z.array(z.object({ id: z.string(),
    state: z.enum(["idle", "active", "completed", "failed", "resetting"]),
    currentWaveId: z.string().nullable(), attempts: z.number().int().nonnegative() })),
  triggers: z.array(z.object({ id: z.string(), enabled: z.boolean(),
    firedCount: z.number().int().nonnegative(), cooldownUntil: z.number().nullable() })),
  dungeonFlags: z.record(z.boolean()), portalLocks: z.record(z.boolean()),
  completed: z.boolean(), cues: z.array(z.string()),
  notices: z.array(z.object({
    id: z.number().int().nonnegative(), text: z.string().min(1).max(200),
    tone: z.enum(["info", "success", "warning"])
  })).optional(),
  resetDeadline: z.number().nullable(),
  runStartedAt: z.number().nullable().optional(),
  partyDeaths: z.number().int().nonnegative().optional(),
  heartPuzzleActiveRoomId: z.string().nullable().optional(),
  status: z.string(), serverTime: z.number()
} as const;
const fullSnapshotSchema = z.object({
  snapshotKind: z.literal("full"),
  ...snapshotFields
}).strict().superRefine(validateSceneIdentity);
const updateSnapshotSchema = z.object({
  snapshotKind: z.literal("update"),
  ...snapshotFields,
  room: z.never().optional(),
  prefabs: z.never().optional()
}).strict().superRefine(validateSceneIdentity);

function validateSceneIdentity(
  snapshot: Readonly<{ catalogRevision: number; dungeonRevision: string;
    spaceId: string; sceneRevision: string }>,
  context: z.RefinementCtx
): void {
  if (snapshot.sceneRevision !== dungeonSceneRevision(
    snapshot.catalogRevision,
    snapshot.dungeonRevision,
    snapshot.spaceId
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sceneRevision"],
      message: "does not match the immutable dungeon scene identity"
    });
  }
}

const torchCount = z.number().int().min(0).max(DUNGEON_TORCH_TOTAL_MAX);
const torchLobbySchema = z.object({
  lobbyId: z.string().min(1), entranceId: z.string().min(1), dungeonId: z.string().min(1),
  dungeonName: z.string(), partyId: z.string().nullable(), leaderPlayerId: z.string().min(1),
  status: z.enum(["open", "starting", "started", "in_progress"]),
  revision: z.number().int().nonnegative(),
  torchCost: z.array(z.object({ itemId: z.string().min(1), quantity: z.number().int().positive() })),
  minTotalTorches: torchCount, maxTotalTorches: torchCount, totalTorches: torchCount,
  members: z.array(z.object({
    playerId: z.string().min(1), name: z.string(), torches: torchCount, ready: z.boolean()
  })).max(16),
  message: z.string().nullable()
});

export const dungeonServerMessageSchemas = {
  DUNGEON_ENTRANCES: z.object({
    type: z.literal("DUNGEON_ENTRANCES"), requestId: z.string().optional(),
    entrances: z.array(entranceSchema)
  }),
  DUNGEON_ENTRANCE_UPSERTED: z.object({
    type: z.literal("DUNGEON_ENTRANCE_UPSERTED"), entrance: entranceSchema
  }),
  DUNGEON_ENTRANCE_REMOVED: z.object({
    type: z.literal("DUNGEON_ENTRANCE_REMOVED"), entranceId: z.string()
  }),
  FALLEN_PRISON_HUNT: z.object({
    type: z.literal("FALLEN_PRISON_HUNT"),
    hint: z.object({
      direction: z.enum(FALLEN_PRISON_HUNT_DIRECTIONS), band: z.enum(FALLEN_PRISON_HUNT_BANDS), smokeInSight: z.boolean()
    }).nullable(),
    announcement: z.string().max(200).optional()
  }),
  DUNGEON_ENTERED: z.object({
    type: z.literal("DUNGEON_ENTERED"), requestId: z.string(), snapshot: fullSnapshotSchema
  }),
  DUNGEON_SNAPSHOT: z.object({ type: z.literal("DUNGEON_SNAPSHOT"),
    requestId: z.string().optional(), snapshot: z.union([fullSnapshotSchema, updateSnapshotSchema]) }),
  DUNGEON_RESOURCE_HARVESTED: z.object({
    type: z.literal("DUNGEON_RESOURCE_HARVESTED"), requestId: z.string(), resourceId: z.string(),
    resourceType: z.enum(DUNGEON_RESOURCE_TYPES), quantity: z.number().int().positive(),
    snapshot: z.union([fullSnapshotSchema, updateSnapshotSchema])
  }),
  DUNGEON_REWARD_GRANTED: z.object({
    type: z.literal("DUNGEON_REWARD_GRANTED"), requestId: z.string().optional(),
    runId: z.string().uuid(), rewardSourceId: z.string(), rewardTableId: z.string(),
    applied: z.boolean(), inventory: inventoryServerSchema,
    wallet: z.object({ playerId: z.string(), gold: z.string(), revision: z.string() }).strict(),
    items: z.array(z.object({ itemId: z.string(), quantity: z.number().int().positive() })).default([]),
    gold: z.number().int().nonnegative().default(0),
    message: z.string()
  }),
  DUNGEON_EXITED: z.object({
    type: z.literal("DUNGEON_EXITED"), requestId: z.string(), player: playerSnapshotServerSchema
  }),
  DUNGEON_ERROR: z.object({
    type: z.literal("DUNGEON_ERROR"), requestId: z.string().optional(),
    code: z.string(), message: z.string()
  }),
  DUNGEON_TORCH_LOBBY: z.object({
    type: z.literal("DUNGEON_TORCH_LOBBY"), requestId: z.string().optional(),
    lobby: torchLobbySchema.nullable()
  })
} as const;
