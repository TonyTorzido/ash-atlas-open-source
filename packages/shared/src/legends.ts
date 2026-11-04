import { z } from "zod";
import type { MobArchetypeKey, MobBiomeVariantFamilyBase } from "./combat.js";
import type { WorldZoneDiscoverableBiome } from "./worldZones.js";

export const LEGEND_CATEGORIES = ["Hunting", "Legends", "Discovery", "Gathering", "Crafting", "Mastery", "Dungeons"] as const;
export const LEGEND_DIFFICULTIES = ["Adventurer", "Veteran", "Elite", "Master", "Legend"] as const;
export type LegendCategory = (typeof LEGEND_CATEGORIES)[number];
export type LegendDifficulty = (typeof LEGEND_DIFFICULTIES)[number];
export type LegendMetric =
  | `kills_${MobArchetypeKey}`
  | `profession_${"woodcutter" | "miner" | "builder" | "oil_worker" | "metallurgy"}`
  | `kills_${MobBiomeVariantFamilyBase}_family`
  | "kills_total" | "species_defeated" | "species_seen" | "habitats_mastered"
  | "drop_types" | "xoral_ring_types" | "legendary_bird_species"
  | "harvests_total" | "harvest_wood" | "harvest_stone" | "harvest_iron" | "harvest_coal" | "harvest_sulfur" | "harvest_flax_fiber"
  | "smelted_bars" | "smelt_recipe_types" | "leather_made" | "tannery_recipe_types"
  | "cloth_woven" | "meals_cooked" | "kitchen_recipe_types"
  | "sewer_wardens_defeated" | "profession_masters" | "level"
  | "poison_damage_taken"
  | "biomes_discovered" | `biome_${WorldZoneDiscoverableBiome}`;

export type LegendObjective = Readonly<{
  metric: LegendMetric;
  target: number;
  label: string;
  hint: string;
}>;

export type LegendDefinition = Readonly<{
  id: string;
  title: string;
  description: string;
  kind: "achievement" | "quest";
  category: LegendCategory;
  difficulty: LegendDifficulty;
  points: number;
  objectives: readonly LegendObjective[];
  requires?: readonly string[];
  journey?: Readonly<{ id: string; title: string; chapter: number; chapters: number }>;
  /** A collectible journal honor, not an equippable character title or a power bonus. */
  honor?: string;
  /** Existing gameplay systems remain responsible for these unlocks. */
  completionAuthority?: "gameplay";
  /** Describes an existing gameplay unlock without granting it from the journal. */
  reward?: string;
}>;

export const legendJournalSnapshotSchema = z.object({
  playerId: z.string(),
  metrics: z.record(z.string(), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
  completed: z.record(z.string(), z.string().datetime()),
  newlyCompletedIds: z.array(z.string()),
  serverTime: z.number().int().nonnegative()
});
export type LegendJournalSnapshot = z.infer<typeof legendJournalSnapshotSchema>;

export const LEGEND_PRESTIGE_RANKS = [
  { title: "Wayfarer", points: 0 },
  { title: "Trailblazer", points: 150 },
  { title: "Atlas Veteran", points: 500 },
  { title: "Realm Champion", points: 1_200 },
  { title: "Mythkeeper", points: 2_500 },
  { title: "Living Legend", points: 4_000 }
] as const;

export function legendObjectiveValue(metrics: Readonly<Record<string, number>>, metric: LegendMetric): number {
  const value = metrics[metric] ?? 0;
  return Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : 0;
}

export function legendProgress(definition: LegendDefinition, metrics: Readonly<Record<string, number>>): number {
  if (definition.objectives.length === 0) return 0;
  return definition.objectives.reduce((sum, objective) =>
    sum + Math.min(1, legendObjectiveValue(metrics, objective.metric) / objective.target), 0
  ) / definition.objectives.length;
}

/** Resolve a whole journey at once when a returning player's history qualifies. */
export function eligibleLegendIds(
  catalog: readonly LegendDefinition[],
  metrics: Readonly<Record<string, number>>,
  completed: ReadonlySet<string>
): string[] {
  const earned = new Set(completed);
  const newlyEarned: string[] = [];
  let changed: boolean;
  do {
    changed = false;
    for (const definition of catalog) {
      if (definition.completionAuthority === "gameplay") continue;
      if (earned.has(definition.id) || definition.objectives.length === 0) continue;
      if (definition.requires?.some((id) => !earned.has(id))) continue;
      if (!definition.objectives.every((objective) =>
        legendObjectiveValue(metrics, objective.metric) >= objective.target)) continue;
      earned.add(definition.id);
      newlyEarned.push(definition.id);
      changed = true;
    }
  } while (changed);
  return newlyEarned;
}

export function legendPrestige(catalog: readonly LegendDefinition[], completed: Readonly<Record<string, string>>) {
  const points = catalog.reduce((sum, entry) => sum + (completed[entry.id] ? entry.points : 0), 0);
  const rank = [...LEGEND_PRESTIGE_RANKS].reverse().find((entry) => points >= entry.points)!;
  const nextRank = LEGEND_PRESTIGE_RANKS.find((entry) => entry.points > points) ?? null;
  return { points, rank, nextRank };
}
