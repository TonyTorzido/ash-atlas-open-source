export const FLAG_ACCESS_MODES = ["public", "normal", "private"] as const;
export type FlagAccessMode = (typeof FLAG_ACCESS_MODES)[number];

export const FLAG_PASSAGE_REQUEST_STATUSES = [
  "pending",
  "approved",
  "denied",
  "cancelled",
  "expired",
  "invalidated"
] as const;
export type FlagPassageRequestStatus =
  (typeof FLAG_PASSAGE_REQUEST_STATUSES)[number];

export type FlagAccessReasonCode =
  | "ALLOWED_OWNER"
  | "ALLOWED_INVITE"
  | "ALLOWED_PUBLIC"
  | "ALLOWED_NORMAL"
  | "FLAG_NOT_FOUND"
  | "FLAG_NOT_TRAVEL_DESTINATION"
  | "FLAG_TYPE_UNSUPPORTED"
  | "PRIVATE_OWNER_ONLY"
  | "PUBLIC_ENEMY_BLOCKED"
  | "NORMAL_PASSAGE_REQUIRED"
  | "NORMAL_ENEMY_BLOCKED"
  | "NORMAL_REQUEST_PENDING"
  | "INSUFFICIENT_GOLD"
  | "TOLL_CHANGED"
  | "FLAG_CHANGED"
  | "OWNER_CHANGED"
  | "ACCESS_CHANGED"
  | "TRAVEL_FAILED";

export type FlagAccessDecision = Readonly<{
  allowed: boolean;
  requestable: boolean;
  reasonCode: FlagAccessReasonCode;
  tollGold: string;
}>;

export type FlagPassageRequestSnapshot = Readonly<{
  id: string;
  scope: "normal_owner";
  ownerPlayerId: string;
  requesterPlayerId: string;
  requesterName: string;
  sourceFlagId: string | null;
  sourceFlagName: string | null;
  status: FlagPassageRequestStatus;
  createdAt: string;
  expiresAt: string;
}>;

export type FlagAccessManagementSnapshot = Readonly<{
  pendingRequests: FlagPassageRequestSnapshot[];
}>;

export type FlagOwnerPreferencesSnapshot = Readonly<{
  defaultFlagAccessMode: FlagAccessMode;
  defaultPublicTollGold: string;
  defaultNormalTollGold: string;
}>;

export type OwnedFlagManagementSnapshot = Readonly<{
  flagId: string;
  flagName: string;
  anchorKind?: "flag" | "buoy";
  mode: FlagAccessMode;
  jumpTollGold: string;
  lat: number;
  lon: number;
  areaLabel: string;
  accessRevision: string;
  atlasShrineSlotNumber?: number;
}>;

export type NormalPassageGrantSnapshot = Readonly<{
  ownerPlayerId: string;
  granteePlayerId: string;
  granteeName: string;
  grantedAt: string;
}>;

export type FlagManagementDashboardSnapshot = Readonly<{
  preferences: FlagOwnerPreferencesSnapshot;
  flags: OwnedFlagManagementSnapshot[];
  ownedFlagCountsByMode?: Readonly<Record<FlagAccessMode, number>>;
  normalGrants: NormalPassageGrantSnapshot[];
  normalRequests: FlagPassageRequestSnapshot[];
  truncated: boolean;
}>;

export type AtlasShrineProgressionSnapshot = Readonly<{
  unlockedSlots: number;
  builtShrines: number;
  availableCapacity: number;
  nextSlot: number | null;
  requiredLevel: number | null;
  playerLevel: number;
  requiredShards: number | null;
  currentShards: number;
  levelRequirementMet: boolean;
  shardRequirementMet: boolean;
}>;

export type FlagAccessSnapshot = Readonly<{
  flagId: string;
  ownerPlayerId: string;
  mode: FlagAccessMode;
  jumpTollGold: string;
  accessRevision: string;
  requestPending: boolean;
  decision: FlagAccessDecision;
  management: FlagAccessManagementSnapshot | null;
}>;

export type FlagAccessPlayerSearchResult = Readonly<{
  playerId: string;
  playerName: string;
}>;
