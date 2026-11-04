import type { FlagAccessMode } from "./flagAccess.js";

export type LatLon = {
  lat: number;
  lon: number;
};

export const DEFAULT_INTERACTION_RADIUS_M = 50;

export type FlagUpgradeTier = "base" | "stone" | "atlas_shrine" | "tower";
/** Reinforcement channel targets: Stone, Tower, the next Guard Tower level, or a City Tower. */
export type FlagReinforcementTarget = "stone" | "tower" | "tower_level" | "city_tower" | "kingdom_tower" | "obelisk";
export const FLAG_UPGRADE_INTERACTION_RADIUS_M = DEFAULT_INTERACTION_RADIUS_M;
export type PersonalAnchorKind = "flag" | "buoy";

export type FlagSnapshot = {
  id: string;
  anchorKind?: PersonalAnchorKind;
  controlType: "personal" | "city" | "city_seat" | "kingdom" | "kingdom_seat";
  ownerId: string;
  ownerUsername?: string;
  ownerColor?: string;
  presentationColor?: string | null;
  systemControlled?: boolean;
  name: string;
  lat: number;
  lon: number;
  packageId: string | null;
  elevationM: number | null;
  terrainClass: string | null;
  biome: string | null;
  ecoregion: string | null;
  claimRadiusM: number;
  resourceVisionRadiusM?: number;
  accessMode?: FlagAccessMode;
  jumpTollGold?: string;
  accessRevision?: string;
  cityId: string | null;
  reinforcementLevel?: number;
  upgradeTier?: FlagUpgradeTier;
  /** Personal Guard Tower 1..25, City Tower 1, Kingdom Tower 1..5; null / absent when not a tower. */
  towerLevel?: number | null;
  /** Kingdom Obelisk 1..5 on a Kingdom Flag; null / absent when not an obelisk. */
  obeliskLevel?: number | null;
  /** War Tower / War Outpost on a Kingdom Flag (B2); null / absent otherwise. */
  warStructureKind?: "war_tower" | "war_outpost" | null;
  /** The war a War Tower / Outpost is tied to; null / absent otherwise. */
  warId?: string | null;
  /** Explicitly marked developer-only warfare target; ordinary flags never set this. */
  developerTestTarget?: boolean;
  health?: number;
  maximumHealth?: number;
  burning?: boolean;
  burningStartedAt?: string | null;
  burningUntil?: string | null;
  legendaryBirdSpecies?: "fire" | "lightning" | "ice" | null;
  atlasShrineSlotNumber?: number | null;
  kingdomId?: string | null;
  kingdomName?: string | null;
  kingdomEmblemKey?: string | null;
  kingdomColor?: string | null;
  kingdomSeatId?: string | null;
  kingdomSeatConstructionState?: "under_construction" | "complete" | null;
  kingdomSeatLat?: number | null;
  kingdomSeatLon?: number | null;
  kingdomAffiliatedAt?: string | null;
  originalOwnerPlayerId?: string | null;
  contributedByPlayerId?: string | null;
  contributedByUsername?: string | null;
  originalPersonalColor?: string | null;
  createdAt: string;
};

export type CitySnapshot = {
  id: string;
  worldId: string;
  worldSettlementId: string;
  worldSettlementSource: string;
  worldSourceSettlementId: string;
  settlementClass: string | null;
  settlementReleaseId: string | null;
  settlementReleaseFingerprint: string | null;
  name: string;
  controllerKind?: "player" | "npc";
  culture?: "human" | "goblin";
  bannerColor?: string;
  countryCode: string;
  regionCode: string | null;
  founderPlayerId: string;
  founderUsername?: string;
  founderColor?: string;
  mayorPlayerId: string | null;
  mayorConfirmed: boolean;
  founderMayorClaimDeadline: string | null;
  mayorUsername?: string;
  mayorColor?: string;
  seatFlagId: string;
  lat: number;
  lon: number;
  active: boolean;
  jumpable: boolean;
  constructionPhase: CityConstructionPhase;
  constructionCompletedAt: string | null;
  constructionContributions: CityConstructionContribution[];
  spatialRevision: string;
  foundingAnnexRadiusM: number;
  createdAt: string;
};

export type CityConstructionPhase = "blueprint" | "foundation" | "framing" | "complete";
export type CityConstructionAction = "build_foundation" | "build_frames" | "finish";
export type CityConstructionContributionStage =
  | "blueprint"
  | "foundation"
  | "framing"
  | "finishing";

export type CityConstructionContribution = {
  playerId: string;
  stage: CityConstructionContributionStage;
  contributedAt: string;
};

export type CityMembershipSnapshot = {
  cityId: string;
  cityName: string;
  role: "mayor" | "member";
  joinedAt: string;
  houseStructureId: string;
  expansionFlagCount: number;
  expansionFlagLimit: number;
};

export type CityInfoSnapshot = {
  city: CitySnapshot;
  memberCount: number;
  expansionFlagCount: number;
  expansionFlagLimit: number;
  membership: CityMembershipSnapshot | null;
  joinAllowed: boolean;
  joinReason: string | null;
  mayorClaimAllowed: boolean;
  mayorClaimReason: string | null;
};

export type CityFoundingFlagSnapshot = {
  id: string;
  name: string;
  ownerColor: string;
  lat: number;
  lon: number;
  claimRadiusM: number;
};

export type NearestMunicipalitySnapshot = {
  municipalityId: string;
  name: string;
  countryCode: string;
  regionCode: string | null;
  jurisdictionName: string | null;
  distanceM: number;
  direction: string;
};

export type SettlementClass = string;

export type CityFoundingPreview = {
  flag: CityFoundingFlagSnapshot;
  hallPosition: LatLon;
  municipality: {
    municipalityId: string;
    name: string;
    countryCode: string;
    regionCode: string | null;
    jurisdictionName: string | null;
    municipalityType: SettlementClass;
  } | null;
  nearestMunicipality: NearestMunicipalitySnapshot | null;
  eligible: boolean;
  reasonCode: string | null;
  reason: string | null;
  materialCost: 0;
};

export type NormalizedWorldLookup = {
  ok: boolean;
  packageId: string | null;
  elevationM: number | null;
  terrainClass: string | null;
  biome: string | null;
  ecoregion: string | null;
  raw: unknown;
  warning?: string;
};
