import { z } from "zod";

import { RESOURCE_TYPES } from "../collectibles.js";
import type { FlagServerMessage } from "./flagMessages.js";
import {
  flagSnapshotServerSchema,
  inventoryServerSchema,
  latLonServerSchema,
  optionalRequestIdSchema,
  requestIdSchema,
  serverFrame,
  wireBooleanSchema,
  wireNonnegativeIntegerSchema,
  wireNumberSchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";

const flagSnapshotAuthorityBaseSchema = z.object({
  connectionId: wireStringSchema,
  connectionGeneration: wireNonnegativeIntegerSchema,
  scopeId: wireStringSchema,
  snapshotId: wireStringSchema,
  chunkIndex: wireNonnegativeIntegerSchema,
  chunkCount: wireNonnegativeIntegerSchema.optional(),
  finalChunk: wireBooleanSchema
});

const flagSnapshotAuthoritySchema = z.discriminatedUnion("scopeKind", [
  flagSnapshotAuthorityBaseSchema.extend({
    scopeKind: z.literal("global-flags")
  }),
  flagSnapshotAuthorityBaseSchema.extend({
    scopeKind: z.literal("gameplay-circle-flags"),
    relocationRevision: wireNonnegativeIntegerSchema,
    gameplayViewGeneration: wireNonnegativeIntegerSchema
  })
]);

const flagBuildMaterialSchema = z.object({
  itemId: z.enum(RESOURCE_TYPES),
  quantity: wireNonnegativeIntegerSchema
}).strict();

export const flagServerMessageSchemas = {
  FLAGS_SNAPSHOT: serverFrame("FLAGS_SNAPSHOT", { flags: z.array(flagSnapshotServerSchema), flagSetRevision: wireNonnegativeIntegerSchema.optional(), complete: wireBooleanSchema.optional(), truncated: wireBooleanSchema.optional(), authority: flagSnapshotAuthoritySchema.optional() }),
  FLAG_BUILD_QUEUED: serverFrame("FLAG_BUILD_QUEUED", { buildId: wireStringSchema, requestId: requestIdSchema, queuedAt: wireNumberSchema, anchorKind: z.enum(["flag", "buoy"]).optional(), flagName: wireStringSchema.optional() }),
  FLAG_BUILD_STARTED: serverFrame("FLAG_BUILD_STARTED", { buildId: wireStringSchema, requestId: requestIdSchema, startedAt: wireNumberSchema, completesAt: wireNumberSchema, durationMs: wireNumberSchema, serverTime: wireNumberSchema, position: latLonServerSchema, anchorKind: z.enum(["flag", "buoy"]).optional(), flagName: wireStringSchema.optional() }),
  FLAG_BUILD_CANCELLED: serverFrame("FLAG_BUILD_CANCELLED", { buildId: wireStringSchema, requestId: requestIdSchema, reason: wireStringSchema, serverTime: wireNumberSchema }),
  FLAG_REINFORCEMENT_STARTED: serverFrame("FLAG_REINFORCEMENT_STARTED", { requestId: requestIdSchema, flagId: wireStringSchema, flagName: wireStringSchema, startedAt: wireNumberSchema, completesAt: wireNumberSchema, durationMs: wireNumberSchema, serverTime: wireNumberSchema, position: latLonServerSchema, targetTier: z.enum(["stone", "tower", "tower_level", "city_tower", "kingdom_tower", "obelisk"]).optional().default("stone"), targetTowerLevel: wireNumberSchema.optional() }),
  FLAG_REINFORCEMENT_CANCELLED: serverFrame("FLAG_REINFORCEMENT_CANCELLED", { requestId: requestIdSchema, flagId: wireStringSchema, reason: wireStringSchema, serverTime: wireNumberSchema }),
  FLAG_BURN_STARTED: serverFrame("FLAG_BURN_STARTED", { operationId: wireStringSchema, requestId: requestIdSchema, flagId: wireStringSchema, flagName: wireStringSchema, startedAt: wireNumberSchema, completesAt: wireNumberSchema, durationMs: wireNumberSchema, serverTime: wireNumberSchema, position: latLonServerSchema }),
  FLAG_BURN_CANCELLED: serverFrame("FLAG_BURN_CANCELLED", { operationId: wireStringSchema, requestId: requestIdSchema, flagId: wireStringSchema, reason: wireStringSchema, serverTime: wireNumberSchema }),
  FLAG_BURN_NOTICE: serverFrame("FLAG_BURN_NOTICE", { operationId: wireStringSchema, flagId: wireStringSchema, flagName: wireStringSchema, message: wireStringSchema, completesAt: wireNumberSchema, serverTime: wireNumberSchema }),
  FLAG_REPAIR_STARTED: serverFrame("FLAG_REPAIR_STARTED", { operationId: wireStringSchema, requestId: requestIdSchema, flagId: wireStringSchema, ownerId: wireStringSchema, flagName: wireStringSchema, startedAt: wireNumberSchema, completesAt: wireNumberSchema, durationMs: wireNumberSchema, pausedBurnRemainingMs: wireNonnegativeIntegerSchema, repairKitQuantity: wireNonnegativeIntegerSchema, stoneQuantity: wireNonnegativeIntegerSchema, serverTime: wireNumberSchema, position: latLonServerSchema }),
  FLAG_REPAIR_CANCELLED: serverFrame("FLAG_REPAIR_CANCELLED", { operationId: wireStringSchema, requestId: requestIdSchema, flagId: wireStringSchema, reason: wireStringSchema, serverTime: wireNumberSchema }),
  FLAG_REPAIRED: serverFrame("FLAG_REPAIRED", { operationId: wireStringSchema, requestId: requestIdSchema, flag: flagSnapshotServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema, serverTime: wireNumberSchema }),
  FLAG_REPAIR_DISRUPT_STARTED: serverFrame("FLAG_REPAIR_DISRUPT_STARTED", { operationId: wireStringSchema, requestId: requestIdSchema, flagId: wireStringSchema, repairOperationId: wireStringSchema, startedAt: wireNumberSchema, completesAt: wireNumberSchema, durationMs: wireNumberSchema, serverTime: wireNumberSchema, position: latLonServerSchema }),
  FLAG_REPAIR_DISRUPT_CANCELLED: serverFrame("FLAG_REPAIR_DISRUPT_CANCELLED", { operationId: wireStringSchema, requestId: requestIdSchema, flagId: wireStringSchema, reason: wireStringSchema, serverTime: wireNumberSchema }),
  FLAG_REPAIR_DISRUPTED: serverFrame("FLAG_REPAIR_DISRUPTED", { operationId: wireStringSchema, requestId: requestIdSchema, flagId: wireStringSchema, repairOperationId: wireStringSchema, replayed: wireBooleanSchema, serverTime: wireNumberSchema }),
  TORCHES_CRAFTED: serverFrame("TORCHES_CRAFTED", { requestId: requestIdSchema, quantity: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema, inventory: inventoryServerSchema }),
  FLAG_CREATED: serverFrame("FLAG_CREATED", { requestId: optionalRequestIdSchema, buildId: wireStringSchema.optional(), flag: flagSnapshotServerSchema, warning: wireStringSchema.optional(), serverTime: wireNumberSchema.optional(), inventory: inventoryServerSchema.optional(), consumedMaterials: z.array(flagBuildMaterialSchema).optional(), recoveredMaterials: z.array(flagBuildMaterialSchema).optional(), flagSetRevision: wireNonnegativeIntegerSchema.optional() }),
  FLAG_UPSERTED: serverFrame("FLAG_UPSERTED", { flag: flagSnapshotServerSchema, serverTime: wireNumberSchema, flagSetRevision: wireNonnegativeIntegerSchema.optional() }),
  FLAG_REINFORCED: serverFrame("FLAG_REINFORCED", { requestId: requestIdSchema, flag: flagSnapshotServerSchema, inventory: inventoryServerSchema, replayed: wireBooleanSchema, flagSetRevision: wireNonnegativeIntegerSchema.optional() }),
  FLAGS_COLLAPSED: serverFrame("FLAGS_COLLAPSED", { flagIds: z.array(wireStringSchema).max(1_000), collapseId: wireStringSchema.nullable(), reason: wireStringSchema, completed: wireBooleanSchema, flagSetRevision: wireNonnegativeIntegerSchema.optional() }),
  TERRITORY_COLLAPSE_STARTED: serverFrame("TERRITORY_COLLAPSE_STARTED", { collapseId: wireStringSchema, kind: z.enum(["city", "kingdom"]), name: wireStringSchema, reason: wireStringSchema, flagCount: wireNonnegativeIntegerSchema }),
  FLAG_DELETED: serverFrame("FLAG_DELETED", { flagId: wireStringSchema, reason: z.enum(["deleted", "transformed", "destroyed"]).optional(), inventory: inventoryServerSchema.optional(), flagSetRevision: wireNonnegativeIntegerSchema.optional() }),
  FLAG_UPDATED: serverFrame("FLAG_UPDATED", { flag: flagSnapshotServerSchema, flagSetRevision: wireNonnegativeIntegerSchema.optional() }),
  FLAG_ACCESS_CHANGED: serverFrame("FLAG_ACCESS_CHANGED", { flagId: wireStringSchema, message: wireStringSchema, flagSetRevision: wireNonnegativeIntegerSchema.optional() }),
} satisfies Record<FlagServerMessage["type"], z.ZodTypeAny>;
