import { z } from "zod";

import { marketIntegerSchema } from "../marketProtocol.js";
import type { TravelServerMessage } from "./travelMessages.js";
import {
  latLonServerSchema,
  optionalRequestIdSchema,
  playerSnapshotServerSchema,
  requestIdSchema,
  serverFrame,
  wireBooleanSchema,
  wireNonnegativeIntegerSchema,
  wireNumberSchema,
  wireObjectArraySchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";

export const travelServerMessageSchemas = {
  TRAVEL_INBOX_SNAPSHOT: serverFrame("TRAVEL_INBOX_SNAPSHOT", {
    entries: wireObjectArraySchema,
    serverTime: wireNumberSchema,
    relocationAvailableAt: wireNumberSchema.nullable().optional(),
    travelInviteAvailableAt: wireNumberSchema.nullable().optional(),
    landActionAvailableAt: wireNumberSchema.nullable().optional(),
    relocationExemptionAvailable: wireBooleanSchema.optional()
  }),
  VISIBLE_FLAG_VISIT_PREPARED: serverFrame("VISIBLE_FLAG_VISIT_PREPARED", { requestId: requestIdSchema, flagId: wireStringSchema, playerSpawnPosition: latLonServerSchema, expiresInMs: wireNonnegativeIntegerSchema }),
  TRAVEL_RESULT: serverFrame("TRAVEL_RESULT", { requestId: optionalRequestIdSchema, kind: z.enum(["invite", "invite_sent", "party_manual", "party_auto_follow", "manor_jump", "pet_open_land", "gps_relocate", "whirlpool"]), success: wireBooleanSchema, message: wireStringSchema, retryAfterMs: wireNonnegativeIntegerSchema.optional(), relocationAvailableAt: wireNumberSchema.nullable().optional(), travelInviteAvailableAt: wireNumberSchema.nullable().optional(), landActionAvailableAt: wireNumberSchema.nullable().optional(), relocationExemptionAvailable: wireBooleanSchema.optional(), player: playerSnapshotServerSchema.optional(), resourceVisionRevision: wireNonnegativeIntegerSchema.optional(), arrivalPresentation: z.literal("jump").optional(), warning: wireStringSchema.optional() }),
  CITY_VISITED: serverFrame("CITY_VISITED", { requestId: requestIdSchema, cityId: wireStringSchema, player: playerSnapshotServerSchema, resourceVisionRevision: wireNonnegativeIntegerSchema.optional(), arrivalPresentation: z.literal("jump").optional(), warning: wireStringSchema.optional() }),
  FLAG_TOLL_RECEIVED: serverFrame("FLAG_TOLL_RECEIVED", { flagId: wireStringSchema, amount: marketIntegerSchema, walletGold: marketIntegerSchema }),
  FLAG_VISITED: serverFrame("FLAG_VISITED", { requestId: requestIdSchema, flagId: wireStringSchema, resourceVisionRevision: wireNonnegativeIntegerSchema, player: playerSnapshotServerSchema, walletGold: marketIntegerSchema.optional(), arrivalPresentation: z.literal("jump").optional(), warning: wireStringSchema.optional() }),
} satisfies Record<TravelServerMessage["type"], z.ZodTypeAny>;
