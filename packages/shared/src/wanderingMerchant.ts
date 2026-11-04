/**
 * Wandering Merchant: a seller who appears outside a
 * dungeon entrance for the player who completed it. Also the Lamp Sheath / Cinder Lantern
 * numbers. Server and client share these; the server is authoritative for every price and stock.
 */
export const WANDERING_MERCHANT_NAME = "Wandering Merchant" as const;
/** The merchant stays this long, then leaves. */
export const WANDERING_MERCHANT_STAY_MS = 30 * 60_000;
/** The merchant stands this far from the dungeon entrance so the two icons don't overlap. */
export const WANDERING_MERCHANT_OFFSET_M = 14;
/** The player must be this close to open the shop. */
export const WANDERING_MERCHANT_INTERACTION_RADIUS_M = 150;
export const WANDERING_MERCHANT_MAX_LAMP_SHEATHS = 3;
/** Lamp Sheath price: character level x this many gold. */
export const LAMP_SHEATH_GOLD_PER_LEVEL = 1_000;
/** Rotating goods offered per merchant, drawn from `WANDERING_MERCHANT_GOODS`. */
export const WANDERING_MERCHANT_GOODS_PER_VISIT = 3;

export const LAMP_SHEATH_ITEM_ID = "lamp_sheath" as const;
export const CINDER_LANTERN_ITEM_ID = "cinder_lantern" as const;
export const CINDER_LANTERN_CHARGES = 9;
/** Crafting a Cinder Lantern: 1 Lamp Sheath plus this much Crystal. */
export const CINDER_LANTERN_CRYSTAL_COST = 3_400;
export const CINDER_LANTERN_DROP_MULTIPLIER = 3;

/** Challenger's Lantern: 1 Lamp Sheath plus this much Lumen; a charge is spent per dungeon entry. */
export const CHALLENGERS_LANTERN_ITEM_ID = "challengers_lantern" as const;
export const CHALLENGERS_LANTERN_CHARGES = 12;
export const CHALLENGERS_LANTERN_LUMEN_COST = 24;
/** Flat Attack and Defense against monsters while the dungeon run was entered on this lantern. */
export const CHALLENGERS_LANTERN_ATTACK_BONUS = 3;
export const CHALLENGERS_LANTERN_DEFENSE_BONUS = 1;

/** Tradecraft (Tradecraft) discount percent by rank 0..3; ranks above 3 stay at the top step. */
export const TRADECRAFT_MERCHANT_DISCOUNT_PERCENT = [0, 18, 27, 37] as const;

export function tradecraftMerchantDiscountPercent(rank: number): number {
  const index = Math.max(0, Math.min(3, Math.trunc(Number.isFinite(rank) ? rank : 0)));
  return TRADECRAFT_MERCHANT_DISCOUNT_PERCENT[index]!;
}

/** Discounted unit price: never below 1 gold, rounded up so a discount can't round to free. */
export function wanderingMerchantUnitPrice(basePriceGold: number | bigint, rank: number): number {
  const percent = tradecraftMerchantDiscountPercent(rank);
  const base = Number(basePriceGold);
  return Math.max(1, Math.ceil((base * (100 - percent)) / 100));
}

export function lampSheathBasePrice(characterLevel: number): number {
  return Math.max(1, Math.trunc(characterLevel)) * LAMP_SHEATH_GOLD_PER_LEVEL;
}

export type WanderingMerchantGood = Readonly<{
  itemId: string;
  basePriceGold: number;
  stock: number;
}>;

/**
 * Existing dungeon-loop goods only, each priced well above its Goblin Market floor (60 gold for the
 * eggs, scale, silk and acorn; 25 for venom; 100 for a Venomsteel Bar) so the merchant can never be
 * flipped for gold. Glimmer Oil is deliberately absent: it burns real-money Glimmer and has no
 * gold price anywhere.
 */
export const WANDERING_MERCHANT_GOODS: readonly WanderingMerchantGood[] = Object.freeze([
  { itemId: "brood_silk", basePriceGold: 400, stock: 5 },
  { itemId: "raptor_scale", basePriceGold: 400, stock: 5 },
  { itemId: "giant_egg", basePriceGold: 450, stock: 3 },
  { itemId: "elder_acorn", basePriceGold: 350, stock: 5 },
  { itemId: "jellyfish_venom", basePriceGold: 150, stock: 10 },
  { itemId: "venomsteel_bar", basePriceGold: 600, stock: 5 }
]);

/** A merchant standing on the map, as the owning player sees it. */
export type WanderingMerchantMapEntry = Readonly<{
  merchantId: string;
  name: string;
  dungeonName: string;
  regionCode: string;
  lat: number;
  lon: number;
  /** ISO time the merchant leaves. */
  expiresAt: string;
}>;

export type WanderingMerchantShopLine = Readonly<{
  itemId: string;
  displayName: string;
  baseUnitPriceGold: string;
  unitPriceGold: string;
  /** Units still for sale at this merchant. */
  remaining: number;
}>;

export type WanderingMerchantShopSnapshot = Readonly<{
  merchantId: string;
  name: string;
  dungeonName: string;
  expiresAt: string;
  /** Tradecraft rank 0..3 and the discount it gives. */
  rank: number;
  discountPercent: number;
  walletGold: string;
  lines: readonly WanderingMerchantShopLine[];
}>;
