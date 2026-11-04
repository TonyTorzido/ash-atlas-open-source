import { randomUUID } from "node:crypto";

import {
  CITY_FLAG_COLOR,
  FLAG_BURN_INTERACTION_RADIUS_M,
  STRUCTURE_WARFARE_BOMBER_DAMAGE,
  STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER,
  STRUCTURE_WARFARE_BASE_HEALTH,
  STRUCTURE_WARFARE_HARDENED_HEALTH,
  STRUCTURE_WARFARE_TOWER_HEALTH,
  STRUCTURE_WARFARE_ATLAS_SHRINE_HEALTH,
  STRUCTURE_WARFARE_CITY_TOWER_HEALTH,
  CITY_TOWER_UPGRADE_COST,
  PERSONAL_GUARD_TOWER_IRON_ITEM_ID,
  personalGuardTowerHealth,
  personalGuardTowerUpgradeCost,
  BRICKS_ITEM_ID,
  hasKingdomPermission,
  kingdomStructureBuildCost,
  type KingdomRole,
  type KingdomStructureKind,
  structureWarfareHealthForReinforcementLevel,
  structureWarfareBreachThresholdForReinforcementLevel,
  type AtlasShrineProgressionSnapshot,
  classifyFlagPlacementTerrain,
  type FlagUpgradeTier,
  personalFlagColorHex,
  RESOURCE_LAYOUT_VERSION,
  TERRITORY_EDGE_TOLERANCE_M,
  type FlagEnvironmentDiagnostics,
  type FlagEnvironmentDetails,
  type FlagBuildMaterial,
  type FlagSnapshot,
  type PersonalAnchorKind,
  type DroppedItemSnapshot,
  type PlayerInventorySnapshot,
  type ResourceType,
  type TerritoryResolution,
  type DeveloperTestFlagKind
} from "@ash-atlas/shared";
import {
  WORLD_EDGE_ERROR_CODE,
  WORLD_EDGE_MESSAGE,
  distanceMeters,
  isWithinWorldEdge
} from "@ash-atlas/shared";
import type pg from "pg";
import { professionEffects, type MasteryGrantResult } from "@ash-atlas/shared";

import { MAX_FLAG_CLAIM_RADIUS_M, type AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type {
  WorldLookupFailureCode,
  WorldLookupResult
} from "../world/worldTypes.js";
import {
  buildFlagEnvironmentComparison,
  buildFlagEnvironmentDetails,
  flagEnvironmentCacheState,
  type PersistedFlagEnvironmentRow
} from "./flagEnvironment.js";
import { prepareFlagEnvironmentPersistence } from "./flagEnvironmentPersistence.js";
import {
  isPersonalFlagControlledByPlayer,
  lockFlagControlGeometry
} from "./flagControlGeometry.js";
import { InventoryService } from "./inventory.js";
import { CityTreasuryService } from "./cityTreasury.js";
import { cityTowerSlotsMessage, cityTowerSlotsSnapshot } from "./cityTowerSlots.js";
import {
  creditKingdomDowngradeRefundInTransaction,
  insertKingdomAuditEvent,
  lockKingdomTreasuryBalance,
  moveKingdomTreasuryInTransaction
} from "./kingdomTreasuryLedger.js";
import { kingdomCapacityMessage, kingdomStructureCapacitySnapshot } from "./kingdomLimits.js";
import {
  WAR_STRUCTURE_CLAIM_RADIUS_M,
  WAR_STRUCTURE_PLACEMENT_RANGE_M,
  kingdomWarStructureCap,
  kingdomWarStructureCost,
  kingdomWarStructureLabel,
  kingdomStructureDowngradeRefund,
  type KingdomWarStructurePlaceInput
} from "@ash-atlas/shared";
import { KingdomBrickEconomyError } from "./kingdomBrickEconomy.js";
import {
  chargeKingdomWarMaterialsInTransaction,
  countKingdomWarStructures,
  kingdomCommandBoardLevelOf,
  warMaterialLabel
} from "./kingdomCommandBoard.js";
import { WalletOperationError, WalletService } from "./wallet.js";
import {
  createSystemGroundDropsInTransaction,
  type SystemGroundDropLine
} from "./droppedItems.js";
import type { CompactMasteryGrantResult, MasteryService } from "./masteries.js";
import { resourceVisionJobIdentity } from "./resourceVisionJobContracts.js";
import { insertResourceVisionJobInTransaction } from "./resourceVisionJobStore.js";
import { resolveTerritoryAtPoint, type TerritoryFlag } from "./territory.js";
import { sanitizeAtlasShrineRename, sanitizeFlagName } from "./validation.js";
import type { PlayerRecord } from "./state.js";
import type { BurnFlagDeletionResult } from "./flagServiceContracts.js";
export type { BurnFlagDeletionResult } from "./flagServiceContracts.js";
import { WORLD_RUNTIME_CONTRACT } from "../runtime/authorityIdentity.js";
import {
  CityFoundingError,
  assertCityFlagAction,
  clearAndPruneCityFlags,
  isCityControlledFlag,
  lockCityFlagNetwork
} from "./cities.js";
import {
  KingdomError,
  assertKingdomFlagAction,
  clearAndPruneKingdomFlags,
  isKingdomControlledFlag,
  lockKingdomFlagNetwork
} from "./kingdoms.js";
import {
  applyOrganizationBomberStrikeInTransaction,
  ensureDamageTriggeredBurnInTransaction,
  PersonalFlagWarfareAdapter
} from "./personalFlagWarfare.js";
import { hasActiveRepair } from "./warStructures.js";
import { monolithAdjustedBuildingDamage } from "./monoliths.js";
import {
  PERSONAL_FLAG_WARFARE_KIND,
  StructureWarfareError,
  StructureWarfareService
} from "./structureWarfare.js";

type FlagRow = {
  id: string;
  anchor_kind?: PersonalAnchorKind;
  control_type?: "personal" | "city" | "city_seat" | "kingdom" | "kingdom_seat";
  owner_id: string;
  owner_username?: string | null;
  owner_color?: string | null;
  developer_test_owner_id?: string | null;
  developer_test_owner_name?: string | null;
  presentation_color?: string | null;
  system_controlled?: boolean;
  name: string;
  lat: number;
  lon: number;
  package_id: string | null;
  elevation_m: number | null;
  terrain_class: string | null;
  biome: string | null;
  ecoregion: string | null;
  claim_radius_m: number;
  resource_vision_radius_m: number;
  access_mode?: "private" | "public" | "normal";
  jump_toll_gold?: string;
  access_revision?: string;
  city_id?: string | null;
  reinforcement_level?: number;
  tower_level?: number | null;
  obelisk_level?: number | null;
  war_structure_kind?: string | null;
  war_id?: string | null;
  developer_test_target?: boolean;
  health?: number | null;
  maximum_health?: number | null;
  burning_started_at?: Date | string | null;
  burning_until?: Date | string | null;
  burning_reason?: string | null;
  legendary_bird_species?: "fire" | "lightning" | "ice" | null;
  reinforced_operation_key?: string | null;
  atlas_shrine_slot_number?: number | null;
  kingdom_id?: string | null;
  kingdom_name?: string | null;
  kingdom_emblem_key?: string | null;
  kingdom_color?: string | null;
  kingdom_seat_id?: string | null;
  kingdom_seat_construction_state?: "under_construction" | "complete" | null;
  kingdom_seat_lat?: number | null;
  kingdom_seat_lon?: number | null;
  kingdom_affiliated_at?: Date | string | null;
  original_owner_player_id?: string | null;
  contributed_by_player_id?: string | null;
  contributed_by_username?: string | null;
  original_personal_color?: string | null;
  created_at: Date;
};

export const DEFAULT_FLAG_COLOR = "#d83a3a";
/** Dedicated presentation identity for developer warfare fixtures. The
 * underlying creator relation remains on the fixture table for cleanup and
 * replay authorization; ordinary player ownership is never rewritten. */
export const DEVELOPER_TEST_OWNER_ID = "developer-test-opponent";
export const DEVELOPER_TEST_OWNER_NAME = "Developer Test Enemy";
export const FLAG_BUILD_COST = { wood: 3, leather: 2 } as const;
export const BUOY_BUILD_COST = { wood: 3, leather: 3, crude_oil: 1 } as const;
export const FLAG_BUILD_RECIPE: readonly FlagBuildMaterial[] = Object.freeze(
  Object.entries(FLAG_BUILD_COST).map(([itemId, quantity]) => ({
    itemId: itemId as FlagBuildMaterial["itemId"],
    quantity
  }))
);
export const BUOY_BUILD_RECIPE: readonly FlagBuildMaterial[] = Object.freeze(
  Object.entries(BUOY_BUILD_COST).map(([itemId, quantity]) => ({
    itemId: itemId as FlagBuildMaterial["itemId"],
    quantity
  }))
);

function recipeForAnchor(anchorKind: PersonalAnchorKind): readonly FlagBuildMaterial[] {
  return anchorKind === "buoy" ? BUOY_BUILD_RECIPE : FLAG_BUILD_RECIPE;
}

function costForAnchor(
  anchorKind: PersonalAnchorKind
): typeof FLAG_BUILD_COST | typeof BUOY_BUILD_COST {
  return anchorKind === "buoy" ? BUOY_BUILD_COST : FLAG_BUILD_COST;
}
export const FLAG_STONE_UPGRADE_COST = 5;
export const FLAG_REINFORCEMENT_STONE_COST = FLAG_STONE_UPGRADE_COST;
export const FLAG_TOWER_UPGRADE_COST = 25;
/** Atlas Shrine: an Atlas Shrine costs 12 wood + 8 stone (was 10 stone only). */
export const ATLAS_SHRINE_STONE_COST = 8;
export const ATLAS_SHRINE_WOOD_COST = 12;
/**
 * At most 8 Atlas Shrine slots can be unlocked. Players who already
 * unlocked more keep them (the DB CHECK stays at 25) but cannot add more.
 */
export const MAX_ATLAS_SHRINE_SLOTS = 8;
const FLAG_SNAPSHOT_ADVISORY_LOCK = "ash-atlas-flag-snapshot-v1";
const SCOPED_FLAG_SNAPSHOT_REUSE_MS = 20_000;
const MAX_RECENT_SCOPED_FLAG_SNAPSHOTS = 64;

export type BBox = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type FlagSnapshotChunk = Readonly<{
  flags: readonly FlagSnapshot[];
  flagSetRevision: number;
  chunkIndex: number;
  finalChunk: boolean;
}>;

export type FlagSnapshotScope = Readonly<{
  center: Readonly<{ lat: number; lon: number }>;
  radiusM: number;
}>;

type LoadedFlagSnapshot = Readonly<{
  flagSetRevision: number;
  chunks: readonly FlagSnapshotChunk[];
}>;

function scopedFlagSnapshotCacheKey(
  pageSize: number,
  scope: FlagSnapshotScope
): string {
  return [
    pageSize,
    scope.center.lat,
    scope.center.lon,
    scope.radiusM
  ].join(":");
}

export type CreateFlagResult = {
  flag: FlagSnapshot;
  warning?: string;
  masteryGrant?: CompactMasteryGrantResult;
  materialsRefunded?: boolean;
  inventory?: PlayerInventorySnapshot;
  activationJobKey?: string;
  flagSetRevision?: number;
  replayed?: boolean;
  timings?: FlagCommitTimings;
};

export type DeveloperTestFlagSpawnResult = Readonly<{
  flag: FlagSnapshot;
  replayed: boolean;
}>;

export type FlagAdmissionTimings = {
  defaultNameMs: number;
  territoryAdmissionMs: number;
  worldLookupMs: number;
  builderRankMs: number;
  affordabilityMs: number;
  totalMs: number;
  quoteState: FlagPlacementQuoteState | "miss" | "stale";
};

export type FlagPlacementQuoteState =
  | "hit"
  | "missing"
  | "expired"
  | "unknown-id"
  | "position-mismatch"
  | "movement-revision-mismatch"
  | "relocation-revision-mismatch"
  | "region-mismatch"
  | "release-mismatch"
  | "consumed";

export type FlagPlacementQuoteDiagnostic = {
  quoteIdPresent: boolean;
  quoteState: FlagPlacementQuoteState;
  quoteMismatchReason: Exclude<FlagPlacementQuoteState, "hit"> | null;
  quoteAgeMs: number | null;
  quoteExpiresInMs: number | null;
  movementRevision: number;
  relocationRevision: number;
  worldLookupAttempted: boolean;
};

export type FlagCommitTimings = {
  databasePoolWaitMs: number;
  requestReplayLockMs: number;
  spatialLockWaitMs: number;
  finalTerritoryRevalidationMs: number;
  inventoryDebitMs: number;
  flagInsertMs: number;
  builderOutcomeMs: number;
  activationJobInsertMs: number;
  playerAuthorityUpdateMs: number;
  transactionCommitMs: number;
  totalMs: number;
};

export type DeleteFlagResult = {
  affectedFlagIds: string[];
  notificationPlayerIds: string[];
  refundInventories: Array<{
    playerId: string;
    inventory: PlayerInventorySnapshot;
  }>;
  droppedItems: DroppedItemSnapshot[];
  replayed: boolean;
};

type StoredFlagDestructionResult = {
  affectedFlagIds: string[];
  notificationPlayerIds: string[];
  refundPlayerIds: string[];
  droppedItems: DroppedItemSnapshot[];
};

export type AtlasShrineUnlockResult = Readonly<{
  progression: AtlasShrineProgressionSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
}>;

export type FlagUpgradeResult = Readonly<{
  flag: FlagSnapshot;
  progression: AtlasShrineProgressionSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
  masteryGrant?: MasteryGrantResult;
}>;

export type PreparedFlagPlacement = {
  flagId: string;
  anchorKind: PersonalAnchorKind;
  ownerId: string;
  ownerUsername: string;
  ownerColor?: string;
  name: string;
  lat: number;
  lon: number;
  regionCode: string;
  movementLeashRadiusM: number;
  movementRevision: number;
  relocationRevision: number;
  builderRank: number;
  buildDurationMs: number;
  materialAffordable: boolean;
  world: WorldLookupResult;
  admissionTimings: FlagAdmissionTimings;
  quoteDiagnostic?: FlagPlacementQuoteDiagnostic;
  warning?: string;
};

export type FlagPlacementQuote = {
  quoteId: string;
  anchorKind: PersonalAnchorKind;
  position: { lat: number; lon: number };
  movementRevision: number;
  relocationRevision: number;
  worldReleaseId: string | null;
  materialAffordable: boolean;
  createdAt: number;
  expiresAt: number;
};

export type FlagPlacementFailureStage =
  | "movement"
  | "territory"
  | "world"
  | "naming"
  | "mastery"
  | "affordability"
  | "unexpected";

export type FlagPlacementQuoteMetrics = Readonly<{
  quoteCreated: number;
  quoteReused: number;
  quoteSingleflightJoined: number;
  validQuoteReplacement: number;
  postBuildQuoteSuppressed: number;
}>;

type StoredFlagPlacementQuote = FlagPlacementQuote & {
  playerId: string;
  ownerUsername: string;
  ownerColor: string | null;
  regionCode: string;
  movementLeashRadiusM: number;
  defaultName: string;
  builderRank: number;
  buildDurationMs: number;
  world: WorldLookupResult;
};

export type FlagEnvironmentRefreshFailure = {
  flagId: string;
  error: string;
};

export type FlagEnvironmentRefreshReport = {
  requested: number;
  refreshed: number;
  refreshedFlagIds: string[];
  failures: FlagEnvironmentRefreshFailure[];
  truncated: boolean;
};

class PublicFlagEnvironmentRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicFlagEnvironmentRefreshError";
  }
}

export function flagEnvironmentRefreshFailureMessage(error: unknown): string {
  return error instanceof PublicFlagEnvironmentRefreshError
    ? error.message
    : "Environment refresh failed. Check server logs.";
}

async function replayFlagDestruction(
  client: pg.PoolClient,
  inventory: InventoryService,
  operationKey: string,
  actorPlayerId: string,
  requestId: string,
  flagId: string
): Promise<DeleteFlagResult | null> {
  const operation = await client.query<{
    actor_player_id: string;
    request_id: string;
    flag_id: string;
    result: StoredFlagDestructionResult | null;
  }>(
    `SELECT actor_player_id,request_id,flag_id::text,result
     FROM flag_destruction_operations
     WHERE operation_key=$1 OR (actor_player_id=$2 AND request_id=$3)
     FOR UPDATE`,
    [operationKey, actorPlayerId, requestId]
  );
  const row = operation.rows[0];
  if (!row) return null;
  if (
    row.actor_player_id !== actorPlayerId ||
    row.request_id !== requestId ||
    row.flag_id !== flagId
  ) {
    throw new Error("Flag destruction request ID was reused with different intent");
  }
  if (!row.result) {
    throw new Error("Flag destruction operation is incomplete");
  }
  const refundInventories: DeleteFlagResult["refundInventories"] = [];
  for (const playerId of row.result.refundPlayerIds) {
    refundInventories.push({
      playerId,
      inventory: await inventory.snapshotInTransaction(client, playerId)
    });
  }
  return {
    affectedFlagIds: row.result.affectedFlagIds,
    notificationPlayerIds: row.result.notificationPlayerIds,
    refundInventories,
    droppedItems: row.result.droppedItems,
    replayed: true
  };
}

async function recordFlagMaterialSpend(
  client: pg.PoolClient,
  flagId: string,
  inventoryOperationKey: string,
  stage: "base" | "stone" | "atlas_shrine" | "tower"
): Promise<void> {
  await client.query(
    `INSERT INTO flag_material_spend (
       flag_id,stage,item_id,variant,quantity,paid_by_player_id,
       source_operation_key,created_at
     )
     SELECT $1::uuid,$3,event.item_id,event.variant,
            sum(-event.delta_quantity),event.player_id,$2,min(event.created_at)
     FROM inventory_events event
     WHERE event.operation_key=$2 AND event.delta_quantity < 0
     GROUP BY event.item_id,event.variant,event.player_id
     ON CONFLICT DO NOTHING`,
    [flagId, inventoryOperationKey, stage]
  );
}

export class FlagPlacementError extends Error {
  constructor(
    message: string,
    readonly code = "FLAG_PLACEMENT_REJECTED",
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly world?: WorldLookupResult,
    readonly quoteDiagnostic?: FlagPlacementQuoteDiagnostic,
    readonly failureStage: FlagPlacementFailureStage = "unexpected",
    readonly errorClass = "FlagPlacementError"
  ) {
    super(message);
    this.name = "FlagPlacementError";
  }
}

/** One City Tower per City Market level; towers already over the cap stay standing. */
async function assertCityTowerSlotAvailable(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  cityId: string
): Promise<void> {
  const slots = await cityTowerSlotsSnapshot(queryable, cityId);
  if (slots.used >= slots.capacity) {
    throw new AtlasShrineError("FLAG_CITY_TOWER_SLOTS_FULL", cityTowerSlotsMessage(slots));
  }
}

export class AtlasShrineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AtlasShrineError";
  }
}

export class FlagDestructionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FlagDestructionError";
  }
}

export class FlagAttackError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FlagAttackError";
  }
}

export type FlagAttackResult = Readonly<{
  flag: FlagSnapshot;
  damage: number;
  replayed: boolean;
}>;

type TerritoryCandidateRow = {
  id: string;
  owner_id: string;
  owner_username: string | null;
  owner_color: string | null;
  name: string;
  lat: number;
  lon: number;
  claim_radius_m: number;
  is_covering?: boolean;
};

const MAX_TERRITORY_COVERING_FLAGS = 1_000;

/**
 * Burn completion uses the same authoritative flag-control lock and deletion
 * boundary as ordinary destruction, but deliberately has no construction
 * material refund. The caller owns the surrounding transaction.
 *
 * This is exported so other authoritative damage transactions can retire a
 * burning structure without creating a parallel deletion path.
 */
export async function deleteFlagForBurnInTransaction(
  client: pg.PoolClient,
  flagId: string,
  burnerPlayerId: string | null
): Promise<BurnFlagDeletionResult> {
  await lockFlagControlGeometry(client);
  const locked = await client.query<{
    id: string;
    control_type: "personal" | "city" | "city_seat" | "kingdom" | "kingdom_seat";
    owner_id: string;
    anchor_kind: PersonalAnchorKind;
    system_controlled: boolean;
    reinforcement_level: number;
    tower_level: number | null;
    obelisk_level?: number | null;
    war_structure_kind?: string | null;
    city_id: string | null;
    kingdom_id: string | null;
    burning_reason: string | null;
    health: number | null;
    maximum_health: number | null;
    developer_test_target: boolean;
    developer_test_creator_id: string | null;
  }>(
    `SELECT id::text,control_type,owner_id,anchor_kind,system_controlled,
            reinforcement_level,tower_level,obelisk_level,war_structure_kind,city_id,kingdom_id,burning_reason,health,maximum_health,
            flags.developer_test_target,
            test.creator_player_id AS developer_test_creator_id
     FROM flags
     LEFT JOIN developer_spawned_test_flags test ON test.flag_id=flags.id
     WHERE flags.id=$1 FOR UPDATE OF flags`,
    [flagId]
  );
  const flag = locked.rows[0];
  if (!flag) throw new FlagDestructionError("FLAG_NOT_FOUND", "Flag does not exist");
  const legendaryBirdBurn = burnerPlayerId === null;
  const systemBurn = legendaryBirdBurn
    ? await client.query(
      `SELECT operation_id
       FROM flag_burn_operations
       WHERE flag_id=$1 AND status='active' AND source_kind='legendary_bird'
       FOR UPDATE`,
      [flagId]
    )
    : null;
  const isDeveloperTestTarget = flag.developer_test_target === true;
  const breachThreshold = structureWarfareBreachThresholdForReinforcementLevel(Number(flag.reinforcement_level), flag.tower_level);
  const expectedHealth = structureWarfareHealthForReinforcementLevel(Number(flag.reinforcement_level), flag.tower_level);
  if (
    flag.control_type !== "personal" ||
    (!legendaryBirdBurn && flag.owner_id === burnerPlayerId &&
      !(isDeveloperTestTarget && flag.developer_test_creator_id === burnerPlayerId &&
        flag.owner_id === burnerPlayerId)) ||
    (legendaryBirdBurn && systemBurn?.rowCount !== 1) ||
    (flag.anchor_kind !== "flag" && flag.anchor_kind !== "buoy") ||
    flag.system_controlled ||
    flag.city_id !== null ||
    flag.kingdom_id !== null ||
    ![0, 1, 2, 3].includes(Number(flag.reinforcement_level)) ||
    expectedHealth === null ||
    breachThreshold === null ||
    Number(flag.maximum_health) !== expectedHealth ||
    (flag.burning_reason !== "flag_burn" && !(Number(flag.reinforcement_level) === 3 && flag.health === 0)) ||
    Number(flag.health) > breachThreshold
  ) {
    throw new FlagDestructionError(
      "FLAG_BURN_TARGET_INVALID",
      "The Flag is not ready to finish burning."
    );
  }
  const legendaryEvent = await client.query<{ event_id: string }>(
    `SELECT event_id::text
     FROM legendary_bird_events
     WHERE flag_id=$1 AND status IN ('pending','active')
     LIMIT 1`,
    [flagId]
  );
  if (legendaryEvent.rowCount !== 0) {
    throw new FlagDestructionError(
      "FLAG_LEGENDARY_EVENT_ACTIVE",
      "This Flag cannot be burned while its legendary encounter is available."
    );
  }
  const deleted = await client.query(
    `DELETE FROM flags
     WHERE id=$1 AND control_type='personal'
       AND ($2::text IS NULL OR owner_id<>$2 OR (developer_test_target AND EXISTS (
         SELECT 1 FROM developer_spawned_test_flags test
         WHERE test.flag_id=flags.id AND test.creator_player_id=$2
       )))
       AND anchor_kind IN ('flag','buoy') AND system_controlled=false
       AND city_id IS NULL AND kingdom_id IS NULL
       AND reinforcement_level IN (0,1,2,3)
       AND (burning_reason='flag_burn' OR (reinforcement_level=3 AND health=0))
       AND health <= $3`,
    [flagId, burnerPlayerId, breachThreshold]
  );
  if (deleted.rowCount !== 1) {
    throw new FlagDestructionError(
      "FLAG_BURN_TARGET_INVALID",
      "The Flag changed before it could be burned."
    );
  }
  return { flagId, affectedFlagIds: [], notificationPlayerIds: [flag.owner_id] };
}

/**
 * Retire a legacy terminal Flag row while preserving the same durable
 * warfare cleanup boundary used by an authoritative destruction write.  The
 * caller owns the surrounding transaction; a null result means the row was
 * already removed or is not a damageable standalone personal Flag.
 */
export async function retireZeroHealthFlagInTransaction(
  client: pg.PoolClient,
  flagId: string
): Promise<BurnFlagDeletionResult | null> {
  await lockFlagTerminalOperationsInTransaction(client, flagId);
  const locked = await client.query<{
    owner_id: string;
    control_type: string;
    anchor_kind: string;
    system_controlled: boolean;
    city_id: string | null;
    kingdom_id: string | null;
    health: number | null;
    maximum_health: number | null;
  }>(
    `SELECT owner_id,control_type,anchor_kind,system_controlled,
            city_id::text,kingdom_id::text,health,maximum_health
     FROM flags
     WHERE id=$1::uuid
     FOR UPDATE`,
    [flagId]
  );
  const flag = locked.rows[0];
  if (
    !flag
    || flag.control_type !== "personal"
    || (flag.anchor_kind !== "flag" && flag.anchor_kind !== "buoy")
    || flag.system_controlled
    || flag.city_id !== null
    || flag.kingdom_id !== null
    || flag.health === null
    || flag.maximum_health === null
    || Number(flag.maximum_health) <= 0
    || Number(flag.health) > 0
  ) return null;

  await closeFlagTerminalOperationsInTransaction(client, flagId);
  const deleted = await client.query<{ owner_id: string }>(
    `DELETE FROM flags
     WHERE id=$1::uuid
       AND control_type='personal' AND anchor_kind IN ('flag','buoy')
       AND system_controlled=false AND city_id IS NULL AND kingdom_id IS NULL
       AND health IS NOT NULL AND maximum_health IS NOT NULL
       AND maximum_health > 0 AND health <= 0
     RETURNING owner_id`,
    [flagId]
  );
  const deletedFlag = deleted.rows[0];
  return deletedFlag
    ? { flagId, affectedFlagIds: [], notificationPlayerIds: [deletedFlag.owner_id] }
    : null;
}

/**
 * The established terminal lock order before a flag row is removed: its live
 * operation rows, then the shared flag geometry lock. The caller locks the
 * flag row next. This lets a reconnect, snapshot repair or abandonment sweep
 * converge safely with an in-flight damage completion.
 */
export async function lockFlagTerminalOperationsInTransaction(
  client: pg.PoolClient,
  flagId: string
): Promise<void> {
  await client.query(
    `SELECT operation_id
     FROM flag_repair_disrupt_operations
     WHERE flag_id=$1::uuid AND status='active'
     ORDER BY operation_id
     FOR UPDATE`,
    [flagId]
  );
  await client.query(
    `SELECT operation_id
     FROM flag_repair_operations
     WHERE flag_id=$1::uuid AND status='active'
     ORDER BY operation_id
     FOR UPDATE`,
    [flagId]
  );
  await client.query(
    `SELECT operation_id
     FROM flag_burn_operations
     WHERE flag_id=$1::uuid AND status='active'
     ORDER BY operation_id
     FOR UPDATE`,
    [flagId]
  );
  await client.query(
    `SELECT operation_key
     FROM military_siege_operations
     WHERE flag_id=$1::uuid AND status='pending'
     ORDER BY operation_key
     FOR UPDATE`,
    [flagId]
  );
  await lockFlagControlGeometry(client);
}

/**
 * A terminal target cannot leave a live operation that later republishes or
 * mutates it. Keeps historical rows for audit/replay, but closes all active
 * channels and military targeting before the flag row is deleted.
 */
export async function closeFlagTerminalOperationsInTransaction(
  client: pg.PoolClient,
  flagId: string
): Promise<void> {
  await client.query(
    `UPDATE flag_repair_disrupt_operations
     SET status='cancelled',cancel_reason='flag-destroyed',completed_at=clock_timestamp()
     WHERE flag_id=$1::uuid AND status='active'`,
    [flagId]
  );
  await client.query(
    `UPDATE flag_repair_operations
     SET status='cancelled',cancel_reason='flag-destroyed',completed_at=clock_timestamp()
     WHERE flag_id=$1::uuid AND status='active'`,
    [flagId]
  );
  await client.query(
    `UPDATE flag_burn_operations
     SET status='cancelled',cancel_reason='flag-destroyed',completed_at=clock_timestamp(),paused_at=NULL
     WHERE flag_id=$1::uuid AND status='active'`,
    [flagId]
  );
  await client.query(
    `UPDATE military_siege_operations
     SET status='cancelled',completed_at=clock_timestamp()
     WHERE flag_id=$1::uuid AND status='pending'`,
    [flagId]
  );
  await client.query(
    `UPDATE military_units
     SET target_flag_id=NULL,next_fire_at=NULL,revision=revision+1,updated_at=clock_timestamp()
     WHERE target_flag_id=$1::uuid`,
    [flagId]
  );
  await client.query(
    `UPDATE military_unit_groups
     SET target_flag_id=NULL,next_fire_at=NULL,revision=revision+1,updated_at=clock_timestamp()
     WHERE target_flag_id=$1::uuid`,
    [flagId]
  );
}

export class FlagService {
  private readonly inventory: InventoryService;
  private readonly warfare: StructureWarfareService;
  private readonly placementQuotes = new Map<string, StoredFlagPlacementQuote>();
  private readonly latestPlacementQuoteByPlayer = new Map<string, string>();
  private readonly placementQuoteRequests = new Map<string, Promise<{
    world: WorldLookupResult;
    quote: FlagPlacementQuote;
  }>>();
  private readonly latestPlacementBindingByPlayer = new Map<string, string>();
  private readonly consumedPlacementQuotes = new Map<string, number>();
  private readonly scopedSnapshotFlights = new Map<
    string,
    Promise<LoadedFlagSnapshot>
  >();
  private readonly recentScopedSnapshots = new Map<string, Readonly<{
    expiresAtMs: number;
    snapshot: LoadedFlagSnapshot;
  }>>();
  private readonly quoteMetrics = {
    quoteCreated: 0,
    quoteReused: 0,
    quoteSingleflightJoined: 0,
    validQuoteReplacement: 0,
    postBuildQuoteSuppressed: 0
  };

  constructor(
    private readonly pool: pg.Pool,
    private readonly worldLookup: WorldLookupClient,
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    inventory?: InventoryService,
    private readonly masteries?: MasteryService
  ) {
    this.inventory = inventory ?? new InventoryService(pool);
    this.warfare = new StructureWarfareService(
      new PersonalFlagWarfareAdapter(this, this.inventory)
    );
  }

  get databasePool(): pg.Pool {
    return this.pool;
  }

  get structureWarfare(): StructureWarfareService {
    return this.warfare;
  }

  /**
   * Repair rows left at zero health by older damage paths before they can be
   * loaded into a map or target picker.  Only terminal, health-bearing
   * standalone personal Flags are considered; positive-health structures are
   * never touched.
   */
  async reconcileZeroHealthFlags(limit = 100): Promise<readonly BurnFlagDeletionResult[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1_000);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const retired: BurnFlagDeletionResult[] = [];
      while (true) {
        const candidates = await client.query<{ id: string }>(
          `SELECT id::text
           FROM flags
           WHERE control_type='personal' AND anchor_kind IN ('flag','buoy')
             AND system_controlled=false AND city_id IS NULL AND kingdom_id IS NULL
             AND health IS NOT NULL AND maximum_health IS NOT NULL
             AND maximum_health > 0 AND health <= 0
           ORDER BY id
           LIMIT $1`,
          [boundedLimit]
        );
        for (const candidate of candidates.rows) {
          const result = await retireZeroHealthFlagInTransaction(client, candidate.id);
          if (result) retired.push(result);
        }
        if (candidates.rows.length < boundedLimit) break;
      }
      await client.query("COMMIT");
      return retired;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listFlags(
    bbox?: BBox,
    limit = 500,
    afterId?: string,
    queryable: pg.Pool | pg.PoolClient = this.pool,
    keysetOrder = false
  ): Promise<FlagSnapshot[]> {
    if (
      queryable === this.pool
      && typeof (this.pool as unknown as { connect?: unknown }).connect === "function"
    ) await this.reconcileZeroHealthFlags();
    const boundedLimit = Math.min(Math.max(limit, 1), 1_000);
    const orderBy = keysetOrder ? "f.id ASC" : "f.created_at DESC";
    const result = bbox
      ? await queryable.query<FlagRow>(
          `
          SELECT f.id, COALESCE(test.test_owner_id, f.owner_id) AS owner_id,
                 CASE WHEN test.flag_id IS NOT NULL THEN test.test_owner_name ELSE p.username END AS owner_username,
                 CASE WHEN test.flag_id IS NOT NULL THEN $6
                      ELSE COALESCE(personal_flag_color_hex(p.personal_flag_color), $6) END AS owner_color,
                 f.name, f.lat, f.lon, f.package_id, f.elevation_m, f.terrain_class,
                 f.biome, f.ecoregion,
                 CASE WHEN f.control_type = 'kingdom_seat'
                   THEN COALESCE(seat.territory_radius_m, f.claim_radius_m) ELSE f.claim_radius_m
                 END AS claim_radius_m,
                 f.resource_vision_radius_m, f.access_mode, f.jump_toll_gold::text,
                 f.access_revision::text,
                 f.city_id, f.presentation_color, f.system_controlled, f.developer_test_target,
                 f.reinforcement_level, f.tower_level, f.obelisk_level, f.war_structure_kind, f.war_id, f.health, f.maximum_health,
                 f.burning_started_at, f.burning_until, f.burning_reason,
                 live_event.bird_species AS legendary_bird_species,
                 f.atlas_shrine_slot_number,
                  f.anchor_kind, f.control_type, f.kingdom_id, k.display_name AS kingdom_name,
                  k.emblem_key AS kingdom_emblem_key, k.display_color AS kingdom_color,
                  seat.id AS kingdom_seat_id,
                  seat.construction_state AS kingdom_seat_construction_state,
                  seat.lat AS kingdom_seat_lat, seat.lon AS kingdom_seat_lon,
                  f.kingdom_affiliated_at, f.original_owner_player_id,
                  f.contributed_by_player_id, contributor.username AS contributed_by_username,
                  f.original_personal_color, f.created_at
          FROM flags f
          LEFT JOIN developer_spawned_test_flags test ON test.flag_id = f.id
          LEFT JOIN players p ON p.id = f.owner_id
          LEFT JOIN kingdoms k ON k.id = f.kingdom_id AND k.status = 'active'
          LEFT JOIN kingdom_seats seat
            ON seat.source_flag_id = f.id AND seat.status = 'active'
          LEFT JOIN players contributor ON contributor.id = f.contributed_by_player_id
          LEFT JOIN legendary_bird_events live_event
            ON live_event.flag_id=f.id AND live_event.status IN ('pending','active')
          WHERE (
              f.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
              OR seat.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            )
            AND ($7::uuid IS NULL OR f.id > $7::uuid)
          ORDER BY ${orderBy}
          LIMIT $5
          `,
          [
            bbox.west,
            bbox.south,
            bbox.east,
            bbox.north,
            boundedLimit,
            DEFAULT_FLAG_COLOR,
            afterId ?? null
          ]
        )
      : await queryable.query<FlagRow>(
          `
          SELECT f.id, COALESCE(test.test_owner_id, f.owner_id) AS owner_id,
                 CASE WHEN test.flag_id IS NOT NULL THEN test.test_owner_name ELSE p.username END AS owner_username,
                 CASE WHEN test.flag_id IS NOT NULL THEN $2
                      ELSE COALESCE(personal_flag_color_hex(p.personal_flag_color), $2) END AS owner_color,
                 f.name, f.lat, f.lon, f.package_id, f.elevation_m, f.terrain_class,
                 f.biome, f.ecoregion,
                 CASE WHEN f.control_type = 'kingdom_seat'
                   THEN COALESCE(seat.territory_radius_m, f.claim_radius_m) ELSE f.claim_radius_m
                 END AS claim_radius_m,
                 f.resource_vision_radius_m, f.access_mode, f.jump_toll_gold::text,
                 f.access_revision::text,
                 f.city_id, f.presentation_color, f.system_controlled, f.developer_test_target,
                 f.reinforcement_level, f.tower_level, f.obelisk_level, f.war_structure_kind, f.war_id, f.health, f.maximum_health,
                 f.burning_started_at, f.burning_until, f.burning_reason,
                 live_event.bird_species AS legendary_bird_species,
                 f.atlas_shrine_slot_number,
                  f.anchor_kind, f.control_type, f.kingdom_id, k.display_name AS kingdom_name,
                  k.emblem_key AS kingdom_emblem_key, k.display_color AS kingdom_color,
                  seat.id AS kingdom_seat_id,
                  seat.construction_state AS kingdom_seat_construction_state,
                  seat.lat AS kingdom_seat_lat, seat.lon AS kingdom_seat_lon,
                  f.kingdom_affiliated_at, f.original_owner_player_id,
                  f.contributed_by_player_id, contributor.username AS contributed_by_username,
                  f.original_personal_color, f.created_at
          FROM flags f
          LEFT JOIN developer_spawned_test_flags test ON test.flag_id = f.id
          LEFT JOIN players p ON p.id = f.owner_id
          LEFT JOIN kingdoms k ON k.id = f.kingdom_id AND k.status = 'active'
          LEFT JOIN kingdom_seats seat
            ON seat.source_flag_id = f.id AND seat.status = 'active'
          LEFT JOIN players contributor ON contributor.id = f.contributed_by_player_id
          LEFT JOIN legendary_bird_events live_event
            ON live_event.flag_id=f.id AND live_event.status IN ('pending','active')
          WHERE ($3::uuid IS NULL OR f.id > $3::uuid)
          ORDER BY ${orderBy}
          LIMIT $1
          `,
          [boundedLimit, DEFAULT_FLAG_COLOR, afterId ?? null]
        );
    return result.rows.map((row) => rowToFlag(row));
  }

  async listFlagsInGameplayCircle(
    scope: FlagSnapshotScope,
    limit = 500,
    afterId?: string,
    queryable: pg.Pool | pg.PoolClient = this.pool
  ): Promise<FlagSnapshot[]> {
    if (
      queryable === this.pool
      && typeof (this.pool as unknown as { connect?: unknown }).connect === "function"
    ) await this.reconcileZeroHealthFlags();
    if (
      !Number.isFinite(scope.center.lat)
      || !Number.isFinite(scope.center.lon)
      || !Number.isFinite(scope.radiusM)
      || scope.radiusM <= 0
    ) throw new Error("flag snapshot gameplay circle is invalid");
    const boundedLimit = Math.min(Math.max(limit, 1), 1_000);
    const result = await queryable.query<FlagRow>(
      `
      WITH query_circle AS (
        SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS center,
               $3::double precision AS radius_m
      )
      SELECT f.id, COALESCE(test.test_owner_id, f.owner_id) AS owner_id,
             CASE WHEN test.flag_id IS NOT NULL THEN test.test_owner_name ELSE p.username END AS owner_username,
             CASE WHEN test.flag_id IS NOT NULL THEN $5
                  ELSE COALESCE(personal_flag_color_hex(p.personal_flag_color), $5) END AS owner_color,
             f.name, f.lat, f.lon, f.package_id, f.elevation_m, f.terrain_class,
             f.biome, f.ecoregion,
             CASE WHEN f.control_type = 'kingdom_seat'
               THEN COALESCE(seat.territory_radius_m, f.claim_radius_m) ELSE f.claim_radius_m
             END AS claim_radius_m,
             f.resource_vision_radius_m, f.access_mode, f.jump_toll_gold::text,
             f.access_revision::text,
             f.city_id, f.presentation_color, f.system_controlled, f.developer_test_target,
             f.reinforcement_level, f.tower_level, f.obelisk_level, f.war_structure_kind, f.war_id, f.health, f.maximum_health,
             f.burning_started_at, f.burning_until, f.burning_reason,
             live_event.bird_species AS legendary_bird_species,
             f.atlas_shrine_slot_number,
             f.anchor_kind, f.control_type, f.kingdom_id, k.display_name AS kingdom_name,
             k.emblem_key AS kingdom_emblem_key, k.display_color AS kingdom_color,
             seat.id AS kingdom_seat_id,
             seat.construction_state AS kingdom_seat_construction_state,
             seat.lat AS kingdom_seat_lat, seat.lon AS kingdom_seat_lon,
             f.kingdom_affiliated_at, f.original_owner_player_id,
             f.contributed_by_player_id, contributor.username AS contributed_by_username,
             f.original_personal_color, f.created_at
      FROM flags f
      LEFT JOIN developer_spawned_test_flags test ON test.flag_id = f.id
      LEFT JOIN players p ON p.id = f.owner_id
      LEFT JOIN kingdoms k ON k.id = f.kingdom_id AND k.status = 'active'
      LEFT JOIN kingdom_seats seat
        ON seat.source_flag_id = f.id AND seat.status = 'active'
      LEFT JOIN players contributor ON contributor.id = f.contributed_by_player_id
      LEFT JOIN legendary_bird_events live_event
        ON live_event.flag_id=f.id AND live_event.status IN ('pending','active')
      CROSS JOIN query_circle
      WHERE ($6::uuid IS NULL OR f.id > $6::uuid)
        AND (
          (
            ST_DWithin(
              f.geom::geography,
              query_circle.center,
              query_circle.radius_m + $7
            )
            AND ST_DWithin(
              f.geom::geography,
              query_circle.center,
              query_circle.radius_m + f.claim_radius_m
            )
          )
          OR (
            seat.geom IS NOT NULL
            AND ST_DWithin(
              seat.geom::geography,
              query_circle.center,
              query_circle.radius_m + seat.territory_radius_m
            )
          )
        )
      ORDER BY f.id ASC
      LIMIT $4
      `,
      [
        scope.center.lon,
        scope.center.lat,
        scope.radiusM,
        boundedLimit,
        DEFAULT_FLAG_COLOR,
        afterId ?? null,
        MAX_FLAG_CLAIM_RADIUS_M
      ]
    );
    return result.rows.map((row) => rowToFlag(row));
  }

  async streamFlagSnapshot(
    onChunk: (chunk: FlagSnapshotChunk) => boolean | Promise<boolean>,
    pageSize = 250,
    scope?: FlagSnapshotScope
  ): Promise<Readonly<{
    flagSetRevision: number;
    chunksPublished: number;
    flagsPublished: number;
    completed: boolean;
  }>> {
    const boundedPageSize = Math.min(Math.max(pageSize, 1), 500);
    const { flagSetRevision, chunks } = await this.loadFlagSnapshotChunks(
      boundedPageSize,
      scope
    );

    // Network backpressure is intentionally handled only after the repeatable-read
    // transaction and its pooled connection have been released. A slow or stalled
    // socket must never be able to hold a database lease during login.
    let chunksPublished = 0;
    let flagsPublished = 0;
    for (const chunk of chunks) {
      const accepted = await onChunk(chunk);
      if (!accepted) {
        return {
          flagSetRevision,
          chunksPublished,
          flagsPublished,
          completed: false
        };
      }
      chunksPublished += 1;
      flagsPublished += chunk.flags.length;
    }
    return {
      flagSetRevision,
      chunksPublished,
      flagsPublished,
      completed: true
    };
  }

  private async loadFlagSnapshotChunks(
    pageSize: number,
    scope?: FlagSnapshotScope
  ): Promise<LoadedFlagSnapshot> {
    if (!scope) return this.readFlagSnapshotChunks(pageSize, scope);
    const cacheKey = scopedFlagSnapshotCacheKey(pageSize, scope);
    const cached = this.recentScopedSnapshots.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      const currentRevision = await this.currentFlagSetRevision();
      if (currentRevision === cached.snapshot.flagSetRevision) {
        return cached.snapshot;
      }
      this.recentScopedSnapshots.delete(cacheKey);
    }
    const existing = this.scopedSnapshotFlights.get(cacheKey);
    if (existing) return existing;
    const flight = this.readFlagSnapshotChunks(pageSize, scope).then(
      (snapshot) => {
        this.recentScopedSnapshots.set(cacheKey, {
          expiresAtMs: Date.now() + SCOPED_FLAG_SNAPSHOT_REUSE_MS,
          snapshot
        });
        while (
          this.recentScopedSnapshots.size > MAX_RECENT_SCOPED_FLAG_SNAPSHOTS
        ) {
          this.recentScopedSnapshots.delete(
            this.recentScopedSnapshots.keys().next().value!
          );
        }
        return snapshot;
      }
    );
    this.scopedSnapshotFlights.set(cacheKey, flight);
    void flight.finally(() => {
      if (this.scopedSnapshotFlights.get(cacheKey) === flight) {
        this.scopedSnapshotFlights.delete(cacheKey);
      }
    }).catch(() => undefined);
    return flight;
  }

  private async readFlagSnapshotChunks(
    boundedPageSize: number,
    scope?: FlagSnapshotScope
  ): Promise<LoadedFlagSnapshot> {
    const client = await this.pool.connect();
    let snapshotLockHeld = false;
    let transactionOpen = false;
    let flagSetRevision = 0;
    const chunks: FlagSnapshotChunk[] = [];
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        [FLAG_SNAPSHOT_ADVISORY_LOCK]
      );
      snapshotLockHeld = true;
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionOpen = true;
      await client.query(
        "SELECT revision FROM flag_set_revision WHERE singleton"
      );
      const revisionResult = await client.query<{ revision: string | number }>(
        "SELECT last_value AS revision FROM flag_set_revision_sequence"
      );
      flagSetRevision = Number(revisionResult.rows[0]?.revision ?? 0);
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [FLAG_SNAPSHOT_ADVISORY_LOCK]
      );
      snapshotLockHeld = false;
      const listPage = (afterId?: string): Promise<FlagSnapshot[]> =>
        scope
          ? this.listFlagsInGameplayCircle(
              scope,
              boundedPageSize,
              afterId,
              client
            )
          : this.listFlags(
              undefined,
              boundedPageSize,
              afterId,
              client,
              true
            );
      let current = await listPage();
      let chunkIndex = 0;
      while (true) {
        const next = current.length === boundedPageSize
          ? await listPage(current.at(-1)!.id)
          : [];
        const finalChunk = next.length === 0;
        chunks.push({
          flags: current,
          flagSetRevision,
          chunkIndex,
          finalChunk
        });
        if (finalChunk) {
          await client.query("COMMIT");
          transactionOpen = false;
          break;
        }
        current = next;
        chunkIndex += 1;
      }
    } catch (error) {
      if (transactionOpen) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      if (snapshotLockHeld) {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [FLAG_SNAPSHOT_ADVISORY_LOCK]
        ).catch(() => undefined);
      }
      client.release();
    }
    return { flagSetRevision, chunks };
  }

  async currentFlagSetRevision(): Promise<number> {
    const result = await this.pool.query<{ revision: string | number }>(
      "SELECT last_value AS revision FROM flag_set_revision_sequence"
    );
    return Number(result.rows[0]?.revision ?? 0);
  }

  async getFlag(flagId: string): Promise<FlagSnapshot | null> {
    return this.loadFlag(flagId);
  }

  async getMapFlag(flagId: string): Promise<FlagSnapshot | null> {
    return this.loadFlag(flagId);
  }

  async createDeveloperTestFlag(input: Readonly<{
    creatorPlayerId: string;
    requestId: string;
    targetKind: DeveloperTestFlagKind;
    position: Readonly<{ lat: number; lon: number }>;
  }>): Promise<DeveloperTestFlagSpawnResult> {
    if (!input.creatorPlayerId || input.requestId.length < 1 || input.requestId.length > 128) {
      throw new FlagPlacementError("A valid developer test flag request is required.", "DEV_FLAG_SPAWN_INVALID_REQUEST");
    }
    if (
      !Number.isFinite(input.position.lat) ||
      !Number.isFinite(input.position.lon) ||
      input.position.lat < -90 ||
      input.position.lat > 90 ||
      input.position.lon < -180 ||
      input.position.lon > 180
    ) {
      throw new FlagPlacementError("Developer test flag coordinates are invalid.", "DEV_FLAG_SPAWN_INVALID_POSITION");
    }
    if (!isWithinWorldEdge(input.position)) {
      throw new FlagPlacementError(WORLD_EDGE_MESSAGE, "DEV_FLAG_SPAWN_INVALID_POSITION");
    }
    const target = developerTestFlagTarget(input.targetKind);
    const world = await this.worldLookup.lookupGameplayEnvironment(
      input.position.lat,
      input.position.lon
    );
    if (!world.ok) {
      throw new FlagPlacementError(
        "Authoritative world terrain is unavailable for this test flag.",
        "DEV_FLAG_SPAWN_WORLD_UNAVAILABLE",
        true
      );
    }
    this.assertWorldLookupPlaceable(world, "flag");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`developer-test-flag:${input.creatorPlayerId}:${input.requestId}`]
      );
      const prior = await client.query<{
        flag_id: string;
        target_kind: DeveloperTestFlagKind;
        spawn_lat: number;
        spawn_lon: number;
      }>(
        `SELECT flag_id::text,target_kind,spawn_lat,spawn_lon
         FROM developer_spawned_test_flags
         WHERE creator_player_id=$1 AND request_id=$2
         FOR UPDATE`,
        [input.creatorPlayerId, input.requestId]
      );
      if (prior.rows[0]) {
        const existing = prior.rows[0];
        if (
          existing.target_kind !== input.targetKind
          || Math.abs(Number(existing.spawn_lat) - input.position.lat) > 0.0000001
          || Math.abs(Number(existing.spawn_lon) - input.position.lon) > 0.0000001
        ) {
          throw new FlagPlacementError(
            "That developer test flag request ID was already used for different work.",
            "DEV_FLAG_SPAWN_REPLAY_CONFLICT"
          );
        }
        await client.query("COMMIT");
        const flag = await this.getMapFlag(existing.flag_id);
        if (!flag) {
          throw new FlagPlacementError(
            "The previously spawned developer test flag is no longer available.",
            "DEV_FLAG_SPAWN_REPLAY_MISSING"
          );
        }
        return { flag, replayed: true };
      }
      const flagId = randomUUID();
      await this.insertFlag({
        id: flagId,
        anchorKind: "flag",
        ownerId: input.creatorPlayerId,
        name: target.name,
        lat: input.position.lat,
        lon: input.position.lon,
        world,
        reinforcementLevel: target.reinforcementLevel,
        developerTestTarget: true,
        accessMode: "normal"
      }, client);
      await client.query(
        `INSERT INTO developer_spawned_test_flags (
           flag_id,creator_player_id,request_id,target_kind,spawn_lat,spawn_lon,
           test_owner_id,test_owner_name
         ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8)`,
        [
          flagId,
          input.creatorPlayerId,
          input.requestId,
          input.targetKind,
          input.position.lat,
          input.position.lon,
          DEVELOPER_TEST_OWNER_ID,
          DEVELOPER_TEST_OWNER_NAME
        ]
      );
      await client.query("COMMIT");
      const flag = await this.getMapFlag(flagId);
      if (!flag) throw new FlagPlacementError("Developer test flag could not be loaded after creation.");
      return { flag, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadFlag(flagId: string): Promise<FlagSnapshot | null> {
    if (typeof (this.pool as unknown as { connect?: unknown }).connect === "function") {
      await this.reconcileZeroHealthFlags();
    }
    const result = await this.pool.query<FlagRow>(
      `
      SELECT f.id, COALESCE(test.test_owner_id, f.owner_id) AS owner_id,
             CASE WHEN test.flag_id IS NOT NULL THEN test.test_owner_name ELSE p.username END AS owner_username,
             CASE WHEN test.flag_id IS NOT NULL THEN $2
                  ELSE COALESCE(personal_flag_color_hex(p.personal_flag_color), $2) END AS owner_color,
             f.name, f.lat, f.lon, f.package_id, f.elevation_m, f.terrain_class,
             f.biome, f.ecoregion,
             CASE WHEN f.control_type = 'kingdom_seat'
               THEN COALESCE(seat.territory_radius_m, f.claim_radius_m) ELSE f.claim_radius_m
             END AS claim_radius_m,
             f.resource_vision_radius_m, f.access_mode, f.jump_toll_gold::text,
             f.access_revision::text,
             f.city_id, f.presentation_color, f.system_controlled, f.developer_test_target,
             f.reinforcement_level, f.tower_level, f.obelisk_level, f.war_structure_kind, f.war_id, f.health, f.maximum_health,
             f.burning_started_at, f.burning_until, f.burning_reason,
             live_event.bird_species AS legendary_bird_species,
             f.atlas_shrine_slot_number,
             f.anchor_kind, f.control_type, f.kingdom_id, k.display_name AS kingdom_name,
             k.emblem_key AS kingdom_emblem_key, k.display_color AS kingdom_color,
             seat.id AS kingdom_seat_id,
             seat.construction_state AS kingdom_seat_construction_state,
             seat.lat AS kingdom_seat_lat, seat.lon AS kingdom_seat_lon,
             f.kingdom_affiliated_at, f.original_owner_player_id,
             f.contributed_by_player_id, contributor.username AS contributed_by_username,
             f.original_personal_color, f.created_at
      FROM flags f
      LEFT JOIN developer_spawned_test_flags test ON test.flag_id = f.id
      LEFT JOIN players p ON p.id = f.owner_id
      LEFT JOIN kingdoms k ON k.id = f.kingdom_id AND k.status = 'active'
      LEFT JOIN kingdom_seats seat
        ON seat.source_flag_id = f.id AND seat.status = 'active'
      LEFT JOIN players contributor ON contributor.id = f.contributed_by_player_id
      LEFT JOIN legendary_bird_events live_event
        ON live_event.flag_id=f.id AND live_event.status IN ('pending','active')
      WHERE f.id = $1
      `,
      [flagId, DEFAULT_FLAG_COLOR]
    );
    const row = result.rows[0];
    return row ? rowToFlag(row) : null;
  }

  async getEnvironmentDetails(flagId: string): Promise<FlagEnvironmentDetails | null> {
    const row = await this.getEnvironmentRow(flagId);
    return row ? buildFlagEnvironmentDetails(row, this.config) : null;
  }

  async getEnvironmentDiagnostics(flagId: string): Promise<FlagEnvironmentDiagnostics | null> {
    const row = await this.getEnvironmentRow(flagId);
    if (!row) return null;
    const stored = buildFlagEnvironmentDetails(row, this.config);
    const lookupStartedAt = new Date();
    const startedMs = performance.now();
    const world = await this.worldLookup.lookup(Number(row.lat), Number(row.lon));
    const durationMs = Math.max(0, performance.now() - startedMs);
    const live = buildFlagEnvironmentDetails({
      ...row,
      package_id: world.packageId,
      elevation_m: world.elevationM,
      terrain_class: world.terrainClass,
      biome: world.biome,
      ecoregion: world.ecoregion,
      environment_snapshot: world.raw,
      updated_at: lookupStartedAt
    }, this.config);
    return {
      stored,
      live: {
        details: live,
        rawLookup: world.raw,
        lookupStartedAt: lookupStartedAt.toISOString(),
        durationMs,
        packageCacheState: flagEnvironmentCacheState(world.raw)
      },
      comparison: buildFlagEnvironmentComparison(stored, live),
      required: {
        environmentSchemaVersion: "world-profile-v2",
        worldReleaseId: this.config.WORLD_REQUIRED_RELEASE_ID,
        profileSetFingerprint: this.config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT,
        buildContractFingerprint: this.config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT,
        boundaryReleaseId: this.config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID
      },
      refreshRecommended: stored.provenance.snapshotStatus !== "current"
    };
  }

  private async getEnvironmentRow(flagId: string): Promise<PersistedFlagEnvironmentRow | null> {
    const result = await this.pool.query<PersistedFlagEnvironmentRow>(
      `
      SELECT f.id, f.owner_id, p.username AS owner_username,
             COALESCE(personal_flag_color_hex(p.personal_flag_color), $2) AS owner_color,
             gc.name AS gameplay_city_name,
             f.name, f.lat, f.lon, f.package_id, f.elevation_m, f.terrain_class,
             f.biome, f.ecoregion, f.claim_radius_m, f.resource_vision_radius_m, f.city_id,
             f.environment_snapshot, f.created_at, f.updated_at
      FROM flags f
      LEFT JOIN players p ON p.id = f.owner_id
      LEFT JOIN cities gc ON gc.id = f.city_id
      WHERE f.id = $1
      `,
      [flagId, DEFAULT_FLAG_COLOR]
    );
    return result.rows[0] ?? null;
  }

  async refreshEnvironment(flagId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ id: string; lat: number; lon: number }>(
        "SELECT id, lat, lon FROM flags WHERE id = $1 FOR UPDATE",
        [flagId]
      );
      const flag = selected.rows[0];
      if (!flag) {
        throw new PublicFlagEnvironmentRefreshError("Flag does not exist.");
      }
      const world = await this.worldLookup.lookupGameplayEnvironment(
        Number(flag.lat),
        Number(flag.lon)
      );
      if (!world.ok) {
        this.logger.warn({ flagId, warning: world.warning }, "authoritative flag environment refresh lookup failed");
        throw new PublicFlagEnvironmentRefreshError("Authoritative world lookup failed.");
      }
      const environment = prepareFlagEnvironmentPersistence(world);
      await client.query(
        `
        UPDATE flags
        SET package_id = $2,
            elevation_m = $3,
            terrain_class = $4,
            biome = $5,
            ecoregion = $6,
            environment_snapshot = $7::jsonb
        WHERE id = $1
        `,
        [
          flagId,
          environment.packageId,
          environment.elevationM,
          environment.terrainClass,
          environment.biome,
          environment.ecoregion,
          environment.snapshotJson
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshAllEnvironments(limit = 1_000): Promise<FlagEnvironmentRefreshReport> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1_000);
    const selected = await this.pool.query<{ id: string }>(
      "SELECT id FROM flags ORDER BY created_at ASC, id ASC LIMIT $1",
      [boundedLimit + 1]
    );
    const ids = selected.rows.slice(0, boundedLimit).map((row) => row.id);
    const failures: FlagEnvironmentRefreshFailure[] = [];
    const refreshedFlagIds: string[] = [];
    let refreshed = 0;
    for (const id of ids) {
      try {
        await this.refreshEnvironment(id);
        refreshed += 1;
        refreshedFlagIds.push(id);
      } catch (error) {
        this.logger.warn({ err: error, flagId: id }, "flag environment refresh failed");
        failures.push({
          flagId: id,
          error: flagEnvironmentRefreshFailureMessage(error)
        });
      }
    }
    return {
      requested: ids.length,
      refreshed,
      refreshedFlagIds,
      failures,
      truncated: selected.rows.length > boundedLimit
    };
  }

  async refreshEnvironmentsNeedingRefresh(limit = 100): Promise<FlagEnvironmentRefreshReport> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1_000);
    const selected = await this.pool.query<{ id: string }>(
      "SELECT id FROM flags ORDER BY created_at ASC, id ASC LIMIT 1001"
    );
    const ids: string[] = [];
    for (const row of selected.rows) {
      const details = await this.getEnvironmentDetails(row.id);
      if (details && details.provenance.snapshotStatus !== "current") ids.push(row.id);
      if (ids.length > boundedLimit) break;
    }
    const requestedIds = ids.slice(0, boundedLimit);
    const failures: FlagEnvironmentRefreshFailure[] = [];
    const refreshedFlagIds: string[] = [];
    let refreshed = 0;
    for (const id of requestedIds) {
      try {
        await this.refreshEnvironment(id);
        refreshed += 1;
        refreshedFlagIds.push(id);
      } catch (error) {
        this.logger.warn({ err: error, flagId: id }, "flag environment refresh failed");
        failures.push({
          flagId: id,
          error: flagEnvironmentRefreshFailureMessage(error)
        });
      }
    }
    return {
      requested: requestedIds.length,
      refreshed,
      refreshedFlagIds,
      failures,
      truncated: ids.length > boundedLimit || selected.rows.length > 1_000
    };
  }

  async countFlags(): Promise<number> {
    const result = await this.pool.query<{ count: string }>("SELECT count(*) AS count FROM flags");
    return Number(result.rows[0]?.count ?? 0);
  }

  async clearFlags(): Promise<Readonly<{
    deletedFlagIds: string[];
    legendaryCombatEntityIds: string[];
  }>> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext('legendary-bird-daily-cycle-v1'))");
      const legendary = await client.query<{ combat_entity_id: string }>(
        `SELECT combat_entity_id::text FROM legendary_bird_events
         WHERE status='active' ORDER BY combat_entity_id FOR UPDATE`
      );
      await client.query(
        `UPDATE flag_burn_operations
         SET status='cancelled',cancel_reason='flags-cleared',completed_at=clock_timestamp(),paused_at=NULL
         WHERE status='active'`,
      );
      const deleted = await client.query<{ id: string }>("DELETE FROM flags RETURNING id::text");
      await client.query("COMMIT");
      transactionOpen = false;
      return {
        deletedFlagIds: deleted.rows.map((row) => row.id),
        legendaryCombatEntityIds: legendary.rows.map((row) => row.combat_entity_id)
      };
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listFlagsForOwner(ownerId: string): Promise<FlagSnapshot[]> {
    const ids = await this.pool.query<{ id: string }>(
      "SELECT id FROM flags WHERE owner_id = $1 ORDER BY id",
      [ownerId]
    );
    const snapshots = await Promise.all(
      ids.rows.map((row) => this.getMapFlag(row.id))
    );
    return snapshots.filter((flag): flag is FlagSnapshot => flag !== null);
  }

  async deleteFlag(
    flagId: string,
    actorId: string | null = null,
    bypassAuthority = false,
    requestId: string = randomUUID()
  ): Promise<DeleteFlagResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (actorId) {
        const replay = await replayFlagDestruction(
          client,
          this.inventory,
          `flag-destroy:${actorId}:${requestId}`,
          actorId,
          requestId,
          flagId
        );
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }
      }
      const hint = await client.query<{
        control_type: "personal" | "city" | "city_seat" | "kingdom" | "kingdom_seat";
        owner_id: string;
        city_id: string | null;
        kingdom_id: string | null;
        kingdom_founding_request_id: string | null;
        lat: number;
        lon: number;
        region_code: string;
      }>(
        `SELECT flag.control_type,flag.owner_id,flag.city_id,flag.kingdom_id,
                flag.kingdom_founding_request_id,flag.lat,flag.lon,
                owner.region_code
         FROM flags flag
         JOIN players owner ON owner.id=flag.owner_id
         WHERE flag.id = $1`,
        [flagId]
      );
      const hintedControl = hint.rows[0];
      if (!hintedControl) throw new Error("flag does not exist");
      const effectiveActorId = actorId ?? hintedControl.owner_id;
      const operationKey = `flag-destroy:${effectiveActorId}:${requestId}`;
      if (hintedControl.control_type === "kingdom_seat") {
        throw hintedControl.kingdom_founding_request_id
          ? new KingdomError("KINGDOM_FOUNDING_FLAG_RESERVED", "A reserved Castle source flag cannot be destroyed")
          : new KingdomError("KINGDOM_PERMISSION_DENIED", "A completed Castle is governed by Kingdom dissolution", 403);
      }
      if (hintedControl.control_type === "city_seat") {
        throw new CityFoundingError(
          "CITY_PERMISSION_DENIED",
          "A City Center is governed by city deactivation"
        );
      }
      const hintedCityId = isCityControlledFlag(hintedControl)
        ? hintedControl.city_id
        : null;
      if (hintedCityId) {
        if (!bypassAuthority) {
          if (!actorId) {
            throw new CityFoundingError(
              "CITY_PLAYER_REQUIRED",
              "An authenticated player is required"
            );
          }
          await assertCityFlagAction(client, actorId, hintedCityId);
        }
        await lockCityFlagNetwork(client, hintedCityId);
      }
      const hintedKingdomId = isKingdomControlledFlag(hintedControl)
        ? hintedControl.kingdom_id
        : null;
      if (hintedKingdomId) {
        if (!bypassAuthority) {
          if (!actorId) throw new KingdomError("KINGDOM_PLAYER_REQUIRED", "An authenticated player is required", 401);
          await assertKingdomFlagAction(client, actorId, hintedKingdomId, "destroy");
        }
        await lockKingdomFlagNetwork(client, hintedKingdomId);
      }
      // Warfare terminalization follows disrupt -> repair -> burn -> flag
      // lock order, matching repair/disrupt completion and shutdown recovery.
      // Lock the live operations before the flag so an owner demolition cannot
      // deadlock a channel that is settling against the same target.
      await client.query(
        `SELECT operation_id
         FROM flag_repair_disrupt_operations
         WHERE flag_id=$1 AND status='active'
         ORDER BY operation_id
         FOR UPDATE`,
        [flagId]
      );
      await client.query(
        `SELECT operation_id
         FROM flag_repair_operations
         WHERE flag_id=$1 AND status='active'
         ORDER BY operation_id
         FOR UPDATE`,
        [flagId]
      );
      await client.query(
        `SELECT operation_id
         FROM flag_burn_operations
         WHERE flag_id=$1 AND status='active'
         ORDER BY operation_id
         FOR UPDATE`,
        [flagId]
      );
      // The burn completion path already owns its operation before taking the
      // shared geometry lock.  Keep demolition in that same order so a late
      // burn completion and owner removal cannot wait on one another.
      await lockFlagControlGeometry(client);
      const locked = await client.query<{
        control_type: "personal" | "city" | "city_seat" | "kingdom" | "kingdom_seat";
        owner_id: string;
        city_id: string | null;
        kingdom_id: string | null;
        damage_cycle_id: string | null;
        burning_reason: string | null;
      }>(
        "SELECT control_type, owner_id, city_id, kingdom_id, damage_cycle_id, burning_reason FROM flags WHERE id = $1 FOR UPDATE",
        [flagId]
      );
      const control = locked.rows[0];
      if (!control) throw new Error("flag does not exist");
      const hostileDamageBegan =
        control.damage_cycle_id !== null || control.burning_reason === "flag_burn";
      const kingdomId = isKingdomControlledFlag(control) ? control.kingdom_id : null;
      const cityId = isCityControlledFlag(control) ? control.city_id : null;
      if (hintedCityId !== cityId) {
        throw new CityFoundingError(
          "CITY_FLAG_CONTROL_CHANGED",
          "Flag control changed during deletion confirmation"
        );
      }
      if (hintedKingdomId !== kingdomId) {
        throw new KingdomError("KINGDOM_FLAG_CONTROL_CHANGED", "Flag control changed during deletion confirmation");
      }
      if (!cityId && !kingdomId && !bypassAuthority) {
        if (!actorId) throw new KingdomError("KINGDOM_PLAYER_REQUIRED", "An authenticated player is required", 401);
        if (!isPersonalFlagControlledByPlayer(control, actorId)) {
          throw new KingdomError("KINGDOM_PERMISSION_DENIED", "You cannot destroy another player's personal flag", 403);
        }
      }
      const legendaryEvent = await client.query<{ event_id: string }>(
        `SELECT event_id::text
         FROM legendary_bird_events
         WHERE flag_id=$1 AND status IN ('pending','active')
         LIMIT 1`,
        [flagId]
      );
      if (legendaryEvent.rowCount !== 0) {
        throw new FlagDestructionError(
          "FLAG_LEGENDARY_EVENT_ACTIVE",
          "This Stone Flag cannot be destroyed while its legendary encounter is available."
        );
      }
      const reserved = await client.query(
        `INSERT INTO flag_destruction_operations (
           operation_key,actor_player_id,request_id,flag_id,intent
         ) VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          operationKey,
          effectiveActorId,
          requestId,
          flagId,
          JSON.stringify({ flagId })
        ]
      );
      if (reserved.rowCount !== 1) {
        const replay = await replayFlagDestruction(
          client,
          this.inventory,
          operationKey,
          effectiveActorId,
          requestId,
          flagId
        );
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }
        throw new Error("Flag destruction operation is incomplete");
      }

      // Destruction is a terminal lifecycle boundary.  End any durable
      // warfare channels before the row is removed so a late timer cannot
      // resume a deleted Flag or leave an orphaned active burn.
      await client.query(
        `UPDATE flag_repair_disrupt_operations
         SET status='cancelled',cancel_reason='flag-destroyed',completed_at=now()
         WHERE flag_id=$1 AND status='active'`,
        [flagId]
      );
      await client.query(
        `UPDATE flag_repair_operations
         SET status='cancelled',cancel_reason='flag-destroyed',completed_at=now()
         WHERE flag_id=$1 AND status='active'`,
        [flagId]
      );
      await client.query(
        `UPDATE flag_burn_operations
         SET status='cancelled',cancel_reason='flag-destroyed',completed_at=now(),paused_at=NULL
         WHERE flag_id=$1 AND status='active'`,
        [flagId]
      );

      const spend = await client.query<{
        paid_by_player_id: string;
        item_id: ResourceType;
        variant: string;
        invested_quantity: string;
      }>(
        `SELECT paid_by_player_id,item_id,variant,
                sum(quantity)::text AS invested_quantity
         FROM flag_material_spend
         WHERE flag_id=$1
           AND item_id <> 'atlas_shrine_shard'
         GROUP BY paid_by_player_id,item_id,variant
         ORDER BY paid_by_player_id,item_id,variant`,
        [flagId]
      );
      const spendByPlayer = new Map<string, typeof spend.rows>();
      for (const line of spend.rows) {
        const playerSpend = spendByPlayer.get(line.paid_by_player_id) ?? [];
        playerSpend.push(line);
        spendByPlayer.set(line.paid_by_player_id, playerSpend);
      }
      const droppedItems: DroppedItemSnapshot[] = [];
      const refundPlayerIds: string[] = [];
      for (const [paidByPlayerId, playerSpend] of hostileDamageBegan ? [] : spendByPlayer) {
        const refundLines = playerSpend.flatMap((line) => {
          const investedQuantity = Number(line.invested_quantity);
          const refundQuantity = Math.floor(investedQuantity / 3);
          return refundQuantity > 0
            ? [{ ...line, investedQuantity, refundQuantity }]
            : [];
        });
        if (refundLines.length === 0) continue;
        refundPlayerIds.push(paidByPlayerId);
        const grant = await this.inventory.grantItemsForOperationInTransaction(
          client,
          {
            operationKey: `${operationKey}:refund:${paidByPlayerId}`,
            playerId: paidByPlayerId,
            source: "flag_destroyed_refund",
            sourceEntityType: "flag",
            sourceEntityId: flagId,
            metadata: { destroyedByPlayerId: effectiveActorId },
            allowPartial: true,
            grants: refundLines.map((line) => ({
              itemId: line.item_id,
              variant: line.variant,
              quantity: line.refundQuantity
            }))
          }
        );
        const dropLines: SystemGroundDropLine[] = [];
        for (const line of refundLines) {
          const grantedQuantity = grant.grants.find(
            (candidate) =>
              candidate.itemId === line.item_id &&
              (candidate.variant ?? "default") === line.variant
          )?.grantedQuantity ?? 0;
          const droppedQuantity = line.refundQuantity - grantedQuantity;
          await client.query(
            `INSERT INTO flag_destruction_refunds (
               operation_key,paid_by_player_id,item_id,variant,
               invested_quantity,refund_quantity,inventory_quantity,dropped_quantity
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              operationKey,
              paidByPlayerId,
              line.item_id,
              line.variant,
              line.investedQuantity,
              line.refundQuantity,
              grantedQuantity,
              droppedQuantity
            ]
          );
          if (droppedQuantity > 0) {
            dropLines.push({
              itemId: line.item_id,
              variant: line.variant,
              quantity: droppedQuantity
            });
          }
        }
        if (dropLines.length > 0) {
          droppedItems.push(...await createSystemGroundDropsInTransaction(client, {
            operationKey: `${operationKey}:ground-refund:${paidByPlayerId}`,
            droppedByPlayerId: paidByPlayerId,
            regionCode: hintedControl.region_code,
            position: {
              lat: Number(hintedControl.lat),
              lon: Number(hintedControl.lon)
            },
            reason: "flag_destroyed",
            lines: dropLines
          }));
        }
      }
      let affectedFlagIds: string[] = [];
      let notificationPlayerIds: string[] = [];
      if (cityId) {
        await client.query("SET CONSTRAINTS flags_mixed_control_geometry DEFERRED");
        const pruned = await clearAndPruneCityFlags(
          client,
          cityId,
          [flagId],
          actorId,
          "flag_deleted",
          "flag_deleted"
        );
        affectedFlagIds = pruned.affectedFlagIds.filter((id) => id !== flagId);
        const members = await client.query<{ player_id: string }>(
          `SELECT player_id
           FROM city_memberships
           WHERE city_id = $1 AND left_at IS NULL`,
          [cityId]
        );
        notificationPlayerIds = [
          ...pruned.ownerPlayerIds,
          ...members.rows.map(({ player_id }) => player_id)
        ];
      }
      if (kingdomId) {
        // The target is deleted in this transaction, so defer the mixed-control
        // constraint across the temporary personal-control restoration step.
        await client.query("SET CONSTRAINTS flags_mixed_control_geometry DEFERRED");
        const pruned = await clearAndPruneKingdomFlags(
          client, kingdomId, [flagId], actorId, "flag_deleted", null, "flag_deleted"
        );
        affectedFlagIds = pruned.affectedFlagIds.filter((id) => id !== flagId);
        const members = await client.query<{ player_id: string }>(
          `SELECT player_id
           FROM kingdom_memberships
           WHERE kingdom_id = $1 AND status = 'active'`,
          [kingdomId]
        );
        notificationPlayerIds = [
          ...pruned.ownerPlayerIds,
          ...members.rows.map(({ player_id }) => player_id)
        ];
      }
      const result = await client.query(
        kingdomId
          ? "DELETE FROM flags WHERE id = $1"
          : cityId
            ? "DELETE FROM flags WHERE id = $1"
            : "DELETE FROM flags WHERE id = $1 AND city_id IS NULL AND kingdom_id IS NULL",
        [flagId]
      );
      if (result.rowCount !== 1) {
        throw new Error(kingdomId ? "flag does not exist" : "flag lifecycle changed during deletion");
      }
      const storedResult: StoredFlagDestructionResult = {
        affectedFlagIds,
        notificationPlayerIds,
        refundPlayerIds,
        droppedItems
      };
      await client.query(
        `UPDATE flag_destruction_operations
         SET result=$2::jsonb,completed_at=now()
         WHERE operation_key=$1 AND result IS NULL`,
        [operationKey, JSON.stringify(storedResult)]
      );
      const refundInventories = await Promise.all(
        refundPlayerIds.map(async (playerId) => ({
          playerId,
          inventory: await this.inventory.snapshotInTransaction(client, playerId)
        }))
      );
      await client.query("COMMIT");
      return {
        affectedFlagIds,
        notificationPlayerIds,
        refundInventories,
        droppedItems,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Burn completion uses the same authoritative flag-control lock and deletion
   * boundary as ordinary destruction, but deliberately has no construction
   * material refund. The caller owns the surrounding transaction.
   */
  async deleteFlagForBurnInTransaction(
    client: pg.PoolClient,
    flagId: string,
    burnerPlayerId: string | null
  ): Promise<BurnFlagDeletionResult> {
    return deleteFlagForBurnInTransaction(client, flagId, burnerPlayerId);
  }

  /**
   * Bomber completion uses the canonical flag-control lock and deletion
   * boundary, but intentionally does not require a burn session. A charge is
   * only accepted while the target has positive health; the caller owns the
   * surrounding transaction.
   */
  async deleteFlagForBomberInTransaction(
    client: pg.PoolClient,
    flagId: string,
    bomberPlayerId: string
  ): Promise<BurnFlagDeletionResult> {
    await lockFlagControlGeometry(client);
    const organizationStrike = await applyOrganizationBomberStrikeInTransaction(client, flagId, bomberPlayerId);
    if (organizationStrike?.kind === "invalid") {
      throw new FlagDestructionError("FLAG_BOMBER_TARGET_INVALID", organizationStrike.message);
    }
    if (organizationStrike) {
      return {
        flagId,
        affectedFlagIds: [flagId],
        notificationPlayerIds: organizationStrike.notificationPlayerIds
      };
    }
    const locked = await client.query<{
      id: string;
      control_type: "personal" | "city" | "city_seat" | "kingdom" | "kingdom_seat";
      owner_id: string;
      anchor_kind: PersonalAnchorKind;
      system_controlled: boolean;
      city_id: string | null;
      kingdom_id: string | null;
      burning_reason: string | null;
      reinforcement_level: number;
      tower_level: number | null;
      obelisk_level?: number | null;
      war_structure_kind?: string | null;
      health: number | null;
      maximum_health: number | null;
      developer_test_target: boolean;
      developer_test_creator_id: string | null;
      lat: number;
      lon: number;
    }>(
      `SELECT id::text,control_type,owner_id,anchor_kind,system_controlled,
              city_id,kingdom_id,burning_reason,reinforcement_level,tower_level,obelisk_level,war_structure_kind,health,maximum_health,
              lat,lon,developer_test_target,
              test.creator_player_id AS developer_test_creator_id
       FROM flags
       LEFT JOIN developer_spawned_test_flags test ON test.flag_id=flags.id
       WHERE flags.id=$1::uuid FOR UPDATE OF flags`,
      [flagId]
    );
    const flag = locked.rows[0];
    if (!flag) throw new FlagDestructionError("FLAG_NOT_FOUND", "Flag does not exist");
    const isDeveloperTestTarget = flag.developer_test_target === true;
    // A bomb can hit a structure whose burn is paused by an active repair;
    // repairing near enemies is dangerous (damage counts triple).
    const repairing = await hasActiveRepair(client, flagId);
    if (
      flag.control_type !== "personal" ||
      (flag.owner_id === bomberPlayerId && !isDeveloperTestTarget) ||
      (flag.anchor_kind !== "flag" && flag.anchor_kind !== "buoy") ||
      flag.system_controlled ||
      flag.city_id !== null ||
      flag.kingdom_id !== null ||
      (flag.burning_reason !== null && !(repairing && flag.burning_reason === "flag_burn"))
    ) {
      throw new FlagDestructionError(
        "FLAG_BOMBER_TARGET_INVALID",
        "Only another player's ordinary personal Flag can be demolished."
      );
    }
    const legendaryEvent = await client.query(
      `SELECT 1 FROM legendary_bird_events
       WHERE flag_id=$1::uuid AND status IN ('pending','active') LIMIT 1`,
      [flagId]
    );
    if (legendaryEvent.rowCount !== 0) {
      throw new FlagDestructionError(
        "FLAG_LEGENDARY_EVENT_ACTIVE",
        "This Flag cannot be demolished while its legendary encounter is available."
      );
    }
    const expectedHealth = structureWarfareHealthForReinforcementLevel(Number(flag.reinforcement_level), flag.tower_level);
    if (
      ![0, 1, 2, 3].includes(Number(flag.reinforcement_level)) ||
      expectedHealth === null ||
      flag.health === null ||
      flag.maximum_health === null ||
      Number(flag.maximum_health) !== expectedHealth ||
      Number(flag.health) <= 0
    ) {
      throw new FlagDestructionError(
        "FLAG_BOMBER_TARGET_INVALID",
        "This structure is not a damageable Flag target."
      );
    }
    const bombDamage = await monolithAdjustedBuildingDamage(
      client,
      STRUCTURE_WARFARE_BOMBER_DAMAGE * (repairing ? STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER : 1),
      { attacker: null, target: flag }
    );
    const damaged = await client.query<{ owner_id: string; health: number; damage_cycle_id: string | null }>(
      `UPDATE flags
       SET health=GREATEST(0,health-$2::integer),
           damage_cycle_id=COALESCE(damage_cycle_id,gen_random_uuid())
       WHERE id=$1::uuid AND control_type='personal'
         AND (owner_id<>$3 OR developer_test_target)
         AND anchor_kind IN ('flag','buoy') AND system_controlled=false
         AND city_id IS NULL AND kingdom_id IS NULL
         AND (burning_reason IS NULL OR $5::boolean)
         AND maximum_health=$4::integer AND health IS NOT NULL
         AND health > 0
       RETURNING owner_id,health,damage_cycle_id::text`,
      [
        flagId,
        bombDamage,
        bomberPlayerId,
        expectedHealth,
        repairing
      ]
    );
    const damagedRow = damaged.rows[0];
    if (!damagedRow) {
      throw new FlagDestructionError(
        "FLAG_BOMBER_TARGET_INVALID",
        "The Flag changed before it could be damaged."
      );
    }
    if (!repairing) {
      await ensureDamageTriggeredBurnInTransaction(client, {
        attackerPlayerId: bomberPlayerId,
        structureId: flagId,
        damageCycleId: damagedRow.damage_cycle_id
      });
    }
    if (Number(damagedRow.health) > 0) {
      return {
        flagId,
        affectedFlagIds: [flagId],
        notificationPlayerIds: [damagedRow.owner_id]
      };
    }

    // Match the canonical flag-destruction lifecycle: no repair, disrupt, or
    // burn channel may survive the terminal row deletion.
    await client.query(
      `UPDATE flag_repair_disrupt_operations
       SET status='cancelled',cancel_reason='flag-destroyed',completed_at=now()
       WHERE flag_id=$1 AND status='active'`,
      [flagId]
    );
    await client.query(
      `UPDATE flag_repair_operations
       SET status='cancelled',cancel_reason='flag-destroyed',completed_at=now()
       WHERE flag_id=$1 AND status='active'`,
      [flagId]
    );
    await client.query(
      `UPDATE flag_burn_operations
       SET status='cancelled',cancel_reason='flag-destroyed',completed_at=now(),paused_at=NULL
       WHERE flag_id=$1 AND status='active'`,
      [flagId]
    );
    await client.query(
      `UPDATE flags SET burning_started_at=NULL,burning_until=NULL,burning_reason=NULL
       WHERE id=$1::uuid`,
      [flagId]
    );
    const deleted = await client.query(
      `DELETE FROM flags
       WHERE id=$1::uuid AND control_type='personal'
         AND (owner_id<>$2 OR developer_test_target)
         AND anchor_kind IN ('flag','buoy') AND system_controlled=false
         AND city_id IS NULL AND kingdom_id IS NULL AND burning_reason IS NULL
         AND health=0 AND maximum_health=$3::integer`,
      [flagId, bomberPlayerId, expectedHealth]
    );
    if (deleted.rowCount !== 1) {
      throw new FlagDestructionError(
        "FLAG_BOMBER_TARGET_INVALID",
        "The Flag changed before it could be demolished."
      );
    }
    return { flagId, affectedFlagIds: [], notificationPlayerIds: [damagedRow.owner_id] };
  }

  async attackFlag(
    playerId: string,
    flagId: string,
    requestId: string,
    player: Pick<PlayerRecord, "position" | "target" | "online">,
    strike?: Readonly<{ origin: Readonly<{ lat: number; lon: number }>; radiusM: number; damage?: number }>
  ): Promise<FlagAttackResult> {
    const warfare = this.warfare ?? new StructureWarfareService(
      new PersonalFlagWarfareAdapter(
        this as unknown as Pick<FlagService, "databasePool" | "getMapFlag" | "deleteFlagForBurnInTransaction">,
        this.inventory ?? new InventoryService(this.pool)
      )
    );
    try {
      const result = await warfare.attack({
        kind: PERSONAL_FLAG_WARFARE_KIND,
        playerId,
        structureId: flagId,
        requestId,
        player,
        ...(strike ? { strike } : {})
      });
      return {
        flag: result.structure as FlagSnapshot,
        damage: result.damage,
        replayed: result.replayed
      };
    } catch (error) {
      if (error instanceof StructureWarfareError && error.phase === "attack") {
        throw new FlagAttackError(error.code, error.message);
      }
      throw error;
    }
  }

  /** Structures (flags table: flags, towers, city/kingdom/war structures) within reach of a point. */
  async listStructureIdsNear(origin: Readonly<{ lat: number; lon: number }>, radiusM: number): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id::text FROM flags
       WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $3)
       ORDER BY ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography), id
       LIMIT 50`,
      [origin.lon, origin.lat, radiusM]
    );
    return result.rows.map((row) => row.id);
  }

  async renameFlag(
    flagId: string,
    name: string,
    actorId: string | null = null,
    _bypassAuthority = false
  ): Promise<FlagSnapshot> {
    void _bypassAuthority;
    if (!actorId) {
      throw new KingdomError(
        "KINGDOM_PLAYER_REQUIRED",
        "An authenticated player is required",
        401
      );
    }
    const normalizedName = sanitizeAtlasShrineRename(name);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        control_type: "personal" | "city" | "city_seat" | "kingdom" | "kingdom_seat";
        owner_id: string;
        city_id: string | null;
        kingdom_id: string | null;
        reinforcement_level: number;
        atlas_shrine_slot_number: number | null;
      }>(
        `SELECT control_type,owner_id,city_id,kingdom_id,reinforcement_level,
                atlas_shrine_slot_number
         FROM flags WHERE id=$1 FOR UPDATE`,
        [flagId]
      );
      const control = locked.rows[0];
      if (!control) throw new Error("flag does not exist");
      if (
        control.control_type !== "personal" ||
        control.city_id !== null ||
        control.kingdom_id !== null ||
        control.reinforcement_level !== 2
      ) {
        throw new KingdomError(
          "KINGDOM_PERMISSION_DENIED",
          "Only an active personal Atlas Shrine can be renamed",
          403
        );
      }
      if (control.owner_id !== actorId) {
        throw new KingdomError(
          "KINGDOM_PERMISSION_DENIED",
          "You cannot rename another player's Atlas Shrine",
          403
        );
      }
      if (control.atlas_shrine_slot_number === null) {
        throw new AtlasShrineError(
          "ATLAS_SHRINE_SLOT_REQUIRED",
          "Atlas Shrine slot identity is unavailable"
        );
      }
      const storedName = normalizedName ||
        `Atlas Shrine ${control.atlas_shrine_slot_number}`;
      await client.query("UPDATE flags SET name = $2 WHERE id = $1", [flagId, storedName]);
      await client.query("COMMIT");
      const renamed = await this.getFlag(flagId);
      if (!renamed) throw new Error("flag does not exist");
      return renamed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveTerritoryAtPoint(
    lat: number,
    lon: number,
    queryable: Pick<pg.Pool | pg.PoolClient, "query"> = this.pool,
    lockCoveringCandidates = false
  ): Promise<TerritoryResolution> {
    return resolveTerritoryAtPoint({
      lat,
      lon,
      flags: await this.listTerritoryCandidates(lat, lon, queryable, lockCoveringCandidates)
    });
  }

  async findOpenLandCandidates(
    playerId: string,
    candidates: readonly Readonly<{ lat: number; lon: number }>[]
  ): Promise<Array<{ lat: number; lon: number; packageId: string }>> {
    const unclaimed = (
      await Promise.all(candidates.map(async (candidate) => {
        try {
          await this.assertFlagPlacementAllowedAt(playerId, candidate.lat, candidate.lon);
          return candidate;
        } catch (error) {
          if (error instanceof FlagPlacementError) return null;
          throw error;
        }
      }))
    ).filter((candidate): candidate is Readonly<{ lat: number; lon: number }> =>
      candidate !== null
    );
    if (unclaimed.length === 0) return [];
    const environments = await this.worldLookup.lookupGameplayEnvironments(
      unclaimed,
      { caller: "flag" }
    );
    return unclaimed.flatMap((candidate, index) => {
      const world = environments[index];
      if (!world?.ok || !world.packageId) return [];
      try {
        this.assertWorldLookupPlaceable(world);
        return [{ ...candidate, packageId: world.packageId }];
      } catch (error) {
        if (error instanceof FlagPlacementError) return [];
        throw error;
      }
    });
  }

  /** Small read-only adapter for Dog Find Open Area; existing territory radii remain authoritative. */
  async nearestClaimedFrontier(origin: Readonly<{ lat: number; lon: number }>): Promise<{
    flagId: string;
    center: { lat: number; lon: number };
    radiusM: number;
    edgeDistanceM: number;
  } | null> {
    const result = await this.pool.query<{
      id: string;
      lat: number;
      lon: number;
      radius_m: number;
      edge_distance_m: number;
    }>(
      `WITH origin AS (
         SELECT ST_SetSRID(ST_MakePoint($1,$2),4326)::geography AS geog
       ), claims AS (
         SELECT f.id,
                CASE WHEN f.control_type='kingdom_seat' THEN COALESCE(seat.lat,f.lat) ELSE f.lat END AS lat,
                CASE WHEN f.control_type='kingdom_seat' THEN COALESCE(seat.lon,f.lon) ELSE f.lon END AS lon,
                CASE WHEN f.control_type='kingdom_seat'
                  THEN COALESCE(seat.territory_radius_m,f.claim_radius_m) ELSE f.claim_radius_m END AS radius_m
         FROM flags f
         LEFT JOIN kingdom_seats seat ON seat.source_flag_id=f.id AND seat.status='active'
       )
       SELECT claims.id,claims.lat,claims.lon,claims.radius_m,
              GREATEST(0,ST_Distance(origin.geog,
                ST_SetSRID(ST_MakePoint(claims.lon,claims.lat),4326)::geography)-claims.radius_m) AS edge_distance_m
       FROM claims CROSS JOIN origin
       WHERE claims.radius_m>0
       ORDER BY edge_distance_m,claims.id
       LIMIT 1`,
      [origin.lon, origin.lat]
    );
    const row = result.rows[0];
    return row ? {
      flagId: row.id,
      center: { lat: Number(row.lat), lon: Number(row.lon) },
      radiusM: Number(row.radius_m),
      edgeDistanceM: Number(row.edge_distance_m)
    } : null;
  }

  async createForPlayer(player: PlayerRecord, requestedName?: string): Promise<CreateFlagResult> {
    const { quote } = await this.createPlacementQuote(player, { anchorKind: "flag" });
    return this.commitPreparedPlacement(
      await this.prepareForPlayer(player, requestedName, quote.quoteId, "flag"),
      false
    );
  }

  async atlasShrineProgression(
    playerId: string,
    queryable: Pick<pg.Pool | pg.PoolClient, "query"> = this.pool
  ): Promise<AtlasShrineProgressionSnapshot> {
    await queryable.query(
      `INSERT INTO player_atlas_shrine_progression (player_id)
       VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
      [playerId]
    );
    await queryable.query(
      `INSERT INTO player_progression_profiles (player_id)
       VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
      [playerId]
    );
    const result = await queryable.query<{
      unlocked_slots: number;
      player_level: number;
      current_shards: string;
      built_shrines: string;
    }>(
      `SELECT shrine.unlocked_slots,
              progression.level AS player_level,
              COALESCE(inventory.quantity, 0)::text AS current_shards,
              (
                SELECT count(*)::text
                FROM flags
                WHERE owner_id = $1
                  AND control_type = 'personal'
                  AND city_id IS NULL
                  AND kingdom_id IS NULL
                  AND reinforcement_level = 2
              ) AS built_shrines
       FROM player_atlas_shrine_progression shrine
       JOIN player_progression_profiles progression
         ON progression.player_id = shrine.player_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(quantity), 0) AS quantity
         FROM player_inventory
         WHERE player_id = shrine.player_id
           AND resource_type = 'atlas_shrine_shard'
           AND variant = 'default'
       ) inventory ON true
       WHERE shrine.player_id = $1`,
      [playerId]
    );
    const row = result.rows[0];
    if (!row) throw new AtlasShrineError("ATLAS_SHRINE_PROGRESS_UNAVAILABLE", "Atlas Shrine progression is unavailable");
    const unlockedSlots = Number(row.unlocked_slots);
    const builtShrines = Number(row.built_shrines);
    const playerLevel = Number(row.player_level);
    const currentShards = Number(row.current_shards);
    const nextSlot = unlockedSlots >= MAX_ATLAS_SHRINE_SLOTS
      ? null
      : unlockedSlots + 1;
    return {
      unlockedSlots,
      builtShrines,
      availableCapacity: Math.max(0, unlockedSlots - builtShrines),
      nextSlot,
      requiredLevel: nextSlot,
      playerLevel,
      requiredShards: nextSlot,
      currentShards,
      levelRequirementMet: nextSlot === null || playerLevel >= nextSlot,
      shardRequirementMet: nextSlot === null || currentShards >= nextSlot
    };
  }

  async unlockAtlasShrineSlot(
    playerId: string,
    requestId: string
  ): Promise<AtlasShrineUnlockResult> {
    const operationKey = `atlas-shrine-unlock:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO player_atlas_shrine_progression (player_id)
         VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
        [playerId]
      );
      const locked = await client.query<{ unlocked_slots: number }>(
        `SELECT unlocked_slots
         FROM player_atlas_shrine_progression
         WHERE player_id = $1
         FOR UPDATE`,
        [playerId]
      );
      const unlockedSlots = Number(locked.rows[0]?.unlocked_slots ?? 0);
      const replay = await client.query<{ player_id: string; slot_number: number }>(
        `SELECT player_id, slot_number
         FROM atlas_shrine_unlock_operations
         WHERE operation_key = $1`,
        [operationKey]
      );
      if (replay.rows[0]) {
        if (replay.rows[0].player_id !== playerId) {
          throw new AtlasShrineError("ATLAS_SHRINE_REQUEST_CONFLICT", "This unlock request was already used");
        }
        const progression = await this.atlasShrineProgression(playerId, client);
        const inventory = await this.inventory.snapshotInTransaction(client, playerId);
        await client.query("COMMIT");
        return { progression, inventory, replayed: true };
      }
      if (unlockedSlots >= MAX_ATLAS_SHRINE_SLOTS) {
        throw new AtlasShrineError("ATLAS_SHRINE_SLOTS_MAXED", `All ${MAX_ATLAS_SHRINE_SLOTS} Atlas Shrine slots are already unlocked`);
      }
      await client.query(
        `INSERT INTO player_progression_profiles (player_id)
         VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
        [playerId]
      );
      const levelResult = await client.query<{ level: number }>(
        `SELECT level FROM player_progression_profiles
         WHERE player_id = $1 FOR SHARE`,
        [playerId]
      );
      const nextSlot = unlockedSlots + 1;
      if (Number(levelResult.rows[0]?.level ?? 0) < nextSlot) {
        throw new AtlasShrineError(
          "ATLAS_SHRINE_LEVEL_REQUIRED",
          `Player level ${nextSlot} is required to unlock Atlas Shrine slot ${nextSlot}`
        );
      }
      const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey,
        playerId,
        source: "atlas_shrine_slot_unlock",
        sourceEntityType: "player_atlas_shrine_progression",
        sourceEntityId: playerId,
        metadata: { slotNumber: nextSlot },
        debits: [{ itemId: "atlas_shrine_shard", variant: null, quantity: nextSlot }]
      });
      const updated = await client.query(
        `UPDATE player_atlas_shrine_progression
         SET unlocked_slots = unlocked_slots + 1, updated_at = now()
         WHERE player_id = $1 AND unlocked_slots = $2`,
        [playerId, unlockedSlots]
      );
      if (updated.rowCount !== 1) {
        throw new AtlasShrineError("ATLAS_SHRINE_CONCURRENT_UNLOCK", "Atlas Shrine progression changed concurrently");
      }
      await client.query(
        `INSERT INTO atlas_shrine_unlock_operations (
           operation_key, player_id, slot_number, shard_cost
         ) VALUES ($1, $2, $3, $3)`,
        [operationKey, playerId, nextSlot]
      );
      const progression = await this.atlasShrineProgression(playerId, client);
      await client.query("COMMIT");
      return { progression, inventory: debit.inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        error instanceof Error &&
        error.message === "Inventory does not contain enough items"
      ) {
        throw new AtlasShrineError(
          "ATLAS_SHRINE_SHARDS_REQUIRED",
          "Not enough Atlas Shrine Shards for the next slot"
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async upgradeFlagTier(
    playerId: string,
    flagId: string,
    targetTier: Exclude<FlagUpgradeTier, "base">,
    requestId: string
  ): Promise<FlagUpgradeResult> {
    const operationKey = `flag-tier:${playerId}:${requestId}`;
    const targetLevel = targetTier === "stone" ? 1 : targetTier === "atlas_shrine" ? 2 : 3;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const hint = await client.query<{
        control_type: NonNullable<FlagRow["control_type"]>;
        anchor_kind: PersonalAnchorKind;
        owner_id: string;
        city_id: string | null;
        kingdom_id: string | null;
      }>(
        `SELECT control_type, anchor_kind, owner_id, city_id, kingdom_id
         FROM flags WHERE id = $1`,
        [flagId]
      );
      const hinted = hint.rows[0];
      if (!hinted) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag does not exist");
      if (hinted.anchor_kind === "buoy") {
        throw new AtlasShrineError(
          "FLAG_TIER_UNSUPPORTED",
          "Buoys cannot be reinforced or converted"
        );
      }
      const hintedCityId = isCityControlledFlag(hinted) ? hinted.city_id : null;
      const hintedKingdomId = isKingdomControlledFlag(hinted) ? hinted.kingdom_id : null;
      if (hinted.control_type === "city_seat" || hinted.control_type === "kingdom_seat") {
        throw new AtlasShrineError("FLAG_TIER_UNSUPPORTED", "Seat flags cannot be upgraded through flag management");
      }
      if (hintedCityId) {
        await assertCityFlagAction(client, playerId, hintedCityId);
      } else if (hintedKingdomId) {
        await assertKingdomFlagAction(client, playerId, hintedKingdomId, "manage");
      }
      const locked = await client.query<{
        control_type: NonNullable<FlagRow["control_type"]>;
        anchor_kind: PersonalAnchorKind;
        owner_id: string;
        city_id: string | null;
        kingdom_id: string | null;
        reinforcement_level: number;
        reinforced_operation_key: string | null;
        burning_until: Date | string | null;
        legendary_event_active: boolean;
      }>(
        `SELECT control_type, anchor_kind, owner_id, city_id, kingdom_id,
                reinforcement_level, reinforced_operation_key, burning_until,
                EXISTS (
                  SELECT 1 FROM legendary_bird_events event
                  WHERE event.flag_id=flags.id AND event.status IN ('pending','active')
                ) AS legendary_event_active
         FROM flags WHERE id = $1 FOR UPDATE`,
        [flagId]
      );
      const row = locked.rows[0];
      if (!row) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag does not exist");
      const cityId = isCityControlledFlag(row) ? row.city_id : null;
      const kingdomId = isKingdomControlledFlag(row) ? row.kingdom_id : null;
      if (cityId !== hintedCityId || kingdomId !== hintedKingdomId) {
        throw new AtlasShrineError("FLAG_CONTROL_CHANGED", "Flag control changed during the upgrade");
      }
      if (!cityId && !kingdomId && !isPersonalFlagControlledByPlayer(row, playerId)) {
        throw new AtlasShrineError("FLAG_UPGRADE_FORBIDDEN", "Only the personal flag owner can upgrade this flag");
      }
      const currentLevel = Number(row.reinforcement_level);
      if (currentLevel === targetLevel && row.reinforced_operation_key === operationKey) {
        const inventory = await this.inventory.snapshotInTransaction(client, playerId);
        const progression = await this.atlasShrineProgression(playerId, client);
        const masteryGrant = this.masteries
          ? await this.masteries.grantProfessionXpInTransaction(client, {
              operationKey: `profession-xp:${operationKey}:builder`,
              playerId,
              sourceId: flagId,
              activity: { kind: "flag-reinforcement" }
            })
          : undefined;
        await client.query("COMMIT");
        const flag = await this.getMapFlag(flagId);
        if (!flag) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag no longer exists");
        return {
          flag,
          inventory,
          progression,
          replayed: true,
          ...(masteryGrant ? { masteryGrant } : {})
        };
      }
      if (targetTier === "stone" && currentLevel !== 0) {
        throw new AtlasShrineError("FLAG_ALREADY_UPGRADED", "Only a base flag can be upgraded to stone");
      }
      if (targetTier === "tower") {
        if (currentLevel !== 1) {
          throw new AtlasShrineError("FLAG_TOWER_STONE_REQUIRED", "Only a stone flag can be upgraded to a Tower");
        }
        if (row.control_type !== "personal" || cityId || kingdomId) {
          throw new AtlasShrineError("FLAG_TOWER_PERSONAL_ONLY", "Only a personal stone flag can be upgraded to a Tower");
        }
      }
      let atlasShrineSlotNumber: number | null = null;
      if (targetTier === "atlas_shrine") {
        if (currentLevel !== 1) {
          throw new AtlasShrineError("ATLAS_SHRINE_STONE_REQUIRED", "Only a stone flag can become an Atlas Shrine");
        }
        if (row.control_type !== "personal" || cityId || kingdomId) {
          throw new AtlasShrineError(
            "ATLAS_SHRINE_PERSONAL_ONLY",
            "Only a personal stone flag can become an Atlas Shrine"
          );
        }
        if (
          row.legendary_event_active ||
          (row.burning_until !== null && new Date(row.burning_until).getTime() > Date.now())
        ) {
          throw new AtlasShrineError(
            "ATLAS_SHRINE_FLAG_BURNING",
            "Repair or finish the active Stone Flag encounter before constructing an Atlas Shrine"
          );
        }
        await client.query(
          `INSERT INTO player_atlas_shrine_progression (player_id)
           VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
          [playerId]
        );
        const capacity = await client.query<{ unlocked_slots: number }>(
          `SELECT unlocked_slots
           FROM player_atlas_shrine_progression
           WHERE player_id = $1 FOR UPDATE`,
          [playerId]
        );
        const available = await client.query<{ slot_number: number }>(
          `SELECT slot_number
           FROM generate_series(1, $2::integer) AS slot(slot_number)
           WHERE NOT EXISTS (
             SELECT 1
             FROM flags occupied
             WHERE occupied.owner_id = $1
               AND occupied.control_type = 'personal'
               AND occupied.city_id IS NULL
               AND occupied.kingdom_id IS NULL
               AND occupied.reinforcement_level = 2
               AND occupied.atlas_shrine_slot_number = slot.slot_number
           )
           ORDER BY slot_number
           LIMIT 1`,
          [playerId, Number(capacity.rows[0]?.unlocked_slots ?? 0)]
        );
        atlasShrineSlotNumber = available.rows[0]?.slot_number ?? null;
        if (atlasShrineSlotNumber === null) {
          throw new AtlasShrineError(
            "ATLAS_SHRINE_CAPACITY_REQUIRED",
            "Unlock an unused Atlas Shrine slot before constructing this shrine"
          );
        }
      }
      const stoneCost = targetTier === "stone"
        ? FLAG_STONE_UPGRADE_COST
        : targetTier === "tower"
          ? FLAG_TOWER_UPGRADE_COST
          : ATLAS_SHRINE_STONE_COST;
      const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey,
        playerId,
        source: targetTier === "stone"
          ? "flag_stone_upgrade"
          : targetTier === "tower"
            ? "flag_tower_upgrade"
            : "atlas_shrine_construction",
        sourceEntityType: "flag",
        sourceEntityId: flagId,
        metadata: {
          targetTier,
          ...(atlasShrineSlotNumber === null ? {} : { atlasShrineSlotNumber })
        },
        debits: targetTier === "atlas_shrine"
          ? [
              { itemId: "wood", variant: null, quantity: ATLAS_SHRINE_WOOD_COST },
              { itemId: "stone", variant: null, quantity: stoneCost }
            ]
          : [{ itemId: "stone", variant: null, quantity: stoneCost }]
      });
      await recordFlagMaterialSpend(
        client,
        flagId,
        operationKey,
        targetTier
      );
      const updated = await client.query(
        `UPDATE flags
         SET reinforcement_level = $2::smallint,
             reinforced_operation_key = $3,
             reinforced_at = clock_timestamp(),
             atlas_shrine_slot_number = CASE
               WHEN $2::smallint = 2 THEN $5::smallint
               ELSE atlas_shrine_slot_number
             END,
             name = CASE
               WHEN $2::smallint = 2 THEN 'Atlas Shrine ' || $5::text
               ELSE name
             END,
             health = CASE
               WHEN $2::smallint = 1 THEN $6::smallint
               WHEN $2::smallint = 2 THEN $8::integer
               WHEN $2::smallint = 3 THEN LEAST(
                 $7::smallint,
                 GREATEST(
                   0,
                   ROUND(
                     COALESCE(health, maximum_health, $6::smallint)::numeric * $7::numeric /
                       NULLIF(COALESCE(maximum_health, $6::smallint), 0)
                   )::integer
                 )
               )::smallint
               ELSE NULL
             END,
             maximum_health = CASE
               WHEN $2::smallint = 1 THEN $6::smallint
               WHEN $2::smallint = 2 THEN $8::integer
               WHEN $2::smallint = 3 THEN $7::smallint
               ELSE NULL
             END,
             burning_started_at = CASE WHEN $2::smallint = 2 THEN NULL ELSE burning_started_at END,
             burning_until = CASE WHEN $2::smallint = 2 THEN NULL ELSE burning_until END,
             burning_reason = CASE WHEN $2::smallint = 2 THEN NULL ELSE burning_reason END
         WHERE id = $1 AND reinforcement_level = $4`,
        [
          flagId,
          targetLevel,
          operationKey,
          currentLevel,
          atlasShrineSlotNumber,
          STRUCTURE_WARFARE_HARDENED_HEALTH,
          STRUCTURE_WARFARE_TOWER_HEALTH,
          STRUCTURE_WARFARE_ATLAS_SHRINE_HEALTH
        ]
      );
      if (updated.rowCount !== 1) {
        throw new AtlasShrineError("FLAG_UPGRADE_CONFLICT", "Flag tier changed concurrently");
      }
      const masteryGrant = this.masteries
        ? await this.masteries.grantProfessionXpInTransaction(client, {
            operationKey: `profession-xp:${operationKey}:builder`,
            playerId,
            sourceId: flagId,
            activity: { kind: "flag-reinforcement" }
          })
        : undefined;
      const progression = await this.atlasShrineProgression(playerId, client);
      await client.query("COMMIT");
      const flag = await this.getMapFlag(flagId);
      if (!flag) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag no longer exists");
      return {
        flag,
        inventory: debit.inventory,
        progression,
        replayed: false,
        ...(masteryGrant ? { masteryGrant } : {})
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        error instanceof Error &&
        error.message === "Inventory does not contain enough items"
      ) {
        throw new AtlasShrineError(
          "ATLAS_SHRINE_STONE_REQUIRED",
          targetTier === "stone"
            ? "Five stone are required for this upgrade"
            : targetTier === "tower"
              ? "Twenty-five stone are required to upgrade to a Tower"
              : "Ten stone are required to construct an Atlas Shrine"
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Builds the next personal Guard Tower level (2..25). Dupe-safe: the
   * request's operation key replays its recorded result, and the level check
   * under the flag row lock refuses a second request for a built level, so the
   * Iron Ore and stone are debited once per level.
   */
  async upgradeGuardTowerLevel(
    playerId: string,
    flagId: string,
    targetLevel: number,
    requestId: string
  ): Promise<FlagUpgradeResult> {
    const cost = personalGuardTowerUpgradeCost(targetLevel);
    if (!cost) {
      throw new AtlasShrineError("FLAG_TOWER_LEVEL_INVALID", "Choose the next Guard Tower level");
    }
    const operationKey = `flag-tower-level:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock order: player row, then the flag row.
      await client.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [playerId]);
      const prior = await towerUpgradeReplay(client, operationKey, flagId, "guard_tower_level", targetLevel);
      if (prior) {
        const inventory = await this.inventory.snapshotInTransaction(client, playerId);
        const progression = await this.atlasShrineProgression(playerId, client);
        await client.query("COMMIT");
        const flag = await this.getMapFlag(flagId);
        if (!flag) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag no longer exists");
        return { flag, inventory, progression, replayed: true };
      }
      const row = await lockTowerUpgradeTarget(client, flagId);
      if (!isPersonalFlagControlledByPlayer(row, playerId) || row.city_id !== null || row.kingdom_id !== null) {
        throw new AtlasShrineError("FLAG_UPGRADE_FORBIDDEN", "Only the Tower owner can build its next level");
      }
      if (Number(row.reinforcement_level) !== 3 || row.tower_level === null) {
        throw new AtlasShrineError("FLAG_TOWER_REQUIRED", "Only a Tower can gain Guard Tower levels");
      }
      if (Number(row.tower_level) !== targetLevel - 1) {
        throw new AtlasShrineError(
          "FLAG_TOWER_LEVEL_CHANGED",
          Number(row.tower_level) >= targetLevel
            ? `This Tower is already level ${Number(row.tower_level)}`
            : `Build level ${Number(row.tower_level) + 1} first`
        );
      }
      await assertTowerUpgradeIdle(client, row, flagId);
      const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey,
        playerId,
        source: "flag_tower_level_upgrade",
        sourceEntityType: "flag",
        sourceEntityId: flagId,
        metadata: { targetLevel },
        debits: [
          { itemId: PERSONAL_GUARD_TOWER_IRON_ITEM_ID, variant: null, quantity: cost.iron },
          { itemId: "stone", variant: null, quantity: cost.stone }
        ]
      });
      const nextMaximum = personalGuardTowerHealth(targetLevel);
      const updated = await client.query(
        `UPDATE flags
         SET tower_level = $2::smallint,
             health = LEAST($4::integer, health + ($4::integer - maximum_health))
         WHERE id = $1 AND reinforcement_level = 3 AND tower_level = $3::smallint`,
        [flagId, targetLevel, targetLevel - 1, nextMaximum]
      );
      if (updated.rowCount !== 1) {
        throw new AtlasShrineError("FLAG_UPGRADE_CONFLICT", "The Tower changed during the upgrade");
      }
      await client.query(
        `INSERT INTO flag_tower_upgrade_operations (
           operation_key,flag_id,player_id,upgrade_kind,from_level,to_level,
           iron_quantity,stone_quantity,city_coin_quantity
         ) VALUES ($1,$2,$3,'guard_tower_level',$4,$5,$6,$7,0)`,
        [operationKey, flagId, playerId, targetLevel - 1, targetLevel, cost.iron, cost.stone]
      );
      const masteryGrant = this.masteries
        ? await this.masteries.grantProfessionXpInTransaction(client, {
            operationKey: `profession-xp:${operationKey}:builder`,
            playerId,
            sourceId: flagId,
            activity: { kind: "flag-reinforcement" }
          })
        : undefined;
      const progression = await this.atlasShrineProgression(playerId, client);
      await client.query("COMMIT");
      const flag = await this.getMapFlag(flagId);
      if (!flag) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag no longer exists");
      return {
        flag,
        inventory: debit.inventory,
        progression,
        replayed: false,
        ...(masteryGrant ? { masteryGrant } : {})
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && error.message === "Inventory does not contain enough items") {
        throw new AtlasShrineError(
          "FLAG_TOWER_LEVEL_MATERIALS_REQUIRED",
          `Level ${targetLevel} needs ${cost.iron} Iron Ore and ${cost.stone} stone`
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Mayor-only preflight for the City Tower channel (the completion re-checks everything). */
  async assertCityTowerUpgradeAllowed(playerId: string, flagId: string): Promise<void> {
    const result = await this.pool.query<{ city_id: string | null; control_type: string; tower_level: number | null }>(
      "SELECT city_id::text,control_type,tower_level FROM flags WHERE id=$1",
      [flagId]
    );
    const row = result.rows[0];
    if (!row || row.control_type !== "city" || row.city_id === null) {
      throw new AtlasShrineError("FLAG_CITY_TOWER_CITY_FLAG_REQUIRED", "Only a City Flag can become a City Tower");
    }
    if (row.tower_level !== null) {
      throw new AtlasShrineError("FLAG_ALREADY_UPGRADED", "This City Flag is already a City Tower");
    }
    await assertCityFlagAction(this.pool, playerId, row.city_id);
    await assertCityTowerSlotAvailable(this.pool, row.city_id);
  }

  /**
   * The Mayor upgrades a City Flag to a City Tower: City Coins from the city
   * treasury plus the Mayor's stone. Lock order: city-structure advisory,
   * player row, flag row. The treasury spend and the stone debit share the
   * request's operation keys, and the tower_level check refuses a second
   * upgrade, so nothing is charged twice.
   */
  async upgradeCityTower(playerId: string, flagId: string, requestId: string): Promise<FlagUpgradeResult> {
    const operationKey = `flag-city-tower:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const hint = await client.query<{ city_id: string | null }>(
        "SELECT city_id::text FROM flags WHERE id=$1",
        [flagId]
      );
      const hintedCityId = hint.rows[0]?.city_id ?? null;
      if (!hintedCityId) {
        throw new AtlasShrineError("FLAG_CITY_TOWER_CITY_FLAG_REQUIRED", "Only a City Flag can become a City Tower");
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`city-structure:${hintedCityId}`]);
      await client.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [playerId]);
      const prior = await towerUpgradeReplay(client, operationKey, flagId, "city_tower", 1);
      if (prior) {
        const inventory = await this.inventory.snapshotInTransaction(client, playerId);
        const progression = await this.atlasShrineProgression(playerId, client);
        await client.query("COMMIT");
        const flag = await this.getMapFlag(flagId);
        if (!flag) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag no longer exists");
        return { flag, inventory, progression, replayed: true };
      }
      const row = await lockTowerUpgradeTarget(client, flagId);
      if (row.control_type !== "city" || row.city_id !== hintedCityId || row.kingdom_id !== null) {
        throw new AtlasShrineError("FLAG_CITY_TOWER_CITY_FLAG_REQUIRED", "Only a City Flag can become a City Tower");
      }
      await assertCityFlagAction(client, playerId, hintedCityId);
      if (row.tower_level !== null) {
        throw new AtlasShrineError("FLAG_ALREADY_UPGRADED", "This City Flag is already a City Tower");
      }
      // Under the city-structure advisory lock: concurrent upgrades cannot share the last slot.
      await assertCityTowerSlotAvailable(client, hintedCityId);
      await assertTowerUpgradeIdle(client, row, flagId);
      const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey,
        playerId,
        source: "city_tower_upgrade",
        sourceEntityType: "flag",
        sourceEntityId: flagId,
        metadata: { cityId: hintedCityId },
        debits: [{ itemId: "stone", variant: null, quantity: CITY_TOWER_UPGRADE_COST.stone }]
      });
      await new CityTreasuryService(this.pool).spendInTransaction(client, {
        operationKey,
        cityId: hintedCityId,
        actorPlayerId: playerId,
        amount: CITY_TOWER_UPGRADE_COST.cityCoins,
        sourceId: flagId,
        metadata: { kind: "city_tower_upgrade" }
      });
      const updated = await client.query(
        `UPDATE flags
         SET tower_level = 1,
             health = LEAST($2::integer, health + ($2::integer - maximum_health))
         WHERE id = $1 AND control_type = 'city' AND tower_level IS NULL`,
        [flagId, STRUCTURE_WARFARE_CITY_TOWER_HEALTH]
      );
      if (updated.rowCount !== 1) {
        throw new AtlasShrineError("FLAG_UPGRADE_CONFLICT", "The City Flag changed during the upgrade");
      }
      await client.query(
        `INSERT INTO flag_tower_upgrade_operations (
           operation_key,flag_id,player_id,upgrade_kind,from_level,to_level,
           iron_quantity,stone_quantity,city_coin_quantity
         ) VALUES ($1,$2,$3,'city_tower',NULL,1,0,$4,$5)`,
        [operationKey, flagId, playerId, CITY_TOWER_UPGRADE_COST.stone, CITY_TOWER_UPGRADE_COST.cityCoins]
      );
      const progression = await this.atlasShrineProgression(playerId, client);
      await client.query("COMMIT");
      const flag = await this.getMapFlag(flagId);
      if (!flag) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag no longer exists");
      return { flag, inventory: debit.inventory, progression, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && error.message === "Inventory does not contain enough items") {
        throw new AtlasShrineError(
          "FLAG_CITY_TOWER_STONE_REQUIRED",
          `A City Tower needs ${CITY_TOWER_UPGRADE_COST.stone} stone`
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Read-only preflight for the Obelisk / Kingdom Tower build channel. The
   * completion re-checks everything under locks.
   */
  async assertKingdomStructureBuildAllowed(
    playerId: string,
    flagId: string,
    kind: KingdomStructureKind,
    targetLevel: number
  ): Promise<void> {
    const cost = kingdomStructureBuildCost(kind, targetLevel);
    if (!cost) throw new AtlasShrineError("FLAG_KINGDOM_STRUCTURE_LEVEL_INVALID", "Choose the next structure level");
    const result = await this.pool.query<TowerUpgradeTargetRow>(
      `SELECT control_type,anchor_kind,owner_id,city_id::text,kingdom_id::text,reinforcement_level,
              tower_level,obelisk_level,war_structure_kind,health,burning_until,burning_reason,territory_collapse_id::text
       FROM flags WHERE id=$1`,
      [flagId]
    );
    const row = result.rows[0];
    if (!row) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag does not exist");
    const kingdomId = assertKingdomStructureTarget(row, kind, targetLevel);
    await assertKingdomStructureBuilder(this.pool, playerId, kingdomId);
    await assertKingdomWithinStructureCapacity(this.pool, kingdomId);
    const bricks = await this.pool.query<{ quantity: string | number }>(
      `SELECT quantity FROM kingdom_treasury_balances
       WHERE kingdom_id=$1 AND resource_type=$2 AND variant='default'`,
      [kingdomId, BRICKS_ITEM_ID]
    );
    const available = Number(bricks.rows[0]?.quantity ?? 0);
    if (available < cost.bricks) {
      throw new AtlasShrineError(
        "FLAG_KINGDOM_STRUCTURE_BRICKS_REQUIRED",
        `The treasury needs ${cost.bricks.toLocaleString("en-US")} Bricks (it has ${available.toLocaleString("en-US")})`
      );
    }
  }

  /**
   * Builds an Obelisk or Kingdom Tower level on a Kingdom Flag (level 1
   * turns the flag into the structure). Bricks come from the kingdom
   * treasury; the second material (crude oil for an Obelisk, crystal for a Tower) comes from
   * the treasury when it holds the full amount, otherwise from the builder.
   *
   * Lock order: player row, flag row, then treasury balance rows and the
   * builder's inventory. The kingdom row is not locked here (the fall sweep
   * locks flags before the kingdom row). Dupe-safe: the operation key replays
   * the recorded build, and the level check under the flag row lock refuses
   * a second request for a level that is already built.
   */
  async upgradeKingdomStructure(
    playerId: string,
    flagId: string,
    kind: KingdomStructureKind,
    targetLevel: number,
    requestId: string
  ): Promise<FlagUpgradeResult> {
    const cost = kingdomStructureBuildCost(kind, targetLevel);
    if (!cost) throw new AtlasShrineError("FLAG_KINGDOM_STRUCTURE_LEVEL_INVALID", "Choose the next structure level");
    const operationKey = `kingdom-structure:${playerId}:${requestId}`;
    const label = kind === "obelisk" ? "Obelisk" : "Kingdom Tower";
    const materialLabel = cost.materialItemId === "crude_oil" ? "Crude Oil" : "Crystal";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [playerId]);
      const prior = await client.query<{ flag_id: string; structure_kind: string; to_level: number }>(
        `SELECT flag_id::text,structure_kind,to_level
         FROM kingdom_structure_build_operations WHERE operation_key=$1`,
        [operationKey]
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.flag_id !== flagId || row.structure_kind !== kind || Number(row.to_level) !== targetLevel) {
          throw new AtlasShrineError("FLAG_UPGRADE_IDEMPOTENCY_CONFLICT", "This upgrade request was already used");
        }
        const inventory = await this.inventory.snapshotInTransaction(client, playerId);
        const progression = await this.atlasShrineProgression(playerId, client);
        await client.query("COMMIT");
        const flag = await this.getMapFlag(flagId);
        if (!flag) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag no longer exists");
        return { flag, inventory, progression, replayed: true };
      }
      const row = await lockTowerUpgradeTarget(client, flagId);
      const kingdomId = assertKingdomStructureTarget(row, kind, targetLevel);
      await assertKingdomStructureBuilder(client, playerId, kingdomId);
      await assertKingdomWithinStructureCapacity(client, kingdomId);
      await assertTowerUpgradeIdle(client, row, flagId);
      const metadata = { flagId, kind, targetLevel };
      const bricks = await moveKingdomTreasuryInTransaction(client, {
        kingdomId,
        actorPlayerId: playerId,
        resourceType: BRICKS_ITEM_ID,
        direction: "debit",
        quantity: cost.bricks,
        sourceType: "kingdom_structure_build",
        operationKey,
        sourceId: flagId,
        metadata
      });
      if (!bricks) {
        throw new AtlasShrineError(
          "FLAG_KINGDOM_STRUCTURE_BRICKS_REQUIRED",
          `${label} level ${targetLevel} needs ${cost.bricks.toLocaleString("en-US")} Bricks in the treasury`
        );
      }
      const treasuryMaterial = await lockKingdomTreasuryBalance(client, kingdomId, cost.materialItemId);
      const materialSource = treasuryMaterial >= cost.materialQuantity ? "treasury" : "builder";
      let inventory: PlayerInventorySnapshot;
      if (materialSource === "treasury") {
        await moveKingdomTreasuryInTransaction(client, {
          kingdomId,
          actorPlayerId: playerId,
          resourceType: cost.materialItemId,
          direction: "debit",
          quantity: cost.materialQuantity,
          sourceType: "kingdom_structure_build",
          operationKey,
          sourceId: flagId,
          metadata
        });
        inventory = await this.inventory.snapshotInTransaction(client, playerId);
      } else {
        try {
          inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
            operationKey,
            playerId,
            source: "kingdom_structure_build",
            sourceEntityType: "flag",
            sourceEntityId: flagId,
            metadata,
            debits: [{ itemId: cost.materialItemId, variant: null, quantity: cost.materialQuantity }]
          })).inventory;
        } catch (error) {
          if (error instanceof Error && error.message === "Inventory does not contain enough items") {
            throw new AtlasShrineError(
              "FLAG_KINGDOM_STRUCTURE_MATERIAL_REQUIRED",
              `${label} level ${targetLevel} needs ${cost.materialQuantity.toLocaleString("en-US")} ${materialLabel} from the treasury or your pack`
            );
          }
          throw error;
        }
      }
      const column = kind === "obelisk" ? "obelisk_level" : "tower_level";
      const otherColumn = kind === "obelisk" ? "tower_level" : "obelisk_level";
      const updated = await client.query(
        `UPDATE flags
         SET ${column} = $3::smallint,
             health = LEAST($5::integer, health + ($5::integer - maximum_health))
         WHERE id = $1 AND control_type = 'kingdom' AND kingdom_id = $2::uuid
           AND ${column} IS NOT DISTINCT FROM $4::smallint AND ${otherColumn} IS NULL`,
        [flagId, kingdomId, targetLevel, targetLevel === 1 ? null : targetLevel - 1, cost.maximumHealth]
      );
      if (updated.rowCount !== 1) {
        throw new AtlasShrineError("FLAG_UPGRADE_CONFLICT", "The Kingdom Flag changed during the build");
      }
      await client.query(
        `INSERT INTO kingdom_structure_build_operations (
           operation_key,kingdom_id,flag_id,player_id,structure_kind,from_level,to_level,
           bricks_quantity,material_item_id,material_quantity,material_source
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [operationKey, kingdomId, flagId, playerId, kind, targetLevel === 1 ? null : targetLevel - 1,
          targetLevel, cost.bricks, cost.materialItemId, cost.materialQuantity, materialSource]
      );
      await insertKingdomAuditEvent(client, {
        kingdomId,
        actorPlayerId: playerId,
        eventType: "kingdom_structure_built",
        entityType: "flag",
        entityId: flagId,
        metadata: { ...metadata, bricks: cost.bricks, materialItemId: cost.materialItemId,
          materialQuantity: cost.materialQuantity, materialSource }
      });
      const progression = await this.atlasShrineProgression(playerId, client);
      await client.query("COMMIT");
      const flag = await this.getMapFlag(flagId);
      if (!flag) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag no longer exists");
      return { flag, inventory, progression, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The leader takes a Kingdom Tower or Obelisk down one level (never below
   * level 1) and the treasury is credited 50% (rounded down) of the removed
   * step's Bricks and second material. Health is clamped to the lower
   * maximum by the flags health trigger.
   *
   * Lock order matches the build: player row, flag row, then treasury rows.
   * Dupe-safe: the operation key replays the recorded downgrade, and the
   * level check under the flag row lock refuses a second request for a level
   * that is already gone.
   */
  async downgradeKingdomStructure(
    playerId: string,
    flagId: string,
    kind: KingdomStructureKind,
    fromLevel: number,
    requestId: string
  ): Promise<{ flag: FlagSnapshot; refund: Array<{ itemId: string; quantity: number }>; replayed: boolean }> {
    const operationKey = `kingdom-structure-downgrade:${playerId}:${requestId}`;
    const label = kind === "obelisk" ? "Obelisk" : "Kingdom Tower";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [playerId]);
      const prior = await client.query<{
        flag_id: string; structure_kind: string; from_level: number | null; operation: string;
        bricks_quantity: number; material_item_id: string; material_quantity: number;
      }>(
        `SELECT flag_id::text,structure_kind,from_level,operation,bricks_quantity,material_item_id,material_quantity
         FROM kingdom_structure_build_operations WHERE operation_key=$1`,
        [operationKey]
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.operation !== "downgrade" || row.flag_id !== flagId || row.structure_kind !== kind ||
            Number(row.from_level) !== fromLevel) {
          throw new KingdomBrickEconomyError("KINGDOM_REQUEST_CONFLICT", "This downgrade request was already used");
        }
        await client.query("COMMIT");
        const flag = await this.getMapFlag(flagId);
        if (!flag) throw new KingdomBrickEconomyError("KINGDOM_FLAG_NOT_FOUND", "Flag no longer exists");
        return {
          flag,
          refund: [
            { itemId: BRICKS_ITEM_ID, quantity: Number(row.bricks_quantity) },
            { itemId: row.material_item_id, quantity: Number(row.material_quantity) }
          ],
          replayed: true
        };
      }
      const locked = await client.query<TowerUpgradeTargetRow>(
        `SELECT control_type,anchor_kind,owner_id,city_id::text,kingdom_id::text,reinforcement_level,
                tower_level,obelisk_level,war_structure_kind,health,burning_until,burning_reason,territory_collapse_id::text
         FROM flags WHERE id=$1 FOR UPDATE`,
        [flagId]
      );
      const row = locked.rows[0];
      const currentLevel = kind === "obelisk" ? row?.obelisk_level ?? null : row?.tower_level ?? null;
      if (!row || row.control_type !== "kingdom" || !row.kingdom_id || (row.war_structure_kind ?? null) !== null ||
          currentLevel === null) {
        throw new KingdomBrickEconomyError("KINGDOM_FLAG_NOT_FOUND", `This flag is not a ${label}`);
      }
      const kingdomId = String(row.kingdom_id);
      const member = await client.query<{ role: KingdomRole; status: string }>(
        `SELECT membership.role, kingdom.status
         FROM kingdom_memberships membership
         JOIN kingdoms kingdom ON kingdom.id = membership.kingdom_id
         WHERE membership.player_id=$1 AND membership.kingdom_id=$2 AND membership.status='active'`,
        [playerId, kingdomId]
      );
      const membership = member.rows[0];
      if (!membership || membership.status !== "active" ||
          !hasKingdomPermission(membership.role, "build_kingdom_structures")) {
        throw new KingdomBrickEconomyError(
          "KINGDOM_PERMISSION_DENIED", `Only the Kingdom leader can downgrade a ${label}`
        );
      }
      if (Number(currentLevel) !== fromLevel) {
        throw new KingdomBrickEconomyError("KINGDOM_STRUCTURE_LEVEL_CHANGED", `This ${label} is now level ${currentLevel}`);
      }
      const refund = kingdomStructureDowngradeRefund(kind, fromLevel);
      if (!refund) {
        throw new KingdomBrickEconomyError("KINGDOM_STRUCTURE_DOWNGRADE_FLOOR", "A level 1 structure cannot be downgraded");
      }
      if (row.territory_collapse_id !== null || row.health === null || Number(row.health) <= 0 ||
          row.burning_reason !== null ||
          (row.burning_until !== null && new Date(row.burning_until).getTime() > Date.now()) ||
          await hasActiveRepair(client, flagId)) {
        throw new KingdomBrickEconomyError(
          "KINGDOM_STRUCTURE_BUSY", `Finish the burn or repair before downgrading this ${label}`
        );
      }
      const toLevel = fromLevel - 1;
      const metadata = { flagId, kind, fromLevel, toLevel };
      await creditKingdomDowngradeRefundInTransaction(client, {
        kingdomId, actorPlayerId: playerId, operationKey, refund, sourceId: flagId, metadata
      });
      const column = kind === "obelisk" ? "obelisk_level" : "tower_level";
      const updated = await client.query(
        `UPDATE flags SET ${column} = $3::smallint
         WHERE id = $1 AND control_type = 'kingdom' AND kingdom_id = $2::uuid AND ${column} = $4::smallint`,
        [flagId, kingdomId, toLevel, fromLevel]
      );
      if (updated.rowCount !== 1) {
        throw new KingdomBrickEconomyError("KINGDOM_STRUCTURE_LEVEL_CHANGED", `The ${label} changed during the downgrade`);
      }
      const refunded = (itemId: string) => refund.find((line) => line.itemId === itemId)?.quantity ?? 0;
      const materialItemId = kind === "obelisk" ? "crude_oil" : "crystal";
      await client.query(
        `INSERT INTO kingdom_structure_build_operations (
           operation_key,kingdom_id,flag_id,player_id,structure_kind,from_level,to_level,
           bricks_quantity,material_item_id,material_quantity,material_source,operation
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'treasury','downgrade')`,
        [operationKey, kingdomId, flagId, playerId, kind, fromLevel, toLevel,
          refunded(BRICKS_ITEM_ID), materialItemId, refunded(materialItemId)]
      );
      await insertKingdomAuditEvent(client, {
        kingdomId,
        actorPlayerId: playerId,
        eventType: "kingdom_structure_downgraded",
        entityType: "flag",
        entityId: flagId,
        metadata: { ...metadata, refund }
      });
      await client.query("COMMIT");
      const flag = await this.getMapFlag(flagId);
      if (!flag) throw new KingdomBrickEconomyError("KINGDOM_FLAG_NOT_FOUND", "Flag no longer exists");
      return { flag, refund: refund.map((line) => ({ ...line })), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * A kingdom member raises a War Tower or War Outpost at their live
   * position (B2). Placement rule: outside every claim (the database's
   * center-outside-claim invariant) and within WAR_STRUCTURE_PLACEMENT_RANGE_M
   * (2 km) of the territory edge of an organization the kingdom is actively
   * at war with; the structure is tied to that war and breaks when it ends.
   * The Command Board level caps standing structures per kind; the kingdom
   * spacing rule does not apply. Gold comes from the builder's wallet. For
   * the leader each material comes from the treasury when it holds the full
   * amount, otherwise from the leader's pack; any other member pays every
   * material from their own pack and never touches the treasury.
   *
   * Lock order: player row, the tied war row (shared), the kingdom flag
   * network advisory lock (serializes the cap), treasury rows / wallet /
   * inventory, then the flag-control geometry lock and the new flag row.
   * Dupe-safe: the operation key replays the recorded placement.
   */
  async placeKingdomWarStructure(
    player: Readonly<{ playerId: string; lat: number; lon: number }>,
    input: KingdomWarStructurePlaceInput
  ): Promise<{ flag: FlagSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean }> {
    const label = kingdomWarStructureLabel(input.kind);
    const position = { lat: player.lat, lon: player.lon };
    const fail = (code: string, message: string, details?: Record<string, unknown>) =>
      new KingdomBrickEconomyError(code, message, details);
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lon) || !isWithinWorldEdge(position)) {
      throw fail("KINGDOM_WAR_STRUCTURE_POSITION_INVALID", `You cannot raise a ${label} here`);
    }
    const operationKey = `kingdom-war-structure:${player.playerId}:${input.requestId}`;
    const loadPrior = async (queryable: Pick<pg.Pool | pg.PoolClient, "query">) =>
      (await queryable.query<{ flag_id: string; structure_kind: string }>(
        "SELECT flag_id::text, structure_kind FROM kingdom_war_structure_operations WHERE operation_key=$1",
        [operationKey]
      )).rows[0] ?? null;
    const replay = async (prior: { flag_id: string; structure_kind: string }) => {
      if (prior.structure_kind !== input.kind) {
        throw fail("KINGDOM_WAR_STRUCTURE_IDEMPOTENCY_CONFLICT", "This placement request was already used");
      }
      const flag = await this.getMapFlag(prior.flag_id);
      if (!flag) throw fail("KINGDOM_WAR_STRUCTURE_NOT_FOUND", `That ${label} no longer stands`);
      return { flag, inventory: await this.inventory.getInventorySnapshot(player.playerId), replayed: true };
    };
    const earlier = await loadPrior(this.pool);
    if (earlier) return replay(earlier);
    const world = await this.worldLookup.lookupGameplayEnvironment(position.lat, position.lon);
    if (!world.ok) {
      throw fail("KINGDOM_WAR_STRUCTURE_WORLD_UNAVAILABLE", "World terrain is unavailable here; try again shortly");
    }
    try {
      this.assertWorldLookupPlaceable(world, "flag");
    } catch (error) {
      if (error instanceof FlagPlacementError) throw fail("KINGDOM_WAR_STRUCTURE_TERRAIN_INVALID", error.message);
      throw error;
    }
    const cost = kingdomWarStructureCost(input.kind);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const playerRow = await client.query<{ account_id: string }>(
        "SELECT account_id::text FROM players WHERE id=$1 FOR UPDATE",
        [player.playerId]
      );
      if (!playerRow.rows[0]) throw fail("KINGDOM_WAR_STRUCTURE_NOT_FOUND", "Player not found");
      const prior = await loadPrior(client);
      if (prior) {
        await client.query("COMMIT");
        return replay(prior);
      }
      // Treasury access follows the active leader role, not kingdoms.leader_player_id:
      // a leader deposed into anarchy keeps that column until a successor takes over.
      const membership = await client.query<{
        kingdom_id: string; leader_player_id: string; is_leader: boolean; display_name: string;
        castle_ruined: boolean;
      }>(
        `SELECT membership.kingdom_id::text, kingdom.leader_player_id, membership.role = 'leader' AS is_leader,
                kingdom.display_name, kingdom.castle_ruined_at IS NOT NULL AS castle_ruined
         FROM kingdom_memberships membership
         JOIN kingdoms kingdom ON kingdom.id = membership.kingdom_id AND kingdom.status = 'active'
         WHERE membership.player_id = $1 AND membership.status = 'active'
         LIMIT 1`,
        [player.playerId]
      );
      const kingdom = membership.rows[0];
      if (!kingdom) {
        throw fail("KINGDOM_WAR_STRUCTURE_PERMISSION_DENIED", `Only kingdom members can raise a ${label}`);
      }
      if (kingdom.castle_ruined) {
        throw fail("KINGDOM_CASTLE_RUBBLE", "The Castle lies in rubble: the leader must rebuild it first");
      }
      const enemy = await client.query<{ war_id: string; edge_distance_m: number }>(
        `SELECT war.war_id::text,
                GREATEST(0, ST_Distance(enemy.geom::geography, point.geog) - enemy.claim_radius_m) AS edge_distance_m
         FROM organization_wars war
         CROSS JOIN (SELECT ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography AS geog) point
         JOIN flags enemy ON (
           (war.side_a_kind = 'kingdom' AND war.side_a_id = $1::uuid AND (
             (war.side_b_kind = 'city' AND enemy.city_id = war.side_b_id)
             OR (war.side_b_kind = 'kingdom' AND enemy.kingdom_id = war.side_b_id)))
           OR
           (war.side_b_kind = 'kingdom' AND war.side_b_id = $1::uuid AND (
             (war.side_a_kind = 'city' AND enemy.city_id = war.side_a_id)
             OR (war.side_a_kind = 'kingdom' AND enemy.kingdom_id = war.side_a_id)))
         )
         WHERE war.status = 'active'
           AND enemy.control_type IN ('city', 'city_seat', 'kingdom', 'kingdom_seat')
           AND enemy.war_structure_kind IS NULL
           AND enemy.territory_collapse_id IS NULL
           AND NOT enemy.system_controlled
           AND ST_DWithin(enemy.geom::geography, point.geog, enemy.claim_radius_m + $4)
         ORDER BY edge_distance_m, war.war_id
         LIMIT 1
         FOR SHARE OF war`,
        [kingdom.kingdom_id, position.lat, position.lon, WAR_STRUCTURE_PLACEMENT_RANGE_M]
      );
      const war = enemy.rows[0];
      if (!war) {
        throw fail(
          "KINGDOM_WAR_STRUCTURE_NO_ENEMY_NEAR",
          `Raise a ${label} within 2 km of territory your kingdom is at war with`
        );
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`kingdom-flag-network:${kingdom.kingdom_id}`]
      );
      const tableLevel = await kingdomCommandBoardLevelOf(client, kingdom.kingdom_id);
      const cap = kingdomWarStructureCap(tableLevel, input.kind);
      const used = await countKingdomWarStructures(client, kingdom.kingdom_id, input.kind);
      if (used >= cap) {
        throw fail(
          "KINGDOM_WAR_STRUCTURE_CAPACITY",
          tableLevel === 0
            ? `Build the Command Board before raising a ${label}`
            : `The Command Board (level ${tableLevel}) allows ${cap} ${label}${cap === 1 ? "" : "s"}; all are standing`,
          { used, cap, tableLevel }
        );
      }
      const flagId = randomUUID();
      const metadata = { flagId, kind: input.kind, warId: war.war_id };
      if (cost.gold > 0) {
        try {
          await new WalletService().debitForOperationInTransaction(client, {
            playerId: player.playerId,
            accountId: playerRow.rows[0].account_id,
            amount: BigInt(cost.gold),
            operationKey,
            reason: "kingdom_war_structure_build",
            metadata
          });
        } catch (error) {
          if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
            throw fail(
              "KINGDOM_WAR_STRUCTURE_GOLD_INSUFFICIENT",
              `A ${label} costs ${cost.gold.toLocaleString("en-US")} gold`
            );
          }
          throw error;
        }
      }
      const materials = await chargeKingdomWarMaterialsInTransaction(client, this.inventory, {
        kingdomId: kingdom.kingdom_id,
        playerId: player.playerId,
        operationKey,
        materials: cost.materials,
        ledgerSource: "war_structure_build",
        inventorySource: "kingdom_war_structure_build",
        sourceEntityType: "flag",
        sourceEntityId: flagId,
        metadata,
        treasuryAllowed: kingdom.is_leader,
        shortageMessage: (material) =>
          `A ${label} needs ${material.quantity.toLocaleString("en-US")} ${warMaterialLabel(material.itemId)} ` +
          (kingdom.is_leader ? "from the treasury or your pack" : "in your pack")
      });
      await lockFlagControlGeometry(client);
      try {
        await this.insertFlag({
          id: flagId,
          anchorKind: "flag",
          ownerId: player.playerId,
          name: `${kingdom.display_name} ${label}`.slice(0, 48),
          lat: position.lat,
          lon: position.lon,
          world,
          accessMode: "private",
          claimRadiusM: WAR_STRUCTURE_CLAIM_RADIUS_M
        }, client);
        await client.query("SET CONSTRAINTS flags_mixed_control_geometry IMMEDIATE");
        await client.query(
          `UPDATE flags SET control_type = 'kingdom', kingdom_id = $2::uuid, owner_id = $3,
              kingdom_affiliated_at = now(), kingdom_affiliated_by_player_id = $4,
              original_owner_player_id = $4, contributed_by_player_id = $4,
              war_structure_kind = $5, war_id = $6::uuid,
              health = NULL, maximum_health = NULL
           WHERE id = $1::uuid`,
          [flagId, kingdom.kingdom_id, kingdom.leader_player_id, player.playerId, input.kind, war.war_id]
        );
      } catch (error) {
        const database = error as { code?: string };
        if (error instanceof FlagPlacementError || database.code === "23514") {
          throw fail(
            "KINGDOM_WAR_STRUCTURE_TERRITORY_OVERLAP",
            `A ${label} must stand outside every claimed territory and clear of players' flag land`
          );
        }
        throw error;
      }
      await client.query(
        `INSERT INTO kingdom_war_structure_operations (
           operation_key, kingdom_id, war_id, flag_id, player_id, structure_kind, lat, lon, gold, materials
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [operationKey, kingdom.kingdom_id, war.war_id, flagId, player.playerId, input.kind,
          position.lat, position.lon, cost.gold, JSON.stringify(materials)]
      );
      await insertKingdomAuditEvent(client, {
        kingdomId: kingdom.kingdom_id,
        actorPlayerId: player.playerId,
        eventType: "war_structure_placed",
        entityType: "flag",
        entityId: flagId,
        metadata: { ...metadata, gold: cost.gold, materials }
      });
      const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      const flag = await this.getMapFlag(flagId);
      if (!flag) throw fail("KINGDOM_WAR_STRUCTURE_NOT_FOUND", `The ${label} could not be loaded`);
      return { flag, inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reinforceFlag(
    playerId: string,
    flagId: string,
    requestId: string
  ): Promise<{
    flag: FlagSnapshot;
    inventory: PlayerInventorySnapshot;
    replayed: boolean;
    masteryGrant?: MasteryGrantResult;
  }> {
    const result = await this.upgradeFlagTier(playerId, flagId, "stone", requestId);
    return {
      flag: result.flag,
      inventory: result.inventory,
      replayed: result.replayed,
      ...(result.masteryGrant ? { masteryGrant: result.masteryGrant } : {})
    };
  }

  async repairBurningStoneFlag(
    ownerPlayerId: string,
    flagId: string,
    playerPosition?: Readonly<{ lat: number; lon: number }>
  ): Promise<FlagSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Burn completion locks the durable operation before locking the flag.
      // Take that same order here so a repair racing the completion cannot
      // deadlock while both operations reconcile the same flag.
      await client.query(
        `SELECT operation_id
         FROM flag_burn_operations
         WHERE flag_id=$1 AND status='active'
         FOR UPDATE`,
        [flagId]
      );
      const flag = await client.query<{
        owner_id: string;
        control_type: string;
        anchor_kind: string;
        reinforcement_level: number;
        burning_reason: string | null;
        lat: number;
        lon: number;
      }>(
        `SELECT owner_id,control_type,anchor_kind,reinforcement_level,burning_reason,lat,lon
         FROM flags WHERE id=$1 FOR UPDATE`,
        [flagId]
      );
      const row = flag.rows[0];
      if (!row) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag does not exist.");
      if (row.owner_id !== ownerPlayerId) {
        throw new AtlasShrineError("FLAG_REPAIR_FORBIDDEN", "Only the flag owner can repair it.");
      }
      const legendaryEvent = await client.query<{ event_id: string }>(
        `SELECT event_id::text
         FROM legendary_bird_events
         WHERE flag_id=$1 AND status IN ('pending','active','completed')
           AND expires_at>clock_timestamp()
         ORDER BY expires_at,event_id
         LIMIT 1
         FOR UPDATE`,
        [flagId]
      );
      const legacyEventBurn = row.burning_reason === "legendary_event";
      const canonicalEventBurn = row.burning_reason === "flag_burn" && legendaryEvent.rowCount === 1;
      if (row.control_type !== "personal" || row.anchor_kind !== "flag" || ![1, 3].includes(Number(row.reinforcement_level)) ||
          (!legacyEventBurn && !canonicalEventBurn)) {
        throw new AtlasShrineError("FLAG_REPAIR_INELIGIBLE", "Only an active legendary Stone or Tower encounter can use this repair path.");
      }
      if (playerPosition) {
        if (distanceMeters(playerPosition, { lat: Number(row.lat), lon: Number(row.lon) }) > FLAG_BURN_INTERACTION_RADIUS_M) {
          throw new AtlasShrineError(
            "FLAG_REPAIR_OUT_OF_RANGE",
            `Move within ${FLAG_BURN_INTERACTION_RADIUS_M}m of the Flag before repairing it.`
          );
        }
      }
      await client.query(
        `UPDATE flags SET health=maximum_health,burning_started_at=NULL,
                burning_until=NULL,burning_reason=NULL,damage_cycle_id=NULL
         WHERE id=$1`,
        [flagId]
      );
      await client.query(
        `UPDATE flag_burn_operations
         SET status='cancelled',cancel_reason='repaired',completed_at=now()
         WHERE flag_id=$1 AND status='active'`,
        [flagId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const repaired = await this.getFlag(flagId);
    if (!repaired) throw new Error("Repaired flag could not be loaded");
    return repaired;
  }

  async createPlacementQuote(
    player: PlayerRecord,
    options: {
      signal?: AbortSignal | undefined;
      anchorKind?: PersonalAnchorKind;
    } = {}
  ): Promise<{
    world: WorldLookupResult;
    quote: FlagPlacementQuote;
  }> {
    const anchorKind = options.anchorKind ?? "flag";
    const playerQuoteKey = placementQuoteOwnerKey(player.playerId, anchorKind);
    const requestKey = placementQuoteBindingKey(
      player,
      this.config.WORLD_REQUIRED_RELEASE_ID,
      anchorKind
    );
    this.latestPlacementBindingByPlayer.set(playerQuoteKey, requestKey);
    const latestQuoteId = this.latestPlacementQuoteByPlayer.get(playerQuoteKey);
    const latestQuote = latestQuoteId ? this.placementQuotes.get(latestQuoteId) : undefined;
    if (
      latestQuote &&
      this.placementQuoteDiagnostic(player, undefined, latestQuoteId, latestQuote).quoteState === "hit"
    ) {
      this.quoteMetrics.quoteReused += 1;
      return { world: latestQuote.world, quote: publicPlacementQuote(latestQuote) };
    }
    const inFlight = this.placementQuoteRequests.get(requestKey);
    if (inFlight) {
      this.quoteMetrics.quoteSingleflightJoined += 1;
      return inFlight;
    }
    const bindingPlayer = {
      ...player,
      position: { ...player.position }
    };
    const request = this.createPlacementQuoteFresh(
      bindingPlayer,
      requestKey,
      anchorKind,
      options.signal
    );
    this.placementQuoteRequests.set(requestKey, request);
    try {
      return await request;
    } finally {
      if (this.placementQuoteRequests.get(requestKey) === request) {
        this.placementQuoteRequests.delete(requestKey);
      }
    }
  }

  private async createPlacementQuoteFresh(
    player: PlayerRecord,
    requestKey: string,
    anchorKind: PersonalAnchorKind,
    signal?: AbortSignal
  ): Promise<{
    world: WorldLookupResult;
    quote: FlagPlacementQuote;
  }> {
    const prepared = await this.prepareFreshPlacement(player, undefined, anchorKind, signal);
    const createdAt = Date.now();
    const quote: StoredFlagPlacementQuote = {
      quoteId: randomUUID(),
      anchorKind,
      playerId: player.playerId,
      ownerUsername: player.username,
      ownerColor: playerPersonalFlagColor(player),
      regionCode: player.regionCode,
      movementLeashRadiusM: player.moveLeashRadiusM,
      defaultName: prepared.name,
      builderRank: prepared.builderRank,
      buildDurationMs: prepared.buildDurationMs,
      world: prepared.world,
      position: { lat: prepared.lat, lon: prepared.lon },
      movementRevision: prepared.movementRevision,
      relocationRevision: prepared.relocationRevision,
      worldReleaseId: worldReleaseId(prepared.world),
      materialAffordable: prepared.materialAffordable,
      createdAt,
      expiresAt: createdAt + 60_000
    };
    const playerQuoteKey = placementQuoteOwnerKey(player.playerId, anchorKind);
    const priorQuoteId = this.latestPlacementQuoteByPlayer.get(playerQuoteKey);
    const priorQuote = priorQuoteId ? this.placementQuotes.get(priorQuoteId) : undefined;
    if (
      priorQuote &&
      this.placementQuoteDiagnostic(player, undefined, priorQuoteId, priorQuote).quoteState === "hit"
    ) {
      this.quoteMetrics.validQuoteReplacement += 1;
    }
    while (this.placementQuotes.size >= 2_048) {
      const oldest = this.placementQuotes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.placementQuotes.delete(oldest);
    }
    this.placementQuotes.set(quote.quoteId, quote);
    this.quoteMetrics.quoteCreated += 1;
    if (this.latestPlacementBindingByPlayer.get(playerQuoteKey) === requestKey) {
      if (priorQuoteId) this.placementQuotes.delete(priorQuoteId);
      this.latestPlacementQuoteByPlayer.set(playerQuoteKey, quote.quoteId);
    }
    return { world: prepared.world, quote: publicPlacementQuote(quote) };
  }

  placementQuoteMetrics(): FlagPlacementQuoteMetrics {
    return { ...this.quoteMetrics };
  }

  notePostBuildQuoteSuppressed(): void {
    this.quoteMetrics.postBuildQuoteSuppressed += 1;
  }

  async tryCreatePlacementQuote(
    player: PlayerRecord,
    options: {
      signal?: AbortSignal | undefined;
      anchorKind?: PersonalAnchorKind;
    } = {}
  ): Promise<{
    world?: WorldLookupResult;
    placementQuote?: FlagPlacementQuote;
    failure?: {
      code: string;
      message: string;
      retryable: boolean;
      retryAfterMs?: number;
      failureStage: FlagPlacementFailureStage;
      errorClass: string;
      domainCode: string;
    };
  }> {
    try {
      const prepared = await this.createPlacementQuote(player, options);
      return { world: prepared.world, placementQuote: prepared.quote };
    } catch (error) {
      if (!(error instanceof FlagPlacementError)) throw error;
      return {
        ...(error.world ? { world: error.world } : {}),
        failure: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          failureStage: error.failureStage,
          errorClass: error.errorClass,
          domainCode: error.code,
          ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs })
        }
      };
    }
  }

  async prepareForPlayer(
    player: PlayerRecord,
    requestedName?: string,
    quoteId?: string,
    anchorKind: PersonalAnchorKind = "flag"
  ): Promise<PreparedFlagPlacement> {
    const playerQuoteKey = placementQuoteOwnerKey(player.playerId, anchorKind);
    let selectedQuoteId = quoteId ?? this.latestPlacementQuoteByPlayer.get(playerQuoteKey);
    let quote = selectedQuoteId ? this.placementQuotes.get(selectedQuoteId) : undefined;
    if (quote?.anchorKind !== anchorKind) quote = undefined;
    let diagnostic = this.placementQuoteDiagnostic(
      player,
      quoteId,
      selectedQuoteId,
      quote
    );
    if (quoteId && diagnostic.quoteState !== "hit") {
      const latestQuoteId = this.latestPlacementQuoteByPlayer.get(playerQuoteKey);
      if (latestQuoteId && latestQuoteId !== selectedQuoteId) {
        const latestQuote = this.placementQuotes.get(latestQuoteId);
        const latestDiagnostic = this.placementQuoteDiagnostic(
          player,
          quoteId,
          latestQuoteId,
          latestQuote
        );
        if (latestQuote && latestDiagnostic.quoteState === "hit") {
          selectedQuoteId = latestQuoteId;
          quote = latestQuote;
          diagnostic = latestDiagnostic;
        }
      }
    }
    if (quote && diagnostic.quoteState === "hit") {
      const started = performance.now();
      try {
        await this.assertFlagPlacementAllowedAt(
          player.playerId,
          player.position.lat,
          player.position.lon
        );
      } catch (error) {
        if (error instanceof FlagPlacementError) {
          throw new FlagPlacementError(
            error.message,
            error.code,
            error.retryable,
            error.retryAfterMs,
            error.world,
            diagnostic,
            "territory",
            error.errorClass
          );
        }
        throw error;
      }
      const totalMs = performance.now() - started;
      const prepared: PreparedFlagPlacement = {
        flagId: randomUUID(),
        anchorKind,
        ownerId: player.playerId,
        ownerUsername: player.username,
        ownerColor: playerPersonalFlagColor(player),
        name: requestedName?.trim() ? sanitizeFlagName(requestedName, 1) : quote.defaultName,
        lat: player.position.lat,
        lon: player.position.lon,
        regionCode: player.regionCode,
        movementLeashRadiusM: player.moveLeashRadiusM,
        movementRevision: player.movementRevision,
        relocationRevision: player.relocationRevision ?? 0,
        builderRank: quote.builderRank,
        buildDurationMs: quote.buildDurationMs,
        materialAffordable: quote.materialAffordable,
        world: quote.world,
        ...(!quote.world.ok
          ? { warning: quote.world.warning ?? "flag created with unresolved world data" }
          : {}),
        admissionTimings: {
          defaultNameMs: 0,
          territoryAdmissionMs: totalMs,
          worldLookupMs: 0,
          builderRankMs: 0,
          affordabilityMs: 0,
          totalMs,
          quoteState: "hit"
        },
        quoteDiagnostic: diagnostic
      };
      this.consumePlacementQuote(quote);
      return prepared;
    }
    throw new FlagPlacementError(
      diagnostic.quoteState === "missing"
        ? "Preparing location. Try again shortly."
        : "The prepared location is stale. Try again.",
      diagnostic.quoteState === "missing" ? "FLAG_QUOTE_NOT_READY" : "FLAG_QUOTE_STALE",
      true,
      0,
      undefined,
      diagnostic
    );
  }

  private async prepareFreshPlacement(
    player: PlayerRecord,
    requestedName: string | undefined,
    anchorKind: PersonalAnchorKind,
    signal?: AbortSignal
  ): Promise<PreparedFlagPlacement> {
    const validationStartedAt = performance.now();
    const timed = async <T>(operation: () => Promise<T>): Promise<{ value: T; durationMs: number }> => {
      const started = performance.now();
      const value = await operation();
      return { value, durationMs: performance.now() - started };
    };
    const territoryResult = await timed(() => this.assertFlagPlacementAllowedAt(
      player.playerId,
      player.position.lat,
      player.position.lon
    )).catch((error: unknown) => {
      throw placementStageError(error, "territory");
    });
    const [nameResult, worldResult, rankResult, affordabilityResult] = await Promise.all([
      requestedName?.trim()
        ? Promise.resolve().then(() => ({
            value: sanitizeFlagName(requestedName, 1),
            durationMs: 0
          })).catch((error: unknown) => {
            throw placementStageError(error, "naming");
          })
        : timed(() => this.nextDefaultAnchorName(player.playerId, anchorKind)).catch((error: unknown) => {
            throw placementStageError(error, "naming");
          }),
      timed(() => this.worldLookup.lookupGameplayEnvironment(
        player.position.lat,
        player.position.lon,
        { signal }
      )).catch((error: unknown) => {
        throw placementStageError(error, "world");
      }),
      timed(() => this.masteries?.professionRank(player.playerId, "builder") ?? Promise.resolve(0))
        .catch((error: unknown) => {
          throw placementStageError(error, "mastery");
        }),
      timed(() => this.inventory.canAfford(player.playerId, recipeForAnchor(anchorKind)))
        .catch((error: unknown) => {
          throw placementStageError(error, "affordability");
        })
    ]);
    const world = worldResult.value;
    const totalMs = performance.now() - validationStartedAt;
    const admissionTimings: FlagAdmissionTimings = {
      defaultNameMs: nameResult.durationMs,
      territoryAdmissionMs: territoryResult.durationMs,
      worldLookupMs: worldResult.durationMs,
      builderRankMs: rankResult.durationMs,
      affordabilityMs: affordabilityResult.durationMs,
      totalMs,
      quoteState: "missing"
    };
    this.logger.info({
      playerId: player.playerId,
      ...admissionTimings,
      worldCache: this.worldLookup.gameplayEnvironmentMetrics?.() ?? null,
      worldTraffic: "compact-gameplay-environment",
      worldReleaseId: worldReleaseId(world)
    }, "flag placement compact World validation completed");
    if (!world.ok && !this.config.ALLOW_UNRESOLVED_FLAGS_IN_DEV) {
      const failure = world.failure ?? {
        code: "WORLD_LOOKUP_RETRYABLE" as WorldLookupFailureCode,
        message: "World validation could not be completed. Try again shortly.",
        retryable: true,
        retryAfterMs: 2_000
      };
      throw new FlagPlacementError(
        failure.message,
        failure.code,
        failure.retryable,
        failure.retryAfterMs,
        world,
        undefined,
        "world"
      );
    }
    try {
      this.assertWorldLookupPlaceable(world, anchorKind);
    } catch (error) {
      throw placementStageError(error, "world", world);
    }

    const warning = world.ok ? undefined : world.warning ?? "flag created with unresolved world data";
    return {
      flagId: randomUUID(),
      anchorKind,
      ownerId: player.playerId,
      ownerUsername: player.username,
      ownerColor: playerPersonalFlagColor(player),
      name: nameResult.value,
      lat: player.position.lat,
      lon: player.position.lon,
      regionCode: player.regionCode,
      movementLeashRadiusM: player.moveLeashRadiusM,
      movementRevision: player.movementRevision,
      relocationRevision: player.relocationRevision ?? 0,
      builderRank: rankResult.value,
      buildDurationMs: adjustedFlagBuildDuration(
        this.config.FLAG_BUILD_DURATION_MS,
        rankResult.value
      ),
      materialAffordable: affordabilityResult.value,
      world,
      admissionTimings,
      quoteDiagnostic: {
        quoteIdPresent: false,
        quoteState: "missing",
        quoteMismatchReason: "missing",
        quoteAgeMs: null,
        quoteExpiresInMs: null,
        movementRevision: player.movementRevision,
        relocationRevision: player.relocationRevision ?? 0,
        worldLookupAttempted: true
      },
      ...(warning ? { warning } : {})
    };
  }

  private placementQuoteDiagnostic(
    player: PlayerRecord,
    suppliedQuoteId: string | undefined,
    selectedQuoteId: string | undefined,
    quote: StoredFlagPlacementQuote | undefined
  ): FlagPlacementQuoteDiagnostic {
    const now = Date.now();
    let quoteState: FlagPlacementQuoteState = "hit";
    if (!selectedQuoteId) quoteState = "missing";
    else if (!quote) {
      quoteState = this.consumedPlacementQuotes.has(selectedQuoteId) ? "consumed" : "unknown-id";
    } else if (quote.expiresAt <= now) quoteState = "expired";
    else if (
      quote.playerId !== player.playerId ||
      quote.position.lat !== player.position.lat ||
      quote.position.lon !== player.position.lon
    ) quoteState = "position-mismatch";
    else if (quote.movementRevision !== player.movementRevision) {
      quoteState = "movement-revision-mismatch";
    } else if (quote.relocationRevision !== (player.relocationRevision ?? 0)) {
      quoteState = "relocation-revision-mismatch";
    } else if (quote.regionCode !== player.regionCode) quoteState = "region-mismatch";
    else if (
      quote.worldReleaseId !== this.config.WORLD_REQUIRED_RELEASE_ID &&
      (quote.world.ok || !this.config.ALLOW_UNRESOLVED_FLAGS_IN_DEV)
    ) quoteState = "release-mismatch";
    return {
      quoteIdPresent: suppliedQuoteId !== undefined,
      quoteState,
      quoteMismatchReason: quoteState === "hit" ? null : quoteState,
      quoteAgeMs: quote ? Math.max(0, now - quote.createdAt) : null,
      quoteExpiresInMs: quote ? quote.expiresAt - now : null,
      movementRevision: player.movementRevision,
      relocationRevision: player.relocationRevision ?? 0,
      worldLookupAttempted: false
    };
  }

  private consumePlacementQuote(quote: StoredFlagPlacementQuote): void {
    this.placementQuotes.delete(quote.quoteId);
    const playerQuoteKey = placementQuoteOwnerKey(quote.playerId, quote.anchorKind);
    if (this.latestPlacementQuoteByPlayer.get(playerQuoteKey) === quote.quoteId) {
      this.latestPlacementQuoteByPlayer.delete(playerQuoteKey);
    }
    const now = Date.now();
    this.consumedPlacementQuotes.set(quote.quoteId, now + 10 * 60_000);
    for (const [id, expiresAt] of this.consumedPlacementQuotes) {
      if (expiresAt <= now || this.consumedPlacementQuotes.size > 2_048) {
        this.consumedPlacementQuotes.delete(id);
      }
    }
  }

  async commitPreparedPlacement(
    prepared: PreparedFlagPlacement,
    revalidate = true,
    buildRequestId?: string
  ): Promise<CreateFlagResult> {
    const commitStartedAt = performance.now();
    const poolWaitStartedAt = performance.now();
    const client = await this.pool.connect();
    const databasePoolWaitMs = performance.now() - poolWaitStartedAt;
    let row: FlagRow | undefined;
    let replayFlagId: string | null = null;
    let masteryGrant: CompactMasteryGrantResult | undefined;
    let inventory: PlayerInventorySnapshot | undefined;
    let activationJobKey: string | undefined;
    let flagSetRevision: number | undefined;
    let materialsRefunded = false;
    const timings: FlagCommitTimings = {
      databasePoolWaitMs,
      requestReplayLockMs: 0,
      spatialLockWaitMs: 0,
      finalTerritoryRevalidationMs: 0,
      inventoryDebitMs: 0,
      flagInsertMs: 0,
      builderOutcomeMs: 0,
      activationJobInsertMs: 0,
      playerAuthorityUpdateMs: 0,
      transactionCommitMs: 0,
      totalMs: 0
    };
    try {
      await client.query("BEGIN");
      if (buildRequestId) {
        const operationKey = `flag-build:${prepared.ownerId}:${buildRequestId}`;
        const replayLockStartedAt = performance.now();
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [operationKey]
        );
        timings.requestReplayLockMs = performance.now() - replayLockStartedAt;
        const existing = await client.query<{
          flag_id: string;
          materials_refunded: boolean;
        }>(
          `SELECT flag_id, materials_refunded
           FROM flag_build_operations
           WHERE operation_key = $1 AND player_id = $2 AND request_id = $3`,
          [operationKey, prepared.ownerId, buildRequestId]
        );
        if (existing.rows[0]) {
          replayFlagId = existing.rows[0].flag_id;
          materialsRefunded = existing.rows[0].materials_refunded;
        }
      }

      if (!replayFlagId) {
        const spatialLockStartedAt = performance.now();
        await client.query(
          `SELECT lock_flag_placement_cells(
             ST_SetSRID(ST_MakePoint($1, $2), 4326)
           )`,
          [prepared.lon, prepared.lat]
        );
        timings.spatialLockWaitMs = performance.now() - spatialLockStartedAt;
        if (revalidate) {
          const revalidationStartedAt = performance.now();
          await this.assertFlagPlacementAllowedAt(
            prepared.ownerId,
            prepared.lat,
            prepared.lon,
            client
          );
          timings.finalTerritoryRevalidationMs = performance.now() - revalidationStartedAt;
        }
        if (buildRequestId) {
          const inventoryStartedAt = performance.now();
          const recipe = recipeForAnchor(prepared.anchorKind);
          const cost = costForAnchor(prepared.anchorKind);
          const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
            operationKey: `flag-build:${prepared.ownerId}:${buildRequestId}`,
            playerId: prepared.ownerId,
            source: "flag_construction",
            sourceEntityType: "flag",
            sourceEntityId: prepared.flagId,
            metadata: cost,
            debits: recipe.map(({ itemId, quantity }) => ({
              itemId,
              variant: null,
              quantity
            }))
          });
          await recordFlagMaterialSpend(
            client,
            prepared.flagId,
            `flag-build:${prepared.ownerId}:${buildRequestId}`,
            "base"
          );
          inventory = debit.inventory;
          timings.inventoryDebitMs = performance.now() - inventoryStartedAt;
        }
        const insertStartedAt = performance.now();
        row = await this.insertFlag({
          id: prepared.flagId,
          anchorKind: prepared.anchorKind,
          ownerId: prepared.ownerId,
          name: prepared.name,
          lat: prepared.lat,
          lon: prepared.lon,
          world: prepared.world
        }, client);
        timings.flagInsertMs = performance.now() - insertStartedAt;
        const flag = rowToFlag(row, prepared.ownerColor, prepared.ownerUsername);
        const activationStartedAt = performance.now();
        const activation = resourceVisionJobIdentity(
          {
            flag,
            regionCode: prepared.regionCode,
            movementLeashRadiusM: prepared.movementLeashRadiusM,
            reason: "flag-build"
          },
          flag.resourceVisionRadiusM ?? this.config.FLAG_RESOURCE_VISION_RADIUS_M,
          this.config,
          RESOURCE_LAYOUT_VERSION
        );
        await insertResourceVisionJobInTransaction(client, activation);
        activationJobKey = activation.jobKey;
        timings.activationJobInsertMs = performance.now() - activationStartedAt;
        flagSetRevision = Number((await client.query<{
          revision: string | number;
        }>(
          "SELECT last_value AS revision FROM flag_set_revision_sequence"
        )).rows[0]?.revision ?? 0);

        if (buildRequestId && this.masteries) {
          const builderStartedAt = performance.now();
          const builderRank = await this.masteries.professionRankInTransaction(
            client,
            prepared.ownerId,
            "builder"
          );
          const refundChance = builderRefundChance(builderRank);
          materialsRefunded = refundChance > 0 && serverRoll() < refundChance;
          if (materialsRefunded) {
            const recipe = recipeForAnchor(prepared.anchorKind);
            const refund = await this.inventory.grantItemsForOperationInTransaction(client, {
              operationKey: `flag-build-refund:${prepared.ownerId}:${buildRequestId}`,
              playerId: prepared.ownerId,
              source: "flag_construction_refund",
              sourceEntityType: "flag",
              sourceEntityId: prepared.flagId,
              metadata: { actualPaidCost: costForAnchor(prepared.anchorKind) },
              grants: recipe.map(({ itemId, quantity }) => ({
                itemId,
                variant: null,
                quantity
              }))
            });
            inventory = refund.inventory;
          }
          masteryGrant = await this.masteries.grantProfessionXpCompactInTransaction(client, {
            operationKey: `profession-xp:flag-build:${prepared.ownerId}:${buildRequestId}:builder`,
            playerId: prepared.ownerId,
            sourceId: prepared.flagId,
            activity: { kind: "flag-build" },
            randomResults: { materialsRefunded, refundChance }
          });
          timings.builderOutcomeMs = performance.now() - builderStartedAt;
          await client.query(
            `INSERT INTO flag_build_operations (
               operation_key, player_id, request_id, flag_id,
               materials_refunded, refund_chance
             ) VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              `flag-build:${prepared.ownerId}:${buildRequestId}`,
              prepared.ownerId,
              buildRequestId,
              prepared.flagId,
              materialsRefunded,
              refundChance
            ]
          );
        } else if (buildRequestId) {
          await client.query(
            `INSERT INTO flag_build_operations (
               operation_key, player_id, request_id, flag_id
             ) VALUES ($1,$2,$3,$4)`,
            [
              `flag-build:${prepared.ownerId}:${buildRequestId}`,
              prepared.ownerId,
              buildRequestId,
              prepared.flagId
            ]
          );
        }
      }
      const commitStarted = performance.now();
      await client.query("COMMIT");
      timings.transactionCommitMs = performance.now() - commitStarted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    timings.totalMs = performance.now() - commitStartedAt;

    if (replayFlagId) {
      const flag = await this.getFlag(replayFlagId);
      if (!flag) throw new Error("completed flag replay is no longer available");
      return {
        flag,
        materialsRefunded,
        replayed: true,
        inventory: await this.inventory.getInventorySnapshot(prepared.ownerId),
        flagSetRevision: await this.currentFlagSetRevision(),
        timings
      };
    }
    if (!row) throw new Error("flag transaction committed without a flag row");

    this.logger.info(
        {
          flagId: row.id,
          ownerId: row.owner_id,
          lat: row.lat,
          lon: row.lon,
          packageId: row.package_id,
          unresolved: !prepared.world.ok,
          timings
        },
        "flag created"
      );

    const result: CreateFlagResult = {
      flag: rowToFlag(row, prepared.ownerColor, prepared.ownerUsername),
      ...(masteryGrant ? { masteryGrant } : {}),
      ...(materialsRefunded ? { materialsRefunded: true } : {}),
      ...(inventory ? { inventory } : {}),
      ...(activationJobKey ? { activationJobKey } : {}),
      ...(flagSetRevision === undefined ? {} : { flagSetRevision }),
      replayed: false,
      timings
    };
    if (prepared.warning) {
      result.warning = prepared.warning;
    }
    return result;
  }

  private async nextDefaultAnchorName(
    ownerId: string,
    anchorKind: PersonalAnchorKind
  ): Promise<string> {
    const result = await this.pool.query<{ name: string }>(
      "SELECT name FROM flags WHERE owner_id = $1 ORDER BY created_at ASC",
      [ownerId]
    );
    return nextDefaultAnchorName(result.rows.map(({ name }) => name), anchorKind);
  }

  private async assertFlagPlacementAllowed(player: PlayerRecord): Promise<void> {
    await this.assertFlagPlacementAllowedAt(player.playerId, player.position.lat, player.position.lon);
  }

  private async assertFlagPlacementAllowedAt(
    playerId: string,
    lat: number,
    lon: number,
    queryable: Pick<pg.Pool | pg.PoolClient, "query"> = this.pool
  ): Promise<void> {
    if (!isWithinWorldEdge({ lat, lon })) {
      throw new FlagPlacementError(WORLD_EDGE_MESSAGE, WORLD_EDGE_ERROR_CODE);
    }
    const result = await queryable.query<{
      id: string;
      owner_id: string;
      owner_username: string | null;
      name: string;
    }>(
      `WITH query_point AS (
         SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS geog
       )
       SELECT flag.id, flag.owner_id, player.username AS owner_username, flag.name
       FROM flags flag
       LEFT JOIN players player ON player.id = flag.owner_id
       CROSS JOIN query_point
       WHERE ST_DWithin(
         flag.geom::geography,
         query_point.geog,
         $3
       )
         AND ST_DWithin(
           flag.geom::geography,
           query_point.geog,
           flag.claim_radius_m + $4
         )
       ORDER BY flag.id
       LIMIT 1`,
      [lon, lat, MAX_FLAG_CLAIM_RADIUS_M + TERRITORY_EDGE_TOLERANCE_M, TERRITORY_EDGE_TOLERANCE_M]
    );
    const covering = result.rows[0];
    if (covering) {
      const message = covering.owner_id === playerId
        ? "Cannot build here: inside your claimed territory"
        : covering.owner_username
          ? `Cannot build here: inside ${covering.owner_username}'s claimed territory`
          : "Cannot build here: inside claimed territory";
      throw new FlagPlacementError(message);
    }
  }

  private async listTerritoryCandidates(
    lat: number,
    lon: number,
    queryable: Pick<pg.Pool | pg.PoolClient, "query"> = this.pool,
    lockCandidates = false
  ): Promise<TerritoryFlag[]> {
    const result = await queryable.query<TerritoryCandidateRow>(
      `
      WITH query_point AS (
        SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS geog
      ), covering AS (
        SELECT f.id, f.owner_id, p.username AS owner_username,
               COALESCE(personal_flag_color_hex(p.personal_flag_color), $3) AS owner_color,
               f.name, f.lat, f.lon, f.claim_radius_m,
               ST_Distance(f.geom::geography, query_point.geog) AS distance_m,
               true AS is_covering
        FROM flags f
        LEFT JOIN players p ON p.id = f.owner_id
        CROSS JOIN query_point
        WHERE ST_DWithin(f.geom::geography, query_point.geog, $4)
          AND ST_DWithin(
            f.geom::geography,
            query_point.geog,
            f.claim_radius_m + $5
          )
          -- A collapsing city / kingdom flag no longer claims territory.
          AND f.territory_collapse_id IS NULL
        ORDER BY distance_m ASC, f.id ASC
        LIMIT $6
        ${lockCandidates ? "FOR SHARE OF f" : ""}
      ), nearest AS (
        SELECT candidate.id, candidate.owner_id, p.username AS owner_username,
               COALESCE(personal_flag_color_hex(p.personal_flag_color), $3) AS owner_color,
               candidate.name, candidate.lat, candidate.lon, candidate.claim_radius_m,
               candidate.distance_m,
               false AS is_covering
        FROM query_point
        CROSS JOIN LATERAL (
          SELECT f.*,
                 ST_Distance(f.geom::geography, query_point.geog) AS distance_m
          FROM flags f
          WHERE f.territory_collapse_id IS NULL
          ORDER BY f.geom::geography <-> query_point.geog ASC
          LIMIT 1
        ) candidate
        LEFT JOIN players p ON p.id = candidate.owner_id
      )
      SELECT * FROM covering
      UNION ALL
      SELECT * FROM nearest
      ORDER BY distance_m ASC, id ASC
      `,
      [
        lon,
        lat,
        DEFAULT_FLAG_COLOR,
        MAX_FLAG_CLAIM_RADIUS_M,
        TERRITORY_EDGE_TOLERANCE_M,
        MAX_TERRITORY_COVERING_FLAGS + 1
      ]
    );
    const coveringCount = result.rows.filter((row) => row.is_covering === true).length;
    if (coveringCount > MAX_TERRITORY_COVERING_FLAGS) {
      throw new Error(
        `Territory candidate safety bound exceeded (${coveringCount} covering flags)`
      );
    }
    const unique = new Map<string, TerritoryCandidateRow>();
    for (const row of result.rows) {
      if (!unique.has(row.id)) unique.set(row.id, row);
    }
    return [...unique.values()].map(rowToTerritoryFlag);
  }

  private assertWorldLookupPlaceable(
    world: WorldLookupResult,
    anchorKind: PersonalAnchorKind = "flag"
  ): void {
    if (anchorKind === "flag" && classifyFlagPlacementTerrain(world) === "water") {
      if (world.waterKind === "river") {
        throw new FlagPlacementError("Cannot build on river water.");
      }
      throw new FlagPlacementError("Cannot place flag on water");
    }
    if (anchorKind === "flag") return;
    if (!world.ok || world.surfaceKind !== "water" || world.isLand !== false) {
      throw new FlagPlacementError("Buoys require authoritative water.");
    }
    if (world.waterKind === "river") {
      if (!canonicalSurfaceMatches(world.riverSurface, WORLD_RUNTIME_CONTRACT.riverSurface, "isRiver")) {
        throw new FlagPlacementError("River authority is unavailable for this buoy location.");
      }
      return;
    }
    if (world.waterKind === "lake") {
      if (!canonicalSurfaceMatches(world.lakeSurface, WORLD_RUNTIME_CONTRACT.lakeSurface, "isLake")) {
        throw new FlagPlacementError("Lake authority is unavailable for this buoy location.");
      }
      return;
    }
    if (world.waterKind === "ocean") {
      if (!canonicalSurfaceIdentityMatches(
        world.oceanCoastSurface,
        WORLD_RUNTIME_CONTRACT.oceanCoastSurface
      ) || world.isSaltwater !== true) {
        throw new FlagPlacementError("Ocean authority is unavailable for this buoy location.");
      }
      return;
    }
    throw new FlagPlacementError("This water kind does not support buoys.");
  }

  private async insertFlag(input: {
    id: string;
    anchorKind: PersonalAnchorKind;
    ownerId: string;
    name: string;
    lat: number;
    lon: number;
    world: WorldLookupResult;
    reinforcementLevel?: number;
    developerTestTarget?: boolean;
    accessMode?: "private" | "public" | "normal";
    claimRadiusM?: number;
  }, queryable: Pick<pg.Pool | pg.PoolClient, "query"> = this.pool): Promise<FlagRow> {
    const environment = prepareFlagEnvironmentPersistence(input.world);
    // Buoys share the soft base profile (220 HP, burns in under 15 s).
    const initialHealth = structureWarfareHealthForReinforcementLevel(
      input.anchorKind === "flag" ? input.reinforcementLevel ?? 0 : 0
    );
    let result: pg.QueryResult<FlagRow>;
    try {
      const preference = await queryable.query<{
        access_mode: "private" | "public" | "normal";
        jump_toll_gold: string;
      }>(
        `SELECT preference.default_flag_access_mode AS access_mode,
                CASE preference.default_flag_access_mode
                  WHEN 'public' THEN preference.default_public_toll_gold::text
                  WHEN 'normal' THEN preference.default_normal_toll_gold::text
                  ELSE '0'
                END AS jump_toll_gold
         FROM player_flag_preferences preference
         WHERE preference.owner_player_id = $1`,
        [input.ownerId]
      );
      const defaults = preference.rows[0] ?? {
        access_mode: "private" as const,
        jump_toll_gold: "0"
      };
      // The owner's chosen mode applies whether or not they are Settled
      // (owner decision 2026-10-15).
      const accessMode = input.accessMode ?? defaults.access_mode;
      const jumpTollGold = input.accessMode === "normal"
        ? "0"
        : defaults.jump_toll_gold;
      result = await queryable.query<FlagRow>(
        `
      INSERT INTO flags (
        id, anchor_kind, owner_id, name, lat, lon, package_id, elevation_m, terrain_class,
        biome, ecoregion, claim_radius_m, resource_vision_radius_m, environment_snapshot, geom,
        access_mode, jump_toll_gold, reinforcement_level, developer_test_target,
        health, maximum_health
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14::jsonb, ST_SetSRID(ST_MakePoint($6, $5), 4326),
        $15, $16, $17::smallint, $18::boolean,
        CASE WHEN $2 = 'flag' THEN $19::smallint ELSE NULL END,
        CASE WHEN $2 = 'flag' THEN $19::smallint ELSE NULL END
      )
      RETURNING id, anchor_kind, control_type, owner_id, name, lat, lon, package_id, elevation_m, terrain_class,
                biome, ecoregion, claim_radius_m, resource_vision_radius_m, city_id,
                reinforcement_level, tower_level, obelisk_level, war_structure_kind, war_id, kingdom_id, access_mode, jump_toll_gold::text,
                access_revision::text, health, maximum_health,
                burning_started_at, burning_until, burning_reason, created_at
        `,
        [
          input.id,
          input.anchorKind,
          input.ownerId,
          input.name,
          input.lat,
          input.lon,
          environment.packageId,
          environment.elevationM,
          environment.terrainClass,
          environment.biome,
          environment.ecoregion,
          input.claimRadiusM ?? this.config.FLAG_CLAIM_RADIUS_M,
          this.config.FLAG_RESOURCE_VISION_RADIUS_M,
          environment.snapshotJson,
          accessMode,
          jumpTollGold,
          input.reinforcementLevel ?? 0,
          input.developerTestTarget ?? false,
          initialHealth ?? STRUCTURE_WARFARE_BASE_HEALTH
        ]
      );
    } catch (error) {
      if (isDatabaseFlagPlacementConflict(error)) {
        throw new FlagPlacementError("Cannot build here: inside claimed territory");
      }
      throw error;
    }
    const row = result.rows[0];
    if (!row) {
      throw new Error("flag insert did not return a row");
    }
    return row;
  }
}

export async function flagSetRevisionMetadata(
  service: FlagService
): Promise<Readonly<{ flagSetRevision?: number }>> {
  const readRevision = (
    service as Partial<Pick<FlagService, "currentFlagSetRevision">>
  ).currentFlagSetRevision;
  return typeof readRevision === "function"
    ? { flagSetRevision: await readRevision.call(service) }
    : {};
}

function serverRoll(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 4_294_967_296;
}

export function adjustedFlagBuildDuration(baseDurationMs: number, builderRank: number): number {
  const effects = professionEffects("builder", builderRank) as {
    generalSpeedBonus: number;
    flagSpeedBonus: number;
  };
  return Math.max(
    1,
    Math.ceil(baseDurationMs * (1 - effects.generalSpeedBonus - effects.flagSpeedBonus))
  );
}

export function builderRefundChance(builderRank: number): number {
  return builderRank >= 8 ? 0.03 : builderRank >= 6 ? 0.02 : builderRank >= 3 ? 0.01 : 0;
}

function worldReleaseId(world: WorldLookupResult): string | null {
  return world.worldReleaseId ?? world.release?.releaseId ?? null;
}

function publicPlacementQuote(quote: StoredFlagPlacementQuote): FlagPlacementQuote {
  return {
    quoteId: quote.quoteId,
    anchorKind: quote.anchorKind,
    position: quote.position,
    movementRevision: quote.movementRevision,
    relocationRevision: quote.relocationRevision,
    worldReleaseId: quote.worldReleaseId,
    materialAffordable: quote.materialAffordable,
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt
  };
}

function isDatabaseFlagPlacementConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const postgres = error as { code?: unknown; constraint?: unknown };
  return postgres.code === "23514" && [
    "flags_center_outside_existing_claim"
  ].includes(String(postgres.constraint));
}

export function nextDefaultFlagName(existingNames: string[]): string {
  return nextDefaultAnchorName(existingNames, "flag");
}

export function nextDefaultAnchorName(
  existingNames: string[],
  anchorKind: PersonalAnchorKind
): string {
  const usedIndexes = new Set<number>();
  const prefix = anchorKind === "buoy" ? "Buoy" : "Flag";
  for (const name of existingNames) {
    const match = new RegExp(`^${prefix} ([1-9]\\d*)$`).exec(name.trim());
    if (match) {
      usedIndexes.add(Number(match[1]));
    }
  }
  let index = 1;
  while (usedIndexes.has(index)) {
    index += 1;
  }
  return `${prefix} ${index}`;
}

function placementQuoteOwnerKey(playerId: string, anchorKind: PersonalAnchorKind): string {
  return `${playerId}:${anchorKind}`;
}

function placementQuoteBindingKey(
  player: PlayerRecord,
  requiredReleaseId: string,
  anchorKind: PersonalAnchorKind
): string {
  return [
    player.playerId,
    anchorKind,
    player.position.lat,
    player.position.lon,
    player.movementRevision,
    player.relocationRevision ?? 0,
    player.regionCode,
    requiredReleaseId
  ].join(":");
}

type CanonicalSurfaceIdentity = Readonly<{
  cellSizeM: number;
  sourceReleaseId: string;
  sourceManifestSha256: string;
}>;

type RequiredCanonicalSurfaceIdentity = Readonly<{
  cellSizeM: number;
  releaseId: string;
  manifestSha256: string;
}>;

function canonicalSurfaceIdentityMatches(
  surface: CanonicalSurfaceIdentity | null | undefined,
  required: RequiredCanonicalSurfaceIdentity
): boolean {
  return Boolean(
    surface &&
    surface.cellSizeM === required.cellSizeM &&
    surface.sourceReleaseId === required.releaseId &&
    surface.sourceManifestSha256 === required.manifestSha256
  );
}

function canonicalSurfaceMatches(
  surface: (CanonicalSurfaceIdentity & Record<string, unknown>) | null | undefined,
  required: RequiredCanonicalSurfaceIdentity,
  membershipKey: "isRiver" | "isLake"
): boolean {
  return canonicalSurfaceIdentityMatches(surface, required) && surface?.[membershipKey] === true;
}

function placementStageError(
  error: unknown,
  failureStage: FlagPlacementFailureStage,
  world?: WorldLookupResult
): FlagPlacementError {
  if (error instanceof FlagPlacementError) {
    return new FlagPlacementError(
      error.message,
      error.code,
      error.retryable,
      error.retryAfterMs,
      error.world ?? world,
      error.quoteDiagnostic,
      failureStage,
      safePlacementErrorClass(error)
    );
  }
  return new FlagPlacementError(
    "Flag preparation is temporarily unavailable.",
    "FLAG_PREPARATION_FAILED",
    true,
    150,
    world,
    undefined,
    failureStage,
    safePlacementErrorClass(error)
  );
}

function safePlacementErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error";
}

function playerPersonalFlagColor(
  player: Pick<PlayerRecord, "personalFlagColor" | "displayColor">
): string {
  return personalFlagColorHex(player.personalFlagColor ?? "blue");
}

function rowToFlag(
  row: FlagRow,
  fallbackOwnerColor = DEFAULT_FLAG_COLOR,
  fallbackOwnerUsername?: string
): FlagSnapshot {
  const cityControlled = row.control_type === "city" || row.control_type === "city_seat";
  const reinforcementLevel = Number(row.reinforcement_level ?? 0);
  const hasHealth = row.health !== null && row.health !== undefined &&
    row.maximum_health !== null && row.maximum_health !== undefined;
  const burningUntilMs = row.burning_until ? new Date(row.burning_until).getTime() : null;
  const isBurning = burningUntilMs !== null && burningUntilMs > Date.now();
  const currentHealth = hasHealth ? Number(row.health) : null;
  const flag: FlagSnapshot = {
    id: row.id,
    anchorKind: row.anchor_kind ?? "flag",
    controlType: row.control_type ?? "personal",
    ownerId: row.developer_test_owner_id ?? row.owner_id,
    ownerColor: row.control_type === "city" || row.control_type === "city_seat"
      ? row.presentation_color ?? CITY_FLAG_COLOR
      : row.owner_color ?? fallbackOwnerColor,
    presentationColor: row.presentation_color ?? null,
    systemControlled: row.system_controlled ?? false,
    name: row.name,
    lat: Number(row.lat),
    lon: Number(row.lon),
    packageId: row.package_id,
    elevationM: row.elevation_m === null ? null : Number(row.elevation_m),
    terrainClass: row.terrain_class,
    biome: row.biome,
    ecoregion: row.ecoregion,
    claimRadiusM: Number(row.claim_radius_m),
    resourceVisionRadiusM: Number(row.resource_vision_radius_m),
    accessMode: row.access_mode ?? "private",
    jumpTollGold: row.jump_toll_gold ?? "0",
    accessRevision: row.access_revision ?? "0",
    cityId: row.city_id ?? null,
    reinforcementLevel,
    upgradeTier: flagUpgradeTier(reinforcementLevel),
    towerLevel: row.tower_level === null || row.tower_level === undefined ? null : Number(row.tower_level),
    obeliskLevel: row.obelisk_level === null || row.obelisk_level === undefined ? null : Number(row.obelisk_level),
    ...(row.war_structure_kind === "war_tower" || row.war_structure_kind === "war_outpost"
      ? { warStructureKind: row.war_structure_kind, warId: row.war_id ?? null }
      : {}),
    ...(row.developer_test_target === true ? { developerTestTarget: true } : {}),
    ...(currentHealth !== null
      ? { health: currentHealth }
      : {}),
    ...(hasHealth
      ? { maximumHealth: Number(row.maximum_health) }
      : {}),
    burning: isBurning,
    burningStartedAt: row.burning_started_at ? new Date(row.burning_started_at).toISOString() : null,
    burningUntil: row.burning_until ? new Date(row.burning_until).toISOString() : null,
    legendaryBirdSpecies: row.legendary_bird_species ?? null,
    atlasShrineSlotNumber: row.atlas_shrine_slot_number === null ||
      row.atlas_shrine_slot_number === undefined
      ? null
      : Number(row.atlas_shrine_slot_number),
    kingdomId: row.kingdom_id ?? null,
    kingdomName: row.kingdom_name ?? null,
    kingdomEmblemKey: row.kingdom_emblem_key ?? null,
    kingdomColor: row.kingdom_color ?? null,
    kingdomSeatId: row.kingdom_seat_id ?? null,
    kingdomSeatConstructionState: row.kingdom_seat_construction_state ?? null,
    kingdomSeatLat: row.kingdom_seat_lat === null || row.kingdom_seat_lat === undefined
      ? null
      : Number(row.kingdom_seat_lat),
    kingdomSeatLon: row.kingdom_seat_lon === null || row.kingdom_seat_lon === undefined
      ? null
      : Number(row.kingdom_seat_lon),
    kingdomAffiliatedAt: row.kingdom_affiliated_at
      ? new Date(row.kingdom_affiliated_at).toISOString()
      : null,
    originalOwnerPlayerId: cityControlled ? null : row.original_owner_player_id ?? null,
    contributedByPlayerId: cityControlled ? null : row.contributed_by_player_id ?? null,
    contributedByUsername: cityControlled ? null : row.contributed_by_username ?? null,
    originalPersonalColor: cityControlled ? null : row.original_personal_color ?? null,
    createdAt: row.created_at.toISOString()
  };
  const ownerUsername = row.developer_test_owner_name ?? row.owner_username ?? fallbackOwnerUsername;
  if (ownerUsername && !cityControlled) {
    flag.ownerUsername = ownerUsername;
  }
  return flag;
}

type TowerUpgradeTargetRow = {
  control_type: NonNullable<FlagRow["control_type"]>;
  anchor_kind: PersonalAnchorKind;
  owner_id: string;
  city_id: string | null;
  kingdom_id: string | null;
  reinforcement_level: number;
  tower_level: number | null;
  obelisk_level?: number | null;
  war_structure_kind?: string | null;
  health: number | null;
  burning_until: Date | string | null;
  burning_reason: string | null;
  territory_collapse_id: string | null;
};

async function lockTowerUpgradeTarget(client: pg.PoolClient, flagId: string): Promise<TowerUpgradeTargetRow> {
  const locked = await client.query<TowerUpgradeTargetRow>(
    `SELECT control_type,anchor_kind,owner_id,city_id::text,kingdom_id::text,reinforcement_level,
            tower_level,obelisk_level,war_structure_kind,health,burning_until,burning_reason,territory_collapse_id::text
     FROM flags WHERE id=$1 FOR UPDATE`,
    [flagId]
  );
  const row = locked.rows[0];
  if (!row) throw new AtlasShrineError("FLAG_NOT_FOUND", "Flag does not exist");
  if (row.anchor_kind !== "flag") {
    throw new AtlasShrineError("FLAG_TIER_UNSUPPORTED", "Buoys cannot be reinforced or converted");
  }
  return row;
}

/**
 * Checks that a locked or read flag row can take `kind` at `targetLevel`
 * and returns its kingdom id.
 */
function assertKingdomStructureTarget(
  row: TowerUpgradeTargetRow,
  kind: KingdomStructureKind,
  targetLevel: number
): string {
  if (row.anchor_kind !== "flag" || row.control_type !== "kingdom" || !row.kingdom_id || row.city_id !== null ||
      (row.war_structure_kind ?? null) !== null) {
    throw new AtlasShrineError(
      "FLAG_KINGDOM_STRUCTURE_FLAG_REQUIRED",
      "Only a Kingdom Flag can become an Obelisk or Kingdom Tower"
    );
  }
  const current = kind === "obelisk" ? row.obelisk_level ?? null : row.tower_level ?? null;
  const other = kind === "obelisk" ? row.tower_level ?? null : row.obelisk_level ?? null;
  if (other !== null) {
    throw new AtlasShrineError(
      "FLAG_KINGDOM_STRUCTURE_OCCUPIED",
      kind === "obelisk" ? "This Kingdom Flag is already a Kingdom Tower" : "This Kingdom Flag is already an Obelisk"
    );
  }
  const currentLevel = current === null ? 0 : Number(current);
  if (currentLevel !== targetLevel - 1) {
    throw new AtlasShrineError(
      "FLAG_KINGDOM_STRUCTURE_LEVEL_CHANGED",
      currentLevel >= targetLevel ? `This structure is already level ${currentLevel}` : `Build level ${currentLevel + 1} first`
    );
  }
  return String(row.kingdom_id);
}

/** The builder must be an active member of an active kingdom with the build permission (the leader). */
/**
 * A kingdom over its structure cap (members went inactive) keeps every
 * standing structure but cannot build Obelisk or Kingdom Tower levels until
 * it is back within the cap.
 */
async function assertKingdomWithinStructureCapacity(queryable: Pick<pg.Pool | pg.PoolClient, "query">, kingdomId: string): Promise<void> {
  const capacity = await kingdomStructureCapacitySnapshot(queryable, kingdomId);
  if (capacity.used > capacity.capacity) {
    throw new AtlasShrineError("FLAG_KINGDOM_STRUCTURE_CAPACITY_REACHED", kingdomCapacityMessage(capacity));
  }
}

async function assertKingdomStructureBuilder(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string,
  kingdomId: string
): Promise<void> {
  const result = await queryable.query<{ role: KingdomRole; status: string; castle_ruined: boolean }>(
    `SELECT membership.role, kingdom.status, kingdom.castle_ruined_at IS NOT NULL AS castle_ruined
     FROM kingdom_memberships membership
     JOIN kingdoms kingdom ON kingdom.id = membership.kingdom_id
     WHERE membership.player_id=$1 AND membership.kingdom_id=$2 AND membership.status='active'`,
    [playerId, kingdomId]
  );
  const row = result.rows[0];
  if (!row || row.status !== "active") {
    throw new AtlasShrineError("FLAG_UPGRADE_FORBIDDEN", "Only members of this Kingdom can build here");
  }
  if (row.castle_ruined) {
    throw new AtlasShrineError("FLAG_KINGDOM_CASTLE_RUBBLE", "The Castle lies in rubble: the leader must rebuild it first");
  }
  if (!hasKingdomPermission(row.role, "build_kingdom_structures")) {
    throw new AtlasShrineError("FLAG_UPGRADE_FORBIDDEN", "Only the Kingdom leader can build Obelisks and Kingdom Towers");
  }
}

/** A tower is upgraded only while standing quietly: not burning, repairing, collapsing or destroyed. */
async function assertTowerUpgradeIdle(
  client: pg.PoolClient,
  row: TowerUpgradeTargetRow,
  flagId: string
): Promise<void> {
  if (row.territory_collapse_id !== null || row.health === null || Number(row.health) <= 0) {
    throw new AtlasShrineError("FLAG_UPGRADE_UNAVAILABLE", "This structure cannot be upgraded right now");
  }
  if (
    row.burning_reason !== null ||
    (row.burning_until !== null && new Date(row.burning_until).getTime() > Date.now()) ||
    await hasActiveRepair(client, flagId)
  ) {
    throw new AtlasShrineError("FLAG_UPGRADE_BURNING", "Finish the burn or repair before upgrading");
  }
}

async function towerUpgradeReplay(
  client: pg.PoolClient,
  operationKey: string,
  flagId: string,
  upgradeKind: "guard_tower_level" | "city_tower",
  toLevel: number
): Promise<boolean> {
  const prior = await client.query<{ flag_id: string; upgrade_kind: string; to_level: number }>(
    `SELECT flag_id::text,upgrade_kind,to_level
     FROM flag_tower_upgrade_operations WHERE operation_key=$1`,
    [operationKey]
  );
  const row = prior.rows[0];
  if (!row) return false;
  if (row.flag_id !== flagId || row.upgrade_kind !== upgradeKind || Number(row.to_level) !== toLevel) {
    throw new AtlasShrineError("FLAG_UPGRADE_IDEMPOTENCY_CONFLICT", "This upgrade request was already used");
  }
  return true;
}

function flagUpgradeTier(level: number): FlagUpgradeTier {
  if (level === 3) return "tower";
  if (level === 2) return "atlas_shrine";
  if (level === 1) return "stone";
  return "base";
}

function developerTestFlagTarget(kind: DeveloperTestFlagKind): Readonly<{
  name: string;
  reinforcementLevel: 0 | 1 | 3;
}> {
  switch (kind) {
    case "soft_flag":
      return { name: "Test Soft Flag", reinforcementLevel: 0 };
    case "bastion_flag":
      return { name: "Test Bastion Flag", reinforcementLevel: 1 };
    case "tower":
      return { name: "Test Tower", reinforcementLevel: 3 };
    default:
      throw new FlagPlacementError(
        "That developer test flag target is unavailable.",
        "DEV_FLAG_SPAWN_INVALID_TARGET"
      );
  }
}

function rowToTerritoryFlag(row: TerritoryCandidateRow): TerritoryFlag {
  const flag: TerritoryFlag = {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    lat: Number(row.lat),
    lon: Number(row.lon),
    claimRadiusM: Number(row.claim_radius_m)
  };
  if (row.owner_username) {
    flag.ownerUsername = row.owner_username;
  }
  if (row.owner_color) {
    flag.ownerColor = row.owner_color;
  }
  return flag;
}
