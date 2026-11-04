import type { PlayerAppearanceSnapshot } from "./appearance.js";

export const WORLD_MAP_MIN_ZOOM = 0;
export const WORLD_MAP_MAX_ZOOM = 5;
/** Hard zoom limit of the Atlas map itself (city level); recenter and gameplay mapping keep WORLD_MAP_MAX_ZOOM. */
export const WORLD_MAP_DETAIL_MAX_ZOOM = 12;
export const WORLD_MAP_DEFAULT_ZOOM = 4;
export const WORLD_MAP_SINGLE_DESTINATION_ZOOM = 3;
export const WORLD_MAP_FIT_MAX_ZOOM = 3.75;

export const WORLD_MAP_CAPITAL_NAME = "Albuquerque";
export const WORLD_MAP_CAPITAL_ANCHOR = { lat: 35.0853, lon: -106.6511 } as const;
export const WORLD_MAP_CAPITAL_MATCH_RADIUS_M = 25_000;
/**
 * Cities shown and travellable for everyone: the anchor city first, then the largest by
 * members. 1 = Albuquerque is the only hub; raise it to feature the largest cities too.
 */
export const WORLD_MAP_MAJOR_DESTINATION_LIMIT = 1;

export const WORLD_MAP_SOCIAL_AUDIENCES = [
  "friends",
  "kingdom_members",
  "city_members"
] as const;

export type WorldMapSocialAudience = typeof WORLD_MAP_SOCIAL_AUDIENCES[number];

export type WorldMapSocialVisibility = Readonly<
  Record<WorldMapSocialAudience, boolean>
>;

export type WorldMapSocialPlayer = Readonly<{
  playerId: string;
  username: string;
  displayColor?: string | null;
  lat: number;
  lon: number;
  publishedAt: string;
  appearance?: PlayerAppearanceSnapshot;
}>;

export type WorldMapCityFeaturedReason = "capital" | "top";

export type WorldMapCityDestination = Readonly<{
  kind: "city";
  id: string;
  name: string;
  lat: number;
  lon: number;
  visible?: boolean;
  /** Present when the city is shown to every player, discovered or not. */
  featured?: WorldMapCityFeaturedReason;
  memberCount?: number;
  /** True when the player is an active member of this city. */
  member?: boolean;
  /** True when this player has discovered the city. */
  discovered?: boolean;
}>;

export type WorldMapManorDestination = Readonly<{
  kind: "manor";
  id: string;
  name: string;
  lat: number;
  lon: number;
  visible?: boolean;
}>;

export type WorldMapKingdomDestination = Readonly<{
  kind: "kingdom";
  id: string;
  seatId: string;
  name: string;
  lat: number;
  lon: number;
  visible?: boolean;
}>;

export type WorldMapAtlasShrineDestination = Readonly<{
  kind: "atlas_shrine";
  id: string;
  name: string;
  lat: number;
  lon: number;
  visible?: boolean;
}>;

export type WorldMapHollinHutDestination = Readonly<{
  kind: "hollin_hut";
  id: string;
  name: string;
  lat: number;
  lon: number;
  visible?: boolean;
}>;

/** A building marked with an Pathfinder Boot; travellable until it expires. */
export type WorldMapPathfinderMarkDestination = Readonly<{
  kind: "pathfinder_mark";
  id: string;
  name: string;
  lat: number;
  lon: number;
  visible?: boolean;
  expiresAt: string;
}>;

/** An authored cave entrance shown to Deepstone Lore holders; view-only, never a travel target. */
export type WorldMapCaveLandmark = Readonly<{
  id: string;
  name: string;
  lat: number;
  lon: number;
}>;

/** A player-named Map Marker; private to its owner and never a travel target. */
export type WorldMapMarkerDestination = Readonly<{
  kind: "map_marker";
  id: string;
  name: string;
  lat: number;
  lon: number;
  visible?: boolean;
}>;

export type WorldMapDestination =
  | WorldMapCityDestination
  | WorldMapManorDestination
  | WorldMapKingdomDestination
  | WorldMapAtlasShrineDestination
  | WorldMapHollinHutDestination
  | WorldMapPathfinderMarkDestination;

export type WorldMapDestinationSnapshot = Readonly<{
  destinations: WorldMapDestination[];
  /** The viewer's own Map Markers (private to them); never travel destinations. */
  markers?: WorldMapMarkerDestination[];
  /** Caves outside the viewer's active circle (Deepstone Lore rank 1+); view-only. */
  caves?: WorldMapCaveLandmark[];
  serverTime: number;
  socialPlayers?: WorldMapSocialPlayer[];
  socialVisibility?: WorldMapSocialVisibility;
}>;
