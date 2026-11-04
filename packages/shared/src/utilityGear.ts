import type { ResourceType } from "./collectibles.js";
import type { TradeSkillGateId } from "./tradeSkills.js";

/**
 * Utility gear: gloves and boots crafted only by Atlas Pass members, usable by anyone. Each
 * carried item has a finite number of uses tracked on the server (`uses_remaining`); it is
 * destroyed at 0, cannot be repaired and takes no normal wear. It can only be put on or taken off
 * while the player is at home (inside their own House, Manor House or City House).
 */
export const UTILITY_GEAR_DEFINITION_IDS = ["lumber_glove", "delver_glove", "artisan_glove", "lodestone_boot", "coinwright_glove", "tiller_boot", "pathfinder_boot"] as const;
export type UtilityGearDefinitionId = (typeof UTILITY_GEAR_DEFINITION_IDS)[number];

export type UtilityGearSpec = Readonly<{
  definitionId: UtilityGearDefinitionId;
  displayName: string;
  slot: "gloves" | "boots";
  uses: number;
  /** Crafting is limited to Atlas Pass members (the Lumen items). False for ordinary crafted gear. */
  atlasPassOnly: boolean;
  /** Gold paid on crafting (ordinary gear only). */
  goldCost?: number;
  /** Trade skill rank needed to craft it (ordinary gear only). */
  tradeGate?: TradeSkillGateId;
  description: string;
  materials: readonly Readonly<{ itemId: ResourceType; quantity: number }>[];
}>;

/** While a glove that sets action time is worn, the action takes exactly this long. */
export const UTILITY_GEAR_ACTION_DURATION_MS = 1000;

export const UTILITY_GEAR: Readonly<Record<UtilityGearDefinitionId, UtilityGearSpec>> = Object.freeze({
  lumber_glove: Object.freeze({
    definitionId: "lumber_glove",
    displayName: "Lumber Glove",
    slot: "gloves",
    uses: 120,
    atlasPassOnly: true,
    description: "Chopping a tree takes 1 second. One use per completed chop.",
    materials: Object.freeze([
      { itemId: "lumen", quantity: 12 },
      { itemId: "leather", quantity: 4 },
      { itemId: "cloth", quantity: 3 }
    ] as const)
  }),
  delver_glove: Object.freeze({
    definitionId: "delver_glove",
    displayName: "Delver Glove",
    slot: "gloves",
    uses: 90,
    atlasPassOnly: true,
    description: "Mining takes 1 second but earns no trade or skill XP. One use per completed mine.",
    materials: Object.freeze([
      { itemId: "lumen", quantity: 4 },
      { itemId: "leather", quantity: 3 },
      { itemId: "cloth", quantity: 5 }
    ] as const)
  }),
  artisan_glove: Object.freeze({
    definitionId: "artisan_glove",
    displayName: "Artisan Glove",
    slot: "gloves",
    uses: 110,
    atlasPassOnly: true,
    description: "Crafting and smelting take 1 second each, at home only. One use per operation started.",
    materials: Object.freeze([
      { itemId: "lumen", quantity: 5 },
      { itemId: "leather", quantity: 4 },
      { itemId: "cloth", quantity: 5 }
    ] as const)
  }),
  lodestone_boot: Object.freeze({
    definitionId: "lodestone_boot",
    displayName: "Lodestone Boot",
    slot: "boots",
    uses: 360,
    atlasPassOnly: true,
    description: "Walking near plain +0 weapons and armor you may pick up dumps them for their gold. One use per item.",
    materials: Object.freeze([
      { itemId: "lumen", quantity: 3 },
      { itemId: "leather", quantity: 4 },
      { itemId: "cloth", quantity: 3 },
      { itemId: "slag", quantity: 3 }
    ] as const)
  }),
  coinwright_glove: Object.freeze({
    definitionId: "coinwright_glove",
    displayName: "Coinwright Glove",
    slot: "gloves",
    uses: 90,
    atlasPassOnly: false,
    goldCost: 290,
    tradeGate: "craft_coinwright_glove",
    description: "+22% gold from every item you dump, rounded down per item. 1% wear per dump, cannot be repaired.",
    materials: Object.freeze([
      { itemId: "cloth", quantity: 5 },
      { itemId: "leather", quantity: 4 }
    ] as const)
  }),
  tiller_boot: Object.freeze({
    definitionId: "tiller_boot",
    displayName: "Tiller Boot",
    slot: "boots",
    uses: 2400,
    atlasPassOnly: true,
    description: "A pool of 2,400 uses: planting a sapling costs 12, tending one costs 1. Plants 3x3 and tends your saplings as you walk by.",
    materials: Object.freeze([
      { itemId: "lumen", quantity: 11 },
      { itemId: "leather", quantity: 4 },
      { itemId: "cloth", quantity: 3 },
      { itemId: "balsam_resin", quantity: 2 }
    ] as const)
  }),
  pathfinder_boot: Object.freeze({
    definitionId: "pathfinder_boot",
    displayName: "Pathfinder Boot",
    slot: "boots",
    uses: 130,
    atlasPassOnly: true,
    description: "Mark a building you may visit to add it to your travel destinations for 31 hours. One use per mark; a new mark replaces the old one.",
    materials: Object.freeze([
      { itemId: "lumen", quantity: 6 },
      { itemId: "leather", quantity: 4 },
      { itemId: "cloth", quantity: 3 },
      { itemId: "balsam_resin", quantity: 2 }
    ] as const)
  })
});

/** How long an Pathfinder Boot mark keeps its building on the travel list. */
export const PATHFINDER_MARK_DURATION_MS = 31 * 60 * 60_000;

/** Tiller Boot pool costs. */
export const TILLER_PLANT_USE_COST = 12;
export const TILLER_TEND_USE_COST = 1;

/** Percent added to the gold an NPC pays for each dumped item while a Coinwright Glove is worn. */
export const COINWRIGHT_GLOVE_BONUS_PERCENT = 22;
/** The bonus on one item's gold, rounded down (a 4-gold item gains nothing). */
export function coinwrightBonusGold(unitGold: number): number {
  return Math.floor((unitGold * COINWRIGHT_GLOVE_BONUS_PERCENT) / 100);
}

export function isUtilityGearDefinitionId(value: unknown): value is UtilityGearDefinitionId {
  return typeof value === "string" && (UTILITY_GEAR_DEFINITION_IDS as readonly string[]).includes(value);
}
