import { z } from "zod";

import {
  BACKPACK_ACTIONS,
  BACKPACK_DEFINITION_IDS,
  BACKPACK_ERROR_CODES
} from "../backpacks.js";
import {
  inventoryServerSchema,
  serverFrame,
  wireNonnegativeIntegerSchema
} from "./serverSchemaPrimitives.js";

const backpackLocationSchema = z.enum([
  "inventory",
  "equipped",
  "manor_storage",
  "world_drop",
  "destroyed"
]);
const backpackInstanceSchema = z.object({
  instanceId: z.string().uuid(),
  ownerPlayerId: z.string().min(1),
  definitionId: z.enum(BACKPACK_DEFINITION_IDS),
  displayName: z.string().min(1),
  location: backpackLocationSchema,
  capacityBonus: wireNonnegativeIntegerSchema.optional(),
  upgradeLevel: z.number().int().min(0).max(10).optional(),
  capacityBonusGrams: wireNonnegativeIntegerSchema.optional(),
  unitWeightGrams: wireNonnegativeIntegerSchema.optional(),
  equippedSlot: z.number().int().min(0).max(3).nullable(),
  inventorySlotIndex: wireNonnegativeIntegerSchema.nullable().optional(),
  manorId: z.string().uuid().nullable(),
  manorSlotIndex: z.number().int().nonnegative().safe().nullable(),
  version: wireNonnegativeIntegerSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export const backpackSnapshotSchema = z.object({
  playerId: z.string().min(1),
  revision: wireNonnegativeIntegerSchema,
  baseCapacityGrams: wireNonnegativeIntegerSchema.optional(),
  backpackBonusGrams: wireNonnegativeIntegerSchema.optional(),
  maximumCapacityGrams: wireNonnegativeIntegerSchema.optional(),
  baseSlots: z.number().int().min(40).max(100).optional(),
  backpackBonusSlots: z.number().int().min(0).max(60).optional(),
  effectiveSlots: z.number().int().min(1).max(100).optional(),
  maximumSlots: z.literal(100).optional(),
  equipped: z.tuple([
    backpackInstanceSchema.nullable(),
    backpackInstanceSchema.nullable(),
    backpackInstanceSchema.nullable(),
    backpackInstanceSchema.nullable()
  ]),
  instances: z.array(backpackInstanceSchema)
}).strict();
const backpackOperationResultSchema = z.object({
  requestId: z.string().min(1).max(120),
  action: z.enum(BACKPACK_ACTIONS),
  replayed: z.boolean(),
  backpacks: backpackSnapshotSchema,
  inventory: inventoryServerSchema,
  walletGold: z.string().regex(/^\d+$/u),
  walletVersion: z.string().regex(/^\d+$/u).optional(),
  message: z.string()
}).strict();
const diagnosticSchema = z.object({
  currentEffectiveSlots: wireNonnegativeIntegerSchema.optional(),
  resultingEffectiveSlots: wireNonnegativeIntegerSchema.optional(),
  occupiedResourceStacks: wireNonnegativeIntegerSchema.optional(),
  slotsToFree: wireNonnegativeIntegerSchema.optional(),
  highSlotOccupied: z.boolean().optional(),
  currentWeightGrams: z.string().regex(/^\d+$/u).optional(),
  resultingMaximumWeightGrams: z.string().regex(/^\d+$/u).optional()
}).strict();

export const backpackServerMessageSchemas = {
  BACKPACK_SNAPSHOT: serverFrame("BACKPACK_SNAPSHOT", {
    backpacks: backpackSnapshotSchema
  }),
  BACKPACK_OPERATION_RESULT: serverFrame("BACKPACK_OPERATION_RESULT", {
    result: backpackOperationResultSchema
  }),
  BACKPACK_ERROR: serverFrame("BACKPACK_ERROR", {
    requestId: z.string().max(120).nullable(),
    code: z.enum(BACKPACK_ERROR_CODES),
    message: z.string(),
    diagnostic: diagnosticSchema.optional()
  })
} as const;
