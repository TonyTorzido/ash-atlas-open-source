import {
  CITY_FACILITY_COSTS,
  CITY_HOUSE_COST,
  OIL_WELL_COST,
  QUARTZ_HUT_COST,
  LIBRARY_COST,
  cityMarketUpgradeCost,
  type CityAppSnapshot,
  type CityMaterialCost,
  type CityDistrictType,
  type CityStructureSnapshot,
  type ResourceType
} from "@ash-atlas/shared";

import type { PhoneBuildRequirement } from "../../ui/PhoneHud.js";

export type PendingCityBuildAction =
  | { kind: "oil-well"; cityId: string }
  | { kind: "quartz-hut"; cityId: string }
  | { kind: "library"; cityId: string }
  | { kind: "warehouse"; cityId: string }
  | { kind: "cistern-warrens"; cityId: string }
  | { kind: "salon"; cityId: string }
  | { kind: "city-kennel"; cityId: string }
  | { kind: "warehouse-upgrade"; structure: CityStructureSnapshot }
  | { kind: "market"; cityId: string }
  | { kind: "market-upgrade"; structure: CityStructureSnapshot }
  | {
      kind: "monument";
      cityId: string;
      districtType: CityDistrictType;
    }
  | { kind: "monument-upgrade"; structure: CityStructureSnapshot };

export type PendingCityDestruction = {
  kind: "house" | "facility" | "oil-well";
  structure: CityStructureSnapshot;
};

export const cityHouseMaterialRequirements = CITY_HOUSE_COST.materials.map(
  ({ itemId, quantity }) =>
    `${quantity} ${itemId.charAt(0).toUpperCase()}${itemId.slice(1)}`
);

/**
 * Chip-ready requirements for a city cost. Material counts default to the
 * player's own inventory; pass `() => null` when another store pays them.
 */
export function cityCostRequirements(
  cost: CityMaterialCost,
  haveOf?: (itemId: ResourceType) => number | null
): PhoneBuildRequirement[] {
  return [
    ...cost.materials.map(({ itemId, quantity }) => haveOf
      ? { itemId, quantity, have: haveOf(itemId) }
      : { itemId, quantity }),
    ...(cost.cityCoins > 0 ? [{ currency: "city_coins" as const, quantity: cost.cityCoins, have: null }] : []),
    ...(cost.cityGold && cost.cityGold > 0 ? [{ currency: "city_gold" as const, quantity: cost.cityGold, have: null }] : [])
  ];
}

export function cityCostLabels(cost: Readonly<{
  materials: readonly Readonly<{ itemId: string; quantity: number }>[];
  cityCoins: number;
  cityGold?: number;
}>): string[] {
  return [
    ...cost.materials.map(({ itemId, quantity }) =>
      `${quantity.toLocaleString()} ${itemId.replaceAll("_", " ")}`
    ),
    ...(cost.cityCoins > 0
      ? [`${cost.cityCoins.toLocaleString()} City Coins`]
      : []),
    ...(cost.cityGold && cost.cityGold > 0
      ? [`${cost.cityGold.toLocaleString()} City Gold`]
      : [])
  ];
}

export function cityStructureDisplayName(structure: CityStructureSnapshot): string {
  switch (structure.type) {
    case "city_house":
      return "City House";
    case "mayor_house":
      return "Mayor House";
    case "oil_well":
      return "Oil Well";
    case "quartz_hut":
      return "Quartz Hut";
    case "library":
      return "Library";
    case "warehouse":
      return "Warehouse";
    case "cistern_warrens":
      return "Cistern Warrens";
    case "salon":
      return "City Salon";
    case "city_kennel":
      return "City Kennel";
    case "market":
      return "City Market";
    case "barracks":
      return "Barracks";
    case "armory":
    case "siege_workshop":
    case "powder_works":
      return "Retired City Structure";
    case "demolition_factory":
      return "Demolition Factory";
    case "monument":
      return structure.districtType
        ? `${structure.districtType[0]!.toUpperCase()}${structure.districtType.slice(1)} Monument`
        : "City Monument";
    case "weaponsmith":
      return "Retired City Structure";
  }
}

export type CityStructureWorldLabelParts = Readonly<{
  primary: string;
  secondary: string | null;
}>;

export function cityStructureWorldLabelParts(
  structure: CityStructureSnapshot
): CityStructureWorldLabelParts {
  const primary = cityStructureDisplayName(structure);
  switch (structure.type) {
    case "city_house":
    case "mayor_house":
    case "oil_well":
    case "quartz_hut":
    case "library":
      return {
        primary,
        secondary: `${structure.ownerUsername ?? "Unknown Player"}’s`
      };
    case "monument":
      return { primary, secondary: `Tier ${structure.tier}` };
    default:
      return { primary, secondary: null };
  }
}

export function cityBuildActionTitle(action: PendingCityBuildAction): string {
  switch (action.kind) {
    case "oil-well":
      return "Build Oil Well";
    case "quartz-hut":
      return "Build Quartz Hut";
    case "library":
      return "Build Library";
    case "warehouse":
      return "Build City Warehouse";
    case "cistern-warrens":
      return "Build Cistern Warrens";
    case "salon":
      return "Build City Salon";
    case "city-kennel":
      return "Build City Kennel";
    case "warehouse-upgrade":
      return `Upgrade Warehouse to Tier ${action.structure.tier + 1}`;
    case "market":
      return "Build City Market";
    case "market-upgrade":
      return `Upgrade City Market to level ${action.structure.tier + 1}`;
    case "monument":
      return "Build City Monument";
    case "monument-upgrade":
      return `Upgrade Monument to Tier ${action.structure.tier + 1}`;
  }
}

export function cityBuildActionSummary(
  action: PendingCityBuildAction,
  snapshot: CityAppSnapshot | null
): string {
  if (action.kind === "oil-well") {
    return `Build Oil Well using ${cityCostLabels(OIL_WELL_COST).join(", ")} from personal Inventory.`;
  }
  if (action.kind === "quartz-hut") {
    return `Build Quartz Hut using ${cityCostLabels(QUARTZ_HUT_COST).join(", ")} from personal Inventory.`;
  }
  if (action.kind === "library") {
    return `Build Library using ${cityCostLabels(LIBRARY_COST).join(", ")} from personal Inventory.`;
  }
  if (action.kind === "market-upgrade") {
    const marketCost = cityMarketUpgradeCost(action.structure.tier + 1);
    return marketCost
      ? `${cityBuildActionTitle(action)} using ${cityCostLabels(marketCost).join(", ")}. It adds one City Tower slot.`
      : "The City Market is at its highest level.";
  }
  if (!snapshot) return "Current authoritative City costs are unavailable.";
  const cost = action.kind === "warehouse"
    ? snapshot.facilityCosts.warehouse[1]
    : action.kind === "cistern-warrens"
      ? snapshot.facilityCosts.cistern_warrens[1]
    : action.kind === "salon"
      ? snapshot.facilityCosts.salon[1]
    : action.kind === "city-kennel"
      ? snapshot.facilityCosts.city_kennel[1]
    : action.kind === "warehouse-upgrade"
      ? snapshot.facilityCosts.warehouse[
          (action.structure.tier + 1) as 2 | 3
        ]
      : action.kind === "market"
        ? snapshot.civicCosts.market
        : action.kind === "monument"
          ? snapshot.civicCosts.monument[1]
          : snapshot.civicCosts.monument[
              (action.structure.tier + 1) as 2 | 3
            ];
  return `${cityBuildActionTitle(action)} using ${cityCostLabels(cost).join(", ")}.`;
}

export function cityBuildConfirmationMessage(
  action: PendingCityBuildAction,
  snapshot: CityAppSnapshot | null
): string {
  const duration = "30";
  const movement = action.kind === "oil-well" || action.kind === "quartz-hut" || action.kind === "library"
    ? " Moving away cancels construction and refunds the materials."
    : " You must remain stationary until the authoritative timer completes.";
  return `${cityBuildActionSummary(action, snapshot)} Construction takes ${duration} seconds.${movement}`;
}

export function cityDestructionConfirmationMessage(
  structure: CityStructureSnapshot
): string {
  const materialTotals = new Map<ResourceType, number>();
  const costs = structure.type === "city_house" || structure.type === "mayor_house"
    ? [CITY_HOUSE_COST]
    : structure.type === "oil_well"
      ? [OIL_WELL_COST]
    : structure.type === "quartz_hut"
      ? [QUARTZ_HUT_COST]
    : structure.type === "library"
      ? [LIBRARY_COST]
    : structure.type === "warehouse"
      ? Array.from({ length: structure.tier }, (_, index) =>
          CITY_FACILITY_COSTS.warehouse[(index + 1) as 1 | 2 | 3]
        )
      : [];
  for (const cost of costs) {
    for (const material of cost.materials) {
      materialTotals.set(
        material.itemId,
        (materialTotals.get(material.itemId) ?? 0) + material.quantity
      );
    }
  }
  const refund = [...materialTotals]
    .map(([itemId, quantity]) => `${Math.floor(quantity / 3)} ${itemId.replaceAll("_", " ")}`)
    .join(" and ");
  const consequences = structure.type === "city_house"
    ? "Destroying it ends your city membership. You may build a City House in another eligible city immediately."
    : structure.type === "mayor_house"
      ? "Destroying it ends your city membership and vacates the Mayor position. You may build a City House in another eligible city immediately."
      : structure.type === "warehouse"
        ? "All stored items will become ordinary ground drops at the Warehouse location."
        : structure.type === "oil_well"
          ? "The refund goes to personal Inventory (overflow drops at the Oil Well), and all stored Crude Oil is destroyed."
        : structure.type === "quartz_hut"
          ? "The refund goes to personal Inventory (overflow drops at the Quartz Hut), and all stored Crystal is destroyed."
        : structure.type === "library"
          ? "The refund goes to personal Inventory (overflow drops at the Library). Your Folios are kept, but students can no longer study here."
          : "The material refund goes to the active City Warehouse; overflow drops at this facility.";
  return `This destruction is permanent. The exact material refund is ${refund || "nothing"} (one-third of eligible invested materials, rounded down after summing each resource). City Coins are not refunded. ${consequences}`;
}
