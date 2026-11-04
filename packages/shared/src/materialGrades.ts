import {
  GOBLIN_MARKET_BASE_RESOURCE_UNIT_PRICES,
  GOBLIN_MARKET_MOB_DROP_FLOOR_BY_RARITY
} from "./goblinMarketFloors.js";
import {
  INVENTORY_CATALOG,
  ITEM_RARITIES,
  type InventoryItemGroupId,
  type ItemRarity
} from "./inventoryCatalog.js";
import type { ResourceType } from "./collectibles.js";
import { MOB_DROP_ITEMS, type MobDropItemId } from "./mobDropItems.js";

/**
 * Material grades, categories and breakdown (DROPS-PROGRESSION-DESIGN sections 1-2).
 * Grade is the catalog rarity (G1 common .. G5 legendary). Category is the inventory group; a few
 * ungrouped basics (Bone, Chitin, Freshwater Fish, ...) join the category they are the basic of.
 */
export type MaterialGrade = 1 | 2 | 3 | 4 | 5;
export const HIGH_GRADE_MIN: MaterialGrade = 4;

export type MaterialTag =
  | "fang" | "horn" | "pelt" | "down" | "horsehair" | "metal" | "textile" | "fibrous" | "woody"
  | "fat" | "element:earth" | "element:air" | "element:water" | "element:dark" | "element:arcane";

/** Ungrouped basics that belong to the category they are the basic state of. */
const BASIC_CATEGORY: Readonly<Partial<Record<string, InventoryItemGroupId>>> = Object.freeze({
  bone: "bones",
  chitin: "scales",
  crab_carapace: "scales",
  shell: "scales",
  balsam_resin: "plants",
  freshwater_fish: "fish",
  jellyfish_venom: "venoms",
  leather: "hides"
});

/**
 * Never satisfy a category input and never break down: dungeon tokens, pet eggs, quest and premium
 * items, and the must-stay-rare signature materials.
 */
export const CATEGORY_INELIGIBLE_ITEM_IDS: ReadonlySet<string> = new Set([
  "raptor_scale", "giant_egg", "elder_acorn", "edict_seal", "brood_silk", "brood_egg",
  "clutch_egg", "crawler_egg", "wyrm_egg", "atlas_shrine_shard", "prison_key_fragment",
  "broken_whistle", "lumen", "gift_box", "refined_oil", "dusk_heart", "skyrise_stone",
  "fire_feather", "tempest_quill", "ice_feather", "simple_food", "food", "raw_meat"
]);

export type BreakdownStation = "tannery" | "loom" | "furnace" | "kitchen";

type BreakdownRow = Readonly<{
  station: BreakdownStation;
  outputItemId: ResourceType;
  /** Yield per input item at G1..G5. */
  yields: readonly [number, number, number, number, number];
}>;

const ROWS = {
  leather: { station: "tannery", outputItemId: "leather", yields: [3, 6, 12, 25, 60] },
  bone: { station: "tannery", outputItemId: "bone", yields: [1, 2, 4, 8, 20] },
  chitin: { station: "tannery", outputItemId: "chitin", yields: [1, 2, 4, 8, 20] },
  resin: { station: "tannery", outputItemId: "balsam_resin", yields: [1, 1, 2, 4, 10] },
  feather: { station: "loom", outputItemId: "feather", yields: [1, 2, 4, 8, 20] },
  cloth: { station: "loom", outputItemId: "cloth", yields: [2, 4, 8, 15, 40] },
  fiber: { station: "loom", outputItemId: "flax_fiber", yields: [2, 4, 8, 15, 40] },
  slag: { station: "furnace", outputItemId: "slag", yields: [1, 2, 4, 8, 20] },
  construct: { station: "furnace", outputItemId: "gearwork_essence", yields: [3, 6, 12, 25, 60] },
  gust: { station: "furnace", outputItemId: "gale_splinter", yields: [3, 6, 12, 25, 60] },
  dark: { station: "furnace", outputItemId: "umbral_essence", yields: [0, 1, 1, 2, 5] },
  crystal: { station: "furnace", outputItemId: "crystal", yields: [2, 4, 8, 16, 40] },
  oil: { station: "kitchen", outputItemId: "crude_oil", yields: [2, 4, 8, 0, 0] }
} as const satisfies Record<string, BreakdownRow>;
type BreakdownRowId = keyof typeof ROWS;

type MaterialFacts = Readonly<{ row: BreakdownRowId; tags?: readonly MaterialTag[]; yield?: number }>;

/** Breakdown lane and tags per material (section 1.3). Venoms wait for the Reagent basic. */
const MATERIAL_FACTS: Readonly<Partial<Record<string, MaterialFacts>>> = Object.freeze({
  fine_fur: { row: "leather", tags: ["pelt"] },
  beaver_pelt: { row: "leather", tags: ["pelt"] },
  fur_pelt: { row: "leather", tags: ["pelt"] },
  otter_pelt: { row: "leather", tags: ["pelt"] },
  sinew: { row: "leather" },
  bugbear_shag_pelt: { row: "leather", tags: ["pelt"] },
  jaguar_pelt: { row: "leather", tags: ["pelt"] },
  lion_mane: { row: "leather", tags: ["pelt"] },
  pantherfolk_rosette_hide: { row: "leather", tags: ["pelt"] },
  river_troll_hide: { row: "leather" },
  talonbear_pelt: { row: "leather", tags: ["pelt"] },
  centaur_horsehair: { row: "cloth", tags: ["horsehair", "textile"] },
  yakfolk_wool_bundle: { row: "cloth", tags: ["textile"] },
  antler: { row: "bone", tags: ["horn"] },
  claw: { row: "bone" },
  fang: { row: "bone", tags: ["fang"] },
  horn: { row: "bone", tags: ["horn"] },
  ibex_horn: { row: "bone", tags: ["horn"] },
  quill: { row: "bone" },
  shark_tooth: { row: "bone", tags: ["fang"] },
  troll_tooth: { row: "bone", tags: ["fang"] },
  dire_wolf_pelt: { row: "leather", tags: ["pelt"] },
  mammoth_tusk: { row: "bone", tags: ["horn"] },
  drake_tail_spike: { row: "bone" },
  drake_scale: { row: "chitin" },
  ember_scale: { row: "chitin" },
  fish_scale: { row: "chitin" },
  beetle_carapace: { row: "chitin" },
  insect_wing: { row: "chitin" },
  kappa_shell_plate: { row: "chitin" },
  merfolk_scale: { row: "chitin" },
  reptile_scale: { row: "chitin" },
  snapper_shell: { row: "chitin" },
  tortoise_scute: { row: "chitin" },
  shell: { row: "chitin" },
  down_feather: { row: "feather", tags: ["down"] },
  owl_feather: { row: "feather", tags: ["down"] },
  harpy_plume: { row: "feather" },
  grave_cloth: { row: "cloth", tags: ["textile"] },
  hangmans_rope: { row: "cloth", tags: ["textile"] },
  marauder_sand_veil: { row: "cloth", tags: ["textile"] },
  steppe_horsehair_tassel: { row: "cloth", tags: ["horsehair", "textile"] },
  fey_silk: { row: "cloth", tags: ["textile"] },
  grave_vine: { row: "fiber", tags: ["fibrous"] },
  reed_blowdart: { row: "fiber", tags: ["fibrous"] },
  balsam_resin: { row: "resin", tags: ["woody"], yield: 0 },
  dryad_heartwood: { row: "resin", tags: ["woody"] },
  living_heartwood: { row: "resin", tags: ["woody"] },
  goblin_scrap_charm: { row: "slag", tags: ["metal"] },
  ancient_coin: { row: "slag", tags: ["metal"] },
  barrow_torc: { row: "slag", tags: ["metal"] },
  drowned_compass: { row: "slag", tags: ["metal"] },
  drowned_locket: { row: "slag", tags: ["metal"] },
  merfolk_spearhead: { row: "slag", tags: ["metal"] },
  nixie_comb: { row: "slag", tags: ["metal"] },
  rimed_draugr_mail: { row: "slag", tags: ["metal"] },
  rusted_legion_blade: { row: "slag", tags: ["metal"] },
  scrap_metal: { row: "slag", tags: ["metal"] },
  slime_gel: { row: "construct", tags: ["element:water"] },
  earthen_core: { row: "construct", tags: ["element:earth"] },
  river_essence: { row: "construct", tags: ["element:water"] },
  coral_heartstone: { row: "construct", tags: ["element:water"] },
  charged_core: { row: "gust", tags: ["element:air"] },
  ectoplasm: { row: "dark", tags: ["element:dark"] },
  mana_shard: { row: "crystal", tags: ["element:arcane"] },
  crude_gem: { row: "crystal" },
  reaper_shard: { row: "crystal" },
  lakeglass_tear: { row: "crystal" },
  riverheart_stone: { row: "crystal" },
  rune_fragment: { row: "crystal" },
  animal_fat: { row: "oil", tags: ["fat"], yield: 2 },
  blubber: { row: "oil", tags: ["fat"], yield: 4 },
  // Trophies break down to their tag's basic at their grade; always behind the high-grade guard.
  alder_kings_horn: { row: "bone", tags: ["horn"] },
  chimera_horn: { row: "bone", tags: ["horn"] },
  gnoll_packlord_mask: { row: "bone" },
  kraken_beak: { row: "bone" },
  leech_mother_maw: { row: "bone", tags: ["fang"] },
  elder_serpent_horn: { row: "bone", tags: ["horn"] },
  patriarch_tusk: { row: "bone", tags: ["horn"] },
  stormwing_talon: { row: "bone" },
  coven_matron_hat: { row: "cloth", tags: ["textile"] },
  centaur_khan_banner: { row: "cloth", tags: ["textile"] },
  crow_crown: { row: "slag", tags: ["metal"] },
  frogking_crown: { row: "slag", tags: ["metal"] },
  frostborn_jarl_helm: { row: "slag", tags: ["metal"] },
  mossjaw_warboss_helm: { row: "slag", tags: ["metal"] },
  serpent_priestess_crown: { row: "slag", tags: ["metal"] },
  troll_toll_bell: { row: "slag", tags: ["metal"] },
  glacier_heart: { row: "construct", tags: ["element:water"] },
  ember_giant_heart_coal: { row: "construct", tags: ["element:earth"] }
});

export function materialGrade(itemId: string): MaterialGrade | null {
  const item = INVENTORY_CATALOG[itemId];
  if (!item || item.kind === "equipment") return null;
  return (ITEM_RARITIES.indexOf(item.rarity) + 1) as MaterialGrade;
}

export function gradeRarity(grade: MaterialGrade): ItemRarity {
  return ITEM_RARITIES[grade - 1]!;
}

export function materialCategory(itemId: string): InventoryItemGroupId | null {
  const item = INVENTORY_CATALOG[itemId];
  if (!item || item.kind === "equipment") return null;
  return BASIC_CATEGORY[itemId] ?? item.inventoryGroup ?? null;
}

export function materialTags(itemId: string): readonly MaterialTag[] {
  return MATERIAL_FACTS[itemId]?.tags ?? [];
}

export function categoryEligible(itemId: string): boolean {
  const item = INVENTORY_CATALOG[itemId];
  return Boolean(item) && item!.kind !== "equipment" && item!.stackable &&
    !CATEGORY_INELIGIBLE_ITEM_IDS.has(itemId) && materialCategory(itemId) !== null;
}

export type MaterialBreakdown = Readonly<{
  inputItemId: ResourceType;
  station: BreakdownStation;
  outputItemId: ResourceType;
  outputPerInput: number;
  grade: MaterialGrade;
}>;

/** One-way breakdown of a graded material at an owned station; null when it has none. */
export function materialBreakdown(itemId: string): MaterialBreakdown | null {
  const facts = MATERIAL_FACTS[itemId];
  const grade = materialGrade(itemId);
  if (!facts || grade === null || CATEGORY_INELIGIBLE_ITEM_IDS.has(itemId)) return null;
  const row: BreakdownRow = ROWS[facts.row];
  const outputPerInput = facts.yield ?? row.yields[grade - 1]!;
  if (outputPerInput <= 0 || row.outputItemId === itemId) return null;
  return { inputItemId: itemId as ResourceType, station: row.station, outputItemId: row.outputItemId, outputPerInput, grade };
}

/** Every breakdown a station offers, sorted by grade then input id. */
export function stationBreakdowns(station: BreakdownStation): readonly MaterialBreakdown[] {
  return Object.keys(MATERIAL_FACTS)
    .map((itemId) => materialBreakdown(itemId))
    .filter((entry): entry is MaterialBreakdown => entry !== null && entry.station === station)
    .sort((left, right) => left.grade - right.grade || left.inputItemId.localeCompare(right.inputItemId));
}

export const BREAKDOWN_MIN_BATCH_SIZE = 1;
export const BREAKDOWN_MAX_BATCH_SIZE = 25;
export const BREAKDOWN_DURATION_MS = 5_000;

/** Mob drop floor: the grade floor, raised to the breakdown value so no conversion mints gold. */
function mobDropFloor(itemId: MobDropItemId): number {
  const gradeFloor = GOBLIN_MARKET_MOB_DROP_FLOOR_BY_RARITY[MOB_DROP_ITEMS[itemId].rarity];
  const breakdown = materialBreakdown(itemId);
  if (!breakdown) return gradeFloor;
  const basicDrop = MOB_DROP_ITEMS[breakdown.outputItemId as MobDropItemId] as (typeof MOB_DROP_ITEMS)[MobDropItemId] | undefined;
  const basicFloor = basicDrop
    ? GOBLIN_MARKET_MOB_DROP_FLOOR_BY_RARITY[basicDrop.rarity]
    : (GOBLIN_MARKET_BASE_RESOURCE_UNIT_PRICES as Record<string, number | undefined>)[breakdown.outputItemId] ?? 0;
  return Math.max(gradeFloor, breakdown.outputPerInput * basicFloor);
}

export const GOBLIN_MARKET_RESOURCE_UNIT_PRICES: Readonly<Partial<Record<string, number>>> = Object.freeze({
  ...GOBLIN_MARKET_BASE_RESOURCE_UNIT_PRICES,
  ...Object.fromEntries(Object.values(MOB_DROP_ITEMS).map((item) => [item.itemId, mobDropFloor(item.itemId)]))
});

/** Goblin floor used for pick ordering; unsold items count as 0. */
export function materialFloorGold(itemId: string): number {
  return GOBLIN_MARKET_RESOURCE_UNIT_PRICES[itemId] ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Category inputs and the shared picker (rules R1-R7).

export type CategoryRequirement = Readonly<{
  groups: readonly InventoryItemGroupId[];
  minGrade?: MaterialGrade;
  maxGrade?: MaterialGrade;
  tag?: MaterialTag;
  /** Narrows the category to these item ids (Kitchen: items with a one-per-batch recipe). */
  onlyItemIds?: readonly string[];
  /** Player-facing name, e.g. "any Bones". */
  label: string;
}>;

export type CategoryRecipeInput = Readonly<{ category: CategoryRequirement; quantity: number }>;
export type ExactRecipeInput = Readonly<{ itemId: string; quantity: number }>;
export type CategoryPick = Readonly<{ itemId: string; quantity: number }>;

export function categoryAccepts(requirement: CategoryRequirement, itemId: string): boolean {
  if (!categoryEligible(itemId)) return false;
  const category = materialCategory(itemId);
  if (category === null || !requirement.groups.includes(category)) return false;
  const grade = materialGrade(itemId)!;
  if (requirement.minGrade !== undefined && grade < requirement.minGrade) return false;
  if (requirement.maxGrade !== undefined && grade > requirement.maxGrade) return false;
  if (requirement.tag !== undefined && !materialTags(itemId).includes(requirement.tag)) return false;
  if (requirement.onlyItemIds !== undefined && !requirement.onlyItemIds.includes(itemId)) return false;
  return true;
}

/** Spendable quantity per item id: excludes protected (kept) stacks; listed items are escrowed. */
export type SpendableCounts = ReadonlyMap<string, number>;

/**
 * Eligible held items for a requirement in auto-pick order: grade ascending, Goblin floor
 * ascending, quantity held descending, then item id.
 */
export function categoryCandidates(
  requirement: CategoryRequirement,
  spendable: SpendableCounts
): readonly CategoryPick[] {
  return [...spendable]
    .filter(([itemId, quantity]) => quantity > 0 && categoryAccepts(requirement, itemId))
    .sort(([leftId, leftQty], [rightId, rightQty]) =>
      materialGrade(leftId)! - materialGrade(rightId)! ||
      materialFloorGold(leftId) - materialFloorGold(rightId) ||
      rightQty - leftQty ||
      (leftId < rightId ? -1 : leftId > rightId ? 1 : 0))
    .map(([itemId, quantity]) => ({ itemId, quantity }));
}

export type RecipeInputResolution =
  | Readonly<{
      ok: true;
      /** One list per category input, in input order. */
      picks: readonly (readonly CategoryPick[])[];
      /** Every item to debit (exact inputs plus picks), merged per item id. */
      debits: readonly CategoryPick[];
      /** Picked items at grade 4 or above (R5). */
      highGrade: readonly CategoryPick[];
    }>
  | Readonly<{ ok: false; reason: "materials_required" | "picks_changed"; label: string }>;

/**
 * The one picker the client preview and the server debit share (R3). Exact inputs are reserved
 * first; each category input then takes the lowest items in order. With `requestedPicks` (the
 * preview the player saw, or an explicit choice, R6) each pick is re-validated instead, and any
 * mismatch is `picks_changed` (R7).
 */
export function pickCategoryInputs(
  exactInputs: readonly ExactRecipeInput[],
  categoryInputs: readonly CategoryRecipeInput[],
  spendable: SpendableCounts,
  requestedPicks?: readonly (readonly CategoryPick[])[]
): RecipeInputResolution {
  const remaining = new Map(spendable);
  const debits = new Map<string, number>();
  const take = (itemId: string, quantity: number) => {
    remaining.set(itemId, (remaining.get(itemId) ?? 0) - quantity);
    debits.set(itemId, (debits.get(itemId) ?? 0) + quantity);
  };
  for (const input of exactInputs) {
    if ((remaining.get(input.itemId) ?? 0) < input.quantity) {
      return { ok: false, reason: "materials_required", label: input.itemId };
    }
    take(input.itemId, input.quantity);
  }
  if (requestedPicks !== undefined && requestedPicks.length !== categoryInputs.length) {
    return { ok: false, reason: "picks_changed", label: categoryInputs[0]?.category.label ?? "" };
  }
  const picks: CategoryPick[][] = [];
  for (const [index, input] of categoryInputs.entries()) {
    const chosen: CategoryPick[] = [];
    const requested = requestedPicks?.[index];
    if (requested !== undefined) {
      let total = 0;
      const seen = new Set<string>();
      for (const pick of requested) {
        if (!Number.isSafeInteger(pick.quantity) || pick.quantity <= 0 || seen.has(pick.itemId) ||
            !categoryAccepts(input.category, pick.itemId) ||
            (remaining.get(pick.itemId) ?? 0) < pick.quantity) {
          return { ok: false, reason: "picks_changed", label: input.category.label };
        }
        seen.add(pick.itemId);
        total += pick.quantity;
        chosen.push({ itemId: pick.itemId, quantity: pick.quantity });
      }
      if (total !== input.quantity) return { ok: false, reason: "picks_changed", label: input.category.label };
    } else {
      let need = input.quantity;
      for (const candidate of categoryCandidates(input.category, remaining)) {
        if (need === 0) break;
        const quantity = Math.min(need, candidate.quantity);
        chosen.push({ itemId: candidate.itemId, quantity });
        need -= quantity;
        remaining.set(candidate.itemId, candidate.quantity - quantity);
      }
      if (need > 0) return { ok: false, reason: "materials_required", label: input.category.label };
      for (const pick of chosen) remaining.set(pick.itemId, (remaining.get(pick.itemId) ?? 0) + pick.quantity);
    }
    for (const pick of chosen) take(pick.itemId, pick.quantity);
    picks.push(chosen);
  }
  return {
    ok: true,
    picks,
    debits: [...debits].map(([itemId, quantity]) => ({ itemId, quantity })),
    highGrade: picks.flat().filter((pick) => (materialGrade(pick.itemId) ?? 0) >= HIGH_GRADE_MIN)
  };
}

/** Scales every category input quantity by a batch size. */
export function scaleCategoryInputs(
  inputs: readonly CategoryRecipeInput[],
  multiplier: number
): readonly CategoryRecipeInput[] {
  return inputs.map((input) => ({ category: input.category, quantity: input.quantity * multiplier }));
}

/** R5 guard text: "This will use your Chimera Horn (Epic)." */
export function highGradeGuardMessage(highGrade: readonly CategoryPick[]): string {
  const names = highGrade.map((pick) => {
    const item = INVENTORY_CATALOG[pick.itemId];
    const rarity = item?.rarity ?? "epic";
    return `${item?.displayName ?? pick.itemId} (${rarity[0]!.toUpperCase()}${rarity.slice(1)})`;
  });
  return `This will use your ${names.join(", ")}.`;
}

export const HIGH_GRADE_CONFIRMATION_REQUIRED = "HIGH_GRADE_CONFIRMATION_REQUIRED";
export const CATEGORY_PICKS_CHANGED = "PICKS_CHANGED";

/** Shared category requirements for the switched recipes (section 2.2). */
export const CATEGORY = Object.freeze({
  anyBones: { groups: ["bones"], label: "any Bones" },
  anyScales: { groups: ["scales"], label: "any Scales" },
  anyScalesG2: { groups: ["scales"], minGrade: 2, label: "any Scales (grade 2+)" },
  anyVenomsG2: { groups: ["venoms"], minGrade: 2, label: "any Venoms (grade 2+)" },
  anyFish: { groups: ["fish"], label: "any Fish" },
  anyWoodyPlant: { groups: ["plants"], tag: "woody", label: "any woody Plant" }
} satisfies Record<string, CategoryRequirement>);
