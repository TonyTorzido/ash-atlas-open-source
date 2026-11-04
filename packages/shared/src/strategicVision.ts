import type { CitySnapshot, FlagSnapshot, LatLon } from "./types.js";

export const STRATEGIC_VISION_RADIUS_M = 3_000;

export type StrategicVisionAuthority = Readonly<{
  center: LatLon;
  radiusM: number;
  relocationRevision: number;
  gameplayViewGeneration: number;
}>;

export type StrategicVisionLandmark = Readonly<{
  kind: "city" | "kingdom" | "manor";
  id: string;
  name: string;
  lat: number;
  lon: number;
}>;

export type StrategicVisionSnapshot = Readonly<{
  authority: StrategicVisionAuthority;
  flags: FlagSnapshot[];
  cities: CitySnapshot[];
  landmarks: StrategicVisionLandmark[];
  flagSetRevision: number;
  complete: boolean;
}>;
