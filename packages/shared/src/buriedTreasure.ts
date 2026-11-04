/*
 * Buried treasure and digging (Cartography treasure).
 *
 * Caches of three tiers appear on land near players. Bronze is visible to
 * everyone holding a Shovel; silver and gold are hidden until the viewer has
 * Cartography rank 2 and 3 (TREASURE_TIER_REQUIRED_CARTOGRAPHY_RANK).
 *
 * Digging needs a Shovel (see SHOVEL_RECIPE for its Crude Oil, Wood and
 * Iron Bar cost) that wears out after SHOVEL_MAX_USES digs. The server owns every roll; a cache can be dug once.
 */
export const TREASURE_TIERS = ["bronze", "silver", "gold"] as const;
export type TreasureTier = (typeof TREASURE_TIERS)[number];

export function isTreasureTier(value: unknown): value is TreasureTier {
  return typeof value === "string" && (TREASURE_TIERS as readonly string[]).includes(value);
}

export const TREASURE_TIER_NAMES: Readonly<Record<TreasureTier, string>> = Object.freeze({
  bronze: "Bronze Cache",
  silver: "Silver Cache",
  gold: "Gold Cache"
});

/** Cartography rank needed to see and dig each tier. */
export const TREASURE_TIER_REQUIRED_CARTOGRAPHY_RANK: Readonly<Record<TreasureTier, number>> = Object.freeze({
  bronze: 0,
  silver: 2,
  gold: 3
});

export function treasureTierVisible(tier: TreasureTier, cartographyRank: number): boolean {
  return Number.isFinite(cartographyRank) && cartographyRank >= TREASURE_TIER_REQUIRED_CARTOGRAPHY_RANK[tier];
}

export const TREASURE_LIFETIME_MS: Readonly<Record<TreasureTier, number>> = Object.freeze({
  bronze: 6 * 60 * 60 * 1_000,
  silver: 12 * 60 * 60 * 1_000,
  gold: 24 * 60 * 60 * 1_000
});

/** Dig from this close (GPS drift allowance included). */
export const TREASURE_DIG_RADIUS_M = 40;
/** Caches listed to a player within this distance. */
export const TREASURE_NEARBY_RADIUS_M = 2_500;
/** Spawn area around a player and the density caps inside it (per tier and total). */
export const TREASURE_AREA_RADIUS_M = 2_500;
export const TREASURE_AREA_CAPS: Readonly<Record<TreasureTier, number>> = Object.freeze({ bronze: 4, silver: 2, gold: 1 });
export const TREASURE_AREA_TOTAL_CAP = 6;
/** Server-wide ceiling on buried caches. */
export const TREASURE_GLOBAL_CAP = 400;
/** Caches keep at least this far apart. */
export const TREASURE_MIN_SPACING_M = 120;
/** New caches land this far from the player they spawn near. */
export const TREASURE_SPAWN_MIN_DISTANCE_M = 150;
export const TREASURE_SPAWN_MAX_DISTANCE_M = 1_500;
/** Silver and gold prefer a landmark within this distance of the player ... */
export const TREASURE_LANDMARK_SEARCH_M = 6_000;
/** ... and bury this close to it (never on top of it). */
export const TREASURE_LANDMARK_MIN_OFFSET_M = 40;
export const TREASURE_LANDMARK_MAX_OFFSET_M = 260;
export const TREASURE_SPAWN_WEIGHTS: Readonly<Record<TreasureTier, number>> = Object.freeze({ bronze: 70, silver: 22, gold: 8 });

export const TREASURE_LANDMARK_KINDS = ["city", "atlas_shrine", "hollin_hut", "kingdom_seat"] as const;
export type TreasureLandmarkKind = (typeof TREASURE_LANDMARK_KINDS)[number];
export const TREASURE_LANDMARK_NAMES: Readonly<Record<TreasureLandmarkKind, string>> = Object.freeze({
  city: "a city",
  atlas_shrine: "an Atlas Shrine",
  hollin_hut: "a Hollin hut",
  kingdom_seat: "a kingdom seat"
});

export const SHOVEL_ITEM_ID = "shovel" as const;
export const SHOVEL_MAX_USES = 20;
/** Shovel recipe: Crude Oil, Wood and Iron Bars. */
export const SHOVEL_RECIPE = Object.freeze([
  { itemId: "crude_oil", quantity: 8 },
  { itemId: "wood", quantity: 14 },
  { itemId: "iron_bar", quantity: 11 }
] as const);

export type TreasureRewardEntry = Readonly<{
  itemId: string;
  min: number;
  max: number;
  weight: number;
}>;

/** Number of weighted draws per tier, and the chance of one extra ring. */
export const TREASURE_DRAWS: Readonly<Record<TreasureTier, number>> = Object.freeze({ bronze: 2, silver: 3, gold: 3 });
export const TREASURE_RING_CHANCE: Readonly<Record<TreasureTier, number>> = Object.freeze({ bronze: 0.04, silver: 0.08, gold: 0.15 });
/** Treasure rings are random Plain rings; the bonus rolls when the ring is granted (rings.ts). */
export const TREASURE_RING_IDS = ["ring_plain"] as const;
export type TreasureRingId = (typeof TREASURE_RING_IDS)[number];

/**
 * Reward tables, drawn only from items that exist in the game today.
 */
export const TREASURE_REWARD_TABLES: Readonly<Record<TreasureTier, readonly TreasureRewardEntry[]>> = Object.freeze({
  bronze: [
    { itemId: "wood", min: 7, max: 17, weight: 3 },
    { itemId: "stone", min: 5, max: 12, weight: 3 },
    { itemId: "iron", min: 4, max: 10, weight: 2 },
    { itemId: "leather", min: 3, max: 7, weight: 2 },
    { itemId: "flax_fiber", min: 4, max: 10, weight: 2 },
    { itemId: "crude_oil", min: 4, max: 10, weight: 2 }
  ],
  silver: [
    { itemId: "wood", min: 12, max: 29, weight: 2 },
    { itemId: "stone", min: 9, max: 22, weight: 2 },
    { itemId: "iron", min: 7, max: 17, weight: 2 },
    { itemId: "leather", min: 5, max: 12, weight: 2 },
    { itemId: "crude_oil", min: 7, max: 17, weight: 2 },
    { itemId: "sulfur", min: 3, max: 7, weight: 2 },
    { itemId: "pearl", min: 2, max: 2, weight: 1 }
  ],
  gold: [
    { itemId: "crystal", min: 3, max: 6, weight: 3 },
    { itemId: "pearl", min: 2, max: 4, weight: 3 },
    { itemId: "sulfur", min: 5, max: 12, weight: 2 },
    { itemId: "crude_oil", min: 12, max: 29, weight: 2 },
    { itemId: "brood_silk", min: 2, max: 4, weight: 1 },
    // Gold caches can also hold a Lamp Sheath (the Wandering Merchant's item).
    { itemId: "lamp_sheath", min: 1, max: 2, weight: 1 }
  ]
});

export type TreasureReward = Readonly<{ itemId: string; quantity: number }>;
export type TreasureRewardResult = Readonly<{
  items: readonly TreasureReward[];
  /** Equipment ring definition id, when the ring roll hit. */
  ring: TreasureRingId | null;
}>;

/** Deterministic unit-interval stream from a seed (the treasure id), so a retried dig pays the same. */
function* unitStream(seed: string, hash: (value: string) => Uint8Array): Generator<number, never, void> {
  for (let counter = 0; ; counter += 1) {
    const bytes = hash(`${seed}:${counter}`);
    for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
      yield ((bytes[offset]! * 2 ** 24) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!) / 2 ** 32;
    }
  }
}

/**
 * Roll a cache's rewards. `hash` is any 16-byte-or-more digest (the server passes
 * SHA-256), keeping this module free of node imports.
 */
export function rollTreasureRewards(
  tier: TreasureTier,
  seed: string,
  hash: (value: string) => Uint8Array
): TreasureRewardResult {
  const stream = unitStream(`buried-treasure-v1:${tier}:${seed}`, hash);
  const table = TREASURE_REWARD_TABLES[tier];
  const totalWeight = table.reduce((sum, entry) => sum + entry.weight, 0);
  const merged = new Map<string, number>();
  for (let draw = 0; draw < TREASURE_DRAWS[tier]; draw += 1) {
    let pick = stream.next().value * totalWeight;
    const entry = table.find((candidate) => (pick -= candidate.weight) < 0) ?? table[table.length - 1]!;
    const quantity = entry.min + Math.floor(stream.next().value * (entry.max - entry.min + 1));
    merged.set(entry.itemId, (merged.get(entry.itemId) ?? 0) + quantity);
  }
  const ringHit = stream.next().value < TREASURE_RING_CHANCE[tier];
  const ringPick = stream.next().value;
  return {
    items: [...merged].map(([itemId, quantity]) => ({ itemId, quantity })),
    ring: ringHit ? TREASURE_RING_IDS[Math.floor(ringPick * TREASURE_RING_IDS.length)]! : null
  };
}

export type TreasureCacheSnapshot = Readonly<{
  id: string;
  tier: TreasureTier;
  lat: number;
  lon: number;
  expiresAt: string;
  distanceM: number;
  reachable: boolean;
  /** Real-world place the cache is buried near (settlement, river or lake), when known. */
  placeLabel: string | null;
  /** In-game landmark this silver or gold cache was buried near, when any. */
  landmarkKind: TreasureLandmarkKind | null;
}>;

export type TreasureStateSnapshot = Readonly<{
  serverTime: string;
  level: number;
  /** Cartography rank (0 when not learned): crafting a Shovel needs 2; silver needs 2 and gold 3 to see or dig. */
  cartographyRank: number;
  shovels: number;
  /** Digs left on the shovel in use (null with no shovel). */
  shovelUsesRemaining: number | null;
  shovelMaxUses: number;
  recipe: ReadonlyArray<Readonly<{ itemId: string; quantity: number; have: number }>>;
  caches: readonly TreasureCacheSnapshot[];
  /** Tiers still hidden from this viewer, with the Cartography rank that reveals them. */
  hiddenTiers: ReadonlyArray<Readonly<{ tier: TreasureTier; requiredRank: number }>>;
}>;
