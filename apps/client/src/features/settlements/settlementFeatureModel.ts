import type {
  CityActiveConstructionSnapshot,
  CityPhysicalConstructionAction,
  CityStructureSnapshot,
  SettlementServerMessage
} from "@ash-atlas/shared";
import type { Dispatch, SetStateAction } from "react";

import type { FlagBuildCountdown } from "../../flags/flagBuildCountdown.js";

const SETTLEMENT_FRAME_TYPES = new Set<string>([
  "KINGDOM_STATE",
  "KINGDOM_STATE_CHANGED",
  "KINGDOM_SPATIAL_CHANGES",
  "KINGDOM_CHAT_MESSAGE",
  "CITIES_SNAPSHOT",
  "CITY_MEMBERSHIP_SNAPSHOT",
  "CITY_APP",
  "CITY_STRUCTURES_SNAPSHOT",
  "GOBLIN_MARKET_SNAPSHOT",
  "GOBLIN_MARKET_SOLD",
  "GOBLIN_MARKET_PURCHASED",
  "GOBLIN_MARKET_ERROR",
  "HOLLIN_HUT_SHOP",
  "HOLLIN_HUT_PURCHASED",
  "HOLLIN_HUT_PACIFIED",
  "HOLLIN_HUT_SERVICED",
  "HOLLIN_HUT_ERROR",
  "WANDERING_MERCHANTS",
  "WANDERING_MERCHANT_SHOP",
  "WANDERING_MERCHANT_ERROR",
  "WANDERING_MERCHANT_PURCHASED",
  "CINDER_LANTERN_CRAFTED",
  "GOBLIN_VILLAGE_REMOVED",
  "OWNER_OIL_WELL_PROJECTION",
  "CITY_HOUSE_CHANGED",
  "CITY_FACILITY_CHANGED",
  "CITY_STRUCTURE_WARFARE_CHANGED",
  "OIL_WELL_OPENED",
  "LIBRARY_STATE",
  "OIL_WELL_HARVESTED",
  "CITY_WAREHOUSE_OPENED",
  "CITY_WAREHOUSE_UPDATED",
  "CITY_GOLD_DONATED",
  "CITY_MARKET_DAILY_PURCHASED",
  "CITY_FOUNDING_PREVIEW",
  "CITY_CONSTRUCTION_ADVANCED",
  "CITY_INFO",
  "CITY_FOUNDED",
  "CITY_TERRITORY_SYNC",
  "CITY_JOINED",
  "CITY_LEFT",
  "CITY_MEMBERSHIP_UPDATED",
  "CITY_MAYOR_UPDATED",
  "MILITARY_INDUSTRY_STATE",
  "MILITARY_INDUSTRY_CHANGED",
  "CITY_FLAG_CONVERSION_STARTED",
  "CITY_FLAG_CONVERTED"
]);

export function isSettlementServerMessage(
  message: { type: string }
): message is SettlementServerMessage {
  return SETTLEMENT_FRAME_TYPES.has(message.type);
}

export type ActiveCityFlagConversion = Readonly<{
  conversionId: string;
  requestId: string;
  flagId: string;
  flagName: string;
  cityId: string;
  cityName: string;
  position: { lat: number; lon: number };
  countdown: FlagBuildCountdown;
}>;

export type PendingCityFlagConversion = Readonly<{
  requestId: string;
  flagId: string;
}>;

export type CityWarehouseDonationIntent = Readonly<{
  warehouseStructureId: string;
  stackId: string;
  itemId: string;
  displayName: string;
  variant: string | null;
  quantity: number;
}>;

export type CityWarehousePendingRequest = Readonly<{
  requestId: string;
  structureId: string;
  action: "open" | "donate" | "donate_all" | "move" | "reorganize" | "gold";
  donation?: CityWarehouseDonationIntent;
}>;

export function upsertCityStructure(
  current: CityStructureSnapshot[],
  structure: CityStructureSnapshot
): CityStructureSnapshot[] {
  if (structure.state === "destroyed") {
    return current.filter((entry) => entry.structureId !== structure.structureId);
  }
  const index = current.findIndex((entry) => entry.structureId === structure.structureId);
  if (index < 0) return [...current, structure];
  const next = [...current];
  next[index] = structure;
  return next;
}

export function reconcileActiveCityConstruction(
  message: Readonly<{ requestId: string; structure: CityStructureSnapshot }>,
  pendingRef: {
    current: { requestId: string; action: CityPhysicalConstructionAction } | null;
  },
  setActive: Dispatch<SetStateAction<CityActiveConstructionSnapshot | null>>
): void {
  if (message.structure.state !== "constructing") {
    setActive((current) =>
      current?.structureId === message.structure.structureId ? null : current
    );
    return;
  }
  const pending = pendingRef.current;
  if (
    !pending
    || pending.requestId !== message.requestId
    || !message.structure.constructionStartedAt
    || !message.structure.constructionCompletesAt
  ) return;
  pendingRef.current = null;
  setActive({
    operationKey: `accepted:${message.requestId}`,
    requestId: message.requestId,
    action: pending.action,
    structureId: message.structure.structureId,
    anchor: { lat: message.structure.lat, lon: message.structure.lon },
    constructionStartedAt: message.structure.constructionStartedAt,
    constructionCompletesAt: message.structure.constructionCompletesAt
  });
}
