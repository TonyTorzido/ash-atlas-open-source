import { z } from "zod";

import { SAPLING_STATE_ACTIONS } from "../givingSaplings.js";
import { PET_ABILITY_IDS } from "../petSystem.js";
import { premiumWalletSnapshotSchema } from "../premiumCurrency.js";
import { PET_STATE_ACTIONS, type PetServerMessage } from "./petMessages.js";
import {
  inventoryServerSchema,
  optionalRequestIdSchema,
  serverFrame,
  wireBooleanSchema,
  wireNumberSchema,
  wireObjectArraySchema,
  wireObjectSchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";

export const petServerMessageSchemas = {
  PET_STATE: serverFrame("PET_STATE", {
    requestId: optionalRequestIdSchema,
    action: z.enum(PET_STATE_ACTIONS).optional(),
    state: wireObjectSchema,
    notice: wireStringSchema.optional(),
    ping: z.object({
      abilityId: z.enum(PET_ABILITY_IDS),
      label: wireStringSchema,
      lat: wireNumberSchema,
      lon: wireNumberSchema,
      distanceM: wireNumberSchema
    }).strict().optional(),
    openLand: z.object({ lat: wireNumberSchema, lon: wireNumberSchema }).strict().optional(),
    stayAt: z.object({ lat: wireNumberSchema, lon: wireNumberSchema }).strict().optional(),
    inventory: inventoryServerSchema.optional(),
    premiumWallet: premiumWalletSnapshotSchema.optional()
  }),
  PET_ERROR: serverFrame("PET_ERROR", {
    requestId: optionalRequestIdSchema,
    code: wireStringSchema,
    message: wireStringSchema,
    retryable: wireBooleanSchema
  }),
  SAPLINGS_STATE: serverFrame("SAPLINGS_STATE", {
    requestId: optionalRequestIdSchema,
    saplings: wireObjectArraySchema,
    serverNowMs: wireNumberSchema
  }),
  SAPLING_DELTA: serverFrame("SAPLING_DELTA", {
    upserts: wireObjectArraySchema,
    removed: z.array(wireStringSchema),
    serverNowMs: wireNumberSchema
  }),
  SAPLING_DETAIL: serverFrame("SAPLING_DETAIL", {
    requestId: optionalRequestIdSchema,
    saplingId: wireStringSchema,
    sapling: wireObjectSchema.nullable(),
    serverNowMs: wireNumberSchema
  }),
  SAPLING_RESULT: serverFrame("SAPLING_RESULT", {
    requestId: optionalRequestIdSchema,
    action: z.enum(SAPLING_STATE_ACTIONS),
    sapling: wireObjectSchema.nullable(),
    serverNowMs: wireNumberSchema,
    notice: wireStringSchema.optional(),
    inventory: inventoryServerSchema.optional()
  }),
  SAPLING_ERROR: serverFrame("SAPLING_ERROR", {
    requestId: optionalRequestIdSchema,
    code: wireStringSchema,
    message: wireStringSchema,
    retryable: wireBooleanSchema
  })
} satisfies Record<PetServerMessage["type"], z.ZodTypeAny>;
