import { INVENTORY_CATALOG, type ItemRarity } from "./inventoryCatalog.js";
import type { GeneralSkillId, SpecializationId, WorldKnowledgeSkillId } from "./skillSystemV3.js";

/**
 * Mob value pass, step C (MOB-VALUE-AND-UNLOCKS sections 4 and 5): overworld mob drops unlock
 * abilities and classes.
 *
 * - Advanced General skills need a one-time discovery offering before Rank 1 (made from the Skills
 *   panel). Discovery is stored in `player_skill_world_unlocks` like World Knowledge.
 * - World Knowledge discoveries take their dungeon token plus an overworld part, in one debit.
 * - Rank 1 of each unlockable class needs a one-time writ, debited with the rank purchase.
 *
 * Anyone who already holds Rank 1 or more (or already discovered the skill) never pays.
 */
export type UnlockOfferingPart =
  | Readonly<{ kind: "item"; itemId: string; quantity: number }>
  | Readonly<{ kind: "any_item"; label: string; itemIds: readonly string[]; quantity: number }>
  /** `count` different items from the set; each counts 1 and one of each is spent (first held in listed order). */
  | Readonly<{ kind: "distinct_items"; label: string; itemIds: readonly string[]; count: number }>;

export type UnlockOffering = Readonly<{
  parts: readonly UnlockOfferingPart[];
  /** Where the parts drop, in player words (the wiki lists every creature from the drop tables). */
  where?: string;
}>;

const item = (itemId: string, quantity: number): UnlockOfferingPart => {
  if (!INVENTORY_CATALOG[itemId]) throw new Error(`Unlock offering item is not in the catalog: ${itemId}`);
  return { kind: "item", itemId, quantity };
};

const RARITY_ORDER: Readonly<Record<ItemRarity, number>> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

/** Grade 4 (epic) or grade 5 (legendary) trophies, lowest grade first so the cheapest is offered. */
export const GREAT_TROPHY_ITEM_IDS: readonly string[] = Object.values(INVENTORY_CATALOG)
  .filter((entry) => entry.inventoryGroup === "trophies" && (entry.rarity === "epic" || entry.rarity === "legendary"))
  .sort((left, right) => RARITY_ORDER[left.rarity] - RARITY_ORDER[right.rarity] || String(left.itemId).localeCompare(String(right.itemId)))
  .map((entry) => String(entry.itemId));

/** Rare Beast Mastery's overworld part: three different boss trophies. */
export const RARE_BEAST_TROPHY_ITEM_IDS: readonly string[] = ["stormwing_talon", "chimera_horn", "patriarch_tusk", "elder_serpent_horn", "kraken_beak"];

/** Section 4.1: Advanced General skills. The gateways and first-tier skills stay Skill-Point only. */
export const GENERAL_SKILL_OFFERINGS: Readonly<Partial<Record<GeneralSkillId, UnlockOffering>>> = {
  // Kestrel Strike: 6 Zephyr from the Training Hall. The Grandmaster drops one Zephyr per clear.
  perfect_strike: { parts: [item("zephyr", 6)], where: "The Grandmaster (Monastery of the Still Hand, level 22 dungeon)" },
  pierce_armor: { parts: [item("fang", 6), item("shark_tooth", 2)], where: "Wolves, big cats, hyenas, pike (everywhere); Hammerhead (open ocean)" },
  blight_strike: { parts: [item("grave_vine", 10), item("poison_gland", 5)], where: "Vine-wrapped Corpse, Vine Lurker (jungle); frogfolk (marsh, lakes)" },
  second_wind: { parts: [item("troll_gristle", 3), item("animal_fat", 10)], where: "Ogre (all land), trolls (badlands, frozen waste); hogs, marmots" },
  deathburst: { parts: [item("chimera_flame_gland", 1), item("tar_lump", 5)], where: "Chimera elite, Tar Elemental (scrubland)" },
  pursuit: { parts: [item("sinew", 5), item("centaur_horsehair", 5)], where: "Giraffe, horses (savanna, steppe), Kappa Brawler (rivers); centaurs (plains, steppe)" },
  heroism: {
    parts: [{ kind: "any_item", label: "Grade 4+ trophy", itemIds: GREAT_TROPHY_ITEM_IDS, quantity: 1 }],
    where: "Any elite or world boss trophy of grade 4 or higher"
  },
  quarry_sense: { parts: [item("monster_eye", 2), item("owl_feather", 5)], where: "Gnoll Packseer (savanna), Coven Matron (greenwood); owls (frostwood, plains)" },
  huntsmans_edge: { parts: [item("feather", 15), item("quill", 5)], where: "Birds, harpies, gnolls (most biomes); Crested Porcupine (scrubland)" },
  concentration: { parts: [item("cyclops_eye_lens", 1), item("insect_wing", 5)], where: "Cyclops Shepherd (scrubland); Emperor Dragonfly (marsh)" },
  scavenge: { parts: [item("goblin_scrap_charm", 5), item("cached_nuts", 5)], where: "Goblins (jungle, badlands); squirrels (pinewild, greenwood, frostwood)" },
  calm_mind: { parts: [item("dryad_blossom", 5), item("lakeglass_tear", 1)], where: "Dryads (pinewild, scrubland); Lake Maiden (lakes)" },
  companion_bond: { parts: [item("fine_fur", 15), item("cached_nuts", 5)], where: "Small mammals everywhere, otters (water); squirrels" },
  delvers_lore: { parts: [item("rune_fragment", 2), item("drowned_compass", 1)], where: "Frostborn Runecaster (tundra); Drowned Deckhand (coasts)" }
};

/** Section 4.2: the overworld part each World Knowledge discovery takes beside its dungeon token. */
export const WORLD_KNOWLEDGE_OVERWORLD_PARTS: Readonly<Partial<Record<WorldKnowledgeSkillId, UnlockOffering>>> = {
  wildkin_lore: { parts: [item("cached_nuts", 10), item("small_egg", 2), item("dryad_heartwood", 2), item("beaver_pelt", 1)] },
  deepstone_lore: { parts: [item("troll_tooth", 3), item("earthen_core", 3), item("crude_gem", 5)] },
  grove_lore: { parts: [item("living_heartwood", 2), item("dryad_blossom", 5), item("grave_vine", 10)] },
  edict_stride: { parts: [item("hangmans_rope", 5), item("barrow_torc", 3), item("reaper_shard", 1), item("drowned_locket", 1)] },
  rare_beast_mastery: { parts: [{ kind: "distinct_items", label: "different trophies", itemIds: RARE_BEAST_TROPHY_ITEM_IDS, count: 3 }], where: "Stormwing, Chimera, Patriarch Boar, Elder Serpent and Kraken trophies" },
};

/** Section 5: one writ per unlockable class, paid with Rank 1. Warrior and Ranger stay free. */
export const CLASS_WRITS: Readonly<Partial<Record<SpecializationId, UnlockOffering>>> = {
  knight: { parts: [item("rusted_legion_blade", 5), item("barrow_torc", 3), item("rimed_draugr_mail", 3)], where: "Skeleton Hoplite (scrubland); wights (pinewild, frostwood, highmeadow, steppe); draugr (frostwood, tundra)" },
  sentinel: { parts: [item("kappa_shell_plate", 3), item("feather", 10), item("steppe_horsehair_tassel", 5)], where: "Kappa (rivers); birds (most biomes); steppe nomads (steppe)" },
  mercenary: { parts: [item("merfolk_spearhead", 2), item("ancient_coin", 8), item("marauder_sand_veil", 3)], where: "Merfolk Harpooner (open ocean); skeletons, wights, Bandit (everywhere); Desert Marauder (badlands)" },
  ninja: { parts: [item("reed_blowdart", 5), item("poison_gland", 5), item("pantherfolk_rosette_hide", 2)], where: "Frogfolk Blowgunner (marsh); frogfolk (marsh, jungle, lakes); Pantherfolk Stalker (jungle, night)" },
  monk: { parts: [item("yakfolk_wool_bundle", 5), item("ibex_horn", 3), item("lakeglass_tear", 1)], where: "Yakfolk Stonehorn, Mountain Ibex (highmeadow); Lake Maiden (lakes)" },
  druid: { parts: [item("dryad_heartwood", 5), item("dryad_blossom", 5), item("living_heartwood", 1), item("fey_silk", 1)], where: "Dryads (pinewild, scrubland); Pinewarden, Alder King elite (pinewild)" },
  legionnaire: { parts: [item("scrap_metal", 8), item("fur_pelt", 4), item("umbral_essence", 3)], where: "Orc Brute (badlands, steppe); Cairn Wight (highmeadow); wights and Skeleton Hoplite (everywhere they roam)" },
  assassin: { parts: [item("venom_sac", 5), item("reptile_scale", 5), item("monster_eye", 2)], where: "Sidewinder (badlands); Giant Scorpion (badlands, steppe); Gnoll Packseer (savanna)" },
  rogue: { parts: [item("goblin_scrap_charm", 5), item("crude_gem", 3), item("mana_shard", 2)], where: "Canopy Goblin (jungle); Dune Goblin (badlands); Mossjaw Hexer (greenwood)" },
  merchant: { parts: [item("leather", 8), item("cloth", 6), item("iron", 3)], where: "Dromedary, Desert Marauder (badlands); Volt Elemental (plains); Gnoll Packlord elite (savanna)" },
  artificer: { parts: [item("gearwork_essence", 6), item("tar_lump", 3), item("charged_core", 1)], where: "Moss Golem (greenwood, highmeadow); Coral Golem (open ocean shallows); Rapids Elemental (rivers); Tar Elemental (scrubland); Volt Elemental (plains)" },
  voyager: { parts: [item("drowned_compass", 2), item("merfolk_scale", 3), item("down_feather", 5), item("harpy_plume", 1)], where: "Drowned Deckhand (coasts); Merfolk Harpooner (open ocean); Stormwing Chick, Storm Harpy (highmeadow)" }
};

/** What a player has already offered (the SKILL_UNLOCK_STATE frame). */
export type SkillUnlockState = Readonly<{
  discoveredGeneralSkills: readonly GeneralSkillId[];
  classWrits: readonly SpecializationId[];
}>;

/** `player_skill_world_unlocks.skill_id` for a class writ (general skills use their own id). */
export function classWritUnlockKey(specializationId: SpecializationId): string {
  return `class_writ:${specializationId}`;
}

export type OfferingPartProgress = Readonly<{
  part: UnlockOfferingPart;
  /** The item that would be spent (for "any" parts: the lowest grade one held in full, else the first). */
  itemId: string;
  label: string;
  have: number;
  need: number;
  met: boolean;
  /** Exactly what a debit spends when `met` (empty items for an unmet part's shortfall is not spent). */
  spend: readonly Readonly<{ itemId: string; quantity: number }>[];
}>;

export function offeringPartLabel(itemId: string): string {
  return INVENTORY_CATALOG[itemId]?.displayName ?? itemId;
}

/**
 * Have/need for every part of an offering. `count` returns how many of an item can be spent
 * (the server passes protected quantities already removed).
 */
export function offeringProgress(parts: readonly UnlockOfferingPart[], count: (itemId: string) => number): readonly OfferingPartProgress[] {
  return parts.map((part) => {
    if (part.kind === "item") {
      const have = Math.max(0, count(part.itemId));
      return { part, itemId: part.itemId, label: offeringPartLabel(part.itemId), have, need: part.quantity, met: have >= part.quantity, spend: [{ itemId: part.itemId, quantity: part.quantity }] };
    }
    if (part.kind === "distinct_items") {
      const held = part.itemIds.filter((candidate) => count(candidate) >= 1);
      const picked = held.slice(0, part.count);
      return {
        part,
        itemId: picked[0] ?? part.itemIds[0] ?? "",
        label: part.label,
        have: Math.min(held.length, part.count),
        need: part.count,
        met: held.length >= part.count,
        spend: picked.map((itemId) => ({ itemId, quantity: 1 }))
      };
    }
    const chosen = part.itemIds.find((candidate) => count(candidate) >= part.quantity);
    const have = part.itemIds.reduce((sum, candidate) => sum + Math.max(0, count(candidate)), 0);
    return {
      part,
      itemId: chosen ?? part.itemIds[0] ?? "",
      label: chosen ? offeringPartLabel(chosen) : part.label,
      have: chosen ? Math.max(0, count(chosen)) : Math.min(have, part.quantity - 1),
      need: part.quantity,
      met: chosen !== undefined,
      spend: chosen ? [{ itemId: chosen, quantity: part.quantity }] : []
    };
  });
}

/** One line for messages: "6 Fang, 2 Shark Tooth". */
export function offeringSummary(parts: readonly UnlockOfferingPart[]): string {
  return parts.map((part) =>
    part.kind === "distinct_items" ? `${part.count} ${part.label}` : `${part.quantity} ${part.kind === "item" ? offeringPartLabel(part.itemId) : part.label}`
  ).join(", ");
}
