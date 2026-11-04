import type { PopulationZoneV2Point } from "./populationZonesV2Geometry.js";
import type { CanonicalJsonValue } from "./populationZonesV2Identity.js";
import type {
  PopulationV2EncounterSurface,
  PopulationV2SurfaceAuthority
} from "./populationV2SurfaceTypes.js";

export type PopulationZoneV2SuppressionClass =
  | "none"
  | "deer-safe"
  | "hostile-pack"
  | "hostile-ogre";

export type PopulationZoneV2HabitatWeights = Readonly<{
  eligibleLand: number;
  tree: number;
  flax?: number;
  deer: number;
  wolf: number;
  stone: number;
  ogre: number;
}>;

export type PopulationZoneV2HabitatCandidateSite = Readonly<{
  siteId: string;
  position: PopulationZoneV2Point;
  source: "world-profile-candidate-slot" | "synthetic-sample-center";
  sourceSampleId: string;
  sourceCellId: string | null;
  sourceSlotId: string | null;
  candidateSlotVersion: string | null;
  placementTags: readonly string[];
  /** Additive land-side proximity facts retained alongside surface membership. */
  isRiverbank?: boolean;
  isLakeshore?: boolean;
  isSaltwater: boolean;
  insideMajorLake: boolean;
  surfaceType?: PopulationV2EncounterSurface | null;
  surfaceAuthority?: PopulationV2SurfaceAuthority | null;
  elevationBand: string | null;
  terrainClass: string | null;
  landCoverClass: string | null;
  biomeId: string | null;
  ecoregionId: string | null;
  spawnProfileKey: string;
  weights: PopulationZoneV2HabitatWeights;
}>;

export type PopulationZoneV2Habitat = Readonly<{
  regionCode: string;
  eligibleLandKm2: number;
  treeKm2: number;
  /** Optional for compatibility with retained pre-Flax test fixtures. */
  flaxKm2?: number;
  deerKm2: number;
  wolfKm2: number;
  stoneKm2: number;
  ogreKm2: number;
  surfaceAreaKm2?: Readonly<Record<PopulationV2EncounterSurface, number>>;
  habitatSummary: Readonly<Record<string, CanonicalJsonValue>>;
  environmentSnapshot: Readonly<Record<string, CanonicalJsonValue>>;
  candidateSites?: readonly PopulationZoneV2HabitatCandidateSite[];
}>;
