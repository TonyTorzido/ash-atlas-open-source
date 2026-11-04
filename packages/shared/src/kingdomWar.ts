import { z } from "zod";

import { BRICKS_ITEM_ID, GLIMMER_OIL_ITEM_ID } from "./kingdomBricks.js";

/*
 * War for cities and kingdoms, part B2: the Command Board, War Towers and War
 * Outposts.
 *
 * Command Board: a kingdom facility, levels 1..3, built by the leader. Each step
 * costs Bricks, Pearl and Glimmer Oil; every material comes from the kingdom
 * treasury when it holds the full amount, otherwise from the builder's pack.
 * Its level caps the kingdom's standing War Outposts and War Towers.
 */
const PEARL_ITEM_ID = "pearl" as const;
const CRYSTAL_ITEM_ID = "crystal" as const;
const IRON_ITEM_ID = "iron" as const;

export const KINGDOM_COMMAND_BOARD_MAX_LEVEL = 3;
export const KINGDOM_COMMAND_BOARD_LEVELS = Object.freeze([
  Object.freeze({ level: 1, bricks: 108_000, pearl: 330, glimmerOil: 540, warOutposts: 1, warTowers: 9 }),
  Object.freeze({ level: 2, bricks: 218_000, pearl: 650, glimmerOil: 1_080, warOutposts: 2, warTowers: 18 }),
  Object.freeze({ level: 3, bricks: 325_000, pearl: 980, glimmerOil: 1_640, warOutposts: 3, warTowers: 27 })
] as const);

export type KingdomCommandBoardLevel = (typeof KINGDOM_COMMAND_BOARD_LEVELS)[number];

export function kingdomCommandBoardLevel(level: number): KingdomCommandBoardLevel | null {
  return Number.isSafeInteger(level) && level >= 1 ? KINGDOM_COMMAND_BOARD_LEVELS[level - 1] ?? null : null;
}

export type KingdomWarMaterial = Readonly<{ itemId: string; quantity: number }>;

/** Step cost of building the Command Board at `level`. */
export function kingdomCommandBoardMaterials(level: KingdomCommandBoardLevel): KingdomWarMaterial[] {
  return [
    { itemId: BRICKS_ITEM_ID, quantity: level.bricks },
    { itemId: PEARL_ITEM_ID, quantity: level.pearl },
    { itemId: GLIMMER_OIL_ITEM_ID, quantity: level.glimmerOil }
  ];
}

export type KingdomWarStructureKind = "war_tower" | "war_outpost";
export const KINGDOM_WAR_STRUCTURE_KINDS = ["war_tower", "war_outpost"] as const;

/** Caps unlocked by a Command Board level (0 = no Command Board: nothing may be placed). */
export function kingdomWarStructureCap(tableLevel: number, kind: KingdomWarStructureKind): number {
  const level = kingdomCommandBoardLevel(tableLevel);
  if (!level) return 0;
  return kind === "war_tower" ? level.warTowers : level.warOutposts;
}

/*
 * War Tower: as strong as a level-1 Kingdom Tower (11,500 HP, 27 h burn,
 * the same arrow). War Outpost: a forward travel point for members, with the
 * War Camp's durability (2,200 HP, 1 h burn). Gold always comes from the
 * builder's wallet; every material from the kingdom treasury when it holds
 * the full amount, otherwise from the builder's pack.
 */
export const WAR_TOWER_GOLD_COST = 11_000;
export const WAR_TOWER_MATERIALS: readonly KingdomWarMaterial[] = Object.freeze([
  Object.freeze({ itemId: CRYSTAL_ITEM_ID, quantity: 230 }),
  Object.freeze({ itemId: BRICKS_ITEM_ID, quantity: 4_500 })
]);
export const WAR_OUTPOST_GOLD_COST = 0;
export const WAR_OUTPOST_MATERIALS: readonly KingdomWarMaterial[] = Object.freeze([
  Object.freeze({ itemId: GLIMMER_OIL_ITEM_ID, quantity: 560 }),
  Object.freeze({ itemId: IRON_ITEM_ID, quantity: 240 }),
  Object.freeze({ itemId: CRYSTAL_ITEM_ID, quantity: 1_150 })
]);

export function kingdomWarStructureCost(kind: KingdomWarStructureKind): Readonly<{
  gold: number;
  materials: readonly KingdomWarMaterial[];
}> {
  return kind === "war_tower"
    ? { gold: WAR_TOWER_GOLD_COST, materials: WAR_TOWER_MATERIALS }
    : { gold: WAR_OUTPOST_GOLD_COST, materials: WAR_OUTPOST_MATERIALS };
}

/**
 * Placement rule: a War Tower or
 * Outpost goes up at the builder's position, outside every claim (the
 * database's center-outside-claim invariant), and within 2 km of the
 * territory edge of an organization the kingdom is actively at war with.
 * It is tied to that war: when the war ends it breaks.
 */
export const WAR_STRUCTURE_PLACEMENT_RANGE_M = 2_000;
/** War structures hold a footprint, not land: a 50 m claim. */
export const WAR_STRUCTURE_CLAIM_RADIUS_M = 50;

/**
 * Forward Sappers hook (perk tree, B1): flat damage added to every War
 * Tower arrow. Base 0; the perk supplies its bonus through
 * TowerVolleyHooks.warTowerAttackBonus (apps/server/src/game/towerVolleys.ts),
 * and the arrow's damage is warTowerArrowDamage(matrixDamage, bonus).
 */
export const WAR_TOWER_BASE_FLAT_ATTACK_BONUS = 0;

export function warTowerArrowDamage(matrixDamage: number, flatAttackBonus: number): number {
  const bonus = Number.isFinite(flatAttackBonus) ? Math.max(0, Math.trunc(flatAttackBonus)) : 0;
  return Math.max(1, Math.round(matrixDamage)) + WAR_TOWER_BASE_FLAT_ATTACK_BONUS + bonus;
}

export function kingdomWarStructureLabel(kind: KingdomWarStructureKind): string {
  return kind === "war_tower" ? "War Tower" : "War Outpost";
}

export type KingdomWarStructureSummary = Readonly<{
  flagId: string;
  kind: KingdomWarStructureKind;
  name: string;
  lat: number;
  lon: number;
  health: number | null;
  maximumHealth: number | null;
  burning: boolean;
  warId: string;
  enemyName: string | null;
}>;

export type KingdomCommandBoardSnapshot = {
  /** 0 until the Command Board is built. */
  level: number;
  warTowers: Readonly<{ used: number; cap: number }>;
  warOutposts: Readonly<{ used: number; cap: number }>;
  structures: KingdomWarStructureSummary[];
};

export const kingdomCommandBoardUpgradeInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  targetLevel: z.number().int().min(1).max(KINGDOM_COMMAND_BOARD_MAX_LEVEL)
}).strict();

export const kingdomWarStructurePlaceInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  kind: z.enum(KINGDOM_WAR_STRUCTURE_KINDS)
}).strict();

/*
 * War Camp health: 2,200 HP and a 1 h burn. Hand attacks
 * (25, once per 24 h), Bombers (1,150, one spent) and Siege volleys stop at
 * the 1,100 burn threshold; reaching it ignites the camp, and when the burn
 * ends the camp is removed and its garrison stands in the field.
 */
export const WAR_CAMP_MAX_HEALTH = 2_200;
export const WAR_CAMP_BURN_THRESHOLD = 1_100;
export const WAR_CAMP_BURN_DURATION_MS = 60 * 60 * 1_000;
export const WAR_CAMP_ATTACK_MODES = ["hand", "bomber", "siege"] as const;
export type WarCampAttackMode = (typeof WAR_CAMP_ATTACK_MODES)[number];

export type KingdomCommandBoardUpgradeInput = z.infer<typeof kingdomCommandBoardUpgradeInputSchema>;
export type KingdomWarStructurePlaceInput = z.infer<typeof kingdomWarStructurePlaceInputSchema>;
