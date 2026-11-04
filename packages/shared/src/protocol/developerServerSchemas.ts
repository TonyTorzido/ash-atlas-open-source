import { z } from "zod";

import { marketIntegerSchema } from "../marketProtocol.js";
import { premiumWalletSnapshotSchema } from "../premiumCurrency.js";
import { combatServerMessageSchema } from "./combatEquipmentServerSchemas.js";
import type { DeveloperServerMessage } from "./developerMessages.js";
import { dungeonServerMessageSchemas } from "./dungeonServerSchemas.js";
import {
  inventoryServerSchema,
  citySnapshotServerSchema,
  flagSnapshotServerSchema,
  playerSnapshotServerSchema,
  requestIdSchema,
  serverFrame,
  wireBooleanSchema,
  wireNonnegativeIntegerSchema,
  wireNumberSchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";

export const developerServerMessageSchemas = {
  DEV_DUNGEON_ENTRANCES_SNAPSHOT: serverFrame("DEV_DUNGEON_ENTRANCES_SNAPSHOT", {
    requestId: requestIdSchema,
    entrances: dungeonServerMessageSchemas.DUNGEON_ENTRANCES.shape.entrances
  }),
  DEV_DUNGEON_ENTRANCE_SPAWNED: serverFrame("DEV_DUNGEON_ENTRANCE_SPAWNED", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    entrance: dungeonServerMessageSchemas.DUNGEON_ENTRANCES.shape.entrances.element
  }),
  DEV_DUNGEON_ENTRANCE_DELETED: serverFrame("DEV_DUNGEON_ENTRANCE_DELETED", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    entranceId: wireStringSchema
  }),
  DEV_GOBLIN_VILLAGES_SNAPSHOT: serverFrame("DEV_GOBLIN_VILLAGES_SNAPSHOT", {
    villages: z.array(z.object({
      cityId: z.string().uuid(),
      name: wireStringSchema,
      hallLat: wireNumberSchema,
      hallLon: wireNumberSchema,
      flagCount: wireNonnegativeIntegerSchema,
      createdAt: wireStringSchema
    }).strict())
  }),
  DEV_GOBLIN_VILLAGE_DELETED: serverFrame("DEV_GOBLIN_VILLAGE_DELETED", {
    requestId: requestIdSchema,
    result: z.object({
      replayed: wireBooleanSchema,
      city: z.object({
        cityId: z.string().uuid(),
        name: wireStringSchema,
        hallLat: wireNumberSchema,
        hallLon: wireNumberSchema
      }).strict(),
      removedFlagIds: z.array(z.string().uuid()),
      structureIds: z.array(z.string().uuid()),
      affectedZoneIds: z.array(wireStringSchema)
    }).strict()
  }),
  DEV_GOBLIN_VILLAGE_SPAWNED: serverFrame("DEV_GOBLIN_VILLAGE_SPAWNED", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    city: citySnapshotServerSchema,
    flags: z.array(flagSnapshotServerSchema).length(19),
    market: z.record(z.string(), z.unknown())
  }),
  DEV_TERRITORY_COLLAPSE_RESULT: serverFrame("DEV_TERRITORY_COLLAPSE_RESULT", {
    requestId: requestIdSchema,
    kind: z.enum(["city", "kingdom"]),
    targetId: wireStringSchema,
    name: wireStringSchema,
    collapseId: wireStringSchema,
    flagCount: wireNonnegativeIntegerSchema
  }),
  DEV_CAPITAL_FOUNDING_RESULT: serverFrame("DEV_CAPITAL_FOUNDING_RESULT", {
    requestId: requestIdSchema,
    dryRun: wireBooleanSchema,
    replayed: wireBooleanSchema,
    plan: z.record(z.string(), z.unknown()),
    city: citySnapshotServerSchema.nullable()
  }),
  DEV_CLASS_COOLDOWNS_RESET: serverFrame("DEV_CLASS_COOLDOWNS_RESET", {
    requestId: requestIdSchema,
    serverTime: wireNumberSchema
  }),
  DEV_ASSETS_GRANTED: serverFrame("DEV_ASSETS_GRANTED", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    walletGold: marketIntegerSchema,
    walletVersion: marketIntegerSchema.optional(),
    premiumWallet: premiumWalletSnapshotSchema.optional(),
    inventory: inventoryServerSchema,
    cityCoins: z.object({
      creditedAmount: z.number().int().positive(),
      cityId: z.string().uuid(),
      cityName: z.string().min(1),
      treasuryBalance: marketIntegerSchema,
      playerContribution: marketIntegerSchema
    }).strict().nullable(),
    grants: z.array(z.object({
      itemId: z.string().min(1),
      requestedQuantity: z.number().int().positive(),
      grantedQuantity: z.number().int().nonnegative(),
      remainderQuantity: z.number().int().nonnegative()
    }))
  }),
  DEV_MOB_SPAWNED: combatServerMessageSchema,
  DEV_MOBS_CLEARED: combatServerMessageSchema,
  DEV_PLANT_SPAWNED: serverFrame("DEV_PLANT_SPAWNED", {
    requestId: requestIdSchema,
    plantEntityId: wireStringSchema,
    plantKey: wireStringSchema
  }),
  DEV_PLANTS_CLEARED: serverFrame("DEV_PLANTS_CLEARED", {
    requestId: requestIdSchema,
    removedCount: wireNonnegativeIntegerSchema
  }),
  DEV_TEST_FLAG_SPAWNED: serverFrame("DEV_TEST_FLAG_SPAWNED", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    targetKind: z.enum(["soft_flag", "bastion_flag", "tower"]),
    flag: flagSnapshotServerSchema
  }),
  DEV_TEST_UNIT_SPAWNED: serverFrame("DEV_TEST_UNIT_SPAWNED", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    unitType: z.enum(["field_ballista", "bomber", "archer", "infantry"]),
    unitId: z.string().uuid(),
    groupId: z.string().uuid()
  }),
  DEV_TELEPORT_COMPLETED: serverFrame("DEV_TELEPORT_COMPLETED", { requestId: requestIdSchema, player: playerSnapshotServerSchema, packageId: wireStringSchema, zoneId: wireStringSchema, resourceVisionRevision: wireNonnegativeIntegerSchema.optional(), serverTime: wireNumberSchema }),
  DEV_MINE_VISIT_COMPLETED: serverFrame("DEV_MINE_VISIT_COMPLETED", { requestId: requestIdSchema, mineId: wireStringSchema, flagId: wireStringSchema, player: playerSnapshotServerSchema, serverTime: wireNumberSchema }),
} satisfies Record<DeveloperServerMessage["type"], z.ZodTypeAny>;
