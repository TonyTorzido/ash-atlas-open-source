import { z } from "zod";

import { marketIntegerSchema } from "../marketProtocol.js";
import { equipmentSnapshotSchema } from "./combatEquipmentServerSchemas.js";
import {
  inventoryServerSchema,
  requestIdSchema,
  serverFrame,
  wireBooleanSchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";
import type { PlayerGiftServerMessage } from "./playerGiftMessages.js";

const count = z.number().int().nonnegative();

export const playerGiftServerMessageSchemas = {
  GIFT_BOX_PURCHASE_RESULT: serverFrame("GIFT_BOX_PURCHASE_RESULT", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    quantity: z.number().int().positive(),
    totalPriceGold: marketIntegerSchema,
    walletGold: marketIntegerSchema,
    walletVersion: marketIntegerSchema,
    inventory: inventoryServerSchema
  }),
  PLAYER_GIFT_SEND_RESULT: serverFrame("PLAYER_GIFT_SEND_RESULT", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    packageId: z.string().uuid(),
    recipientPlayerId: z.string().min(1).max(160),
    recipientName: z.string().min(1).max(80),
    inventory: inventoryServerSchema,
    equipment: equipmentSnapshotSchema
  }),
  PLAYER_GIFT_STATUS: serverFrame("PLAYER_GIFT_STATUS", {
    requestId: requestIdSchema,
    giftBoxPriceGold: marketIntegerSchema,
    giftBoxesOwned: count,
    sentToday: count,
    maxSentPerDay: count,
    maxPerRecipientPerDay: count,
    minSenderLevel: count,
    senderLevel: count,
    levelOk: wireBooleanSchema,
    settledOk: wireBooleanSchema,
    heldCount: count,
    maxHeld: count,
    maxLines: count
  }),
  PLAYER_GIFT_ERROR: serverFrame("PLAYER_GIFT_ERROR", {
    requestId: requestIdSchema,
    code: wireStringSchema,
    message: wireStringSchema
  })
} satisfies Record<PlayerGiftServerMessage["type"], z.ZodTypeAny>;
