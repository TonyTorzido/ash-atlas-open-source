import {
  BACKPACK_DEFINITIONS,
  EQUIPMENT_DEFINITIONS,
  EQUIPMENT_UPGRADE_COSTS_V1,
  GOBLIN_MARKET_RESOURCE_UNIT_PRICES,
  GOBLIN_MARKET_WHEAT_SEED_ITEM_ID,
  MAX_EQUIPMENT_LEVEL,
  type BackpackDefinitionId,
  type EquipmentDefinitionId,
  type EquipmentGameplayFamilyId,
  type MilitaryResourceType
} from "@ash-atlas/shared";

// The floor table lives in shared (materialGrades.ts) so the category picker orders by it.
export {
  GOBLIN_MARKET_MOB_DROP_FLOOR_BY_RARITY,
  GOBLIN_MARKET_RESOURCE_UNIT_PRICES,
  GOBLIN_MARKET_WHEAT_SEED_INITIAL_STOCK,
  GOBLIN_MARKET_WHEAT_SEED_ITEM_ID,
  GOBLIN_MARKET_WHEAT_SEED_UNIT_PRICE_GOLD
} from "@ash-atlas/shared";


export const GOBLIN_MARKET_EQUIPMENT_FAMILY_BASE_PRICES = Object.freeze({
  sword: 30,
  god_sword: 1,
  axe: 35,
  hammer: 40,
  bow: 50,
  staff: 50,
  shuriken: 20,
  wand: 45,
  spear: 35,
  dagger: 20,
  brass_knuckles: 20,
  crossbow: 50,
  blowdart: 45,
  sling: 30,
  scepter: 45,
  tunic: 40,
  leather: 60,
  chain_mail: 20,
  breastplate: 50,
  heavy_helm: 25,
  heavy_gloves: 25,
  heavy_boots: 25,
  light_hood: 25,
  light_gloves: 25,
  light_boots: 25,
  training_ring: 10,
  chopping_ring: 250,
  mining_ring: 250,
  attack_ring: 400,
  // Random-roll rings sell for a token amount; dumping for Ring Shards is the main outlet.
  random_ring: 25,
  utility_glove: 25,
  utility_boot: 25,
  melee_shield: 25,
  ranged_shield: 25,
  // Starter gathering tools sell below their wood/stone/flax value (no craft-to-sell profit).
  wooden_axe: 5,
  stone_axe: 10,
  wooden_pickaxe: 5,
  stone_pickaxe: 10,
  starter_fishing_pole: 5
} as const satisfies Readonly<Record<EquipmentGameplayFamilyId, number>>);

/** Items that sell for more than their family's base price. */
const GOBLIN_MARKET_EQUIPMENT_DEFINITION_BASE_PRICES: Readonly<Partial<Record<string, number>>> = Object.freeze({
  coinwright_glove: 150
});

export const GOBLIN_MARKET_BACKPACK_PRICES = Object.freeze({
  starter_backpack: 25,
  traveler_backpack: 100,
  explorer_backpack: 250,
  trailblazer_backpack: 1_000
} as const satisfies Readonly<Record<BackpackDefinitionId, number>>);

export function goblinMarketResourceOfferGold(
  resourceType: MilitaryResourceType | typeof GOBLIN_MARKET_WHEAT_SEED_ITEM_ID,
  quantity: number
): string {
  requirePositiveSafeInteger(quantity, "Resource quantity");
  if (
    resourceType === "shell" || resourceType === "repair_kit" || resourceType === "torch" || resourceType === "shovel" ||
    resourceType === "raw_meat" || resourceType === "simple_food" || resourceType === "slag" ||
    resourceType === "freshwater_fish" || resourceType === "ashen_fish" ||
    resourceType === "refined_oil" || resourceType === "cinder_lantern" ||
    resourceType === "challengers_lantern"
  ) {
    throw new Error(
      resourceType === "raw_meat"
        ? "Legacy Raw Meat is not sold to the Goblin Market"
        : resourceType === "refined_oil"
        ? "Glimmer Oil is not sold to the Goblin Market"
        : resourceType === "cinder_lantern"
        ? "A Cinder Lantern is not sold to the Goblin Market"
        : resourceType === "challengers_lantern"
        ? "A Challenger's Lantern is not sold to the Goblin Market"
        : resourceType === "simple_food"
        ? "Simple Food is not sold to the Goblin Market"
        : resourceType === "slag"
        ? "Slag is not sold to the Goblin Market"
        : resourceType === "freshwater_fish"
        ? "Freshwater Fish is not sold to the Goblin Market"
        : resourceType === "ashen_fish"
        ? "Freshwater Fish is not sold to the Goblin Market"
        : resourceType === "shell"
        ? "Legacy Shell is not sold to the Goblin Market"
        : resourceType === "repair_kit"
          ? "Repair Kits are not sold to the Goblin Market"
          : "Torches are not sold to the Goblin Market"
    );
  }
  const unitPrice = GOBLIN_MARKET_RESOURCE_UNIT_PRICES[resourceType];
  if (unitPrice === undefined) {
    throw new Error(`${resourceType} is not sold to the Goblin Market`);
  }
  return exactGold(unitPrice * quantity);
}

export function goblinMarketEquipmentOfferGold(item: Readonly<{
  definitionId: EquipmentDefinitionId;
  itemLevel: number;
  enchantmentIdentity: string | null;
}>): string {
  // Goblin equipment offers are static by family/level. Selling a damaged
  // item destroys that exact instance and never repairs or resets condition.
  if (!Number.isInteger(item.itemLevel) || item.itemLevel < 0 || item.itemLevel > MAX_EQUIPMENT_LEVEL) {
    throw new Error(`Equipment level must be between 0 and ${MAX_EQUIPMENT_LEVEL}`);
  }
  const definition = EQUIPMENT_DEFINITIONS[item.definitionId];
  if (!definition) throw new Error(`Unknown equipment definition: ${item.definitionId}`);
  const paidUpgradeGold = EQUIPMENT_UPGRADE_COSTS_V1
    .slice(0, item.itemLevel)
    .reduce((total, cost) => total + cost, 0);
  const offer = (GOBLIN_MARKET_EQUIPMENT_DEFINITION_BASE_PRICES[item.definitionId] ??
    GOBLIN_MARKET_EQUIPMENT_FAMILY_BASE_PRICES[definition.gameplayFamilyId])
    + Math.floor(paidUpgradeGold * 0.1)
    + (item.enchantmentIdentity === null ? 0 : 250);
  return exactGold(offer);
}

export function goblinMarketBackpackOfferGold(item: Readonly<{
  definitionId: BackpackDefinitionId;
}>): string {
  if (!BACKPACK_DEFINITIONS[item.definitionId]) {
    throw new Error(`Unknown backpack definition: ${item.definitionId}`);
  }
  return exactGold(GOBLIN_MARKET_BACKPACK_PRICES[item.definitionId]);
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function exactGold(value: number): string {
  requirePositiveSafeInteger(value, "Gold offer");
  return String(value);
}
