import { z } from "zod";

const requestIdSchema = z.string().min(1).max(120);
const instanceIdSchema = z.string().uuid();
const equippedSlotSchema = z.number().int().min(0).max(3);

/** Canonical Crafting-menu recipe: creates one Backpack +0 in Player Inventory. */
export const craftBackpackMessageSchema = z.object({
  type: z.literal("CRAFT_BACKPACK"),
  requestId: requestIdSchema
}).strict();

export const createStarterBackpackMessageSchema = z.object({
  type: z.literal("CREATE_STARTER_BACKPACK"),
  requestId: requestIdSchema,
  targetEquippedSlot: equippedSlotSchema
}).strict();

export const equipBackpackMessageSchema = z.object({
  type: z.literal("EQUIP_BACKPACK"),
  requestId: requestIdSchema,
  instanceId: instanceIdSchema,
  targetEquippedSlot: equippedSlotSchema
}).strict();

export const unequipBackpackMessageSchema = z.object({
  type: z.literal("UNEQUIP_BACKPACK"),
  requestId: requestIdSchema,
  instanceId: instanceIdSchema
}).strict();

export const upgradeBackpackMessageSchema = z.object({
  type: z.literal("UPGRADE_BACKPACK"),
  requestId: requestIdSchema,
  instanceId: instanceIdSchema
}).strict();
