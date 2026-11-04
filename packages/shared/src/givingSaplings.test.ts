import { describe, expect, it } from "vitest";

import {
  SAPLING_DAY_MS,
  decideSaplingPull,
  decideSaplingTend,
  SAPLING_PLANTABLE_BIOMES,
  evaluateSapling,
  isSaplingPlantableBiome,
  saplingBiomeRefusal,
  saplingGrowthPhase,
  saplingHeals,
  saplingMapItem
} from "./givingSaplings.js";
import { WORLD_ZONE_BIOMES } from "./worldZones.js";
import { treeVarietyForStableId } from "./givingTrees.js";

const planted = { plantedAtMs: 0, lastTendedAtMs: 0, fastGrowth: false };

describe("sapling lifecycle", () => {
  it("lives 2 days untended, then dies", () => {
    expect(evaluateSapling(planted, 2 * SAPLING_DAY_MS - 1).state).toBe("sapling");
    expect(evaluateSapling(planted, 2 * SAPLING_DAY_MS)).toEqual({ state: "dead", diedAtMs: 2 * SAPLING_DAY_MS });
  });

  it("matures after 6 tended days and after 4 once fast-tended", () => {
    const tended = { plantedAtMs: 0, lastTendedAtMs: 5 * SAPLING_DAY_MS, fastGrowth: false };
    expect(evaluateSapling(tended, 6 * SAPLING_DAY_MS)).toEqual({ state: "grown", maturedAtMs: 6 * SAPLING_DAY_MS });
    const fast = { plantedAtMs: 0, lastTendedAtMs: 3 * SAPLING_DAY_MS - 1, fastGrowth: true };
    expect(evaluateSapling(fast, 4 * SAPLING_DAY_MS - 1).state).toBe("sapling");
    expect(evaluateSapling(fast, 4 * SAPLING_DAY_MS).state).toBe("grown");
  });

  it("tends only from the next day, and any player can tend", () => {
    expect(decideSaplingTend({ sapling: planted, tenderIsOwner: false, tenderGroveLoreRank: 0, nowMs: SAPLING_DAY_MS - 1 }))
      .toMatchObject({ allowed: false, code: "SAPLING_TEND_TOO_SOON", retryAtMs: SAPLING_DAY_MS });
    expect(decideSaplingTend({ sapling: planted, tenderIsOwner: false, tenderGroveLoreRank: 3, nowMs: SAPLING_DAY_MS }))
      .toEqual({ allowed: true, fastGrowth: false });
  });

  it("grants fast growth only to the owner with Grove Lore rank 2", () => {
    const at = { sapling: planted, nowMs: SAPLING_DAY_MS };
    expect(decideSaplingTend({ ...at, tenderIsOwner: true, tenderGroveLoreRank: 1 })).toEqual({ allowed: true, fastGrowth: false });
    expect(decideSaplingTend({ ...at, tenderIsOwner: true, tenderGroveLoreRank: 2 })).toEqual({ allowed: true, fastGrowth: true });
  });

  it("refuses to tend a dead sapling", () => {
    expect(decideSaplingTend({ sapling: planted, tenderIsOwner: true, tenderGroveLoreRank: 2, nowMs: 3 * SAPLING_DAY_MS }))
      .toEqual({ allowed: false, code: "SAPLING_NOT_GROWING" });
  });

  it("pulls with rank 3 on own land, own sapling anywhere, and never in another player's territory", () => {
    const base = { sapling: planted, nowMs: 1, pullerPlayerId: "me" };
    expect(decideSaplingPull({ ...base, groveLoreRank: 2, pullerIsOwner: true, territoryOwnerPlayerId: null }))
      .toEqual({ allowed: false, code: "SAPLING_PULL_RANK_REQUIRED" });
    expect(decideSaplingPull({ ...base, groveLoreRank: 3, pullerIsOwner: true, territoryOwnerPlayerId: "other" })).toEqual({ allowed: true });
    expect(decideSaplingPull({ ...base, groveLoreRank: 3, pullerIsOwner: false, territoryOwnerPlayerId: null })).toEqual({ allowed: true });
    expect(decideSaplingPull({ ...base, groveLoreRank: 3, pullerIsOwner: false, territoryOwnerPlayerId: "me" })).toEqual({ allowed: true });
    expect(decideSaplingPull({ ...base, groveLoreRank: 3, pullerIsOwner: false, territoryOwnerPlayerId: "other" }))
      .toEqual({ allowed: false, code: "SAPLING_TERRITORY_OWNED_BY_OTHER" });
  });

  it("pulls any growing sapling with a Shovel, anyone's, anywhere, but never a grown tree", () => {
    const base = { sapling: planted, nowMs: 1, pullerPlayerId: "me", groveLoreRank: 0, hasShovel: true };
    expect(decideSaplingPull({ ...base, pullerIsOwner: false, territoryOwnerPlayerId: "other" })).toEqual({ allowed: true });
    expect(decideSaplingPull({ ...base, pullerIsOwner: false, territoryOwnerPlayerId: null })).toEqual({ allowed: true });
    expect(decideSaplingPull({ ...base, nowMs: 1.5 * SAPLING_DAY_MS, pullerIsOwner: false, territoryOwnerPlayerId: null }))
      .toEqual({ allowed: true });
    expect(decideSaplingPull({ ...base, nowMs: 30 * SAPLING_DAY_MS, pullerIsOwner: true, territoryOwnerPlayerId: null }))
      .toMatchObject({ allowed: false });
  });

  it("looks sickly once tending is due and dying in the last half day", () => {
    const input = { tendReadyAtMs: SAPLING_DAY_MS, diesAtMs: 2 * SAPLING_DAY_MS };
    expect(saplingGrowthPhase(input, SAPLING_DAY_MS - 1)).toBe("healthy");
    expect(saplingGrowthPhase(input, SAPLING_DAY_MS)).toBe("needs_tending");
    expect(saplingGrowthPhase(input, 1.5 * SAPLING_DAY_MS)).toBe("dying");
  });

  it("player trees count as Giving Trees for the healing aura", () => {
    expect(treeVarietyForStableId("sapling:7f0c0a5e-0000-4000-8000-000000000001")).toBe("giving_tree");
  });

  it("stops healing the moment tending is due and resumes only once tended", () => {
    expect(saplingHeals(planted, SAPLING_DAY_MS - 1)).toBe(true);
    expect(saplingHeals(planted, SAPLING_DAY_MS)).toBe(false);
    expect(saplingHeals(planted, 2 * SAPLING_DAY_MS)).toBe(false);
    expect(saplingHeals({ ...planted, lastTendedAtMs: SAPLING_DAY_MS }, SAPLING_DAY_MS + 1)).toBe(true);
    expect(saplingHeals({ plantedAtMs: 0, lastTendedAtMs: 5 * SAPLING_DAY_MS, fastGrowth: false }, 6 * SAPLING_DAY_MS)).toBe(true);
  });

  it("allows tree biomes and refuses dry, frozen and water biomes by name", () => {
    for (const biome of ["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "wilds"] as const) {
      expect(isSaplingPlantableBiome(biome)).toBe(true);
    }
    for (const biome of ["badlands", "steppe", "tundra", "frozen_waste", "coast", "open_ocean", "lake"] as const) {
      expect(isSaplingPlantableBiome(biome)).toBe(false);
    }
    expect(saplingBiomeRefusal("frozen_waste")).toContain("Frozen Waste");
    // Every biome is decided: the allow list only names real biomes.
    for (const biome of SAPLING_PLANTABLE_BIOMES) expect(WORLD_ZONE_BIOMES).toContain(biome);
  });

  it("builds compact map rows: bucketed growth, phase, and no owner or timers", () => {
    const facts = { id: "a", lat: 1, lon: 2, state: "sapling" as const, plantedAtMs: 0, lastTendedAtMs: 0, fastGrowth: false, berryReadyAtMs: null };
    expect(saplingMapItem(facts, SAPLING_DAY_MS / 2)).toEqual({
      id: "a", lat: 1, lon: 2, state: "sapling", growth: 0, phase: "healthy", berryAvailable: false
    });
    expect(saplingMapItem(facts, SAPLING_DAY_MS)).toMatchObject({ growth: 1, phase: "needs_tending" });
    expect(saplingMapItem(facts, 2 * SAPLING_DAY_MS)).toBeNull();
    const grown = { ...facts, state: "grown" as const, berryReadyAtMs: SAPLING_DAY_MS };
    expect(saplingMapItem(grown, 0)).toMatchObject({ state: "grown", growth: 10, berryAvailable: false });
    expect(saplingMapItem(grown, SAPLING_DAY_MS)).toMatchObject({ berryAvailable: true });
    expect(Object.keys(saplingMapItem(facts, 0)!).sort()).toEqual(["berryAvailable", "growth", "id", "lat", "lon", "phase", "state"]);
  });
});
