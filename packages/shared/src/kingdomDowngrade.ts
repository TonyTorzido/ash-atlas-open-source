import { z } from "zod";

import {
  GLIMMER_OIL_ITEM_ID,
  KINGDOM_BRICK_FURNACE_MAX_LEVEL,
  kingdomBrickFurnaceLevel
} from "./kingdomBricks.js";
import {
  KINGDOM_COMMAND_BOARD_MAX_LEVEL,
  kingdomCommandBoardLevel,
  kingdomCommandBoardMaterials
} from "./kingdomWar.js";
import {
  KINGDOM_OBELISK_MAX_LEVEL,
  KINGDOM_TOWER_MAX_LEVEL,
  kingdomStructureBuildCost
} from "./structureWarfare.js";

/*
 * Kingdom structure downgrade. The leader takes a Kingdom Tower, Obelisk,
 * Brick Furnace or Command Board down one level; the kingdom treasury gets
 * back 45% (rounded down) of every material of the step being removed,
 * wherever that step was
 * paid from. Level 1 is the floor: removing a structure is not a downgrade.
 */
export const KINGDOM_DOWNGRADE_REFUND_PERCENT = 45;
export const KINGDOM_DOWNGRADE_STRUCTURES = ["kingdom_tower", "obelisk", "brick_furnace", "command_board"] as const;
export type KingdomDowngradeStructure = (typeof KINGDOM_DOWNGRADE_STRUCTURES)[number];

export type KingdomDowngradeRefundLine = Readonly<{ itemId: string; quantity: number }>;

export function kingdomDowngradeStructureMaxLevel(structure: KingdomDowngradeStructure): number {
  switch (structure) {
    case "kingdom_tower": return KINGDOM_TOWER_MAX_LEVEL;
    case "obelisk": return KINGDOM_OBELISK_MAX_LEVEL;
    case "brick_furnace": return KINGDOM_BRICK_FURNACE_MAX_LEVEL;
    case "command_board": return KINGDOM_COMMAND_BOARD_MAX_LEVEL;
  }
}

/**
 * The refund for taking `structure` from `fromLevel` to `fromLevel - 1`:
 * 45% of each material of the `fromLevel` build step, rounded down, with
 * empty lines dropped. Null when `fromLevel` cannot be downgraded.
 */
export function kingdomStructureDowngradeRefund(
  structure: KingdomDowngradeStructure,
  fromLevel: number
): KingdomDowngradeRefundLine[] | null {
  if (!Number.isSafeInteger(fromLevel) || fromLevel < 2) return null;
  let step: Array<{ itemId: string; quantity: number }>;
  if (structure === "kingdom_tower" || structure === "obelisk") {
    const cost = kingdomStructureBuildCost(structure, fromLevel);
    if (!cost) return null;
    step = [{ itemId: "bricks", quantity: cost.bricks }, { itemId: cost.materialItemId, quantity: cost.materialQuantity }];
  } else if (structure === "brick_furnace") {
    const level = kingdomBrickFurnaceLevel(fromLevel);
    if (!level) return null;
    step = [{ itemId: GLIMMER_OIL_ITEM_ID, quantity: level.upgradeGlimmerOil }];
  } else {
    const level = kingdomCommandBoardLevel(fromLevel);
    if (!level) return null;
    step = kingdomCommandBoardMaterials(level).map((line) => ({ ...line }));
  }
  return step
    .map((line) => Object.freeze({
      itemId: line.itemId,
      quantity: Math.floor((line.quantity * KINGDOM_DOWNGRADE_REFUND_PERCENT) / 100)
    }))
    .filter((line) => line.quantity > 0);
}

export const kingdomStructureDowngradeInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  structure: z.enum(KINGDOM_DOWNGRADE_STRUCTURES),
  /** The Kingdom Flag holding the Kingdom Tower or Obelisk; omitted for the Brick Furnace and Command Board. */
  flagId: z.string().uuid().optional(),
  /** The level the leader saw; a structure that changed meanwhile is refused rather than refunded differently. */
  fromLevel: z.number().int().min(2).max(5)
}).strict().superRefine((input, context) => {
  const onFlag = input.structure === "kingdom_tower" || input.structure === "obelisk";
  if (onFlag !== (input.flagId !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["flagId"],
      message: onFlag ? "A Kingdom Tower or Obelisk downgrade names its flag" : "Only a Kingdom Tower or Obelisk names a flag"
    });
  }
  if (input.fromLevel > kingdomDowngradeStructureMaxLevel(input.structure)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fromLevel"], message: "That level does not exist" });
  }
});

export type KingdomStructureDowngradeInput = z.infer<typeof kingdomStructureDowngradeInputSchema>;
