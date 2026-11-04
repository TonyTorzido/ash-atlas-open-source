import { z } from "zod";

import { CLASS_IDS, SUBCLASS_IDS } from "../classes.js";
import { RESOURCE_TYPES } from "../collectibles.js";
import { marketIntegerSchema } from "../marketProtocol.js";
import { PVP_TIMER_KINDS } from "../pvpTimers.js";
import { premiumWalletSnapshotSchema } from "../premiumCurrency.js";
import type { CombatEquipmentServerMessage } from "./combatEquipmentMessages.js";
import {
  combatKitActivatedMessageSchema,
  combatKitInvalidatedMessageSchema,
  combatKitSnapshotMessageSchema,
  combatServerMessageSchema,
  equipmentSnapshotSchema,
  equipmentAcquiredMessageSchema,
  equipmentRepairedMessageSchema,
  repairKitCraftedMessageSchema,
  ringOperationResultMessageSchema,
  gearScrollsStateMessageSchema,
  equipmentUpgradeResultMessageSchema,
  progressionSnapshotSchema
} from "./combatEquipmentServerSchemas.js";
import {
  inventoryServerSchema,
  optionalRequestIdSchema,
  requestIdSchema,
  serverFrame,
  wireBooleanSchema,
  wireNonnegativeIntegerSchema,
  wireObjectArraySchema,
  wireObjectSchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";

const combatRewardGrantedServerSchema = serverFrame("COMBAT_REWARD_GRANTED", {
  settlementKey: wireStringSchema,
  playerId: wireStringSchema,
  items: z.array(z.object({
    itemId: z.enum(RESOURCE_TYPES),
    quantity: wireNonnegativeIntegerSchema
  }).passthrough()),
  drops: wireObjectArraySchema,
  gold: wireNonnegativeIntegerSchema,
  mobName: wireStringSchema.optional(),
  boss: wireBooleanSchema.optional(),
  walletGold: marketIntegerSchema.optional(),
  walletVersion: marketIntegerSchema.optional(),
  inventory: inventoryServerSchema,
  cityCoins: wireNonnegativeIntegerSchema,
  cityId: wireStringSchema.nullable(),
  cityTreasuryBalance: marketIntegerSchema.nullable(),
  cityContribution: marketIntegerSchema.nullable(),
  rings: z.array(z.object({
    definitionId: z.enum(["ring_plain", "ring_fine", "ring_prime", "ring_peerless"]),
    onGround: wireBooleanSchema,
    lost: wireBooleanSchema.optional()
  }).strict()).max(4).optional()
}).superRefine((message, context) => {
  const hasWalletGold = message.walletGold !== undefined;
  const hasWalletVersion = message.walletVersion !== undefined;
  if (hasWalletGold !== hasWalletVersion) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["walletGold"],
      message: "Combat wallet balance and version must be provided together"
    });
  }
  if (message.gold === 0 && (hasWalletGold || hasWalletVersion)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["walletGold"],
      message: "Zero-gold combat rewards must not contain a wallet update"
    });
  }
  if (
    message.gold > 0 &&
    (
      !hasWalletGold ||
      !hasWalletVersion ||
      message.walletGold === "0" ||
      message.walletVersion === "0"
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["walletGold"],
      message: "Positive-gold combat rewards require a positive authoritative wallet update"
    });
  }
});

export const combatEquipmentServerMessageSchemas = {
  COMBAT_SNAPSHOT: combatServerMessageSchema,
  COMBAT_DELTA: combatServerMessageSchema,
  COMBAT_STARTED: combatServerMessageSchema,
  XORAL_EVENT_STARTED: serverFrame("XORAL_EVENT_STARTED", {
    requestId: requestIdSchema,
    eventId: wireStringSchema,
    xoralEntityId: wireStringSchema,
    participantPlayerIds: z.array(wireStringSchema).min(1).max(5)
  }),
  XORAL_REWARD_GRANTED: serverFrame("XORAL_REWARD_GRANTED", {
    eventId: wireStringSchema,
    ringDefinitionId: z.enum(["ring_plain", "chopping_ring", "mining_ring", "attack_ring"]),
    ringDelivery: z.enum(["inventory", "ground"]),
    gold: wireNonnegativeIntegerSchema,
    walletGold: marketIntegerSchema,
    walletVersion: marketIntegerSchema,
    xp: wireNonnegativeIntegerSchema,
    classXp: wireNonnegativeIntegerSchema
  }),
  LAND_BONUS_EARNED: serverFrame("LAND_BONUS_EARNED", {
    gold: wireNonnegativeIntegerSchema,
    kills: wireNonnegativeIntegerSchema,
    walletGold: marketIntegerSchema,
    walletVersion: marketIntegerSchema
  }),
  XORAL_EVENT_CANCELLED: serverFrame("XORAL_EVENT_CANCELLED", {
    eventId: wireStringSchema,
    reason: wireStringSchema
  }),
  LEGENDARY_EVENT_ALERT: serverFrame("LEGENDARY_EVENT_ALERT", {
    eventId: wireStringSchema,
    birdSpecies: z.enum(["fire", "lightning", "ice"]),
    flagId: wireStringSchema,
    message: wireStringSchema,
    selectedAt: wireStringSchema,
    expiresAt: wireStringSchema
  }),
  XORAL_PARTICIPANT_EXITED: serverFrame("XORAL_PARTICIPANT_EXITED", {
    requestId: requestIdSchema,
    eventId: wireStringSchema,
    reason: wireStringSchema
  }),
  XORAL_RING_DROPS_SNAPSHOT: serverFrame("XORAL_RING_DROPS_SNAPSHOT", {
    drops: z.array(z.object({
      dropId: z.string().uuid(),
      eventId: z.string().uuid(),
      ringDefinitionId: z.enum(["ring_plain", "chopping_ring", "mining_ring", "attack_ring"]),
      regionCode: wireStringSchema,
      zoneId: wireStringSchema,
      lat: z.number().finite().min(-90).max(90),
      lon: z.number().finite().min(-180).max(180),
      createdAt: wireStringSchema
    }).strict())
  }),
  XORAL_RING_DROP_PICKED_UP: serverFrame("XORAL_RING_DROP_PICKED_UP", {
    requestId: requestIdSchema,
    dropId: z.string().uuid(),
    equipment: equipmentSnapshotSchema
  }),
  COMBAT_CANCELLED: combatServerMessageSchema,
  COMBAT_REWARD_GRANTED: combatRewardGrantedServerSchema,
  PROGRESSION_SNAPSHOT: serverFrame("PROGRESSION_SNAPSHOT", {
    progression: progressionSnapshotSchema,
    deathPenalty: z.object({
      operationKey: wireStringSchema,
      deathDrop: z.object({
        outcome: z.enum([
          "dropped", "protected", "dungeon", "interior", "disabled", "unknown_context", "no_backpack", "cannot_fit"
        ]),
        lines: z.array(z.object({
          kind: z.enum(["backpack", "item", "equipment"]),
          itemId: wireStringSchema,
          name: wireStringSchema,
          quantity: wireNonnegativeIntegerSchema
        }).strict()).max(200)
      }).strict().optional(),
      xpLost: wireNonnegativeIntegerSchema
    }).strict().optional()
  }),
  PVP_STATUS: serverFrame("PVP_STATUS", {
    timers: z.array(z.object({
      kind: z.enum(PVP_TIMER_KINDS),
      playerId: wireStringSchema,
      displayName: wireStringSchema,
      expiresAt: wireNonnegativeIntegerSchema
    }).strict()).max(500),
    serverTime: wireNonnegativeIntegerSchema,
    notice: z.string().max(240).optional(),
    walletGold: marketIntegerSchema.optional(),
    walletVersion: marketIntegerSchema.optional()
  }),
  MASTERY_SNAPSHOT: serverFrame("MASTERY_SNAPSHOT", { masteries: wireObjectSchema }),
  CLASS_SNAPSHOT: serverFrame("CLASS_SNAPSHOT", { requestId: optionalRequestIdSchema, snapshot: wireObjectSchema }),
  DEV_PROGRESSION_ADJUSTED: serverFrame("DEV_PROGRESSION_ADJUSTED", { operationId: wireStringSchema, replayed: wireBooleanSchema, classSnapshot: wireObjectSchema, progression: progressionSnapshotSchema, masteries: wireObjectSchema.optional() }),
  CLASS_MUTATION_CONFIRMED: serverFrame("CLASS_MUTATION_CONFIRMED", { requestId: requestIdSchema, replayed: wireBooleanSchema, snapshot: wireObjectSchema, walletGold: marketIntegerSchema.optional(), walletVersion: marketIntegerSchema.optional() }),
  ABILITY_QUEUE_UPDATED: serverFrame("ABILITY_QUEUE_UPDATED", { requestId: requestIdSchema, classCombat: wireObjectSchema.nullable(), pveCombat: wireObjectSchema.nullable() }),
  CLASS_MASTERY_GRANTED: serverFrame("CLASS_MASTERY_GRANTED", { eventId: wireStringSchema, classId: z.enum(CLASS_IDS), subclassId: z.enum(SUBCLASS_IDS).nullable(), requestedXp: wireNonnegativeIntegerSchema, grantedXp: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema, previousRank: wireNonnegativeIntegerSchema, resultingRank: wireNonnegativeIntegerSchema, snapshot: wireObjectSchema }),
  XP_GRANTED: serverFrame("XP_GRANTED", { grant: wireObjectSchema }),
  LEVEL_UP: serverFrame("LEVEL_UP", { level: wireNonnegativeIntegerSchema, progression: progressionSnapshotSchema, requestId: requestIdSchema.optional(), replayed: wireBooleanSchema.optional(), premiumWallet: premiumWalletSnapshotSchema.optional() }),
  EQUIPMENT_SNAPSHOT: serverFrame("EQUIPMENT_SNAPSHOT", { equipment: equipmentSnapshotSchema }),
  ACHIEVEMENT_SNAPSHOT: serverFrame("ACHIEVEMENT_SNAPSHOT", { achievements: wireObjectSchema }),
  ACHIEVEMENT_UNLOCKED: serverFrame("ACHIEVEMENT_UNLOCKED", {
    achievementId: z.literal("bitter_blood"),
    title: wireStringSchema,
    achievements: wireObjectSchema
  }),
  EQUIPMENT_UPDATED: serverFrame("EQUIPMENT_UPDATED", { requestId: requestIdSchema, replayed: wireBooleanSchema, equipment: equipmentSnapshotSchema, progression: progressionSnapshotSchema }),
  EQUIPMENT_UPGRADE_RESULT: equipmentUpgradeResultMessageSchema,
  EQUIPMENT_ACQUIRED: equipmentAcquiredMessageSchema,
  EQUIPMENT_REPAIRED: equipmentRepairedMessageSchema,
  REPAIR_KIT_CRAFTED: repairKitCraftedMessageSchema,
  RING_OPERATION_RESULT: ringOperationResultMessageSchema,
  GEAR_SCROLLS_STATE: gearScrollsStateMessageSchema,
  COMBAT_KIT_SNAPSHOT: combatKitSnapshotMessageSchema,
  COMBAT_KIT_ACTIVATED: combatKitActivatedMessageSchema,
  COMBAT_KIT_INVALIDATED: combatKitInvalidatedMessageSchema,
} satisfies Record<CombatEquipmentServerMessage["type"], z.ZodTypeAny>;
