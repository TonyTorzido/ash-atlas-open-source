import { describe, expect, it } from "vitest";
import { BITTER_BLOOD_ACHIEVEMENT_ID, BITTER_BLOOD_POISON_DAMAGE_REQUIRED } from "./achievements.js";
import { CREATURE_BOOK_ROSTER } from "./creatureBook.js";
import { MOB_BIOME_VARIANT_FAMILY_BASES } from "./mobContracts.js";
import { FURNACE_RECIPE_IDS } from "./furnace.js";
import { KITCHEN_RECIPE_IDS } from "./kitchen.js";
import { LEGEND_CATALOG } from "./legendCatalog.js";
import {
  eligibleLegendIds, legendPrestige, LEGEND_CATEGORIES, LEGEND_DIFFICULTIES, LEGEND_PRESTIGE_RANKS,
  type LegendDefinition, type LegendMetric
} from "./legends.js";
import { PROFESSION_IDS, professionMaxRank } from "./masteries.js";
import { CURRENT_LEVEL_CAP } from "./progression.js";
import { TANNERY_RECIPE_IDS } from "./tannery.js";
import { UNIVERSAL_FOOD_BY_MOB } from "./universalFood.js";
import { WORLD_ZONE_DISCOVERABLE_BIOMES } from "./worldZones.js";

const byId = new Map(LEGEND_CATALOG.map((entry) => [entry.id, entry]));
const species = new Set<string>(CREATURE_BOOK_ROSTER.map((entry) => entry.archetypeKey));
/** Species with hunt achievements (hunts are optional per species). */
const huntedSpecies = new Set<string>([...species].filter((key) => byId.has(`legend_hunt_${key}_1`)));
const professions = new Set<string>(PROFESSION_IDS);
const scalarMetrics = new Set<LegendMetric>([
  "kills_total", ...MOB_BIOME_VARIANT_FAMILY_BASES.map((base) => `kills_${base}_family` as const), "species_defeated", "species_seen", "habitats_mastered",
  "drop_types", "xoral_ring_types", "legendary_bird_species",
  "harvests_total", "harvest_wood", "harvest_stone", "harvest_iron",
  "harvest_coal", "harvest_sulfur", "harvest_flax_fiber",
  "smelted_bars", "smelt_recipe_types", "leather_made", "tannery_recipe_types",
  "cloth_woven", "meals_cooked", "kitchen_recipe_types",
  "sewer_wardens_defeated", "profession_masters", "level", "poison_damage_taken",
  "biomes_discovered",
  ...WORLD_ZONE_DISCOVERABLE_BIOMES.map((biome) => `biome_${biome}` as const)
]);

function qualifyingMetrics(entries: readonly LegendDefinition[]): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const entry of entries) {
    for (const objective of entry.objectives) {
      metrics[objective.metric] = Math.max(metrics[objective.metric] ?? 0, objective.target);
    }
  }
  return metrics;
}

describe("Legends journal catalogue", () => {
  it("provides varied, well-formed entries and enough prestige for the highest rank", () => {
    expect(byId.size).toBe(LEGEND_CATALOG.length);
    expect(new Set(LEGEND_CATALOG.map((entry) => entry.title)).size).toBe(LEGEND_CATALOG.length);
    const achievements = LEGEND_CATALOG.filter((entry) => entry.kind === "achievement");
    expect(achievements.length).toBeGreaterThanOrEqual(100);
    expect(achievements.length).toBeLessThanOrEqual(280);
    // Wave 1 mobs joined the Creature Book without hunts: the catalogue is unchanged.
    expect(achievements.length).toBe(260);
    expect(new Set(LEGEND_CATALOG.map((entry) => entry.category))).toEqual(new Set(LEGEND_CATEGORIES));
    expect(new Set(LEGEND_CATALOG.map((entry) => entry.difficulty))).toEqual(new Set(LEGEND_DIFFICULTIES));

    const totalPoints = LEGEND_CATALOG.reduce((total, entry) => total + entry.points, 0);
    expect(totalPoints).toBeGreaterThan(5_000);
    expect(totalPoints).toBeGreaterThan(LEGEND_PRESTIGE_RANKS.at(-1)!.points);

    for (const entry of LEGEND_CATALOG) {
      if (entry.id !== BITTER_BLOOD_ACHIEVEMENT_ID) expect(entry.id, entry.title).toMatch(/^legend_[a-z0-9_]+$/);
      expect(entry.id.length).toBeLessThanOrEqual(64);
      expect(entry.title.trim().length).toBeGreaterThan(0);
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(Number.isSafeInteger(entry.points)).toBe(true);
      expect(entry.points).toBeGreaterThanOrEqual(5);
      expect(entry.points).toBeLessThanOrEqual(100);
      expect(entry.objectives.length).toBeGreaterThan(0);
      expect(new Set(entry.objectives.map((objective) => objective.metric)).size).toBe(entry.objectives.length);
      for (const objective of entry.objectives) {
        expect(Number.isSafeInteger(objective.target), entry.id).toBe(true);
        expect(objective.target, entry.id).toBeGreaterThan(0);
        expect(objective.label.trim().length, entry.id).toBeGreaterThan(0);
        expect(objective.hint.trim().length, entry.id).toBeGreaterThan(0);
      }
    }
  });

  it("uses reachable roster metrics and keeps finite collections within current content", () => {
    const naturalSpecies = CREATURE_BOOK_ROSTER.filter((entry) => entry.habitatThreshold !== null);
    // A conservative reachable set: current species foods and rare hides alone.
    // Other existing creature drops can only make the drop-type goal easier.
    const knownDropTypes = new Set([
      ...CREATURE_BOOK_ROSTER.flatMap((entry) => UNIVERSAL_FOOD_BY_MOB[entry.archetypeKey]?.itemId ?? []),
      ...TANNERY_RECIPE_IDS
    ]);
    const finiteBounds: Partial<Record<LegendMetric, number>> = {
      species_seen: species.size,
      species_defeated: species.size,
      habitats_mastered: naturalSpecies.length,
      drop_types: knownDropTypes.size,
      xoral_ring_types: 3,
      legendary_bird_species: 3,
      smelt_recipe_types: FURNACE_RECIPE_IDS.length,
      tannery_recipe_types: TANNERY_RECIPE_IDS.length,
      kitchen_recipe_types: KITCHEN_RECIPE_IDS.length,
      profession_masters: PROFESSION_IDS.length,
      level: CURRENT_LEVEL_CAP,
      biomes_discovered: WORLD_ZONE_DISCOVERABLE_BIOMES.length,
      ...Object.fromEntries(WORLD_ZONE_DISCOVERABLE_BIOMES.map((biome) => [`biome_${biome}`, 1]))
    };
    for (const profession of PROFESSION_IDS) {
      finiteBounds[`profession_${profession}`] = professionMaxRank(profession);
    }

    const coveredSpecies = new Set<string>();
    const coveredProfessions = new Set<string>();
    for (const entry of LEGEND_CATALOG) {
      for (const objective of entry.objectives) {
        if (objective.metric.startsWith("kills_") && objective.metric !== "kills_total" && !objective.metric.endsWith("_family")) {
          const key = objective.metric.slice("kills_".length);
          expect(species.has(key), `${entry.id}: ${key} must have durable Encyclopedia kill credit`).toBe(true);
          coveredSpecies.add(key);
        } else if (objective.metric.startsWith("profession_") && objective.metric !== "profession_masters") {
          const key = objective.metric.slice("profession_".length);
          expect(professions.has(key), entry.id).toBe(true);
          coveredProfessions.add(key);
        } else {
          expect(scalarMetrics.has(objective.metric), `${entry.id}: unsupported metric`).toBe(true);
        }
        const bound = finiteBounds[objective.metric];
        if (bound !== undefined) expect(objective.target, `${entry.id}: exceeds available content`).toBeLessThanOrEqual(bound);
      }
    }
    expect(coveredSpecies).toEqual(huntedSpecies);
    expect(coveredProfessions).toEqual(professions);
  });

  it("has existing, acyclic prerequisites and complete three-chapter journeys", () => {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      expect(byId.has(id), `Missing prerequisite: ${id}`).toBe(true);
      expect(visiting.has(id), `Prerequisite cycle at ${id}`).toBe(false);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)!.requires ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const entry of LEGEND_CATALOG) visit(entry.id);

    const journeys = new Map<string, LegendDefinition[]>();
    for (const entry of LEGEND_CATALOG) {
      if (entry.kind !== "quest") {
        expect(entry.journey).toBeUndefined();
        continue;
      }
      expect(entry.journey, entry.id).toBeDefined();
      const journeyId = entry.journey!.id;
      journeys.set(journeyId, [...(journeys.get(journeyId) ?? []), entry]);
    }
    expect(journeys.size).toBeGreaterThanOrEqual(8);
    expect(journeys.size).toBeLessThanOrEqual(12);
    for (const chapters of journeys.values()) {
      chapters.sort((left, right) => left.journey!.chapter - right.journey!.chapter);
      expect(chapters).toHaveLength(3);
      expect(chapters.map((entry) => entry.journey!.chapter)).toEqual([1, 2, 3]);
      expect(new Set(chapters.map((entry) => entry.journey!.title)).size).toBe(1);
      chapters.forEach((chapter, index) => {
        expect(chapter.journey!.chapters).toBe(3);
        expect(chapter.requires ?? []).toEqual(index === 0 ? [] : [chapters[index - 1]!.id]);
        if (index < 2) expect(chapter.honor).toBeUndefined();
        else expect(chapter.honor?.length).toBeGreaterThan(0);
      });
    }
  });

  it("requires every objective, including every species in a multi-species bounty", () => {
    for (const entry of LEGEND_CATALOG.filter((candidate) => candidate.completionAuthority !== "gameplay")) {
      const metrics = qualifyingMetrics([entry]);
      const completed = new Set(entry.requires ?? []);
      expect(eligibleLegendIds([entry], metrics, completed), entry.id).toEqual([entry.id]);
      for (const objective of entry.objectives) {
        const shortOfGoal = { ...metrics, [objective.metric]: objective.target - 1 };
        expect(eligibleLegendIds([entry], shortOfGoal, completed), `${entry.id}: ${objective.metric}`).toEqual([]);
      }
    }
  });

  it("keeps later chapters locked until their prerequisite is earned", () => {
    for (const entry of LEGEND_CATALOG.filter((candidate) => candidate.requires?.length)) {
      expect(eligibleLegendIds([entry], qualifyingMetrics([entry]), new Set()), entry.id).toEqual([]);
    }
  });

  it("credits returning players through entire journeys in one reconciliation regardless of order", () => {
    const metrics = qualifyingMetrics(LEGEND_CATALOG);
    const reversedCatalog = [...LEGEND_CATALOG].reverse();
    const earned = eligibleLegendIds(reversedCatalog, metrics, new Set());
    expect(new Set(earned)).toEqual(new Set(LEGEND_CATALOG.filter((entry) => entry.completionAuthority !== "gameplay").map((entry) => entry.id)));
    const earnedSet = new Set(earned);
    expect(eligibleLegendIds(LEGEND_CATALOG, metrics, earnedSet)).toEqual([]);
    // Chapters must be emitted after their prerequisites even when supplied backwards.
    for (const entry of LEGEND_CATALOG) {
      for (const prerequisite of entry.requires ?? []) {
        expect(earned.indexOf(prerequisite)).toBeLessThan(earned.indexOf(entry.id));
      }
    }
  });

  it("bases sewer expeditions on distinct personal Rat Warden credits", () => {
    const expeditions = LEGEND_CATALOG.filter((entry) => entry.category === "Dungeons");
    expect(expeditions).toHaveLength(6);
    for (const entry of expeditions) {
      const wardenObjective = entry.objectives.find((objective) => objective.metric === "sewer_wardens_defeated");
      expect(wardenObjective, entry.id).toBeDefined();
      expect(wardenObjective!.label).toContain("distinct credited Rat Warden defeats");
      expect(wardenObjective!.hint).toContain("different Cistern Warrenss");
      expect(wardenObjective!.hint).toContain("already credited encounter adds no progress");
    }
  });
  it("does not complete anything from an empty history", () => {
    expect(eligibleLegendIds(LEGEND_CATALOG, {}, new Set())).toEqual([]);
  });

  it("integrates the existing Bitter Blood identity without awarding its gameplay unlock", () => {
    const bitterBlood = byId.get(BITTER_BLOOD_ACHIEVEMENT_ID)!;
    expect(bitterBlood).toMatchObject({
      title: "Bitter Blood", kind: "achievement", category: "Mastery", points: 25,
      completionAuthority: "gameplay",
      objectives: [{ metric: "poison_damage_taken", target: BITTER_BLOOD_POISON_DAMAGE_REQUIRED }]
    });
    expect(bitterBlood.reward).toContain("Venom Core");
    expect(bitterBlood.reward).toContain("Venomsteel");
    expect(eligibleLegendIds([bitterBlood], { poison_damage_taken: 10_000 }, new Set())).toEqual([]);
    expect(legendPrestige(LEGEND_CATALOG, { [BITTER_BLOOD_ACHIEVEMENT_ID]: "2026-09-12T00:00:00.000Z" }).points).toBe(25);
    const { completionAuthority, ...journalGoal } = bitterBlood;
    expect(completionAuthority).toBe("gameplay");
    const dependent = { ...journalGoal, id: "test_dependent", requires: [BITTER_BLOOD_ACHIEVEMENT_ID] };
    expect(eligibleLegendIds([dependent], qualifyingMetrics([dependent]), new Set())).toEqual([]);
    expect(eligibleLegendIds([dependent], qualifyingMetrics([dependent]), new Set([BITTER_BLOOD_ACHIEVEMENT_ID]))).toEqual([dependent.id]);
  });
});
