import { readFileSync } from "node:fs";

import {
  POPULATION_BALANCE,
  mobSpawnGroup,
  mobSpawnTableEntries,
  type MobSpawnSiteBiome
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  POPULATION_V2_ENCOUNTER_DENSITY_PER_KM2,
  materializePopulationV2EncounterTables,
  populationV2EncounterTableDiagnostic,
  populationV2EncounterTableForSite,
  populationV2GenericEncounterTarget,
  selectPopulationV2EncounterOrigins,
  selectPopulationV2EncounterKind,
  simulatePopulationV2FlagEncounterDensity,
  validatePopulationV2EncounterTables,
  validatePopulationV2SpawnRules
} from "./populationV2EncounterTables.js";
import type {
  PopulationZoneV2Habitat,
  PopulationZoneV2HabitatCandidateSite
} from "./populationV2HabitatTypes.js";
import {
  POPULATION_V2_MOB_DEFINITIONS,
  POPULATION_V2_RUNTIME_MOB_KINDS,
  createPopulationV2MobRegistry,
  populationV2MobEncounterSurfaces,
  populationV2MobRegistry,
  type PopulationV2MobDefinition
} from "./populationV2MobRegistry.js";
import { populationV2RegisteredMobFormation } from
  "./populationV2RegisteredMobOverlay.js";
import type { PopulationV2EncounterSurface } from
  "./populationV2SurfaceTypes.js";
import { greatCircleDistanceMeters } from "./populationZonesV2Geometry.js";

const SURFACE_AUTHORITY = {
  releaseId: "river-surface-v1",
  manifestSha256: "a".repeat(64),
  cellSizeM: 25,
  rowId: 12,
  columnId: 34
} as const;

/** A site's table with nothing known but its surface (and coastal tag). */
const plainTable = (surface: PopulationV2EncounterSurface, coastalLand = false) =>
  populationV2EncounterTableForSite(surface, {
    biomeId: null,
    ecoregionId: null,
    position: { lat: 50, lon: -106 },
    placementTags: coastalLand ? ["coastal-land"] : []
  });
const PLAIN_TABLES = {
  land: plainTable("land"),
  lake: plainTable("lake"),
  river: plainTable("river"),
  ocean: plainTable("ocean")
};
const PLAIN_COASTAL_LAND_TABLE = plainTable("land", true);
const sumWeights = (table: Readonly<Partial<Record<string, number>>>) =>
  Object.values(table).reduce((sum: number, weight) => sum + (weight ?? 0), 0);

describe("Population Encounter Tables V1", () => {
  it("publishes the exact validated tables and supports zero and tiny weights", () => {
    // Rarity weights (common 100, uncommon 40, rare 15), animals 70% where
    // both groups spawn, and no kind above its cap (1.5x an even split below
    // nine kinds; a rare kind 15% of that).
    const cap = (kinds: number) => 1.5 / kinds;
    const lakeBride = cap(4) * 0.15;
    // Eleven ocean kinds: the 12% dominance cap; rare kinds 15% of it.
    const oceanRare = 0.12 * 0.15;
    const oceanUncommon = (1 - 5 * 0.12 - 3 * oceanRare) / 3;
    expect(PLAIN_TABLES).toEqual({
      // An unknown biome rolls only the three base animals, so they take the whole table.
      land: {
        hog: expect.closeTo(100 / 240, 12),
        wolf: expect.closeTo(100 / 240, 12),
        bear: expect.closeTo(40 / 240, 12)
      },
      // The Frog (the only animal) is capped, and so are Thrall and Bride; the excess goes to the Shellback.
      lake: {
        frog: expect.closeTo(cap(4), 12),
        drowned_bride: expect.closeTo(lakeBride, 12),
        drowned_thrall: expect.closeTo(cap(4), 12),
        shellback: expect.closeTo(1 - 2 * cap(4) - lakeBride, 12)
      },
      // Rapids Elemental needs a known upland-or-higher band, which these sites lack.
      river: { alligator: 1 },
      // Away from the ocean lookup the site reads open_water: every common and
      // rare kind sits at its cap and the three uncommons share the rest.
      ocean: {
        squid: expect.closeTo(0.12, 12),
        jellyfish: expect.closeTo(oceanRare, 12),
        humpback_whale: expect.closeTo(oceanRare, 12),
        merfolk_harpooner: expect.closeTo(0.12, 12),
        phantom_lookout: expect.closeTo(0.12, 12),
        maelstrom_spirit: expect.closeTo(oceanUncommon, 12),
        sea_serpent: expect.closeTo(oceanUncommon, 12),
        shellback: expect.closeTo(0.12, 12),
        darter: expect.closeTo(0.12, 12),
        ink_pool: expect.closeTo(oceanUncommon, 12),
        drowned_citizen: expect.closeTo(oceanRare, 12)
      }
    });
    expect(sumWeights(PLAIN_TABLES.land)).toBeCloseTo(1, 12);
    expect(() => validatePopulationV2EncounterTables({
      land: { hog: 0, wolf: 0.0005 },
      lake: { frog: 1 },
      river: { alligator: 1 },
      ocean: { squid: 0.995, jellyfish: 0.005 }
    })).not.toThrow();
    expect(() => validatePopulationV2EncounterTables({
      land: { hog: 0 },
      lake: { frog: 1 },
      river: { alligator: 1 },
      ocean: { squid: 0.995, jellyfish: 0.005 }
    })).toThrow(/no positive weight/i);
    expect(() => validatePopulationV2EncounterTables({
      land: { squid: 1 },
      lake: { frog: 1 },
      river: { alligator: 1 },
      ocean: { squid: 0.995, jellyfish: 0.005 }
    })).toThrow(/not a registered land mob/i);
  });

  it("samples deterministically and keeps the plain land shares", () => {
    const counts = new Map<string, number>();
    for (let index = 0; index < 20_000; index += 1) {
      const input = {
        generationId: `generation-${Math.floor(index / 100)}`,
        encounterOriginId: `origin-${index}`,
        surface: "land" as const
      };
      const first = selectPopulationV2EncounterKind(input);
      expect(selectPopulationV2EncounterKind(input)).toBe(first);
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }
    expect(Math.abs((counts.get("wolf") ?? 0) / 20_000 - PLAIN_TABLES.land.wolf!))
      .toBeLessThan(0.01);
    expect(Math.abs((counts.get("hog") ?? 0) / 20_000 - PLAIN_TABLES.land.hog!))
      .toBeLessThan(0.01);
    expect(Math.abs((counts.get("bear") ?? 0) / 20_000 - PLAIN_TABLES.land.bear!))
      .toBeLessThan(0.01);
  });

  it("rolls no coastal mobs on coastal land any more", () => {
    // The land roster has no shore filters: coastal land reads like inland land.
    expect(PLAIN_COASTAL_LAND_TABLE).toEqual(PLAIN_TABLES.land);
    expect(sumWeights(PLAIN_COASTAL_LAND_TABLE)).toBeCloseTo(1, 12);
    const coastal = materializePopulationV2EncounterTables({
      generationId: "coastal-land-fixture",
      habitat: habitat("land", 100, false, "fixture-biome", true)
    });
    const inland = materializePopulationV2EncounterTables({
      generationId: "coastal-land-fixture",
      habitat: habitat("land", 100)
    });
    expect(coastal.diagnostics.genericEncounterTarget)
      .toBe(inland.diagnostics.genericEncounterTarget);
    expect(coastal.diagnostics.selectedByMobKind.coastal_crab).toBeUndefined();
    expect(coastal.diagnostics.selectedByMobKind).toEqual(inland.diagnostics.selectedByMobKind);
  });

  it("deterministically keeps Jellyfish rare in open water", () => {
    let jellyfish = 0;
    const sampleCount = 100_000;
    for (let index = 0; index < sampleCount; index += 1) {
      const input = {
        generationId: `ocean-generation-${Math.floor(index / 100)}`,
        encounterOriginId: `ocean-origin-${index}`,
        surface: "ocean" as const,
        table: PLAIN_TABLES.ocean
      };
      const first = selectPopulationV2EncounterKind(input);
      expect(selectPopulationV2EncounterKind(input)).toBe(first);
      if (first === "jellyfish") jellyfish += 1;
    }
    expect(jellyfish / sampleCount).toBeCloseTo(PLAIN_TABLES.ocean.jellyfish!, 2);
    expect(PLAIN_TABLES.ocean.jellyfish!).toBeLessThan(PLAIN_TABLES.ocean.squid! / 5);
  });

  it("uses only the surface table and treats unknown land biome as land", () => {
    for (const surface of ["lake", "river", "ocean"] as const) {
      for (let index = 0; index < 100; index += 1) {
        expect(Object.keys(PLAIN_TABLES[surface])).toContain(selectPopulationV2EncounterKind({
          generationId: "surface-generation",
          encounterOriginId: `${surface}-${index}`,
          surface
        }));
      }
    }
    const unknownBiome = habitat("land", 1, false, "unknown-biome");
    const ordinaryBiome = habitat("land", 1, false, "grassland");
    expect(materializePopulationV2EncounterTables({
      generationId: "same-generation",
      habitat: unknownBiome
    }).slots.map((slot) => slot.entityKind)).toEqual(
      materializePopulationV2EncounterTables({
        generationId: "same-generation",
        habitat: ordinaryBiome
      }).slots.map((slot) => slot.entityKind)
    );
  });

  it("rolls no deer on any land biome", () => {
    const kindsFor = (
      biomeId: string,
      lat: number,
      ecoregionId: string | null = null,
      coastalLand = false
    ) => {
      const base = habitat("land", 240, false, biomeId, coastalLand);
      const result = materializePopulationV2EncounterTables({
        generationId: `deer-biome-${biomeId}-${lat}-${ecoregionId}-${coastalLand}`,
        habitat: {
          ...base,
          candidateSites: base.candidateSites.map((site) => ({
            ...site,
            ecoregionId,
            position: { ...site.position, lat: site.position.lat - 35 + lat }
          }))
        }
      });
      return new Set(result.slots.map((slot) => slot.entityKind));
    };
    const deerKinds = ["deer", "frost_deer", "jungle_deer", "marsh_deer", "sand_deer"];
    const deerIn = (kinds: Set<string>) => deerKinds.filter((kind) => kinds.has(kind));
    for (const coastal of [false, true]) {
      // RESOLVE 6 boreal forest = Frostwood; 13 desert = Badlands below 35 degrees, Steppe beyond.
      expect(deerIn(kindsFor("6", 60, "1", coastal))).toEqual([]);
      expect(deerIn(kindsFor("13", 20, "1", coastal))).toEqual([]);
      expect(deerIn(kindsFor("13", 45, "1", coastal))).toEqual([]);
    }
    expect(deerIn(kindsFor("1", 0))).toEqual([]);
    expect(deerIn(kindsFor("14", 10))).toEqual([]);
    expect(deerIn(kindsFor("4", 50))).toEqual([]);
    expect(deerIn(kindsFor("fixture-biome", 50))).toEqual([]);
    // The rest of the land table still rolls.
    expect(kindsFor("13", 20, "1").has("javelina")).toBe(true);
  });

  describe("biome variant families", () => {
    // RESOLVE BIOME_NUM: 1 jungle, 4 greenwood, 6 frostwood, 7 savanna, 8 plains,
    // 9 marsh, 11 tundra (ECO_ID 0 = Frozen Waste), 12 scrubland, 13 desert
    // (Badlands below 35 degrees, Steppe at or beyond).
    const kindsOn = (
      surface: PopulationV2EncounterSurface,
      biomeId: string | null,
      lat: number,
      ecoregionId: string | null = "1",
      coastalLand = false
    ) => {
      const base = habitat(surface, 120, false, biomeId ?? "fixture-biome", coastalLand);
      const result = materializePopulationV2EncounterTables({
        generationId: `family-${surface}-${biomeId}-${lat}-${ecoregionId}-${coastalLand}`,
        habitat: {
          ...base,
          candidateSites: base.candidateSites.map((site) => ({
            ...site,
            biomeId,
            ecoregionId,
            position: { ...site.position, lat: site.position.lat - 35 + lat }
          }))
        }
      });
      return new Set(result.slots.map((slot) => slot.entityKind));
    };
    // The kinds a site's table can roll (wave 1 dilutes families too much to sample them all).
    const tableKindsOn = (
      surface: PopulationV2EncounterSurface,
      biomeId: string | null,
      lat: number,
      ecoregionId: string | null = "1",
      coastalLand = false
    ) => new Set(Object.keys(populationV2EncounterTableForSite(surface, {
      biomeId, ecoregionId, position: { lat, lon: -106 }, placementTags: coastalLand ? ["coastal-land"] : []
    })));
    const familyIn = (family: readonly string[], kinds: Set<string>) =>
      family.filter((kind) => kinds.has(kind));
    const WOLVES = ["wolf", "frost_wolf", "dune_wolf", "jungle_wolf", "bog_wolf"];
    const HOGS = ["hog", "woolly_hog", "warthog", "jungle_hog", "mud_hog", "javelina"];
    const BEARS = ["bear", "snow_bear", "black_bear", "sun_bear"];
    const CRABS = ["coastal_crab", "ice_crab", "sand_crab", "mangrove_crab"];
    const FROGS = ["frog", "frost_frog", "poison_frog", "desert_toad"];
    const GATORS = ["alligator", "caiman", "crocodile"];

    it("rolls each biome's Wolf, Hog and Bear and none where the family is absent", () => {
      for (const coastal of [false, true]) {
        const frostwood = tableKindsOn("land", "6", 60, "1", coastal);
        expect(familyIn(WOLVES, frostwood)).toEqual(["frost_wolf"]);
        expect(familyIn(HOGS, frostwood)).toEqual(["woolly_hog"]);
        expect(familyIn(BEARS, frostwood)).toEqual([]);
        const frozenWaste = tableKindsOn("land", "11", 70, "0", coastal);
        expect(familyIn(WOLVES, frozenWaste)).toEqual([]);
        expect(familyIn(HOGS, frozenWaste)).toEqual([]);
        expect(familyIn(BEARS, frozenWaste)).toEqual(["snow_bear"]);
        const badlands = tableKindsOn("land", "13", 20, "1", coastal);
        expect(familyIn(WOLVES, badlands)).toEqual([]);
        expect(familyIn(HOGS, badlands)).toEqual(["javelina"]);
        expect(familyIn(BEARS, badlands)).toEqual([]);
      }
      const tundra = tableKindsOn("land", "11", 70);
      expect(familyIn(WOLVES, tundra)).toEqual(["frost_wolf"]);
      expect(familyIn(HOGS, tundra)).toEqual([]);
      expect(familyIn(BEARS, tundra)).toEqual([]);
      const steppe = tableKindsOn("land", "13", 45);
      expect(familyIn(WOLVES, steppe)).toEqual(["dune_wolf"]);
      expect(familyIn(HOGS, steppe)).toEqual([]);
      const savanna = tableKindsOn("land", "7", 10);
      expect(familyIn(WOLVES, savanna)).toEqual([]);
      expect(familyIn(HOGS, savanna)).toEqual(["warthog"]);
      expect(familyIn(BEARS, savanna)).toEqual([]);
      const jungle = tableKindsOn("land", "1", 0);
      expect(familyIn(WOLVES, jungle)).toEqual([]);
      expect(familyIn(HOGS, jungle)).toEqual([]);
      expect(familyIn(BEARS, jungle)).toEqual([]);
      const marsh = tableKindsOn("land", "9", 10);
      expect(familyIn(WOLVES, marsh)).toEqual([]);
      expect(familyIn(HOGS, marsh)).toEqual(["mud_hog"]);
      expect(familyIn(BEARS, marsh)).toEqual([]);
      const greenwood = tableKindsOn("land", "4", 50);
      expect(familyIn(WOLVES, greenwood)).toEqual([]);
      expect(familyIn(HOGS, greenwood)).toEqual(["hog"]);
      expect(familyIn(BEARS, greenwood)).toEqual([]);
      const plains = tableKindsOn("land", "8", 45);
      expect(familyIn(WOLVES, plains)).toEqual(["wolf"]);
      expect(familyIn(HOGS, plains)).toEqual([]);
      expect(familyIn(BEARS, plains)).toEqual([]);
      const scrubland = tableKindsOn("land", "12", 40);
      expect(familyIn(WOLVES, scrubland)).toEqual([]);
      expect(familyIn(HOGS, scrubland)).toEqual(["hog"]);
      expect(familyIn(BEARS, scrubland)).toEqual([]);
      // Only an unknown biome rolls the three base animals together.
      const unknown = tableKindsOn("land", null, 50, null);
      expect(familyIn(WOLVES, unknown)).toEqual(["wolf"]);
      expect(familyIn(HOGS, unknown)).toEqual(["hog"]);
      expect(familyIn(BEARS, unknown)).toEqual(["bear"]);
    });

    it("rolls no crab on land, coastal or not", () => {
      for (const [biomeId, lat, ecoregionId] of [
        ["6", 60, "1"], ["11", 70, "0"], ["12", 40, "1"], ["13", 20, "1"], ["1", 0, "1"], ["4", 50, "1"]
      ] as const) {
        for (const coastal of [false, true]) {
          expect(familyIn(CRABS, tableKindsOn("land", biomeId, lat, ecoregionId, coastal))).toEqual([]);
        }
      }
    });

    it("rolls each biome's frog on lakes and alligator on rivers", () => {
      expect(familyIn(FROGS, kindsOn("lake", "6", 60))).toEqual(["frost_frog"]);
      expect(familyIn(FROGS, kindsOn("lake", "11", 70, "0"))).toEqual(["frost_frog"]);
      expect(familyIn(FROGS, kindsOn("lake", "1", 0))).toEqual(["poison_frog"]);
      expect(familyIn(FROGS, kindsOn("lake", "13", 45))).toEqual(["desert_toad"]);
      expect(familyIn(FROGS, kindsOn("lake", "4", 50))).toEqual(["frog"]);
      expect(familyIn(FROGS, kindsOn("lake", null, 50, null))).toEqual(["frog"]);
      expect(familyIn(GATORS, kindsOn("river", "1", 0))).toEqual(["caiman"]);
      expect(familyIn(GATORS, kindsOn("river", "7", 10))).toEqual(["crocodile"]);
      expect(familyIn(GATORS, kindsOn("river", "13", 20))).toEqual(["crocodile"]);
      // Cold rivers and every other biome keep the plain Alligator.
      expect(familyIn(GATORS, kindsOn("river", "6", 60))).toEqual(["alligator"]);
      expect(familyIn(GATORS, kindsOn("river", "4", 50))).toEqual(["alligator"]);
      expect(familyIn(GATORS, kindsOn("river", null, 50, null))).toEqual(["alligator"]);
    });

    it("rolls the Frog, River Otter and Alligator on Marsh land as well as in water", () => {
      const marshLand = tableKindsOn("land", "9", 10);
      for (const kind of ["frog", "river_otter", "alligator"]) expect(marshLand.has(kind), kind).toBe(true);
      expect(tableKindsOn("land", "4", 50).has("frog")).toBe(false);
      // Their water rules are unchanged.
      expect(tableKindsOn("lake", "9", 10).has("frog")).toBe(true);
      expect(tableKindsOn("river", "9", 10).has("alligator")).toBe(true);
      expect(tableKindsOn("river", "9", 10).has("river_otter")).toBe(true);
    });
  });

  describe("land roster", () => {
    // The owner's roster per biome (animals, then fantasy); exact, with no extras.
    const ROSTER: Readonly<Record<string, readonly string[]>> = {
      jungle: ["jungle_tapir", "mandrill", "jaguar", "vine_lurker", "lizardfolk_warrior", "snapjaw_flytrap", "capybara", "armadillo"],
      pinewild: ["red_squirrel", "hog", "wolf", "bear", "pine_dryad", "moss_troll", "barrow_wight", "field_hare"],
      greenwood: ["grey_squirrel", "hog", "badger", "moss_golem", "mossjaw_spearman", "hedge_witch", "field_hare", "red_fox"],
      frostwood: ["woolly_hog", "great_grey_owl", "frost_wolf", "barrow_wight", "rime_witch", "snow_talonbear", "arctic_hare", "wolverine"],
      plains: ["prairie_dog", "plains_bison", "wild_horse", "wolf", "centaur_outrider", "volt_elemental", "griffin", "field_hare"],
      savanna: ["warthog", "giraffe", "spotted_hyena", "lioness", "gnoll_bonebow", "thunderhorn", "basilisk", "ostrich"],
      marsh: ["mud_hog", "frog", "river_otter", "alligator", "frogfolk_blowgunner", "bloat_leech", "bog_hag", "capybara"],
      highmeadow: ["alpine_marmot", "mountain_ibex", "wild_yak", "griffin", "storm_harpy", "cairn_golem", "wolverine", "golden_eagle"],
      scrubland: ["wild_scrub_goat", "hog", "crested_porcupine", "spur_thighed_tortoise", "basilisk", "cyclops_shepherd", "olive_dryad", "field_hare"],
      badlands: ["fennec_fox", "javelina", "dromedary", "sidewinder", "giant_scorpion", "ash_drake", "dust_mummy", "armadillo"],
      steppe: ["steppe_marmot", "saiga", "wild_horse", "dune_wolf", "woolly_mammoth", "centaur_outrider", "kurgan_wight", "cairn_golem"],
      tundra: ["snow_goose", "frost_wolf", "woolly_mammoth", "frost_wraith", "yeti", "permafrost_elemental", "arctic_hare", "musk_ox"],
      frozen_waste: ["lemming", "snow_bear", "yeti", "rime_troll", "aurora_shade", "arctic_hare", "musk_ox", "seal"]
    };
    const landTable = (biome: string) => Object.fromEntries(mobSpawnTableEntries({
      surface: "land", biome: biome as MobSpawnSiteBiome, elevationBand: null, oceanDepth: null,
      coast: null, lakeshore: null, riverside: null
    }));

    it("rolls exactly the roster in each biome, normalised", () => {
      for (const [biome, kinds] of Object.entries(ROSTER)) {
        const table = landTable(biome);
        expect(Object.keys(table).sort(), biome).toEqual([...kinds].sort());
        expect(sumWeights(table), biome).toBeCloseTo(1, 12);
      }
    });

    it("gives animals 70% wherever the dominance cap allows", () => {
      for (const biome of Object.keys(ROSTER)) {
        const table = landTable(biome);
        const animals = Object.entries(table).filter(([kind]) => mobSpawnGroup(kind) === "animal")
          .reduce((sum, [, weight]) => sum + weight, 0);
        expect(animals, biome).toBeCloseTo(0.7, 9);
      }
    });

    it("rolls no unknown-biome mob but the three base animals", () => {
      expect(Object.keys(populationV2EncounterTableForSite("land", {
        biomeId: null, ecoregionId: null, position: { lat: 50, lon: -106 }, placementTags: []
      })).sort()).toEqual(["bear", "hog", "wolf"]);
    });

    it("never rolls the retired land mobs", () => {
      const retired = [
        "deer", "sap_crawler", "skeleton", "ogre", "mysterious_traveler", "bandit", "orc_brute", "elk",
        "coastal_crab", "herring_gull", "gillfolk_scout", "drowned_deckhand", "emperor_penguin"
      ];
      for (const biome of Object.keys(ROSTER)) {
        for (const kind of retired) expect(landTable(biome)[kind], `${biome} ${kind}`).toBeUndefined();
      }
    });
  });

  it("budgets equal valid area equally and matches the flag balance fixture", () => {
    for (const surface of ["land", "lake", "river", "ocean"] as const) {
      expect(populationV2GenericEncounterTarget({
        generationId: "equal-area",
        surface,
        validSurfaceAreaKm2:
          5 / POPULATION_V2_ENCOUNTER_DENSITY_PER_KM2[surface]
      })).toBe(5);
    }
    const diagnostic = populationV2EncounterTableDiagnostic();
    expect(diagnostic.expectedEncountersPerMaximumDistanceExpansionFlag)
      .toBeCloseTo(4.5, 1);
    expect(diagnostic.expectedEncountersInFresh650mCircle)
      .toBeCloseTo(8, 10);
    expect(diagnostic.maximumBodiesPerEncounter).toBe(4);
    const simulation = simulatePopulationV2FlagEncounterDensity(2_048);
    expect(simulation.meanNewlyExposedEncounters).toBeCloseTo(4.5, 0);
    expect(simulation.meanFreshCircleEncounters).toBeCloseTo(8, 0);
  });

  it("records exact encounter and body counts for benchmark fixtures", () => {
    const freshAreaKm2 = Math.PI * 0.65 ** 2;
    for (const [generationId, surface, areaKm2, encounters, bodies, kinds] of [
      // Rolls are keyed by MOB_SPAWN_RULES_REVISION (v10 since biome roster phase C); land at 2x density.
      // Shellback herds are always three bodies.
      ["benchmark-expansion", "land", 0.751, 4, 8, {
        bear: 1, hog: 1, wolf: 2
      }],
      ["benchmark-fresh", "land", freshAreaKm2, 8, 10, {
        bear: 2, hog: 5, wolf: 1
      }],
      ["benchmark-group-26", "land", freshAreaKm2, 8, 19, {
        bear: 1, hog: 1, wolf: 6
      }],
      ["benchmark-lake", "lake", freshAreaKm2, 5, 11, {
        drowned_thrall: 2, shellback: 3
      }],
      ["benchmark-river", "river", freshAreaKm2, 6, 6, { alligator: 6 }],
      ["benchmark-ocean", "ocean", freshAreaKm2, 5, 8, {
        darter: 1, ink_pool: 1, maelstrom_spirit: 2, shellback: 1
      }]
    ] as const) {
      const result = materializePopulationV2EncounterTables({
        generationId,
        habitat: habitatForArea(surface, areaKm2, 32)
      });
      expect(result.diagnostics.genericEncounterOriginsSelected)
        .toBe(encounters);
      expect(result.diagnostics.totalMobBodyCount).toBe(bodies);
      expect(result.diagnostics.selectedByMobKind).toEqual(kinds);
      expect(result.diagnostics.shortfalls).toEqual([]);
    }
  });

  it("turns five origins into five complete atomic encounters", () => {
    const result = materializePopulationV2EncounterTables({
      generationId: "five-encounters",
      habitat: habitat("land", 5)
    });
    const encounters = groupBy(
      result.slots,
      (slot) => slot.encounterId ?? slot.entityId
    );
    expect(encounters.size).toBe(5);
    expect(result.diagnostics.genericEncounterTarget).toBe(5);
    expect(result.diagnostics.genericEncounterOriginsSelected).toBe(5);
    expect(result.shortfall.groups).toBe(0);
    for (const slots of encounters.values()) {
      const definition = populationV2MobRegistry.requireDefinition(
        slots[0]!.entityKind
      );
      if (definition.spawnModel === "single") {
        expect(slots).toHaveLength(1);
      } else {
        expect(definition.packFormation!.allowedMemberCounts)
          .toContain(slots.length);
        expect(new Set(slots.map((slot) =>
          `${slot.position.lat}/${slot.position.lon}`
        )).size).toBe(slots.length);
      }
    }
  });

  it("forms Deer, Wolves, and Resin Crawlers from one origin", () => {
    for (const [kind, minimumRadius, maximumRadius, minimumPairwise] of [
      ["deer", 30, 45, 25],
      ["wolf", 46, 50, 55],
      ["sap_crawler", 18, 30, 15]
    ] as const) {
      const definition = populationV2MobRegistry.requireDefinition(kind);
      const origin = { lat: 35, lon: -106 };
      const positions = populationV2RegisteredMobFormation(
        definition,
        `${kind}-one-origin`,
        origin
      );
      expect(definition.packFormation!.allowedMemberCounts)
        .toContain(positions.length);
      for (const position of positions) {
        const radius = greatCircleDistanceMeters(origin, position);
        expect(radius).toBeGreaterThanOrEqual(minimumRadius - 0.01);
        expect(radius).toBeLessThanOrEqual(maximumRadius + 0.01);
      }
      for (let left = 0; left < positions.length; left += 1) {
        for (let right = left + 1; right < positions.length; right += 1) {
          expect(greatCircleDistanceMeters(
            positions[left]!,
            positions[right]!
          )).toBeGreaterThanOrEqual(minimumPairwise - 0.01);
        }
      }
    }
  });

  it("materializes a complete Wolf pack encounter", () => {
    let packResult: ReturnType<
      typeof materializePopulationV2EncounterTables
    > | null = null;
    for (let index = 0; index < 100 && packResult === null; index += 1) {
      const result = materializePopulationV2EncounterTables({
        generationId: `wolf-generation-${index}`,
        habitat: habitat("land", 1)
      });
      if (result.slots[0]?.entityKind === "wolf") {
        packResult = result;
      }
    }
    expect(packResult).not.toBeNull();
    expect(populationV2MobRegistry.requireDefinition("wolf").packFormation!.allowedMemberCounts)
      .toContain(packResult!.slots.length);
    expect(new Set(packResult!.slots.map((slot) => slot.packId)).size)
      .toBe(1);
    expect(packResult!.shortfall.groups).toBe(0);
  });

  it("keeps close origins and nudges exact collisions instead of dropping", () => {
    const close = habitat("land", 5, true);
    const first = materializePopulationV2EncounterTables({
      generationId: "collision-generation",
      habitat: close
    });
    const second = materializePopulationV2EncounterTables({
      generationId: "collision-generation",
      habitat: close
    });
    expect(first.diagnostics.genericEncounterOriginsSelected).toBe(5);
    expect(first.diagnostics.exactCoordinateNudges).toBe(4);
    expect(first.shortfall.groups).toBe(0);
    expect(first.slots).toEqual(second.slots);
    expect({
      ...first.diagnostics,
      materializationDurationMs: 0
    }).toEqual({
      ...second.diagnostics,
      materializationDurationMs: 0
    });
  });

  it("softly prefers 200m land spacing and deterministically falls back", () => {
    const spaced = [
      candidateSite("land", 0, false, "fixture-biome"),
      candidateSite("land", 1, false, "fixture-biome"),
      {
        ...candidateSite("land", 2, false, "fixture-biome"),
        position: { lat: 35.003, lon: -106 }
      },
      {
        ...candidateSite("land", 3, false, "fixture-biome"),
        position: { lat: 35.006, lon: -106 }
      }
    ];
    const input = {
      generationId: "soft-spacing",
      surface: "land" as const,
      target: 3,
      candidates: spaced
    };
    const first = selectPopulationV2EncounterOrigins(input);
    const second = selectPopulationV2EncounterOrigins(input);
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    for (let left = 0; left < first.length; left += 1) {
      for (let right = left + 1; right < first.length; right += 1) {
        expect(greatCircleDistanceMeters(
          first[left]!.position,
          first[right]!.position
        )).toBeGreaterThanOrEqual(200);
      }
    }

    const close = spaced.map((site, index) => ({
      ...site,
      position: { lat: 35 + index * 0.000_01, lon: -106 }
    }));
    expect(selectPopulationV2EncounterOrigins({
      ...input,
      generationId: "soft-spacing-fallback",
      candidates: close
    })).toHaveLength(3);
  });

  it("requires cached canonical river authority and keeps every surface pure", () => {
    for (const surface of ["land", "lake", "river", "ocean"] as const) {
      const result = materializePopulationV2EncounterTables({
        generationId: `${surface}-generation`,
        habitat: habitat(surface, 1)
      });
      expect(result.diagnostics.selectedBySurface[surface]).toBe(1);
      expect(result.slots).not.toHaveLength(0);
      // Every slot is a kind registered on that surface.
      expect(populationV2MobEncounterSurfaces(
        populationV2MobRegistry.requireDefinition(result.slots[0]!.entityKind)
      )).toContain(surface);
      expect(result.slots[0]!.environmentSnapshot.surfaceType).toBe(surface);
    }
    const missingAuthority = habitat("river", 1);
    missingAuthority.candidateSites![0] = {
      ...missingAuthority.candidateSites![0]!,
      surfaceAuthority: null
    };
    const rejected = materializePopulationV2EncounterTables({
      generationId: "river-missing-authority",
      habitat: missingAuthority
    });
    expect(rejected.slots).toHaveLength(0);
    expect(rejected.diagnostics.shortfalls).toEqual([{
      surface: "river",
      count: 1,
      reason: "insufficient_cached_surface_candidates"
    }]);
  });

  describe("multi-surface water mobs", () => {
    // The Alligator re-registered as a lake mob that also lives in rivers.
    const withAlligator = (surfaces: Readonly<{
      encounterSurface: PopulationV2EncounterSurface;
      additionalEncounterSurfaces?: readonly PopulationV2EncounterSurface[];
    }>) => createPopulationV2MobRegistry(POPULATION_V2_MOB_DEFINITIONS.map((definition) => {
      if (definition.mobKind !== "alligator") return definition;
      const { additionalEncounterSurfaces: _none, ...rest } = { ...definition, ...surfaces };
      return surfaces.additionalEncounterSurfaces === undefined
        ? rest
        : { ...rest, additionalEncounterSurfaces: surfaces.additionalEncounterSurfaces };
    }) as PopulationV2MobDefinition[]);

    it("accepts rules and rolls on every surface the kind declares", () => {
      const lakeAndRiver = withAlligator({ encounterSurface: "lake", additionalEncounterSurfaces: ["river", "land"] });
      expect(populationV2MobEncounterSurfaces(lakeAndRiver.requireDefinition("alligator")))
        .toEqual(["lake", "river", "land"]);
      expect(() => validatePopulationV2SpawnRules(lakeAndRiver)).not.toThrow();
      const result = materializePopulationV2EncounterTables({
        generationId: "multi-surface-river",
        habitat: habitat("river", 4),
        registry: lakeAndRiver
      });
      expect(result.diagnostics.selectedByMobKind).toEqual({ alligator: 4 });
      // Its eligible anchors count sites on all of its surfaces.
      expect(result.mobs[0]!.eligibleAnchorCount).toBe(4);
      // A kind registered on the lake alone may not hold a river rule.
      expect(() => validatePopulationV2SpawnRules(withAlligator({ encounterSurface: "lake" })))
        .toThrow("spawn rule river/alligator is not a registered river mob");
    });

    it("lets a water mob add land, and only a water mob", () => {
      const lakeAndLand = withAlligator({ encounterSurface: "lake", additionalEncounterSurfaces: ["land"] });
      expect(populationV2MobEncounterSurfaces(lakeAndLand.requireDefinition("alligator")))
        .toEqual(["lake", "land"]);
      expect(() => withAlligator({ encounterSurface: "land", additionalEncounterSurfaces: ["lake"] }))
        .toThrow("additional surfaces must be other surfaces of a water mob");
    });

    it("allows only distinct further surfaces on a water mob", () => {
      for (const surfaces of [
        { encounterSurface: "land", additionalEncounterSurfaces: ["river"] },
        { encounterSurface: "river", additionalEncounterSurfaces: ["river"] },
        { encounterSurface: "lake", additionalEncounterSurfaces: ["river", "river"] },
        { encounterSurface: "lake", additionalEncounterSurfaces: [] },
        { encounterSurface: "ocean", additionalEncounterSurfaces: ["ocean"] }
      ] as const) {
        expect(() => withAlligator(surfaces)).toThrow("additional surfaces must be other surfaces of a water mob");
      }
    });
  });

  it("registers only the intended open-world mobs (51 plus 137 wave 1)", () => {
    // Hollin Huts are an independently budgeted overlay, not an encounter-table mob.
    expect(POPULATION_V2_RUNTIME_MOB_KINDS.filter((kind) => kind !== "hollin_hut")).toEqual([
      "alpine_marmot",
      "arctic_hare",
      "armadillo",
      "capercaillie",
      "capybara",
      "deer",
      "dromedary",
      "emperor_penguin",
      "fennec_fox",
      "field_hare",
      "flying_squirrel",
      "frost_deer",
      "giraffe",
      "grey_squirrel",
      "jungle_deer",
      "lemming",
      "marsh_deer",
      "mountain_ibex",
      "peary_caribou",
      "plains_bison",
      "prairie_dog",
      "red_fox",
      "red_squirrel",
      "saiga",
      "sand_deer",
      "seal",
      "sitatunga",
      "snow_goose",
      "steppe_marmot",
      "wild_horse",
      "wild_scrub_goat",
      "wild_yak",
      "bog_wolf",
      "desert_lion",
      "dire_wolf",
      "dune_wolf",
      "frost_wolf",
      "griffin",
      "jungle_wolf",
      "lioness",
      "mandrill",
      "spotted_hyena",
      "storm_harpy",
      "sun_griffin",
      "wolf",
      "blizzard_lord",
      "cairn_golem",
      "centaur_khan",
      "cyclops_shepherd",
      "ember_giant",
      "mammoth_patriarch",
      "moss_golem",
      "ogre",
      "permafrost_elemental",
      "pinewarden",
      "stormwing",
      "volt_elemental",
      "bear",
      "black_bear",
      "bugbear_chieftain",
      "chimera",
      "ember_dragon",
      "giant_larva",
      "jaguar",
      "pantherfolk_stalker",
      "snow_bear",
      "snow_talonbear",
      "sun_bear",
      "thunderhorn",
      "wolverine",
      "yeti",
      "mysterious_traveler",
      "alder_king",
      "ash_drake",
      "badger",
      "bandit",
      "basilisk",
      "bog_hag",
      "burrowing_owl",
      "canopy_goblin",
      "centaur_outrider",
      "coven_matron",
      "crested_porcupine",
      "desert_marauder",
      "dune_goblin",
      "elk",
      "frogfolk_blowgunner",
      "frogfolk_chief",
      "frogfolk_shaman",
      "frostborn_jarl",
      "frostborn_runecaster",
      "giant_scorpion",
      "gillfolk_netter",
      "gnoll_bonebow",
      "gnoll_packlord",
      "gnoll_packseer",
      "golden_eagle",
      "great_grey_owl",
      "hedge_witch",
      "herring_gull",
      "highland_reaver",
      "hog",
      "jackalfolk_skirmisher",
      "javelina",
      "jungle_hog",
      "jungle_tapir",
      "moss_troll",
      "mossjaw_hexer",
      "mossjaw_spearman",
      "mossjaw_warboss",
      "mud_hog",
      "musk_ox",
      "olive_dryad",
      "orc_brute",
      "ostrich",
      "pine_dryad",
      "poisonfrog_raider",
      "rime_troll",
      "rime_witch",
      "scorch_troll",
      "serpent_priestess",
      "sidewinder",
      "snapjaw_flytrap",
      "spur_thighed_tortoise",
      "stag_beetle",
      "stagfolk_warden",
      "steppe_horse_archer",
      "steppe_raider",
      "stormwing_chick",
      "strawman_lord",
      "tar_elemental",
      "warthog",
      "woolly_hog",
      "woolly_mammoth",
      "yakfolk_stonehorn",
      "coastal_crab",
      "gillfolk_scout",
      "ice_crab",
      "mangrove_crab",
      "sand_crab",
      "aurora_shade",
      "barrow_wight",
      "bog_ghoul",
      "cairn_wight",
      "carrion_ghoul",
      "draugr",
      "draugr_berserker",
      "drowned_deckhand",
      "dust_mummy",
      "frost_wraith",
      "gallows_ghost",
      "kurgan_wight",
      "lizardfolk_warrior",
      "possessed_scythe",
      "restless_gravedigger",
      "salt_husk",
      "skeleton",
      "skeleton_hoplite",
      "vine_wrapped_corpse",
      "desert_toad",
      "drowned_bride",
      "drowned_thrall",
      "elder_mere_serpent",
      "frog",
      "frogfolk_tadpole",
      "frost_frog",
      "lake_maiden",
      "leech_mother",
      "muskellunge",
      "mute_swan",
      "northern_pike",
      "poison_frog",
      "snapping_turtle",
      "underice_lurker",
      "alligator",
      "beaver",
      "bridge_troll",
      "caiman",
      "crocodile",
      "frostwater_troll",
      "kappa",
      "kappa_brawler",
      "nixie",
      "rapids_elemental",
      "river_otter",
      "river_salmon",
      "coral_golem",
      "darter",
      "drowned_citizen",
      "drowned_cultist",
      "gate_warden",
      "hammerhead_shark",
      "humpback_whale",
      "ink_pool",
      "kraken",
      "maelstrom_spirit",
      "manta_ray",
      "merfolk_harpooner",
      "phantom_lookout",
      "reef_kraken",
      "sea_otter",
      "sea_serpent",
      "shellback",
      "spiny_lobster",
      "squid",
      "tide_wraith",
      "jellyfish",
      "bloat_leech",
      "emperor_dragonfly",
      "ice_worm",
      "mossjaw_sneak",
      "sap_crawler",
      "vine_lurker"
    ]);
  });

  it("keeps the new writer local, lifecycle-compatible, and river-safe", () => {
    const store = readFileSync(
      new URL("./populationZonesV2Store.ts", import.meta.url),
      "utf8"
    );
    const writer = store.slice(
      store.indexOf("private async materializeCurrentGeneration"),
      store.indexOf("async loadCurrentGenerations")
    );
    expect(writer).toContain("materializePopulationV2EncounterTables");
    expect(writer).not.toContain("loadAuthoritativeNeighborSpacingOccupants");
    expect(writer).not.toContain("worldLookup");
    expect(writer).toContain("slot.entityKind === \"tree\"");
    expect(writer).toContain("current.expiresAt.getTime() >");
    expect(writer).toContain("current.materializationRevision !==");
    expect(store).toContain("48 * 60 * 60_000");
    expect(store).toContain("status='active' AND expires_at > statement_timestamp()");
    expect(store).toContain("generation.plan_id=cutover.selected_plan_id");
    expect(store).toContain("cutover.selected_plan_id<>$3::uuid");
    expect(writer).toContain("selected_plan_id=$3::uuid");
    expect(writer).toContain("cutover_revision=cutover_revision + 1");
    expect(store).toContain("requested.entity_kind NOT IN ('alligator', 'caiman', 'crocodile')");
    expect(store).toContain(
      "min(pack_member.entity_kind) IN ('deer','frost_deer','jungle_deer','marsh_deer','sand_deer') THEN 1"
    );
    expect(store).toContain(
      "min(pack_member.entity_kind) IN ('wolf','frost_wolf','dune_wolf','jungle_wolf','bog_wolf','griffin') THEN 2"
    );
    expect(store).toContain("min(pack_member.entity_kind) IN ('sap_crawler','vine_lurker') THEN 3");
    expect(store).toMatch(
      /slot\.entity_kind NOT IN \(\s+'deer', 'frost_deer', 'jungle_deer', 'marsh_deer', 'sand_deer',\s+'wolf', 'frost_wolf', 'dune_wolf', 'jungle_wolf', 'bog_wolf', 'griffin',\s+'sap_crawler', 'vine_lurker'\s+\)/u
    );

    const riverReconciliation = readFileSync(
      new URL("./riverWaterPopulationReconciliation.ts", import.meta.url),
      "utf8"
    );
    expect(riverReconciliation).toContain(
      "WHERE slot.entity_kind NOT IN ('alligator', 'caiman', 'crocodile')"
    );
    expect(riverReconciliation).toContain(
      "environment.waterKind !== \"river\""
    );
    const backend = readFileSync(
      new URL("./populationZonesV2Backend.ts", import.meta.url),
      "utf8"
    );
    expect(backend).toContain("compatiblePlacementRevisions.includes");
    expect(populationV2MobRegistry.requireDefinition("deer")
      .compatiblePlacementRevisions).toContain("deer-group-formation-v2");
    expect(populationV2MobRegistry.requireDefinition("sap_crawler")
      .compatiblePlacementRevisions).toContain(
        "sap-crawler-group-formation-v2"
      );
  });
});

function habitat(
  surface: PopulationV2EncounterSurface,
  encounterCount: number,
  collide = false,
  biomeId = "fixture-biome",
  coastalLand = false
): PopulationZoneV2Habitat & {
  candidateSites: PopulationZoneV2HabitatCandidateSite[];
} {
  const areaKm2 = encounterCount
    / POPULATION_V2_ENCOUNTER_DENSITY_PER_KM2[surface];
  return habitatForArea(surface, areaKm2, encounterCount, collide, biomeId, coastalLand);
}

function habitatForArea(
  surface: PopulationV2EncounterSurface,
  areaKm2: number,
  candidateCount: number,
  collide = false,
  biomeId = "fixture-biome",
  coastalLand = false
): PopulationZoneV2Habitat & {
  candidateSites: PopulationZoneV2HabitatCandidateSite[];
} {
  return {
    regionCode: "fixture",
    eligibleLandKm2: surface === "land" ? areaKm2 : 0,
    treeKm2: surface === "land" ? areaKm2 : 0,
    deerKm2: surface === "land" ? areaKm2 : 0,
    wolfKm2: surface === "land" ? areaKm2 : 0,
    stoneKm2: surface === "land" ? areaKm2 : 0,
    ogreKm2: surface === "land" ? areaKm2 : 0,
    surfaceAreaKm2: {
      land: surface === "land" ? areaKm2 : 0,
      lake: surface === "lake" ? areaKm2 : 0,
      river: surface === "river" ? areaKm2 : 0,
      ocean: surface === "ocean" ? areaKm2 : 0
    },
    habitatSummary: {},
    environmentSnapshot: {},
    candidateSites: Array.from({ length: candidateCount }, (_, index) =>
      candidateSite(surface, index, collide, biomeId, coastalLand)
    )
  };
}

function candidateSite(
  surface: PopulationV2EncounterSurface,
  index: number,
  collide: boolean,
  biomeId: string,
  coastalLand = false
): PopulationZoneV2HabitatCandidateSite {
  const water = surface !== "land";
  return {
    siteId: `site-${surface}-${index}`,
    position: {
      lat: 35 + (collide ? 0 : index * 0.000_01),
      lon: -106
    },
    source: "synthetic-sample-center",
    sourceSampleId: `sample-${index}`,
    sourceCellId: null,
    sourceSlotId: null,
    candidateSlotVersion: "fixture-v1",
    placementTags: [
      "general",
      `surface:${surface}`,
      ...(coastalLand ? ["coastal-land"] : [])
    ],
    isSaltwater: surface === "ocean",
    insideMajorLake: surface === "lake",
    surfaceType: surface,
    surfaceAuthority: water ? SURFACE_AUTHORITY : null,
    elevationBand: null,
    terrainClass: null,
    landCoverClass: null,
    biomeId,
    ecoregionId: null,
    spawnProfileKey: surface === "land" ? "generic_land" : surface,
    weights: {
      eligibleLand: surface === "land" ? 1 : 0,
      tree: surface === "land" ? 1 : 0,
      deer: surface === "land" ? 1 : 0,
      wolf: surface === "land" ? 1 : 0,
      stone: surface === "land" ? 1 : 0,
      ogre: surface === "land" ? 1 : 0
    }
  };
}

function groupBy<T>(
  values: readonly T[],
  keyFor: (value: T) => string
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}
