import catalogJson from "./data/progression-icon-presentation.json" with { type: "json" };

import { z } from "zod";

import { PROFESSION_IDS, type ProfessionId } from "./masteries.js";
import {
  GENERAL_SKILL_IDS,
  SPECIALIZATION_IDS,
  type GeneralSkillId,
  type SpecializationId
} from "./skillSystemV3.js";
import { TRADE_SKILL_IDS, isTradeSkillId, type TradeSkillId } from "./tradeSkills.js";

export type ProgressionIconGroup = "general" | "class" | "profession" | "profession-skill";
export type ProgressionIconKey = `${ProgressionIconGroup}:${string}`;

export type ProgressionIconRegistryEntry = Readonly<{
  key: ProgressionIconKey;
  id: GeneralSkillId | SpecializationId | ProfessionId | TradeSkillId;
  label: string;
  group: ProgressionIconGroup;
  atlasPath: string;
  columns: number;
  index: number;
  cellSize: 256;
}>;

const humanize = (id: string): string => id === "tradecraft"
  ? "Tradecraft"
  : id.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());

function entries(
  group: ProgressionIconGroup,
  ids: readonly string[],
  atlasPath: string,
  columns: number,
  order?: readonly (string | null)[],
  aliases: Readonly<Record<string, string>> = {}
): ProgressionIconRegistryEntry[] {
  const indices = order ?? ids;
  return ids.map((id) => ({
    key: `${group}:${id}`,
    id,
    label: humanize(id),
    group,
    atlasPath,
    columns,
    index: indices.indexOf(aliases[id] ?? id),
    cellSize: 256
  } as ProgressionIconRegistryEntry));
}

const GENERAL_ATLAS_ORDER = [
  "cleave", "shield_charge", "provoke", "pursuit", "pierce_armor",
  "blight_strike", "second_wind", "deathburst", "archery", "ricochet",
  "quarry_sense", "huntsmans_edge", "concentration", "martial_arts", "perfect_strike",
  "tactics", "taunt", "war_standard", "heroism", "cleanse", "calm_mind", "scavenge",
  "companion_bond", "delvers_lore"
] as const;
// Atlas cells 3 and 11 are retired (blank); keep the remaining cells at their positions.
const CLASS_ATLAS_ORDER = [
  "warrior", "knight", "legionnaire", null, "ranger", "mercenary", "sentinel",
  "assassin", "ninja", "monk", "rogue", null, "druid", "merchant", "artificer", "voyager"
] as const;
// The five trade skills are General Skills but keep their own atlas (group "profession-skill").
// Hunter and Breeder are retired professions and the profession-skill Metallurgy merged into the
// Metallurgy profession; their atlas cells stay in place, unused.
// Ronin has no art yet: it reuses the Ninja cell until its own icon lands.
const CLASS_ATLAS_ALIASES = { ronin: "ninja" } as const;
const PROFESSION_ATLAS_ORDER = ["woodcutter", "miner", "hunter", "oil_worker", "builder", "breeder", "metallurgy"] as const;
const PROFESSION_SKILL_ATLAS_ORDER = ["blacksmithing", "leatherworking", "alchemy", "metallurgy", "cartography", "tradecraft"] as const;

export const PROGRESSION_ICON_REGISTRY = Object.freeze([
  ...entries("general", GENERAL_SKILL_IDS.filter((id) => !isTradeSkillId(id)), "apps/client/public/assets/skills/general-skills-v3.png", 5, GENERAL_ATLAS_ORDER),
  ...entries("class", SPECIALIZATION_IDS, "apps/client/public/assets/skills/class-icons-v3.png", 4, CLASS_ATLAS_ORDER, CLASS_ATLAS_ALIASES),
  ...entries("profession", PROFESSION_IDS, "apps/client/public/assets/skills/profession-icons-v3.png", 3, PROFESSION_ATLAS_ORDER),
  ...entries("profession-skill", TRADE_SKILL_IDS, "apps/client/public/assets/skills/profession-skill-icons-v3.png", 3, PROFESSION_SKILL_ATLAS_ORDER)
]);

export function progressionIconRegistryEntry(
  group: ProgressionIconGroup,
  id: string
): ProgressionIconRegistryEntry {
  const key = progressionIconKey(group, id);
  const entry = PROGRESSION_ICON_REGISTRY.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Unknown progression icon: ${key}`);
  return entry;
}

export const progressionIconTransformSchema = z.object({
  offsetX: z.number().finite().min(-1).max(1),
  offsetY: z.number().finite().min(-1).max(1),
  scale: z.number().finite().min(0.25).max(3)
});

export const progressionIconPresentationCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  transforms: z.record(z.string(), progressionIconTransformSchema)
}).superRefine((catalog, context) => {
  const expected = PROGRESSION_ICON_REGISTRY.map((entry) => entry.key).sort();
  const actual = Object.keys(catalog.transforms).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["transforms"], message: "Progression icon key set must match the registry" });
  }
});

export type ProgressionIconTransform = z.infer<typeof progressionIconTransformSchema>;
export type ProgressionIconPresentationCatalog = z.infer<typeof progressionIconPresentationCatalogSchema>;

export function parseProgressionIconPresentationCatalog(value: unknown): ProgressionIconPresentationCatalog {
  return progressionIconPresentationCatalogSchema.parse(value);
}

export function progressionIconKey(group: ProgressionIconGroup, id: string): ProgressionIconKey {
  return `${group}:${id}`;
}

export function progressionIconTransformCss(
  transform: ProgressionIconTransform,
  renderedSize: number,
  cellSize: number
): string {
  return `translate(${transform.offsetX * renderedSize}px, ${transform.offsetY * renderedSize}px) scale(${(renderedSize / cellSize) * transform.scale})`;
}

export const PROGRESSION_ICON_PRESENTATION_CATALOG = Object.freeze(
  parseProgressionIconPresentationCatalog(catalogJson)
);
