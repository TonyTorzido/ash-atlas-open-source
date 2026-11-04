import {
  MOB_SPAWN_KINDS,
  MOB_SPAWN_RULES,
  MOB_SPAWN_RULES_REVISION,
  POPULATION_BALANCE,
  destinationPoint,
  isMobSpawnElevationBand,
  mobSpawnLayersUsed,
  mobSpawnSiteFactCombinations,
  mobSpawnTableEntries,
  validateMobSpawnRules,
  worldZoneBiomeFromResolveIds,
  worldZoneOceanDepthAt,
  type MobSpawnKind,
  type MobSpawnOceanDepth,
  type MobSpawnSiteFacts,
  type WorldZoneLookup
} from "@ash-atlas/shared";

import { loadWorldZoneLookupFromDisk } from "./biomeDiscovery.js";

import {
  populationV2MobEncounterSurfaces,
  populationV2MobRegistry,
  type PopulationV2MobRegistry
} from "./populationV2MobRegistry.js";
import {
  materializePopulationV2RegisteredMobCandidate,
  type PopulationV2RegisteredMobOverlayMobResult,
  type PopulationV2RegisteredMobOverlayResult,
  type PopulationV2RegisteredMobOverlaySlot
} from "./populationV2RegisteredMobOverlay.js";
import type {
  PopulationZoneV2Habitat,
  PopulationZoneV2HabitatCandidateSite
} from "./populationV2HabitatTypes.js";
import {
  POPULATION_V2_ENCOUNTER_SURFACES,
  populationV2EncounterSurface,
  type PopulationV2EncounterSurface
} from "./populationV2SurfaceTypes.js";
import {
  deterministicUnit,
  hashPartsHex
} from "./populationZonesV2Identity.js";
import { greatCircleDistanceMeters } from "./populationZonesV2Geometry.js";

/** Encounter tables are derived from the per-mob spawn rules (packages/shared/src/mobSpawnRules.ts). */
export const POPULATION_V2_ENCOUNTER_TABLE_REVISION = MOB_SPAWN_RULES_REVISION;
export const POPULATION_V2_ENCOUNTER_BUDGET_REVISION =
  "surface-specific-valid-area-budget-v3-water-four-per-km2";
const POPULATION_V2_LAND_ENCOUNTER_BUDGET_REVISION =
  "surface-specific-valid-area-budget-v3-land-2x";
export const POPULATION_V2_ENCOUNTER_ORIGIN_REVISION =
  "ranked-cached-land-soft-spacing-v2";
export const POPULATION_V2_GROUP_FORMATION_REVISION =
  "atomic-mathematical-formation-v2";
export const POPULATION_V2_PREFERRED_LAND_ANCHOR_SPACING_M = 200;
export const POPULATION_V2_ENCOUNTER_DENSITY_PER_KM2 = Object.freeze({
  // 2x (owner, 2026-10-08): 8 encounters within 650 m.
  land: 8 / (Math.PI * 0.65 ** 2),
  lake: 4,
  river: 4,
  ocean: 4
}) satisfies Readonly<Record<PopulationV2EncounterSurface, number>>;

export type PopulationV2EncounterMobKind = MobSpawnKind;

export type PopulationV2EncounterTable = Readonly<
  Partial<Record<PopulationV2EncounterMobKind, number>>
>;

type EncounterTableSite = Pick<
  PopulationZoneV2HabitatCandidateSite,
  "biomeId" | "ecoregionId" | "position" | "placementTags"
> & Partial<Pick<
  PopulationZoneV2HabitatCandidateSite,
  "elevationBand" | "isLakeshore" | "isRiverbank"
>>;

/**
 * An ocean site's depth band from the cooked world-zone lookup, the source of
 * the zone label the player sees out at sea. Where the lookup is not ocean
 * (World says ocean, the cooked grid disagrees) the label reads Open Water, and
 * so does the site. Without a lookup the depth is unknown.
 */
function siteOceanDepth(
  surface: PopulationV2EncounterSurface,
  site: EncounterTableSite,
  lookup: WorldZoneLookup | null
): MobSpawnOceanDepth | null {
  if (surface !== "ocean" || lookup === null) return null;
  return worldZoneOceanDepthAt(lookup, site.position) ?? "open_water";
}

/**
 * What the spawn rules can see of a site; unknown layers are null. Ocean depth
 * is resolved only when a lookup is given.
 */
export function populationV2SpawnSiteFacts(
  surface: PopulationV2EncounterSurface,
  site: EncounterTableSite,
  oceanDepthLookup: WorldZoneLookup | null = null
): MobSpawnSiteFacts {
  const elevationBand = site.elevationBand ?? null;
  return {
    surface,
    biome: worldZoneBiomeFromResolveIds(site.biomeId, site.ecoregionId, site.position.lat),
    elevationBand: isMobSpawnElevationBand(elevationBand) ? elevationBand : null,
    oceanDepth: siteOceanDepth(surface, site, oceanDepthLookup),
    coast: site.placementTags.includes("coastal-land"),
    lakeshore: site.isLakeshore ?? null,
    riverside: site.isRiverbank ?? null
  };
}

const LAYERS_USED_BY_SURFACE = Object.freeze(Object.fromEntries(
  POPULATION_V2_ENCOUNTER_SURFACES.map((surface) => [surface, mobSpawnLayersUsed(surface)])
) as Record<PopulationV2EncounterSurface, ReturnType<typeof mobSpawnLayersUsed>>);

/** Only the layers some rule on the surface filters on; sites alike in those share a table. */
function spawnTableKey(facts: MobSpawnSiteFacts): string {
  const used = LAYERS_USED_BY_SURFACE[facts.surface];
  const known = (value: string | boolean | null) => value === null ? "?" : String(value);
  return [
    facts.surface,
    facts.biome ?? "?",
    ...(used.elevationBand ? [`elevation=${known(facts.elevationBand)}`] : []),
    ...(used.oceanDepth ? [`depth=${known(facts.oceanDepth)}`] : []),
    ...(used.coast ? [`coast=${known(facts.coast)}`] : []),
    ...(used.lakeshore ? [`lakeshore=${known(facts.lakeshore)}`] : []),
    ...(used.riverside ? [`riverside=${known(facts.riverside)}`] : [])
  ].join("|");
}

const DERIVED_ENCOUNTER_TABLE_REVISIONS = new WeakMap<PopulationV2EncounterTable, string>();
const DERIVED_ENCOUNTER_TABLES = new Map<string, PopulationV2EncounterTable>();

function encounterTableForFacts(facts: MobSpawnSiteFacts): PopulationV2EncounterTable {
  const key = spawnTableKey(facts);
  const cached = DERIVED_ENCOUNTER_TABLES.get(key);
  if (cached !== undefined) return cached;
  const table: PopulationV2EncounterTable = Object.freeze(
    Object.fromEntries(mobSpawnTableEntries(facts))
  );
  DERIVED_ENCOUNTER_TABLE_REVISIONS.set(table, `${MOB_SPAWN_RULES_REVISION}/${key}`);
  DERIVED_ENCOUNTER_TABLES.set(key, table);
  return table;
}

/**
 * The encounter table for one site on any surface, derived from every spawn
 * rule that matches the site. Water sites use the biome World resolves for
 * the water point (World's nearest-land ecology fallback).
 */
export function populationV2EncounterTableForSite(
  surface: PopulationV2EncounterSurface,
  site: EncounterTableSite
): PopulationV2EncounterTable {
  const lookup = LAYERS_USED_BY_SURFACE[surface].oceanDepth ? oceanDepthLookup() : null;
  return encounterTableForFacts(populationV2SpawnSiteFacts(surface, site, lookup));
}

let cachedOceanDepthLookup: WorldZoneLookup | null | undefined;

/** The bundled world-zone lookup, read once and only when an ocean rule filters on depth. */
function oceanDepthLookup(): WorldZoneLookup | null {
  if (cachedOceanDepthLookup === undefined) {
    cachedOceanDepthLookup = loadWorldZoneLookupFromDisk({
      warn: (...args: unknown[]) => console.warn("ocean depth spawn rules disabled:", ...args)
    });
  }
  return cachedOceanDepthLookup;
}

/** The table of a site with nothing known beyond its surface (inland, unknown biome). */
function defaultEncounterTable(surface: PopulationV2EncounterSurface): PopulationV2EncounterTable {
  return encounterTableForFacts({
    surface,
    biome: null,
    elevationBand: null,
    oceanDepth: null,
    coast: false,
    lakeshore: null,
    riverside: null
  });
}

export type PopulationV2EncounterDiagnostics = Readonly<{
  tableRevision: typeof POPULATION_V2_ENCOUNTER_TABLE_REVISION;
  budgetRevision: typeof POPULATION_V2_ENCOUNTER_BUDGET_REVISION;
  originRevision: typeof POPULATION_V2_ENCOUNTER_ORIGIN_REVISION;
  formationRevision: typeof POPULATION_V2_GROUP_FORMATION_REVISION;
  genericEncounterTarget: number;
  genericEncounterOriginsSelected: number;
  selectedBySurface: Readonly<Record<PopulationV2EncounterSurface, number>>;
  selectedByMobKind: Readonly<Record<string, number>>;
  groupCount: number;
  soloCount: number;
  totalMobBodyCount: number;
  exactCoordinateNudges: number;
  shortfalls: readonly Readonly<{
    surface: PopulationV2EncounterSurface;
    count: number;
    reason: "insufficient_cached_surface_candidates";
  }>[];
  materializationDurationMs: number;
}>;

export type PopulationV2EncounterMaterialization =
  PopulationV2RegisteredMobOverlayResult<string> & Readonly<{
    diagnostics: PopulationV2EncounterDiagnostics;
  }>;

/** Each surface's table must be non-empty, hold only registered mobs of that surface, and have positive weight. */
export function validatePopulationV2EncounterTables(
  tables: Readonly<Record<string, PopulationV2EncounterTable>>
): void {
  for (const surface of POPULATION_V2_ENCOUNTER_SURFACES) {
    const table = tables[surface];
    if (table === undefined) {
      throw new Error(`encounter table ${surface} is missing`);
    }
    const entries = Object.entries(table);
    if (entries.length === 0) {
      throw new Error(`encounter table ${surface} is empty`);
    }
    let total = 0;
    for (const [kind, weight] of entries) {
      if (!/^[a-z][a-z0-9_]*$/u.test(kind)) {
        throw new Error(`encounter table ${surface} has invalid kind ${kind}`);
      }
      if (!Number.isFinite(weight) || weight < 0) {
        throw new Error(
          `encounter table ${surface}/${kind} has an invalid weight`
        );
      }
      const definition = populationV2MobRegistry.definitionForKind(kind);
      if (
        definition === undefined
        || !populationV2MobEncounterSurfaces(definition).includes(surface)
      ) {
        throw new Error(
          `encounter table ${surface}/${kind} is not a registered ${surface} mob`
        );
      }
      total += weight;
    }
    if (!(total > 0) || !Number.isFinite(total)) {
      throw new Error(`encounter table ${surface} has no positive weight`);
    }
  }
}

export function selectPopulationV2EncounterKind(input: Readonly<{
  generationId: string;
  encounterOriginId: string;
  surface: PopulationV2EncounterSurface;
  table?: PopulationV2EncounterTable;
}>): PopulationV2EncounterMobKind {
  const table = input.table ?? defaultEncounterTable(input.surface);
  const entries = Object.entries(table).filter((entry) => entry[1] > 0) as
    [PopulationV2EncounterMobKind, number][];
  const total = entries.reduce((sum, entry) => sum + entry[1], 0);
  if (!(total > 0)) throw new Error("encounter table has no selectable entry");
  const roll = deterministicUnit(
    DERIVED_ENCOUNTER_TABLE_REVISIONS.get(table)
      ?? `${POPULATION_V2_ENCOUNTER_TABLE_REVISION}/custom/${input.surface}`,
    input.generationId,
    input.encounterOriginId,
    input.surface
  ) * total;
  let upper = 0;
  for (const [kind, weight] of entries) {
    upper += weight;
    if (roll < upper) return kind;
  }
  return entries.at(-1)![0];
}

export function populationV2GenericEncounterTarget(input: Readonly<{
  generationId: string;
  surface: PopulationV2EncounterSurface;
  validSurfaceAreaKm2: number;
}>): number {
  if (!Number.isFinite(input.validSurfaceAreaKm2)
      || input.validSurfaceAreaKm2 < 0) {
    throw new Error("valid encounter surface area must be nonnegative");
  }
  const expected = input.validSurfaceAreaKm2
    * POPULATION_V2_ENCOUNTER_DENSITY_PER_KM2[input.surface];
  const whole = Math.floor(expected);
  return whole + (deterministicUnit(
    input.surface === "land"
      ? POPULATION_V2_LAND_ENCOUNTER_BUDGET_REVISION
      : POPULATION_V2_ENCOUNTER_BUDGET_REVISION,
    input.generationId,
    input.surface
  ) < expected - whole ? 1 : 0);
}

export function materializePopulationV2EncounterTables(input: Readonly<{
  generationId: string;
  habitat: PopulationZoneV2Habitat;
  registry?: PopulationV2MobRegistry;
}>): PopulationV2EncounterMaterialization {
  const startedAt = performance.now();
  const registry = input.registry ?? populationV2MobRegistry;
  const surfaceAreas = encounterSurfaceAreas(input.habitat);
  const sitesBySurface = new Map<
    PopulationV2EncounterSurface,
    PopulationZoneV2HabitatCandidateSite[]
  >(POPULATION_V2_ENCOUNTER_SURFACES.map((surface) => [surface, []]));
  for (const site of input.habitat.candidateSites ?? []) {
    const surface = candidateSurface(site);
    if (surface === null) continue;
    if (surface === "river" && site.surfaceAuthority == null) continue;
    sitesBySurface.get(surface)!.push(site);
  }

  const slots: PopulationV2RegisteredMobOverlaySlot<string>[] = [];
  const encounterCounts = new Map<string, number>();
  const bodyCounts = new Map<string, number>();
  const selectedBySurface = Object.fromEntries(
    POPULATION_V2_ENCOUNTER_SURFACES.map((surface) => [surface, 0])
  ) as Record<PopulationV2EncounterSurface, number>;
  const occupiedCoordinates = new Set<string>();
  const shortfalls: PopulationV2EncounterDiagnostics["shortfalls"][number][] = [];
  let genericEncounterTarget = 0;
  let exactCoordinateNudges = 0;

  for (const surface of POPULATION_V2_ENCOUNTER_SURFACES) {
    const target = populationV2GenericEncounterTarget({
      generationId: input.generationId,
      surface,
      validSurfaceAreaKm2: surfaceAreas[surface]
    });
    genericEncounterTarget += target;
    const candidates = selectPopulationV2EncounterOrigins({
      generationId: input.generationId,
      surface,
      target,
      candidates: sitesBySurface.get(surface)!
    });
    if (candidates.length < target) {
      shortfalls.push({
        surface,
        count: target - candidates.length,
        reason: "insufficient_cached_surface_candidates"
      });
    }
    for (const candidate of candidates) {
      const encounterOriginId = `encounter-origin/${hashPartsHex(
        POPULATION_V2_ENCOUNTER_ORIGIN_REVISION,
        input.generationId,
        surface,
        candidate.siteId
      ).slice(0, 40)}`;
      let position = candidate.position;
      const coordinate = coordinateKey(position);
      if (occupiedCoordinates.has(coordinate)) {
        position = destinationPoint(
          position,
          1 + deterministicUnit(
            POPULATION_V2_ENCOUNTER_ORIGIN_REVISION,
            input.generationId,
            encounterOriginId,
            "nudge"
          ) * 2,
          deterministicUnit(
            POPULATION_V2_ENCOUNTER_ORIGIN_REVISION,
            input.generationId,
            encounterOriginId,
            "bearing"
          ) * 360
        );
        exactCoordinateNudges += 1;
      }
      occupiedCoordinates.add(coordinateKey(position));
      const mobKind = selectPopulationV2EncounterKind({
        generationId: input.generationId,
        encounterOriginId,
        surface,
        table: populationV2EncounterTableForSite(surface, candidate)
      });
      const definition = registry.requireDefinition(mobKind);
      if (!populationV2MobEncounterSurfaces(definition).includes(surface)) {
        throw new Error(
          `encounter table selected ${mobKind} for the wrong surface`
        );
      }
      const encounterSlots = materializePopulationV2RegisteredMobCandidate({
        definition,
        generationId: input.generationId,
        encounterOrigin: {
          ...candidate,
          siteId: encounterOriginId,
          position
        },
        registry
      });
      slots.push(...encounterSlots);
      selectedBySurface[surface] += 1;
      encounterCounts.set(mobKind, (encounterCounts.get(mobKind) ?? 0) + 1);
      bodyCounts.set(mobKind, (bodyCounts.get(mobKind) ?? 0)
        + encounterSlots.length);
    }
  }

  const mobs: PopulationV2RegisteredMobOverlayMobResult<string>[] =
    [...encounterCounts].sort(([left], [right]) => left.localeCompare(right))
      .map(([mobKind, groups]) => {
        const definition = registry.requireDefinition(mobKind);
        const bodies = bodyCounts.get(mobKind) ?? 0;
        return {
          mobKind,
          placementRevision: definition.placementRevision,
          rolloutPolicy: definition.defaultRolloutPolicy,
          status: "completed",
          target: { groups, bodies },
          current: { groups: 0, bodies: 0 },
          inserted: { groups, bodies },
          shortfall: { groups: 0, bodies: 0 },
          eligibleAnchorCount: populationV2MobEncounterSurfaces(definition)
            .reduce((sum, surface) => sum + sitesBySurface.get(surface)!.length, 0),
          consideredAnchorCount: groups,
          terminalPartialGroups: []
        };
      });
  const insertedGroups = [...encounterCounts.values()]
    .reduce((sum, count) => sum + count, 0);
  const insertedBodies = slots.length;
  const shortfallGroups = shortfalls.reduce(
    (sum, shortfall) => sum + shortfall.count,
    0
  );
  const groupCount = mobs.filter((mob) =>
    registry.requireDefinition(mob.mobKind).spawnModel === "pack"
  ).reduce((sum, mob) => sum + mob.inserted.groups, 0);
  return {
    mode: "next_generation",
    status: shortfallGroups > 0 ? "completed_with_shortfall" : "completed",
    slots: slots.sort((left, right) => left.entityId.localeCompare(right.entityId)),
    mobs,
    target: {
      groups: genericEncounterTarget,
      bodies: insertedBodies
    },
    current: { groups: 0, bodies: 0 },
    inserted: { groups: insertedGroups, bodies: insertedBodies },
    shortfall: { groups: shortfallGroups, bodies: 0 },
    terminalPartialGroups: [],
    diagnostics: {
      tableRevision: POPULATION_V2_ENCOUNTER_TABLE_REVISION,
      budgetRevision: POPULATION_V2_ENCOUNTER_BUDGET_REVISION,
      originRevision: POPULATION_V2_ENCOUNTER_ORIGIN_REVISION,
      formationRevision: POPULATION_V2_GROUP_FORMATION_REVISION,
      genericEncounterTarget,
      genericEncounterOriginsSelected: insertedGroups,
      selectedBySurface,
      selectedByMobKind: Object.fromEntries([...encounterCounts].sort()),
      groupCount,
      soloCount: insertedGroups - groupCount,
      totalMobBodyCount: insertedBodies,
      exactCoordinateNudges,
      shortfalls,
      materializationDurationMs: Math.max(0, performance.now() - startedAt)
    }
  };
}

export function populationV2EncounterTableDiagnostic() {
  const mean = (
    outcomes: readonly Readonly<{
      memberCount: number;
      probability: number;
    }>[]
  ) => {
    return outcomes.reduce(
      (sum, outcome) => sum + outcome.memberCount * outcome.probability,
      0
    );
  };
  // The plain land table (unknown biome, inland): Deer, Wolves and Resin
  // Crawlers come in groups, every other kind alone.
  const groupMean: Readonly<Partial<Record<string, number>>> = {
    deer: mean(POPULATION_BALANCE.deerGroupSize.outcomes),
    wolf: mean(POPULATION_BALANCE.wolfPackSize.outcomes),
    sap_crawler: mean(POPULATION_BALANCE.sapCrawlerGroupSize.outcomes)
  };
  const expectedBodiesPerLandEncounter = Object.entries(defaultEncounterTable("land"))
    .reduce((sum, [kind, share]) => sum + (share ?? 0) * (groupMean[kind] ?? 1), 0);
  const expansionAreaKm2 = 0.751;
  const freshCircleAreaKm2 = Math.PI * 0.65 ** 2;
  return Object.freeze({
    expectedBodiesPerEncounter: Object.freeze({
      land: expectedBodiesPerLandEncounter,
      lake: 1,
      river: 1,
      ocean: 1
    }),
    expectedEncountersPerMaximumDistanceExpansionFlag:
      POPULATION_V2_ENCOUNTER_DENSITY_PER_KM2.land * expansionAreaKm2,
    expectedBodiesPerMaximumDistanceLandExpansionFlag:
      POPULATION_V2_ENCOUNTER_DENSITY_PER_KM2.land
      * expansionAreaKm2
      * expectedBodiesPerLandEncounter,
    expectedEncountersInFresh650mCircle:
      POPULATION_V2_ENCOUNTER_DENSITY_PER_KM2.land * freshCircleAreaKm2,
    expectedBodiesInFresh650mLandCircle:
      POPULATION_V2_ENCOUNTER_DENSITY_PER_KM2.land
      * freshCircleAreaKm2
      * expectedBodiesPerLandEncounter,
    maximumBodiesPerEncounter: 4
  });
}

export function simulatePopulationV2FlagEncounterDensity(
  sampleCount = 512
): Readonly<{
  sampleCount: number;
  meanNewlyExposedEncounters: number;
  meanFreshCircleEncounters: number;
}> {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 32) {
    throw new Error("encounter density simulation requires at least 32 samples");
  }
  const cellSizeKm = Math.sqrt(
    1 / POPULATION_V2_ENCOUNTER_DENSITY_PER_KM2.land
  );
  const radiusKm = 0.65;
  const centerDistanceKm = 0.6;
  let newlyExposed = 0;
  let fresh = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const first = {
      x: deterministicUnit("encounter-density-center-x", sample)
        * cellSizeKm,
      y: deterministicUnit("encounter-density-center-y", sample)
        * cellSizeKm
    };
    const heading = deterministicUnit(
      "encounter-density-heading",
      sample
    ) * Math.PI * 2;
    const second = {
      x: first.x + Math.cos(heading) * centerDistanceKm,
      y: first.y + Math.sin(heading) * centerDistanceKm
    };
    const minimumX = Math.floor(
      (Math.min(first.x, second.x) - radiusKm) / cellSizeKm
    );
    const maximumX = Math.ceil(
      (Math.max(first.x, second.x) + radiusKm) / cellSizeKm
    );
    const minimumY = Math.floor(
      (Math.min(first.y, second.y) - radiusKm) / cellSizeKm
    );
    const maximumY = Math.ceil(
      (Math.max(first.y, second.y) + radiusKm) / cellSizeKm
    );
    for (let x = minimumX; x <= maximumX; x += 1) {
      for (let y = minimumY; y <= maximumY; y += 1) {
        const point = {
          x: (x + deterministicUnit(
            "encounter-density-point-x",
            sample,
            x,
            y
          )) * cellSizeKm,
          y: (y + deterministicUnit(
            "encounter-density-point-y",
            sample,
            x,
            y
          )) * cellSizeKm
        };
        const inFirst = squaredDistance(point, first) <= radiusKm ** 2;
        const inSecond = squaredDistance(point, second) <= radiusKm ** 2;
        if (inSecond) fresh += 1;
        if (inSecond && !inFirst) newlyExposed += 1;
      }
    }
  }
  return {
    sampleCount,
    meanNewlyExposedEncounters: newlyExposed / sampleCount,
    meanFreshCircleEncounters: fresh / sampleCount
  };
}

export function selectPopulationV2EncounterOrigins(input: Readonly<{
  generationId: string;
  surface: PopulationV2EncounterSurface;
  target: number;
  candidates: readonly PopulationZoneV2HabitatCandidateSite[];
}>): PopulationZoneV2HabitatCandidateSite[] {
  if (!Number.isSafeInteger(input.target) || input.target < 0) {
    throw new Error("encounter origin target must be a nonnegative integer");
  }
  const ranked = input.candidates.map((site) => ({
    site,
    rank: encounterOriginRank(
      input.generationId,
      input.surface,
      site.siteId
    )
  })).sort((left, right) =>
    left.rank.localeCompare(right.rank)
    || left.site.siteId.localeCompare(right.site.siteId)
  );
  if (input.surface !== "land" || input.target <= 1) {
    return ranked.slice(0, input.target).map(({ site }) => site);
  }

  const selected: typeof ranked = [];
  while (selected.length < input.target && ranked.length > 0) {
    let selectedIndex = 0;
    let selectedScore = -1;
    for (let index = 0; index < ranked.length; index += 1) {
      const minimumDistanceM = selected.length === 0
        ? Number.POSITIVE_INFINITY
        : Math.min(...selected.map(({ site }) =>
            greatCircleDistanceMeters(
              ranked[index]!.site.position,
              site.position
            )
          ));
      const score = Math.min(
        minimumDistanceM,
        POPULATION_V2_PREFERRED_LAND_ANCHOR_SPACING_M
      );
      if (score > selectedScore) {
        selectedIndex = index;
        selectedScore = score;
      }
    }
    selected.push(ranked.splice(selectedIndex, 1)[0]!);
  }
  return selected.map(({ site }) => site);
}

function encounterSurfaceAreas(
  habitat: PopulationZoneV2Habitat
): Readonly<Record<PopulationV2EncounterSurface, number>> {
  return habitat.surfaceAreaKm2 ?? {
    land: habitat.eligibleLandKm2,
    lake: 0,
    river: 0,
    ocean: 0
  };
}

function candidateSurface(
  site: PopulationZoneV2HabitatCandidateSite
): PopulationV2EncounterSurface | null {
  return site.surfaceType ?? populationV2EncounterSurface({
    isLand: !site.isSaltwater && !site.insideMajorLake
      && site.weights.eligibleLand > 0,
    isSaltwater: site.isSaltwater,
    insideMajorLake: site.insideMajorLake
  });
}

function encounterOriginRank(
  generationId: string,
  surface: PopulationV2EncounterSurface,
  siteId: string
): string {
  return hashPartsHex(
    POPULATION_V2_ENCOUNTER_ORIGIN_REVISION,
    generationId,
    surface,
    siteId
  );
}

function coordinateKey(point: Readonly<{ lat: number; lon: number }>): string {
  return `${point.lat.toFixed(9)}/${point.lon.toFixed(9)}`;
}

function squaredDistance(
  left: Readonly<{ x: number; y: number }>,
  right: Readonly<{ x: number; y: number }>
): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

/**
 * Every spawn rule's kind must be a registered mob of the rule's surface (its
 * surface or one of its additional water surfaces), and
 * every combination of site layers the rules distinguish must derive a valid
 * table (plus the shared data checks: biomes, rarity or fixed share).
 */
export function validatePopulationV2SpawnRules(
  registry: PopulationV2MobRegistry = populationV2MobRegistry
): void {
  validateMobSpawnRules();
  for (const kind of MOB_SPAWN_KINDS) {
    for (const rule of MOB_SPAWN_RULES[kind]) {
      const definition = registry.definitionForKind(kind);
      if (definition === undefined
          || !populationV2MobEncounterSurfaces(definition).includes(rule.surface)) {
        throw new Error(`spawn rule ${rule.surface}/${kind} is not a registered ${rule.surface} mob`);
      }
    }
  }
  for (const facts of mobSpawnSiteFactCombinations()) {
    validatePopulationV2EncounterTables({
      ...Object.fromEntries(POPULATION_V2_ENCOUNTER_SURFACES.map((surface) =>
        [surface, defaultEncounterTable(surface)])),
      [facts.surface]: encounterTableForFacts(facts)
    });
  }
}

validatePopulationV2SpawnRules();
