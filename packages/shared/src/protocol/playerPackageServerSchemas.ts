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
import type { PlayerPackageServerMessage } from "./playerPackageMessages.js";

const packageItemSchema = z.object({
  lineNumber: z.number().int().positive(),
  itemKind: z.enum([
    "resource",
    "consumable",
    "equipment",
    "gold",
    "city_coins"
  ]),
  itemId: z.string().min(1).max(120),
  variant: z.string().min(1).max(80).nullable(),
  displayName: z.string().min(1).max(160),
  iconKey: z.string().min(1).max(120),
  category: z.string().min(1).max(120),
  originalQuantity: z.number().int().positive(),
  remainingQuantity: z.number().int().nonnegative()
}).strict();

export const playerPackageSnapshotSchema = z.object({
  packageId: z.string().uuid(),
  campaignId: z.string().uuid(),
  title: z.string().min(1).max(80),
  message: z.string().max(280),
  sender: z.string().min(1).max(80),
  kind: z.enum(["admin", "player_gift"]),
  senderPlayerId: z.string().min(1).max(160).nullable(),
  status: z.enum(["unopened", "partial", "claimed"]),
  readAt: z.string().datetime().nullable(),
  firstClaimedAt: z.string().datetime().nullable(),
  claimedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  revision: z.string().regex(/^\d+$/),
  items: z.array(packageItemSchema).max(24)
}).strict();

const claimLineSchema = z.object({
  lineNumber: z.number().int().positive(),
  itemKind: z.enum([
    "resource",
    "consumable",
    "equipment",
    "gold",
    "city_coins"
  ]),
  itemId: z.string().min(1).max(120),
  variant: z.string().min(1).max(80).nullable(),
  requestedQuantity: z.number().int().positive(),
  grantedQuantity: z.number().int().nonnegative(),
  remainingQuantity: z.number().int().nonnegative(),
  status: z.enum([
    "granted",
    "partially_granted",
    "blocked_city_membership",
    "blocked_inventory_capacity",
    "already_consumed"
  ]),
  blockedReason: z.enum([
    "CITY_MEMBERSHIP_REQUIRED",
    "INVENTORY_CAPACITY"
  ]).nullable()
}).strict();

const cityCreditSchema = z.object({
  creditedAmount: z.number().int().positive(),
  cityId: z.string().uuid(),
  cityName: z.string().min(1),
  treasuryBalance: marketIntegerSchema,
  playerContribution: marketIntegerSchema
}).strict();

export const playerPackageServerMessageSchemas = {
  PLAYER_PACKAGES_SNAPSHOT: serverFrame("PLAYER_PACKAGES_SNAPSHOT", {
    requestId: requestIdSchema.optional(),
    packages: z.array(playerPackageSnapshotSchema)
  }),
  PLAYER_PACKAGE_AVAILABLE: serverFrame("PLAYER_PACKAGE_AVAILABLE", {
    package: playerPackageSnapshotSchema
  }),
  PLAYER_PACKAGE_CLAIM_RESULT: serverFrame("PLAYER_PACKAGE_CLAIM_RESULT", {
    requestId: requestIdSchema,
    replayed: wireBooleanSchema,
    walletGold: marketIntegerSchema,
    walletVersion: marketIntegerSchema.optional(),
    cityCredit: cityCreditSchema.nullable(),
    inventory: inventoryServerSchema,
    equipment: equipmentSnapshotSchema,
    package: playerPackageSnapshotSchema,
    lines: z.array(claimLineSchema).max(24),
    message: wireStringSchema
  }),
  PLAYER_PACKAGE_ERROR: serverFrame("PLAYER_PACKAGE_ERROR", {
    requestId: requestIdSchema,
    code: wireStringSchema,
    message: wireStringSchema,
    packageId: z.string().uuid().optional(),
    currentPackage: playerPackageSnapshotSchema.optional()
  })
} satisfies Record<PlayerPackageServerMessage["type"], z.ZodTypeAny>;
