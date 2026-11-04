import type { WorldTimePhase } from "./worldTime.js";
import { worldTimeAt } from "./worldTime.js";
import type { WorldSeason, WorldZoneBiome } from "./worldZones.js";

/**
 * World dungeon entrances (docs/design/WORLD_DUNGEON_ENTRANCES.md): the one tuning table for where
 * the ladder dungeons' overworld entrances may appear, how often, and when they show. The server's
 * placement (apps/server/src/game/worldDungeonEntrances.ts) reads only this table.
 */

/** Each rolled entrance stands this long, then the cell rolls again somewhere else. */
export const WORLD_DUNGEON_ENTRANCE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

export const WORLD_TIME_PHASES: readonly WorldTimePhase[] = ["day", "dusk", "night", "dawn"];

/** The qualifying layers of a cell. Every listed layer must pass; an unknown value fails. */
export type WorldDungeonEntranceLayers = Readonly<{
  terrainClasses?: readonly ("flat" | "hilly" | "mountainous")[];
  biomes?: readonly WorldZoneBiome[];
  landCoverClasses?: readonly string[];
  minElevationM?: number;
  /** Exclusive upper bound. */
  maxElevationM?: number;
  /** Outside every World city and at least this far from one (checked on two rings of points). */
  minCityDistanceM?: number;
  notCoastal?: boolean;
}>;

export type WorldDungeonEntranceRule = Readonly<{
  dungeonId: string;
  /** The (retired) library entrance every rolled entrance copies: name, label, art, portal. */
  templateEntranceId: string;
  /**
   * One candidate slot per this many km² of qualifying land (the cell size at x1 season; cells are
   * this / the max season multiplier, thinned back by the season roll).
   */
  targetAreaKm2: number;
  /** Two live entrances of this dungeon are never this close (lower mark wins). */
  spacingM: number;
  /**
   * The design target: the median distance from a spot in fully qualifying land (x1 season) to the
   * nearest entrance. `targetAreaKm2` and `spacingM` are tuned to it (worldDungeonEntrances.test.ts).
   */
  nearestTargetM: number;
  visiblePhases: readonly WorldTimePhase[];
  /** Rate multipliers by the season at the slot when it spawns (absent = x1). */
  seasonMultipliers: Readonly<Partial<Record<WorldSeason, number>>>;
  layers: WorldDungeonEntranceLayers;
}>;

/**
 * The five rolled (cell) entrances, on the owner's distance ladder (2026-10-06): in fully qualifying
 * land the nearest entrance is typically 10 / 12 / 14 / 17 / 20 km away.
 */
export const WORLD_DUNGEON_ENTRANCE_RULES: readonly WorldDungeonEntranceRule[] = Object.freeze([
  {
    dungeonId: "fangrock_cavern",
    templateEntranceId: "fangrock_cavern_world_entrance",
    targetAreaKm2: 400,
    spacingM: 14_000,
    nearestTargetM: 10_000,
    visiblePhases: WORLD_TIME_PHASES,
    seasonMultipliers: {},
    layers: {
      terrainClasses: ["hilly", "mountainous"],
      biomes: ["badlands", "steppe", "scrubland", "highmeadow"],
      minCityDistanceM: 3_000
    }
  },
  {
    dungeonId: "the_eyrie",
    templateEntranceId: "the_eyrie_world_entrance",
    targetAreaKm2: 600,
    spacingM: 17_000,
    nearestTargetM: 12_000,
    visiblePhases: ["day", "dusk", "dawn"],
    seasonMultipliers: { summer: 2 },
    layers: {
      minElevationM: 2_500,
      terrainClasses: ["mountainous"],
      biomes: ["highmeadow", "pinewild", "tundra", "frostwood"]
    }
  },
  {
    dungeonId: "blightwood_grove",
    templateEntranceId: "blightwood_grove_world_entrance",
    targetAreaKm2: 800,
    spacingM: 20_000,
    nearestTargetM: 14_000,
    visiblePhases: ["dusk", "night"],
    seasonMultipliers: { autumn: 2 },
    layers: {
      landCoverClasses: ["forest"],
      biomes: ["greenwood", "pinewild", "jungle", "marsh"],
      maxElevationM: 1_500,
      notCoastal: true
    }
  },
  {
    dungeonId: "still_hand_monastery",
    templateEntranceId: "still_hand_monastery_world_entrance",
    targetAreaKm2: 1_150,
    spacingM: 24_000,
    nearestTargetM: 17_000,
    visiblePhases: ["dawn", "day"],
    seasonMultipliers: {},
    layers: {
      minElevationM: 1_500,
      maxElevationM: 2_500,
      terrainClasses: ["hilly"],
      biomes: ["highmeadow", "steppe", "pinewild"],
      minCityDistanceM: 10_000
    }
  },
  {
    dungeonId: "wyrm_hollow",
    templateEntranceId: "wyrm_hollow_world_entrance",
    targetAreaKm2: 1_600,
    spacingM: 28_000,
    nearestTargetM: 20_000,
    visiblePhases: WORLD_TIME_PHASES,
    seasonMultipliers: { summer: 2, dry: 2 },
    layers: {
      terrainClasses: ["mountainous"],
      minElevationM: 1_500,
      biomes: ["badlands", "scrubland", "steppe", "tundra"]
    }
  }
] satisfies WorldDungeonEntranceRule[]);

/** Drowned City: placed on coastal ocean water sites (waterSitePlacement.ts). */
export const DROWNED_CITY_WORLD_ENTRANCE_RULE = Object.freeze({
  dungeonId: "drowned_city",
  /**
   * One site per this many km² of coastal ocean (within 5 km of the coast), sized so the median
   * distance from a spot on a coast to the nearest site along it is about `nearestTargetM`.
   */
  targetAreaKm2: 350,
  /** The owner's ladder (2026-10-06): typical distance to the nearest site along a coast. */
  nearestTargetM: 25_000,
  visiblePhases: ["dusk", "night"] as readonly WorldTimePhase[]
});

/** Golem Forge: the region's first slot that passes these layers, else its first land slot. */
export const GOLEM_FORGE_PREFERRED_SLOT_LAYERS: WorldDungeonEntranceLayers = Object.freeze<WorldDungeonEntranceLayers>({
  terrainClasses: ["hilly", "mountainous"],
  biomes: ["badlands", "steppe", "scrubland", "tundra", "highmeadow"]
});

export function worldDungeonEntranceRule(dungeonId: string): WorldDungeonEntranceRule | null {
  return WORLD_DUNGEON_ENTRANCE_RULES.find((rule) => rule.dungeonId === dungeonId) ?? null;
}

/** Whether an entrance with these visible phases shows at `instant` (world clock, global). */
export function worldDungeonEntranceVisibleAt(
  visiblePhases: readonly WorldTimePhase[],
  instant: Date | number
): boolean {
  return visiblePhases.includes(worldTimeAt(instant).phase);
}

export function worldDungeonEntranceSeasonMultiplier(rule: WorldDungeonEntranceRule, season: WorldSeason): number {
  return rule.seasonMultipliers[season] ?? 1;
}

export function worldDungeonEntranceMaxMultiplier(rule: WorldDungeonEntranceRule): number {
  return Math.max(1, ...Object.values(rule.seasonMultipliers).filter((value): value is number => typeof value === "number"));
}

/** The environment facts a qualifying check reads (null = World did not say). */
export type WorldDungeonEntranceEnvironment = Readonly<{
  isLand: boolean | null;
  terrainClass: string | null;
  landCoverClass: string | null;
  elevationM: number | null;
  biome: WorldZoneBiome | null;
  isCoastal: boolean | null;
}>;

/**
 * Whether one point passes the layers (everything but the city distance, which needs nearby points).
 * Land only. Fail closed: a layer whose fact is unknown fails.
 */
export function worldDungeonEntranceLayersPass(
  layers: WorldDungeonEntranceLayers,
  environment: WorldDungeonEntranceEnvironment
): boolean {
  if (environment.isLand !== true) return false;
  if (layers.terrainClasses && !layers.terrainClasses.includes(environment.terrainClass as "flat")) return false;
  if (layers.biomes && (environment.biome === null || !layers.biomes.includes(environment.biome))) return false;
  if (layers.landCoverClasses && (environment.landCoverClass === null || !layers.landCoverClasses.includes(environment.landCoverClass))) {
    return false;
  }
  if (layers.minElevationM !== undefined || layers.maxElevationM !== undefined) {
    const elevation = environment.elevationM;
    if (elevation === null || !Number.isFinite(elevation)) return false;
    if (layers.minElevationM !== undefined && elevation < layers.minElevationM) return false;
    if (layers.maxElevationM !== undefined && elevation >= layers.maxElevationM) return false;
  }
  if (layers.notCoastal && environment.isCoastal !== false) return false;
  return true;
}
