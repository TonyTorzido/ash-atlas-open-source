import type { ResourceVision } from "@ash-atlas/shared";

import type { AuthoritativeTravelAnchor } from "../game/state.js";

type Position = { lat: number; lon: number };

export type ResolvedTravelDestination = Readonly<{
  kind: "flag" | "city" | "world" | "manor";
  id: string | null;
  center: Position;
  travelAnchor?: AuthoritativeTravelAnchor;
  resourceVision?: ResourceVision;
  flagName?: string;
  flagCenter?: Position;
  claimRadiusM?: number;
  resourceVisionRadiusM?: number | undefined;
  personalFlagId?: string;
  jumpTollGold?: string;
}>;

export type TravelArrivalMode = "protected_jump" | "ordinary_relocation";

export type TravelArrivalPlan = Readonly<{
  positions: ReadonlyMap<string, { lat: number; lon: number }>;
  release(): void;
}>;
