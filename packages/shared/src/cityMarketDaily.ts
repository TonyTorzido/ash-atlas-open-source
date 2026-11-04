import type { CityMonumentTier } from "./citySystem.js";

/**
 * City Market "Daily offer": once per UTC day a city member may buy one
 * package of City Coins for Glimmer; the coins go into the city treasury. The
 * package grows with the City Market level (`cityMarketLevel`, 1-10): level 1,
 * level 2, and level 3 and above. `tier` is the package (1-3), not the level.
 */
export type CityMarketDailyPackage = Readonly<{
  tier: CityMonumentTier;
  cityCoins: number;
  glimmer: number;
}>;

export const CITY_MARKET_DAILY_PACKAGES: Readonly<Record<CityMonumentTier, CityMarketDailyPackage>> = {
  1: { tier: 1, cityCoins: 110, glimmer: 4 },
  2: { tier: 2, cityCoins: 215, glimmer: 7 },
  3: { tier: 3, cityCoins: 320, glimmer: 9 }
};

/** The package for a City Market level: 1 -> 110/4, 2 -> 215/7, 3 and above -> 320/9. */
export function cityMarketDailyPackage(marketLevel: number): CityMarketDailyPackage {
  const clamped = Math.min(3, Math.max(1, Math.trunc(marketLevel) || 1)) as CityMonumentTier;
  return CITY_MARKET_DAILY_PACKAGES[clamped];
}

/** What the City app shows for the viewing member. */
export type CityMarketDailySnapshot = Readonly<{
  marketStructureId: string;
  /** The City Market level (1-10) the package was picked from. */
  marketLevel: number;
  tier: CityMonumentTier;
  cityCoins: number;
  glimmer: number;
  /** UTC calendar day (YYYY-MM-DD) the purchase limit resets at the end of. */
  day: string;
  purchasedToday: boolean;
}>;
