import { BASIC_ATTACK_INTERVAL_MS } from "./combatConstants.js";
import { MONOLITH_DISCOVERY_SPARKS, MONOLITH_SPARK_ITEM_ID } from "./monoliths.js";
import { WORLD_KNOWLEDGE_SKILL_DEFINITIONS } from "./skillSystemV3.js";
import { ZEPHYR_ALTAR_COST, ZEPHYR_ALTAR_SKILL_ID, ZEPHYR_ITEM_ID } from "./stillHandMonastery.js";

/**
 * Dungeon tokens discover World Knowledge skills (the dungeon-token loop): turning in the tokens
 * reveals the skill once per player, then each of its three ranks costs 1 General Skill Point. The
 * ranks and their descriptions live in `WORLD_KNOWLEDGE_SKILL_DEFINITIONS`; this module holds the
 * turn-in table and the numbers the server applies for each rank.
 */
export const DUNGEON_SKILL_IDS = ["deepstone_lore", "wildkin_lore", "grove_lore", "edict_stride", "tidecraft", "field_engineering", "rare_beast_mastery"] as const;
export type DungeonSkillId = (typeof DUNGEON_SKILL_IDS)[number];

export type DungeonSkillTurnIn = Readonly<{
  id: DungeonSkillId;
  /** Inventory item consumed by the turn-in. */
  tokenItemId: string;
  tokenCost: number;
  /** Single PNG under apps/client/public (these icons are not part of the progression atlases). */
  iconPath: string;
  dungeonId: string;
}>;

export const DUNGEON_SKILL_TURN_INS: Readonly<Record<DungeonSkillId, DungeonSkillTurnIn>> = {
  deepstone_lore: { id: "deepstone_lore", dungeonId: "fangrock_cavern", tokenItemId: "raptor_scale", tokenCost: 6, iconPath: "assets/skills/new/deepstone-lore.png" },
  // Temporary: until Hollin Huts exist the Eyrie egg nest takes the Giant Eggs.
  wildkin_lore: { id: "wildkin_lore", dungeonId: "the_eyrie", tokenItemId: "giant_egg", tokenCost: 6, iconPath: "assets/skills/new/hollin-lore.png" },
  grove_lore: { id: "grove_lore", dungeonId: "blightwood_grove", tokenItemId: "elder_acorn", tokenCost: 28, iconPath: "assets/skills/new/grove-lore.png" },
  // Reuses the Deepstone icon until Edict Stride has its own art.
  edict_stride: { id: "edict_stride", dungeonId: "fallen_prison", tokenItemId: "edict_seal", tokenCost: 440, iconPath: "assets/skills/new/deepstone-lore.png" },
  rare_beast_mastery: { id: "rare_beast_mastery", dungeonId: "wyrm_hollow", tokenItemId: "wyrm_egg", tokenCost: 6, iconPath: "assets/skills/new/rare-beast-mastery.png" },
  // Presented at a Drowned City site on the open sea (the dungeon itself is phase E).
  tidecraft: { id: "tidecraft", dungeonId: "drowned_city", tokenItemId: "abyssal_orb", tokenCost: 20, iconPath: "assets/skills/new/tidecraft.png" },
  // The Spark Forge altar in the Golem Forge hub; discovery happens nowhere else.
  field_engineering: { id: "field_engineering", dungeonId: "golem_forge", tokenItemId: MONOLITH_SPARK_ITEM_ID, tokenCost: MONOLITH_DISCOVERY_SPARKS, iconPath: "assets/skills/new/field-engineering.png" }
};

/** Every token turn-in a dungeon object can take: the World Knowledge discoveries plus the Zephyr Altar. */
export const DUNGEON_TURN_IN_IDS = [...DUNGEON_SKILL_IDS, ZEPHYR_ALTAR_SKILL_ID] as const;
export type DungeonTurnInId = (typeof DUNGEON_TURN_IN_IDS)[number];

/** The Zephyr Altar in the Monastery of the Still Hand unlocks the general skill Perfect Strike. */
export const ZEPHYR_ALTAR_TURN_IN = Object.freeze({
  skillId: ZEPHYR_ALTAR_SKILL_ID,
  tokenItemId: ZEPHYR_ITEM_ID,
  tokenCost: ZEPHYR_ALTAR_COST,
  dungeonId: "still_hand_monastery"
});

export function dungeonSkillName(id: DungeonSkillId): string {
  return WORLD_KNOWLEDGE_SKILL_DEFINITIONS[id].displayName;
}

export function isDungeonSkillId(value: unknown): value is DungeonSkillId {
  return typeof value === "string" && (DUNGEON_SKILL_IDS as readonly string[]).includes(value);
}

/** Skill ranks by World Knowledge id (0 = not learned). */
export type DungeonSkillRanks = Readonly<Partial<Record<string, number>>>;

const rankIndex = (rank: number | undefined): 0 | 1 | 2 | 3 =>
  (Math.max(0, Math.min(3, Math.trunc(rank ?? 0))) as 0 | 1 | 2 | 3);

/** Deepstone Lore: double-yield chance when mining, by rank. */
export const DEEPSTONE_DOUBLE_YIELD_CHANCE = [0, 0.12, 0.22, 0.28] as const;
export const DEEPSTONE_MINED_RESOURCES: ReadonlySet<string> = new Set(["stone", "ore", "sulfur", "coal", "iron"]);
/** Rank 3 only: chance per mined harvest of one rare material. */
export const DEEPSTONE_RARE_FIND_CHANCE = 0.0085;
/** Rare pool: Lichen, Dusk Heart, Umbral Essence, Thistle. */
/** Rare-find entry that grants a random ring (Plain or Fine, rings.ts 1-9 row) instead of an item. */
export const DEEPSTONE_RING_FIND_ID = "deepstone_ring";
export const DEEPSTONE_RARE_FIND_POOL: readonly string[] = ["lichen", "dusk_heart", "umbral_essence", "thistle", DEEPSTONE_RING_FIND_ID];

/** Independent rare finds on ordinary harvests, rolled for every player (no skill needed). */
export const HARVEST_RARE_FINDS: Readonly<Record<string, Readonly<{ itemId: string; chance: number }>>> = {
  wood: { itemId: "lichen", chance: 0.005 },
  flax_fiber: { itemId: "thistle", chance: 0.01 },
  stone: { itemId: "skyrise_stone", chance: 0.0025 },
  ore: { itemId: "skyrise_stone", chance: 0.0025 },
  sulfur: { itemId: "skyrise_stone", chance: 0.0025 },
  coal: { itemId: "skyrise_stone", chance: 0.0025 },
  iron: { itemId: "skyrise_stone", chance: 0.0025 }
};

/** Grove Lore: harvest double-yield chance (wood and plants), heal-aura radius and tree companions, by rank. */
export const GROVE_DOUBLE_YIELD_CHANCE = [0, 0.06, 0.11, 0.17] as const;
export const GROVE_HARVESTED_RESOURCES: ReadonlySet<string> = new Set(["wood", "flax_fiber"]);
export const GROVE_AURA_RADIUS_M = [0, 165, 240, 380] as const;
export const GROVE_TREE_COMPANIONS = [0, 1, 3, 4] as const;

/** Chance that a harvest of `resourceType` yields double for a player with these skill ranks. */
export function harvestDoubleYieldChance(ranks: DungeonSkillRanks, resourceType: string): number {
  let chance = 0;
  if (DEEPSTONE_MINED_RESOURCES.has(resourceType)) chance = Math.max(chance, DEEPSTONE_DOUBLE_YIELD_CHANCE[rankIndex(ranks.deepstone_lore)]);
  if (GROVE_HARVESTED_RESOURCES.has(resourceType)) chance = Math.max(chance, GROVE_DOUBLE_YIELD_CHANCE[rankIndex(ranks.grove_lore)]);
  return chance;
}

/** Rare-find chance when mining `resourceType` (Deepstone Lore rank 3). */
export function deepstoneRareFindChance(ranks: DungeonSkillRanks, resourceType: string): number {
  return rankIndex(ranks.deepstone_lore) >= 3 && DEEPSTONE_MINED_RESOURCES.has(resourceType) ? DEEPSTONE_RARE_FIND_CHANCE : 0;
}

/** Grove Lore aura radius for a rank; the Grove's temporary aura counts as rank 1. */
export function groveAuraRadiusM(rank: number, insideGrove: boolean): number {
  return GROVE_AURA_RADIUS_M[Math.max(rankIndex(rank), insideGrove ? 1 : 0) as 0 | 1 | 2 | 3];
}

/**
 * Rare Beast Mastery against dragons (PvE): Defense +1/+1/+2 and Attack +0/+1/+2 by rank. Max health lives
 * in skillSystemV3 (RARE_BEAST_MASTERY_MAX_HEALTH); the Ember Drake's longer outings in petSystem.
 */
export const RARE_BEAST_DRAGON_ARCHETYPES: ReadonlySet<string> = new Set([
  "drakeling", "ash_wyvern", "drake_broodguard", "elder_dragon",
  // Overworld dragons count too (every dragon).
  "ash_drake", "ember_dragon"
]);

const RARE_BEAST_DRAGON_DEFENSE = [0, 1, 1, 2] as const;
const RARE_BEAST_DRAGON_ATTACK = [0, 0, 1, 2] as const;

export function rareBeastDragonDefenseBonus(rank: number, archetypeKey: string | null | undefined): number {
  return archetypeKey && RARE_BEAST_DRAGON_ARCHETYPES.has(archetypeKey) ? RARE_BEAST_DRAGON_DEFENSE[rankIndex(rank)] : 0;
}

export function rareBeastDragonAttackBonus(rank: number, archetypeKey: string | null | undefined): number {
  return archetypeKey && RARE_BEAST_DRAGON_ARCHETYPES.has(archetypeKey) ? RARE_BEAST_DRAGON_ATTACK[rankIndex(rank)] : 0;
}

/**
 * Edict Stride: an active, targeted World Knowledge skill. After activation it waits up to `armWindowMs` for
 * the target to move, then for `effectMs` damages the target on every move by `damagePer100m` per 100 m travelled.
 * Rank 2 rolls 4-9 (6.5 on average) each time it triggers. Each use costs `sealCost` Edict Seals.
 */
export const EDICT_STRIDE = Object.freeze({
  sealCost: 2,
  armWindowMs: 12_000,
  effectMs: 6_000,
  cooldownMs: [0, 135_000, 100_000, 70_000] as const,
  damagePer100m: [[0, 0], [4, 4], [4, 9], [9, 9]] as readonly (readonly [number, number])[]
});

/** Damage for `movedM` metres of target movement; `roll` is a 0-1 random number. */
export function edictStrideDamage(rank: number, movedM: number, roll: number): number {
  const [low, high] = EDICT_STRIDE.damagePer100m[rankIndex(rank)]!;
  return (low + (high - low) * roll) * Math.max(0, movedM) / 100;
}

/**
 * Grove aura: heal this fraction of max health every tick, for the holder and party within range.
 * One beat per tick (the 1.4 s environment); 0.8% of max health per beat.
 */
export const GROVE_AURA_TICK_MS = BASIC_ATTACK_INTERVAL_MS;
export const GROVE_AURA_HEAL_FRACTION = 0.008;
/** Everyone inside this dungeon has the Grove Lore rank 1 aura (without the harvest bonus). */
export const GROVE_LORE_GROVE_DUNGEON_ID = "blightwood_grove";
/** Standing in a `heal` zone (the Healing Spring) heals this fraction of max health per tick. */
export const HEAL_ZONE_TICK_MS = BASIC_ATTACK_INTERVAL_MS;
/** 2.3% of max health per beat. */
export const HEAL_ZONE_HEAL_FRACTION = 0.023;
