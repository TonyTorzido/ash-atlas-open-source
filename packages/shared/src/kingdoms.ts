import { z } from "zod";

import { RESOURCE_TYPES } from "./collectibles.js";
import { GLIMMER_OIL_ITEM_ID } from "./kingdomBricks.js";
import type { KingdomBrickFurnaceSnapshot } from "./kingdomBricks.js";
import type {
  KingdomPerkDefinition,
  KingdomPerkId,
  KingdomPerkSelectionSnapshot
} from "./kingdomPerks.js";
import type { KingdomCommandBoardSnapshot } from "./kingdomWar.js";
import type { KingdomRevoltState } from "./kingdomRevolt.js";
import type { KingdomStructureCapacitySnapshot } from "./warEnding.js";

export const KINGDOM_ROLES = ["leader", "officer", "member"] as const;
export type KingdomRole = (typeof KINGDOM_ROLES)[number];

export const KINGDOM_PERMISSIONS = [
  "invite_members",
  "cancel_invitations",
  "remove_members",
  "ban_members",
  "manage_roles",
  "mute_chat",
  "manage_identity",
  "manage_cots",
  "place_decorations",
  "move_decorations",
  "remove_decorations",
  "manage_kingdom_decorations",
  "view_treasury_ledger",
  "manage_perks",
  "contribute_kingdom_flags",
  "manage_kingdom_flags",
  "release_kingdom_flags",
  "destroy_kingdom_flags",
  /** Build and upgrade Obelisks, Kingdom Towers and the Brick Furnace (leader only). */
  "build_kingdom_structures",
  "transfer_leadership",
  "dissolve_kingdom"
] as const;
export type KingdomPermission = (typeof KINGDOM_PERMISSIONS)[number];

export const KINGDOM_ROLE_PERMISSIONS: Readonly<Record<KingdomRole, readonly KingdomPermission[]>> = {
  leader: KINGDOM_PERMISSIONS,
  officer: [
    "invite_members",
    "cancel_invitations",
    "remove_members",
    "ban_members",
    "manage_roles",
    "mute_chat",
    "manage_identity",
    "manage_cots",
    "place_decorations",
    "move_decorations",
    "remove_decorations",
    "manage_kingdom_decorations",
    "view_treasury_ledger",
    "contribute_kingdom_flags",
    "manage_kingdom_flags",
    "release_kingdom_flags"
  ],
  member: ["place_decorations", "contribute_kingdom_flags"]
};

export type KingdomLevelDefinition = {
  level: number;
  requiredLifetimeXp: number;
  memberCapacity: number;
  cotCapacity: number;
  decorationCapacity: number;
  futureBuildingUnlocks: string[];
};

/**
 * 2: level 6 added with the perk tree; perks are chosen, no longer unlocked by level.
 * 3: levels 7-9; cumulative XP thresholds fed by member XP (L2 46k ... L6 655k; L7-L9 905k / 1.21M / 1.555M).
 */
export const KINGDOM_LEVEL_DEFINITION_VERSION = 3;
/** Each XP point a member earns adds one kingdom XP, up to this much per kingdom per UTC day. */
export const KINGDOM_MEMBER_XP_DAILY_CAP = 23_000;
export const KINGDOM_LEVELS: readonly KingdomLevelDefinition[] = [
  {
    level: 1,
    requiredLifetimeXp: 0,
    memberCapacity: 10,
    cotCapacity: 10,
    decorationCapacity: 25,
    futureBuildingUnlocks: ["founding_seat", "basic_cots", "basic_decorations"]
  },
  {
    level: 2,
    requiredLifetimeXp: 46_000,
    memberCapacity: 15,
    cotCapacity: 15,
    decorationCapacity: 35,
    futureBuildingUnlocks: ["social_hall_tier_1"]
  },
  {
    level: 3,
    requiredLifetimeXp: 147_000,
    memberCapacity: 20,
    cotCapacity: 20,
    decorationCapacity: 50,
    futureBuildingUnlocks: ["social_decorations_tier_2"]
  },
  {
    level: 4,
    requiredLifetimeXp: 281_000,
    memberCapacity: 30,
    cotCapacity: 30,
    decorationCapacity: 70,
    futureBuildingUnlocks: ["social_hall_tier_2"]
  },
  {
    level: 5,
    requiredLifetimeXp: 436_000,
    memberCapacity: 40,
    cotCapacity: 40,
    decorationCapacity: 100,
    futureBuildingUnlocks: ["future_construction_tier_3"]
  },
  {
    // Capacities scaled like the 4 -> 5 step.
    level: 6,
    requiredLifetimeXp: 655_000,
    memberCapacity: 50,
    cotCapacity: 50,
    decorationCapacity: 130,
    futureBuildingUnlocks: []
  },
  // Levels 7-9: capacities keep growing by the 5 -> 6 step.
  {
    level: 7,
    requiredLifetimeXp: 905_000,
    memberCapacity: 60,
    cotCapacity: 60,
    decorationCapacity: 160,
    futureBuildingUnlocks: []
  },
  {
    level: 8,
    requiredLifetimeXp: 1_210_000,
    memberCapacity: 70,
    cotCapacity: 70,
    decorationCapacity: 190,
    futureBuildingUnlocks: []
  },
  {
    level: 9,
    requiredLifetimeXp: 1_555_000,
    memberCapacity: 80,
    cotCapacity: 80,
    decorationCapacity: 220,
    futureBuildingUnlocks: []
  }
] as const;

export const KINGDOM_MAX_LEVEL = 9;

export const KINGDOM_ADVANCEMENT_PROJECT_RULES_VERSION = 1;
export type KingdomAdvancementTargetLevel = 2 | 3 | 4 | 5 | 6;
export type KingdomAdvancementProjectDefinition = {
  projectType: "advancement";
  targetLevel: KingdomAdvancementTargetLevel;
  displayName: string;
  baseConstructionSeconds: number;
  cost: KingdomCostLine[];
};

export const KINGDOM_ADVANCEMENT_PROJECTS: Readonly<
  Record<KingdomAdvancementTargetLevel, KingdomAdvancementProjectDefinition>
> = {
  2: {
    projectType: "advancement",
    targetLevel: 2,
    displayName: "Raise the Standard",
    baseConstructionSeconds: 10 * 60,
    cost: [
      { resourceType: "wood", quantity: 150 },
      { resourceType: "stone", quantity: 100 },
      { resourceType: "leather", quantity: 50 }
    ]
  },
  3: {
    projectType: "advancement",
    targetLevel: 3,
    displayName: "Fortify the Seat",
    baseConstructionSeconds: 20 * 60,
    cost: [
      { resourceType: "wood", quantity: 300 },
      { resourceType: "stone", quantity: 250 },
      { resourceType: "leather", quantity: 100 },
      { resourceType: "balsam_resin", quantity: 50 }
    ]
  },
  4: {
    projectType: "advancement",
    targetLevel: 4,
    displayName: "Build the Great Hall",
    baseConstructionSeconds: 30 * 60,
    cost: [
      { resourceType: "wood", quantity: 600 },
      { resourceType: "stone", quantity: 500 },
      { resourceType: "leather", quantity: 200 },
      { resourceType: "balsam_resin", quantity: 100 }
    ]
  },
  5: {
    projectType: "advancement",
    targetLevel: 5,
    displayName: "Crown the Realm",
    baseConstructionSeconds: 60 * 60,
    cost: [
      { resourceType: "wood", quantity: 1_000 },
      { resourceType: "stone", quantity: 800 },
      { resourceType: "leather", quantity: 350 },
      { resourceType: "balsam_resin", quantity: 200 }
    ]
  },
  6: {
    // The 4 -> 5 step's ratios applied again (rounded to 50): time x2,
    // wood x5/3, stone x1.6, leather x1.75, frond sap x2.
    projectType: "advancement",
    targetLevel: 6,
    displayName: "Raise the Banner of Ages",
    baseConstructionSeconds: 120 * 60,
    cost: [
      { resourceType: "wood", quantity: 1_650 },
      { resourceType: "stone", quantity: 1_300 },
      { resourceType: "leather", quantity: 600 },
      { resourceType: "balsam_resin", quantity: 400 }
    ]
  }
};

export type KingdomEnvironmentSnapshot = {
  terrainClass: string | null;
  biome: string | null;
  ecoregion: string | null;
  elevationM: number | null;
  elevationBand: string | null;
  slope: number | null;
  slopeBand: string | null;
  isLand: boolean;
  isSaltwater: boolean;
  insideMajorLake: boolean;
  worldReleaseId: string | null;
  worldReleaseVersion: string | null;
  worldPackageId: string | null;
  environmentSchemaVersion: string | null;
  environmentRulesVersion: number;
  sourceVersions: Record<string, string>;
  lookedUpAt: string;
};

export type KingdomEnvironmentModifier = {
  key: string;
  label: string;
  value: number;
  unit: "multiplier" | "flat" | "percent";
  applied: boolean;
  futureSystem: string | null;
};

export type KingdomSeatSnapshot = {
  id: string;
  kingdomId: string;
  lat: number;
  lon: number;
  territoryRadiusM: number;
  environment: KingdomEnvironmentSnapshot;
  environmentModifiers: KingdomEnvironmentModifier[];
  environmentRulesVersion: number;
  constructionState: "under_construction" | "complete";
  constructionCompletesAt: string | null;
  completedUnderFreeConstruction: boolean;
  status: "active" | "archived" | "relocating";
  createdAt: string;
  completedAt: string | null;
  sourceFlagId?: string | null;
};

export type KingdomFoundingSourceFlag = {
  id: string;
  name: string;
  ownerColor: string;
  ownerPlayerId?: string;
  ownerDisplayName?: string | null;
  controlType?: "personal" | "city" | "city_seat" | "kingdom" | "kingdom_seat";
  ownedByPlayer?: boolean;
  personallyControlled?: boolean;
  lat: number;
  lon: number;
  claimRadiusM: number;
};

export type KingdomPublicSnapshot = {
  id: string;
  displayName: string;
  displayColor: string;
  description: string | null;
  emblemKey: string | null;
  founderPlayerId: string;
  leaderPlayerId: string;
  level: number;
  memberCount: number;
  kingdomFlagCount?: number;
  spatialRevision: string;
  status: "active" | "dissolved" | "archived";
  seat: KingdomSeatSnapshot | null;
  /** When the Castle fell to rubble; null (or absent from older servers) while it stands. */
  castleRuinedAt?: string | null;
  createdAt: string;
};

export type KingdomFlagConnectionAnchor =
  | { kind: "seat"; id: string; name: string }
  | { kind: "kingdom_flag"; id: string; name: string; ownerPlayerId: string };

export type KingdomFlagSnapshot = {
  flagId: string;
  kingdomId: string;
  flagName: string;
  ownerPlayerId: string;
  ownerDisplayName: string;
  contributedByPlayerId: string;
  contributedByDisplayName: string;
  kingdomColor: string;
  lat: number;
  lon: number;
  claimRadiusM: number;
  constructionState: "complete";
  connected: true;
  directlyTouchesSeat: boolean;
  connectionAnchor: KingdomFlagConnectionAnchor;
  affiliatedAt: string;
};

export type KingdomFlagEligibility = {
  flagId: string;
  kingdomId: string | null;
  eligible: boolean;
  reasonCode: string | null;
  reason: string | null;
  networkRevision: string | null;
  connectionAnchor: KingdomFlagConnectionAnchor | null;
};

export type KingdomFlagRemovalPreview = {
  flagId: string;
  kingdomId: string | null;
  allowed: boolean;
  reasonCode: string | null;
  reason: string | null;
  networkRevision: string | null;
  downstreamCount: number;
};

export type KingdomChatMuteState =
  | { state: "not_muted" }
  | { state: "muted_until"; mutedUntil: string }
  | { state: "muted_indefinitely" };

export type KingdomMemberSnapshot = {
  membershipId: string;
  playerId: string;
  displayName: string;
  role: KingdomRole;
  status: "active" | "left" | "removed" | "banned";
  joinedAt: string;
  endedAt: string | null;
  perkQualifiedAt: string;
  chatMutedUntil: string | null;
  chatMute: KingdomChatMuteState;
};

export type KingdomInvitationSnapshot = {
  id: string;
  kingdomId: string;
  kingdomName: string;
  targetPlayerId: string;
  targetDisplayName: string;
  invitedByPlayerId: string;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
  respondedAt?: string | null;
};

export type KingdomChatMessage = {
  id: string;
  kingdomId: string;
  senderPlayerId: string;
  senderDisplayName: string;
  content: string;
  createdAt: string;
};

export type KingdomTreasuryBalance = {
  resourceType: (typeof RESOURCE_TYPES)[number];
  variant: string | null;
  quantity: number;
};

export type KingdomDonationEntry = {
  id: string;
  kingdomId: string;
  donorPlayerId: string;
  donorDisplayName: string;
  resourceType: (typeof RESOURCE_TYPES)[number];
  variant: string | null;
  quantity: number;
  playerBalanceBefore: number;
  playerBalanceAfter: number;
  treasuryBalanceBefore: number;
  treasuryBalanceAfter: number;
  kingdomXpGranted: number;
  createdAt: string;
};

export type KingdomProjectResourceRequirement = KingdomCostLine & {
  variant: string;
  availableQuantity: number;
  missingQuantity: number;
};

export type KingdomAdvancementProjectSnapshot = {
  id: string;
  projectType: "advancement";
  rulesVersion: number;
  targetLevel: KingdomAdvancementTargetLevel;
  displayName: string;
  status: "pending" | "completed" | "cancelled" | "failed";
  actorPlayerId: string;
  actorDisplayName: string;
  cost: KingdomProjectResourceRequirement[];
  xpDelta: number;
  startedAt: string;
  completesAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
};

export type KingdomTreasuryExpenditureEntry = {
  id: string;
  kingdomId: string;
  projectId: string;
  projectName: string;
  actorPlayerId: string;
  actorDisplayName: string;
  resourceType: (typeof RESOURCE_TYPES)[number];
  variant: string;
  direction: "debit" | "refund";
  quantity: number;
  balanceBefore: number;
  balanceAfter: number;
  createdAt: string;
};

export type KingdomActivityEntry = {
  id: string;
  eventType: string;
  summary: string;
  actorDisplayName: string | null;
  targetDisplayName: string | null;
  createdAt: string;
};

export type KingdomPerkState = KingdomPerkDefinition & {
  /** The kingdom has reached the perk's level. */
  unlocked: boolean;
  /** The viewing member passed the membership qualification period. */
  qualified: boolean;
  /** Chosen for its level. */
  selected: boolean;
  /** Chosen, qualified and (for an activated perk) its 24 h buff is running. */
  active: boolean;
};

export type KingdomProgressionSnapshot = {
  level: number;
  currentXp: number;
  lifetimeXp: number;
  levelDefinitionVersion: number;
  nextLevelXp: number | null;
  /** Member XP credited to the kingdom this UTC day, out of dailyXpCap. */
  dailyXp: number;
  dailyXpCap: number;
  capacities: Pick<KingdomLevelDefinition, "memberCapacity" | "cotCapacity" | "decorationCapacity"> & {
    seatAnchorRadiusM: number;
  };
  perks: KingdomPerkState[];
  /** One chosen perk per level, levels 2-8. */
  perkSelections: KingdomPerkSelectionSnapshot[];
  futureBuildingUnlocks: string[];
};

export type KingdomCotSnapshot = {
  id: string;
  kingdomId: string;
  ownerPlayerId: string;
  ownerDisplayName: string;
  lat: number;
  lon: number;
  rotation: number;
  status: "active" | "packed" | "archived";
  completedUnderFreeConstruction: boolean;
  constructionState: "under_construction" | "complete";
  constructionCompletesAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type KingdomDecorationTypeId = string;

export type KingdomCostLine = {
  resourceType: (typeof RESOURCE_TYPES)[number];
  quantity: number;
};

/** Founding a kingdom needs a level 5 character. */
export const KINGDOM_FOUNDING_MIN_PLAYER_LEVEL = 5;

export const KINGDOM_FOUNDING_BASE_REQUIREMENTS = {
  cost: [
    { resourceType: GLIMMER_OIL_ITEM_ID, quantity: 1_150 },
    { resourceType: "wood", quantity: 450 },
    { resourceType: "stone", quantity: 550 },
    { resourceType: "iron", quantity: 425 }
  ]
} as const satisfies {
  cost: readonly KingdomCostLine[];
};

export const KINGDOM_FOUNDING_CHANNEL_DURATION_MS = 15_000;

/*
 * Castle rubble: a Castle at 0 HP lies in rubble instead of
 * ending the kingdom. Perks give nothing and members cannot build until the
 * leader rebuilds it for the founding cost; the leader may instead disband
 * the kingdom once 7 days have passed since the ruin.
 */
export const KINGDOM_CASTLE_RUBBLE_DISBAND_DELAY_MS = 7 * 24 * 60 * 60 * 1_000;

export type KingdomCastleRubbleSnapshot = {
  ruinedAt: string;
  /** From this moment the leader may disband the ruined kingdom. */
  disbandAvailableAt: string;
  /** What rebuilding the Castle costs (each line from the treasury when it holds enough, else the leader's pack). */
  rebuildCost: KingdomCostLine[];
};

export type KingdomFoundingAffordabilityLine = {
  resourceType: (typeof RESOURCE_TYPES)[number];
  requiredQuantity: number;
  availableQuantity: number;
  missingQuantity: number;
};

export type KingdomFoundingQuoteResult = {
  requestId: string | null;
  position: { lat: number; lon: number };
  seatPosition: { lat: number; lon: number };
  territoryRadiusM: number | null;
  sourceFlag: KingdomFoundingSourceFlag | null;
  absorbedFlagCount: number;
  eligible: boolean;
  affordable: boolean | null;
  disabledReason: string | null;
  blockerCode: string | null;
  guidance: string | null;
  environment: KingdomEnvironmentSnapshot | null;
  quote: KingdomConstructionQuote | null;
  affordability: KingdomFoundingAffordabilityLine[];
  informational: boolean;
  reservationNotice: string;
};

export type KingdomDecorationDefinition = {
  typeId: KingdomDecorationTypeId;
  displayName: string;
  footprintRadiusM: number;
  ownershipType: "personal" | "kingdom" | "choice";
  requiredKingdomLevel: number;
  capacityCost: number;
  futureMaterialCost: KingdomCostLine[];
  intendedConstructionSeconds: number;
  membersMayPlace: boolean;
  officersOnly: boolean;
  constructionQuote?: KingdomConstructionQuote;
};

export type KingdomDecorationSnapshot = {
  id: string;
  kingdomId: string;
  typeId: KingdomDecorationTypeId;
  displayName: string;
  placedByPlayerId: string;
  personalOwnerPlayerId: string | null;
  kingdomOwned: boolean;
  lat: number;
  lon: number;
  rotation: number;
  status: "active" | "packed" | "archived" | "removed";
  capacityCost: number;
  completedUnderFreeConstruction: boolean;
  constructionState: "under_construction" | "complete";
  constructionCompletesAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type NearbyKingdomObjectSnapshot = {
  id: string;
  kingdomId: string;
  kind: "cot" | "decoration";
  typeId: KingdomDecorationTypeId | "cot";
  displayName: string;
  lat: number;
  lon: number;
  rotation: number;
  spatialRevision: string;
};

export type KingdomSpatialEntity =
  | {
      entityType: "seat";
      id: string;
      kingdomId: string;
      kingdom: KingdomPublicSnapshot;
    }
  | {
      entityType: "object";
      id: string;
      kingdomId: string;
      objectKind: NearbyKingdomObjectSnapshot["kind"];
      object: NearbyKingdomObjectSnapshot;
    };

export type KingdomSpatialEntityReference =
  | { entityType: "seat"; id: string; kingdomId: string; spatialRevision: string }
  | {
      entityType: "object";
      id: string;
      kingdomId: string;
      objectKind: NearbyKingdomObjectSnapshot["kind"];
      spatialRevision: string;
    };

export type KingdomSpatialWireChange =
  | { action: "upsert"; entity: KingdomSpatialEntity }
  | { action: "remove"; entity: KingdomSpatialEntityReference };

export type KingdomConstructionQuote = {
  action: "found" | "cot" | "decoration";
  freeConstruction: boolean;
  intendedCost: KingdomCostLine[];
  intendedConstructionSeconds: number;
  adjustedCost: KingdomCostLine[];
  adjustedConstructionSeconds: number;
  modifiers: KingdomEnvironmentModifier[];
};

export type KingdomStateSnapshot = {
  spatialRevision: string;
  membership: KingdomMemberSnapshot | null;
  kingdom: KingdomPublicSnapshot | null;
  permissions: KingdomPermission[];
  roster: KingdomMemberSnapshot[];
  invitations: KingdomInvitationSnapshot[];
  chatHistory: KingdomChatMessage[];
  treasury: KingdomTreasuryBalance[];
  donationHistory: KingdomDonationEntry[] | null;
  treasuryExpenditureHistory: KingdomTreasuryExpenditureEntry[] | null;
  progression: KingdomProgressionSnapshot | null;
  advancementProject: KingdomAdvancementProjectSnapshot | null;
  activityHistory: KingdomActivityEntry[];
  cots: KingdomCotSnapshot[];
  decorations: KingdomDecorationSnapshot[];
  kingdomFlags?: KingdomFlagSnapshot[];
  decorationCatalog: KingdomDecorationDefinition[];
  cotConstructionQuote?: KingdomConstructionQuote | null;
  nearbyKingdoms: KingdomPublicSnapshot[];
  nearbyObjects?: NearbyKingdomObjectSnapshot[];
  freeConstruction: boolean;
  perkQualificationSeconds: number;
  /** The kingdom's Brick Furnace; null without a kingdom. */
  brickFurnace?: KingdomBrickFurnaceSnapshot | null;
  /** Kingdom Flags against the 36-per-active-member cap; null without a kingdom. */
  structureCapacity?: KingdomStructureCapacitySnapshot | null;
  /** The kingdom's Command Board, its caps and standing War Towers / Outposts; null without a kingdom. */
  commandBoard?: KingdomCommandBoardSnapshot | null;
  /** Open revolt vote, anarchy countdown and leader war-death boost; null without a kingdom. */
  revolt?: KingdomRevoltState | null;
  /** Present while the kingdom's Castle lies in rubble; null otherwise. */
  castleRubble?: KingdomCastleRubbleSnapshot | null;
};

export type KingdomStatModifiers = {
  kingdomId: string | null;
  attackBonus: number;
  defenseBonus: number;
  perkIds: KingdomPerkId[];
  qualified: boolean;
};

export const foundKingdomInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  sourceFlagId: z.string().uuid().optional(),
  displayName: z.string().min(1).refine((value) => unicodeLength(value.trim()) <= 40),
  description: z.string().max(500).nullable().optional(),
  emblemKey: z.string().trim().min(1).max(80).nullable().optional(),
  displayColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
}).strict();

export const kingdomInviteInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  targetPlayerId: z.string().uuid()
}).strict();

export const kingdomInvitationResponseSchema = z.object({
  requestId: z.string().min(1).max(128),
  invitationId: z.string().uuid(),
  response: z.enum(["accept", "decline"])
}).strict();

export const kingdomMemberActionSchema = z.object({
  requestId: z.string().min(1).max(128),
  targetPlayerId: z.string().uuid(),
  action: z.enum(["remove", "ban", "unban", "promote", "demote", "transfer_leadership"])
}).strict();

export const kingdomSimpleActionSchema = z.object({
  requestId: z.string().min(1).max(128)
}).strict();

export const kingdomCancelInvitationSchema = z.object({
  requestId: z.string().min(1).max(128),
  invitationId: z.string().uuid()
}).strict();

export const kingdomIdentityInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  description: z.string().max(500).nullable().optional(),
  emblemKey: z.string().trim().min(1).max(80).nullable().optional(),
  displayColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
}).strict();

export const kingdomMuteInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  targetPlayerId: z.string().uuid(),
  action: z.enum(["mute", "unmute"]),
  mutedUntil: z.string().datetime().nullable().optional()
}).strict().superRefine((value, context) => {
  if (value.action === "unmute" && value.mutedUntil !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Unmute does not accept an expiry" });
  }
});

export const kingdomDonationInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  resourceType: z.enum(RESOURCE_TYPES),
  variant: z.string().trim().min(1).max(80).nullable().optional(),
  quantity: z.number().int().positive().max(1_000_000)
}).strict();

export const kingdomAdvancementProjectStartSchema = z.object({
  requestId: z.string().min(1).max(128),
  targetLevel: z.number().int().min(2).max(9)
}).strict();

export const kingdomAdvancementProjectCancelSchema = z.object({
  requestId: z.string().min(1).max(128),
  projectId: z.string().uuid()
}).strict();

export const kingdomPlacementInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  rotation: z.number().finite().min(-360).max(360).default(0)
}).strict();

export const kingdomCotMutationInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  cotId: z.string().uuid(),
  action: z.enum(["move", "pack"]),
  rotation: z.number().finite().min(-360).max(360).optional()
}).strict();

export const kingdomDecorationPlacementInputSchema = kingdomPlacementInputSchema.extend({
  typeId: z.string().trim().min(1).max(80),
  kingdomOwned: z.boolean().default(false)
}).strict();

export const kingdomDecorationMutationInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  decorationId: z.string().uuid(),
  action: z.enum(["move", "remove"]),
  rotation: z.number().finite().min(-360).max(360).optional()
}).strict();

export const kingdomChatInputSchema = z.object({
  type: z.literal("KINGDOM_CHAT_SEND"),
  requestId: z.string().min(1).max(128),
  content: z.string().refine((value) => unicodeLength(value) <= 500)
}).strict();

export const kingdomFlagConversionInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  flagId: z.string().uuid()
}).strict();

export const kingdomFlagRemovalInputSchema = z.object({
  requestId: z.string().min(1).max(128),
  flagId: z.string().uuid(),
  expectedNetworkRevision: z.string().regex(/^\d+$/)
}).strict();

export function unicodeLength(value: string): number {
  return Array.from(value).length;
}

export function kingdomLevelForXp(lifetimeXp: number): KingdomLevelDefinition {
  return [...KINGDOM_LEVELS].reverse().find((definition) => lifetimeXp >= definition.requiredLifetimeXp)
    ?? KINGDOM_LEVELS[0]!;
}

export function permissionsForKingdomRole(role: KingdomRole): KingdomPermission[] {
  return [...KINGDOM_ROLE_PERMISSIONS[role]];
}

export function canModerateKingdomRole(
  actorRole: KingdomRole,
  targetRole: KingdomRole,
  samePlayer: boolean
): boolean {
  if (samePlayer) return false;
  if (actorRole === "leader") return targetRole !== "leader";
  return actorRole === "officer" && targetRole === "member";
}

export function hasKingdomPermission(role: KingdomRole, permission: KingdomPermission): boolean {
  return KINGDOM_ROLE_PERMISSIONS[role].includes(permission);
}
