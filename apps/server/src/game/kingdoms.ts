import { createHash, randomUUID } from "node:crypto";
import { enqueueNativePush, type NativePushAudience } from "../notifications/nativePushOutbox.js";

import {
  KINGDOM_ADVANCEMENT_PROJECTS,
  KINGDOM_FOUNDING_BASE_REQUIREMENTS,
  KINGDOM_FOUNDING_MIN_PLAYER_LEVEL,
  KINGDOM_LEVEL_DEFINITION_VERSION,
  KINGDOM_MEMBER_XP_DAILY_CAP,
  KINGDOM_LEVELS,
  KINGDOM_PERKS,
  KINGDOM_PERK_LABOR_CORPS_TIME_MULTIPLIER,
  KINGDOM_PERK_IDS,
  canModerateKingdomRole,
  hasKingdomPermission,
  kingdomLevelForXp,
  permissionsForKingdomRole,
  professionEffects,
  type KingdomChatMessage,
  type KingdomActivityEntry,
  type KingdomAdvancementProjectSnapshot,
  type KingdomAdvancementTargetLevel,
  type KingdomConstructionQuote,
  type KingdomCostLine,
  type KingdomDecorationDefinition,
  type KingdomDecorationSnapshot,
  type KingdomDecorationTypeId,
  type KingdomDonationEntry,
  type KingdomEnvironmentModifier,
  type KingdomEnvironmentSnapshot,
  type KingdomInvitationSnapshot,
  type KingdomFlagConnectionAnchor,
  type KingdomFlagEligibility,
  type KingdomFlagRemovalPreview,
  type KingdomFlagSnapshot,
  type KingdomFoundingAffordabilityLine,
  type KingdomFoundingQuoteResult,
  type KingdomFoundingSourceFlag,
  type KingdomMemberSnapshot,
  type KingdomPermission,
  type KingdomProgressionSnapshot,
  type KingdomPublicSnapshot,
  type KingdomRole,
  type KingdomSeatSnapshot,
  type KingdomSpatialEntity,
  type KingdomStateSnapshot,
  type KingdomStatModifiers,
  type KingdomTreasuryBalance,
  type KingdomTreasuryExpenditureEntry,
  type KingdomCotSnapshot,
  type KingdomBrickDepositInput,
  type KingdomBrickFurnacePackageInput,
  type KingdomRevoltVoteInput,
  type KingdomBrickFurnaceUpgradeInput,
  type KingdomPerkActivateInput,
  type KingdomPerkChooseInput,
  type KingdomPerkId,
  type KingdomPerkSelectionSnapshot,
  type KingdomCommandBoardUpgradeInput,
  type KingdomStructureDowngradeInput,
  BRICKS_ITEM_ID,
  type NearbyKingdomObjectSnapshot,
  type ResourceType,
  TERRITORY_EDGE_TOLERANCE_M,
  isShopCopyItemId
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldLookupResult } from "../world/worldTypes.js";
import {
  DEFAULT_INVENTORY_VARIANT,
  InventoryService,
  type InventoryOperationResult
} from "./inventory.js";
import { requireItemDefinition } from "./items.js";
import {
  KingdomBrickEconomyError,
  buyBrickFurnacePackageInTransaction,
  depositBricksInTransaction,
  loadBrickFurnace,
  upgradeBrickFurnaceInTransaction,
  downgradeBrickFurnaceInTransaction
} from "./kingdomBrickEconomy.js";
import { loadKingdomDailyMemberXp } from "./kingdomMemberXp.js";
import {
  chargeKingdomWarMaterialsInTransaction,
  downgradeKingdomCommandBoardInTransaction,
  loadKingdomCommandBoard,
  upgradeKingdomCommandBoardInTransaction,
  warMaterialLabel
} from "./kingdomCommandBoard.js";
import {
  castleRubbleDisbandAvailableAt,
  castleRubbleSnapshot,
  lockKingdomCastleFlag
} from "./kingdomCastleRubble.js";
import {
  activateKingdomPerkInTransaction,
  chooseKingdomPerkInTransaction,
  kingdomPerksForPlayer,
  loadKingdomPerkSelections
} from "./kingdomPerks.js";
import {
  findKingdomWithinSpacing,
  kingdomCapacityMessage,
  kingdomSpacingMessage,
  kingdomStructureCapacitySnapshot
} from "./kingdomLimits.js";
import {
  KingdomRevoltError,
  castKingdomRevoltVoteInTransaction,
  kingdomRevoltWorkDue,
  kingdomsWithRevoltWork,
  loadKingdomRevoltState,
  settleKingdomRevoltInTransaction,
  startKingdomRevoltInTransaction
} from "./kingdomRevolts.js";
import type { PlayerRecord } from "./state.js";
import type { MasteryService } from "./masteries.js";
import { classifyLandFootprint } from "./landFootprintAuthority.js";
import {
  beginTerritoryCollapseInTransaction,
  breakTerritoryFlagsInTransaction,
  type TerritoryCollapseBegun
} from "./territoryCollapse.js";
import {
  FLAG_CONTROL_TOUCH_TOLERANCE_M,
  findForeignOrganizationConnection,
  isPersonalFlagControlledByPlayer,
  lockFlagControlGeometry,
  type FlagControlRecord
} from "./flagControlGeometry.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type FoundKingdomInput = {
  requestId: string;
  sourceFlagId?: string | undefined;
  displayName: string;
  description?: string | null | undefined;
  emblemKey?: string | null | undefined;
  displayColor?: string | undefined;
};

export type KingdomInviteInput = { requestId: string; targetPlayerId: string };
export type KingdomInvitationResponseInput = {
  requestId: string;
  invitationId: string;
  response: "accept" | "decline";
};
export type KingdomCancelInvitationInput = { requestId: string; invitationId: string };
export type KingdomMemberActionInput = {
  requestId: string;
  targetPlayerId: string;
  action: "remove" | "ban" | "unban" | "promote" | "demote" | "transfer_leadership";
};
export type KingdomIdentityInput = {
  requestId: string;
  description?: string | null | undefined;
  emblemKey?: string | null | undefined;
  displayColor?: string | undefined;
};
export type KingdomMuteInput = {
  requestId: string;
  targetPlayerId: string;
  action: "mute" | "unmute";
  mutedUntil?: string | null | undefined;
};
export type KingdomDonationInput = {
  requestId: string;
  resourceType: ResourceType;
  variant?: string | null | undefined;
  quantity: number;
};
export type KingdomAdvancementProjectStartInput = {
  requestId: string;
  targetLevel: number;
};
export type KingdomAdvancementProjectCancelInput = {
  requestId: string;
  projectId: string;
};
export type KingdomPlacementInput = { requestId: string; rotation?: number | undefined };
export type KingdomCotMutationInput = {
  requestId: string;
  cotId: string;
  action: "move" | "pack";
  rotation?: number | undefined;
};
export type KingdomDecorationPlacementInput = KingdomPlacementInput & {
  typeId: KingdomDecorationTypeId;
  kingdomOwned?: boolean | undefined;
};
export type KingdomDecorationMutationInput = {
  requestId: string;
  decorationId: string;
  action: "move" | "remove";
  rotation?: number | undefined;
};
export type KingdomChatInput = { requestId: string; content: string };
export type KingdomFlagConversionInput = { requestId: string; flagId: string };
export type KingdomFlagRemovalInput = {
  requestId: string;
  flagId: string;
  expectedNetworkRevision: string;
};
export type KingdomServiceHooks = {
  beforePrivateStateEmission?: (playerId: string, kingdomId: string) => void | Promise<void>;
  beforePostCommitStateLoad?: (playerId: string, operation: string) => void | Promise<void>;
};

export type KingdomMutationResult = {
  state: KingdomStateSnapshot | null;
  stateRefreshRequired: boolean;
  replayed: boolean;
  spatialChanges?: KingdomSpatialChange[];
  notificationPlayerIds?: string[];
  affectedFlagIds?: string[];
};
export type KingdomSpatialChange = {
  previous: KingdomSpatialEntity | null;
  current: KingdomSpatialEntity | null;
  spatialRevision: string;
};
export type KingdomInviteResult = KingdomMutationResult & { targetPlayerId: string };
export type KingdomChatResult = {
  kingdomId: string;
  message: KingdomChatMessage | null;
  messageId: string;
  recipientPlayerIds: string[];
  replayed: boolean;
};

export type KingdomErrorCode =
  | "KINGDOM_NOT_FOUND"
  | "KINGDOM_PLAYER_REQUIRED"
  | "KINGDOM_LIVE_POSITION_REQUIRED"
  | "KINGDOM_INVALID_REQUEST"
  | "KINGDOM_INACTIVE"
  | "KINGDOM_MEMBERSHIP_REQUIRED"
  | "KINGDOM_ALREADY_MEMBER"
  | "KINGDOM_PERMISSION_DENIED"
  | "KINGDOM_NAME_INVALID"
  | "KINGDOM_NAME_UNAVAILABLE"
  | "KINGDOM_REQUEST_CONFLICT"
  | "KINGDOM_WORLD_AUTHORITY_UNAVAILABLE"
  | "KINGDOM_NOT_ON_LAND"
  | "KINGDOM_WATER_REJECTED"
  | "KINGDOM_TERRITORY_OVERLAP"
  | "KINGDOM_SEAT_TOO_CLOSE"
  | "KINGDOM_PENDING_RESERVATION_CONFLICT"
  | "KINGDOM_FLAG_TERRITORY_OVERLAP"
  | "KINGDOM_CONSTRUCTION_DISABLED"
  | "KINGDOM_CONSTRUCTION_INSUFFICIENT_RESOURCES"
  | "KINGDOM_INVITATION_NOT_FOUND"
  | "KINGDOM_INVITATION_EXPIRED"
  | "KINGDOM_INVITATION_EXISTS"
  | "KINGDOM_MEMBER_CAPACITY_REACHED"
  | "KINGDOM_MEMBER_NOT_FOUND"
  | "KINGDOM_MEMBER_BANNED"
  | "KINGDOM_LEADER_PROTECTED"
  | "KINGDOM_LEADERSHIP_TRANSFER_REQUIRED"
  | "KINGDOM_CHAT_MUTED"
  | "KINGDOM_CHAT_RATE_LIMITED"
  | "KINGDOM_CHAT_INVALID"
  | "KINGDOM_DONATION_INVALID"
  | "KINGDOM_DONATION_INSUFFICIENT_BALANCE"
  | "KINGDOM_ADVANCEMENT_PROJECT_ACTIVE"
  | "KINGDOM_ADVANCEMENT_MAX_LEVEL"
  | "KINGDOM_ADVANCEMENT_RETIRED"
  | "KINGDOM_ADVANCEMENT_PROJECT_NOT_FOUND"
  | "KINGDOM_ADVANCEMENT_PROJECT_NOT_PENDING"
  | "KINGDOM_ADVANCEMENT_INSUFFICIENT_TREASURY"
  | "KINGDOM_ADVANCEMENT_PROJECT_STATE_CHANGED"
  | "KINGDOM_ADVANCEMENT_COMPLETION_PROCESSED"
  | "KINGDOM_COT_ALREADY_PLACED"
  | "KINGDOM_COT_CAPACITY_REACHED"
  | "KINGDOM_DECORATION_CAPACITY_REACHED"
  | "KINGDOM_DECORATION_LOCKED"
  | "KINGDOM_DECORATION_NOT_FOUND"
  | "KINGDOM_OUTSIDE_TERRITORY"
  | "KINGDOM_PLACEMENT_COLLISION"
  | "KINGDOM_FLAG_NOT_FOUND"
  | "KINGDOM_FLAG_KIND_UNSUPPORTED"
  | "KINGDOM_FLAG_NOT_OWNER"
  | "KINGDOM_FLAG_NOT_PERSONALLY_CONTROLLED"
  | "KINGDOM_FLAG_CONTRIBUTE_PERMISSION_REQUIRED"
  | "KINGDOM_FLAG_MANAGE_PERMISSION_REQUIRED"
  | "KINGDOM_FLAG_RELEASE_PERMISSION_REQUIRED"
  | "KINGDOM_FLAG_DESTROY_PERMISSION_REQUIRED"
  | "KINGDOM_SEAT_INCOMPLETE"
  | "KINGDOM_FLAG_INCOMPLETE"
  | "KINGDOM_FLAG_CITY_AFFILIATED"
  | "KINGDOM_FLAG_ALREADY_AFFILIATED"
  | "KINGDOM_FLAG_FOREIGN_AFFILIATION"
  | "KINGDOM_FLAG_FOREIGN_CONNECTION"
  | "KINGDOM_FLAG_NOT_CONNECTED"
  | "KINGDOM_FLAG_LIFECYCLE_CHANGED"
  | "KINGDOM_FOUNDING_FLAG_REQUIRED"
  | "KINGDOM_FOUNDING_LEVEL_REQUIRED"
  | "KINGDOM_FOUNDING_NO_FLAG_TERRITORY"
  | "KINGDOM_FOUNDING_OUTSIDE_TERRITORY"
  | "KINGDOM_FOUNDING_FLAG_RESERVED"
  | "KINGDOM_FOUNDING_FLAG_OWNERSHIP_CHANGED"
  | "KINGDOM_MEMBERSHIP_CHANGED"
  | "KINGDOM_FLAG_NETWORK_CHANGED"
  | "KINGDOM_FLAG_CONTROL_CHANGED"
  | "KINGDOM_FLAG_RELEASE_OVERLAP"
  | "KINGDOM_FLAG_NETWORK_LIMIT"
  | "KINGDOM_DESTINATION_UNAVAILABLE"
  | "KINGDOM_VALIDATION_FAILED"
  | "KINGDOM_DONATION_USE_BRICK_DEPOSIT"
  | "KINGDOM_BRICK_DEPOSIT_INVALID"
  | "KINGDOM_BRICK_DEPOSIT_INSUFFICIENT"
  | "KINGDOM_BRICK_FURNACE_LEVEL_INVALID"
  | "KINGDOM_BRICK_FURNACE_LEVEL_CHANGED"
  | "KINGDOM_BRICK_FURNACE_GLIMMER_OIL_REQUIRED"
  | "KINGDOM_BRICK_FURNACE_REQUIRED"
  | "KINGDOM_BRICK_FURNACE_COOLDOWN"
  | "KINGDOM_STRUCTURE_CAPACITY_REACHED"
  | "KINGDOM_SPACING_TOO_CLOSE"
  | "KINGDOM_PERK_LOCKED"
  | "KINGDOM_PERK_ALREADY_CHOSEN"
  | "KINGDOM_PERK_STATE_CHANGED"
  | "KINGDOM_PERK_INSUFFICIENT_TREASURY"
  | "KINGDOM_PERK_NOT_ACTIVATED"
  | "KINGDOM_PERK_ACTIVATION_COOLDOWN"
  | "KINGDOM_REVOLT_ANARCHY"
  | "KINGDOM_REVOLT_LEADER_CANNOT_VOTE"
  | "KINGDOM_REVOLT_ALREADY_OPEN"
  | "KINGDOM_REVOLT_NOT_FOUND"
  | "KINGDOM_REVOLT_ALREADY_VOTED"
  | "KINGDOM_REVOLT_COOLDOWN"
  | "KINGDOM_COMMAND_BOARD_LEVEL_CHANGED"
  | "KINGDOM_STRUCTURE_DOWNGRADE_FLOOR"
  | "KINGDOM_CASTLE_RUBBLE"
  | "KINGDOM_CASTLE_STANDING"
  | "KINGDOM_CASTLE_NOT_FOUND"
  | "KINGDOM_CASTLE_RUBBLE_DISBAND_LOCKED"
  | "KINGDOM_CASTLE_REBUILD_MATERIAL_REQUIRED";

export class KingdomError extends Error {
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    readonly code: KingdomErrorCode,
    message: string,
    statusOrDetails: number | Record<string, unknown> = 400,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "KingdomError";
    this.statusCode = typeof statusOrDetails === "number" ? statusOrDetails : 400;
    this.details = typeof statusOrDetails === "number" ? details : statusOrDetails;
  }
}

const FOUNDING_QUOTE_BLOCKER_CODES: ReadonlySet<KingdomErrorCode> = new Set([
  "KINGDOM_ALREADY_MEMBER",
  "KINGDOM_NAME_UNAVAILABLE",
  "KINGDOM_WORLD_AUTHORITY_UNAVAILABLE",
  "KINGDOM_NOT_ON_LAND",
  "KINGDOM_WATER_REJECTED",
  "KINGDOM_TERRITORY_OVERLAP",
  "KINGDOM_SEAT_TOO_CLOSE",
  "KINGDOM_SPACING_TOO_CLOSE",
  "KINGDOM_PENDING_RESERVATION_CONFLICT",
  "KINGDOM_FLAG_TERRITORY_OVERLAP",
  "KINGDOM_FLAG_NOT_OWNER",
  "KINGDOM_FLAG_NOT_PERSONALLY_CONTROLLED",
  "KINGDOM_FLAG_INCOMPLETE",
  "KINGDOM_FLAG_CITY_AFFILIATED",
  "KINGDOM_FLAG_ALREADY_AFFILIATED",
  "KINGDOM_FLAG_FOREIGN_AFFILIATION",
  "KINGDOM_FLAG_FOREIGN_CONNECTION",
  "KINGDOM_FOUNDING_FLAG_REQUIRED",
  "KINGDOM_FOUNDING_LEVEL_REQUIRED",
  "KINGDOM_FOUNDING_NO_FLAG_TERRITORY",
  "KINGDOM_FOUNDING_OUTSIDE_TERRITORY",
  "KINGDOM_FOUNDING_FLAG_RESERVED"
]);

function foundingBlockerGuidance(code: KingdomErrorCode): string {
  if (code === "KINGDOM_ALREADY_MEMBER") return "Leave your current Kingdom before founding another.";
  if (code === "KINGDOM_NAME_UNAVAILABLE") return "Choose another Kingdom name and check again.";
  if (code === "KINGDOM_FOUNDING_LEVEL_REQUIRED") return `Reach level ${KINGDOM_FOUNDING_MIN_PLAYER_LEVEL} to found a Kingdom.`;
  if (code === "KINGDOM_FOUNDING_NO_FLAG_TERRITORY" || code === "KINGDOM_FOUNDING_OUTSIDE_TERRITORY") {
    return "Move inside the actual radius of a completed personal flag you own.";
  }
  if (code === "KINGDOM_FLAG_NOT_OWNER" || code === "KINGDOM_FLAG_NOT_PERSONALLY_CONTROLLED") {
    return "Move to a personally controlled flag you own.";
  }
  if (code === "KINGDOM_FLAG_CITY_AFFILIATED" || code === "KINGDOM_FLAG_ALREADY_AFFILIATED" ||
      code === "KINGDOM_FLAG_FOREIGN_AFFILIATION" || code === "KINGDOM_FLAG_FOREIGN_CONNECTION") {
    return "Select a different personal flag without City or Kingdom connections.";
  }
  if (code === "KINGDOM_FOUNDING_FLAG_RESERVED" || code === "KINGDOM_PENDING_RESERVATION_CONFLICT") {
    return "Wait for the pending founding attempt to finish or select another flag.";
  }
  if (code === "KINGDOM_WORLD_AUTHORITY_UNAVAILABLE") return "Try again when World authority is available.";
  if (code === "KINGDOM_WATER_REJECTED" || code === "KINGDOM_NOT_ON_LAND") return "Move the Seat location onto valid land.";
  if (code === "KINGDOM_TERRITORY_OVERLAP" || code === "KINGDOM_FLAG_TERRITORY_OVERLAP" ||
      code === "KINGDOM_SEAT_TOO_CLOSE" || code === "KINGDOM_SPACING_TOO_CLOSE") {
    return "Move to another flag farther from existing Kingdom territory.";
  }
  return "Correct the blocker, then check this location again.";
}

type ResolvedKingdomConfig = {
  freeConstruction: boolean;
  initialTerritoryRadiusM: number;
  minimumSeatSpacingM: number;
  seatSpacingBufferM: number;
  nearbyRadiusM: number;
  nearbyLimit: number;
  objectSnapshotLimit: number;
  invitationTtlSeconds: number;
  perkQualificationSeconds: number;
  chatHistoryLimit: number;
  chatRetentionLimit: number;
  donationHistoryLimit: number;
  chatRateMaximum: number;
  chatRateWindowSeconds: number;
  seatFootprintRadiusM: number;
  cotFootprintRadiusM: number;
  replayRetentionDays: number;
};

const ENVIRONMENT_RULES_VERSION = 1;
const FOUNDING_COST: readonly KingdomCostLine[] = KINGDOM_FOUNDING_BASE_REQUIREMENTS.cost;
const COT_COST: readonly KingdomCostLine[] = [{ resourceType: "wood", quantity: 10 }];
export const DEFAULT_KINGDOM_COLOR = "#7c3aed";

export type KingdomFlagAction = "contribute" | "manage" | "release" | "destroy";

const KINGDOM_FLAG_ACTION_PERMISSION: Readonly<Record<KingdomFlagAction, KingdomPermission>> = {
  contribute: "contribute_kingdom_flags",
  manage: "manage_kingdom_flags",
  release: "release_kingdom_flags",
  destroy: "destroy_kingdom_flags"
};

export function isKingdomControlledFlag(
  flag: Pick<FlagControlRecord, "control_type" | "kingdom_id">
): boolean {
  return flag.control_type === "kingdom" && flag.kingdom_id !== null;
}

export function canPerformKingdomFlagAction(role: KingdomRole, action: KingdomFlagAction): boolean {
  return hasKingdomPermission(role, KINGDOM_FLAG_ACTION_PERMISSION[action]);
}

/**
 * Kingdom flags belong to the Kingdom: only a member whose role grants the
 * action may perform it. The contributing player keeps no personal rights.
 */
export async function assertKingdomFlagAction(
  queryable: Queryable,
  actorId: string,
  kingdomId: string,
  action: Exclude<KingdomFlagAction, "contribute">
): Promise<KingdomRole> {
  const membership = await queryable.query<{ role: KingdomRole }>(
    `SELECT role FROM kingdom_memberships
     WHERE kingdom_id = $1 AND player_id = $2 AND status = 'active'
     ORDER BY joined_at DESC LIMIT 1 FOR UPDATE`,
    [kingdomId, actorId]
  );
  const role = membership.rows[0]?.role;
  if (!role || !canPerformKingdomFlagAction(role, action)) {
    const labels = { manage: "manage", release: "release", destroy: "destroy" } as const;
    const errorCodes = {
      manage: "KINGDOM_FLAG_MANAGE_PERMISSION_REQUIRED",
      release: "KINGDOM_FLAG_RELEASE_PERMISSION_REQUIRED",
      destroy: "KINGDOM_FLAG_DESTROY_PERMISSION_REQUIRED"
    } as const;
    throw new KingdomError(
      errorCodes[action],
      `You do not have permission to ${labels[action]} Kingdom Flags`
    );
  }
  return role;
}
export const KINGDOM_FLAG_NETWORK_LIMIT = 1_000;

export class KingdomConstructionPolicy {
  constructor(readonly freeConstruction: boolean) {}

  quote(
    action: "found" | "cot" | "decoration",
    environment: KingdomEnvironmentSnapshot,
    decoration?: KingdomDecorationDefinition
  ): KingdomConstructionQuote {
    const intendedCost = action === "found"
      ? [...FOUNDING_COST]
      : action === "cot"
        ? [...COT_COST]
        : [...(decoration?.futureMaterialCost ?? [])];
    const intendedConstructionSeconds = action === "found"
      ? 0
      : action === "cot"
        ? 60
        : decoration?.intendedConstructionSeconds ?? 0;
    const modifiers = environmentModifiersFor(environment).filter(
      (modifier) => action !== "found" || modifier.key !== "construction_time"
    );
    const costMultipliers = new Map<ResourceType, number>();
    let timeMultiplier = 1;
    for (const modifier of modifiers) {
      if (!modifier.applied || modifier.unit !== "multiplier") continue;
      if (modifier.key === "construction_time") timeMultiplier *= modifier.value;
      if (modifier.key === "wood_requirement") costMultipliers.set("wood", modifier.value);
      if (modifier.key === "stone_requirement") costMultipliers.set("stone", modifier.value);
    }
    return {
      action,
      freeConstruction: this.freeConstruction,
      intendedCost,
      intendedConstructionSeconds,
      adjustedCost: intendedCost.map((line) => ({
        ...line,
        quantity: Math.max(0, Math.ceil(line.quantity * (costMultipliers.get(line.resourceType) ?? 1)))
      })),
      adjustedConstructionSeconds: Math.max(0, Math.ceil(intendedConstructionSeconds * timeMultiplier)),
      modifiers
    };
  }

}

export function normalizeKingdomName(value: string): { displayName: string; normalizedName: string } {
  rejectControlCharacters(value, false);
  const displayName = value.trim().replace(/\s+/gu, " ");
  const normalizedName = displayName.toLowerCase();
  const length = Array.from(displayName).length;
  if (
    length < 3 ||
    length > 40 ||
    !/^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/.test(displayName)
  ) {
    throw new KingdomError(
      "KINGDOM_NAME_INVALID",
      "Kingdom names must be 3-40 letters or numbers separated by single spaces, hyphens, or underscores"
    );
  }
  return { displayName, normalizedName };
}

export function environmentModifiersFor(
  _environment: Pick<KingdomEnvironmentSnapshot, "terrainClass" | "biome" | "elevationM">
): KingdomEnvironmentModifier[] {
  void _environment;
  return [];
}

export class KingdomService {
  private readonly pushEnqueueEnabled: boolean;
  private readonly pushAudience: NativePushAudience;
  readonly constructionPolicy: KingdomConstructionPolicy;
  private readonly settings: ResolvedKingdomConfig;
  private readonly inventory: InventoryService;

  constructor(
    private readonly pool: pg.Pool,
    private readonly worldLookup: WorldLookupClient,
    config: AppConfig,
    private readonly logger: AppLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly hooks: KingdomServiceHooks = {},
    private readonly masteries?: MasteryService
  ) {
    this.settings = resolveConfig(config);
    this.pushEnqueueEnabled = config.NATIVE_PUSH_ENQUEUE_ENABLED;
    this.pushAudience = { accounts:config.NATIVE_PUSH_ACCOUNT_ALLOWLIST,kinds:config.NATIVE_PUSH_CATEGORY_ALLOWLIST };
    this.constructionPolicy = new KingdomConstructionPolicy(this.settings.freeConstruction);
    this.inventory = new InventoryService(pool);
  }

  get spatialInterestRadiusM(): number {
    return this.settings.nearbyRadiusM;
  }

  private async builderAdjustedConstructionSeconds(
    queryable: Queryable,
    playerId: string,
    baseSeconds: number
  ): Promise<number> {
    const rank = this.masteries
      ? await this.masteries.professionRankInTransaction(queryable, playerId, "builder")
      : 0;
    const effects = professionEffects("builder", rank) as { generalSpeedBonus: number };
    // Labor Corps: the builder's kingdom builds 20% quicker.
    const laborCorps = (await kingdomPerksForPlayer(queryable, playerId, this.now()))?.perkIds
      .has("labor_corps")
      ? KINGDOM_PERK_LABOR_CORPS_TIME_MULTIPLIER
      : 1;
    return Math.max(1, Math.round(baseSeconds * (1 - effects.generalSpeedBonus) * laborCorps));
  }

  async quoteFounding(
    player: PlayerRecord,
    input: FoundKingdomInput
  ): Promise<Omit<KingdomFoundingQuoteResult, "requestId">> {
    const identity = normalizeKingdomName(input.displayName);
    normalizeDescription(input.description);
    normalizeEmblem(input.emblemKey);
    const seatPosition = { ...player.position };
    let source: FoundingSourceFlagRow | null = null;
    let environment: KingdomEnvironmentSnapshot | null = null;
    let quote: KingdomConstructionQuote | null = null;
    let affordability: KingdomFoundingAffordabilityLine[] = [];
    const absorbedFlagCount = 0;
    const baseResult = (): Omit<KingdomFoundingQuoteResult, "requestId"> => ({
      position: seatPosition,
      seatPosition,
      territoryRadiusM: source ? Number(source.claim_radius_m) : null,
      sourceFlag: source ? foundingSourceSnapshot(source, player.playerId) : null,
      absorbedFlagCount,
      eligible: false,
      affordable: quote
        ? quote.freeConstruction || affordability.every(({ missingQuantity }) => missingQuantity === 0)
        : null,
      disabledReason: null,
      blockerCode: null,
      guidance: null,
      environment,
      quote,
      affordability,
      informational: true,
      reservationNotice: "This quote does not reserve the name, location, territory, or resources. Confirmation revalidates all rules transactionally."
    });
    try {
      await assertFoundingPlayerLevel(this.pool, player.playerId);
      source = await loadFoundingSourceFlagCandidate(
        this.pool,
        { ...player, position: seatPosition },
        input.sourceFlagId ?? null,
        false
      );
      assertFoundingSourceFlagEligible(source, player, input.sourceFlagId ?? null, false);
      if (await loadActiveMembership(this.pool, player.playerId)) {
        throw new KingdomError("KINGDOM_ALREADY_MEMBER", "Leave your current Kingdom before founding another");
      }
      const conflictingName = await this.pool.query(
        "SELECT id FROM kingdoms WHERE normalized_name = $1 LIMIT 1",
        [identity.normalizedName]
      );
      if (conflictingName.rowCount) {
        throw new KingdomError("KINGDOM_NAME_UNAVAILABLE", "That Kingdom name is unavailable");
      }
      if (await findForeignOrganizationConnection(this.pool, source!.id, null, null)) {
        throw new KingdomError(
          "KINGDOM_FLAG_FOREIGN_CONNECTION",
          "This flag connects to an existing City or foreign Kingdom"
        );
      }
      environment = await this.lookupFoundingEnvironment(seatPosition);
      await assertLandOnlyFootprint(
        this.worldLookup,
        seatPosition,
        this.settings.seatFootprintRadiusM
      );
      const territoryRadiusM = Number(source!.claim_radius_m);
      await assertSeatPlacementAvailable(
        this.pool,
        source!,
        seatPosition,
        territoryRadiusM,
        Math.max(
          this.settings.minimumSeatSpacingM,
          2 * territoryRadiusM + this.settings.seatSpacingBufferM
        ),
        { actorPlayerId: player.playerId, requestId: input.requestId }
      );
      const quoteSpacing = await findKingdomWithinSpacing(this.pool, source!.id, null);
      if (quoteSpacing) throw new KingdomError("KINGDOM_SPACING_TOO_CLOSE", kingdomSpacingMessage(quoteSpacing));
      quote = this.constructionPolicy.quote("found", environment);
      affordability = await loadFoundingAffordability(
        this.pool,
        player.playerId,
        quote.adjustedCost
      );
      return { ...baseResult(), eligible: true };
    } catch (error) {
      if (!(error instanceof KingdomError) || !FOUNDING_QUOTE_BLOCKER_CODES.has(error.code)) {
        throw error;
      }
      return {
        ...baseResult(),
        disabledReason: error.message,
        blockerCode: error.code,
        guidance: foundingBlockerGuidance(error.code)
      };
    }
  }

  async inventorySnapshot(playerId: string) {
    return this.inventory.getInventorySnapshot(playerId);
  }

  async listNearby(
    position: { lat: number; lon: number },
    radiusM = this.settings.nearbyRadiusM,
    limit = this.settings.nearbyLimit
  ): Promise<KingdomPublicSnapshot[]> {
    const result = await this.pool.query<PublicKingdomRow>(
      `${PUBLIC_KINGDOM_SELECT}
       WHERE k.status = 'active' AND s.status = 'active'
         AND ST_DWithin(
           s.geom::geography,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           $3
         )
       ORDER BY ST_Distance(
         s.geom::geography,
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
       ), k.id
       LIMIT $4`,
      [position.lon, position.lat, Math.max(1, radiusM), Math.min(1_000, Math.max(1, limit))]
    );
    return result.rows.map(publicKingdomFromRow);
  }

  async getPublicKingdom(kingdomId: string): Promise<KingdomPublicSnapshot> {
    const kingdom = await loadPublicKingdom(this.pool, kingdomId);
    if (!kingdom || kingdom.status !== "active") {
      throw new KingdomError("KINGDOM_NOT_FOUND", "Active Kingdom not found");
    }
    return kingdom;
  }

  async getSeatTravelDestination(seatId: string): Promise<{
    id: string;
    kingdomId: string;
    name: string;
    lat: number;
    lon: number;
    claimRadiusM: number;
  } | null> {
    const result = await this.pool.query<{
      id: string; kingdom_id: string; display_name: string;
      lat: number; lon: number; territory_radius_m: number;
    }>(
      `SELECT seat.id, seat.kingdom_id, kingdom.display_name,
              seat.lat, seat.lon, seat.territory_radius_m
       FROM kingdom_seats seat
       JOIN kingdoms kingdom ON kingdom.id = seat.kingdom_id
       WHERE seat.id = $1
         AND seat.status = 'active'
         AND seat.construction_state = 'complete'
         AND kingdom.status = 'active'
       LIMIT 1`,
      [seatId]
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      kingdomId: row.kingdom_id,
      name: `${row.display_name} Castle`,
      lat: Number(row.lat),
      lon: Number(row.lon),
      claimRadiusM: Number(row.territory_radius_m)
    } : null;
  }

  async getKingdomFlagEligibility(
    actorId: string,
    flagId: string
  ): Promise<KingdomFlagEligibility> {
    const membership = await loadActiveMembership(this.pool, actorId);
    if (!membership) {
      return ineligibleKingdomFlag(flagId, null, "KINGDOM_MEMBERSHIP_REQUIRED", "Active Kingdom membership is required");
    }
    if (!canPerformKingdomFlagAction(membership.role, "contribute")) {
      return ineligibleKingdomFlag(flagId, membership.kingdomId, "KINGDOM_FLAG_CONTRIBUTE_PERMISSION_REQUIRED", "You do not have permission to contribute Kingdom Flags");
    }
    const kingdom = await loadKingdomLock(this.pool, membership.kingdomId, false);
    if (!kingdom || kingdom.status !== "active") {
      return ineligibleKingdomFlag(flagId, membership.kingdomId, "KINGDOM_INACTIVE", "The Kingdom is no longer active");
    }
    if (kingdom.castle_ruined_at !== null) {
      return ineligibleKingdomFlag(
        flagId, membership.kingdomId, "KINGDOM_CASTLE_RUBBLE", "The Castle lies in rubble: the leader must rebuild it first"
      );
    }
    const flag = await loadKingdomFlagRow(this.pool, flagId, false);
    if (!flag) {
      return ineligibleKingdomFlag(flagId, membership.kingdomId, "KINGDOM_FLAG_NOT_FOUND", "Flag does not exist or is still under construction");
    }
    if (flag.anchor_kind === "buoy") {
      return ineligibleKingdomFlag(flagId, membership.kingdomId, "KINGDOM_FLAG_KIND_UNSUPPORTED", "Buoys cannot be converted into Kingdom Flags");
    }
    if (flag.city_id) {
      return ineligibleKingdomFlag(flagId, membership.kingdomId, "KINGDOM_FLAG_CITY_AFFILIATED", "Remove the flag's city affiliation before converting it");
    }
    if (!isPersonalFlagControlledByPlayer(flag, actorId)) {
      return ineligibleKingdomFlag(flagId, membership.kingdomId, "KINGDOM_FLAG_NOT_PERSONALLY_CONTROLLED", "The flag is not personally controlled by you");
    }
    if (isKingdomControlledFlag(flag) && flag.kingdom_id === membership.kingdomId) {
      return ineligibleKingdomFlag(flagId, membership.kingdomId, "KINGDOM_FLAG_ALREADY_AFFILIATED", "This flag is already affiliated with your Kingdom");
    }
    if (isKingdomControlledFlag(flag)) {
      return ineligibleKingdomFlag(flagId, membership.kingdomId, "KINGDOM_FLAG_FOREIGN_AFFILIATION", "This flag is affiliated with another Kingdom");
    }
    const seat = await loadCompletedKingdomSeat(this.pool, membership.kingdomId, false);
    if (!seat) {
      return ineligibleKingdomFlag(flagId, membership.kingdomId, "KINGDOM_SEAT_INCOMPLETE", "The Castle must be active and fully constructed");
    }
    const connectedIds = await loadConnectedKingdomFlagIds(this.pool, membership.kingdomId);
    const anchor = await loadKingdomFlagConnectionAnchor(
      this.pool, flag, membership.kingdomId, seat, connectedIds
    );
    if (!anchor) {
      return ineligibleKingdomFlag(
        flagId,
        membership.kingdomId,
        "KINGDOM_FLAG_NOT_CONNECTED",
        "The flag territory must touch the completed Castle or a connected Kingdom Flag",
        String(kingdom.spatial_revision)
      );
    }
    return {
      flagId,
      kingdomId: membership.kingdomId,
      eligible: true,
      reasonCode: null,
      reason: null,
      networkRevision: String(kingdom.spatial_revision),
      connectionAnchor: anchor
    };
  }

  async getKingdomFlagRemovalPreview(
    actorId: string,
    flagId: string
  ): Promise<KingdomFlagRemovalPreview> {
    const membership = await loadActiveMembership(this.pool, actorId);
    const flag = await loadKingdomFlagRow(this.pool, flagId, false);
    if (!membership || !flag?.kingdom_id || membership.kingdomId !== flag.kingdom_id) {
      return {
        flagId,
        kingdomId: flag?.kingdom_id ?? membership?.kingdomId ?? null,
        allowed: false,
        reasonCode: membership ? "KINGDOM_FLAG_FOREIGN_AFFILIATION" : "KINGDOM_MEMBERSHIP_REQUIRED",
        reason: membership ? "This flag is not affiliated with your Kingdom" : "Active Kingdom membership is required",
        networkRevision: null,
        downstreamCount: 0
      };
    }
    if (!canPerformKingdomFlagAction(membership.role, "release")) {
      return {
        flagId,
        kingdomId: flag.kingdom_id,
        allowed: false,
        reasonCode: "KINGDOM_FLAG_RELEASE_PERMISSION_REQUIRED",
        reason: "You do not have permission to release Kingdom Flags",
        networkRevision: null,
        downstreamCount: 0
      };
    }
    const kingdom = await loadKingdomLock(this.pool, flag.kingdom_id, false);
    const affected = await calculateKingdomFlagRemovalSet(this.pool, flag.kingdom_id, [flagId]);
    return {
      flagId,
      kingdomId: flag.kingdom_id,
      allowed: true,
      reasonCode: null,
      reason: null,
      networkRevision: String(kingdom?.spatial_revision ?? 0),
      downstreamCount: Math.max(0, affected.length - 1)
    };
  }

  async convertKingdomFlag(
    actorId: string,
    input: KingdomFlagConversionInput
  ): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, input.requestId, "convert_kingdom_flag", input, async (client) => {
      const actor = await lockActorContext(client, actorId, "contribute_kingdom_flags");
      assertCastleStanding(actor.castleRuinedAt);
      await lockKingdomFlagNetwork(client, actor.kingdomId);
      await lockFlagControlGeometry(client);
      const kingdom = await loadKingdomLock(client, actor.kingdomId, true);
      if (!kingdom || kingdom.status !== "active") throw new KingdomError("KINGDOM_INACTIVE", "The Kingdom is no longer active");
      const flag = await loadKingdomFlagRow(client, input.flagId, true);
      if (!flag) throw new KingdomError("KINGDOM_FLAG_LIFECYCLE_CHANGED", "The flag no longer exists or is still under construction");
      if (flag.anchor_kind === "buoy") throw new KingdomError("KINGDOM_FLAG_KIND_UNSUPPORTED", "Buoys cannot be converted into Kingdom Flags");
      if (flag.city_id) throw new KingdomError("KINGDOM_FLAG_CITY_AFFILIATED", "Remove the flag's city affiliation before converting it");
      if (!isPersonalFlagControlledByPlayer(flag, actorId)) {
        throw new KingdomError("KINGDOM_FLAG_NOT_PERSONALLY_CONTROLLED", "The flag is no longer personally controlled by you");
      }
      if (flag.kingdom_id === actor.kingdomId) throw new KingdomError("KINGDOM_FLAG_ALREADY_AFFILIATED", "This flag is already affiliated with your Kingdom");
      if (flag.kingdom_id) throw new KingdomError("KINGDOM_FLAG_FOREIGN_AFFILIATION", "This flag is affiliated with another Kingdom");
      if (await findForeignOrganizationConnection(client, flag.id, null, actor.kingdomId)) {
        throw new KingdomError(
          "KINGDOM_FLAG_FOREIGN_CONNECTION",
          "A Kingdom Flag cannot connect to a city or another Kingdom"
        );
      }
      const flagSpacing = await findKingdomWithinSpacing(client, flag.id, actor.kingdomId);
      if (flagSpacing) throw new KingdomError("KINGDOM_SPACING_TOO_CLOSE", kingdomSpacingMessage(flagSpacing));
      const capacity = await kingdomStructureCapacitySnapshot(client, actor.kingdomId);
      if (capacity.used >= capacity.capacity) {
        throw new KingdomError("KINGDOM_STRUCTURE_CAPACITY_REACHED", kingdomCapacityMessage(capacity), {
          used: capacity.used, capacity: capacity.capacity, activeMembers: capacity.activeMembers
        });
      }
      const seat = await loadCompletedKingdomSeat(client, actor.kingdomId, true);
      if (!seat) throw new KingdomError("KINGDOM_SEAT_INCOMPLETE", "The Castle must be active and fully constructed");
      const connectedIds = await loadConnectedKingdomFlagIds(client, actor.kingdomId);
      const anchor = await loadKingdomFlagConnectionAnchor(client, flag, actor.kingdomId, seat, connectedIds);
      if (!anchor) {
        throw new KingdomError("KINGDOM_FLAG_NOT_CONNECTED", "The flag territory does not touch the connected Kingdom network");
      }
      const now = this.now();
      const changed = await client.query(
        // The flag now belongs to the Kingdom: owner_id records the leader at
        // conversion and grants nothing by itself (rights are role-based);
        // provenance stays in original_owner_player_id / contributed_by_player_id.
        `UPDATE flags SET control_type = 'kingdom', kingdom_id = $2,
            owner_id = (SELECT leader_player_id FROM kingdoms WHERE id = $2),
            kingdom_affiliated_at = $3, kingdom_affiliated_by_player_id = $4,
            original_owner_player_id = COALESCE(original_owner_player_id, owner_id),
            contributed_by_player_id = $4,
            original_personal_color = COALESCE(original_personal_color, $5),
            health = NULL, maximum_health = NULL,
            burning_started_at = NULL, burning_until = NULL, burning_reason = NULL
         WHERE id = $1 AND control_type = 'personal' AND kingdom_id IS NULL
           AND city_id IS NULL AND owner_id = $4
           AND NOT EXISTS (
             SELECT 1 FROM legendary_bird_events event
             WHERE event.flag_id = flags.id AND event.status IN ('pending','active')
           )`,
        [input.flagId, actor.kingdomId, now, actorId, flag.owner_color]
      );
      if (changed.rowCount !== 1) throw new KingdomError("KINGDOM_FLAG_LIFECYCLE_CHANGED", "Flag affiliation changed during confirmation");
      await insertKingdomFlagHistory(client, {
        kingdomId: actor.kingdomId, flag, actorId, action: "affiliated",
        reason: "owner_conversion", requestId: input.requestId,
        resultingKingdomId: actor.kingdomId,
        metadata: { connectionAnchor: anchor }
      });
      await insertAudit(
        client,
        actor.kingdomId,
        actorId,
        flag.owner_id,
        "kingdom_flag_contributed",
        "flag",
        flag.id
      );
      await bumpKingdomSpatialRevision(client, actor.kingdomId);
      return { kingdomId: actor.kingdomId, flagId: input.flagId };
    });
    return {
      ...(await this.stateAfterCommit(actorId, "convert Kingdom flag")),
      replayed: mutation.replayed,
      affectedFlagIds: mutation.replayed ? [] : [input.flagId]
    };
  }

  async removeKingdomFlag(
    actorId: string,
    input: KingdomFlagRemovalInput
  ): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, input.requestId, "remove_kingdom_flag", input, async (client) => {
      const actor = await lockActorContext(client, actorId);
      await assertKingdomFlagAction(client, actorId, actor.kingdomId, "release");
      await lockKingdomFlagNetwork(client, actor.kingdomId);
      await lockFlagControlGeometry(client);
      const kingdom = await loadKingdomLock(client, actor.kingdomId, true);
      if (!kingdom || kingdom.status !== "active") throw new KingdomError("KINGDOM_INACTIVE", "The Kingdom is no longer active");
      if (String(kingdom.spatial_revision) !== input.expectedNetworkRevision) {
        throw new KingdomError("KINGDOM_FLAG_NETWORK_CHANGED", "The Kingdom Flag network changed; review the downstream warning again");
      }
      const flag = await loadKingdomFlagRow(client, input.flagId, true);
      if (!flag) throw new KingdomError("KINGDOM_FLAG_LIFECYCLE_CHANGED", "The flag no longer exists");
      if (!isKingdomControlledFlag(flag) || flag.kingdom_id !== actor.kingdomId) {
        throw new KingdomError("KINGDOM_FLAG_CONTROL_CHANGED", "This flag is no longer controlled by your Kingdom");
      }
      const result = await clearAndPruneKingdomFlags(
        client, actor.kingdomId, [input.flagId], actorId,
        "authorized_release",
        input.requestId
      );
      return {
        kingdomId: actor.kingdomId,
        affectedFlagIds: result.affectedFlagIds,
        notificationPlayerIds: result.ownerPlayerIds
      };
    }, (value) => ({ kingdomId: value.kingdomId, affectedFlagIds: value.affectedFlagIds }));
    return {
      ...(await this.stateAfterCommit(actorId, "remove Kingdom flag")),
      replayed: mutation.replayed,
      affectedFlagIds: mutation.replayed ? [] : mutation.value.affectedFlagIds as string[],
      notificationPlayerIds: mutation.replayed ? [] : mutation.value.notificationPlayerIds as string[]
    };
  }

  async listNearbyObjects(
    position: { lat: number; lon: number },
    radiusM = this.settings.nearbyRadiusM,
    limit = this.settings.objectSnapshotLimit
  ): Promise<NearbyKingdomObjectSnapshot[]> {
    const result = await this.pool.query<{
      id: string;
      kingdom_id: string;
      kind: "cot" | "decoration";
      type_id: KingdomDecorationTypeId | "cot";
      display_name: string;
      lat: number;
      lon: number;
      rotation: number;
      spatial_revision: string | number;
    }>(
      `SELECT id, kingdom_id, kind, type_id, display_name, lat, lon, rotation, spatial_revision
       FROM (
         SELECT c.id, c.kingdom_id, 'cot'::text AS kind, 'cot'::text AS type_id,
                'Cot'::text AS display_name, c.lat, c.lon, c.rotation, c.geom, c.spatial_revision
         FROM kingdom_cots c
         JOIN kingdoms k ON k.id = c.kingdom_id AND k.status = 'active'
         WHERE c.status = 'active' AND c.construction_state = 'complete'
         UNION ALL
         SELECT d.id, d.kingdom_id, 'decoration'::text, d.type_id,
                definition.display_name, d.lat, d.lon, d.rotation, d.geom, d.spatial_revision
         FROM kingdom_decorations d
         JOIN kingdoms k ON k.id = d.kingdom_id AND k.status = 'active'
         JOIN kingdom_decoration_definitions definition ON definition.type_id = d.type_id
         WHERE d.status = 'active' AND d.construction_state = 'complete'
       ) objects
       WHERE ST_DWithin(
         objects.geom::geography,
         ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
         $3
       )
       ORDER BY ST_Distance(
         objects.geom::geography,
         ST_SetSRID(ST_MakePoint($1,$2),4326)::geography
       ), objects.id
       LIMIT $4`,
      [position.lon, position.lat, Math.max(1, radiusM), Math.min(1_000, Math.max(1, limit))]
    );
    return result.rows.map((row) => ({
      id: row.id,
      kingdomId: row.kingdom_id,
      kind: row.kind,
      typeId: row.type_id,
      displayName: row.display_name,
      lat: Number(row.lat),
      lon: Number(row.lon),
      rotation: Number(row.rotation),
      spatialRevision: String(row.spatial_revision)
    }));
  }

  async getState(player: PlayerRecord | string): Promise<KingdomStateSnapshot> {
    return this.loadState(player, true);
  }

  private async loadState(
    player: PlayerRecord | string,
    allowAuthorityRetry: boolean
  ): Promise<KingdomStateSnapshot> {
    const playerId = typeof player === "string" ? player : player.playerId;
    const position = typeof player === "string" ? null : { ...player.position };
    const membership = await loadActiveMembership(this.pool, playerId);
    await expireRelevantInvitations(this.pool, this.now(), playerId, membership?.kingdomId ?? null);
    if (membership) {
      await completeDueConstruction(this.pool, membership.kingdomId, this.now(), this.masteries);
      await completeDueKingdomProjects(this.pool, membership.kingdomId, this.now());
      if (await kingdomRevoltWorkDue(this.pool, membership.kingdomId, this.now())) {
        await this.settleRevolts([membership.kingdomId]);
      }
    }
    const spatialRevision = await loadSpatialRevision(this.pool);
    const permissions = membership ? permissionsForKingdomRole(membership.role) : [];
    const kingdomId = membership?.kingdomId ?? null;
    const [kingdom, roster, invitations, chatHistory, treasury, donations, expenditures, advancementProject,
      activityHistory, cots, decorations, kingdomFlags, decorationCatalog, nearby, nearbyObjects, brickFurnace, structureCapacity, commandBoard,
      revolt] =
      await Promise.all([
        kingdomId ? loadPublicKingdom(this.pool, kingdomId) : Promise.resolve(null),
        kingdomId
          ? loadRoster(
              this.pool,
              kingdomId,
              Boolean(membership && hasKingdomPermission(membership.role, "ban_members"))
            )
          : Promise.resolve([]),
        loadInvitations(
          this.pool,
          playerId,
          kingdomId,
          Boolean(membership && hasKingdomPermission(membership.role, "invite_members")),
          this.now()
        ),
        kingdomId
          ? loadChatHistory(this.pool, kingdomId, playerId, this.settings.chatHistoryLimit)
          : Promise.resolve([]),
        kingdomId ? loadTreasury(this.pool, kingdomId) : Promise.resolve([]),
        kingdomId && membership && hasKingdomPermission(membership.role, "view_treasury_ledger")
          ? loadDonations(this.pool, kingdomId, this.settings.donationHistoryLimit)
          : Promise.resolve(null),
        kingdomId && membership && hasKingdomPermission(membership.role, "view_treasury_ledger")
          ? loadTreasuryExpenditures(this.pool, kingdomId, this.settings.donationHistoryLimit)
          : Promise.resolve(null),
        kingdomId ? loadActiveAdvancementProject(this.pool, kingdomId) : Promise.resolve(null),
        kingdomId ? loadActivityHistory(this.pool, kingdomId, this.settings.donationHistoryLimit) : Promise.resolve([]),
        kingdomId ? loadCots(this.pool, kingdomId) : Promise.resolve([]),
        kingdomId ? loadDecorations(this.pool, kingdomId) : Promise.resolve([]),
        kingdomId ? loadKingdomFlags(this.pool, kingdomId) : Promise.resolve([]),
        loadDecorationDefinitions(this.pool),
        position ? this.listNearby(position) : Promise.resolve([]),
        position ? this.listNearbyObjects(position) : Promise.resolve([]),
        kingdomId ? loadBrickFurnace(this.pool, kingdomId, this.now()) : Promise.resolve(null),
        kingdomId ? kingdomStructureCapacitySnapshot(this.pool, kingdomId) : Promise.resolve(null),
        kingdomId ? loadKingdomCommandBoard(this.pool, kingdomId, this.now()) : Promise.resolve(null),
        kingdomId ? loadKingdomRevoltState(this.pool, kingdomId, playerId, this.now()) : Promise.resolve(null)
      ]);
    // Private reads deliberately use separate bounded queries. Revalidate membership at
    // the emission boundary so a concurrent removal/dissolution cannot leak the snapshot.
    if (kingdomId) await this.hooks.beforePrivateStateEmission?.(playerId, kingdomId);
    const currentMembership = kingdomId ? await loadActiveMembership(this.pool, playerId) : null;
    const authorityChanged = Boolean(kingdomId && (
      currentMembership?.kingdomId !== kingdomId ||
      currentMembership.membershipId !== membership?.membershipId ||
      currentMembership.role !== membership?.role
    ));
    if (authorityChanged && allowAuthorityRetry) {
      return this.loadState(player, false);
    }
    if (authorityChanged) {
      return {
        spatialRevision,
        membership: null,
        kingdom: null,
        permissions: [],
        roster: [],
        invitations: await loadInvitations(this.pool, playerId, null, false, this.now()),
        chatHistory: [],
        treasury: [],
        donationHistory: null,
        treasuryExpenditureHistory: null,
        progression: null,
        advancementProject: null,
        activityHistory: [],
        cots: [],
        decorations: [],
        kingdomFlags: [],
        decorationCatalog,
        nearbyKingdoms: nearby,
        nearbyObjects,
        freeConstruction: this.settings.freeConstruction,
        perkQualificationSeconds: this.settings.perkQualificationSeconds
      };
    }
    const xp = kingdomId ? await loadKingdomXp(this.pool, kingdomId) : null;
    const progression = kingdom && membership && xp
      ? progressionSnapshot(
          kingdom.level,
          xp.currentXp,
          xp.lifetimeXp,
          membership.perkQualifiedAt,
          this.now(),
          kingdom.seat?.territoryRadiusM,
          await loadKingdomPerkSelections(this.pool, kingdom.id, this.now()),
          await loadKingdomDailyMemberXp(this.pool, kingdom.id)
        )
      : null;
    const decorationCatalogWithQuotes = kingdom?.seat
      ? decorationCatalog.map((definition) => ({
          ...definition,
          constructionQuote: this.constructionPolicy.quote("decoration", kingdom.seat!.environment, definition)
        }))
      : decorationCatalog;
    return {
      spatialRevision,
      membership: membership?.snapshot ?? null,
      kingdom,
      permissions,
      roster,
      invitations,
      chatHistory,
      treasury,
      donationHistory: donations,
      treasuryExpenditureHistory: expenditures,
      progression,
      advancementProject,
      activityHistory,
      cots,
      decorations,
      kingdomFlags,
      decorationCatalog: decorationCatalogWithQuotes,
      brickFurnace,
      structureCapacity,
      commandBoard,
      revolt,
      ...(kingdom?.castleRuinedAt
        ? { castleRubble: castleRubbleSnapshot(kingdom.castleRuinedAt, this.castleRebuildCost()) }
        : {}),
      cotConstructionQuote: kingdom?.seat
        ? this.constructionPolicy.quote("cot", kingdom.seat.environment)
        : null,
      nearbyKingdoms: nearby,
      nearbyObjects,
      freeConstruction: this.settings.freeConstruction,
      perkQualificationSeconds: this.settings.perkQualificationSeconds
    };
  }

  async foundKingdom(player: PlayerRecord, input: FoundKingdomInput): Promise<KingdomMutationResult> {
    if (!input.sourceFlagId) {
      throw new KingdomError(
        "KINGDOM_FOUNDING_FLAG_REQUIRED",
        "Select an eligible completed personal flag territory to found a Kingdom"
      );
    }
    const identity = normalizeKingdomName(input.displayName);
    const description = normalizeDescription(input.description);
    const emblemKey = normalizeEmblem(input.emblemKey);
    const displayColor = normalizeKingdomColor(input.displayColor);
    const payload = { ...input, ...identity, description, emblemKey, displayColor };
    const existing = await this.loadReplay<{ kingdomId: string }>(
      player.playerId,
      input.requestId,
      "found",
      payload
    );
    if (existing) {
      return {
        ...(await this.stateAfterCommit(player, "found replay")),
        replayed: true,
        spatialChanges: []
      };
    }

    if (await loadActiveMembership(this.pool, player.playerId)) {
      throw new KingdomError("KINGDOM_ALREADY_MEMBER", "A player may belong to only one active Kingdom");
    }
    const seatPosition = { ...player.position };
    const capturedPlayer = { ...player, position: seatPosition };
    const source = await resolveFoundingSourceFlag(
      this.pool, capturedPlayer, input.sourceFlagId, false, true
    );
    const environment = await this.lookupFoundingEnvironment(seatPosition);
    await assertLandOnlyFootprint(
      this.worldLookup,
      seatPosition,
      this.settings.seatFootprintRadiusM
    );
    const initialTerritoryRadiusM = Number(source.claim_radius_m);
    const quote = this.constructionPolicy.quote("found", environment);
    const mutation = await this.mutate(
      player.playerId,
      input.requestId,
      "found",
      payload,
      async (client) => {
        await client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [player.playerId]);
        await assertFoundingPlayerLevel(client, player.playerId);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('kingdom-seat-placement', 0))");
        await lockFlagControlGeometry(client);
        const active = await client.query(
          "SELECT id FROM kingdom_memberships WHERE player_id = $1 AND status = 'active' LIMIT 1",
          [player.playerId]
        );
        if (active.rowCount) {
          throw new KingdomError("KINGDOM_ALREADY_MEMBER", "A player may belong to only one active Kingdom");
        }
        const lockedSource = await resolveFoundingSourceFlag(
          client, capturedPlayer, input.sourceFlagId!, true, true
        );
        if (await findForeignOrganizationConnection(client, lockedSource.id, null, null)) {
          throw new KingdomError(
            "KINGDOM_FLAG_FOREIGN_CONNECTION",
            "A Castle cannot connect to an existing city or Kingdom"
          );
        }
        if (
          Number(lockedSource.lat) !== Number(source.lat) ||
          Number(lockedSource.lon) !== Number(source.lon) ||
          Number(lockedSource.claim_radius_m) !== initialTerritoryRadiusM
        ) {
          throw new KingdomError(
            "KINGDOM_FLAG_LIFECYCLE_CHANGED",
            "The founding flag changed after the quote; request a new authoritative quote"
          );
        }
        const conflictingName = await client.query(
          "SELECT id FROM kingdoms WHERE normalized_name = $1 LIMIT 1",
          [identity.normalizedName]
        );
        if (conflictingName.rowCount) {
          throw new KingdomError("KINGDOM_NAME_UNAVAILABLE", "That Kingdom name is unavailable");
        }
        await assertSeatPlacementAvailable(
          client,
          lockedSource,
          seatPosition,
          initialTerritoryRadiusM,
          Math.max(
            this.settings.minimumSeatSpacingM,
            2 * initialTerritoryRadiusM + this.settings.seatSpacingBufferM
          ),
          { actorPlayerId: player.playerId, requestId: input.requestId }
        );
        const seatSpacing = await findKingdomWithinSpacing(client, lockedSource.id, null);
        if (seatSpacing) throw new KingdomError("KINGDOM_SPACING_TOO_CLOSE", kingdomSpacingMessage(seatSpacing));
        const kingdomId = randomUUID();
        const seatId = randomUUID();
        const now = this.now();
        await client.query(
          `INSERT INTO kingdoms (
             id, normalized_name, display_name, description, emblem_key, display_color,
             founder_player_id, leader_player_id, level, current_xp, lifetime_xp,
             level_definition_version, founding_request_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,1,0,0,$8,$9)`,
          [kingdomId, identity.normalizedName, identity.displayName, description, emblemKey,
            displayColor, player.playerId, KINGDOM_LEVEL_DEFINITION_VERSION, input.requestId]
        );
        const reserved = await client.query(
          `UPDATE flags
           SET control_type = 'kingdom_seat', kingdom_id = $2,
               kingdom_affiliated_at = $3, kingdom_affiliated_by_player_id = $4,
               original_owner_player_id = COALESCE(original_owner_player_id, owner_id),
               contributed_by_player_id = NULL,
               original_personal_color = COALESCE(original_personal_color, $5),
               health = NULL, maximum_health = NULL,
               burning_started_at = NULL, burning_until = NULL, burning_reason = NULL,
               kingdom_founding_request_id = $6,
               kingdom_founding_reserved_at = $7
           WHERE id = $1 AND owner_id = $4 AND control_type = 'personal'
             AND kingdom_id IS NULL AND city_id IS NULL
             AND kingdom_founding_request_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM legendary_bird_events event
               WHERE event.flag_id = flags.id AND event.status IN ('pending','active')
             )`,
          [
            lockedSource.id, kingdomId, now, player.playerId, lockedSource.owner_color,
            null,
            null
          ]
        );
        if (reserved.rowCount !== 1) {
          throw new KingdomError(
            "KINGDOM_FLAG_LIFECYCLE_CHANGED",
            "The founding flag changed during confirmation"
          );
        }
        await this.debitConstructionCost(client, player.playerId, input.requestId, kingdomId, "seat", seatId, quote);
        const constructionSeconds = quote.adjustedConstructionSeconds === 0
          ? 0
          : await this.builderAdjustedConstructionSeconds(
              client, player.playerId, quote.adjustedConstructionSeconds
            );
        const completesImmediately = this.settings.freeConstruction || constructionSeconds === 0;
        const constructionState = completesImmediately ? "complete" : "under_construction";
        const completesAt = new Date(now.getTime() + constructionSeconds * 1_000);
        await client.query(
          `INSERT INTO kingdom_seats (
             id, kingdom_id, lat, lon, geom, territory_radius_m,
             terrain_class, biome, ecoregion, elevation_m, elevation_band, slope, slope_band,
             is_land, is_saltwater, inside_major_lake, world_release_id, world_release_version,
             world_package_id, environment_schema_version, environment_source_versions,
             environment_rules_version, environment_modifiers, environment_lookup_at,
             construction_state, completed_under_free_construction, status, completed_at,
             source_flag_id
           ) VALUES (
             $1,$2,$3,$4,ST_SetSRID(ST_MakePoint($4,$3),4326),$5,
             $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,
             $21,$22::jsonb,$23,$24,$25,'active',$26,$27
           )`,
          [seatId, kingdomId, seatPosition.lat, seatPosition.lon, initialTerritoryRadiusM,
            environment.terrainClass, environment.biome, environment.ecoregion,
            environment.elevationM, environment.elevationBand, environment.slope,
            environment.slopeBand, environment.isLand, environment.isSaltwater,
            environment.insideMajorLake, environment.worldReleaseId,
            environment.worldReleaseVersion, environment.worldPackageId,
            environment.environmentSchemaVersion, JSON.stringify(environment.sourceVersions),
            ENVIRONMENT_RULES_VERSION, JSON.stringify(quote.modifiers), now,
            constructionState, this.settings.freeConstruction, completesImmediately ? now : null,
            lockedSource.id]
        );
        if (!completesImmediately) {
          await insertConstructionJob(client, {
            kingdomId, actorPlayerId: player.playerId, entityType: "seat", entityId: seatId,
            requestId: input.requestId, quote, startedAt: now, completesAt
          });
        }
        await client.query(
          `INSERT INTO kingdom_memberships (
             id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
           ) VALUES ($1,$2,$3,'leader','active',$4,$5)`,
          [randomUUID(), kingdomId, player.playerId, now,
            new Date(now.getTime() + this.settings.perkQualificationSeconds * 1_000)]
        );
        await insertAudit(client, kingdomId, player.playerId, null, "kingdom_founded", "seat", seatId, {
          freeConstruction: this.settings.freeConstruction,
          quote,
          environmentRulesVersion: ENVIRONMENT_RULES_VERSION,
          sourceFlagId: lockedSource.id,
          sourceFlagName: lockedSource.name,
          sourceFlagRadiusM: Number(lockedSource.claim_radius_m),
          sourceTerritoryLat: Number(lockedSource.lat),
          sourceTerritoryLon: Number(lockedSource.lon),
          seatLat: seatPosition.lat,
          seatLon: seatPosition.lon,
          absorbedFlagIds: []
        });
        const publicKingdom = await loadPublicKingdom(client, kingdomId);
        return {
          kingdomId,
          affectedFlagIds: [lockedSource.id],
          spatialChanges: publicKingdom
            ? [spatialUpsertChange(null, spatialSeatEntity(publicKingdom))]
            : []
        };
      },
      (value) => ({ kingdomId: value.kingdomId })
    );
    this.logger.info({ kingdomId: mutation.value.kingdomId, founderPlayerId: player.playerId }, "kingdom founded");
    return {
      ...(await this.stateAfterCommit(player, "found")),
      replayed: mutation.replayed,
      spatialChanges: mutation.replayed ? [] : mutation.value.spatialChanges,
      affectedFlagIds: mutation.replayed ? [] : mutation.value.affectedFlagIds
    };
  }

  private async debitConstructionCost(
    client: pg.PoolClient,
    playerId: string,
    requestId: string,
    kingdomId: string,
    entityType: "seat" | "cot" | "decoration",
    entityId: string,
    quote: KingdomConstructionQuote
  ): Promise<void> {
    if (quote.freeConstruction || quote.adjustedCost.length === 0) return;
    try {
      await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: durableOperationKey(`kingdom-construction-${entityType}`, playerId, requestId),
        playerId,
        source: "kingdom_construction",
        sourceEntityType: entityType,
        sourceEntityId: entityId,
        metadata: { kingdomId, requestId, quote },
        debits: quote.adjustedCost.map((line) => ({
          itemId: requireItemDefinition(line.resourceType).itemId,
          variant: DEFAULT_INVENTORY_VARIANT,
          quantity: line.quantity
        }))
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Inventory does not contain enough items") {
        throw new KingdomError(
          "KINGDOM_CONSTRUCTION_INSUFFICIENT_RESOURCES",
          "The player does not have the resources required for this construction"
        );
      }
      throw error;
    }
  }

  async invitePlayer(actorId: string, input: KingdomInviteInput): Promise<KingdomInviteResult> {
    if (actorId === input.targetPlayerId) {
      throw new KingdomError("KINGDOM_VALIDATION_FAILED", "A player cannot invite themselves");
    }
    const mutation = await this.mutate(actorId, input.requestId, "invite", input, async (client) => {
      const actor = await lockActorContext(client, actorId, "invite_members");
      await expireRelevantInvitations(client, this.now(), input.targetPlayerId, actor.kingdomId);
      if (await activeMemberCount(client, actor.kingdomId) >= kingdomLevelForState(actor.level, actor.lifetimeXp).memberCapacity) {
        throw new KingdomError("KINGDOM_MEMBER_CAPACITY_REACHED", "The Kingdom has reached its member capacity");
      }
      await requirePlayer(client, input.targetPlayerId);
      const targetMembership = await client.query(
        "SELECT id FROM kingdom_memberships WHERE player_id = $1 AND status = 'active' LIMIT 1",
        [input.targetPlayerId]
      );
      if (targetMembership.rowCount) {
        throw new KingdomError("KINGDOM_ALREADY_MEMBER", "The invited player already belongs to a Kingdom");
      }
      if (await isBanned(client, actor.kingdomId, input.targetPlayerId)) {
        throw new KingdomError("KINGDOM_MEMBER_BANNED", "The invited player is banned from this Kingdom");
      }
      const pending = await client.query(
        `SELECT id FROM kingdom_invitations
         WHERE kingdom_id = $1 AND target_player_id = $2 AND status = 'pending' LIMIT 1`,
        [actor.kingdomId, input.targetPlayerId]
      );
      if (pending.rowCount) {
        throw new KingdomError("KINGDOM_INVITATION_EXISTS", "A pending invitation already exists");
      }
      const invitationId = randomUUID();
      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + this.settings.invitationTtlSeconds * 1_000);
      await client.query(
        `INSERT INTO kingdom_invitations (
           id, kingdom_id, target_player_id, invited_by_player_id, request_id, expires_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invitationId, actor.kingdomId, input.targetPlayerId, actorId, input.requestId, expiresAt, createdAt]
      );
      await insertAudit(client, actor.kingdomId, actorId, input.targetPlayerId, "member_invited", "invitation", invitationId);
      await enqueueNativePush(client, { enabled: this.pushEnqueueEnabled, audience:this.pushAudience, kind: "kingdom_invite", playerId: input.targetPlayerId, sourceId: invitationId, eventKey: `kingdom:${invitationId}`, expiresAt });
      return {
        kingdomId: actor.kingdomId,
        targetPlayerId: input.targetPlayerId,
        notificationPlayerIds: await loadInvitationAudience(
          client,
          [actor.kingdomId],
          [actorId, input.targetPlayerId]
        )
      };
    }, (value) => ({ kingdomId: value.kingdomId, targetPlayerId: value.targetPlayerId }));
    return {
      ...(await this.stateAfterCommit(actorId, "invite")),
      targetPlayerId: mutation.value.targetPlayerId,
      replayed: mutation.replayed,
      notificationPlayerIds: mutation.replayed ? [] : mutation.value.notificationPlayerIds
    };
  }

  async respondToInvitation(
    actorId: string,
    input: KingdomInvitationResponseInput
  ): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, input.requestId, "respond_invitation", input, async (client) => {
      const hint = await client.query<{ kingdom_id: string; target_player_id: string }>(
        "SELECT kingdom_id, target_player_id FROM kingdom_invitations WHERE id = $1",
        [input.invitationId]
      );
      if (!hint.rows[0] || hint.rows[0].target_player_id !== actorId) {
        throw new KingdomError("KINGDOM_INVITATION_NOT_FOUND", "Pending Kingdom invitation not found");
      }
      const kingdom = await lockKingdom(client, hint.rows[0].kingdom_id);
      await client.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [actorId]);
      const invitationResult = await client.query<InvitationLockRow>(
        `SELECT i.id, i.kingdom_id, i.target_player_id, i.invited_by_player_id,
                i.status, i.expires_at
         FROM kingdom_invitations i WHERE i.id = $1 FOR UPDATE`,
        [input.invitationId]
      );
      const invitation = invitationResult.rows[0];
      if (!invitation || invitation.target_player_id !== actorId || invitation.status !== "pending") {
        throw new KingdomError("KINGDOM_INVITATION_NOT_FOUND", "Pending Kingdom invitation not found");
      }
      if (asDate(invitation.expires_at).getTime() <= this.now().getTime()) {
        throw new KingdomError("KINGDOM_INVITATION_EXPIRED", "Kingdom invitation has expired");
      }
      if (input.response === "decline") {
        await client.query(
          "UPDATE kingdom_invitations SET status = 'declined', responded_at = $2 WHERE id = $1",
          [invitation.id, this.now()]
        );
        await insertAudit(client, invitation.kingdom_id, actorId, actorId, "invitation_declined", "invitation", invitation.id);
        return {
          kingdomId: invitation.kingdom_id,
          notificationPlayerIds: await loadInvitationAudience(
            client,
            [invitation.kingdom_id],
            [actorId, invitation.invited_by_player_id]
          )
        };
      }

      if (kingdom.status !== "active") {
        throw new KingdomError("KINGDOM_INACTIVE", "The inviting Kingdom is no longer active");
      }
      const active = await client.query(
        "SELECT id FROM kingdom_memberships WHERE player_id = $1 AND status = 'active' LIMIT 1 FOR UPDATE",
        [actorId]
      );
      if (active.rowCount) {
        throw new KingdomError("KINGDOM_ALREADY_MEMBER", "A player may belong to only one active Kingdom");
      }
      if (await isBanned(client, invitation.kingdom_id, actorId)) {
        throw new KingdomError("KINGDOM_MEMBER_BANNED", "This player is banned from the Kingdom");
      }
      const count = await activeMemberCount(client, invitation.kingdom_id);
      if (count >= kingdomLevelForState(kingdom.level, Number(kingdom.lifetime_xp)).memberCapacity) {
        throw new KingdomError("KINGDOM_MEMBER_CAPACITY_REACHED", "The Kingdom has reached its member capacity");
      }
      const previousKingdom = await loadPublicKingdom(client, invitation.kingdom_id);
      const now = this.now();
      await client.query(
        `INSERT INTO kingdom_memberships (
           id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
         ) VALUES ($1,$2,$3,'member','active',$4,$5)`,
        [randomUUID(), invitation.kingdom_id, actorId, now,
          new Date(now.getTime() + this.settings.perkQualificationSeconds * 1_000)]
      );
      await client.query(
        "UPDATE kingdom_invitations SET status = 'accepted', responded_at = $2 WHERE id = $1",
        [invitation.id, now]
      );
      await client.query(
        `UPDATE kingdom_invitations SET status = 'expired', responded_at = $2
         WHERE target_player_id = $1 AND status = 'pending' AND id <> $3
           AND expires_at <= $2`,
        [actorId, now, invitation.id]
      );
      const revoked = await client.query<{
        kingdom_id: string;
        invited_by_player_id: string;
      }>(
        `UPDATE kingdom_invitations SET status = 'revoked', responded_at = $2
         WHERE target_player_id = $1 AND status = 'pending' AND id <> $3
           AND expires_at > $2
         RETURNING kingdom_id, invited_by_player_id`,
        [actorId, now, invitation.id]
      );
      await insertAudit(client, invitation.kingdom_id, actorId, actorId, "invitation_accepted", "invitation", invitation.id);
      await bumpKingdomSpatialRevision(client, invitation.kingdom_id);
      const currentKingdom = await loadPublicKingdom(client, invitation.kingdom_id);
      return {
        kingdomId: invitation.kingdom_id,
        spatialChanges: previousKingdom && currentKingdom
          ? [spatialUpsertChange(spatialSeatEntity(previousKingdom), spatialSeatEntity(currentKingdom))]
          : [],
        notificationPlayerIds: await loadInvitationAudience(
          client,
          [invitation.kingdom_id, ...revoked.rows.map((row) => row.kingdom_id)],
          [actorId, invitation.invited_by_player_id,
            ...revoked.rows.map((row) => row.invited_by_player_id)]
        )
      };
    }, (value) => ({ kingdomId: value.kingdomId }));
    return {
      ...(await this.stateAfterCommit(actorId, "respond invitation")),
      replayed: mutation.replayed,
      spatialChanges: mutation.replayed ? [] : mutation.value.spatialChanges ?? [],
      notificationPlayerIds: mutation.replayed ? [] : mutation.value.notificationPlayerIds
    };
  }

  async cancelInvitation(
    actorId: string,
    input: KingdomCancelInvitationInput
  ): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, input.requestId, "cancel_invitation", input, async (client) => {
      const actor = await lockActorContext(client, actorId, "cancel_invitations");
      const invitation = await client.query<{
        id: string;
        target_player_id: string;
        invited_by_player_id: string;
      }>(
        `SELECT id, target_player_id, invited_by_player_id FROM kingdom_invitations
         WHERE id = $1 AND kingdom_id = $2 AND status = 'pending' FOR UPDATE`,
        [input.invitationId, actor.kingdomId]
      );
      const row = invitation.rows[0];
      if (!row) throw new KingdomError("KINGDOM_INVITATION_NOT_FOUND", "Pending Kingdom invitation not found");
      await client.query(
        "UPDATE kingdom_invitations SET status = 'cancelled', responded_at = $2 WHERE id = $1",
        [row.id, this.now()]
      );
      await insertAudit(client, actor.kingdomId, actorId, row.target_player_id, "invitation_cancelled", "invitation", row.id);
      return {
        kingdomId: actor.kingdomId,
        notificationPlayerIds: await loadInvitationAudience(
          client,
          [actor.kingdomId],
          [row.target_player_id, row.invited_by_player_id]
        )
      };
    }, (value) => ({ kingdomId: value.kingdomId }));
    return {
      ...(await this.stateAfterCommit(actorId, "cancel invitation")),
      replayed: mutation.replayed,
      notificationPlayerIds: mutation.replayed ? [] : mutation.value.notificationPlayerIds
    };
  }

  async memberAction(actorId: string, input: KingdomMemberActionInput): Promise<KingdomMutationResult> {
    if (actorId === input.targetPlayerId) {
      throw new KingdomError("KINGDOM_PERMISSION_DENIED", "Use the dedicated leave or leadership-transfer action");
    }
    const mutation = await this.mutate(actorId, input.requestId, `member_${input.action}`, input, async (client) => {
      const permission = permissionForMemberAction(input.action);
      const actor = await lockActorContext(client, actorId, permission);
      if (input.action === "unban") {
        const banned = await client.query<{ id: string }>(
          `SELECT id FROM kingdom_memberships
           WHERE kingdom_id = $1 AND player_id = $2 AND status = 'banned'
           ORDER BY ended_at DESC LIMIT 1 FOR UPDATE`,
          [actor.kingdomId, input.targetPlayerId]
        );
        const ban = banned.rows[0];
        if (!ban) throw new KingdomError("KINGDOM_MEMBER_NOT_FOUND", "No active ban exists for this player");
        await client.query(
          "UPDATE kingdom_memberships SET status = 'removed', end_reason = 'unbanned', ended_by_player_id = $2 WHERE id = $1",
          [ban.id, actorId]
        );
        await insertAudit(client, actor.kingdomId, actorId, input.targetPlayerId, "member_unbanned");
        return { kingdomId: actor.kingdomId };
      }

      const target = await lockMember(client, actor.kingdomId, input.targetPlayerId);
      if (!target) throw new KingdomError("KINGDOM_MEMBER_NOT_FOUND", "Active Kingdom member not found");
      if (target.role === "leader" && input.action !== "transfer_leadership") {
        throw new KingdomError("KINGDOM_LEADER_PROTECTED", "The Kingdom leader cannot be removed, banned, or demoted");
      }
      assertRoleAuthority(actor.role, target.role, input.action);
      if (input.action === "transfer_leadership") {
        if (actor.role !== "leader") {
          throw new KingdomError("KINGDOM_PERMISSION_DENIED", "Only the leader may transfer leadership");
        }
        await client.query("UPDATE kingdom_memberships SET role = 'officer' WHERE id = $1", [actor.membershipId]);
        await client.query("UPDATE kingdom_memberships SET role = 'leader' WHERE id = $1", [target.id]);
        const previousKingdom = await loadPublicKingdom(client, actor.kingdomId);
        await client.query(
          `UPDATE kingdoms SET leader_player_id = $2,
             spatial_revision = nextval('kingdom_spatial_revision_seq') WHERE id = $1`,
          [actor.kingdomId, input.targetPlayerId]
        );
        await insertAudit(client, actor.kingdomId, actorId, input.targetPlayerId, "leadership_transferred");
        const currentKingdom = await loadPublicKingdom(client, actor.kingdomId);
        return {
          kingdomId: actor.kingdomId,
          spatialChanges: previousKingdom && currentKingdom
            ? [spatialUpsertChange(spatialSeatEntity(previousKingdom), spatialSeatEntity(currentKingdom))]
            : []
        };
      }
      if (input.action === "promote" || input.action === "demote") {
        const nextRole: KingdomRole = input.action === "promote" ? "officer" : "member";
        if (target.role === nextRole) return { kingdomId: actor.kingdomId };
        await client.query("UPDATE kingdom_memberships SET role = $2 WHERE id = $1", [target.id, nextRole]);
        await insertAudit(client, actor.kingdomId, actorId, input.targetPlayerId, `member_${input.action}`);
        return { kingdomId: actor.kingdomId };
      }
      const previousKingdom = await loadPublicKingdom(client, actor.kingdomId);
      const objectChanges = await closeMembershipAndObjects(
        client,
        actor.kingdomId,
        target.id,
        input.targetPlayerId,
        input.action === "ban" ? "banned" : "removed",
        actorId,
        input.action
      );
      await bumpKingdomSpatialRevision(client, actor.kingdomId);
      const currentKingdom = await loadPublicKingdom(client, actor.kingdomId);
      await insertAudit(client, actor.kingdomId, actorId, input.targetPlayerId, `member_${input.action}`);
      return {
        kingdomId: actor.kingdomId,
        affectedFlagIds: [],
        notificationPlayerIds: [],
        spatialChanges: [
          ...objectChanges,
          ...(previousKingdom && currentKingdom
            ? [spatialUpsertChange(spatialSeatEntity(previousKingdom), spatialSeatEntity(currentKingdom))]
            : [])
        ]
      };
    });
    return {
      ...(await this.stateAfterCommit(actorId, `member ${input.action}`)),
      replayed: mutation.replayed,
      spatialChanges: mutation.replayed ? [] : mutation.value.spatialChanges ?? [],
      affectedFlagIds: mutation.replayed ? [] : mutation.value.affectedFlagIds as string[] ?? [],
      notificationPlayerIds: mutation.replayed ? [] : mutation.value.notificationPlayerIds as string[] ?? []
    };
  }

  async leaveKingdom(actorId: string, requestId: string): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, requestId, "leave", { requestId }, async (client) => {
      const actor = await lockActorContext(client, actorId);
      if (actor.role === "leader") {
        throw new KingdomError(
          "KINGDOM_LEADERSHIP_TRANSFER_REQUIRED",
          "The leader must transfer leadership or dissolve the Kingdom before leaving"
        );
      }
      const previousKingdom = await loadPublicKingdom(client, actor.kingdomId);
      const objectChanges = await closeMembershipAndObjects(
        client, actor.kingdomId, actor.membershipId, actorId, "left", actorId, "left"
      );
      await bumpKingdomSpatialRevision(client, actor.kingdomId);
      const currentKingdom = await loadPublicKingdom(client, actor.kingdomId);
      await insertAudit(client, actor.kingdomId, actorId, actorId, "member_left");
      return {
        kingdomId: actor.kingdomId,
        affectedFlagIds: [],
        notificationPlayerIds: [],
        spatialChanges: [
          ...objectChanges,
          ...(previousKingdom && currentKingdom
            ? [spatialUpsertChange(spatialSeatEntity(previousKingdom), spatialSeatEntity(currentKingdom))]
            : [])
        ]
      };
    });
    return {
      ...(await this.stateAfterCommit(actorId, "leave")),
      replayed: mutation.replayed,
      spatialChanges: mutation.replayed ? [] : mutation.value.spatialChanges,
      affectedFlagIds: mutation.replayed ? [] : (mutation.value.affectedFlagIds as string[] | undefined) ?? [],
      notificationPlayerIds: mutation.replayed ? [] : (mutation.value.notificationPlayerIds as string[] | undefined) ?? []
    };
  }

  async updateIdentity(actorId: string, input: KingdomIdentityInput): Promise<KingdomMutationResult> {
    const description = input.description === undefined ? undefined : normalizeDescription(input.description);
    const emblemKey = input.emblemKey === undefined ? undefined : normalizeEmblem(input.emblemKey);
    const displayColor = input.displayColor === undefined ? undefined : normalizeKingdomColor(input.displayColor);
    if (description === undefined && emblemKey === undefined && displayColor === undefined) {
      throw new KingdomError("KINGDOM_VALIDATION_FAILED", "At least one Kingdom identity field is required");
    }
    const payload = { ...input, description, emblemKey, displayColor };
    const mutation = await this.mutate(actorId, input.requestId, "update_identity", payload, async (client) => {
      const actor = await lockActorContext(client, actorId, "manage_identity");
      const previousKingdom = await loadPublicKingdom(client, actor.kingdomId);
      await client.query(
        `UPDATE kingdoms SET
           description = CASE WHEN $2::boolean THEN $3::text ELSE description END,
           emblem_key = CASE WHEN $4::boolean THEN $5::text ELSE emblem_key END,
           display_color = CASE WHEN $6::boolean THEN $7::text ELSE display_color END
         WHERE id = $1`,
        [actor.kingdomId, description !== undefined, description ?? null, emblemKey !== undefined, emblemKey ?? null,
          displayColor !== undefined, displayColor ?? null]
      );
      await bumpKingdomSpatialRevision(client, actor.kingdomId);
      await insertAudit(client, actor.kingdomId, actorId, null, "kingdom_identity_updated", null, null, {
        fields: [description !== undefined ? "description" : null, emblemKey !== undefined ? "emblem" : null,
          displayColor !== undefined ? "display_color" : null].filter(Boolean)
      });
      const affectedFlagIds = displayColor === undefined
        ? []
        : (await client.query<{ id: string }>(
            `SELECT id FROM flags
             WHERE kingdom_id = $1 AND control_type = 'kingdom'
             ORDER BY id`,
            [actor.kingdomId]
          )).rows.map(({ id }) => id);
      const currentKingdom = await loadPublicKingdom(client, actor.kingdomId);
      return {
        kingdomId: actor.kingdomId,
        affectedFlagIds,
        spatialChanges: previousKingdom && currentKingdom
          ? [spatialUpsertChange(spatialSeatEntity(previousKingdom), spatialSeatEntity(currentKingdom))]
          : []
      };
    }, (value) => ({ kingdomId: value.kingdomId }));
    return {
      ...(await this.stateAfterCommit(actorId, "identity")),
      replayed: mutation.replayed,
      spatialChanges: mutation.replayed ? [] : mutation.value.spatialChanges,
      affectedFlagIds: mutation.replayed ? [] : mutation.value.affectedFlagIds as string[]
    };
  }

  async muteMember(actorId: string, input: KingdomMuteInput): Promise<KingdomMutationResult> {
    if (actorId === input.targetPlayerId) {
      throw new KingdomError("KINGDOM_PERMISSION_DENIED", "A moderator cannot mute themselves");
    }
    const mutedUntil = input.action === "mute" && input.mutedUntil
      ? new Date(input.mutedUntil)
      : null;
    if (mutedUntil && (!Number.isFinite(mutedUntil.getTime()) || mutedUntil.getTime() <= this.now().getTime())) {
      throw new KingdomError("KINGDOM_VALIDATION_FAILED", "Chat mute expiry must be in the future");
    }
    const mutation = await this.mutate(actorId, input.requestId, "mute_chat", input, async (client) => {
      const actor = await lockActorContext(client, actorId, "mute_chat");
      const target = await lockMember(client, actor.kingdomId, input.targetPlayerId);
      if (!target) throw new KingdomError("KINGDOM_MEMBER_NOT_FOUND", "Active Kingdom member not found");
      if (!canModerateKingdomRole(actor.role, target.role, false)) {
        throw new KingdomError("KINGDOM_PERMISSION_DENIED", "The actor cannot mute an equal or higher Kingdom role");
      }
      if (input.action === "unmute") {
        await client.query(
          "DELETE FROM kingdom_chat_mutes WHERE kingdom_id = $1 AND player_id = $2",
          [actor.kingdomId, input.targetPlayerId]
        );
      } else {
        await client.query(
          `INSERT INTO kingdom_chat_mutes (kingdom_id, player_id, muted_by_player_id, muted_until)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (kingdom_id, player_id) DO UPDATE SET
             muted_by_player_id = EXCLUDED.muted_by_player_id,
             muted_until = EXCLUDED.muted_until,
             updated_at = now()`,
          [actor.kingdomId, input.targetPlayerId, actorId, mutedUntil]
        );
      }
      await insertAudit(client, actor.kingdomId, actorId, input.targetPlayerId,
        input.action === "mute" ? "chat_muted" : "chat_unmuted", null, null,
        input.action === "mute" ? { mutedUntil: mutedUntil?.toISOString() ?? null } : {});
      return { kingdomId: actor.kingdomId };
    });
    return { ...(await this.stateAfterCommit(actorId, "mute")), replayed: mutation.replayed };
  }

  async donate(actorId: string, input: KingdomDonationInput): Promise<KingdomMutationResult> {
    if (input.resourceType === BRICKS_ITEM_ID) {
      // Bricks always go through the taxed deposit.
      throw new KingdomError("KINGDOM_DONATION_USE_BRICK_DEPOSIT", "Deposit Bricks from the Bricks section");
    }
    if (isShopCopyItemId(input.resourceType)) {
      // Tagged shop copies keep their tag and buyer; a treasury would swallow them anonymously.
      throw new KingdomError("KINGDOM_DONATION_INVALID", "Masks and Manor skins cannot be donated to a kingdom");
    }
    const item = requireItemDefinition(input.resourceType);
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0 || input.quantity > 1_000_000) {
      throw new KingdomError("KINGDOM_DONATION_INVALID", "Donation quantity must be a positive whole number");
    }
    const variant = normalizeVariant(input.variant);
    const payload = { ...input, resourceType: item.itemId, variant };
    const mutation = await this.mutate(actorId, input.requestId, "donate", payload, async (client) => {
      const actor = await lockActorContext(client, actorId);
      const stack = await client.query<{ quantity: number; version: string | number }>(
        `SELECT quantity, version FROM player_inventory
         WHERE player_id = $1 AND resource_type = $2 AND variant = $3 FOR UPDATE`,
        [actorId, item.itemId, variant]
      );
      const playerBefore = Number(stack.rows[0]?.quantity ?? 0);
      if (playerBefore < input.quantity) {
        throw new KingdomError(
          "KINGDOM_DONATION_INSUFFICIENT_BALANCE",
          "Donation exceeds the player's available inventory",
          { available: playerBefore }
        );
      }
      const operationKey = durableOperationKey("kingdom-donation", actorId, input.requestId);
      let inventoryResult: InventoryOperationResult;
      try {
        inventoryResult = await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey,
          playerId: actorId,
          source: "kingdom_donation",
          sourceEntityType: "kingdom",
          sourceEntityId: actor.kingdomId,
          metadata: {
            requestId: input.requestId,
            resourceType: item.itemId,
            variant,
            quantity: input.quantity
          },
          debits: [{ itemId: item.itemId, variant, quantity: input.quantity }]
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Inventory does not contain enough items") {
          throw new KingdomError(
            "KINGDOM_DONATION_INSUFFICIENT_BALANCE",
            "Donation exceeds available inventory"
          );
        }
        throw error;
      }
      const playerAfter = inventoryResult.inventory.items
        .filter((entry) =>
          entry.resourceType === item.itemId
          && (entry.variant ?? DEFAULT_INVENTORY_VARIANT) === variant
        )
        .reduce((total, entry) => total + entry.quantity, 0);
      await client.query(
        `INSERT INTO kingdom_treasury_balances (kingdom_id, resource_type, variant, quantity)
         VALUES ($1,$2,$3,0) ON CONFLICT (kingdom_id, resource_type, variant) DO NOTHING`,
        [actor.kingdomId, item.itemId, variant]
      );
      const treasury = await client.query<{ quantity: string | number }>(
        `SELECT quantity FROM kingdom_treasury_balances
         WHERE kingdom_id = $1 AND resource_type = $2 AND variant = $3 FOR UPDATE`,
        [actor.kingdomId, item.itemId, variant]
      );
      const treasuryBefore = Number(treasury.rows[0]?.quantity ?? 0);
      const treasuryAfter = treasuryBefore + input.quantity;
      await client.query(
        `UPDATE kingdom_treasury_balances SET quantity = $4, updated_at = now()
         WHERE kingdom_id = $1 AND resource_type = $2 AND variant = $3`,
        [actor.kingdomId, item.itemId, variant, treasuryAfter]
      );
      const donationId = randomUUID();
      await client.query(
        `INSERT INTO kingdom_donations (
           id, kingdom_id, donor_player_id, request_id, resource_type, variant, quantity,
           player_balance_before, player_balance_after, treasury_balance_before,
           treasury_balance_after, kingdom_xp_granted
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [donationId, actor.kingdomId, actorId, input.requestId, item.itemId, variant,
          input.quantity, playerBefore, playerAfter, treasuryBefore, treasuryAfter, 0]
      );
      await insertAudit(client, actor.kingdomId, actorId, actorId, "treasury_donated", "donation", donationId, {
        resourceType: item.itemId,
        variant,
        quantity: input.quantity,
        xpGranted: 0
      });
      return {
        kingdomId: actor.kingdomId,
        donationId,
        spatialChanges: []
      };
    });
    return {
      ...(await this.stateAfterCommit(actorId, "donate")),
      replayed: mutation.replayed,
      spatialChanges: mutation.replayed ? [] : mutation.value.spatialChanges
    };
  }

  /** Deposits carried Bricks into the treasury, destroying the 12% tax. */
  async depositBricks(actorId: string, input: KingdomBrickDepositInput): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, input.requestId, "deposit_bricks", input, async (client) => {
      const actor = await lockActorContext(client, actorId);
      const deposit = await mapBrickEconomyError(() =>
        depositBricksInTransaction(client, this.inventory, actor, input));
      return { kingdomId: actor.kingdomId, ...deposit };
    });
    return { ...(await this.stateAfterCommit(actorId, "deposit_bricks")), replayed: mutation.replayed };
  }

  /** Any member but the leader starts a revolt vote against the leader (and votes yes). */
  async startRevolt(actorId: string, requestId: string): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, requestId, "revolt_start", { requestId }, async (client) => {
      const actor = await lockActorContext(client, actorId);
      const started = await mapRevoltError(() => startKingdomRevoltInTransaction(client, actor, this.now()));
      return { kingdomId: actor.kingdomId, ...started };
    });
    return { ...(await this.stateAfterCommit(actorId, "revolt_start")), replayed: mutation.replayed };
  }

  /** One vote per member per revolt; the leader cannot vote. */
  async voteRevolt(actorId: string, input: KingdomRevoltVoteInput): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, input.requestId, "revolt_vote", input, async (client) => {
      const actor = await lockActorContext(client, actorId);
      const voted = await mapRevoltError(() => castKingdomRevoltVoteInTransaction(client, actor, input, this.now()));
      return { kingdomId: actor.kingdomId, ...voted };
    });
    return { ...(await this.stateAfterCommit(actorId, "revolt_vote")), replayed: mutation.replayed };
  }

  /**
   * Settles revolt work (a vote that passed, expired or lost its target; an
   * anarchy that ended), each kingdom in its own transaction under the
   * kingdom row lock. Without ids, every kingdom with an open vote or a due
   * anarchy. Returns the kingdoms that changed.
   */
  async settleRevolts(kingdomIds?: readonly string[]): Promise<string[]> {
    const ids = kingdomIds ?? await kingdomsWithRevoltWork(this.pool, this.now());
    const changed: string[] = [];
    for (const kingdomId of ids) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query("SELECT id FROM kingdoms WHERE id = $1::uuid FOR UPDATE", [kingdomId]);
        const didChange = locked.rowCount
          ? await settleKingdomRevoltInTransaction(client, kingdomId, this.now())
          : false;
        await client.query("COMMIT");
        if (didChange) changed.push(kingdomId);
      } catch (error) {
        await client.query("ROLLBACK");
        this.logger.warn({ err: error, kingdomId }, "kingdom revolt settlement failed");
      } finally {
        client.release();
      }
    }
    return changed;
  }

  /** Active members of the given kingdoms, for state-change notifications. */
  async activeMemberIds(kingdomIds: readonly string[]): Promise<string[]> {
    if (kingdomIds.length === 0) return [];
    const result = await this.pool.query<{ player_id: string }>(
      "SELECT player_id FROM kingdom_memberships WHERE kingdom_id = ANY($1::uuid[]) AND status = 'active'",
      [kingdomIds]
    );
    return result.rows.map((row) => row.player_id);
  }

  /** Builds or upgrades the Brick Furnace (build permission: the leader). */
  async upgradeBrickFurnace(actorId: string, input: KingdomBrickFurnaceUpgradeInput): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, input.requestId, "upgrade_brick_furnace", input, async (client) => {
      const actor = await lockActorContext(client, actorId, "build_kingdom_structures");
      assertCastleStanding(actor.castleRuinedAt);
      const upgrade = await mapBrickEconomyError(() =>
        upgradeBrickFurnaceInTransaction(client, this.inventory, actor, input));
      return { kingdomId: actor.kingdomId, ...upgrade };
    });
    return { ...(await this.stateAfterCommit(actorId, "upgrade_brick_furnace")), replayed: mutation.replayed };
  }

  /** Builds or upgrades the Command Board (build permission: the leader). */
  async upgradeCommandBoard(actorId: string, input: KingdomCommandBoardUpgradeInput): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, input.requestId, "upgrade_command_board", input, async (client) => {
      const actor = await lockActorContext(client, actorId, "build_kingdom_structures");
      assertCastleStanding(actor.castleRuinedAt);
      const upgrade = await mapBrickEconomyError(() =>
        upgradeKingdomCommandBoardInTransaction(client, this.inventory, actor, input));
      return { kingdomId: actor.kingdomId, ...upgrade };
    });
    return { ...(await this.stateAfterCommit(actorId, "upgrade_command_board")), replayed: mutation.replayed };
  }

  /**
   * Takes the Brick Furnace or Command Board down one level and refunds 45% of
   * that step's materials to the treasury (build permission: the leader).
   * Kingdom Towers and Obelisks downgrade through FlagService (flag row lock).
   */
  async downgradeKingdomFacility(
    actorId: string,
    input: KingdomStructureDowngradeInput
  ): Promise<KingdomMutationResult> {
    const structure = input.structure;
    if (structure !== "brick_furnace" && structure !== "command_board") {
      throw new KingdomError("KINGDOM_VALIDATION_FAILED", "Only the Brick Furnace or Command Board downgrades here");
    }
    const mutation = await this.mutate(actorId, input.requestId, "downgrade_structure", input, async (client) => {
      const actor = await lockActorContext(client, actorId, "build_kingdom_structures");
      const downgraded = await mapBrickEconomyError(() => structure === "brick_furnace"
        ? downgradeBrickFurnaceInTransaction(client, actor, input)
        : downgradeKingdomCommandBoardInTransaction(client, actor, input));
      return { kingdomId: actor.kingdomId, structure, ...downgraded };
    });
    return { ...(await this.stateAfterCommit(actorId, "downgrade_structure")), replayed: mutation.replayed };
  }

  /** Any member buys the furnace's brick package once per kingdom every 20 hours. */
  async buyBrickFurnacePackage(
    actorId: string,
    input: KingdomBrickFurnacePackageInput
  ): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, input.requestId, "buy_brick_furnace_package", input, async (client) => {
      const actor = await lockActorContext(client, actorId);
      const bought = await mapBrickEconomyError(() =>
        buyBrickFurnacePackageInTransaction(client, this.inventory, actor, input, this.now()));
      return { kingdomId: actor.kingdomId, ...bought };
    });
    return { ...(await this.stateAfterCommit(actorId, "buy_brick_furnace_package")), replayed: mutation.replayed };
  }

  /** Chooses or changes one level's perk from the treasury (leader only). */
  async chooseKingdomPerk(actorId: string, input: KingdomPerkChooseInput): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, input.requestId, "choose_kingdom_perk", input, async (client) => {
      const actor = await lockActorContext(client, actorId, "manage_perks");
      const chosen = await mapBrickEconomyError(() => chooseKingdomPerkInTransaction(client, {
        playerId: actorId,
        kingdomId: actor.kingdomId,
        kingdomLevel: kingdomLevelForState(actor.level, actor.lifetimeXp).level
      }, input));
      return { kingdomId: actor.kingdomId, ...chosen };
    });
    return { ...(await this.stateAfterCommit(actorId, "choose_kingdom_perk")), replayed: mutation.replayed };
  }

  /** Starts the chosen level 6 perk's 24 h member buff (leader only, once per 24 h). */
  async activateKingdomPerk(actorId: string, input: KingdomPerkActivateInput): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, input.requestId, "activate_kingdom_perk", input, async (client) => {
      const actor = await lockActorContext(client, actorId, "manage_perks");
      assertCastleStanding(actor.castleRuinedAt);
      const activated = await mapBrickEconomyError(() => activateKingdomPerkInTransaction(client, {
        playerId: actorId,
        kingdomId: actor.kingdomId,
        kingdomLevel: kingdomLevelForState(actor.level, actor.lifetimeXp).level
      }, input, this.now()));
      return { kingdomId: actor.kingdomId, ...activated };
    });
    return { ...(await this.stateAfterCommit(actorId, "activate_kingdom_perk")), replayed: mutation.replayed };
  }

  /**
   * Advancement projects are retired: kingdom levels now come only from member XP
   *. The route stays so an old client gets a clear refusal.
   */
  async startAdvancementProject(
    actorId: string,
    input: KingdomAdvancementProjectStartInput
  ): Promise<KingdomMutationResult> {
    throw new KingdomError(
      "KINGDOM_ADVANCEMENT_RETIRED",
      "Kingdoms now level up from the XP their members earn; advancement projects are retired",
      { targetLevel: input.targetLevel }
    );
  }

  async cancelAdvancementProject(
    actorId: string,
    input: KingdomAdvancementProjectCancelInput
  ): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(
      actorId,
      input.requestId,
      "cancel_advancement_project",
      input,
      async (client) => {
        const membership = await lockAdvancementMembership(client, actorId);
        await completeDueKingdomProjectsInTransaction(client, membership.kingdomId, this.now());
        const projectResult = await client.query<KingdomProjectRow>(
          `SELECT id, kingdom_id, project_type, rules_version, target_level, status,
                  actor_player_id, cost_snapshot, xp_snapshot, started_at, completes_at,
                  completed_at, cancelled_at, failed_at, failure_code
           FROM kingdom_projects
           WHERE id = $1 AND kingdom_id = $2 FOR UPDATE`,
          [input.projectId, membership.kingdomId]
        );
        const project = projectResult.rows[0];
        if (!project) {
          throw new KingdomError(
            "KINGDOM_ADVANCEMENT_PROJECT_NOT_FOUND",
            "Kingdom advancement project not found"
          );
        }
        if (project.status !== "pending") {
          throw new KingdomError(
            project.status === "completed"
              ? "KINGDOM_ADVANCEMENT_COMPLETION_PROCESSED"
              : "KINGDOM_ADVANCEMENT_PROJECT_NOT_PENDING",
            project.status === "completed"
              ? "This advancement project has already completed"
              : "This advancement project is no longer pending"
          );
        }
        const definition = KINGDOM_ADVANCEMENT_PROJECTS[
          Number(project.target_level) as KingdomAdvancementTargetLevel
        ];
        const cost = parseProjectCost(project.cost_snapshot);
        const cancelledAt = this.now();
        await refundProjectCost(client, {
          kingdomId: membership.kingdomId,
          projectId: project.id,
          actorId,
          requestId: input.requestId,
          sourceType: "project_cancel",
          projectName: definition.displayName,
          targetLevel: definition.targetLevel,
          cost
        });
        const changed = await client.query(
          `UPDATE kingdom_projects
           SET status = 'cancelled', cancelled_at = $2
           WHERE id = $1 AND status = 'pending'`,
          [project.id, cancelledAt]
        );
        if (changed.rowCount !== 1) {
          throw new KingdomError(
            "KINGDOM_ADVANCEMENT_PROJECT_STATE_CHANGED",
            "The advancement project changed while cancellation was being confirmed"
          );
        }
        await insertAudit(
          client,
          membership.kingdomId,
          actorId,
          null,
          "advancement_project_cancelled",
          "project",
          project.id,
          { projectName: definition.displayName, targetLevel: definition.targetLevel }
        );
        return {
          kingdomId: membership.kingdomId,
          projectId: project.id,
          notificationPlayerIds: await loadActiveKingdomPlayerIds(client, membership.kingdomId)
        };
      },
      (value) => ({ kingdomId: value.kingdomId, projectId: value.projectId }),
      "serializable"
    );
    return {
      ...(await this.stateAfterCommit(actorId, "cancel advancement project")),
      replayed: mutation.replayed,
      notificationPlayerIds: mutation.replayed ? [] : mutation.value.notificationPlayerIds
    };
  }

  async sendChat(actorId: string, input: KingdomChatInput): Promise<KingdomChatResult> {
    const content = normalizeChat(input.content);
    const payload = { requestId: input.requestId, content };
    const mutation = await this.mutate(actorId, input.requestId, "chat_send", payload, async (client) => {
      const actor = await lockActorContext(client, actorId);
      const mute = await client.query<{ muted_until: Date | string | null }>(
        `SELECT muted_until FROM kingdom_chat_mutes
         WHERE kingdom_id = $1 AND player_id = $2 FOR UPDATE`,
        [actor.kingdomId, actorId]
      );
      const mutedUntil = mute.rows[0]?.muted_until;
      if (mutedUntil === null && mute.rowCount) {
        throw new KingdomError("KINGDOM_CHAT_MUTED", "Kingdom chat is muted for this player");
      }
      if (mutedUntil && asDate(mutedUntil).getTime() > this.now().getTime()) {
        throw new KingdomError("KINGDOM_CHAT_MUTED", "Kingdom chat is muted for this player", {
          mutedUntil: asDate(mutedUntil).toISOString()
        });
      }
      const recent = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM kingdom_chat_messages
         WHERE sender_player_id = $1 AND created_at > $2`,
        [actorId, new Date(this.now().getTime() - this.settings.chatRateWindowSeconds * 1_000)]
      );
      if (Number(recent.rows[0]?.count ?? 0) >= this.settings.chatRateMaximum) {
        throw new KingdomError("KINGDOM_CHAT_RATE_LIMITED", "Kingdom chat rate limit reached");
      }
      const messageId = randomUUID();
      const createdAt = this.now();
      await client.query(
        `INSERT INTO kingdom_chat_messages (
           id, kingdom_id, sender_player_id, request_id, content, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [messageId, actor.kingdomId, actorId, input.requestId, content, createdAt]
      );
      await client.query(
        `DELETE FROM kingdom_chat_messages WHERE id IN (
           SELECT id FROM kingdom_chat_messages WHERE kingdom_id = $1
           ORDER BY created_at DESC, id DESC OFFSET $2
         )`,
        [actor.kingdomId, this.settings.chatRetentionLimit]
      );
      const recipients = await client.query<{ player_id: string }>(
        `SELECT m.player_id
         FROM kingdom_memberships m
         WHERE m.kingdom_id = $1 AND m.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM player_blocks b
             WHERE (b.blocker_id = $2 AND b.blocked_id = m.player_id)
                OR (b.blocker_id = m.player_id AND b.blocked_id = $2)
           )
         ORDER BY m.player_id`,
        [actor.kingdomId, actorId]
      );
      return {
        kingdomId: actor.kingdomId,
        message: {
          id: messageId,
          kingdomId: actor.kingdomId,
          senderPlayerId: actorId,
          senderDisplayName: actor.displayName,
          content,
          createdAt: createdAt.toISOString()
        } satisfies KingdomChatMessage,
        recipientPlayerIds: recipients.rows.map((row) => row.player_id)
      };
    }, (value) => ({ kingdomId: value.kingdomId, messageId: value.message.id }));
    if (mutation.replayed) {
      const stored = mutation.value as unknown as { kingdomId: string; messageId: string };
      return {
        kingdomId: stored.kingdomId,
        message: null,
        messageId: stored.messageId,
        recipientPlayerIds: [],
        replayed: true
      };
    }
    return {
      kingdomId: mutation.value.kingdomId,
      message: mutation.value.message,
      messageId: mutation.value.message.id,
      recipientPlayerIds: mutation.replayed ? [] : mutation.value.recipientPlayerIds,
      replayed: mutation.replayed
    };
  }

  async activeChatRecipients(kingdomId: string, candidatePlayerIds: string[]): Promise<string[]> {
    if (candidatePlayerIds.length === 0) return [];
    const result = await this.pool.query<{ player_id: string }>(
      `SELECT player_id FROM kingdom_memberships
       WHERE kingdom_id = $1 AND status = 'active' AND player_id = ANY($2::text[])
       ORDER BY player_id`,
      [kingdomId, candidatePlayerIds]
    );
    return result.rows.map((row) => row.player_id);
  }

  async connectedQualificationDeadlines(playerIds: string[]): Promise<Array<{
    playerId: string;
    membershipId: string;
    qualifiedAt: Date;
  }>> {
    if (playerIds.length === 0) return [];
    const result = await this.pool.query<{
      player_id: string;
      id: string;
      perk_qualified_at: Date | string;
    }>(
      `SELECT player_id, id, perk_qualified_at
       FROM kingdom_memberships
       WHERE status = 'active' AND player_id = ANY($1::text[])
       ORDER BY perk_qualified_at, player_id`,
      [playerIds]
    );
    // A running kingdom buff ends without any mutation, so its end is a
    // stat refresh deadline too (one per membership and buff window).
    const buffs = await this.pool.query<{ player_id: string; id: string; active_until: Date | string }>(
      `SELECT m.player_id, m.id, s.active_until
       FROM kingdom_memberships m
       JOIN kingdom_perk_selections_in_effect s ON s.kingdom_id = m.kingdom_id
       WHERE m.status = 'active' AND m.player_id = ANY($1::text[])
         AND s.active_until IS NOT NULL AND s.active_until > $2`,
      [playerIds, new Date(this.now().getTime() - 60 * 60 * 1_000)]
    );
    // A Castle falling to rubble turns perks off without a member mutation:
    // one stat refresh per membership and ruin.
    const ruins = await this.pool.query<{ player_id: string; id: string; castle_ruined_at: Date | string }>(
      `SELECT m.player_id, m.id, k.castle_ruined_at
       FROM kingdom_memberships m
       JOIN kingdoms k ON k.id = m.kingdom_id
       WHERE m.status = 'active' AND m.player_id = ANY($1::text[]) AND k.castle_ruined_at IS NOT NULL`,
      [playerIds]
    );
    return [
      ...ruins.rows.map((row) => ({
        playerId: row.player_id,
        membershipId: `${row.id}:castle-ruined:${asDate(row.castle_ruined_at).toISOString()}`,
        qualifiedAt: asDate(row.castle_ruined_at)
      })),
      ...result.rows.map((row) => ({
        playerId: row.player_id,
        membershipId: row.id,
        qualifiedAt: asDate(row.perk_qualified_at)
      })),
      ...buffs.rows.map((row) => ({
        playerId: row.player_id,
        membershipId: `${row.id}:buff:${asDate(row.active_until).toISOString()}`,
        qualifiedAt: asDate(row.active_until)
      }))
    ];
  }

  async placeCot(player: PlayerRecord, input: KingdomPlacementInput): Promise<KingdomMutationResult> {
    const position = { ...player.position };
    const rotation = normalizeRotation(input.rotation);
    const payload = { requestId: input.requestId, rotation };
    const mutation = await this.mutate(player.playerId, input.requestId, "place_cot", payload, async (client) => {
      const actor = await lockActorContext(client, player.playerId);
      assertCastleStanding(actor.castleRuinedAt);
      const environment = await loadSeatEnvironment(client, actor.kingdomId);
      await assertActiveSeatComplete(client, actor.kingdomId);
      const quote = this.constructionPolicy.quote("cot", environment);
      const capacity = kingdomLevelForState(actor.level, actor.lifetimeXp).cotCapacity;
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM kingdom_cots WHERE kingdom_id = $1 AND status = 'active'",
        [actor.kingdomId]
      );
      if (Number(count.rows[0]?.count ?? 0) >= capacity) {
        throw new KingdomError("KINGDOM_COT_CAPACITY_REACHED", "The Kingdom has reached its cot capacity");
      }
      const existing = await client.query(
        "SELECT id FROM kingdom_cots WHERE owner_player_id = $1 AND status = 'active' LIMIT 1",
        [player.playerId]
      );
      if (existing.rowCount) {
        throw new KingdomError("KINGDOM_COT_ALREADY_PLACED", "This member already has an active cot");
      }
      await assertInsideTerritory(client, actor.kingdomId, position, this.settings.cotFootprintRadiusM);
      await assertLandOnlyFootprint(this.worldLookup, position, this.settings.cotFootprintRadiusM);
      await assertNoPlacementCollision(
        client,
        actor.kingdomId,
        position,
        this.settings.cotFootprintRadiusM,
        this.settings.seatFootprintRadiusM
      );
      const cotId = randomUUID();
      const now = this.now();
      await this.debitConstructionCost(client, player.playerId, input.requestId, actor.kingdomId, "cot", cotId, quote);
      const constructionState = this.settings.freeConstruction ? "complete" : "under_construction";
      const insertedCot = await client.query<{ spatial_revision: string | number }>(
        `INSERT INTO kingdom_cots (
           id, kingdom_id, owner_player_id, placed_by_player_id, request_id,
           lat, lon, geom, rotation, footprint_radius_m, status,
           completed_under_free_construction, construction_state, completed_at
         ) VALUES ($1,$2,$3,$3,$4,$5,$6,ST_SetSRID(ST_MakePoint($6,$5),4326),$7,$8,'active',$9,$10,$11)
         RETURNING spatial_revision`,
        [cotId, actor.kingdomId, player.playerId, input.requestId, position.lat, position.lon,
          rotation, this.settings.cotFootprintRadiusM, this.settings.freeConstruction,
          constructionState, this.settings.freeConstruction ? now : null]
      );
      if (!this.settings.freeConstruction) {
        await insertConstructionJob(client, {
          kingdomId: actor.kingdomId, actorPlayerId: player.playerId, entityType: "cot", entityId: cotId,
          requestId: input.requestId, quote, startedAt: now,
          completesAt: new Date(now.getTime() + await this.builderAdjustedConstructionSeconds(
            client, player.playerId, quote.adjustedConstructionSeconds
          ) * 1_000)
        });
      }
      await insertAudit(client, actor.kingdomId, player.playerId, player.playerId, "cot_placed", "cot", cotId, {
        freeConstruction: this.settings.freeConstruction,
        quote
      });
      return {
        kingdomId: actor.kingdomId,
        cotId,
        spatialChanges: this.settings.freeConstruction ? [spatialUpsertChange(null, spatialObjectEntity({
            id: cotId,
            kingdomId: actor.kingdomId,
            kind: "cot",
            typeId: "cot",
            displayName: "Cot",
            lat: position.lat,
            lon: position.lon,
            rotation,
            spatialRevision: String(insertedCot.rows[0]!.spatial_revision)
          }))] : []
      };
    }, (value) => ({ kingdomId: value.kingdomId, cotId: value.cotId }));
    return {
      ...(await this.stateAfterCommit(player, "place cot")),
      replayed: mutation.replayed,
      spatialChanges: mutation.replayed ? [] : mutation.value.spatialChanges
    };
  }

  async mutateCot(
    player: PlayerRecord,
    input: KingdomCotMutationInput
  ): Promise<KingdomMutationResult> {
    const position = { ...player.position };
    const rotation = input.rotation === undefined ? undefined : normalizeRotation(input.rotation);
    const payload = { ...input, ...(rotation === undefined ? {} : { rotation }) };
    const mutation = await this.mutate(
      player.playerId,
      input.requestId,
      `cot_${input.action}`,
      payload,
      async (client) => {
        const actor = await lockActorContext(client, player.playerId);
        const result = await client.query<{
          id: string;
          kingdom_id: string;
          owner_player_id: string;
          lat: number;
          lon: number;
          rotation: number;
          footprint_radius_m: number;
          status: string;
          construction_state: "under_construction" | "complete";
          spatial_revision: string | number;
        }>(
          `SELECT id, kingdom_id, owner_player_id, lat, lon, rotation, footprint_radius_m, status,
                  construction_state,
                  spatial_revision
           FROM kingdom_cots WHERE id = $1 FOR UPDATE`,
          [input.cotId]
        );
        const cot = result.rows[0];
        if (!cot || cot.kingdom_id !== actor.kingdomId || cot.status !== "active") {
          throw new KingdomError("KINGDOM_MEMBER_NOT_FOUND", "Active Kingdom cot not found");
        }
        if (input.action === "move" && cot.construction_state !== "complete") {
          throw new KingdomError("KINGDOM_CONSTRUCTION_DISABLED", "Finish cot construction before moving it");
        }
        if (
          cot.owner_player_id !== player.playerId &&
          !hasKingdomPermission(actor.role, "manage_cots")
        ) {
          throw new KingdomError(
            "KINGDOM_PERMISSION_DENIED",
            "Managing another member's cot requires permission"
          );
        }
        const previous = spatialObjectEntity({
          id: cot.id,
          kingdomId: cot.kingdom_id,
          kind: "cot",
          typeId: "cot",
          displayName: "Cot",
          lat: Number(cot.lat),
          lon: Number(cot.lon),
          rotation: Number(cot.rotation),
          spatialRevision: String(cot.spatial_revision)
        });
        let nextSpatialRevision: string;
        if (input.action === "pack") {
          const updated = await client.query<{ spatial_revision: string | number }>(
            `UPDATE kingdom_cots SET status = 'packed', archived_at = $2,
               spatial_revision = nextval('kingdom_spatial_revision_seq')
             WHERE id = $1 RETURNING spatial_revision`,
            [cot.id, this.now()]
          );
          nextSpatialRevision = String(updated.rows[0]!.spatial_revision);
          await cancelConstructionJob(client, "cot", cot.id, this.now());
          await insertAudit(
            client,
            actor.kingdomId,
            player.playerId,
            cot.owner_player_id,
            "cot_packed",
            "cot",
            cot.id
          );
        } else {
          await assertInsideTerritory(
            client,
            actor.kingdomId,
            position,
            Number(cot.footprint_radius_m)
          );
          await assertLandOnlyFootprint(
            this.worldLookup,
            position,
            Number(cot.footprint_radius_m)
          );
          await assertNoPlacementCollision(
            client,
            actor.kingdomId,
            position,
            Number(cot.footprint_radius_m),
            this.settings.seatFootprintRadiusM,
            cot.id,
            null
          );
          const updated = await client.query<{ spatial_revision: string | number }>(
            `UPDATE kingdom_cots SET lat = $2, lon = $3,
               geom = ST_SetSRID(ST_MakePoint($3,$2),4326), rotation = $4,
               spatial_revision = nextval('kingdom_spatial_revision_seq')
             WHERE id = $1 RETURNING spatial_revision`,
            [cot.id, position.lat, position.lon, rotation ?? Number(cot.rotation)]
          );
          nextSpatialRevision = String(updated.rows[0]!.spatial_revision);
          await insertAudit(
            client,
            actor.kingdomId,
            player.playerId,
            cot.owner_player_id,
            "cot_moved",
            "cot",
            cot.id,
            { lat: position.lat, lon: position.lon }
          );
        }
        const current = input.action === "move"
          ? spatialObjectEntity({
              id: cot.id,
              kingdomId: cot.kingdom_id,
              kind: "cot",
              typeId: "cot",
              displayName: "Cot",
              lat: position.lat,
              lon: position.lon,
              rotation: rotation ?? Number(cot.rotation),
              spatialRevision: nextSpatialRevision
            })
          : null;
        return {
          kingdomId: actor.kingdomId,
          cotId: cot.id,
          spatialChanges: [current
            ? spatialUpsertChange(previous, current)
            : spatialRemovalChange(previous, nextSpatialRevision)]
        };
      },
      (value) => ({ kingdomId: value.kingdomId, cotId: value.cotId })
    );
    return {
      ...(await this.stateAfterCommit(player, `cot ${input.action}`)),
      replayed: mutation.replayed,
      spatialChanges: mutation.replayed ? [] : mutation.value.spatialChanges
    };
  }

  async placeDecoration(
    player: PlayerRecord,
    input: KingdomDecorationPlacementInput
  ): Promise<KingdomMutationResult> {
    const position = { ...player.position };
    const rotation = normalizeRotation(input.rotation);
    const kingdomOwned = input.kingdomOwned ?? false;
    const payload = { ...input, rotation, kingdomOwned };
    const mutation = await this.mutate(player.playerId, input.requestId, "place_decoration", payload, async (client) => {
      const actor = await lockActorContext(client, player.playerId, "place_decorations");
      assertCastleStanding(actor.castleRuinedAt);
      const definition = await loadDecorationDefinition(client, input.typeId);
      if (!definition) throw new KingdomError("KINGDOM_DECORATION_NOT_FOUND", "Decoration type does not exist");
      assertDecorationPlacementPermission(actor.role, definition);
      if (actor.level < definition.requiredKingdomLevel) {
        throw new KingdomError("KINGDOM_DECORATION_LOCKED", "This decoration is not unlocked at the current Kingdom level");
      }
      if (definition.ownershipType === "personal" && kingdomOwned) {
        throw new KingdomError("KINGDOM_VALIDATION_FAILED", "This decoration must remain personally owned");
      }
      if (definition.ownershipType === "kingdom" && !kingdomOwned) {
        throw new KingdomError("KINGDOM_VALIDATION_FAILED", "This decoration must be Kingdom owned");
      }
      const used = await decorationCapacityUsed(client, actor.kingdomId);
      const capacity = kingdomLevelForState(actor.level, actor.lifetimeXp).decorationCapacity;
      if (used + definition.capacityCost > capacity) {
        throw new KingdomError("KINGDOM_DECORATION_CAPACITY_REACHED", "The Kingdom has reached its decoration capacity");
      }
      const environment = await loadSeatEnvironment(client, actor.kingdomId);
      await assertActiveSeatComplete(client, actor.kingdomId);
      const quote = this.constructionPolicy.quote("decoration", environment, definition);
      await assertInsideTerritory(client, actor.kingdomId, position, definition.footprintRadiusM);
      await assertLandOnlyFootprint(this.worldLookup, position, definition.footprintRadiusM);
      await assertNoPlacementCollision(
        client,
        actor.kingdomId,
        position,
        definition.footprintRadiusM,
        this.settings.seatFootprintRadiusM
      );
      const decorationId = randomUUID();
      const now = this.now();
      await this.debitConstructionCost(
        client, player.playerId, input.requestId, actor.kingdomId, "decoration", decorationId, quote
      );
      const constructionState = this.settings.freeConstruction ? "complete" : "under_construction";
      const insertedDecoration = await client.query<{ spatial_revision: string | number }>(
        `INSERT INTO kingdom_decorations (
           id, kingdom_id, type_id, placed_by_player_id, personal_owner_player_id,
           kingdom_owned, request_id, lat, lon, geom, rotation, footprint_radius_m,
           capacity_cost, status, completed_under_free_construction, construction_state, completed_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,ST_SetSRID(ST_MakePoint($9,$8),4326),
           $10,$11,$12,'active',$13,$14,$15
         ) RETURNING spatial_revision`,
        [decorationId, actor.kingdomId, definition.typeId, player.playerId,
          kingdomOwned ? null : player.playerId, kingdomOwned, input.requestId,
          position.lat, position.lon, rotation, definition.footprintRadiusM, definition.capacityCost,
          this.settings.freeConstruction, constructionState, this.settings.freeConstruction ? now : null]
      );
      if (!this.settings.freeConstruction) {
        await insertConstructionJob(client, {
          kingdomId: actor.kingdomId, actorPlayerId: player.playerId, entityType: "decoration",
          entityId: decorationId, requestId: input.requestId, quote, startedAt: now,
          completesAt: new Date(now.getTime() + await this.builderAdjustedConstructionSeconds(
            client, player.playerId, quote.adjustedConstructionSeconds
          ) * 1_000)
        });
      }
      await insertAudit(client, actor.kingdomId, player.playerId, kingdomOwned ? null : player.playerId,
        "decoration_placed", "decoration", decorationId,
        { typeId: definition.typeId, kingdomOwned, freeConstruction: this.settings.freeConstruction, quote });
      return {
        kingdomId: actor.kingdomId,
        decorationId,
        spatialChanges: this.settings.freeConstruction ? [spatialUpsertChange(null, spatialObjectEntity({
            id: decorationId,
            kingdomId: actor.kingdomId,
            kind: "decoration",
            typeId: definition.typeId,
            displayName: definition.displayName,
            lat: position.lat,
            lon: position.lon,
            rotation,
            spatialRevision: String(insertedDecoration.rows[0]!.spatial_revision)
          }))] : []
      };
    }, (value) => ({ kingdomId: value.kingdomId, decorationId: value.decorationId }));
    return {
      ...(await this.stateAfterCommit(player, "place decoration")),
      replayed: mutation.replayed,
      spatialChanges: mutation.replayed ? [] : mutation.value.spatialChanges
    };
  }

  async mutateDecoration(
    player: PlayerRecord,
    input: KingdomDecorationMutationInput
  ): Promise<KingdomMutationResult> {
    const position = { ...player.position };
    const payload = { ...input, rotation: input.rotation === undefined ? undefined : normalizeRotation(input.rotation) };
    const mutation = await this.mutate(
      player.playerId,
      input.requestId,
      `decoration_${input.action}`,
      payload,
      async (client) => {
        const actor = await lockActorContext(
          client,
          player.playerId,
          input.action === "move" ? "move_decorations" : "remove_decorations",
          true
        );
        const result = await client.query<DecorationLockRow>(
          `SELECT decoration.id, decoration.kingdom_id, decoration.type_id,
                  decoration.personal_owner_player_id, decoration.kingdom_owned,
                  decoration.lat, decoration.lon, decoration.rotation,
                  decoration.footprint_radius_m, decoration.status,
                  decoration.construction_state,
                  decoration.spatial_revision,
                  definition.display_name
           FROM kingdom_decorations decoration
           JOIN kingdom_decoration_definitions definition ON definition.type_id = decoration.type_id
           WHERE decoration.id = $1 FOR UPDATE OF decoration`,
          [input.decorationId]
        );
        const decoration = result.rows[0];
        if (!decoration || decoration.kingdom_id !== actor.kingdomId || decoration.status !== "active") {
          throw new KingdomError("KINGDOM_DECORATION_NOT_FOUND", "Active Kingdom decoration not found");
        }
        if (input.action === "move" && decoration.construction_state !== "complete") {
          throw new KingdomError("KINGDOM_CONSTRUCTION_DISABLED", "Finish decoration construction before moving it");
        }
        const previous = spatialObjectEntity({
          id: decoration.id,
          kingdomId: decoration.kingdom_id,
          kind: "decoration",
          typeId: decoration.type_id,
          displayName: decoration.display_name,
          lat: Number(decoration.lat),
          lon: Number(decoration.lon),
          rotation: Number(decoration.rotation),
          spatialRevision: String(decoration.spatial_revision)
        });
        assertDecorationMutationPermission(actor, decoration, input.action);
        let nextSpatialRevision: string;
        if (input.action === "remove") {
          const updated = await client.query<{ spatial_revision: string | number }>(
            `UPDATE kingdom_decorations SET status = 'removed', archived_at = $2,
               spatial_revision = nextval('kingdom_spatial_revision_seq')
             WHERE id = $1 RETURNING spatial_revision`,
            [decoration.id, this.now()]
          );
          nextSpatialRevision = String(updated.rows[0]!.spatial_revision);
          await cancelConstructionJob(client, "decoration", decoration.id, this.now());
          await insertAudit(client, actor.kingdomId, player.playerId, decoration.personal_owner_player_id,
            "decoration_removed", "decoration", decoration.id, { typeId: decoration.type_id });
        } else {
          await assertInsideTerritory(client, actor.kingdomId, position, Number(decoration.footprint_radius_m));
          await assertLandOnlyFootprint(
            this.worldLookup,
            position,
            Number(decoration.footprint_radius_m)
          );
          await assertNoPlacementCollision(
            client,
            actor.kingdomId,
            position,
            Number(decoration.footprint_radius_m),
            this.settings.seatFootprintRadiusM,
            null,
            decoration.id
          );
          const updated = await client.query<{ spatial_revision: string | number }>(
            `UPDATE kingdom_decorations SET lat = $2, lon = $3,
               geom = ST_SetSRID(ST_MakePoint($3,$2),4326), rotation = $4,
               spatial_revision = nextval('kingdom_spatial_revision_seq')
             WHERE id = $1 RETURNING spatial_revision`,
            [decoration.id, position.lat, position.lon,
              payload.rotation ?? Number(decoration.rotation)]
          );
          nextSpatialRevision = String(updated.rows[0]!.spatial_revision);
          await insertAudit(client, actor.kingdomId, player.playerId, decoration.personal_owner_player_id,
            "decoration_moved", "decoration", decoration.id,
            { lat: position.lat, lon: position.lon });
        }
        const current = input.action === "move"
          ? spatialObjectEntity({
              id: decoration.id,
              kingdomId: decoration.kingdom_id,
              kind: "decoration",
              typeId: decoration.type_id,
              displayName: decoration.display_name,
              lat: position.lat,
              lon: position.lon,
              rotation: payload.rotation ?? Number(decoration.rotation),
              spatialRevision: nextSpatialRevision
            })
          : null;
        return {
          kingdomId: actor.kingdomId,
          decorationId: decoration.id,
          spatialChanges: [current
            ? spatialUpsertChange(previous, current)
            : spatialRemovalChange(previous, nextSpatialRevision)]
        };
      },
      (value) => ({ kingdomId: value.kingdomId, decorationId: value.decorationId })
    );
    return {
      ...(await this.stateAfterCommit(player, `decoration ${input.action}`)),
      replayed: mutation.replayed,
      spatialChanges: mutation.replayed ? [] : mutation.value.spatialChanges
    };
  }

  async dissolveKingdom(actorId: string, requestId: string): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, requestId, "dissolve", { requestId }, async (client) => {
      const actor = await lockActorContext(client, actorId, "dissolve_kingdom");
      if (actor.role !== "leader") {
        throw new KingdomError("KINGDOM_PERMISSION_DENIED", "Only the leader may dissolve the Kingdom");
      }
      if (actor.castleRuinedAt) {
        const availableAt = castleRubbleDisbandAvailableAt(actor.castleRuinedAt);
        if (this.now().getTime() < availableAt.getTime()) {
          throw new KingdomError(
            "KINGDOM_CASTLE_RUBBLE_DISBAND_LOCKED",
            "A kingdom whose Castle lies in rubble can be disbanded 7 days after it fell",
            { disbandAvailableAt: availableAt.toISOString() }
          );
        }
      }
      const ended = await endKingdomInTransaction(
        client, actor.kingdomId, actorId, requestId, this.now(), "kingdom_dissolved"
      );
      if (!ended) throw new KingdomError("KINGDOM_INACTIVE", "Kingdom is no longer active");
      return {
        kingdomId: actor.kingdomId,
        collapseId: ended.collapse.collapseId,
        affectedFlagIds: [],
        notificationPlayerIds: [],
        spatialChanges: ended.spatialChanges
      };
    }, (value) => ({ kingdomId: value.kingdomId }));
    return {
      ...(await this.stateAfterCommit(actorId, "dissolve")),
      replayed: mutation.replayed,
      spatialChanges: mutation.replayed ? [] : mutation.value.spatialChanges,
      affectedFlagIds: mutation.replayed ? [] : mutation.value.affectedFlagIds as string[] ?? [],
      notificationPlayerIds: mutation.replayed ? [] : mutation.value.notificationPlayerIds as string[] ?? []
    };
  }

  /** The Castle rebuild price: the current founding cost (nothing under free construction). */
  castleRebuildCost(): KingdomCostLine[] {
    return this.settings.freeConstruction ? [] : FOUNDING_COST.map((line) => ({ ...line }));
  }

  /**
   * The leader rebuilds a Castle lying in rubble at the same spot for the
   * founding cost; each material comes from the treasury when it holds the
   * full amount, otherwise from the leader's pack. The Castle returns at full
   * health and the kingdom's perks and building resume.
   *
   * Lock order: player row, kingdom row and membership (lockActorContext),
   * the Castle flag row, then treasury rows and the leader's inventory.
   * Replay-safe through the kingdom request ledger and the treasury /
   * inventory operation keys.
   */
  async rebuildCastle(actorId: string, requestId: string): Promise<KingdomMutationResult> {
    const mutation = await this.mutate(actorId, requestId, "rebuild_castle", { requestId }, async (client) => {
      const actor = await lockActorContext(client, actorId, "dissolve_kingdom");
      if (actor.role !== "leader") {
        throw new KingdomError("KINGDOM_PERMISSION_DENIED", "Only the leader may rebuild the Castle");
      }
      if (!actor.castleRuinedAt) throw new KingdomError("KINGDOM_CASTLE_STANDING", "The Castle is not in rubble");
      const castle = await lockKingdomCastleFlag(client, actor.kingdomId);
      if (!castle) throw new KingdomError("KINGDOM_CASTLE_NOT_FOUND", "The Castle no longer exists");
      const operationKey = durableOperationKey("kingdom-castle-rebuild", actorId, requestId);
      const cost = this.castleRebuildCost().map((line) => ({
        itemId: requireItemDefinition(line.resourceType).itemId,
        quantity: line.quantity
      }));
      let materials: Array<Readonly<{ itemId: string; quantity: number; source: "treasury" | "builder" }>> = [];
      if (cost.length > 0) {
        try {
          materials = await chargeKingdomWarMaterialsInTransaction(client, this.inventory, {
            kingdomId: actor.kingdomId,
            playerId: actorId,
            operationKey,
            materials: cost,
            ledgerSource: "castle_rebuild",
            inventorySource: "kingdom_castle_rebuild",
            sourceEntityType: "kingdom",
            sourceEntityId: actor.kingdomId,
            metadata: { castleFlagId: castle.id },
            shortageMessage: (material) =>
              `Rebuilding the Castle needs ${material.quantity.toLocaleString("en-US")} ` +
              `${warMaterialLabel(material.itemId)} from the treasury or your pack`
          });
        } catch (error) {
          if (error instanceof KingdomBrickEconomyError && error.code === "KINGDOM_WAR_MATERIAL_REQUIRED") {
            throw new KingdomError("KINGDOM_CASTLE_REBUILD_MATERIAL_REQUIRED", error.message, error.details ?? {});
          }
          throw error;
        }
      }
      await client.query(
        `UPDATE flags
         SET health = maximum_health, damage_cycle_id = NULL,
             burning_started_at = NULL, burning_until = NULL, burning_reason = NULL
         WHERE id = $1::uuid`,
        [castle.id]
      );
      await client.query("UPDATE kingdoms SET castle_ruined_at = NULL WHERE id = $1", [actor.kingdomId]);
      await insertAudit(client, actor.kingdomId, actorId, null, "castle_rebuilt", "flag", castle.id);
      const members = await client.query<{ player_id: string }>(
        "SELECT player_id FROM kingdom_memberships WHERE kingdom_id = $1 AND status = 'active'",
        [actor.kingdomId]
      );
      return {
        kingdomId: actor.kingdomId,
        castleFlagId: castle.id,
        materials: materials.map((material) => ({ ...material })),
        notificationPlayerIds: members.rows.map((member) => member.player_id)
      };
    });
    return {
      ...(await this.stateAfterCommit(actorId, "rebuild_castle")),
      replayed: mutation.replayed,
      affectedFlagIds: mutation.replayed ? [] : [mutation.value.castleFlagId as string],
      notificationPlayerIds: mutation.replayed ? [] : mutation.value.notificationPlayerIds as string[]
    };
  }

  private async stateAfterCommit(
    player: PlayerRecord | string,
    operation: string
  ): Promise<{ state: KingdomStateSnapshot | null; stateRefreshRequired: boolean }> {
    try {
      const playerId = typeof player === "string" ? player : player.playerId;
      await this.hooks.beforePostCommitStateLoad?.(playerId, operation);
      return { state: await this.getState(player), stateRefreshRequired: false };
    } catch (error) {
      const playerId = typeof player === "string" ? player : player.playerId;
      this.logger.warn(
        { err: error, playerId, operation },
        "Kingdom mutation committed but response state refresh failed"
      );
      return { state: null, stateRefreshRequired: true };
    }
  }

  async statModifiers(playerId: string): Promise<KingdomStatModifiers> {
    const result = await this.pool.query<{
      kingdom_id: string;
      level: number;
      lifetime_xp: string | number;
      perk_qualified_at: Date | string;
    }>(
      `SELECT m.kingdom_id, k.level, k.lifetime_xp, m.perk_qualified_at
       FROM kingdom_memberships m JOIN kingdoms k ON k.id = m.kingdom_id
       WHERE m.player_id = $1 AND m.status = 'active' AND k.status = 'active'
       LIMIT 1`,
      [playerId]
    );
    const row = result.rows[0];
    if (!row) return emptyStatModifiers();
    const qualified = asDate(row.perk_qualified_at).getTime() <= this.now().getTime();
    if (!qualified) return { ...emptyStatModifiers(), kingdomId: row.kingdom_id };
    const perkIds: KingdomPerkId[] = [
      ...((await kingdomPerksForPlayer(this.pool, playerId, this.now()))?.perkIds ?? [])
    ];
    return {
      kingdomId: row.kingdom_id,
      qualified: true,
      perkIds,
      attackBonus: perkIds.reduce((sum, id) =>
        sum + KINGDOM_PERKS[id].attackBonus + KINGDOM_PERKS[id].buffAttackBonus, 0),
      defenseBonus: perkIds.reduce((sum, id) =>
        sum + KINGDOM_PERKS[id].defenseBonus + KINGDOM_PERKS[id].buffDefenseBonus, 0)
    };
  }

  private async lookupFoundingEnvironment(position: { lat: number; lon: number }): Promise<KingdomEnvironmentSnapshot> {
    let world: WorldLookupResult;
    try {
      world = await this.worldLookup.lookupGameplayEnvironment(position.lat, position.lon);
    } catch {
      throw new KingdomError(
        "KINGDOM_WORLD_AUTHORITY_UNAVAILABLE",
        "Kingdom founding is unavailable because world authority could not be reached"
      );
    }
    if (
      !world.ok ||
      typeof world.isLand !== "boolean" ||
      typeof world.isSaltwater !== "boolean" ||
      typeof world.insideMajorLake !== "boolean"
    ) {
      throw new KingdomError(
        "KINGDOM_WORLD_AUTHORITY_UNAVAILABLE",
        "Kingdom founding requires an authoritative land and water classification"
      );
    }
    if (!world.isLand || world.isSaltwater || world.insideMajorLake) {
      throw new KingdomError("KINGDOM_WATER_REJECTED", "A Castle cannot be founded on water");
    }
    return environmentSnapshot(world, this.now());
  }

  private async loadReplay<T>(
    actorId: string,
    requestId: string,
    operation: string,
    payload: unknown
  ): Promise<T | null> {
    const result = await this.pool.query<RequestRow>(
      `SELECT operation, request_hash, response FROM kingdom_requests
       WHERE actor_player_id = $1 AND request_id = $2`,
      [actorId, requestId]
    );
    const row = result.rows[0];
    if (!row) return null;
    assertReplayMatches(row, operation, requestHash(payload));
    return row.response as T;
  }

  private async mutate<T extends Record<string, unknown>>(
    actorId: string,
    requestId: string,
    operation: string,
    payload: unknown,
    apply: (client: pg.PoolClient) => Promise<T>,
    replayResponse: (value: T) => Record<string, unknown> = (value) => value,
    isolationLevel: "serializable" | null = null
  ): Promise<{ value: T; replayed: boolean }> {
    validateRequestId(requestId);
    const hash = requestHash(payload);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (isolationLevel === "serializable") {
        await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      }
      await requirePlayer(client, actorId, true);
      await client.query(
        `DELETE FROM kingdom_requests
         WHERE actor_player_id = $1 AND created_at < $2`,
        [actorId, new Date(this.now().getTime() - this.settings.replayRetentionDays * 86_400_000)]
      );
      const replay = await client.query<RequestRow>(
        `SELECT operation, request_hash, response FROM kingdom_requests
         WHERE actor_player_id = $1 AND request_id = $2`,
        [actorId, requestId]
      );
      if (replay.rows[0]) {
        assertReplayMatches(replay.rows[0], operation, hash);
        await client.query("COMMIT");
        return { value: replay.rows[0].response as T, replayed: true };
      }
      const value = await apply(client);
      await client.query(
        `INSERT INTO kingdom_requests (
           actor_player_id, request_id, operation, request_hash, kingdom_id, response
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [actorId, requestId, operation, hash,
          typeof value.kingdomId === "string" ? value.kingdomId : null,
          JSON.stringify(replayResponse(value))]
      );
      await client.query("COMMIT");
      return { value, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapKingdomError(error);
    } finally {
      client.release();
    }
  }
}

type RequestRow = { operation: string; request_hash: string; response: unknown };
type KingdomLockRow = {
  id: string;
  status: "active" | "dissolved" | "archived";
  castle_ruined_at: Date | string | null;
  level: number;
  current_xp: string | number;
  lifetime_xp: string | number;
  spatial_revision: string | number;
};
type ActorContext = {
  playerId: string;
  membershipId: string;
  kingdomId: string;
  role: KingdomRole;
  displayName: string;
  level: number;
  lifetimeXp: number;
  /** When the Castle fell to rubble; null while it stands. */
  castleRuinedAt: Date | null;
};
type MemberLockRow = { id: string; player_id: string; role: KingdomRole };
type InvitationLockRow = {
  id: string;
  kingdom_id: string;
  target_player_id: string;
  invited_by_player_id: string;
  status: string;
  expires_at: Date | string;
};
type KingdomProjectRow = {
  id: string;
  kingdom_id: string;
  project_type: "advancement";
  rules_version: number;
  target_level: number;
  status: "pending" | "completed" | "cancelled" | "failed";
  actor_player_id: string;
  cost_snapshot: unknown;
  xp_snapshot: unknown;
  started_at: Date | string;
  completes_at: Date | string;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  failed_at: Date | string | null;
  failure_code: string | null;
};
type ProjectCostLine = {
  resourceType: ResourceType;
  variant: string;
  quantity: number;
};
type ProjectXpSnapshot = {
  levelBefore: number;
  lifetimeXpBefore: number;
  targetLifetimeXp: number;
  xpDelta: number;
};
type DecorationLockRow = {
  id: string;
  kingdom_id: string;
  type_id: KingdomDecorationTypeId;
  personal_owner_player_id: string | null;
  kingdom_owned: boolean;
  lat: number;
  lon: number;
  rotation: number;
  footprint_radius_m: number;
  status: string;
  construction_state: "under_construction" | "complete";
  spatial_revision: string | number;
  display_name: string;
};

type KingdomFlagRow = {
  id: string;
  anchor_kind: "flag" | "buoy";
  control_type: "personal" | "city" | "city_seat" | "kingdom" | "kingdom_seat";
  owner_id: string;
  owner_username: string | null;
  owner_color: string;
  original_owner_player_id: string | null;
  contributed_by_player_id: string | null;
  contributor_username: string | null;
  name: string;
  lat: number;
  lon: number;
  claim_radius_m: number;
  city_id: string | null;
  kingdom_id: string | null;
  kingdom_affiliated_at: Date | string | null;
  kingdom_founding_request_id?: string | null;
  kingdom_founding_reserved_at?: Date | string | null;
};

type FoundingSourceFlagRow = KingdomFlagRow & { distance_m: number };

type CompletedKingdomSeatRow = {
  id: string;
  kingdom_id: string;
  kingdom_name: string;
  lat: number;
  lon: number;
  territory_radius_m: number;
};

async function resolveFoundingSourceFlag(
  queryable: Queryable,
  player: PlayerRecord,
  requestedFlagId: string | null,
  lock: boolean,
  confirmation: boolean
): Promise<FoundingSourceFlagRow> {
  const source = await loadFoundingSourceFlagCandidate(
    queryable,
    player,
    requestedFlagId,
    lock
  );
  return assertFoundingSourceFlagEligible(source, player, requestedFlagId, confirmation);
}

async function loadFoundingSourceFlagCandidate(
  queryable: Queryable,
  player: PlayerRecord,
  requestedFlagId: string | null,
  lock: boolean
): Promise<FoundingSourceFlagRow | null> {
  const result = await queryable.query<FoundingSourceFlagRow>(
    `SELECT flag.id, flag.owner_id, player.username AS owner_username,
            COALESCE(player.display_color, '#d83a3a') AS owner_color,
            flag.control_type, flag.anchor_kind, flag.original_owner_player_id,
            flag.contributed_by_player_id, contributor.username AS contributor_username,
            flag.name, flag.lat, flag.lon, flag.claim_radius_m,
            flag.city_id, flag.kingdom_id, flag.kingdom_affiliated_at,
            flag.kingdom_founding_request_id, flag.kingdom_founding_reserved_at,
            ST_Distance(
              flag.geom::geography,
              ST_SetSRID(ST_MakePoint($1,$2),4326)::geography
            ) AS distance_m
     FROM flags flag
     LEFT JOIN players player ON player.id = flag.owner_id
     LEFT JOIN players contributor ON contributor.id = flag.contributed_by_player_id
     WHERE (
       ($3::uuid IS NOT NULL AND flag.id = $3::uuid)
       OR
       ($3::uuid IS NULL
         AND ST_DWithin(
           flag.geom::geography,
           ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
           flag.claim_radius_m + $4
         )
       )
     )
     ORDER BY
       CASE WHEN flag.owner_id = $5
                  AND flag.control_type = 'personal'
                  AND flag.city_id IS NULL
                  AND flag.kingdom_id IS NULL
                  AND flag.kingdom_founding_request_id IS NULL
            THEN 0 ELSE 1 END,
       distance_m,
       flag.id
     LIMIT 1${lock ? " FOR UPDATE OF flag" : ""}`,
    [
      player.position.lon,
      player.position.lat,
      requestedFlagId,
      TERRITORY_EDGE_TOLERANCE_M,
      player.playerId
    ]
  );
  return result.rows[0] ?? null;
}

function assertFoundingSourceFlagEligible(
  source: FoundingSourceFlagRow | null,
  player: PlayerRecord,
  requestedFlagId: string | null,
  confirmation: boolean
): FoundingSourceFlagRow {
  if (!source) {
    throw new KingdomError(
      requestedFlagId
        ? "KINGDOM_FOUNDING_FLAG_REQUIRED"
        : "KINGDOM_FOUNDING_NO_FLAG_TERRITORY",
      requestedFlagId
        ? "The selected founding territory no longer exists"
        : "No flag territory exists at your current position",
      {
        ...(requestedFlagId ? { sourceFlagId: requestedFlagId } : {}),
        territoryEdgeToleranceM: TERRITORY_EDGE_TOLERANCE_M
      }
    );
  }
  if (source.owner_id !== player.playerId) {
    throw new KingdomError(
      confirmation ? "KINGDOM_FOUNDING_FLAG_OWNERSHIP_CHANGED" : "KINGDOM_FLAG_NOT_OWNER",
      confirmation
        ? "The founding flag is no longer owned by you"
        : `This territory belongs to ${source.owner_username ?? "another player"}`,
      { sourceFlagId: source.id }
    );
  }
  if (source.anchor_kind === "buoy") {
    throw new KingdomError(
      "KINGDOM_FLAG_KIND_UNSUPPORTED",
      "Buoys cannot found or join a Kingdom Flag network",
      { sourceFlagId: source.id }
    );
  }
  if (source.city_id !== null || source.control_type === "city" || source.control_type === "city_seat") {
    throw new KingdomError(
      "KINGDOM_FLAG_CITY_AFFILIATED",
      "This flag is affiliated with a City",
      { sourceFlagId: source.id, cityId: source.city_id, controlType: source.control_type }
    );
  }
  if (source.kingdom_id !== null || source.control_type === "kingdom" || source.control_type === "kingdom_seat") {
    throw new KingdomError(
      "KINGDOM_FLAG_ALREADY_AFFILIATED",
      "This flag is already affiliated with a Kingdom",
      { sourceFlagId: source.id, kingdomId: source.kingdom_id, controlType: source.control_type }
    );
  }
  if (source.control_type !== "personal") {
    throw new KingdomError(
      "KINGDOM_FLAG_NOT_PERSONALLY_CONTROLLED",
      "This is not a personally controlled founding flag",
      { sourceFlagId: source.id, controlType: source.control_type }
    );
  }
  if (source.kingdom_founding_request_id) {
    throw new KingdomError(
      "KINGDOM_FOUNDING_FLAG_RESERVED",
      "This flag is already reserved for another Kingdom-founding attempt",
      { sourceFlagId: source.id }
    );
  }
  if (
    Number(source.distance_m) >
    Number(source.claim_radius_m) + TERRITORY_EDGE_TOLERANCE_M
  ) {
    throw new KingdomError(
      "KINGDOM_FOUNDING_OUTSIDE_TERRITORY",
      confirmation
        ? "You moved outside the selected source territory before confirmation"
        : "Stand inside the selected completed personal flag territory",
      {
        sourceFlagId: source.id,
        distanceM: Number(source.distance_m),
        claimRadiusM: Number(source.claim_radius_m),
        territoryEdgeToleranceM: TERRITORY_EDGE_TOLERANCE_M
      }
    );
  }
  return source;
}

function foundingSourceSnapshot(
  source: FoundingSourceFlagRow,
  actorPlayerId: string
): KingdomFoundingSourceFlag {
  return {
    id: source.id,
    name: source.name,
    ownerColor: source.owner_color,
    ownerPlayerId: source.owner_id,
    ownerDisplayName: source.owner_username,
    controlType: source.control_type,
    ownedByPlayer: source.owner_id === actorPlayerId,
    personallyControlled: source.owner_id === actorPlayerId &&
      source.control_type === "personal" && source.city_id === null && source.kingdom_id === null,
    lat: Number(source.lat),
    lon: Number(source.lon),
    claimRadiusM: Number(source.claim_radius_m)
  };
}

type KingdomFlagPruneResult = {
  affectedFlagIds: string[];
  ownerPlayerIds: string[];
};

function ineligibleKingdomFlag(
  flagId: string,
  kingdomId: string | null,
  reasonCode: string,
  reason: string,
  networkRevision: string | null = null
): KingdomFlagEligibility {
  return {
    flagId,
    kingdomId,
    eligible: false,
    reasonCode,
    reason,
    networkRevision,
    connectionAnchor: null
  };
}

async function loadKingdomLock(
  queryable: Queryable,
  kingdomId: string,
  lock: boolean
): Promise<KingdomLockRow | null> {
  const result = await queryable.query<KingdomLockRow>(
    `SELECT id, status, level, current_xp, lifetime_xp, spatial_revision, castle_ruined_at
     FROM kingdoms WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [kingdomId]
  );
  return result.rows[0] ?? null;
}

async function loadKingdomFlagRow(
  queryable: Queryable,
  flagId: string,
  lock: boolean
): Promise<KingdomFlagRow | null> {
  const result = await queryable.query<KingdomFlagRow>(
    `SELECT flag.id, flag.owner_id, player.username AS owner_username,
            COALESCE(player.display_color, '#d83a3a') AS owner_color,
            flag.control_type, flag.anchor_kind, flag.original_owner_player_id,
            flag.contributed_by_player_id, contributor.username AS contributor_username,
            flag.name, flag.lat, flag.lon, flag.claim_radius_m,
            flag.city_id, flag.kingdom_id, flag.kingdom_affiliated_at
     FROM flags flag
     LEFT JOIN players player ON player.id = flag.owner_id
     LEFT JOIN players contributor ON contributor.id = flag.contributed_by_player_id
     WHERE flag.id = $1${lock ? " FOR UPDATE OF flag" : ""}`,
    [flagId]
  );
  return result.rows[0] ?? null;
}

async function loadCompletedKingdomSeat(
  queryable: Queryable,
  kingdomId: string,
  lock: boolean
): Promise<CompletedKingdomSeatRow | null> {
  const result = await queryable.query<CompletedKingdomSeatRow>(
    `SELECT seat.id, seat.kingdom_id, kingdom.display_name AS kingdom_name,
            seat.lat, seat.lon, seat.territory_radius_m
     FROM kingdom_seats seat
     JOIN kingdoms kingdom ON kingdom.id = seat.kingdom_id
     WHERE seat.kingdom_id = $1
       AND seat.status = 'active'
       AND seat.construction_state = 'complete'
       AND kingdom.status = 'active'
     LIMIT 1${lock ? " FOR UPDATE OF seat" : ""}`,
    [kingdomId]
  );
  return result.rows[0] ?? null;
}

async function assertKingdomFlagNetworkBound(
  queryable: Queryable,
  kingdomId: string
): Promise<void> {
  const result = await queryable.query<{ count: string }>(
    "SELECT count(*) AS count FROM flags WHERE kingdom_id = $1 AND control_type = 'kingdom'",
    [kingdomId]
  );
  const count = Number(result.rows[0]?.count ?? 0);
  if (count > KINGDOM_FLAG_NETWORK_LIMIT) {
    throw new KingdomError(
      "KINGDOM_FLAG_NETWORK_LIMIT",
      `Kingdom Flag network safety limit exceeded (${count}/${KINGDOM_FLAG_NETWORK_LIMIT})`
    );
  }
}

export async function lockKingdomFlagNetwork(queryable: Queryable, kingdomId: string): Promise<void> {
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`kingdom-flag-network:${kingdomId}`]
  );
  const locked = await queryable.query<{ id: string }>(
    `SELECT id FROM flags WHERE kingdom_id = $1 AND control_type = 'kingdom' ORDER BY id
     LIMIT $2 FOR UPDATE`,
    [kingdomId, KINGDOM_FLAG_NETWORK_LIMIT + 1]
  );
  if (locked.rows.length > KINGDOM_FLAG_NETWORK_LIMIT) {
    throw new KingdomError("KINGDOM_FLAG_NETWORK_LIMIT", "Kingdom Flag network safety limit exceeded");
  }
}

async function loadConnectedKingdomFlagIds(
  queryable: Queryable,
  kingdomId: string,
  excludedFlagIds: string[] = []
): Promise<string[]> {
  await assertKingdomFlagNetworkBound(queryable, kingdomId);
  const result = await queryable.query<{ id: string }>(
    `WITH RECURSIVE connected(id) AS (
       SELECT flag.id
       FROM flags flag
       JOIN kingdom_seats seat ON seat.kingdom_id = flag.kingdom_id
       LEFT JOIN flags source ON source.id = seat.source_flag_id
       JOIN kingdoms kingdom ON kingdom.id = flag.kingdom_id
       WHERE flag.kingdom_id = $1
          AND flag.control_type = 'kingdom'
         AND flag.war_structure_kind IS NULL
         AND NOT (flag.id = ANY($2::uuid[]))
         AND seat.status = 'active'
         AND seat.construction_state = 'complete'
         AND kingdom.status = 'active'
         AND ST_DWithin(
           flag.geom::geography,
           COALESCE(source.geom, seat.geom)::geography,
           flag.claim_radius_m + seat.territory_radius_m + $3
         )
       UNION
       SELECT candidate.id
       FROM connected
       JOIN flags current_flag ON current_flag.id = connected.id
       JOIN flags candidate
          ON candidate.kingdom_id = $1
         AND candidate.control_type = 'kingdom'
         AND candidate.war_structure_kind IS NULL
        AND candidate.id <> current_flag.id
        AND NOT (candidate.id = ANY($2::uuid[]))
       WHERE ST_DWithin(
         candidate.geom::geography,
         current_flag.geom::geography,
         candidate.claim_radius_m + current_flag.claim_radius_m + $3
       )
     )
     SELECT id FROM connected ORDER BY id`,
    [kingdomId, excludedFlagIds, FLAG_CONTROL_TOUCH_TOLERANCE_M]
  );
  return result.rows.map(({ id }) => id);
}

async function loadKingdomFlagConnectionAnchor(
  queryable: Queryable,
  flag: KingdomFlagRow,
  kingdomId: string,
  seat: CompletedKingdomSeatRow,
  connectedIds: string[]
): Promise<KingdomFlagConnectionAnchor | null> {
  const direct = await queryable.query<{ touching: boolean }>(
    `SELECT ST_DWithin(
       flag.geom::geography,
       COALESCE(source.geom, seat.geom)::geography,
       flag.claim_radius_m + seat.territory_radius_m + $3
     ) AS touching
     FROM flags flag
     JOIN kingdom_seats seat ON seat.id = $2
     LEFT JOIN flags source ON source.id = seat.source_flag_id
     WHERE flag.id = $1`,
    [flag.id, seat.id, FLAG_CONTROL_TOUCH_TOLERANCE_M]
  );
  if (direct.rows[0]?.touching) {
    return { kind: "seat", id: seat.id, name: `${seat.kingdom_name} Castle` };
  }
  if (connectedIds.length === 0) return null;
  const neighbor = await queryable.query<{
    id: string; name: string; owner_id: string;
  }>(
    `SELECT neighbor.id, neighbor.name, neighbor.owner_id
     FROM flags target
     JOIN flags neighbor
       ON neighbor.kingdom_id = $2
      AND neighbor.id = ANY($3::uuid[])
      AND neighbor.id <> target.id
      AND ST_DWithin(
        target.geom::geography,
        neighbor.geom::geography,
        target.claim_radius_m + neighbor.claim_radius_m + $4
      )
     WHERE target.id = $1
     ORDER BY ST_Distance(target.geom::geography, neighbor.geom::geography), neighbor.id
     LIMIT 1`,
    [flag.id, kingdomId, connectedIds, FLAG_CONTROL_TOUCH_TOLERANCE_M]
  );
  const row = neighbor.rows[0];
  return row ? { kind: "kingdom_flag", id: row.id, name: row.name, ownerPlayerId: row.owner_id } : null;
}

async function calculateKingdomFlagRemovalSet(
  queryable: Queryable,
  kingdomId: string,
  initialFlagIds: string[]
): Promise<string[]> {
  // War Towers / Outposts are not part of the seat network: they break only
  // with themselves, their war, or the kingdom's fall.
  const all = await queryable.query<{ id: string }>(
    `SELECT id FROM flags WHERE kingdom_id = $1 AND control_type = 'kingdom'
       AND (war_structure_kind IS NULL OR id = ANY($2::uuid[])) ORDER BY id`,
    [kingdomId, initialFlagIds]
  );
  const allIds = all.rows.map(({ id }) => id);
  const allSet = new Set(allIds);
  const initial = [...new Set(initialFlagIds.filter((id) => allSet.has(id)))];
  if (initial.length === 0) return [];
  const remainingConnected = new Set(
    await loadConnectedKingdomFlagIds(queryable, kingdomId, initial)
  );
  return [
    ...initial,
    ...allIds.filter((id) => !initial.includes(id) && !remainingConnected.has(id))
  ];
}

async function insertKingdomFlagHistory(
  queryable: Queryable,
  input: {
    kingdomId: string;
    flag: KingdomFlagRow;
    actorId: string | null;
    action: "affiliated" | "removed" | "released" | "pruned" | "flag_deleted" | "kingdom_dissolved" | "restored_on_dissolution";
    reason: string;
    requestId?: string | null;
    resultingKingdomId?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await queryable.query(
    `INSERT INTO kingdom_flag_affiliation_history (
       id, kingdom_id, flag_id, flag_owner_player_id, performed_by_player_id,
       action, reason, request_id, prior_kingdom_id, resulting_kingdom_id, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [
      randomUUID(), input.kingdomId, input.flag.id, input.flag.owner_id, input.actorId,
      input.action, input.reason, input.requestId ?? null, input.flag.kingdom_id,
      input.resultingKingdomId ?? null, JSON.stringify(input.metadata ?? {})
    ]
  );
}

/**
 * Removes flags from a Kingdom. Released / removed flags and every flag the
 * removal cuts off from the Castle network BREAK (are deleted) instead
 * of reverting to personal control. With initialAction "flag_deleted" the
 * caller deletes the initial flags itself.
 */
export async function clearAndPruneKingdomFlags(
  queryable: Queryable,
  kingdomId: string,
  initialFlagIds: string[],
  actorId: string | null,
  reason: string,
  requestId: string | null = null,
  initialAction: "removed" | "released" | "flag_deleted" = "released"
): Promise<KingdomFlagPruneResult> {
  await lockKingdomFlagNetwork(queryable, kingdomId);
  const rows = await queryable.query<KingdomFlagRow>(
    `SELECT flag.id, flag.control_type, flag.anchor_kind, flag.owner_id,
            player.username AS owner_username,
            COALESCE(player.display_color, '#d83a3a') AS owner_color,
            flag.original_owner_player_id, flag.contributed_by_player_id,
            contributor.username AS contributor_username, flag.name,
            flag.lat, flag.lon, flag.claim_radius_m, flag.city_id,
            flag.kingdom_id, flag.kingdom_affiliated_at
     FROM flags flag
     LEFT JOIN players player ON player.id = flag.owner_id
     LEFT JOIN players contributor ON contributor.id = flag.contributed_by_player_id
     WHERE flag.kingdom_id = $1 ORDER BY flag.id FOR UPDATE OF flag`,
    [kingdomId]
  );
  const affectedIds = await calculateKingdomFlagRemovalSet(queryable, kingdomId, initialFlagIds);
  if (affectedIds.length === 0) return { affectedFlagIds: [], ownerPlayerIds: [] };
  const initialSet = new Set(initialFlagIds);
  const breakingIds = initialAction === "flag_deleted"
    ? affectedIds.filter((id) => !initialSet.has(id))
    : affectedIds;
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const notify = new Set<string>();
  for (const id of affectedIds) {
    const flag = byId.get(id);
    if (!flag) continue;
    notify.add(flag.original_owner_player_id ?? flag.owner_id);
    await insertKingdomFlagHistory(queryable, {
      kingdomId,
      flag,
      actorId,
      action: initialSet.has(id) ? initialAction : "pruned",
      reason: initialSet.has(id) ? reason : `disconnected_after:${reason}`,
      requestId,
      resultingKingdomId: null,
      metadata: { downstream: !initialSet.has(id), broken: true }
    });
    const eventType = !initialSet.has(id)
      ? "kingdom_flag_pruned"
      : initialAction === "released"
        ? "kingdom_flag_released"
        : "kingdom_flag_removed";
    await insertAudit(
      queryable,
      kingdomId,
      actorId,
      flag.original_owner_player_id ?? flag.owner_id,
      eventType,
      "flag",
      flag.id
    );
  }
  const broken = await breakTerritoryFlagsInTransaction(queryable, breakingIds);
  await bumpKingdomSpatialRevision(queryable, kingdomId);
  return {
    affectedFlagIds: broken.map(({ id }) => id),
    ownerPlayerIds: [...notify]
  };
}

/**
 * Standalone Kingdom fall for TerritoryCollapseService.begin: ends the Kingdom
 * in its own transaction. Without an actor the leader is recorded.
 */
export async function endKingdomWithCollapse(
  pool: pg.Pool,
  kingdomId: string,
  actorPlayerId: string | null,
  reason: string
): Promise<TerritoryCollapseBegun | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const kingdom = await client.query<{ leader_player_id: string }>(
      "SELECT leader_player_id FROM kingdoms WHERE id = $1 FOR UPDATE",
      [kingdomId]
    );
    if (!kingdom.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    const actorId = actorPlayerId ?? kingdom.rows[0].leader_player_id;
    const ended = await endKingdomInTransaction(
      client, kingdomId, actorId, `territory-collapse:${kingdomId}`, new Date(), reason
    );
    if (!ended) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("COMMIT");
    return ended.collapse;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ends an active Kingdom and starts its territory collapse in the caller's
 * transaction. Returns null when the Kingdom was already ended. Used by the
 * leader's dissolve and by TerritoryCollapseService.begin (developer / sieges).
 */
export async function endKingdomInTransaction(
  client: Queryable,
  kingdomId: string,
  actorId: string,
  requestId: string,
  now: Date,
  reason: string
): Promise<{ collapse: TerritoryCollapseBegun; spatialChanges: KingdomSpatialChange[] } | null> {
  const previousEntities = await loadKingdomSpatialEntities(client, kingdomId);
  await lockKingdomFlagNetwork(client, kingdomId);
  await lockFlagControlGeometry(client);
  await cancelPendingAdvancementProjectForDissolution(
    client,
    kingdomId,
    actorId,
    requestId,
    now
  );
  const changed = await client.query<{ spatial_revision: string | number }>(
    `UPDATE kingdoms SET status = 'dissolved', dissolved_at = $2,
       spatial_revision = nextval('kingdom_spatial_revision_seq')
     WHERE id = $1 AND status = 'active' RETURNING spatial_revision`,
    [kingdomId, now]
  );
  if (!changed.rowCount) return null;
  const members = await client.query<{ player_id: string }>(
    `SELECT player_id FROM kingdom_memberships
     WHERE kingdom_id = $1 AND status = 'active' ORDER BY player_id`,
    [kingdomId]
  );
  // Every Kingdom flag, the Seat source included, breaks in a wave.
  const collapse = await beginKingdomCollapse(
    client, kingdomId, actorId, reason,
    members.rows.map(({ player_id }) => player_id)
  );
  await insertAudit(client, kingdomId, actorId, null, "kingdom_dissolved");
  await client.query(
    `UPDATE kingdom_memberships SET status = 'removed', ended_at = $2,
       ended_by_player_id = $3, end_reason = 'kingdom_dissolved'
     WHERE kingdom_id = $1 AND status = 'active'`,
    [kingdomId, now, actorId]
  );
  await client.query(
    `UPDATE kingdom_invitations SET status = 'revoked', responded_at = $2
     WHERE kingdom_id = $1 AND status = 'pending'`,
    [kingdomId, now]
  );
  await client.query(
    "UPDATE kingdom_seats SET status = 'archived', archived_at = $2 WHERE kingdom_id = $1 AND status = 'active'",
    [kingdomId, now]
  );
  await client.query(
    `UPDATE kingdom_construction_jobs SET status = 'cancelled', cancelled_at = $2
     WHERE kingdom_id = $1 AND status = 'pending'`,
    [kingdomId, now]
  );
  const archivedCots = await client.query<{ id: string; spatial_revision: string | number }>(
    `UPDATE kingdom_cots SET status = 'archived', archived_at = $2,
       spatial_revision = nextval('kingdom_spatial_revision_seq')
     WHERE kingdom_id = $1 AND status = 'active' RETURNING id, spatial_revision`,
    [kingdomId, now]
  );
  const archivedDecorations = await client.query<{ id: string; spatial_revision: string | number }>(
    `UPDATE kingdom_decorations SET status = 'archived', archived_at = $2,
       spatial_revision = nextval('kingdom_spatial_revision_seq')
     WHERE kingdom_id = $1 AND status = 'active' RETURNING id, spatial_revision`,
    [kingdomId, now]
  );
  const removalRevisions = new Map<string, string>([
    ...archivedCots.rows.map((row) => [row.id, String(row.spatial_revision)] as const),
    ...archivedDecorations.rows.map((row) => [row.id, String(row.spatial_revision)] as const)
  ]);
  return {
    collapse,
    spatialChanges: previousEntities.map((previous) => spatialRemovalChange(
      previous,
      previous.entityType === "seat"
        ? changed.rows[0]!.spatial_revision
        : removalRevisions.get(previous.id)!
    ))
  };
}

/**
 * Starts the Kingdom's territory collapse inside the transaction that ended it:
 * every Kingdom flag, including the Seat source flag, is marked collapsing and
 * queued to break in a wave outward from the Seat.
 */
async function beginKingdomCollapse(
  queryable: Queryable,
  kingdomId: string,
  actorId: string | null,
  reason: string,
  notifyPlayerIds: readonly string[]
): Promise<TerritoryCollapseBegun> {
  const kingdom = await queryable.query<{ display_name: string }>(
    "SELECT display_name FROM kingdoms WHERE id = $1",
    [kingdomId]
  );
  return beginTerritoryCollapseInTransaction(queryable, {
    kind: "kingdom",
    id: kingdomId,
    displayName: kingdom.rows[0]?.display_name ?? "The Kingdom",
    reason,
    actorPlayerId: actorId,
    notifyPlayerIds
  });
}

function resolveConfig(config: AppConfig): ResolvedKingdomConfig {
  const production = config.NODE_ENV === "production";
  const free = config.KINGDOMS_FREE_CONSTRUCTION;
  if (production && free) {
    throw new Error("Production cannot enable free Kingdom construction");
  }
  return {
    freeConstruction: free,
    initialTerritoryRadiusM: config.KINGDOM_INITIAL_TERRITORY_RADIUS_M,
    minimumSeatSpacingM: config.KINGDOM_MIN_SEAT_SPACING_M,
    seatSpacingBufferM: config.KINGDOM_SEAT_SPACING_BUFFER_M,
    nearbyRadiusM: config.KINGDOM_SNAPSHOT_RADIUS_M,
    nearbyLimit: config.KINGDOM_SNAPSHOT_LIMIT,
    objectSnapshotLimit: config.KINGDOM_OBJECT_SNAPSHOT_LIMIT,
    invitationTtlSeconds: config.KINGDOM_INVITATION_TTL_HOURS * 3_600,
    perkQualificationSeconds: config.KINGDOM_PERK_QUALIFICATION_SECONDS,
    chatHistoryLimit: config.KINGDOM_CHAT_HISTORY_LIMIT,
    chatRetentionLimit: config.KINGDOM_CHAT_RETENTION_LIMIT,
    donationHistoryLimit: config.KINGDOM_DONATION_HISTORY_LIMIT,
    chatRateMaximum: config.KINGDOM_CHAT_RATE_MAX,
    chatRateWindowSeconds: config.KINGDOM_CHAT_RATE_WINDOW_SECONDS,
    seatFootprintRadiusM: config.KINGDOM_SEAT_FOOTPRINT_RADIUS_M,
    cotFootprintRadiusM: config.KINGDOM_COT_FOOTPRINT_RADIUS_M,
    replayRetentionDays: config.KINGDOM_REPLAY_RETENTION_DAYS
  };
}

async function requirePlayer(queryable: Queryable, playerId: string, lock = false): Promise<void> {
  const result = await queryable.query(
    `SELECT id FROM players WHERE id = $1${lock ? " FOR NO KEY UPDATE" : ""}`,
    [playerId]
  );
  if (!result.rowCount) throw new KingdomError("KINGDOM_MEMBER_NOT_FOUND", "Player does not exist");
}

async function loadInvitationAudience(
  queryable: Queryable,
  kingdomIds: string[],
  directPlayerIds: string[]
): Promise<string[]> {
  const uniqueKingdomIds = [...new Set(kingdomIds)];
  const audience = new Set(directPlayerIds);
  if (uniqueKingdomIds.length > 0) {
    const authorized = await queryable.query<{ player_id: string }>(
      `SELECT player_id
       FROM kingdom_memberships
       WHERE kingdom_id = ANY($1::uuid[])
         AND status = 'active'
         AND role IN ('leader', 'officer')
       ORDER BY player_id`,
      [uniqueKingdomIds]
    );
    for (const { player_id: playerId } of authorized.rows) audience.add(playerId);
  }
  return [...audience].sort();
}

async function loadActiveKingdomPlayerIds(
  queryable: Queryable,
  kingdomId: string
): Promise<string[]> {
  const result = await queryable.query<{ player_id: string }>(
    `SELECT player_id FROM kingdom_memberships
     WHERE kingdom_id = $1 AND status = 'active'
     ORDER BY player_id`,
    [kingdomId]
  );
  return result.rows.map((row) => row.player_id);
}

async function lockKingdom(queryable: Queryable, kingdomId: string): Promise<KingdomLockRow> {
  const result = await queryable.query<KingdomLockRow>(
    `SELECT id, status, level, current_xp, lifetime_xp, spatial_revision, castle_ruined_at FROM kingdoms
     WHERE id = $1 FOR UPDATE`,
    [kingdomId]
  );
  const row = result.rows[0];
  if (!row) throw new KingdomError("KINGDOM_NOT_FOUND", "Kingdom does not exist");
  return row;
}

async function lockActorContext(
  client: Queryable,
  actorId: string,
  permission?: KingdomPermission,
  allowOwnerWithoutPermission = false
): Promise<ActorContext> {
  const membershipHint = await client.query<{ kingdom_id: string }>(
    `SELECT kingdom_id FROM kingdom_memberships
     WHERE player_id = $1 AND status = 'active' LIMIT 1`,
    [actorId]
  );
  const kingdomId = membershipHint.rows[0]?.kingdom_id;
  if (!kingdomId) {
    throw new KingdomError("KINGDOM_MEMBERSHIP_REQUIRED", "Active Kingdom membership is required");
  }
  const kingdom = await lockKingdom(client, kingdomId);
  if (kingdom.status !== "active") throw new KingdomError("KINGDOM_INACTIVE", "Kingdom is no longer active");
  const membership = await client.query<{
    id: string;
    kingdom_id: string;
    role: KingdomRole;
    username: string;
  }>(
    `SELECT m.id, m.kingdom_id, m.role, p.username
     FROM kingdom_memberships m JOIN players p ON p.id = m.player_id
     WHERE m.player_id = $1 AND m.kingdom_id = $2 AND m.status = 'active'
     FOR UPDATE OF m`,
    [actorId, kingdomId]
  );
  const row = membership.rows[0];
  if (!row) throw new KingdomError("KINGDOM_MEMBERSHIP_REQUIRED", "Active Kingdom membership is required");
  if (permission && !hasKingdomPermission(row.role, permission) && !allowOwnerWithoutPermission) {
    throw new KingdomError("KINGDOM_PERMISSION_DENIED", `Kingdom permission '${permission}' is required`);
  }
  return {
    playerId: actorId,
    membershipId: row.id,
    kingdomId,
    role: row.role,
    displayName: row.username,
    level: Number(kingdom.level),
    lifetimeXp: Number(kingdom.lifetime_xp),
    castleRuinedAt: kingdom.castle_ruined_at === null ? null : new Date(kingdom.castle_ruined_at)
  };
}

/** A kingdom whose Castle lies in rubble cannot build, upgrade or place anything until it is rebuilt. */
function assertCastleStanding(castleRuinedAt: Date | string | null | undefined): void {
  if (castleRuinedAt !== null && castleRuinedAt !== undefined) {
    throw new KingdomError("KINGDOM_CASTLE_RUBBLE", "The Castle lies in rubble: the leader must rebuild it first");
  }
}

async function lockAdvancementMembership(
  client: Queryable,
  actorId: string
): Promise<{ membershipId: string; kingdomId: string; role: KingdomRole }> {
  const result = await client.query<{ id: string; kingdom_id: string; role: KingdomRole }>(
    `SELECT id, kingdom_id, role
     FROM kingdom_memberships
     WHERE player_id = $1 AND status = 'active'
     LIMIT 1 FOR UPDATE`,
    [actorId]
  );
  const membership = result.rows[0];
  if (!membership) {
    throw new KingdomError("KINGDOM_MEMBERSHIP_REQUIRED", "Active Kingdom membership is required");
  }
  if (!hasKingdomPermission(membership.role, "manage_perks")) {
    throw new KingdomError(
      "KINGDOM_PERMISSION_DENIED",
      "Kingdom permission 'manage_perks' is required"
    );
  }
  return {
    membershipId: membership.id,
    kingdomId: membership.kingdom_id,
    role: membership.role
  };
}

async function lockMember(
  client: Queryable,
  kingdomId: string,
  playerId: string
): Promise<MemberLockRow | null> {
  const result = await client.query<MemberLockRow>(
    `SELECT id, player_id, role FROM kingdom_memberships
     WHERE kingdom_id = $1 AND player_id = $2 AND status = 'active' FOR UPDATE`,
    [kingdomId, playerId]
  );
  return result.rows[0] ?? null;
}

async function activeMemberCount(queryable: Queryable, kingdomId: string): Promise<number> {
  const result = await queryable.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM kingdom_memberships WHERE kingdom_id = $1 AND status = 'active'",
    [kingdomId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function isBanned(queryable: Queryable, kingdomId: string, playerId: string): Promise<boolean> {
  const result = await queryable.query(
    `SELECT id FROM kingdom_memberships
     WHERE kingdom_id = $1 AND player_id = $2 AND status = 'banned' LIMIT 1`,
    [kingdomId, playerId]
  );
  return Boolean(result.rowCount);
}

async function closeMembershipAndObjects(
  client: Queryable,
  kingdomId: string,
  membershipId: string,
  playerId: string,
  status: "left" | "removed" | "banned",
  actorId: string,
  reason: string
): Promise<KingdomSpatialChange[]> {
  const now = new Date();
  const cots = await client.query<{
    id: string; kingdom_id: string; lat: number; lon: number; rotation: number;
    spatial_revision: string | number;
  }>(
    `SELECT id, kingdom_id, lat, lon, rotation, spatial_revision
     FROM kingdom_cots
     WHERE kingdom_id = $1 AND owner_player_id = $2 AND status = 'active'
     FOR UPDATE`,
    [kingdomId, playerId]
  );
  const decorations = await client.query<{
    id: string; kingdom_id: string; type_id: KingdomDecorationTypeId; display_name: string;
    lat: number; lon: number; rotation: number; spatial_revision: string | number;
  }>(
    `SELECT decoration.id, decoration.kingdom_id, decoration.type_id,
            definition.display_name, decoration.lat, decoration.lon, decoration.rotation,
            decoration.spatial_revision
     FROM kingdom_decorations decoration
     JOIN kingdom_decoration_definitions definition ON definition.type_id = decoration.type_id
     WHERE decoration.kingdom_id = $1
       AND decoration.personal_owner_player_id = $2
       AND decoration.kingdom_owned = false
       AND decoration.status = 'active'
     FOR UPDATE OF decoration`,
    [kingdomId, playerId]
  );
  await client.query(
    `UPDATE kingdom_memberships SET status = $2, ended_at = $3,
       ended_by_player_id = $4, end_reason = $5 WHERE id = $1 AND status = 'active'`,
    [membershipId, status, now, actorId, reason]
  );
  const packedCots = await client.query<{ id: string; spatial_revision: string | number }>(
    `UPDATE kingdom_cots SET status = 'packed', archived_at = $3,
       spatial_revision = nextval('kingdom_spatial_revision_seq')
     WHERE kingdom_id = $1 AND owner_player_id = $2 AND status = 'active'
     RETURNING id, spatial_revision`,
    [kingdomId, playerId, now]
  );
  const packedDecorations = await client.query<{ id: string; spatial_revision: string | number }>(
    `UPDATE kingdom_decorations SET status = 'packed', archived_at = $3,
       spatial_revision = nextval('kingdom_spatial_revision_seq')
     WHERE kingdom_id = $1 AND personal_owner_player_id = $2
       AND kingdom_owned = false AND status = 'active'
     RETURNING id, spatial_revision`,
    [kingdomId, playerId, now]
  );
  await client.query(
    `UPDATE kingdom_construction_jobs SET status = 'cancelled', cancelled_at = $3
     WHERE status = 'pending' AND (
       (entity_type = 'cot' AND entity_id = ANY($1::uuid[])) OR
       (entity_type = 'decoration' AND entity_id = ANY($2::uuid[]))
     )`,
    [cots.rows.map((row) => row.id), decorations.rows.map((row) => row.id), now]
  );
  await client.query(
    "DELETE FROM kingdom_chat_mutes WHERE kingdom_id = $1 AND player_id = $2",
    [kingdomId, playerId]
  );
  await client.query(
    `UPDATE kingdom_invitations SET status = 'revoked', responded_at = $3
     WHERE kingdom_id = $1 AND target_player_id = $2 AND status = 'pending'`,
    [kingdomId, playerId, now]
  );
  const revisions = new Map<string, string>([
    ...packedCots.rows.map((row) => [row.id, String(row.spatial_revision)] as const),
    ...packedDecorations.rows.map((row) => [row.id, String(row.spatial_revision)] as const)
  ]);
  return [
    ...cots.rows.map((cot) => spatialRemovalChange(spatialObjectEntity({
      id: cot.id,
      kingdomId: cot.kingdom_id,
      kind: "cot",
      typeId: "cot",
      displayName: "Cot",
      lat: Number(cot.lat),
      lon: Number(cot.lon),
      rotation: Number(cot.rotation),
      spatialRevision: String(cot.spatial_revision)
    }), revisions.get(cot.id)!)),
    ...decorations.rows.map((decoration) => spatialRemovalChange(spatialObjectEntity({
      id: decoration.id,
      kingdomId: decoration.kingdom_id,
      kind: "decoration",
      typeId: decoration.type_id,
      displayName: decoration.display_name,
      lat: Number(decoration.lat),
      lon: Number(decoration.lon),
      rotation: Number(decoration.rotation),
      spatialRevision: String(decoration.spatial_revision)
    }), revisions.get(decoration.id)!))
  ];
}

async function insertAudit(
  queryable: Queryable,
  kingdomId: string,
  actorId: string | null,
  targetId: string | null,
  eventType: string,
  entityType: string | null = null,
  entityId: string | null = null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await queryable.query(
    `INSERT INTO kingdom_audit_events (
       id, kingdom_id, actor_player_id, target_player_id, event_type,
       entity_type, entity_id, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [randomUUID(), kingdomId, actorId, targetId, eventType, entityType, entityId, JSON.stringify(metadata)]
  );
}

async function expireRelevantInvitations(
  queryable: Queryable,
  now: Date,
  playerId: string,
  kingdomId: string | null
): Promise<void> {
  await queryable.query(
    `WITH due AS (
       SELECT id FROM kingdom_invitations
       WHERE status = 'pending' AND expires_at <= $1
         AND (target_player_id = $2 OR ($3::uuid IS NOT NULL AND kingdom_id = $3::uuid))
       ORDER BY expires_at, id LIMIT 200
     )
     UPDATE kingdom_invitations invitation SET status = 'expired', responded_at = $1
     FROM due WHERE invitation.id = due.id`,
    [now, playerId, kingdomId]
  );
}

async function assertFoundingPlayerLevel(queryable: Queryable, playerId: string): Promise<void> {
  const result = await queryable.query<{ level: number | null }>(
    "SELECT level FROM player_progression_profiles WHERE player_id = $1",
    [playerId]
  );
  if (Number(result.rows[0]?.level ?? 0) < KINGDOM_FOUNDING_MIN_PLAYER_LEVEL) {
    throw new KingdomError(
      "KINGDOM_FOUNDING_LEVEL_REQUIRED",
      `Reach level ${KINGDOM_FOUNDING_MIN_PLAYER_LEVEL} to found a Kingdom`
    );
  }
}

async function loadFoundingAffordability(
  queryable: Queryable,
  playerId: string,
  cost: readonly KingdomCostLine[]
): Promise<KingdomFoundingAffordabilityLine[]> {
  const lines: KingdomFoundingAffordabilityLine[] = [];
  for (const line of cost) {
    const itemId = requireItemDefinition(line.resourceType).itemId;
    const result = await queryable.query<{ quantity: string | number }>(
      `SELECT quantity FROM player_inventory
      WHERE player_id = $1 AND resource_type = $2 AND variant = $3`,
      [playerId, itemId, DEFAULT_INVENTORY_VARIANT]
    );
    const availableQuantity = Number(result.rows[0]?.quantity ?? 0);
    lines.push({
      resourceType: line.resourceType,
      requiredQuantity: line.quantity,
      availableQuantity,
      missingQuantity: Math.max(0, line.quantity - availableQuantity)
    });
  }
  return lines;
}

async function assertActiveSeatComplete(queryable: Queryable, kingdomId: string): Promise<void> {
  const result = await queryable.query<{ construction_state: string }>(
    `SELECT construction_state FROM kingdom_seats
     WHERE kingdom_id = $1 AND status = 'active' LIMIT 1 FOR UPDATE`,
    [kingdomId]
  );
  if (result.rows[0]?.construction_state !== "complete") {
    throw new KingdomError("KINGDOM_CONSTRUCTION_DISABLED", "The Castle must finish construction first");
  }
}

type ConstructionJobInput = {
  kingdomId: string;
  actorPlayerId: string;
  entityType: "seat" | "cot" | "decoration";
  entityId: string;
  requestId: string;
  quote: KingdomConstructionQuote;
  startedAt: Date;
  completesAt: Date;
};

async function insertConstructionJob(queryable: Queryable, input: ConstructionJobInput): Promise<void> {
  await queryable.query(
    `INSERT INTO kingdom_construction_jobs (
       id, kingdom_id, actor_player_id, entity_type, entity_id, request_id,
       cost_snapshot, rules_version, started_at, completes_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
    [randomUUID(), input.kingdomId, input.actorPlayerId, input.entityType, input.entityId,
      input.requestId, JSON.stringify(input.quote), ENVIRONMENT_RULES_VERSION,
      input.startedAt, input.completesAt]
  );
}

async function cancelConstructionJob(
  queryable: Queryable,
  entityType: "seat" | "cot" | "decoration",
  entityId: string,
  now: Date
): Promise<void> {
  await queryable.query(
    `UPDATE kingdom_construction_jobs SET status = 'cancelled', cancelled_at = $3
     WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending'`,
    [entityType, entityId, now]
  );
}

async function completeDueConstruction(
  pool: pg.Pool,
  kingdomId: string,
  now: Date,
  masteries?: MasteryService
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<{
      id: string;
      entity_type: "seat" | "cot" | "decoration";
      entity_id: string;
      actor_player_id: string;
      cost_snapshot: KingdomConstructionQuote;
    }>(
      `SELECT id, entity_type, entity_id, actor_player_id, cost_snapshot
       FROM kingdom_construction_jobs
       WHERE kingdom_id = $1 AND status = 'pending' AND completes_at <= $2
       ORDER BY completes_at, id LIMIT 100 FOR UPDATE SKIP LOCKED`,
      [kingdomId, now]
    );
    for (const job of due.rows) {
      const table = job.entity_type === "seat"
        ? "kingdom_seats"
        : job.entity_type === "cot" ? "kingdom_cots" : "kingdom_decorations";
      const updated = job.entity_type === "seat"
        ? await client.query(
            `UPDATE ${table} SET construction_state = 'complete', completed_at = $2
             WHERE id = $1 AND status = 'active' AND construction_state = 'under_construction'`,
            [job.entity_id, now]
          )
        : await client.query(
            `UPDATE ${table} SET construction_state = 'complete', completed_at = $2,
               spatial_revision = nextval('kingdom_spatial_revision_seq')
             WHERE id = $1 AND status = 'active' AND construction_state = 'under_construction'`,
            [job.entity_id, now]
          );
      if (updated.rowCount) {
        if (job.entity_type === "seat") {
          await client.query(
            `UPDATE flags
             SET kingdom_founding_request_id = NULL,
                 kingdom_founding_reserved_at = NULL
             WHERE control_type = 'kingdom_seat'
               AND id = (SELECT source_flag_id FROM kingdom_seats WHERE id = $1)`,
            [job.entity_id]
          );
        }
        await client.query(
          `UPDATE kingdom_construction_jobs SET status = 'completed', completed_at = $2
           WHERE id = $1`,
          [job.id, now]
        );
        await bumpKingdomSpatialRevision(client, kingdomId);
        await insertAudit(client, kingdomId, job.actor_player_id, null,
          "construction_completed", job.entity_type, job.entity_id);
        if (masteries) {
          await masteries.grantProfessionXpInTransaction(client, {
            operationKey: `profession-xp:construction:${job.id}`,
            playerId: job.actor_player_id,
            sourceId: job.id,
            activity: {
              kind: "construction",
              baseDurationSeconds: job.cost_snapshot.intendedConstructionSeconds
            }
          });
        }
      } else {
        await client.query(
          `UPDATE kingdom_construction_jobs SET status = 'failed', failed_at = $2,
             failure_code = 'ENTITY_INACTIVE' WHERE id = $1`,
          [job.id, now]
        );
        if (job.entity_type === "seat") {
          await client.query(
            `UPDATE kingdom_seats SET status = 'archived', archived_at = $2
             WHERE id = $1 AND status = 'active'`,
            [job.entity_id, now]
          );
          const dissolved = await client.query(
            `UPDATE kingdoms SET status = 'dissolved', dissolved_at = $2,
               spatial_revision = nextval('kingdom_spatial_revision_seq')
             WHERE id = $1 AND status = 'active'`,
            [kingdomId, now]
          );
          if (dissolved.rowCount) {
            // Same collapse as a voluntary dissolve: no flag leaks behind.
            await lockKingdomFlagNetwork(client, kingdomId);
            await lockFlagControlGeometry(client);
            const members = await client.query<{ player_id: string }>(
              `SELECT player_id FROM kingdom_memberships
               WHERE kingdom_id = $1 AND status = 'active' ORDER BY player_id`,
              [kingdomId]
            );
            await beginKingdomCollapse(
              client, kingdomId, job.actor_player_id, "seat_construction_failed",
              members.rows.map(({ player_id }) => player_id)
            );
            await insertAudit(client, kingdomId, job.actor_player_id, null, "kingdom_dissolved");
          }
          await client.query(
            `UPDATE kingdom_memberships SET status = 'removed', ended_at = $2,
               ended_by_player_id = $3, end_reason = 'seat_construction_failed'
             WHERE kingdom_id = $1 AND status = 'active'`,
            [kingdomId, now, job.actor_player_id]
          );
        }
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function completeDueKingdomProjects(
  pool: pg.Pool,
  kingdomId: string,
  now: Date
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await completeDueKingdomProjectsInTransaction(client, kingdomId, now);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function completeDueKingdomProjectsInTransaction(
  client: Queryable,
  kingdomId: string,
  now: Date
): Promise<void> {
  const due = await client.query<KingdomProjectRow>(
    `SELECT id, kingdom_id, project_type, rules_version, target_level, status,
            actor_player_id, cost_snapshot, xp_snapshot, started_at, completes_at,
            completed_at, cancelled_at, failed_at, failure_code
     FROM kingdom_projects
     WHERE kingdom_id = $1 AND project_type = 'advancement'
       AND status = 'pending' AND completes_at <= $2
     ORDER BY completes_at, id
     LIMIT 100 FOR UPDATE`,
    [kingdomId, now]
  );
  for (const project of due.rows) {
    const kingdom = await lockKingdom(client, kingdomId);
    if (kingdom.status !== "active") {
      await client.query(
        `UPDATE kingdom_projects
         SET status = 'failed', failed_at = $2, failure_code = 'KINGDOM_INACTIVE'
         WHERE id = $1 AND status = 'pending'`,
        [project.id, now]
      );
      continue;
    }
    let snapshot: ProjectXpSnapshot;
    try {
      snapshot = parseProjectXpSnapshot(project.xp_snapshot);
    } catch {
      await client.query(
        `UPDATE kingdom_projects
         SET status = 'failed', failed_at = $2, failure_code = 'INVALID_XP_SNAPSHOT'
         WHERE id = $1 AND status = 'pending'`,
        [project.id, now]
      );
      await insertAudit(
        client,
        kingdomId,
        project.actor_player_id,
        null,
        "advancement_project_failed",
        "project",
        project.id
      );
      continue;
    }

    const targetLevel = Number(project.target_level) as KingdomAdvancementTargetLevel;
    const definition = KINGDOM_ADVANCEMENT_PROJECTS[targetLevel];
    const lifetimeXpBefore = Number(kingdom.lifetime_xp);
    const currentXpBefore = Number(kingdom.current_xp);
    const xpDelta = Math.min(
      snapshot.xpDelta,
      Math.max(0, snapshot.targetLifetimeXp - lifetimeXpBefore)
    );
    const lifetimeXpAfter = lifetimeXpBefore + xpDelta;
    const currentXpAfter = currentXpBefore + xpDelta;
    const levelBefore = Number(kingdom.level);
    const levelAfter = Math.max(levelBefore, targetLevel);
    await client.query(
      `UPDATE kingdoms
       SET current_xp = $2, lifetime_xp = $3, level = $4,
           level_definition_version = $5,
           spatial_revision = CASE WHEN level <> $4
             THEN nextval('kingdom_spatial_revision_seq') ELSE spatial_revision END
       WHERE id = $1`,
      [
        kingdomId,
        currentXpAfter,
        lifetimeXpAfter,
        levelAfter,
        KINGDOM_LEVEL_DEFINITION_VERSION
      ]
    );
    await client.query(
      `INSERT INTO kingdom_xp_ledger (
         id, kingdom_id, source_type, source_id, actor_player_id, request_id,
         xp_delta, xp_before, xp_after, level_before, level_after,
         level_definition_version, metadata
       ) VALUES ($1,$2,'advancement_project',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        randomUUID(),
        kingdomId,
        project.id,
        project.actor_player_id,
        `advancement-project:${project.id}:completion`,
        xpDelta,
        lifetimeXpBefore,
        lifetimeXpAfter,
        levelBefore,
        levelAfter,
        KINGDOM_LEVEL_DEFINITION_VERSION,
        JSON.stringify({
          projectId: project.id,
          projectName: definition.displayName,
          targetLevel,
          snapshottedXpDelta: snapshot.xpDelta,
          targetLifetimeXp: snapshot.targetLifetimeXp
        })
      ]
    );
    const completed = await client.query(
      `UPDATE kingdom_projects
       SET status = 'completed', completed_at = $2
       WHERE id = $1 AND status = 'pending'`,
      [project.id, now]
    );
    if (completed.rowCount !== 1) {
      throw new KingdomError(
        "KINGDOM_ADVANCEMENT_PROJECT_STATE_CHANGED",
        "The advancement project changed while completion was being processed"
      );
    }
    await insertAudit(
      client,
      kingdomId,
      project.actor_player_id,
      null,
      "advancement_project_completed",
      "project",
      project.id,
      { projectName: definition.displayName, targetLevel, xpGranted: xpDelta }
    );
  }
}

async function insertTreasuryExpenditure(
  queryable: Queryable,
  input: {
    kingdomId: string;
    projectId: string;
    actorId: string;
    resourceType: ResourceType;
    variant: string;
    direction: "debit" | "refund";
    quantity: number;
    balanceBefore: number;
    balanceAfter: number;
    sourceType: "project_start" | "project_cancel" | "kingdom_dissolution";
    requestId: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  await queryable.query(
    `INSERT INTO kingdom_treasury_expenditures (
       id, kingdom_id, project_id, actor_player_id, resource_type, variant,
       direction, quantity, balance_before, balance_after, source_type,
       request_id, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [
      randomUUID(),
      input.kingdomId,
      input.projectId,
      input.actorId,
      input.resourceType,
      input.variant,
      input.direction,
      input.quantity,
      input.balanceBefore,
      input.balanceAfter,
      input.sourceType,
      input.requestId,
      JSON.stringify(input.metadata)
    ]
  );
}

async function refundProjectCost(
  client: Queryable,
  input: {
    kingdomId: string;
    projectId: string;
    actorId: string;
    requestId: string;
    sourceType: "project_cancel" | "kingdom_dissolution";
    projectName: string;
    targetLevel: number;
    cost: ProjectCostLine[];
  }
): Promise<void> {
  const cost = [...input.cost].sort((left, right) =>
    left.resourceType.localeCompare(right.resourceType) || left.variant.localeCompare(right.variant)
  );
  for (const line of cost) {
    await client.query(
      `INSERT INTO kingdom_treasury_balances (kingdom_id, resource_type, variant, quantity)
       VALUES ($1,$2,$3,0)
       ON CONFLICT (kingdom_id, resource_type, variant) DO NOTHING`,
      [input.kingdomId, line.resourceType, line.variant]
    );
    const balance = await client.query<{ quantity: string | number }>(
      `SELECT quantity FROM kingdom_treasury_balances
       WHERE kingdom_id = $1 AND resource_type = $2 AND variant = $3
       FOR UPDATE`,
      [input.kingdomId, line.resourceType, line.variant]
    );
    const before = Number(balance.rows[0]?.quantity ?? 0);
    const after = before + line.quantity;
    await client.query(
      `UPDATE kingdom_treasury_balances SET quantity = $4, updated_at = now()
       WHERE kingdom_id = $1 AND resource_type = $2 AND variant = $3`,
      [input.kingdomId, line.resourceType, line.variant, after]
    );
    await insertTreasuryExpenditure(client, {
      kingdomId: input.kingdomId,
      projectId: input.projectId,
      actorId: input.actorId,
      resourceType: line.resourceType,
      variant: line.variant,
      direction: "refund",
      quantity: line.quantity,
      balanceBefore: before,
      balanceAfter: after,
      sourceType: input.sourceType,
      requestId: input.requestId,
      metadata: {
        projectName: input.projectName,
        targetLevel: input.targetLevel
      }
    });
  }
}

async function cancelPendingAdvancementProjectForDissolution(
  client: Queryable,
  kingdomId: string,
  actorId: string,
  requestId: string,
  now: Date
): Promise<void> {
  const result = await client.query<KingdomProjectRow>(
    `SELECT id, kingdom_id, project_type, rules_version, target_level, status,
            actor_player_id, cost_snapshot, xp_snapshot, started_at, completes_at,
            completed_at, cancelled_at, failed_at, failure_code
     FROM kingdom_projects
     WHERE kingdom_id = $1 AND project_type = 'advancement' AND status = 'pending'
     LIMIT 1 FOR UPDATE`,
    [kingdomId]
  );
  const project = result.rows[0];
  if (!project) return;
  const targetLevel = Number(project.target_level) as KingdomAdvancementTargetLevel;
  const definition = KINGDOM_ADVANCEMENT_PROJECTS[targetLevel];
  await refundProjectCost(client, {
    kingdomId,
    projectId: project.id,
    actorId,
    requestId,
    sourceType: "kingdom_dissolution",
    projectName: definition.displayName,
    targetLevel,
    cost: parseProjectCost(project.cost_snapshot)
  });
  await client.query(
    `UPDATE kingdom_projects
     SET status = 'cancelled', cancelled_at = $2
     WHERE id = $1 AND status = 'pending'`,
    [project.id, now]
  );
  await insertAudit(
    client,
    kingdomId,
    actorId,
    null,
    "advancement_project_cancelled",
    "project",
    project.id,
    { projectName: definition.displayName, targetLevel, reason: "kingdom_dissolved" }
  );
}

function permissionForMemberAction(action: KingdomMemberActionInput["action"]): KingdomPermission {
  if (action === "remove") return "remove_members";
  if (action === "ban" || action === "unban") return "ban_members";
  if (action === "transfer_leadership") return "transfer_leadership";
  return "manage_roles";
}

function assertRoleAuthority(
  actor: KingdomRole,
  target: KingdomRole,
  action: KingdomMemberActionInput["action"]
): void {
  if (action === "transfer_leadership") return;
  if (!canModerateKingdomRole(actor, target, false)) {
    throw new KingdomError("KINGDOM_PERMISSION_DENIED", "The actor cannot manage an equal or higher Kingdom role");
  }
}

function assertDecorationPlacementPermission(
  role: KingdomRole,
  definition: KingdomDecorationDefinition
): void {
  if (definition.officersOnly && role === "member") {
    throw new KingdomError("KINGDOM_PERMISSION_DENIED", "This decoration may only be placed by an officer or leader");
  }
  if (!definition.membersMayPlace && role === "member") {
    throw new KingdomError("KINGDOM_PERMISSION_DENIED", "Members cannot place this decoration");
  }
}

function assertDecorationMutationPermission(
  actor: ActorContext,
  decoration: DecorationLockRow,
  action: "move" | "remove"
): void {
  const permission = action === "move" ? "move_decorations" : "remove_decorations";
  const isPersonalOwner = decoration.personal_owner_player_id === actor.playerId;
  if (!isPersonalOwner && !hasKingdomPermission(actor.role, permission)) {
    throw new KingdomError("KINGDOM_PERMISSION_DENIED", "The actor cannot modify this decoration");
  }
  if (decoration.kingdom_owned && !hasKingdomPermission(actor.role, "manage_kingdom_decorations")) {
    throw new KingdomError("KINGDOM_PERMISSION_DENIED", "Kingdom-owned decorations require management permission");
  }
}

async function assertSeatPlacementAvailable(
  queryable: Queryable,
  source: FoundingSourceFlagRow,
  seatPosition: { lat: number; lon: number },
  territoryRadiusM: number,
  minimumSeatSpacingM: number,
  request: { actorPlayerId: string; requestId: string }
): Promise<void> {
  const result = await queryable.query<{
    id: string;
    kingdom_id: string;
    territory_radius_m: number;
    seat_distance_m: number;
    territory_distance_m: number;
    construction_state: "under_construction" | "complete";
    pending_job_id: string | null;
  }>(
    `SELECT s.id, s.kingdom_id, s.territory_radius_m, s.construction_state,
            pending_job.id AS pending_job_id,
            ST_Distance(
              s.geom::geography,
              ST_SetSRID(ST_MakePoint($1,$2),4326)::geography
            ) AS seat_distance_m,
            ST_Distance(
              COALESCE(existing_source.geom, s.geom)::geography,
              candidate_source.geom::geography
            ) AS territory_distance_m
     FROM kingdom_seats s
     JOIN kingdoms k ON k.id = s.kingdom_id
     LEFT JOIN flags existing_source ON existing_source.id = s.source_flag_id
     JOIN flags candidate_source ON candidate_source.id = $5
     LEFT JOIN kingdom_construction_jobs pending_job
       ON pending_job.entity_type = 'seat'
      AND pending_job.entity_id = s.id
      AND pending_job.status = 'pending'
     WHERE s.status = 'active' AND k.status = 'active'
       AND (
         s.construction_state = 'complete'
         OR (
           s.construction_state = 'under_construction'
           AND pending_job.id IS NOT NULL
           AND NOT (
             pending_job.actor_player_id = $6
             AND pending_job.request_id = $7
           )
         )
       )
       AND (
         ST_DWithin(
           s.geom::geography,
           ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
           $3
         )
         OR ST_DWithin(
           COALESCE(existing_source.geom, s.geom)::geography,
           candidate_source.geom::geography,
           s.territory_radius_m + $4
         )
       )
     ORDER BY s.id FOR UPDATE OF s`,
    [
      seatPosition.lon,
      seatPosition.lat,
      minimumSeatSpacingM,
      territoryRadiusM,
      source.id,
      request.actorPlayerId,
      request.requestId
    ]
  );
  for (const row of result.rows) {
    const seatDistance = Number(row.seat_distance_m);
    const territoryDistance = Number(row.territory_distance_m);
    const overlapDistance = Number(row.territory_radius_m) + territoryRadiusM;
    const territoryOverlaps = territoryDistance < overlapDistance;
    const seatTooClose = seatDistance < minimumSeatSpacingM;
    const details = {
      candidateSeatLat: seatPosition.lat,
      candidateSeatLon: seatPosition.lon,
      candidateSourceFlagId: source.id,
      candidateSourceTerritoryLat: Number(source.lat),
      candidateSourceTerritoryLon: Number(source.lon),
      candidateRadiusM: territoryRadiusM,
      conflictingEntityType: row.pending_job_id ? "pending_kingdom_seat" : "kingdom_seat",
      conflictingKingdomId: row.kingdom_id,
      conflictingSeatId: row.id,
      conflictingConstructionJobId: row.pending_job_id,
      conflictingRadiusM: Number(row.territory_radius_m),
      seatDistanceM: seatDistance,
      territoryDistanceM: territoryDistance,
      requiredSeatDistanceM: minimumSeatSpacingM,
      territoryOverlapDistanceM: overlapDistance,
      constructionState: row.construction_state,
      constructionJobStatus: row.pending_job_id ? "pending" : null
    };
    if (row.pending_job_id && (territoryOverlaps || seatTooClose)) {
      throw new KingdomError(
        "KINGDOM_PENDING_RESERVATION_CONFLICT",
        "The proposed Castle conflicts with a pending Kingdom construction reservation",
        details
      );
    }
    if (territoryOverlaps) {
      throw new KingdomError(
        "KINGDOM_TERRITORY_OVERLAP",
        "The proposed Kingdom territory overlaps another Kingdom",
        details
      );
    }
    if (seatTooClose) {
      throw new KingdomError(
        "KINGDOM_SEAT_TOO_CLOSE",
        "The proposed Castle is too close to another Castle",
        details
      );
    }
  }
  const kingdomFlagConflict = await queryable.query<{
    id: string; kingdom_id: string; claim_radius_m: number; distance_m: number;
  }>(
    `SELECT flag.id, flag.kingdom_id, flag.claim_radius_m,
            ST_Distance(
              flag.geom::geography,
              source.geom::geography
            ) AS distance_m
     FROM flags flag
     JOIN flags source ON source.id = $1
     JOIN kingdoms kingdom ON kingdom.id = flag.kingdom_id
     WHERE flag.control_type = 'kingdom'
       AND kingdom.status = 'active'
       AND ST_Distance(
         flag.geom::geography,
         source.geom::geography
       ) < flag.claim_radius_m + $2::double precision - $3::double precision
     ORDER BY ST_Distance(
       flag.geom::geography,
       source.geom::geography
     ), flag.id
     LIMIT 1`,
    [source.id, territoryRadiusM, FLAG_CONTROL_TOUCH_TOLERANCE_M]
  );
  if (kingdomFlagConflict.rows[0]) {
    const conflict = kingdomFlagConflict.rows[0];
    throw new KingdomError(
      "KINGDOM_FLAG_TERRITORY_OVERLAP",
      "The proposed Castle overlaps a Kingdom Flag territory",
      {
        candidateSourceFlagId: source.id,
        candidateSourceTerritoryLat: Number(source.lat),
        candidateSourceTerritoryLon: Number(source.lon),
        candidateSeatLat: seatPosition.lat,
        candidateSeatLon: seatPosition.lon,
        candidateRadiusM: territoryRadiusM,
        conflictingEntityType: "kingdom_flag",
        conflictingKingdomId: conflict.kingdom_id,
        conflictingFlagId: conflict.id,
        conflictingRadiusM: Number(conflict.claim_radius_m),
        distanceM: Number(conflict.distance_m),
        requiredDistanceM: Number(conflict.claim_radius_m) + territoryRadiusM - FLAG_CONTROL_TOUCH_TOLERANCE_M,
        controlType: "kingdom"
      }
    );
  }
}

async function assertInsideTerritory(
  queryable: Queryable,
  kingdomId: string,
  position: { lat: number; lon: number },
  footprintRadiusM: number
): Promise<void> {
  const result = await queryable.query(
    `SELECT seat.id FROM kingdom_seats seat
     LEFT JOIN flags source ON source.id = seat.source_flag_id
     WHERE seat.kingdom_id = $1 AND seat.status = 'active'
       AND seat.territory_radius_m > $4
       AND ST_DWithin(
         COALESCE(source.geom, seat.geom)::geography,
         ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
         seat.territory_radius_m - $4
       ) LIMIT 1`,
    [kingdomId, position.lon, position.lat, footprintRadiusM]
  );
  if (!result.rowCount) {
    throw new KingdomError("KINGDOM_OUTSIDE_TERRITORY", "Placement must remain fully inside Kingdom territory");
  }
}

async function assertNoPlacementCollision(
  queryable: Queryable,
  kingdomId: string,
  position: { lat: number; lon: number },
  footprintRadiusM: number,
  seatFootprintRadiusM: number,
  excludedCotId: string | null = null,
  excludedDecorationId: string | null = null
): Promise<void> {
  const result = await queryable.query<{ kind: string; id: string }>(
    `SELECT kind, id FROM (
       SELECT 'seat'::text AS kind, s.id
       FROM kingdom_seats s
       WHERE s.kingdom_id = $1 AND s.status = 'active'
         AND ST_DWithin(s.geom::geography,
           ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
           $4::double precision + $5::double precision)
       UNION ALL
       SELECT 'cot', c.id FROM kingdom_cots c
       WHERE c.kingdom_id = $1 AND c.status = 'active'
         AND ($6::uuid IS NULL OR c.id <> $6::uuid)
         AND ST_DWithin(c.geom::geography,
           ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
           c.footprint_radius_m + $4::double precision)
       UNION ALL
       SELECT 'decoration', d.id FROM kingdom_decorations d
       WHERE d.kingdom_id = $1 AND d.status = 'active'
         AND ($7::uuid IS NULL OR d.id <> $7::uuid)
         AND ST_DWithin(d.geom::geography,
           ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
           d.footprint_radius_m + $4::double precision)
     ) collisions LIMIT 1`,
    [kingdomId, position.lon, position.lat, footprintRadiusM, seatFootprintRadiusM,
      excludedCotId, excludedDecorationId]
  );
  if (result.rows[0]) {
    throw new KingdomError("KINGDOM_PLACEMENT_COLLISION", `Placement overlaps an active ${result.rows[0].kind}`);
  }
}

async function assertLandOnlyFootprint(
  worldLookup: Pick<WorldLookupClient, "lookupGameplayEnvironments">,
  position: { lat: number; lon: number },
  footprintRadiusM: number
): Promise<void> {
  let water: Awaited<ReturnType<typeof classifyLandFootprint>>;
  try {
    water = await classifyLandFootprint(worldLookup, position, footprintRadiusM);
  } catch {
    throw new KingdomError(
      "KINGDOM_WORLD_AUTHORITY_UNAVAILABLE",
      "Placement requires authoritative footprint validation"
    );
  }
  if (water === "river") {
    throw new KingdomError("KINGDOM_WATER_REJECTED", "Cannot build on river water.");
  }
  if (water === "other-water") {
    throw new KingdomError("KINGDOM_WATER_REJECTED", "Cannot build on water.");
  }
}

async function decorationCapacityUsed(queryable: Queryable, kingdomId: string): Promise<number> {
  const result = await queryable.query<{ used: string }>(
    `SELECT COALESCE(sum(capacity_cost), 0)::text AS used
     FROM kingdom_decorations WHERE kingdom_id = $1 AND status = 'active'`,
    [kingdomId]
  );
  return Number(result.rows[0]?.used ?? 0);
}

async function loadSeatEnvironment(
  queryable: Queryable,
  kingdomId: string
): Promise<KingdomEnvironmentSnapshot> {
  const result = await queryable.query<SeatRow>(
    `${SEAT_COLUMNS} WHERE kingdom_id = $1 AND status = 'active' LIMIT 1`,
    [kingdomId]
  );
  const row = result.rows[0];
  if (!row) throw new KingdomError("KINGDOM_NOT_FOUND", "Active Castle not found");
  return seatFromRow(row).environment;
}

function environmentSnapshot(world: WorldLookupResult, lookedUpAt: Date): KingdomEnvironmentSnapshot {
  const elevationM = world.elevationM ?? null;
  const slope = world.slope ?? null;
  return {
    terrainClass: world.terrainClass,
    biome: world.biome,
    ecoregion: world.ecoregion,
    elevationM,
    elevationBand: elevationBand(elevationM),
    slope,
    slopeBand: slopeBand(slope),
    isLand: world.isLand === true,
    isSaltwater: world.isSaltwater === true,
    insideMajorLake: world.insideMajorLake === true,
    worldReleaseId: world.worldReleaseId ?? null,
    worldReleaseVersion: world.worldReleaseVersion ?? null,
    worldPackageId: world.packageId ?? null,
    environmentSchemaVersion: world.environmentSchemaVersion ?? null,
    environmentRulesVersion: ENVIRONMENT_RULES_VERSION,
    sourceVersions: { ...(world.sourceVersions ?? {}) },
    lookedUpAt: lookedUpAt.toISOString()
  };
}

function elevationBand(value: number | null): string | null {
  if (value === null) return null;
  if (value >= 2_500) return "high";
  if (value >= 1_500) return "elevated";
  if (value >= 500) return "mid";
  return "low";
}

function slopeBand(value: number | null): string | null {
  if (value === null) return null;
  if (value >= 30) return "steep";
  if (value >= 15) return "sloped";
  if (value >= 5) return "rolling";
  return "flat";
}

function normalizeDescription(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  rejectControlCharacters(value, true);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return null;
  if (Array.from(normalized).length > 500) {
    throw new KingdomError("KINGDOM_VALIDATION_FAILED", "Kingdom description must be at most 500 characters");
  }
  return normalized;
}

function normalizeEmblem(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(normalized)) {
    throw new KingdomError("KINGDOM_VALIDATION_FAILED", "Kingdom emblem key is invalid");
  }
  return normalized;
}

function normalizeKingdomColor(value: string | undefined): string {
  const normalized = value ?? DEFAULT_KINGDOM_COLOR;
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new KingdomError("KINGDOM_VALIDATION_FAILED", "Kingdom color must be a six-digit hex color");
  }
  return normalized.toLowerCase();
}

function normalizeChat(value: string): string {
  rejectControlCharacters(value, true);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized || Array.from(normalized).length > 500) {
    throw new KingdomError("KINGDOM_CHAT_INVALID", "Kingdom chat messages must contain 1-500 characters");
  }
  return normalized;
}

function rejectControlCharacters(value: string, allowLineFeed: boolean): void {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 && !(allowLineFeed && (character === "\n" || character === "\t"))) {
      throw new KingdomError("KINGDOM_VALIDATION_FAILED", "Unsupported control character");
    }
  }
}

function normalizeVariant(value: string | null | undefined): string {
  if (value === null || value === undefined) return DEFAULT_INVENTORY_VARIANT;
  const normalized = value.trim();
  if (!normalized || normalized.length > 80) {
    throw new KingdomError("KINGDOM_DONATION_INVALID", "Inventory variant is invalid");
  }
  return normalized;
}

function normalizeRotation(value: number | undefined): number {
  const rotation = value ?? 0;
  if (!Number.isFinite(rotation) || rotation < -360 || rotation > 360) {
    throw new KingdomError("KINGDOM_VALIDATION_FAILED", "Rotation must be between -360 and 360 degrees");
  }
  return rotation;
}

function validateRequestId(requestId: string): void {
  if (!requestId || requestId.length > 128) {
    throw new KingdomError("KINGDOM_VALIDATION_FAILED", "Request id must contain 1-128 characters");
  }
}

function requestHash(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function durableOperationKey(kind: string, actorId: string, requestId: string): string {
  return `${kind}:${createHash("sha256").update(`${actorId}\0${requestId}`).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function assertReplayMatches(row: RequestRow, operation: string, hash: string): void {
  if (row.operation !== operation || row.request_hash !== hash) {
    throw new KingdomError(
      "KINGDOM_REQUEST_CONFLICT",
      "Request id was already used for a different Kingdom action"
    );
  }
}

type SeatRow = {
  id: string;
  kingdom_id: string;
  lat: number;
  lon: number;
  territory_radius_m: number;
  terrain_class: string | null;
  biome: string | null;
  ecoregion: string | null;
  elevation_m: number | null;
  elevation_band: string | null;
  slope: number | null;
  slope_band: string | null;
  is_land: boolean;
  is_saltwater: boolean;
  inside_major_lake: boolean;
  world_release_id: string | null;
  world_release_version: string | null;
  world_package_id: string | null;
  environment_schema_version: string | null;
  environment_source_versions: Record<string, string>;
  environment_rules_version: number;
  environment_modifiers: KingdomEnvironmentModifier[];
  environment_lookup_at: Date | string;
  construction_state: "under_construction" | "complete";
  completed_under_free_construction: boolean;
  status: "active" | "archived" | "relocating";
  created_at: Date | string;
  completed_at: Date | string | null;
  construction_completes_at: Date | string | null;
  source_flag_id: string | null;
};

type PublicKingdomRow = SeatRow & {
  kingdom_id_value: string;
  normalized_name: string;
  display_name: string;
  display_color: string;
  description: string | null;
  emblem_key: string | null;
  founder_player_id: string;
  leader_player_id: string;
  kingdom_status: "active" | "dissolved" | "archived";
  level: number;
  current_xp: string | number;
  lifetime_xp: string | number;
  level_definition_version: number;
  kingdom_created_at: Date | string;
  member_count: string | number;
  kingdom_flag_count: string | number;
  spatial_revision: string | number;
  castle_ruined_at?: Date | string | null;
};

type ActiveMembershipLoaded = {
  membershipId: string;
  kingdomId: string;
  role: KingdomRole;
  perkQualifiedAt: Date;
  snapshot: KingdomMemberSnapshot;
};

const SEAT_COLUMNS = `
  SELECT id, kingdom_id, lat, lon, territory_radius_m, terrain_class, biome, ecoregion,
         elevation_m, elevation_band, slope, slope_band, is_land, is_saltwater,
         inside_major_lake, world_release_id, world_release_version, world_package_id,
         environment_schema_version, environment_source_versions, environment_rules_version,
         environment_modifiers, environment_lookup_at, construction_state,
         completed_under_free_construction, status, created_at, completed_at,
         source_flag_id,
         (SELECT job.completes_at FROM kingdom_construction_jobs job
          WHERE job.entity_type = 'seat' AND job.entity_id = kingdom_seats.id LIMIT 1)
           AS construction_completes_at
  FROM kingdom_seats`;

const PUBLIC_KINGDOM_SELECT = `
  SELECT k.id AS kingdom_id_value, k.normalized_name, k.display_name, k.description,
         k.emblem_key, k.display_color, k.founder_player_id, k.leader_player_id,
         k.spatial_revision, k.castle_ruined_at,
         k.status AS kingdom_status, k.level, k.current_xp, k.lifetime_xp,
         k.level_definition_version, k.created_at AS kingdom_created_at,
         (SELECT count(*) FROM kingdom_memberships m
          WHERE m.kingdom_id = k.id AND m.status = 'active') AS member_count,
          (SELECT count(*) FROM flags flag
           WHERE flag.kingdom_id = k.id AND flag.control_type = 'kingdom') AS kingdom_flag_count,
         s.id, s.kingdom_id, s.lat, s.lon, s.territory_radius_m,
         s.terrain_class, s.biome, s.ecoregion, s.elevation_m, s.elevation_band,
         s.slope, s.slope_band, s.is_land, s.is_saltwater, s.inside_major_lake,
         s.world_release_id, s.world_release_version, s.world_package_id,
         s.environment_schema_version, s.environment_source_versions,
         s.environment_rules_version, s.environment_modifiers, s.environment_lookup_at,
         s.construction_state, s.completed_under_free_construction, s.status,
         s.created_at, s.completed_at, s.source_flag_id,
         (SELECT job.completes_at FROM kingdom_construction_jobs job
          WHERE job.entity_type = 'seat' AND job.entity_id = s.id LIMIT 1)
           AS construction_completes_at
  FROM kingdoms k
  LEFT JOIN kingdom_seats s ON s.kingdom_id = k.id AND s.status = 'active'`;

async function loadPublicKingdom(
  queryable: Queryable,
  kingdomId: string
): Promise<KingdomPublicSnapshot | null> {
  const result = await queryable.query<PublicKingdomRow>(
    `${PUBLIC_KINGDOM_SELECT} WHERE k.id = $1 LIMIT 1`,
    [kingdomId]
  );
  return result.rows[0] ? publicKingdomFromRow(result.rows[0]) : null;
}

function spatialSeatEntity(kingdom: KingdomPublicSnapshot): KingdomSpatialEntity {
  if (!kingdom.seat) {
    throw new KingdomError("KINGDOM_NOT_FOUND", "Active Castle not found");
  }
  return {
    entityType: "seat",
    id: kingdom.seat.id,
    kingdomId: kingdom.id,
    kingdom
  };
}

function spatialObjectEntity(object: NearbyKingdomObjectSnapshot): KingdomSpatialEntity {
  return {
    entityType: "object",
    id: object.id,
    kingdomId: object.kingdomId,
    objectKind: object.kind,
    object
  };
}

function spatialUpsertChange(
  previous: KingdomSpatialEntity | null,
  current: KingdomSpatialEntity
): KingdomSpatialChange {
  return { previous, current, spatialRevision: spatialEntityRevision(current) };
}

function spatialRemovalChange(
  previous: KingdomSpatialEntity,
  spatialRevision: string | number
): KingdomSpatialChange {
  return { previous, current: null, spatialRevision: String(spatialRevision) };
}

function spatialEntityRevision(entity: KingdomSpatialEntity): string {
  return entity.entityType === "seat"
    ? entity.kingdom.spatialRevision
    : entity.object.spatialRevision;
}

async function bumpKingdomSpatialRevision(client: Queryable, kingdomId: string): Promise<string> {
  const result = await client.query<{ spatial_revision: string | number }>(
    `UPDATE kingdoms SET spatial_revision = nextval('kingdom_spatial_revision_seq')
     WHERE id = $1 RETURNING spatial_revision`,
    [kingdomId]
  );
  return String(result.rows[0]!.spatial_revision);
}

async function loadKingdomSpatialEntities(
  queryable: Queryable,
  kingdomId: string
): Promise<KingdomSpatialEntity[]> {
  const kingdom = await loadPublicKingdom(queryable, kingdomId);
  const objects = await queryable.query<{
    id: string;
    kingdom_id: string;
    kind: "cot" | "decoration";
    type_id: KingdomDecorationTypeId | "cot";
    display_name: string;
    lat: number;
    lon: number;
    rotation: number;
    spatial_revision: string | number;
  }>(
    `SELECT cot.id, cot.kingdom_id, 'cot'::text AS kind, 'cot'::text AS type_id,
            'Cot'::text AS display_name, cot.lat, cot.lon, cot.rotation, cot.spatial_revision
     FROM kingdom_cots cot
     WHERE cot.kingdom_id = $1 AND cot.status = 'active'
     UNION ALL
     SELECT decoration.id, decoration.kingdom_id, 'decoration'::text,
            decoration.type_id, definition.display_name,
            decoration.lat, decoration.lon, decoration.rotation, decoration.spatial_revision
     FROM kingdom_decorations decoration
     JOIN kingdom_decoration_definitions definition ON definition.type_id = decoration.type_id
     WHERE decoration.kingdom_id = $1 AND decoration.status = 'active'`,
    [kingdomId]
  );
  return [
    ...(kingdom?.seat ? [spatialSeatEntity(kingdom)] : []),
    ...objects.rows.map((row) => spatialObjectEntity({
      id: row.id,
      kingdomId: row.kingdom_id,
      kind: row.kind,
      typeId: row.type_id,
      displayName: row.display_name,
      lat: Number(row.lat),
      lon: Number(row.lon),
      rotation: Number(row.rotation),
      spatialRevision: String(row.spatial_revision)
    }))
  ];
}

async function loadSpatialRevision(queryable: Queryable): Promise<string> {
  const result = await queryable.query<{ revision: string | number }>(
    `SELECT GREATEST(
       COALESCE((SELECT max(spatial_revision) FROM kingdoms), 0),
       COALESCE((SELECT max(spatial_revision) FROM kingdom_cots), 0),
       COALESCE((SELECT max(spatial_revision) FROM kingdom_decorations), 0)
     ) AS revision`
  );
  return String(result.rows[0]?.revision ?? 0);
}

async function loadKingdomXp(
  queryable: Queryable,
  kingdomId: string
): Promise<{ currentXp: number; lifetimeXp: number } | null> {
  const result = await queryable.query<{ current_xp: string | number; lifetime_xp: string | number }>(
    "SELECT current_xp, lifetime_xp FROM kingdoms WHERE id = $1",
    [kingdomId]
  );
  const row = result.rows[0];
  return row ? { currentXp: Number(row.current_xp), lifetimeXp: Number(row.lifetime_xp) } : null;
}

function publicKingdomFromRow(row: PublicKingdomRow): KingdomPublicSnapshot {
  return {
    id: row.kingdom_id_value,
    displayName: row.display_name,
    displayColor: row.display_color,
    description: row.description,
    emblemKey: row.emblem_key,
    founderPlayerId: row.founder_player_id,
    leaderPlayerId: row.leader_player_id,
    level: Number(row.level),
    memberCount: Number(row.member_count),
    kingdomFlagCount: Number(row.kingdom_flag_count),
    spatialRevision: String(row.spatial_revision),
    status: row.kingdom_status,
    seat: row.id ? seatFromRow(row) : null,
    ...(row.castle_ruined_at ? { castleRuinedAt: iso(row.castle_ruined_at) } : {}),
    createdAt: iso(row.kingdom_created_at)
  };
}

function seatFromRow(row: SeatRow): KingdomSeatSnapshot {
  return {
    id: row.id,
    kingdomId: row.kingdom_id,
    lat: Number(row.lat),
    lon: Number(row.lon),
    territoryRadiusM: Number(row.territory_radius_m),
    environment: {
      terrainClass: row.terrain_class,
      biome: row.biome,
      ecoregion: row.ecoregion,
      elevationM: nullableNumber(row.elevation_m),
      elevationBand: row.elevation_band,
      slope: nullableNumber(row.slope),
      slopeBand: row.slope_band,
      isLand: row.is_land,
      isSaltwater: row.is_saltwater,
      insideMajorLake: row.inside_major_lake,
      worldReleaseId: row.world_release_id,
      worldReleaseVersion: row.world_release_version,
      worldPackageId: row.world_package_id,
      environmentSchemaVersion: row.environment_schema_version,
      environmentRulesVersion: Number(row.environment_rules_version),
      sourceVersions: row.environment_source_versions ?? {},
      lookedUpAt: iso(row.environment_lookup_at)
    },
    environmentModifiers: row.environment_modifiers ?? [],
    environmentRulesVersion: Number(row.environment_rules_version),
    constructionState: row.construction_state,
    constructionCompletesAt: row.construction_completes_at ? iso(row.construction_completes_at) : null,
    completedUnderFreeConstruction: row.completed_under_free_construction,
    status: row.status,
    createdAt: iso(row.created_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    sourceFlagId: row.source_flag_id
  };
}

async function loadActiveMembership(
  queryable: Queryable,
  playerId: string
): Promise<ActiveMembershipLoaded | null> {
  const result = await queryable.query<{
    id: string;
    kingdom_id: string;
    player_id: string;
    username: string;
    role: KingdomRole;
    status: "active";
    joined_at: Date | string;
    ended_at: null;
    perk_qualified_at: Date | string;
    chat_muted_until: Date | string | null;
    chat_mute_exists: boolean;
  }>(
    `SELECT m.id, m.kingdom_id, m.player_id, p.username, m.role, m.status,
            m.joined_at, m.ended_at, m.perk_qualified_at,
            mute.muted_until AS chat_muted_until, (mute.player_id IS NOT NULL) AS chat_mute_exists
     FROM kingdom_memberships m
     JOIN kingdoms k ON k.id = m.kingdom_id AND k.status = 'active'
     JOIN players p ON p.id = m.player_id
     LEFT JOIN kingdom_chat_mutes mute
       ON mute.kingdom_id = m.kingdom_id AND mute.player_id = m.player_id
     WHERE m.player_id = $1 AND m.status = 'active' LIMIT 1`,
    [playerId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const perkQualifiedAt = asDate(row.perk_qualified_at);
  return {
    membershipId: row.id,
    kingdomId: row.kingdom_id,
    role: row.role,
    perkQualifiedAt,
    snapshot: memberSnapshot(row)
  };
}

async function loadRoster(
  queryable: Queryable,
  kingdomId: string,
  includeBanned: boolean
): Promise<KingdomMemberSnapshot[]> {
  const result = await queryable.query<{
    id: string;
    player_id: string;
    username: string;
    role: KingdomRole;
    status: "active" | "banned";
    joined_at: Date | string;
    ended_at: Date | string | null;
    perk_qualified_at: Date | string;
    chat_muted_until: Date | string | null;
    chat_mute_exists: boolean;
  }>(
    `SELECT m.id, m.player_id, p.username, m.role, m.status, m.joined_at,
            m.ended_at, m.perk_qualified_at, mute.muted_until AS chat_muted_until,
            (mute.player_id IS NOT NULL) AS chat_mute_exists
     FROM kingdom_memberships m JOIN players p ON p.id = m.player_id
     LEFT JOIN kingdom_chat_mutes mute
       ON mute.kingdom_id = m.kingdom_id AND mute.player_id = m.player_id
      WHERE m.kingdom_id = $1
        AND (m.status = 'active' OR ($2::boolean AND m.status = 'banned'))
      ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END,
               CASE m.role WHEN 'leader' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END,
               m.joined_at, m.player_id
      LIMIT 200`,
    [kingdomId, includeBanned]
  );
  return result.rows.map(memberSnapshot);
}

function memberSnapshot(row: {
  id: string;
  player_id: string;
  username: string;
  role: KingdomRole;
  status: "active" | "left" | "removed" | "banned";
  joined_at: Date | string;
  ended_at: Date | string | null;
  perk_qualified_at: Date | string;
  chat_muted_until: Date | string | null;
  chat_mute_exists: boolean;
}): KingdomMemberSnapshot {
  return {
    membershipId: row.id,
    playerId: row.player_id,
    displayName: row.username,
    role: row.role,
    status: row.status,
    joinedAt: iso(row.joined_at),
    endedAt: row.ended_at ? iso(row.ended_at) : null,
    perkQualifiedAt: iso(row.perk_qualified_at),
    chatMutedUntil: row.chat_muted_until ? iso(row.chat_muted_until) : null,
    chatMute: !row.chat_mute_exists
      ? { state: "not_muted" }
      : row.chat_muted_until
        ? { state: "muted_until", mutedUntil: iso(row.chat_muted_until) }
        : { state: "muted_indefinitely" }
  };
}

async function loadInvitations(
  queryable: Queryable,
  playerId: string,
  kingdomId: string | null,
  canManageKingdomInvitations: boolean,
  now: Date
): Promise<KingdomInvitationSnapshot[]> {
  const result = await queryable.query<{
    id: string;
    kingdom_id: string;
    kingdom_name: string;
    target_player_id: string;
    target_name: string;
    invited_by_player_id: string;
    status: KingdomInvitationSnapshot["status"];
    created_at: Date | string;
    expires_at: Date | string;
    responded_at: Date | string | null;
  }>(
    `SELECT i.id, i.kingdom_id, k.display_name AS kingdom_name,
            i.target_player_id, p.username AS target_name, i.invited_by_player_id,
            i.status, i.created_at, i.expires_at, i.responded_at
     FROM kingdom_invitations i
     JOIN kingdoms k ON k.id = i.kingdom_id
     JOIN players p ON p.id = i.target_player_id
     WHERE (
       i.target_player_id = $1
       OR i.invited_by_player_id = $1
       OR ($2::uuid IS NOT NULL AND $3::boolean AND i.kingdom_id = $2::uuid)
     )
       AND (
         i.status = 'pending'
         OR COALESCE(i.responded_at, i.created_at) > $4::timestamptz - interval '90 days'
       )
     ORDER BY i.created_at DESC, i.id LIMIT 200`,
    [playerId, kingdomId, canManageKingdomInvitations, now]
  );
  return result.rows.map((row) => ({
    id: row.id,
    kingdomId: row.kingdom_id,
    kingdomName: row.kingdom_name,
    targetPlayerId: row.target_player_id,
    targetDisplayName: row.target_name,
    invitedByPlayerId: row.invited_by_player_id,
    status: row.status,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    respondedAt: row.responded_at ? iso(row.responded_at) : null
  }));
}

async function loadChatHistory(
  queryable: Queryable,
  kingdomId: string,
  viewerPlayerId: string,
  limit: number
): Promise<KingdomChatMessage[]> {
  const result = await queryable.query<{
    id: string;
    kingdom_id: string;
    sender_player_id: string;
    sender_name: string;
    content: string;
    created_at: Date | string;
  }>(
    `SELECT message.id, message.kingdom_id, message.sender_player_id,
            p.username AS sender_name, message.content, message.created_at
      FROM kingdom_chat_messages message
      JOIN players p ON p.id = message.sender_player_id
      WHERE message.kingdom_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM player_blocks block
          WHERE (block.blocker_id = $2 AND block.blocked_id = message.sender_player_id)
             OR (block.blocker_id = message.sender_player_id AND block.blocked_id = $2)
        )
      ORDER BY message.created_at DESC, message.id DESC LIMIT $3`,
    [kingdomId, viewerPlayerId, Math.max(1, Math.min(limit, 500))]
  );
  return result.rows.reverse().map((row) => ({
    id: row.id,
    kingdomId: row.kingdom_id,
    senderPlayerId: row.sender_player_id,
    senderDisplayName: row.sender_name,
    content: row.content,
    createdAt: iso(row.created_at)
  }));
}

async function loadTreasury(queryable: Queryable, kingdomId: string): Promise<KingdomTreasuryBalance[]> {
  const result = await queryable.query<{
    resource_type: ResourceType;
    variant: string;
    quantity: string | number;
  }>(
    `SELECT resource_type, variant, quantity FROM kingdom_treasury_balances
     WHERE kingdom_id = $1 ORDER BY resource_type, variant`,
    [kingdomId]
  );
  return result.rows.map((row) => ({
    resourceType: row.resource_type,
    variant: row.variant === DEFAULT_INVENTORY_VARIANT ? null : row.variant,
    quantity: Number(row.quantity)
  }));
}

async function loadDonations(
  queryable: Queryable,
  kingdomId: string,
  limit: number
): Promise<KingdomDonationEntry[]> {
  const result = await queryable.query<{
    id: string;
    kingdom_id: string;
    donor_player_id: string;
    donor_name: string;
    resource_type: ResourceType;
    variant: string;
    quantity: number;
    player_balance_before: number;
    player_balance_after: number;
    treasury_balance_before: string | number;
    treasury_balance_after: string | number;
    kingdom_xp_granted: number;
    created_at: Date | string;
  }>(
    `SELECT d.id, d.kingdom_id, d.donor_player_id,
            p.username AS donor_name, d.resource_type, d.variant, d.quantity,
            d.player_balance_before, d.player_balance_after,
            d.treasury_balance_before, d.treasury_balance_after,
            d.kingdom_xp_granted, d.created_at
     FROM kingdom_donations d JOIN players p ON p.id = d.donor_player_id
     WHERE d.kingdom_id = $1
     ORDER BY d.created_at DESC, d.id DESC LIMIT $2`,
    [kingdomId, Math.max(1, Math.min(limit, 500))]
  );
  return result.rows.map((row) => ({
    id: row.id,
    kingdomId: row.kingdom_id,
    donorPlayerId: row.donor_player_id,
    donorDisplayName: row.donor_name,
    resourceType: row.resource_type,
    variant: row.variant === DEFAULT_INVENTORY_VARIANT ? null : row.variant,
    quantity: Number(row.quantity),
    playerBalanceBefore: Number(row.player_balance_before),
    playerBalanceAfter: Number(row.player_balance_after),
    treasuryBalanceBefore: Number(row.treasury_balance_before),
    treasuryBalanceAfter: Number(row.treasury_balance_after),
    kingdomXpGranted: Number(row.kingdom_xp_granted),
    createdAt: iso(row.created_at)
  }));
}

async function loadTreasuryExpenditures(
  queryable: Queryable,
  kingdomId: string,
  limit: number
): Promise<KingdomTreasuryExpenditureEntry[]> {
  const result = await queryable.query<{
    id: string;
    kingdom_id: string;
    project_id: string;
    target_level: number;
    actor_player_id: string;
    actor_name: string;
    resource_type: ResourceType;
    variant: string;
    direction: "debit" | "refund";
    quantity: number;
    balance_before: string | number;
    balance_after: string | number;
    created_at: Date | string;
  }>(
    `SELECT expenditure.id, expenditure.kingdom_id, expenditure.project_id,
            project.target_level, expenditure.actor_player_id,
            player.username AS actor_name, expenditure.resource_type,
            expenditure.variant, expenditure.direction, expenditure.quantity,
            expenditure.balance_before, expenditure.balance_after,
            expenditure.created_at
     FROM kingdom_treasury_expenditures expenditure
     JOIN kingdom_projects project ON project.id = expenditure.project_id
     JOIN players player ON player.id = expenditure.actor_player_id
     WHERE expenditure.kingdom_id = $1
     ORDER BY expenditure.created_at DESC, expenditure.id DESC
     LIMIT $2`,
    [kingdomId, Math.max(1, Math.min(limit, 500))]
  );
  return result.rows.map((row) => ({
    id: row.id,
    kingdomId: row.kingdom_id,
    projectId: row.project_id,
    projectName: KINGDOM_ADVANCEMENT_PROJECTS[
      Number(row.target_level) as KingdomAdvancementTargetLevel
    ].displayName,
    actorPlayerId: row.actor_player_id,
    actorDisplayName: row.actor_name,
    resourceType: row.resource_type,
    variant: row.variant,
    direction: row.direction,
    quantity: Number(row.quantity),
    balanceBefore: Number(row.balance_before),
    balanceAfter: Number(row.balance_after),
    createdAt: iso(row.created_at)
  }));
}

async function loadActiveAdvancementProject(
  queryable: Queryable,
  kingdomId: string
): Promise<KingdomAdvancementProjectSnapshot | null> {
  const result = await queryable.query<KingdomProjectRow & { actor_name: string }>(
    `SELECT project.id, project.kingdom_id, project.project_type,
            project.rules_version, project.target_level, project.status,
            project.actor_player_id, project.cost_snapshot, project.xp_snapshot,
            project.started_at, project.completes_at, project.completed_at,
            project.cancelled_at, project.failed_at, project.failure_code,
            player.username AS actor_name
     FROM kingdom_projects project
     JOIN players player ON player.id = project.actor_player_id
     WHERE project.kingdom_id = $1 AND project.project_type = 'advancement'
       AND project.status = 'pending'
     ORDER BY project.started_at DESC, project.id DESC
     LIMIT 1`,
    [kingdomId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const balances = await loadTreasury(queryable, kingdomId);
  const xp = parseProjectXpSnapshot(row.xp_snapshot);
  const targetLevel = Number(row.target_level) as KingdomAdvancementTargetLevel;
  return {
    id: row.id,
    projectType: "advancement",
    rulesVersion: Number(row.rules_version),
    targetLevel,
    displayName: KINGDOM_ADVANCEMENT_PROJECTS[targetLevel].displayName,
    status: row.status,
    actorPlayerId: row.actor_player_id,
    actorDisplayName: row.actor_name,
    cost: parseProjectCost(row.cost_snapshot).map((line) => {
      const available = balances.find((balance) =>
        balance.resourceType === line.resourceType &&
        (balance.variant ?? DEFAULT_INVENTORY_VARIANT) === line.variant
      )?.quantity ?? 0;
      return {
        resourceType: line.resourceType,
        variant: line.variant,
        quantity: line.quantity,
        availableQuantity: available,
        missingQuantity: Math.max(0, line.quantity - available)
      };
    }),
    xpDelta: xp.xpDelta,
    startedAt: iso(row.started_at),
    completesAt: iso(row.completes_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    cancelledAt: row.cancelled_at ? iso(row.cancelled_at) : null,
    failedAt: row.failed_at ? iso(row.failed_at) : null,
    failureCode: row.failure_code
  };
}

async function loadActivityHistory(
  queryable: Queryable,
  kingdomId: string,
  limit: number
): Promise<KingdomActivityEntry[]> {
  const result = await queryable.query<{
    id: string;
    event_type: string;
    actor_name: string | null;
    target_name: string | null;
    project_name: string | null;
    created_at: Date | string;
  }>(
    `SELECT event.id, event.event_type,
            actor.username AS actor_name, target.username AS target_name,
            event.metadata->>'projectName' AS project_name,
            event.created_at
     FROM kingdom_audit_events event
     LEFT JOIN players actor ON actor.id = event.actor_player_id
     LEFT JOIN players target ON target.id = event.target_player_id
     WHERE event.kingdom_id = $1
     ORDER BY event.created_at DESC, event.id DESC
     LIMIT $2`,
    [kingdomId, Math.max(1, Math.min(limit, 500))]
  );
  return result.rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    summary: activitySummary(
      row.event_type,
      row.actor_name,
      row.target_name,
      row.project_name
    ),
    actorDisplayName: row.actor_name,
    targetDisplayName: row.target_name,
    createdAt: iso(row.created_at)
  }));
}

function activitySummary(
  eventType: string,
  actor: string | null,
  target: string | null,
  projectName: string | null
): string {
  const actorName = actor ?? "The Kingdom";
  const targetName = target ?? "a member";
  const summaries: Record<string, string> = {
    kingdom_founded: `${actorName} founded the Kingdom.`,
    member_invited: `${actorName} invited ${targetName}.`,
    invitation_accepted: `${targetName} joined the Kingdom.`,
    invitation_declined: `${targetName} declined a Kingdom invitation.`,
    invitation_cancelled: `${actorName} cancelled ${targetName}'s invitation.`,
    member_left: `${targetName} left the Kingdom.`,
    member_removed: `${actorName} removed ${targetName}.`,
    member_ban: `${actorName} banned ${targetName}.`,
    member_unbanned: `${actorName} unbanned ${targetName}.`,
    member_promote: `${actorName} promoted ${targetName}.`,
    member_demote: `${actorName} changed ${targetName}'s role.`,
    leadership_transferred: `${actorName} transferred leadership to ${targetName}.`,
    chat_muted: `${actorName} muted ${targetName}.`,
    chat_unmuted: `${actorName} unmuted ${targetName}.`,
    kingdom_identity_updated: `${actorName} updated the Kingdom identity.`,
    treasury_donated: `${actorName} donated resources to the treasury.`,
    bricks_deposited: `${actorName} deposited Bricks into the treasury.`,
    kingdom_structure_built: `${actorName} built a Kingdom structure.`,
    brick_furnace_upgraded: `${actorName} upgraded the Brick Furnace.`,
    command_board_upgraded: `${actorName} upgraded the Command Board.`,
    war_structure_placed: `${actorName} raised a War Tower or War Outpost.`,
    brick_furnace_package_bought: `${actorName} bought a Brick Furnace package.`,
    advancement_project_started: `${actorName} started ${projectName ?? "an advancement project"}.`,
    advancement_project_cancelled: `${actorName} cancelled ${projectName ?? "an advancement project"}.`,
    kingdom_level_up: "The Kingdom reached a new level.",
    advancement_project_completed: `${projectName ?? "An advancement project"} completed.`,
    kingdom_flag_contributed: `${actorName} contributed a Kingdom Flag.`,
    kingdom_flag_released: `${actorName} released a Kingdom Flag.`,
    kingdom_flag_removed: `${actorName} removed a Kingdom Flag.`,
    kingdom_flag_pruned: "A disconnected Kingdom Flag returned to personal control.",
    kingdom_flag_restored: "A Kingdom Flag returned to personal control.",
    kingdom_flag_absorbed_at_founding: `${actorName} affiliated an overlapping founder Flag.`,
    cot_placed: `${actorName} placed a cot.`,
    cot_moved: `${actorName} moved a cot.`,
    cot_packed: `${actorName} packed a cot.`,
    decoration_placed: `${actorName} placed a decoration.`,
    decoration_moved: `${actorName} moved a decoration.`,
    decoration_removed: `${actorName} removed a decoration.`,
    kingdom_dissolved: `${actorName} dissolved the Kingdom.`
  };
  return summaries[eventType] ??
    `${actorName}: ${eventType.replaceAll("_", " ")}.`;
}

async function loadCots(queryable: Queryable, kingdomId: string): Promise<KingdomCotSnapshot[]> {
  const result = await queryable.query<{
    id: string;
    kingdom_id: string;
    owner_player_id: string;
    owner_name: string;
    lat: number;
    lon: number;
    rotation: number;
    status: KingdomCotSnapshot["status"];
    completed_under_free_construction: boolean;
    construction_state: KingdomCotSnapshot["constructionState"];
    completed_at: Date | string | null;
    construction_completes_at: Date | string | null;
    created_at: Date | string;
  }>(
    `SELECT cot.id, cot.kingdom_id, cot.owner_player_id, p.username AS owner_name,
            cot.lat, cot.lon, cot.rotation, cot.status,
            cot.completed_under_free_construction, cot.construction_state, cot.completed_at,
            job.completes_at AS construction_completes_at, cot.created_at
     FROM kingdom_cots cot JOIN players p ON p.id = cot.owner_player_id
     LEFT JOIN kingdom_construction_jobs job ON job.entity_type = 'cot' AND job.entity_id = cot.id
     WHERE cot.kingdom_id = $1 AND cot.status = 'active'
     ORDER BY cot.created_at, cot.id`,
    [kingdomId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    kingdomId: row.kingdom_id,
    ownerPlayerId: row.owner_player_id,
    ownerDisplayName: row.owner_name,
    lat: Number(row.lat),
    lon: Number(row.lon),
    rotation: Number(row.rotation),
    status: row.status,
    completedUnderFreeConstruction: row.completed_under_free_construction,
    constructionState: row.construction_state,
    constructionCompletesAt: row.construction_completes_at ? iso(row.construction_completes_at) : null,
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    createdAt: iso(row.created_at)
  }));
}

async function loadKingdomFlags(
  queryable: Queryable,
  kingdomId: string
): Promise<KingdomFlagSnapshot[]> {
  const seat = await loadCompletedKingdomSeat(queryable, kingdomId, false);
  if (!seat) return [];
  const connectedIds = await loadConnectedKingdomFlagIds(queryable, kingdomId);
  if (connectedIds.length === 0) return [];
  const result = await queryable.query<{
    id: string;
    name: string;
    owner_id: string;
    owner_name: string;
    contributor_id: string;
    contributor_name: string;
    kingdom_color: string;
    lat: number;
    lon: number;
    claim_radius_m: number;
    kingdom_affiliated_at: Date | string;
    directly_touches_seat: boolean;
    anchor_id: string | null;
    anchor_name: string | null;
    anchor_owner_id: string | null;
  }>(
    `SELECT flag.id, flag.name, flag.owner_id, player.username AS owner_name,
            flag.contributed_by_player_id AS contributor_id,
            contributor.username AS contributor_name,
            kingdom.display_color AS kingdom_color,
            flag.lat, flag.lon, flag.claim_radius_m, flag.kingdom_affiliated_at,
            ST_DWithin(
              flag.geom::geography,
              COALESCE(source.geom, seat.geom)::geography,
              flag.claim_radius_m + seat.territory_radius_m + $4
            ) AS directly_touches_seat,
            anchor.id AS anchor_id, anchor.name AS anchor_name,
            anchor.owner_id AS anchor_owner_id
     FROM flags flag
     JOIN players player ON player.id = flag.owner_id
     JOIN players contributor ON contributor.id = flag.contributed_by_player_id
     JOIN kingdoms kingdom ON kingdom.id = flag.kingdom_id
     JOIN kingdom_seats seat ON seat.id = $3
     LEFT JOIN flags source ON source.id = seat.source_flag_id
     LEFT JOIN LATERAL (
       SELECT neighbor.id, neighbor.name, neighbor.owner_id
       FROM flags neighbor
       WHERE neighbor.kingdom_id = $1
         AND neighbor.id = ANY($2::uuid[])
         AND neighbor.id <> flag.id
         AND ST_DWithin(
           flag.geom::geography,
           neighbor.geom::geography,
           flag.claim_radius_m + neighbor.claim_radius_m + $4
         )
       ORDER BY ST_Distance(flag.geom::geography, neighbor.geom::geography), neighbor.id
       LIMIT 1
     ) anchor ON true
     WHERE flag.kingdom_id = $1 AND flag.id = ANY($2::uuid[])
     ORDER BY directly_touches_seat DESC, flag.kingdom_affiliated_at, flag.id`,
    [kingdomId, connectedIds, seat.id, FLAG_CONTROL_TOUCH_TOLERANCE_M]
  );
  return result.rows.map((row) => ({
    flagId: row.id,
    kingdomId,
    flagName: row.name,
    ownerPlayerId: row.owner_id,
    ownerDisplayName: row.owner_name,
    contributedByPlayerId: row.contributor_id,
    contributedByDisplayName: row.contributor_name,
    kingdomColor: row.kingdom_color,
    lat: Number(row.lat),
    lon: Number(row.lon),
    claimRadiusM: Number(row.claim_radius_m),
    constructionState: "complete",
    connected: true,
    directlyTouchesSeat: row.directly_touches_seat,
    connectionAnchor: row.directly_touches_seat
      ? { kind: "seat", id: seat.id, name: `${seat.kingdom_name} Castle` }
      : {
          kind: "kingdom_flag",
          id: row.anchor_id!,
          name: row.anchor_name!,
          ownerPlayerId: row.anchor_owner_id!
        },
    affiliatedAt: iso(row.kingdom_affiliated_at)
  }));
}

async function loadDecorations(
  queryable: Queryable,
  kingdomId: string
): Promise<KingdomDecorationSnapshot[]> {
  const result = await queryable.query<{
    id: string;
    kingdom_id: string;
    type_id: KingdomDecorationTypeId;
    display_name: string;
    placed_by_player_id: string;
    personal_owner_player_id: string | null;
    kingdom_owned: boolean;
    lat: number;
    lon: number;
    rotation: number;
    status: KingdomDecorationSnapshot["status"];
    completed_under_free_construction: boolean;
    capacity_cost: number;
    construction_state: KingdomDecorationSnapshot["constructionState"];
    completed_at: Date | string | null;
    construction_completes_at: Date | string | null;
    created_at: Date | string;
  }>(
    `SELECT d.id, d.kingdom_id, d.type_id, definition.display_name,
            d.placed_by_player_id, d.personal_owner_player_id, d.kingdom_owned,
            d.lat, d.lon, d.rotation, d.status,
            d.capacity_cost, d.completed_under_free_construction, d.construction_state,
            d.completed_at, job.completes_at AS construction_completes_at, d.created_at
     FROM kingdom_decorations d
     JOIN kingdom_decoration_definitions definition ON definition.type_id = d.type_id
     LEFT JOIN kingdom_construction_jobs job ON job.entity_type = 'decoration' AND job.entity_id = d.id
     WHERE d.kingdom_id = $1 AND d.status = 'active'
     ORDER BY d.created_at, d.id`,
    [kingdomId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    kingdomId: row.kingdom_id,
    typeId: row.type_id,
    displayName: row.display_name,
    placedByPlayerId: row.placed_by_player_id,
    personalOwnerPlayerId: row.personal_owner_player_id,
    kingdomOwned: row.kingdom_owned,
    lat: Number(row.lat),
    lon: Number(row.lon),
    rotation: Number(row.rotation),
    status: row.status,
    capacityCost: Number(row.capacity_cost),
    completedUnderFreeConstruction: row.completed_under_free_construction,
    constructionState: row.construction_state,
    constructionCompletesAt: row.construction_completes_at ? iso(row.construction_completes_at) : null,
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    createdAt: iso(row.created_at)
  }));
}

async function loadDecorationDefinitions(queryable: Queryable): Promise<KingdomDecorationDefinition[]> {
  const result = await queryable.query<{
    type_id: string;
    display_name: string;
    footprint_radius_m: number;
    ownership_type: KingdomDecorationDefinition["ownershipType"];
    required_kingdom_level: number;
    capacity_cost: number;
    future_material_cost: unknown;
    intended_construction_seconds: number;
    members_may_place: boolean;
    officers_only: boolean;
  }>(
    `SELECT type_id, display_name, footprint_radius_m, ownership_type,
            required_kingdom_level, capacity_cost, future_material_cost,
            intended_construction_seconds, members_may_place, officers_only
     FROM kingdom_decoration_definitions WHERE active = true ORDER BY type_id`
  );
  return result.rows.map((row) => ({
    typeId: row.type_id,
    displayName: row.display_name,
    footprintRadiusM: Number(row.footprint_radius_m),
    ownershipType: row.ownership_type,
    requiredKingdomLevel: Number(row.required_kingdom_level),
    capacityCost: Number(row.capacity_cost),
    futureMaterialCost: parseDecorationCost(row.future_material_cost),
    intendedConstructionSeconds: Number(row.intended_construction_seconds),
    membersMayPlace: row.members_may_place,
    officersOnly: row.officers_only
  }));
}

async function loadDecorationDefinition(
  queryable: Queryable,
  typeId: string
): Promise<KingdomDecorationDefinition | null> {
  return (await loadDecorationDefinitions(queryable)).find((definition) => definition.typeId === typeId) ?? null;
}

function parseDecorationCost(value: unknown): KingdomCostLine[] {
  if (!Array.isArray(value)) throw new Error("Invalid Kingdom decoration material cost catalog entry");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid Kingdom decoration material cost catalog entry");
    const resourceType = (entry as { resourceType?: unknown }).resourceType;
    const quantity = (entry as { quantity?: unknown }).quantity;
    if (typeof resourceType !== "string" || !Number.isSafeInteger(quantity) || Number(quantity) < 0) {
      throw new Error("Invalid Kingdom decoration material cost catalog entry");
    }
    return { resourceType: requireItemDefinition(resourceType).itemId as ResourceType, quantity: Number(quantity) };
  });
}

function parseProjectCost(value: unknown): ProjectCostLine[] {
  if (!Array.isArray(value)) throw new Error("Invalid Kingdom project cost snapshot");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Invalid Kingdom project cost snapshot");
    }
    const resourceType = (entry as { resourceType?: unknown }).resourceType;
    const variant = (entry as { variant?: unknown }).variant;
    const quantity = (entry as { quantity?: unknown }).quantity;
    if (
      typeof resourceType !== "string" ||
      typeof variant !== "string" ||
      !Number.isSafeInteger(quantity) ||
      Number(quantity) <= 0
    ) {
      throw new Error("Invalid Kingdom project cost snapshot");
    }
    return {
      resourceType: requireItemDefinition(resourceType).itemId as ResourceType,
      variant,
      quantity: Number(quantity)
    };
  });
}

function parseProjectXpSnapshot(value: unknown): ProjectXpSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Kingdom project XP snapshot");
  }
  const snapshot = value as Partial<ProjectXpSnapshot>;
  for (const field of [
    snapshot.levelBefore,
    snapshot.lifetimeXpBefore,
    snapshot.targetLifetimeXp,
    snapshot.xpDelta
  ]) {
    if (!Number.isSafeInteger(field) || Number(field) < 0) {
      throw new Error("Invalid Kingdom project XP snapshot");
    }
  }
  return {
    levelBefore: Number(snapshot.levelBefore),
    lifetimeXpBefore: Number(snapshot.lifetimeXpBefore),
    targetLifetimeXp: Number(snapshot.targetLifetimeXp),
    xpDelta: Number(snapshot.xpDelta)
  };
}

function progressionSnapshot(
  level: number,
  currentXp: number,
  lifetimeXp: number,
  perkQualifiedAt: Date,
  now: Date,
  seatAnchorRadiusM = 0,
  perkSelections: KingdomPerkSelectionSnapshot[] = [],
  dailyXp = 0
): KingdomProgressionSnapshot {
  const definition = kingdomLevelForState(level, lifetimeXp);
  const next = KINGDOM_LEVELS.find((candidate) => candidate.level === definition.level + 1) ?? null;
  const qualified = perkQualifiedAt.getTime() <= now.getTime();
  return {
    // Effective level: the stored level, or higher when lifetime XP already reached it.
    level: definition.level,
    currentXp,
    lifetimeXp,
    levelDefinitionVersion: KINGDOM_LEVEL_DEFINITION_VERSION,
    nextLevelXp: next?.requiredLifetimeXp ?? null,
    dailyXp,
    dailyXpCap: KINGDOM_MEMBER_XP_DAILY_CAP,
    capacities: {
      memberCapacity: definition.memberCapacity,
      cotCapacity: definition.cotCapacity,
      decorationCapacity: definition.decorationCapacity,
      seatAnchorRadiusM
    },
    perks: KINGDOM_PERK_IDS.map((id) => {
      const perk = KINGDOM_PERKS[id];
      const unlocked = definition.level >= perk.level;
      const selection = perkSelections.find((candidate) => candidate.perkId === id) ?? null;
      const running = !perk.activated || selection?.activeUntil != null;
      return {
        ...perk,
        unlocked,
        qualified,
        selected: selection !== null,
        active: selection !== null && qualified && running
      };
    }),
    perkSelections,
    futureBuildingUnlocks: [...definition.futureBuildingUnlocks]
  };
}

function kingdomLevelForState(level: number, lifetimeXp: number) {
  const xpDefinition = kingdomLevelForXp(lifetimeXp);
  const effectiveLevel = Math.max(
    Math.min(Math.trunc(level), KINGDOM_LEVELS[KINGDOM_LEVELS.length - 1]!.level),
    xpDefinition.level
  );
  return KINGDOM_LEVELS.find((candidate) => candidate.level === effectiveLevel) ?? xpDefinition;
}

function emptyStatModifiers(): KingdomStatModifiers {
  return { kingdomId: null, attackBonus: 0, defenseBonus: 0, perkIds: [], qualified: false };
}

async function mapBrickEconomyError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof KingdomBrickEconomyError) {
      throw new KingdomError(error.code as KingdomErrorCode, error.message, error.details ?? {});
    }
    throw error;
  }
}

async function mapRevoltError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof KingdomRevoltError) throw new KingdomError(error.code as KingdomErrorCode, error.message);
    throw error;
  }
}

function mapKingdomError(error: unknown): Error {
  if (error instanceof KingdomError) return error;
  const database = error as { code?: string; constraint?: string };
  if (database.code === "23505") {
    if (database.constraint?.includes("normalized_name")) {
      return new KingdomError("KINGDOM_NAME_UNAVAILABLE", "That Kingdom name is unavailable");
    }
    if (database.constraint?.includes("memberships_one_active")) {
      return new KingdomError("KINGDOM_ALREADY_MEMBER", "A player may belong to only one active Kingdom");
    }
    if (database.constraint?.includes("invitations_one_pending")) {
      return new KingdomError("KINGDOM_INVITATION_EXISTS", "A pending invitation already exists");
    }
    if (database.constraint?.includes("cots_one_active")) {
      return new KingdomError("KINGDOM_COT_ALREADY_PLACED", "This member already has an active cot");
    }
    if (database.constraint?.includes("projects_one_pending_advancement")) {
      return new KingdomError(
        "KINGDOM_ADVANCEMENT_PROJECT_ACTIVE",
        "A Kingdom advancement project is already active"
      );
    }
    if (database.constraint?.includes("kingdom_seats_source_flag_unique_idx")) {
      return new KingdomError(
        "KINGDOM_FLAG_LIFECYCLE_CHANGED",
        "This flag is already assigned to an active Castle"
      );
    }
    return new KingdomError("KINGDOM_REQUEST_CONFLICT", "Kingdom request conflicts with an existing operation");
  }
  if (database.code === "40001" || database.code === "40P01") {
    return new KingdomError(
      "KINGDOM_ADVANCEMENT_PROJECT_STATE_CHANGED",
      "Kingdom project state changed concurrently; refresh and try again"
    );
  }
  if (database.code === "23503" || database.code === "23514" || database.code === "22P02") {
    return new KingdomError("KINGDOM_VALIDATION_FAILED", "Kingdom request violates an authoritative constraint");
  }
  return error instanceof Error ? error : new Error("Kingdom operation failed");
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function iso(value: Date | string): string {
  return asDate(value).toISOString();
}
