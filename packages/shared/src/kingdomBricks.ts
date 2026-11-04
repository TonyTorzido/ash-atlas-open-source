import { z } from "zod";

import {
  KINGDOM_OBELISK_LADDER,
  KINGDOM_OBELISK_MAX_LEVEL
} from "./structureWarfare.js";

/*
 * Bricks: the kingdom building material. Players carry Bricks as an ordinary inventory item and
 * deposit them into their kingdom's treasury; every deposit is taxed 12%
 * and the tax is destroyed, never kept by anyone.
 */
export const BRICKS_ITEM_ID = "bricks" as const;
export const KINGDOM_BRICK_TAX_PERCENT = 12;
/** Largest single deposit; matches the treasury donation cap. */
export const KINGDOM_BRICK_DEPOSIT_MAX = 1_000_000;

export type KingdomBrickDepositSplit = Readonly<{ quantity: number; tax: number; credited: number }>;

/**
 * Tax is rounded up so splitting a deposit into small pieces never avoids
 * it. Returns null when nothing would reach the treasury (1 Brick).
 */
export function kingdomBrickDepositSplit(quantity: number): KingdomBrickDepositSplit | null {
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > KINGDOM_BRICK_DEPOSIT_MAX) return null;
  const tax = Math.ceil((quantity * KINGDOM_BRICK_TAX_PERCENT) / 100);
  const credited = quantity - tax;
  return credited > 0 ? Object.freeze({ quantity, tax, credited }) : null;
}

/*
 * Brick yield (tunable). Each completed gather and each mob kill on kingdom land has
 * a KINGDOM_BRICK_YIELD_CHANCE roll; a hit drops KINGDOM_BRICK_YIELD_BASE
 * Bricks into the player's carried inventory, multiplied by the strongest
 * obelisk of that kingdom within 550 m (x1..x5 non-members, x2..x8
 * members). Without an obelisk the yield is the base x1. Bricks land in the
 * player's pack, not the treasury, so the 12% deposit tax and war-death
 * carried-brick losses apply to them.
 */
export const KINGDOM_BRICK_YIELD_CHANCE = 0.1;
export const KINGDOM_BRICK_YIELD_BASE = 1;

export function kingdomBrickYieldMultiplier(obeliskLevel: number | null, member: boolean): number {
  if (obeliskLevel === null || !Number.isSafeInteger(obeliskLevel) || obeliskLevel < 1) return 1;
  const rung = KINGDOM_OBELISK_LADDER[Math.min(KINGDOM_OBELISK_MAX_LEVEL, obeliskLevel) - 1]!;
  return member ? rung.memberYieldMultiplier : rung.nonMemberYieldMultiplier;
}

/**
 * Bricks for one yield roll in [0, 1); 0 when the roll misses. `chance` is the
 * roll's hit chance: the normal 10%, or Boundary Writ's 25% on war land.
 */
export function kingdomBrickYieldQuantity(
  roll: number,
  obeliskLevel: number | null,
  member: boolean,
  chance: number = KINGDOM_BRICK_YIELD_CHANCE
): number {
  if (!(roll >= 0 && roll < chance)) return 0;
  return KINGDOM_BRICK_YIELD_BASE * kingdomBrickYieldMultiplier(obeliskLevel, member);
}

/*
 * Brick Furnace (the upgrade cost and the package price are both paid in Glimmer Oil). A kingdom
 * facility, levels 1..3. Once every 20 hours per kingdom one member buys the
 * level's brick package with their own carried Glimmer Oil; the Bricks go
 * straight into the kingdom treasury (no deposit tax).
 */
export const GLIMMER_OIL_ITEM_ID = "refined_oil" as const;
export const KINGDOM_BRICK_FURNACE_MAX_LEVEL = 3;
export const KINGDOM_BRICK_FURNACE_PACKAGE_COOLDOWN_MS = 20 * 60 * 60 * 1_000;
export const KINGDOM_BRICK_FURNACE_LEVELS = Object.freeze([
  Object.freeze({ level: 1, upgradeGlimmerOil: 1_150, packageBricks: 480, packageGlimmerOil: 6 }),
  Object.freeze({ level: 2, upgradeGlimmerOil: 2_250, packageBricks: 860, packageGlimmerOil: 10 }),
  Object.freeze({ level: 3, upgradeGlimmerOil: 3_400, packageBricks: 1_300, packageGlimmerOil: 13 })
] as const);

export type KingdomBrickFurnaceLevel = (typeof KINGDOM_BRICK_FURNACE_LEVELS)[number];

export function kingdomBrickFurnaceLevel(level: number): KingdomBrickFurnaceLevel | null {
  return Number.isSafeInteger(level) && level >= 1 ? KINGDOM_BRICK_FURNACE_LEVELS[level - 1] ?? null : null;
}

export type KingdomBrickFurnaceSnapshot = {
  /** 0 until the furnace is built. */
  level: number;
  lastPackageAt: string | null;
  /** When the next package can be bought; null when one is available now (or no furnace). */
  nextPackageAt: string | null;
};

export const kingdomBrickDepositInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  quantity: z.number().int().min(2).max(KINGDOM_BRICK_DEPOSIT_MAX)
}).strict();

export const kingdomBrickFurnaceUpgradeInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  targetLevel: z.number().int().min(1).max(KINGDOM_BRICK_FURNACE_MAX_LEVEL)
}).strict();

export const kingdomBrickFurnacePackageInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  /** The furnace level the buyer saw; a stale level is refused rather than charged differently. */
  furnaceLevel: z.number().int().min(1).max(KINGDOM_BRICK_FURNACE_MAX_LEVEL)
}).strict();

export type KingdomBrickDepositInput = z.infer<typeof kingdomBrickDepositInputSchema>;
export type KingdomBrickFurnaceUpgradeInput = z.infer<typeof kingdomBrickFurnaceUpgradeInputSchema>;
export type KingdomBrickFurnacePackageInput = z.infer<typeof kingdomBrickFurnacePackageInputSchema>;
