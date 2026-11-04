/*
 * City building warfare (war part C3). City buildings use the same war rules
 * as city and kingdom structures (structureWarfare.ts):
 *  - hand attacks, Sieges and Bombers stop at the 50% burn threshold;
 *    reaching it ignites the building, which then burns from the threshold
 *    to 0 over its burn time;
 *  - repair is free and time-only at 5x the burn rate, the burn pauses while
 *    it runs, and hostile damage dealt meanwhile counts 3x;
 *  - only a Bomber can take a repairing building below the threshold.
 * A building that burns out or reaches 0 health is destroyed.
 *
 * Health and burn values are tuned here; the
 * Warehouse, Market and Monument values are our own choice. The Mayor House
 * has no health of its own: it belongs to the City Center seat, which already
 * carries the city's 230,000 health. Retired building types stay immune.
 *
 * The database keeps one checkpoint per building (health, health_at, burning,
 * repairing); current health is projected from it with the fixed burn and
 * repair rates, so the server and the client compute the same value.
 */
import { QUARTZ_HUT_BURN_DURATION_MS, QUARTZ_HUT_MAXIMUM_HEALTH, LIBRARY_BURN_DURATION_MS, LIBRARY_MAXIMUM_HEALTH, type CityStructureType } from "./citySystem.js";
import {
  STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS,
  STRUCTURE_WARFARE_ORGANIZATION_SEAT_BURN_DURATION_MS,
  structureWarfareRepairHealthAfter
} from "./structureWarfare.js";

const HOUR_MS = 60 * 60 * 1_000;

export const CITY_BUILDING_WARFARE_VALUES = Object.freeze({
  city_house: Object.freeze({ maximumHealth: 17_500, burnDurationMs: STRUCTURE_WARFARE_ORGANIZATION_SEAT_BURN_DURATION_MS }),
  oil_well: Object.freeze({ maximumHealth: 11_500, burnDurationMs: 46 * HOUR_MS }),
  quartz_hut: Object.freeze({ maximumHealth: QUARTZ_HUT_MAXIMUM_HEALTH, burnDurationMs: QUARTZ_HUT_BURN_DURATION_MS }),
  library: Object.freeze({ maximumHealth: LIBRARY_MAXIMUM_HEALTH, burnDurationMs: LIBRARY_BURN_DURATION_MS }),
  salon: Object.freeze({ maximumHealth: 18_500, burnDurationMs: STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS }),
  barracks: Object.freeze({ maximumHealth: 21_500, burnDurationMs: STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS }),
  demolition_factory: Object.freeze({ maximumHealth: 19_000, burnDurationMs: STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS }),
  warehouse: Object.freeze({ maximumHealth: 23_000, burnDurationMs: STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS }),
  market: Object.freeze({ maximumHealth: 22_000, burnDurationMs: STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS }),
  city_kennel: Object.freeze({ maximumHealth: 6_500, burnDurationMs: STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS }),
  cistern_warrens: Object.freeze({ maximumHealth: 5_500, burnDurationMs: STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS }),
  monument: Object.freeze({ maximumHealth: 18_000, burnDurationMs: STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS })
} as const);

export type CityBuildingWarfareType = keyof typeof CITY_BUILDING_WARFARE_VALUES;

/** Ember bombs cannot target houses. */
export const CITY_BUILDING_BOMB_IMMUNE_TYPES: readonly CityBuildingWarfareType[] = Object.freeze(["city_house"]);

export type CityBuildingWarfareProfile = Readonly<{
  type: CityBuildingWarfareType;
  maximumHealth: number;
  burnThreshold: number;
  burnDurationMs: number;
  bombable: boolean;
}>;

export function isCityBuildingWarfareType(type: string): type is CityBuildingWarfareType {
  return Object.prototype.hasOwnProperty.call(CITY_BUILDING_WARFARE_VALUES, type);
}

/** Null for the Mayor House (part of the City Center), retired types and unknown types. */
export function cityBuildingWarfareProfile(type: CityStructureType | string): CityBuildingWarfareProfile | null {
  if (!isCityBuildingWarfareType(type)) return null;
  const values = CITY_BUILDING_WARFARE_VALUES[type];
  return Object.freeze({
    type,
    maximumHealth: values.maximumHealth,
    burnThreshold: Math.floor(values.maximumHealth / 2),
    burnDurationMs: values.burnDurationMs,
    bombable: !CITY_BUILDING_BOMB_IMMUNE_TYPES.includes(type)
  });
}

export function cityBuildingDisplayName(type: CityStructureType | string): string {
  switch (type) {
    case "city_house": return "City House";
    case "mayor_house": return "Mayor House";
    case "oil_well": return "Oil Well";
    case "quartz_hut": return "Quartz Hut";
    case "library": return "Library";
    case "salon": return "Salon";
    case "barracks": return "Barracks";
    case "demolition_factory": return "Demolition Factory";
    case "warehouse": return "Warehouse";
    case "market": return "Market";
    case "city_kennel": return "City Kennel";
    case "cistern_warrens": return "Cistern Warrens";
    case "monument": return "Monument";
    default: return "City Building";
  }
}

/** Durable warfare checkpoint of one building. */
export type CityBuildingWarfareState = Readonly<{
  /** Health at `healthAtMs`; null means untouched (full health). */
  health: number | null;
  healthAtMs: number | null;
  burning: boolean;
  repairing: boolean;
}>;

/**
 * Projected health at `nowMs`. A repair restores health at 5x the burn rate
 * and pauses the burn; a burn removes the threshold's worth of health over
 * the burn time.
 */
export function cityBuildingHealthAt(
  profile: Pick<CityBuildingWarfareProfile, "maximumHealth" | "burnThreshold" | "burnDurationMs">,
  state: CityBuildingWarfareState,
  nowMs: number
): number {
  const base = Math.max(0, Math.min(profile.maximumHealth, state.health ?? profile.maximumHealth));
  const elapsedMs = state.healthAtMs === null ? 0 : Math.max(0, nowMs - state.healthAtMs);
  if (state.repairing) {
    return Math.min(profile.maximumHealth, base + structureWarfareRepairHealthAfter(profile, elapsedMs));
  }
  if (state.burning) {
    return Math.max(0, base - Math.floor((elapsedMs * profile.burnThreshold) / profile.burnDurationMs));
  }
  return base;
}

/** Milliseconds until a burning (unrepaired) building at `health` burns out. */
export function cityBuildingBurnRemainingMs(
  profile: Pick<CityBuildingWarfareProfile, "burnThreshold" | "burnDurationMs">,
  health: number
): number {
  if (health <= 0 || profile.burnThreshold <= 0) return 0;
  return Math.ceil((health * profile.burnDurationMs) / profile.burnThreshold);
}

/** Wire projection sent with every city structure snapshot that has health. */
export type CityBuildingWarfareSnapshot = Readonly<{
  maximumHealth: number;
  burnThreshold: number;
  burnDurationMs: number;
  bombable: boolean;
  /** Checkpoint health (full health when untouched). */
  health: number;
  /** ISO time of the checkpoint; null when untouched. */
  healthAt: string | null;
  burning: boolean;
  repairing: boolean;
  repairPlayerId: string | null;
}>;

export function cityBuildingHealthFromSnapshot(snapshot: CityBuildingWarfareSnapshot, nowMs: number): number {
  return cityBuildingHealthAt(snapshot, {
    health: snapshot.health,
    healthAtMs: snapshot.healthAt ? Date.parse(snapshot.healthAt) : null,
    burning: snapshot.burning,
    repairing: snapshot.repairing
  }, nowMs);
}
