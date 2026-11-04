import {
  HOLLIN_HUT_TARGET_AREA_KM2,
  destinationPoint,
  distanceMeters,
  type LatLon
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  POPULATION_V2_MOB_DEFINITIONS,
  createPopulationV2MobRegistry,
  populationV2MobRegistry
} from "./populationV2MobRegistry.js";
import { materializePopulationV2EncounterTables } from "./populationV2EncounterTables.js";
import {
  hollinHutEligibleAreaKm2,
  isHollinHutAnchor
} from "./populationV2HollinHutHabitat.js";
import { populationV2SpacingConflict, populationV2SpacingRule } from "./populationV2MobSpacing.js";
import {
  planPopulationV2RegisteredMobOverlay,
  type PopulationV2RegisteredMobOccupiedSlot
} from "./populationV2RegisteredMobOverlay.js";
import type {
  PopulationZoneV2Habitat,
  PopulationZoneV2HabitatCandidateSite
} from "./populationV2HabitatTypes.js";

const GENERATION_ID = "20000000-0000-8000-8000-000000000001";
const ORIGIN: LatLon = { lat: 35, lon: -106 };
// RESOLVE BIOME_NUM: 8 plains, 4 greenwood, 10 highmeadow, 7 savanna, 3 pinewild, 11 tundra.
const BIOME = { plains: "8", greenwood: "4", highmeadow: "10", savanna: "7", pinewild: "3", tundra: "11" } as const;

function site(index: number, overrides: Partial<PopulationZoneV2HabitatCandidateSite> = {}): PopulationZoneV2HabitatCandidateSite {
  const columns = 40;
  const row = destinationPoint(ORIGIN, Math.floor(index / columns) * 1_000, 0);
  return {
    siteId: `hut-anchor-${String(index).padStart(5, "0")}`,
    position: destinationPoint(row, (index % columns) * 1_000, 90),
    source: "world-profile-candidate-slot",
    sourceSampleId: `sample-${index}`,
    sourceCellId: `cell-${index}`,
    sourceSlotId: `slot-${index}`,
    candidateSlotVersion: "hollin-test-v1",
    placementTags: ["flat-anchor"],
    isSaltwater: false,
    insideMajorLake: false,
    surfaceType: "land",
    elevationBand: "low",
    terrainClass: "flat",
    landCoverClass: "cropland",
    biomeId: BIOME.plains,
    ecoregionId: "1",
    spawnProfileKey: "grassland",
    weights: { eligibleLand: 1, tree: 1, deer: 1, wolf: 1, stone: 1, ogre: 1 },
    ...overrides
  };
}

function habitat(landKm2: number, sites: readonly PopulationZoneV2HabitatCandidateSite[]): PopulationZoneV2Habitat {
  return {
    regionCode: "hollin-test",
    eligibleLandKm2: landKm2,
    treeKm2: landKm2, deerKm2: landKm2, wolfKm2: landKm2, stoneKm2: landKm2, ogreKm2: landKm2,
    habitatSummary: {}, environmentSnapshot: {},
    candidateSites: sites
  };
}

const sites = (count: number) => Array.from({ length: count }, (_, index) => site(index));

describe("Hollin Hut Population V2 definition", () => {
  const definition = populationV2MobRegistry.requireDefinition("hollin_hut");

  it("is an independently budgeted overlay, never an encounter-table member", () => {
    expect(definition.generationPlacement).toBe("registered_overlay");
    expect(definition.spacingClass).toBe("settlement_hut");
    expect(definition.density).toMatchObject({ model: "rare", targetAreaKm2: HOLLIN_HUT_TARGET_AREA_KM2 });
    expect(HOLLIN_HUT_TARGET_AREA_KM2).toBeGreaterThanOrEqual(10);
    expect(HOLLIN_HUT_TARGET_AREA_KM2).toBeLessThanOrEqual(20);
    expect(definition.existingGenerationRolloutEligible).toBe(true);
  });

  it("places on a new placement revision and keeps v1 slots servable", () => {
    expect(definition.placementRevision).toBe("overlay-v1-hollin-hut-single-v2");
    expect(definition.compatiblePlacementRevisions).toEqual(["overlay-v1-hollin-hut-single-v1"]);
  });

  it("allows any dry land biome and denies water", () => {
    for (const biomeId of Object.values(BIOME)) {
      expect(isHollinHutAnchor(site(0, { biomeId }))).toBe(true);
    }
    expect(isHollinHutAnchor(site(0, { biomeId: null }))).toBe(true); // wilds: unclassified land
    expect(isHollinHutAnchor(site(0, { biomeId: "13", ecoregionId: "5" }))).toBe(true); // badlands
    expect(isHollinHutAnchor(site(0, { surfaceType: "ocean", isSaltwater: true }))).toBe(false);
    expect(isHollinHutAnchor(site(0, { surfaceType: "lake", insideMajorLake: true }))).toBe(false);
    expect(isHollinHutAnchor(site(0, { surfaceType: "river" }))).toBe(false);
  });

  it("uses the zone's land area, and none without a land anchor", () => {
    const mixed = [...sites(30), ...Array.from({ length: 70 }, (_, i) => site(30 + i, { biomeId: BIOME.pinewild }))];
    expect(hollinHutEligibleAreaKm2(habitat(100, mixed))).toBe(100);
    expect(hollinHutEligibleAreaKm2(habitat(100, sites(0)))).toBe(0);
    const water = Array.from({ length: 5 }, (_, i) => site(i, { surfaceType: "ocean", isSaltwater: true }));
    expect(hollinHutEligibleAreaKm2(habitat(100, water))).toBe(0);
  });

  it("targets about one hut per 15 km2 of land in any biome and places only on land anchors", () => {
    const land = Array.from({ length: 300 }, (_, i) => site(i, { biomeId: Object.values(BIOME)[i % 6]! }));
    const water = Array.from({ length: 300 }, (_, i) => site(300 + i, { surfaceType: "ocean", isSaltwater: true }));
    const result = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID, habitat: habitat(300, [...land, ...water]), occupiedSlots: [], mobKinds: ["hollin_hut"]
    });
    const hut = result.mobs[0]!;
    expect(hut.target.groups).toBe(Math.floor(300 / HOLLIN_HUT_TARGET_AREA_KM2));
    expect(hut.inserted.groups).toBeGreaterThan(0);
    const landIds = new Set(land.map((entry) => entry.siteId));
    expect(result.slots.every((slot) => landIds.has(slot.sourceAnchorSiteId))).toBe(true);
  });

  it("plans no huts on water-only zones and about one per 15 km2 across land zones of every biome", () => {
    const biomes = Object.values(BIOME);
    const zones = 3_000;
    let huts = 0;
    for (let index = 0; index < zones; index += 1) {
      const generationId = `30000000-0000-8000-8000-${String(index).padStart(12, "0")}`;
      const biomeId = biomes[index % biomes.length]!;
      const result = planPopulationV2RegisteredMobOverlay({
        generationId, habitat: habitat(1, Array.from({ length: 40 }, (_, i) => site(i, { biomeId }))),
        occupiedSlots: [], mobKinds: ["hollin_hut"]
      });
      expect(result.slots.length).toBeLessThanOrEqual(1);
      huts += result.slots.length;
      const sea = planPopulationV2RegisteredMobOverlay({
        generationId, habitat: habitat(1, Array.from({ length: 40 }, (_, i) => site(i, { surfaceType: "ocean", isSaltwater: true }))),
        occupiedSlots: [], mobKinds: ["hollin_hut"]
      });
      expect(sea.slots).toHaveLength(0);
    }
    const expected = zones / HOLLIN_HUT_TARGET_AREA_KM2;
    expect(huts).toBeGreaterThan(expected * 0.8);
    expect(huts).toBeLessThan(expected * 1.2);
  });

  it("never adds a second hut to a generation that already holds a v1 hut", () => {
    // A real 1 km2 zone: every candidate site lies within about 1 km of the others.
    const zoneSites = Array.from({ length: 40 }, (_, i) => site(i, {
      position: destinationPoint(destinationPoint(ORIGIN, Math.floor(i / 7) * 150, 0), (i % 7) * 150, 90)
    }));
    const area = habitat(1, zoneSites);
    let rolled = 0;
    for (let index = 0; index < 400; index += 1) {
      const generationId = `40000000-0000-8000-8000-${String(index).padStart(12, "0")}`;
      const fresh = planPopulationV2RegisteredMobOverlay({
        generationId, habitat: area, occupiedSlots: [], mobKinds: ["hollin_hut"]
      });
      if (fresh.slots.length === 0) continue; // this generation's v2 roll is "no hut"
      rolled += 1;
      // The same generation already got a v1 hut elsewhere in the zone (a different anchor).
      const v1Anchor = zoneSites[39 - (index % 5)]!;
      const v1Slot: PopulationV2RegisteredMobOccupiedSlot = {
        slotId: `v1-slot-${index}`, entityId: `v1-entity-${index}`, candidateId: `v1-candidate-${index}`,
        entityKind: "hollin_hut", archetype: "hollin_hut", encounterId: null, packId: null, packMemberIndex: null,
        position: v1Anchor.position, anchor: v1Anchor.position, environmentSnapshot: {},
        suppressionClass: "none", placementRevision: "overlay-v1-hollin-hut-single-v1", spacingClass: "settlement_hut"
      };
      const topUp = planPopulationV2RegisteredMobOverlay({
        generationId, habitat: area, occupiedSlots: [v1Slot], mobKinds: ["hollin_hut"]
      });
      expect(topUp.slots, `generation ${index}`).toHaveLength(0);
    }
    expect(rolled).toBeGreaterThan(5);
  });

  it("keeps 2.5 km between huts and a hut-sized margin from nodes and mob camps", () => {
    const result = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID, habitat: habitat(600, sites(600)), occupiedSlots: [], mobKinds: ["hollin_hut"]
    });
    expect(result.slots.length).toBeGreaterThan(1);
    for (const a of result.slots) for (const b of result.slots) {
      if (a !== b) expect(distanceMeters(a.position, b.position)).toBeGreaterThanOrEqual(2_500);
    }
    // A tree 100 m from a candidate (inside the 150 m margin) blocks it; the same tree 200 m away does not.
    const anchor = site(0);
    const treeAt = (distanceM: number): PopulationV2RegisteredMobOccupiedSlot => {
      const position = destinationPoint(anchor.position, distanceM, 0);
      return {
        slotId: "tree-slot", entityId: "tree-entity", candidateId: "tree-candidate", entityKind: "tree", archetype: "tree",
        encounterId: null, packId: null, packMemberIndex: null, position, anchor: position,
        environmentSnapshot: {}, suppressionClass: "none"
      };
    };
    const one = (tree: PopulationV2RegisteredMobOccupiedSlot) => planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID, habitat: habitat(15, [anchor]), occupiedSlots: [tree], mobKinds: ["hollin_hut"]
    });
    const mustPlace = { ...habitat(15, [anchor]) };
    expect(mustPlace.candidateSites).toHaveLength(1);
    expect(one(treeAt(100)).slots).toHaveLength(0);
    expect(one(treeAt(200)).slots).toHaveLength(1);
    // Mob camps (a wolf pack anchor) need 250 m; the matrix is complete and symmetric.
    expect(populationV2SpacingConflict(
      { spacingClass: "settlement_hut", anchor: anchor.position, bodies: [anchor.position] },
      { spacingClass: "hostile_pack", anchor: anchor.position, bodies: [destinationPoint(anchor.position, 200, 90)] }
    )).toBe(true);
    expect(populationV2SpacingRule("settlement_hut", "large_hostile")).toEqual(populationV2SpacingRule("large_hostile", "settlement_hut"));
  });

  it("leaves every existing placement byte-identical when the overlay is added", () => {
    const withoutHut = createPopulationV2MobRegistry(
      POPULATION_V2_MOB_DEFINITIONS.filter((entry) => entry.mobKind !== "hollin_hut")
    );
    const area = habitat(500, sites(500));
    // Extra anchors halfway between the grid sites, so hut candidates are not all on encounter origins.
    const extra = Array.from({ length: 500 }, (_, index) => {
      const base = site(index);
      return site(index, { siteId: `hut-extra-${index}`, position: destinationPoint(base.position, 500, 45) });
    });
    const roomy = habitat(500, [...area.candidateSites!, ...extra]);
    const before = materializePopulationV2EncounterTables({ generationId: GENERATION_ID, habitat: area, registry: withoutHut as never });
    const after = materializePopulationV2EncounterTables({ generationId: GENERATION_ID, habitat: area });
    expect(JSON.stringify(after.slots)).toBe(JSON.stringify(before.slots));
    expect(after.slots.every((slot) => slot.entityKind !== "hollin_hut")).toBe(true);
    // The overlay then plans on top of those slots without touching them.
    const occupied = [...after.slots];
    const snapshot = JSON.stringify(occupied);
    const overlay = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID, habitat: roomy, occupiedSlots: occupied, mobKinds: ["hollin_hut"]
    });
    expect(JSON.stringify(occupied)).toBe(snapshot);
    expect(overlay.slots.length).toBeGreaterThan(0);
    expect(overlay.slots.every((slot) => slot.entityKind === "hollin_hut")).toBe(true);
  });

  it("derives a deterministic identity from generation, kind, anchor and placement revision across a restart", () => {
    const area = habitat(600, sites(600));
    const run = () => planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID, habitat: area, occupiedSlots: [], mobKinds: ["hollin_hut"]
    }).slots.map((slot) => [slot.entityId, slot.sourceAnchorSiteId]);
    expect(run()).toEqual(run());
    expect(run().length).toBeGreaterThan(0);
    const other = planPopulationV2RegisteredMobOverlay({
      generationId: "20000000-0000-8000-8000-000000000002", habitat: area, occupiedSlots: [], mobKinds: ["hollin_hut"]
    }).slots.map((slot) => slot.entityId);
    expect(other).not.toEqual(run().map(([id]) => id));
  });
});
