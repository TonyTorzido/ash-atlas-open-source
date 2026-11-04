/**
 * Hollin Huts: huts of the Hollins, small farm folk who are masters of food (not Kippens).
 * The hut is a stationary combat mob (`hollin_hut`); this module holds the numbers, the shop stock
 * and the wire types shared by server and client. Every art key below is a normal asset key that is
 * currently drawn as a generic placeholder square, so real art only has to replace the descriptor.
 */
import { GOBLIN_MARKET_BASE_RESOURCE_UNIT_PRICES } from "./goblinMarketFloors.js";
import type { WorldZoneBiome } from "./worldZones.js";

export const HOLLIN_LORE_SKILL_ID = "wildkin_lore" as const;

/** Mob archetypes (and therefore art keys) used by the Hollin Hut system. */
export const HOLLIN_ART_KEYS = Object.freeze({
  hut: "hollin_hut",
  guard: "hollin_guard",
  brute: "hollin_brute",
  elder: "hollin_elder",
  farmer: "hollin_farmer",
  helper: "hollin_helper",
  orchardTree: "hollin_orchard_tree"
});

export const HOLLIN_HUT_MAX_HP = 10_000;
/** The hut starts repairing after this long without being attacked. */
export const HOLLIN_HUT_REPAIR_DELAY_MS = 60_000;
/** While repairing it recovers this fraction of its maximum health per second (full in ~10s). */
export const HOLLIN_HUT_REPAIR_FRACTION_PER_SECOND = 0.1;
export const HOLLIN_HUT_RESPAWN_MS = 30 * 60_000;
/** Breaking a hut bans every damage contributor from that hut's shop for 24 hours (per player). */
export const HOLLIN_RAID_TRADE_BAN_MS = 24 * 60 * 60_000;
/** Landing a hit on any Hollin (guard, elite or farmer) bans that player from that hut's shop for 12 hours. */
export const HOLLIN_HIT_TRADE_BAN_MS = 12 * 60 * 60_000;
/** Breaking a hut: every Hollin attacks that player on sight for this long (a grudge that follows them to every hut). */
export const HOLLIN_GRUDGE_MS = 24 * 60 * 60_000;
/** Hollins at a hut notice trees chopped, and grudge-bearers, within this distance. */
export const HOLLIN_SIGHT_RANGE_M = 150;
/** Harvesting a guarded orchard without Hollin Lore rank 2 angers the hut for this long. */
export const HOLLIN_ORCHARD_TRADE_BAN_MS = 30 * 60_000;
export const HOLLIN_ANGER_MS = 5 * 60_000;

export const HOLLIN_FARMER_COUNT = 3;
export const HOLLIN_FARMER_RING_RADIUS_M = 22;
export const HOLLIN_ORCHARD_TREE_COUNT = 4;
export const HOLLIN_ORCHARD_RADIUS_M = 45;
export const HOLLIN_ORCHARD_REGROW_MS = 5 * 60_000;
export const HOLLIN_ORCHARD_YIELD_ITEM = "giving_berry" as const;
export const HOLLIN_ORCHARD_YIELD_QUANTITY = 3;
export const HOLLIN_ORCHARD_PLANT_KEY = "hollin_orchard_tree" as const;

/** Guards sent after a tree-chopper or a grudge-bearer on sight. */
export const HOLLIN_INITIAL_GUARDS = 2;
/** Most defenders (guards and elites) alive at once per hut. */
export const HOLLIN_MAX_DEFENDERS = 20;
export type HollinDefenderKind = "guard" | "brute" | "elder";
export type HollinRaidWave = Readonly<Record<HollinDefenderKind, number>>;
/**
 * Four raid waves. One fires on the first hit and one each time the hut drops to or below the
 * matching health (7,500, 5,000 and 2,500 of 10,000). Each is stronger than the last and the final
 * one is elite-heavy. A threshold re-arms only after repair heals the hut back above it.
 */
export const HOLLIN_RAID_WAVE_HEALTH: readonly number[] = Object.freeze([Number.POSITIVE_INFINITY, 7_500, 5_000, 2_500]);
export const HOLLIN_RAID_WAVES: readonly HollinRaidWave[] = Object.freeze([
  { guard: 4, brute: 0, elder: 0 },
  { guard: 4, brute: 1, elder: 0 },
  { guard: 3, brute: 2, elder: 1 },
  { guard: 2, brute: 3, elder: 2 }
]);
/** Each attacker beyond the first adds a guard to every wave, up to this many. */
export const HOLLIN_WAVE_EXTRA_GUARDS_MAX = 4;
/** Elder healing: each live Elder heals every wounded defender by this fraction of its max health per second. */
export const HOLLIN_ELDER_HEAL_FRACTION_PER_SECOND = 0.05;

/** Wave composition for the number of attackers; elites listed first so a full hut keeps them. */
export function hollinWaveComposition(waveIndex: number, attackers: number): readonly HollinDefenderKind[] {
  const wave = HOLLIN_RAID_WAVES[Math.max(0, Math.min(HOLLIN_RAID_WAVES.length - 1, waveIndex))]!;
  const extra = Math.max(0, Math.min(HOLLIN_WAVE_EXTRA_GUARDS_MAX, Math.trunc(attackers) - 1));
  return [
    ...Array<HollinDefenderKind>(wave.elder).fill("elder"),
    ...Array<HollinDefenderKind>(wave.brute).fill("brute"),
    ...Array<HollinDefenderKind>(wave.guard + extra).fill("guard")
  ];
}
/** Players must be this close to open the shop or offer a berry. */
export const HOLLIN_INTERACTION_RADIUS_M = 150;

/** Shop discount percent by Hollin Lore rank (0..3). */
export const HOLLIN_SHOP_DISCOUNT_PERCENT = [0, 4, 9, 9] as const;

export function hollinShopDiscountPercent(rank: number): number {
  const index = Math.max(0, Math.min(3, Math.trunc(rank)));
  return HOLLIN_SHOP_DISCOUNT_PERCENT[index]!;
}

/** Discounted unit price: never below 1 gold, rounded up so a discount can't round to free. */
export function hollinDiscountedUnitPrice(basePriceGold: number, rank: number): number {
  const percent = hollinShopDiscountPercent(rank);
  return Math.max(1, Math.ceil((basePriceGold * (100 - percent)) / 100));
}

export type HollinShopStockLine = Readonly<{
  itemId: string;
  basePriceGold: number;
  maxQuantity: number;
}>;

/**
 * Staples: always-useful food and seed. Prices sit above the Goblin Market buyback so nothing
 * can be flipped (a Field Ration cooks into 4 Simple Food, a Hearty Ration into 8). Giving Berries
 * are not a staple: they are `HOLLIN_GIVING_BERRY_LINE`, sold only where Giving Trees grow.
 */
export const HOLLIN_STAPLE_POOL: readonly HollinShopStockLine[] = Object.freeze([
  { itemId: "simple_food", basePriceGold: 30, maxQuantity: 50 },
  { itemId: "field_ration", basePriceGold: 24, maxQuantity: 50 },
  { itemId: "hearty_ration", basePriceGold: 56, maxQuantity: 50 },
  { itemId: "wheat_seed", basePriceGold: 12, maxQuantity: 100 }
]);

/**
 * Kitchen ingredients (existing items only), each priced above its Goblin Market buyback.
 * No recipe items exist yet (the Kitchen has no recipe unlocks), so recipes are not in the pool.
 */
export const HOLLIN_INGREDIENT_POOL: readonly HollinShopStockLine[] = Object.freeze([
  { itemId: "frog_legs", basePriceGold: 3, maxQuantity: 50 },
  { itemId: "crab_meat", basePriceGold: 4, maxQuantity: 50 },
  { itemId: "jellyfish_jelly", basePriceGold: 4, maxQuantity: 50 },
  { itemId: "squid_cut", basePriceGold: 6, maxQuantity: 50 },
  { itemId: "wolf_cut", basePriceGold: 12, maxQuantity: 50 },
  { itemId: "deer_cut", basePriceGold: 15, maxQuantity: 50 },
  { itemId: "hog_cut", basePriceGold: 18, maxQuantity: 50 },
  { itemId: "alligator_tail", basePriceGold: 24, maxQuantity: 25 },
  { itemId: "bear_cut", basePriceGold: 30, maxQuantity: 25 }
]);

/**
 * Price of a regional ingredient: 1.5x its Goblin Market buyback, and never less than 2 gold above
 * it, so nothing can be flipped (the same margin the generic pool uses). Large cuts (buyback 16+)
 * sell in smaller lots.
 */
function regionalLine(itemId: string): HollinShopStockLine {
  const buyback = (GOBLIN_MARKET_BASE_RESOURCE_UNIT_PRICES as Record<string, number | undefined>)[itemId] ?? 0;
  return Object.freeze({
    itemId,
    basePriceGold: Math.max(buyback + 2, Math.ceil(buyback * 1.5)),
    maxQuantity: buyback >= 16 ? 25 : 50
  });
}

const regionalPool = (...itemIds: readonly string[]): readonly HollinShopStockLine[] =>
  Object.freeze(itemIds.map(regionalLine));

/**
 * What a hut sells besides the staples depends on its biome: the meats that live there (existing
 * Kitchen ingredients only). Biomes not listed, and huts with no known biome, use the generic
 * `HOLLIN_INGREDIENT_POOL`.
 */
export const HOLLIN_BIOME_INGREDIENT_POOLS: Readonly<Partial<Record<WorldZoneBiome, readonly HollinShopStockLine[]>>> = Object.freeze({
  jungle: regionalPool("jungle_deer_cut", "jungle_hog_cut", "jungle_wolf_cut", "jungle_tapir_cut", "mandrill_cut",
    "poison_frog_legs", "caiman_tail", "jaguar_cut", "sun_bear_cut"),
  pinewild: regionalPool("capercaillie_meat", "elk_cut", "red_squirrel_cut", "wolf_cut", "deer_cut", "hog_cut",
    "bear_cut", "frog_legs"),
  greenwood: regionalPool("badger_cut", "grey_squirrel_cut", "stag_beetle_cut", "elk_cut", "deer_cut", "wolf_cut",
    "hog_cut", "bear_cut", "frog_legs"),
  frostwood: regionalPool("frost_deer_cut", "frost_wolf_cut", "black_bear_cut", "great_grey_owl_meat",
    "flying_squirrel_cut", "red_squirrel_cut", "woolly_hog_cut", "frost_frog_legs"),
  plains: regionalPool("plains_bison_cut", "prairie_dog_cut", "burrowing_owl_meat", "deer_cut", "wolf_cut", "hog_cut",
    "frog_legs", "crab_meat"),
  highmeadow: regionalPool("mountain_ibex_cut", "wild_yak_cut", "alpine_marmot_cut", "deer_cut", "wolf_cut", "hog_cut",
    "bear_cut", "frog_legs"),
  savanna: regionalPool("giraffe_cut", "lioness_cut", "spotted_hyena_cut", "sand_deer_cut", "dune_wolf_cut",
    "warthog_cut", "desert_toad_legs", "crocodile_tail"),
  marsh: regionalPool("marsh_deer_cut", "bog_wolf_cut", "mud_hog_cut", "sitatunga_cut", "emperor_dragonfly_cut",
    "alligator_tail", "frog_legs", "mangrove_crab_meat"),
  scrubland: regionalPool("wild_scrub_goat_cut", "crested_porcupine_cut", "spur_thighed_tortoise_cut", "sand_crab_meat",
    "deer_cut", "wolf_cut", "hog_cut", "frog_legs"),
  badlands: regionalPool("dromedary_cut", "fennec_fox_cut", "sidewinder_cut", "desert_lion_cut", "javelina_cut",
    "dune_wolf_cut", "desert_toad_legs", "crocodile_tail"),
  steppe: regionalPool("saiga_cut", "wild_horse_cut", "steppe_marmot_cut", "sand_deer_cut", "warthog_cut",
    "dune_wolf_cut", "desert_toad_legs", "crocodile_tail"),
  tundra: regionalPool("lemming_cut", "snow_goose_meat", "frost_deer_cut", "frost_wolf_cut", "woolly_hog_cut",
    "snow_bear_cut", "frost_frog_legs", "ice_crab_meat"),
  frozen_waste: regionalPool("peary_caribou_cut", "ice_worm_cut", "emperor_penguin_meat", "frost_wolf_cut",
    "snow_bear_cut", "frost_frog_legs", "ice_crab_meat")
});

/** The ingredient pool for a hut's biome; unknown or unlisted biomes use the generic pool. */
export function hollinIngredientPoolForBiome(biome: WorldZoneBiome | null | undefined): readonly HollinShopStockLine[] {
  return (biome ? HOLLIN_BIOME_INGREDIENT_POOLS[biome] : undefined) ?? HOLLIN_INGREDIENT_POOL;
}

/**
 * Giving Berries: listed every day at a hut where Giving Trees grow (its population zone has tree
 * habitat), and never anywhere else. Any quantity up to the max per purchase.
 */
export const HOLLIN_GIVING_BERRY_LINE: HollinShopStockLine = Object.freeze({
  itemId: "giving_berry", basePriceGold: 20, maxQuantity: 20
});

/**
 * Every hut shows Simple Food plus this many other staples, reshuffled daily, and 0, 1 or 2 lines
 * from its biome ingredient pool (each count equally likely, per hut and day).
 */
export const HOLLIN_STOCK_OTHER_STAPLES = 2;
export const HOLLIN_STOCK_MAX_INGREDIENTS = 2;
export const HOLLIN_STOCK_ROTATION_MS = 24 * 60 * 60_000;

export function hollinStockEpoch(nowMs: number): number {
  return Math.floor(nowMs / HOLLIN_STOCK_ROTATION_MS);
}

export function hollinStockRefreshesAtMs(epoch: number): number {
  return (epoch + 1) * HOLLIN_STOCK_ROTATION_MS;
}

function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Small deterministic PRNG (mulberry32): the same seed always yields the same sequence. */
export function hollinSeededRandom(seedText: string): () => number {
  let state = hashSeed(seedText);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pickSeeded<T>(pool: readonly T[], count: number, random: () => number): T[] {
  const copy = [...pool];
  const picked: T[] = [];
  while (picked.length < count && copy.length > 0) {
    picked.push(copy.splice(Math.floor(random() * copy.length), 1)[0]!);
  }
  return picked;
}

/**
 * One hut's stock for one rotation epoch: deterministic, so server and snapshots always agree.
 * The staples are universal; 0..2 ingredients come from the hut's biome pool; Giving Berries are
 * listed only when Giving Trees grow at the hut.
 */
export function hollinStockForHut(
  hutId: string,
  epoch: number,
  biome?: WorldZoneBiome | null,
  givingTrees = false
): readonly HollinShopStockLine[] {
  const random = hollinSeededRandom(`hollin-stock:${hutId}:${epoch}`);
  const [simpleFood, ...otherStaples] = HOLLIN_STAPLE_POOL;
  const staples = pickSeeded(otherStaples, HOLLIN_STOCK_OTHER_STAPLES, random);
  const ingredientCount = Math.floor(random() * (HOLLIN_STOCK_MAX_INGREDIENTS + 1));
  return Object.freeze([
    simpleFood!,
    ...staples,
    ...(givingTrees ? [HOLLIN_GIVING_BERRY_LINE] : []),
    ...pickSeeded(hollinIngredientPoolForBiome(biome), ingredientCount, random)
  ]);
}

/**
 * A population hut stands for 6 to 8 days from adoption (deterministic per hut id), then
 * despawns; its Population V2 generation (48 h) ending does not remove it. Developer huts never
 * expire.
 */
export const HOLLIN_HUT_MIN_LIFETIME_MS = 6 * 24 * 60 * 60_000;
export const HOLLIN_HUT_MAX_LIFETIME_MS = 8 * 24 * 60 * 60_000;

export function hollinHutLifetimeMs(hutId: string): number {
  const span = HOLLIN_HUT_MAX_LIFETIME_MS - HOLLIN_HUT_MIN_LIFETIME_MS;
  return HOLLIN_HUT_MIN_LIFETIME_MS + Math.floor(hollinSeededRandom(`hollin-hut-lifetime:${hutId}`)() * (span + 1));
}

/**
 * No new hut may appear within this distance of any hut that still stands (population or
 * developer, including one destroyed and waiting to respawn). This is what makes huts rare.
 */
export const HOLLIN_HUT_EXCLUSION_RADIUS_M = 30_000;

/** Heal service: a flat handful of gold restores all health. */
export const HOLLIN_HEAL_COST_GOLD = 10;

/** Giant Eggs handed in at a Hut discover Hollin Lore (same cost as the Eyrie nest). */
export const HOLLIN_LORE_EGG_COST = 5;
export const HOLLIN_LORE_EGG_ITEM = "giant_egg" as const;

/** A contributor must deal at least this much damage to a hut to share its loot. */
export const HOLLIN_RAID_LOOT_MIN_DAMAGE = 100;
export type HollinRaidLootEntry = Readonly<{ itemId: string; quantity: number; weight: number }>;
/** The Hollins hoard food: every contributor rolls this many times on the food table... */
export const HOLLIN_RAID_LOOT_COMMON_ROLLS = 2;
export const HOLLIN_RAID_LOOT_COMMON: readonly HollinRaidLootEntry[] = Object.freeze([
  { itemId: "simple_food", quantity: 10, weight: 3 },
  { itemId: "field_ration", quantity: 6, weight: 3 },
  { itemId: "giving_berry", quantity: 8, weight: 3 },
  { itemId: "hearty_ration", quantity: 3, weight: 2 },
  { itemId: "deer_cut", quantity: 4, weight: 2 },
  { itemId: "wolf_cut", quantity: 4, weight: 2 },
  { itemId: "hog_cut", quantity: 3, weight: 1 },
  { itemId: "wheat_seed", quantity: 10, weight: 1 }
]);
/** ...and has this chance of one extra, nicer roll here. */
export const HOLLIN_RAID_LOOT_RARE_CHANCE = 0.1;
export const HOLLIN_RAID_LOOT_RARE: readonly HollinRaidLootEntry[] = Object.freeze([
  { itemId: "giant_egg", quantity: 1, weight: 3 },
  { itemId: "bear_cut", quantity: 5, weight: 3 },
  { itemId: "alligator_tail", quantity: 4, weight: 2 },
  { itemId: "zappy_bird_meat", quantity: 1, weight: 1 }
]);

/** Deterministic for a seed, so a retried grant rolls the same loot. */
export function rollHollinRaidLoot(seedText: string): readonly Readonly<{ itemId: string; quantity: number }>[] {
  const random = hollinSeededRandom(seedText);
  const pick = (table: readonly HollinRaidLootEntry[]): HollinRaidLootEntry => {
    const total = table.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = random() * total;
    for (const entry of table) {
      roll -= entry.weight;
      if (roll < 0) return entry;
    }
    return table[table.length - 1]!;
  };
  const loot: { itemId: string; quantity: number }[] = [];
  for (let roll = 0; roll < HOLLIN_RAID_LOOT_COMMON_ROLLS; roll += 1) {
    const common = pick(HOLLIN_RAID_LOOT_COMMON);
    const existing = loot.find((entry) => entry.itemId === common.itemId);
    if (existing) existing.quantity += common.quantity;
    else loot.push({ itemId: common.itemId, quantity: common.quantity });
  }
  if (random() < HOLLIN_RAID_LOOT_RARE_CHANCE) {
    const rare = pick(HOLLIN_RAID_LOOT_RARE);
    loot.push({ itemId: rare.itemId, quantity: rare.quantity });
  }
  return loot;
}

/**
 * Population V2 placement: one hut per this many km2 of dry land, in every biome (a hut's biome
 * only changes what it sells). Huts are landmarks, not clutter: a 650 m vision circle covers about
 * 1.3 km2, so 15 km2 per hut (the middle of the 10-20 km2 requested) is a few minutes'
 * walk between huts, and the 2.5 km hut spacing is comfortably smaller than the mean gap of about
 * 3.9 km, so spacing rarely rejects one. The per-zone roll stays, but a hut is only adopted when no
 * standing hut is within `HOLLIN_HUT_EXCLUSION_RADIUS_M` (30 km), so in practice huts are rare.
 */
export const HOLLIN_HUT_TARGET_AREA_KM2 = 15;

export type HollinBanReason = "orchard" | "raid";

export type HollinHutShopLine = Readonly<{
  itemId: string;
  displayName: string;
  baseUnitPriceGold: string;
  unitPriceGold: string;
  maxQuantity: number;
}>;

export type HollinHutShopSnapshot = Readonly<{
  hutId: string;
  /** ISO time this hut's stock next rotates. */
  stockRefreshesAt: string;
  heal: Readonly<{ costGold: string; currentHealth: number; maxHealth: number; canHeal: boolean }>;
  /** Hollin Lore hand-in: Giant Eggs held versus needed; `discovered` once the lore is known. */
  eggs: Readonly<{ have: number; need: number; discovered: boolean }>;
  name: string;
  rank: number;
  discountPercent: number;
  /** ISO time the player's trade ban at this hut ends; null when trading is open. */
  tradeBannedUntil: string | null;
  banReason: HollinBanReason | null;
  /** Rank 3 players can lift the ban by offering a berry. */
  canPacify: boolean;
  walletGold: string;
  lines: readonly HollinHutShopLine[];
}>;

const HUT_ENTITY_PATTERN = /^mob:(hollin-hut:[0-9a-f-]{36}):(\d+)$/u;

export function hollinHutEntityId(hutId: string, life: number): string {
  return `mob:${hutId}:${life}`;
}

/** Stable hut id for a hut combat entity id, or null for any other entity. */
export function hollinHutIdFromEntityId(entityId: string | null | undefined): string | null {
  const match = entityId ? HUT_ENTITY_PATTERN.exec(entityId) : null;
  return match ? match[1]! : null;
}

/** Hollin Lore rank 3 helper: follows its owner and forages. */
export const HOLLIN_HELPER_MIN_RANK = 3;
export const HOLLIN_HELPER_FOLLOW_DISTANCE_M = 5;
export const HOLLIN_HELPER_FORAGE_INTERVAL_MS = 20_000;
export const HOLLIN_HELPER_PICKUP_RADIUS_M = 40;
/** At most one berry is gathered per owner in each window. */
export const HOLLIN_HELPER_BERRY_INTERVAL_MS = 10 * 60_000;
export const HOLLIN_HELPER_BERRY_ITEM = "giving_berry" as const;

export function hollinHelperEntityId(ownerPlayerId: string): string {
  return `mob:hollin-helper:${ownerPlayerId}`;
}
