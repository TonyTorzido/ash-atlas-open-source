import {
  MOB_SPAWN_ANIMAL_SHARE,
  MOB_SPAWN_RARITY_WEIGHTS,
  MOB_SPAWN_RULES,
  mobSpawnGroup,
  mobSpawnKindCap,
  mobSpawnRuleMatches,
  mobSpawnSiteFactCombinations,
  mobSpawnTableEntries,
  type MobSpawnKind,
  type MobSpawnRarity,
  type MobSpawnRule,
  type MobSpawnSiteFacts,
  type WorldZoneLookup
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  populationV2EncounterTableForSite,
  populationV2SpawnSiteFacts,
  validatePopulationV2SpawnRules
} from "./populationV2EncounterTables.js";

type Row = Readonly<{ kind: MobSpawnKind; share: number; rarity: MobSpawnRarity | "fixed"; cap: number }>;

/** Every reachable combination of site facts with its derived table. */
const SITES = mobSpawnSiteFactCombinations().map((facts) => {
  const entries = mobSpawnTableEntries(facts);
  const rows: Row[] = entries.map(([kind, share]) => {
    const rule = (MOB_SPAWN_RULES[kind] as readonly MobSpawnRule[])
      .find((candidate) => mobSpawnRuleMatches(candidate, facts))!;
    const rarity = rule.rarity ?? "fixed";
    return { kind, share, rarity, cap: rarity === "fixed" ? 1 : mobSpawnKindCap(kind, rarity, entries.length) };
  });
  return { facts, rows };
}).filter((site) => site.rows.length > 0);
const label = (facts: MobSpawnSiteFacts) => JSON.stringify(facts);
const sum = (rows: readonly Row[]) => rows.reduce((total, row) => total + row.share, 0);
const EPSILON = 1e-9;

describe("per-mob spawn rules", () => {
  it("validate against the mob registry", () => {
    expect(() => validatePopulationV2SpawnRules()).not.toThrow();
  });

  it("derive a normalised table at every reachable combination of site facts", () => {
    expect(SITES.length).toBeGreaterThan(100);
    for (const { facts, rows } of SITES) {
      expect(sum(rows), label(facts)).toBeCloseTo(1, 12);
      expect(rows.every((row) => row.share > 0), label(facts)).toBe(true);
    }
  });

  it("weigh kinds by rarity inside a group when no cap binds", () => {
    // Greenwood: every kind is under its cap.
    const { rows } = SITES.find(({ facts }) => facts.surface === "land" && facts.biome === "greenwood")!;
    const fantasy = rows.filter((row) => row.rarity !== "fixed" && mobSpawnGroup(row.kind) === "fantasy");
    const unit = fantasy[0]!.share / MOB_SPAWN_RARITY_WEIGHTS[fantasy[0]!.rarity as MobSpawnRarity];
    for (const row of fantasy) {
      expect(row.share / MOB_SPAWN_RARITY_WEIGHTS[row.rarity as MobSpawnRarity], row.kind).toBeCloseTo(unit, 12);
    }
  });

  it("give animals 70% wherever both groups spawn, unless the other group is full to its caps", () => {
    let held = 0;
    for (const { facts, rows } of SITES) {
      const pooled = rows.filter((row) => row.rarity !== "fixed");
      const animals = pooled.filter((row) => mobSpawnGroup(row.kind) === "animal");
      const fantasy = pooled.filter((row) => mobSpawnGroup(row.kind) === "fantasy");
      if (animals.length === 0 || fantasy.length === 0) continue;
      const share = sum(animals);
      const atCap = (group: readonly Row[]) => group.every((row) => row.share >= row.cap - EPSILON);
      if (share > MOB_SPAWN_ANIMAL_SHARE + 0.005) {
        expect(atCap(fantasy), `${label(facts)} animals ${share}`).toBe(true);
      } else if (share < MOB_SPAWN_ANIMAL_SHARE - 0.005) {
        expect(atCap(animals), `${label(facts)} animals ${share}`).toBe(true);
      } else {
        held += 1;
      }
    }
    // Every land site with both groups and a known biome holds 70%, except the thin Frozen Waste
    // table, which cannot fit 70% animals under the dominance cap.
    for (const { facts, rows } of SITES) {
      if (facts.surface !== "land" || facts.biome === null || facts.biome === "frozen_waste") continue;
      const animals = rows.filter((row) => row.rarity !== "fixed" && mobSpawnGroup(row.kind) === "animal");
      expect(sum(animals), label(facts)).toBeCloseTo(MOB_SPAWN_ANIMAL_SHARE, 2);
    }
    expect(held).toBeGreaterThan(0);
  });

  it("hold the dominance cap at every reachable combination of site facts", () => {
    for (const { facts, rows } of SITES) {
      const pooled = rows.filter((row) => row.rarity !== "fixed");
      if (pooled.every((row) => row.share <= row.cap + EPSILON)) continue;
      // Only a table too thin to fit under its caps may exceed them, and then
      // every kind sits at the same multiple of its cap.
      const scale = pooled[0]!.share / pooled[0]!.cap;
      expect(scale, label(facts)).toBeGreaterThan(1);
      for (const row of pooled) {
        expect(row.share / row.cap, `${label(facts)} ${row.kind}`).toBeCloseTo(scale, 12);
      }
    }
  });

  it("keep no fixed shares in the land roster", () => {
    for (const { facts, rows } of SITES.filter(({ facts }) => facts.surface === "land")) {
      expect(rows.some((row) => row.rarity === "fixed"), label(facts)).toBe(false);
    }
  });

  it("keep every boss below 1% everywhere", () => {
    let bosses = 0;
    for (const { facts, rows } of SITES) {
      for (const row of rows.filter((candidate) => candidate.rarity === "boss")) {
        expect(row.share, `${label(facts)} ${row.kind}`).toBeLessThan(0.01);
        bosses += 1;
      }
    }
    expect(bosses).toBeGreaterThan(0);
  });

  it("match a shore filter only on lakeshore or riverside land", () => {
    // No overworld rule filters on shore any more, so exercise the matcher with a synthetic rule.
    const nearWater: MobSpawnRule = {
      surface: "land", biomes: ["jungle"], rarity: "uncommon", shore: { riverside: true }
    };
    const jungle = (shore: Readonly<{ isLakeshore?: boolean; isRiverbank?: boolean }>) =>
      populationV2SpawnSiteFacts("land", {
        biomeId: "1", ecoregionId: "1", position: { lat: 0, lon: 0 }, placementTags: [], ...shore
      }, null);
    expect(mobSpawnRuleMatches(nearWater, jungle({ isLakeshore: false, isRiverbank: true }))).toBe(true);
    expect(mobSpawnRuleMatches(nearWater, jungle({ isLakeshore: false, isRiverbank: false }))).toBe(false);
    // Unknown shore facts never match a shore filter.
    expect(mobSpawnRuleMatches(nearWater, jungle({}))).toBe(false);
  });

  it("match a band filter only at a matching elevation band", () => {
    // No overworld rule filters on elevation any more, so exercise the matcher with a synthetic rule.
    const montane: MobSpawnRule = {
      surface: "land", biomes: ["highmeadow"], rarity: "common", elevationBands: ["montane", "alpine", "high_alpine"]
    };
    const highmeadow = (band: Readonly<{ elevationBand?: string }>) =>
      populationV2SpawnSiteFacts("land", {
        biomeId: "10", ecoregionId: "1", position: { lat: 45, lon: 0 }, placementTags: [], ...band
      }, null);
    expect(mobSpawnRuleMatches(montane, highmeadow({ elevationBand: "montane" }))).toBe(true);
    expect(mobSpawnRuleMatches(montane, highmeadow({ elevationBand: "lowland" }))).toBe(false);
    expect(mobSpawnRuleMatches(montane, highmeadow({ elevationBand: "unknown" }))).toBe(false);
    expect(mobSpawnRuleMatches(montane, highmeadow({}))).toBe(false);
  });

  it("match an ocean depth filter only at a known depth in the listed band", () => {
    const deepOnly: MobSpawnRule = {
      surface: "ocean", biomes: ["greenwood"], unknownBiome: true, rarity: "common", oceanDepth: ["the_deep"]
    };
    // Cooked world-zone codes: 97 Shallows ... 99 The Deep (96 + depth band).
    const lookupWithCode = (code: number): WorldZoneLookup => ({
      codeAt: () => code,
      nearestCodeAt: () => null
    });
    const site = { biomeId: null, ecoregionId: null, position: { lat: 20, lon: -150 }, placementTags: [] };
    const factsWith = (lookup: WorldZoneLookup | null) =>
      populationV2SpawnSiteFacts("ocean", site, lookup);
    expect(factsWith(lookupWithCode(99)).oceanDepth).toBe("the_deep");
    expect(mobSpawnRuleMatches(deepOnly, factsWith(lookupWithCode(99)))).toBe(true);
    expect(factsWith(lookupWithCode(97)).oceanDepth).toBe("shallows");
    expect(mobSpawnRuleMatches(deepOnly, factsWith(lookupWithCode(97)))).toBe(false);
    expect(factsWith(null).oceanDepth).toBeNull();
    expect(mobSpawnRuleMatches(deepOnly, factsWith(null))).toBe(false);
    // Without the filter the rule matches every depth, known or not.
    const { oceanDepth: _ignored, ...anyDepth } = deepOnly;
    expect(mobSpawnRuleMatches(anyDepth as MobSpawnRule, factsWith(null))).toBe(true);
  });
});
