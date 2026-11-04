import type { ClientMessage } from "./protocol/clientMessages.js";

/** Reusable named waypoints (Survey Stake Kit) and the Compass that unlocks the worldwide overview. */
export const MAP_MARKER_CAP = 50;
export const MAP_MARKER_NAME_MAX_LENGTH = 32;
/** A marked building must be within this distance of the player's authoritative position. */
export const MAP_MARKER_MAX_REACH_M = 2_000;
/** A Compass lasts 30 days of use; a day counts when the compass is used (waypoint set or overview opened). */
export const MAP_COMPASS_MAX_DAYS = 30;

/** Recipes built from resources already in the game: kit = Acorn / Flax Fiber / Cloth; compass = Crude Oil / Wood / Iron Slag. */
export const SURVEY_STAKE_KIT_RECIPE = Object.freeze({ elder_acorn: 1, flax_fiber: 5, cloth: 2 });
export const MAP_COMPASS_RECIPE = Object.freeze({ crude_oil: 34, wood: 13, slag: 7 });

/** Voyager (Wayfinder): recorded locations a player can travel back to, paid for in Glimmer Oil (refined_oil). */
export const VOYAGER_RECORDED_LOCATION_CAP = 5;
export const VOYAGER_RECORD_ITEM = "refined_oil";

/** Refined oil to record a location: 9 at Voyager rank 1-2, 6 at rank 3-4, 3 at rank 5. */
export function voyagerRecordCost(rank: number): number {
  return rank >= 5 ? 3 : rank >= 3 ? 6 : 9;
}

export type MapCraftItem = "survey_stake_kit" | "compass";

export type MapMarker = Readonly<{
  id: string;
  name: string;
  lat: number;
  lon: number;
  createdAt: number;
}>;

export type MapWaypoint = Readonly<{
  /** Set when the waypoint is one of the player's markers. */
  markerId: string | null;
  label: string;
  lat: number;
  lon: number;
}>;

export type MapCompassState = Readonly<{
  held: boolean;
  daysUsed: number;
  maxDays: number;
}>;

/** Present only while Voyager is the active specialization (rank >= 1). */
export type VoyagerTravelState = Readonly<{
  rank: number;
  recordCost: number;
  recordCap: number;
  locations: readonly MapMarker[];
}>;

export type MapMarkersState = Readonly<{
  markers: readonly MapMarker[];
  waypoint: MapWaypoint | null;
  compass: MapCompassState;
  kitCount: number;
  /** Cartography rank (0 when not learned); the Compass and Survey Stake Kit need rank 1 to craft. */
  cartographyRank: number;
  markerCap: number;
  voyager?: VoyagerTravelState;
}>;

/** Collapse whitespace, drop control/format characters and markup brackets, then clamp the length. */
export function sanitizeMapMarkerName(raw: string): string {
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[\p{C}\p{Zl}\p{Zp}<>\\]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(cleaned).slice(0, MAP_MARKER_NAME_MAX_LENGTH).join("").trim();
}

export function mapCompassDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** The wire command carried by one MAP_MARKER_COMMAND frame. */
export type MapMarkerCommand = Extract<ClientMessage, { type: "MAP_MARKER_COMMAND" }>["command"];
