import {
  COLLECTIBLE_PICKUP_RADIUS_M,
  UTILITY_GEAR_ACTION_DURATION_MS,
  isUtilityGearDefinitionId,
  type UtilityGearDefinitionId,
  applyRingSecondsToDuration,
  distanceMeters,
  type DroppedItemSnapshot,
  type MasteryGrantResult,
  type HarvestSessionSnapshot,
  type LatLon,
  type PlayerInventorySnapshot,
  type RepeatableResourceNode,
  type ResourceType,
  type ResourceVision
} from "@ash-atlas/shared";
import type pg from "pg";

import {
  InventoryCapacityError,
  isInventoryCapacityError,
  InventoryService
} from "./inventory.js";
import {
  createPhysicalRewardOverflowDropsInTransaction,
  settlePhysicalItemRewardInTransaction
} from "./droppedItems.js";
import type { CollectiblePlayer } from "./collectibles.js";
import type { MasteryService } from "./masteries.js";
import { CityDistrictBenefitService } from "./cityDistrictBenefits.js";
import { WalletOperationError, WalletService } from "./wallet.js";
import {
  permanentResourceYield,
  PermanentResourceLifecycleService,
  STONE_MINE_REGENERATION_MS,
  type PermanentResourceNodeRow as RepeatableNodeRow
} from "./permanentResourceLifecycle.js";
import { packageIdForPosition, zoneIdForPosition } from "./spatialZones.js";

export { STONE_MINE_REGENERATION_MS };
export const STONE_MINE_DURATION_MS = 30_000;
export const MINING_SESSION_EXPIRY_GRACE_MS = 5 * 60_000;

export type RepeatableMineAuthorityFailureReason =
  | "projection-harvest-revision-changed"
  | "canonical-state-revision-mismatch"
  | "canonical-state-not-ready"
  | "projection-suppressed"
  | "projection-canonical-entity-mismatch"
  | "projection-plan-cutover-mismatch"
  | "projection-definition-mismatch"
  | "canonical-lifecycle-invalid";

type RepeatableSessionRow = {
  id: string;
  player_id: string;
  node_id: string;
  resource_type: ResourceType;
  operation_key: string;
  starting_revision: number | string;
  status: "active" | "completed" | "cancelled" | "expired";
  effective_duration_ms: number | string;
  started_at: Date | string;
  completes_at: Date | string;
  expires_at: Date | string;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  database_now?: Date | string;
  mastery_results: { bonusYield?: boolean; instant?: boolean; unbrokenVein?: boolean; bonusExtraction?: boolean; utilityGlove?: string };
  city_id: string | null;
  city_district_type: "mining" | null;
  city_district_revision: string | null;
  city_monument_tier: 1 | 2 | 3 | null;
  city_bonus_chance: number;
  city_bonus_succeeded: boolean;
  quoted_owner_player_id: string | null;
  quoted_access_mode: "private" | "public" | null;
  quoted_toll_gold: number | string;
  quoted_access_revision: number | string;
  quoted_toll_revision: number | string;
};

export type RepeatableMiningStartResult = {
  session: HarvestSessionSnapshot;
  /** The mine; null on a replay. */
  nodePosition?: LatLon | null;
  replayed: boolean;
};

export type MineClaimResult = {
  node: RepeatableResourceNode;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
};

export type RepeatableHarvestResult = {
  session: HarvestSessionSnapshot;
  node: RepeatableResourceNode;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
  masteryGrant: MasteryGrantResult | null;
  droppedItems: DroppedItemSnapshot[];
  professionResults: { bonusYield: boolean; instant: boolean; unbrokenVein: boolean };
  rewardQuantity: number;
  tollGold: string;
  walletGold: string | null;
  walletRevision: string | null;
  diagnostics: Readonly<{
    startingHarvestRevision: number;
    completionHarvestRevision: number;
    startingCanonicalStateRevision: number;
    completionCanonicalStateRevision: number;
    inventoryRevisionBefore: number;
    inventoryRevisionAfter: number;
    inventoryOperation: "applied" | "replayed";
    cityBonusYield: number;
  }>;
};

export type RepeatableCompletionFailureDisposition =
  | "retryable"
  | "terminal-cancelled"
  | "terminal-expired"
  | "internal";

export type RepeatableTerminalCleanupResult = Readonly<{
  sessionId: string;
  nodeId: string | null;
  statusBefore: RepeatableSessionRow["status"] | null;
  statusAfter: RepeatableSessionRow["status"] | null;
  outcome: "cancelled" | "expired" | "already-terminal" | "completed" | "not-found";
}>;

export function repeatableCompletionFailureDisposition(
  code: string
): RepeatableCompletionFailureDisposition {
  switch (code) {
    case "HARVEST_TOO_EARLY":
      return "retryable";
    case "HARVEST_EXPIRED":
      return "terminal-expired";
    case "HARVEST_NODE_CHANGED":
    case "HARVEST_NODE_NOT_FOUND":
    case "HARVEST_NODE_NOT_VISIBLE":
    case "HARVEST_NODE_OUT_OF_RANGE":
    case "HARVEST_NODE_DEPLETED":
    case "HARVEST_INVENTORY_FULL":
    case "HARVEST_CANCELLED":
    case "HARVEST_PLAYER_UNAVAILABLE":
    case "HARVEST_RESOURCE_VISION_REQUIRED":
      return "terminal-cancelled";
    default:
      return "internal";
  }
}

export type DeveloperPermanentMine = {
  id: string;
  lat: number;
  lon: number;
  state: "ready" | "depleted";
  canonicalState: "ready" | "harvested" | "dead" | "missing";
  canonicalLifecycleValid: boolean;
  projectionState: "ready" | "depleted";
  canonicalRevision: number | null;
  projectionRevision: number;
  harvestRevision: number;
  lifecycleMismatch: boolean;
  readyAt: string | null;
  remainingMs: number;
  placementBucketKey: string;
  placementVersion: string;
  regionCode: string;
  worldPackageId: string | null;
  worldEcoregion: string | null;
  coveringFlag: { id: string; name: string; distanceM: number } | null;
  coveringFlagCount: number;
};

export type DeveloperMineVisitTarget = {
  mineId: string;
  minePosition: { lat: number; lon: number };
  flag: {
    id: string;
    name: string;
    center: { lat: number; lon: number };
    claimRadiusM: number;
    resourceVisionRadiusM: number;
  } | null;
};

import {
  UTILITY_GEAR_GONE_MESSAGE,
  spendUtilityGearUseInTransaction,
  wornUtilityGearReady,
  type UtilityGearHooks
} from "./utilityGear.js";

export class RepeatableResourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
    readonly details: Readonly<{
      nodeId?: string;
      stateRevision?: number;
      populationV2StateRevision?: number;
      authoritativeDistanceM?: number;
      reconciliation?: "remove-node" | "refresh-node";
      authorityFailureReason?: RepeatableMineAuthorityFailureReason;
      startingHarvestRevision?: number;
      completionHarvestRevision?: number;
      projectionStateRevision?: number;
      canonicalStateRevision?: number;
      canonicalState?: "ready" | "harvested" | "dead";
      currentWeightGrams?: string;
      maximumWeightGrams?: string;
      availableWeightGrams?: string;
      requestedYield?: number;
    }> = {}
  ) {
    super(message);
    this.name = "RepeatableResourceError";
  }
}

export class RepeatableResourceService {
  private readonly inventory: InventoryService;
  private readonly lifecycle: PermanentResourceLifecycleService;
  private readonly districtBenefits: CityDistrictBenefitService;
  private readonly wallet: WalletService;
  private utilityGear: UtilityGearHooks | null = null;

  /** Refreshes the equipment runtime and the client after a utility glove spent a use. */
  setUtilityGear(hooks: UtilityGearHooks): void {
    this.utilityGear = hooks;
  }

  constructor(
    private readonly pool: pg.Pool,
    inventory?: InventoryService,
    private readonly masteries?: MasteryService,
    private readonly roll: () => number = serverRoll,
    lifecycle?: PermanentResourceLifecycleService
  ) {
    this.inventory = inventory ?? new InventoryService(pool);
    this.lifecycle =
      lifecycle ?? new PermanentResourceLifecycleService(pool);
    this.districtBenefits = new CityDistrictBenefitService(pool);
    this.wallet = new WalletService(pool);
  }

  async listDeveloperMines(input: {
    search?: string | undefined;
    state?: "all" | "ready" | "depleted";
    page?: number;
    limit?: number;
  } = {}): Promise<{ mines: DeveloperPermanentMine[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 25)));
    await this.lifecycle.convergeForDiagnostics(
      Math.max(limit, MAX_DEVELOPER_MINE_CONVERGENCE)
    );
    const state = input.state ?? "all";
    const search = input.search?.trim() ?? "";
    const values = [state, search, limit, (page - 1) * limit];
    const result = await this.pool.query<{
      id: string; lat: number | string; lon: number | string; public_state: "ready" | "depleted";
      canonical_state: "ready" | "harvested" | "dead" | null;
      canonical_lifecycle_valid: boolean;
      projection_state: "ready" | "depleted";
      canonical_revision: number | string | null;
      projection_revision: number | string;
      harvest_revision: number | string;
      lifecycle_mismatch: boolean;
      ready_at: Date | string | null; remaining_ms: number | string; placement_bucket_key: string;
      placement_version: string; region_code: string; world_package_id: string | null;
      world_ecoregion: string | null; covering_flag_id: string | null; covering_flag_name: string | null;
      covering_flag_distance_m: number | string | null; covering_flag_count: number | string; total_count: number | string;
    }>(
      `SELECT n.id::text, n.lat, n.lon,
              CASE WHEN canonical.state='ready'
                THEN 'ready' ELSE 'depleted' END AS public_state,
              canonical.state AS canonical_state,
              COALESCE((
                (
                  canonical.state='ready'
                  AND canonical.state_actor_player_id IS NULL
                  AND canonical.killed_or_harvested_at IS NULL
                  AND canonical.respawn_at IS NULL
                )
                OR
                (
                  canonical.state='harvested'
                  AND canonical.killed_or_harvested_at IS NOT NULL
                  AND canonical.respawn_at IS NOT NULL
                  AND canonical.respawn_at =
                      canonical.killed_or_harvested_at
                      + authority.regeneration_interval
                )
              ), false) AS canonical_lifecycle_valid,
              CASE WHEN n.ready_at <= clock_timestamp()
                THEN 'ready' ELSE 'depleted' END AS projection_state,
              canonical.state_revision AS canonical_revision,
              n.population_v2_state_revision AS projection_revision,
              n.harvest_revision,
              (
                canonical.entity_id IS NULL
                OR NOT (
                  (
                    canonical.state='ready'
                    AND canonical.state_actor_player_id IS NULL
                    AND canonical.killed_or_harvested_at IS NULL
                    AND canonical.respawn_at IS NULL
                  )
                  OR
                  (
                    canonical.state='harvested'
                    AND canonical.killed_or_harvested_at IS NOT NULL
                    AND canonical.respawn_at IS NOT NULL
                    AND canonical.respawn_at =
                        canonical.killed_or_harvested_at
                        + authority.regeneration_interval
                  )
                )
                OR canonical.state_revision<>n.population_v2_state_revision
                OR canonical.state_revision<>n.harvest_revision
                OR n.ready_at IS DISTINCT FROM CASE
                  WHEN canonical.state='ready' THEN '-infinity'::timestamptz
                  ELSE canonical.respawn_at
                END
              ) AS lifecycle_mismatch,
              canonical.respawn_at AS ready_at,
              CASE WHEN canonical.state='ready' THEN 0
                   ELSE GREATEST(0, EXTRACT(EPOCH FROM (
                     canonical.respawn_at - clock_timestamp()
                   )) * 1000)::bigint
              END AS remaining_ms,
              n.placement_bucket_key, n.placement_version, n.region_code,
              a.world_package_id, a.world_ecoregion,
              covering.id::text AS covering_flag_id, covering.name AS covering_flag_name,
              covering.distance_m AS covering_flag_distance_m,
              COALESCE(covering_counts.flag_count, 0) AS covering_flag_count,
              count(*) OVER() AS total_count
       FROM repeatable_resource_nodes n
       LEFT JOIN population_entity_state_v2 AS canonical
         ON canonical.entity_id=n.population_v2_entity_id
       LEFT JOIN population_permanent_resource_authority_v2 AS authority
         ON authority.entity_id=canonical.entity_id
       LEFT JOIN permanent_mine_allocation_buckets a ON a.mine_id = n.id
       LEFT JOIN LATERAL (
         SELECT f.id, f.name, ST_Distance(f.geom::geography, n.geom::geography) AS distance_m
         FROM flags f
         WHERE ST_DWithin(f.geom::geography, n.geom::geography, f.resource_vision_radius_m)
         ORDER BY distance_m ASC, f.id ASC LIMIT 1
       ) covering ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS flag_count FROM flags f
         WHERE ST_DWithin(f.geom::geography, n.geom::geography, f.resource_vision_radius_m)
       ) covering_counts ON true
       WHERE n.population_v2_entity_id IS NOT NULL
         AND ($1 = 'all' OR $1 = CASE WHEN canonical.state='ready'
           THEN 'ready' ELSE 'depleted' END)
         AND ($2 = '' OR n.id::text ILIKE '%' || $2 || '%'
           OR n.region_code ILIKE '%' || $2 || '%'
           OR COALESCE(a.world_package_id, '') ILIKE '%' || $2 || '%'
           OR COALESCE(a.world_ecoregion, '') ILIKE '%' || $2 || '%'
           OR (n.lat::text || ',' || n.lon::text) ILIKE '%' || $2 || '%')
       ORDER BY n.created_at DESC, n.id ASC LIMIT $3 OFFSET $4`,
      values
    );
    return {
      mines: result.rows.map((row) => ({
        id: row.id, lat: Number(row.lat), lon: Number(row.lon), state: row.public_state,
        canonicalState: row.canonical_state ?? "missing",
        canonicalLifecycleValid: row.canonical_lifecycle_valid,
        projectionState: row.projection_state,
        canonicalRevision:
          row.canonical_revision === null ? null : Number(row.canonical_revision),
        projectionRevision: Number(row.projection_revision),
        harvestRevision: Number(row.harvest_revision),
        lifecycleMismatch: row.lifecycle_mismatch,
        readyAt:
          row.public_state === "depleted" && row.ready_at !== null
            ? dateIso(row.ready_at)
            : null,
        remainingMs: Number(row.remaining_ms), placementBucketKey: row.placement_bucket_key,
        placementVersion: row.placement_version, regionCode: row.region_code,
        worldPackageId: row.world_package_id, worldEcoregion: row.world_ecoregion,
        coveringFlag: row.covering_flag_id && row.covering_flag_name
          ? { id: row.covering_flag_id, name: row.covering_flag_name, distanceM: Number(row.covering_flag_distance_m) }
          : null,
        coveringFlagCount: Number(row.covering_flag_count)
      })),
      total: Number(result.rows[0]?.total_count ?? 0), page, limit
    };
  }

  async developerMineVisitTarget(mineId: string): Promise<DeveloperMineVisitTarget | null> {
    const result = await this.pool.query<{
      mine_id: string; mine_lat: number | string; mine_lon: number | string;
      flag_id: string | null; flag_name: string | null; flag_lat: number | string | null;
      flag_lon: number | string | null; claim_radius_m: number | string | null;
      resource_vision_radius_m: number | string | null;
    }>(
      `SELECT n.id::text AS mine_id, n.lat AS mine_lat, n.lon AS mine_lon,
              covering.id::text AS flag_id, covering.name AS flag_name,
              covering.lat AS flag_lat, covering.lon AS flag_lon,
              covering.claim_radius_m, covering.resource_vision_radius_m
       FROM repeatable_resource_nodes n
       LEFT JOIN LATERAL (
         SELECT f.* FROM flags f
         WHERE ST_DWithin(f.geom::geography, n.geom::geography, f.resource_vision_radius_m)
         ORDER BY ST_Distance(f.geom::geography, n.geom::geography), f.id ASC LIMIT 1
       ) covering ON true
       WHERE n.id::text = $1
         AND n.population_v2_entity_id IS NOT NULL`,
      [mineId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      mineId: row.mine_id,
      minePosition: { lat: Number(row.mine_lat), lon: Number(row.mine_lon) },
      flag: row.flag_id && row.flag_name
        ? {
            id: row.flag_id, name: row.flag_name,
            center: { lat: Number(row.flag_lat), lon: Number(row.flag_lon) },
            claimRadiusM: Number(row.claim_radius_m),
            resourceVisionRadiusM: Number(row.resource_vision_radius_m)
          }
        : null
    };
  }

  async hasNode(nodeId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM repeatable_resource_nodes
       WHERE id::text = $1
         AND population_v2_entity_id IS NOT NULL`,
      [nodeId]
    );
    return result.rowCount === 1;
  }

  async hasSession(sessionId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM repeatable_resource_sessions WHERE id::text = $1",
      [sessionId]
    );
    return result.rowCount === 1;
  }

  async listInVision(
    _regionCode: string,
    vision: ResourceVision | null,
    playerId?: string
  ): Promise<RepeatableResourceNode[]> {
    return this.lifecycle.listInVision(vision, playerId);
  }

  async claimMine(
    player: CollectiblePlayer,
    nodeId: string,
    requestId: string,
    expectedAuthorityRevision: number
  ): Promise<MineClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ actor_player_id: string; node_id: string }>(
        `SELECT actor_player_id, node_id::text FROM repeatable_resource_claim_operations
         WHERE operation_key=$1`,
        [`mine-claim:${requestId}`]
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0].actor_player_id !== player.playerId
          || existing.rows[0].node_id !== nodeId
        ) {
          throw new RepeatableResourceError(
            "MINE_CLAIM_IDEMPOTENCY_CONFLICT",
            "Mine claim request ID was reused with different intent."
          );
        }
        const node = await this.lifecycle.nodeForPlayer(nodeId, player.playerId, client);
        if (!node || node.ownerPlayerId !== player.playerId) throw new Error("Completed mine claim is unavailable");
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { node, inventory, replayed: true };
      }
      const locked = await this.lifecycle.lockAndConvergeNode(client, nodeId);
      if (!locked || locked.authorityFailureReason) {
        throw new RepeatableResourceError("HARVEST_NODE_NOT_FOUND", "Mine not found.");
      }
      const row = locked.row;
      const authorityRevision = Number(row.population_v2_state_revision) * 2 + (row.public_state === "ready" ? 1 : 0);
      if (authorityRevision !== expectedAuthorityRevision) {
        throw new RepeatableResourceError("HARVEST_NODE_CHANGED", "This mine changed. Refresh and try again.");
      }
      if (distanceMeters(player.position, { lat: Number(row.lat), lon: Number(row.lon) }) > COLLECTIBLE_PICKUP_RADIUS_M) {
        throw new RepeatableResourceError("HARVEST_NODE_OUT_OF_RANGE", "Move closer to claim this mine.");
      }
      if (row.owner_player_id) {
        throw new RepeatableResourceError("MINE_ALREADY_CLAIMED", "This mine is already claimed.");
      }
      const operationKey = `mine-claim:${requestId}`;
      const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey,
        playerId: player.playerId,
        source: "repeatable_resource_claim",
        sourceEntityType: "repeatable_resource_node",
        sourceEntityId: nodeId,
        debits: [
          { itemId: "stone", variant: null, quantity: 3 },
          { itemId: "wood", variant: null, quantity: 10 }
        ],
        metadata: { accessMode: "private" }
      });
      const claimed = await client.query(
        `UPDATE repeatable_resource_nodes
         SET owner_player_id=$1, harvest_access_mode='private', claimed_at=clock_timestamp(),
             harvest_access_revision=harvest_access_revision+1
         WHERE id=$2::uuid AND owner_player_id IS NULL`,
        [player.playerId, nodeId]
      );
      if (claimed.rowCount !== 1) throw new RepeatableResourceError("MINE_ALREADY_CLAIMED", "This mine is already claimed.");
      await client.query(
        `INSERT INTO repeatable_resource_claim_operations
           (operation_key, request_id, node_id, actor_player_id, result, completed_at)
         VALUES ($1,$2,$3::uuid,$4,$5::jsonb,clock_timestamp())`,
        [operationKey, requestId, nodeId, player.playerId, JSON.stringify({ accessMode: "private" })]
      );
      const node = await this.lifecycle.nodeForPlayer(nodeId, player.playerId, client);
      if (!node) throw new Error("Claimed mine projection is unavailable");
      await client.query("COMMIT");
      return { node, inventory: debit.inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async startMining(
    player: CollectiblePlayer,
    nodeId: string,
    vision: ResourceVision | null,
    expectedAuthorityRevision?: number,
    actionDurationMultiplier = 1,
    miningDurationMultiplier = 1,
    /** Fleet miner ring: negative seconds off a mine. */
    miningRingSeconds = 0,
    utilityGlove: UtilityGearDefinitionId | null = null
  ): Promise<RepeatableMiningStartResult> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await expireSessions(client, player.playerId, nodeId);
      const active = await findActiveSession(client, player.playerId, nodeId);
      if (active) {
        if (active.player_id === player.playerId && active.node_id === nodeId) {
          await client.query("COMMIT");
          return { session: sessionSnapshot(active), replayed: true };
        }
        throw new RepeatableResourceError(
          "HARVEST_ALREADY_ACTIVE",
          active.player_id === player.playerId
            ? "Player already has an active gathering action"
            : "This stone mine is already being mined"
        );
      }

      const node = await this.lockAndValidateNode(
        client,
        player,
        nodeId,
        vision,
        true
      );
      const authorityRevision =
        Number(node.population_v2_state_revision) * 2 +
        (node.public_state === "ready" ? 1 : 0);
      if (
        expectedAuthorityRevision !== undefined &&
        authorityRevision !== expectedAuthorityRevision
      ) {
        await client.query("COMMIT");
        committed = true;
        throw new RepeatableResourceError(
          "HARVEST_NODE_CHANGED",
          `This ${mineLabel(node.node_type)} was refreshed. Mine it again.`,
          undefined,
          {
            nodeId: node.id,
            stateRevision: authorityRevision,
            populationV2StateRevision:
              Number(node.population_v2_state_revision),
            projectionStateRevision:
              Number(node.population_v2_state_revision),
            canonicalStateRevision:
              Number(node.population_v2_state_revision),
            canonicalState: node.public_state === "ready" ? "ready" : "harvested",
            authorityFailureReason: "canonical-state-revision-mismatch",
            reconciliation: "refresh-node"
          }
        );
      }
      await client.query(
        `INSERT INTO player_discovered_mines (player_id, node_id) VALUES ($1,$2::uuid) ON CONFLICT DO NOTHING`,
        [player.playerId, node.id]
      );
      const minerRank = this.masteries
        ? await this.masteries.professionRankInTransaction(client, player.playerId, "miner")
        : 0;
      let quotedOwnerPlayerId: string | null = null;
      let quotedAccessMode: "private" | "public" | null = null;
      let quotedTollGold = 0n;
      let quotedTollRevision = 0n;
      if (node.owner_player_id && node.owner_player_id !== player.playerId) {
        if (node.harvest_access_mode !== "public") {
          throw new RepeatableResourceError("MINE_PRIVATE", "This mine is private.");
        }
        const toll = await client.query<{ toll_gold: string; revision: string }>(
          `SELECT toll_gold::text, revision::text FROM player_harvest_toll_settings
           WHERE owner_player_id=$1 AND harvest_type=$2`,
          [node.owner_player_id, node.node_type]
        );
        quotedOwnerPlayerId = node.owner_player_id;
        quotedAccessMode = "public";
        quotedTollGold = BigInt(toll.rows[0]?.toll_gold ?? "0");
        quotedTollRevision = BigInt(toll.rows[0]?.revision ?? "0");
        if (quotedTollGold > 0n) {
          const account = await client.query<{ account_id: string }>(
            "SELECT account_id FROM players WHERE id=$1",
            [player.playerId]
          );
          const accountId = account.rows[0]?.account_id;
          if (!accountId) throw new Error("Mine toll payer account is unavailable");
          const wallet = await this.wallet.snapshotInTransaction(client, player.playerId, accountId);
          if (BigInt(wallet.gold) < quotedTollGold) {
            throw new RepeatableResourceError("INSUFFICIENT_GOLD", `This public mine costs ${quotedTollGold} Gold.`);
          }
        }
      }
      const bonusExtraction = Boolean(node.bonus_extraction_available);
      const { instantChance, bonusYieldChance, unbrokenChance } =
        minerMasteryChances(minerRank, bonusExtraction);
      const masteryResults = {
        instant: instantChance > 0 && this.roll() < instantChance,
        bonusYield: bonusYieldChance > 0 && this.roll() < bonusYieldChance,
        unbrokenVein: unbrokenChance > 0 && this.roll() < unbrokenChance,
        bonusExtraction,
        // The 1-second mine needs the glove worn with a use left in the database, not just in memory.
        ...(utilityGlove === "delver_glove" && await wornUtilityGearReady(client, player.playerId, utilityGlove)
          ? { utilityGlove }
          : {}),
        actionDurationMultiplier:
          Math.max(
            0.9,
            Math.min(
              1,
              Number.isFinite(actionDurationMultiplier)
                ? actionDurationMultiplier
                : 1
            )
          ) * Math.max(
            0.8,
            Math.min(
              1,
              Number.isFinite(miningDurationMultiplier)
                ? miningDurationMultiplier
                : 1
            )
          )
      };
      const benefit = await this.districtBenefits.resolveForPlayer(
        client,
        player.playerId
      );
      const cityBonusChance = benefit.miningExtraYieldChance;
      const cityBonusSucceeded =
        cityBonusChance > 0 && this.roll() < cityBonusChance;
      const effectiveDurationMs = masteryResults.utilityGlove && !masteryResults.instant
        ? UTILITY_GEAR_ACTION_DURATION_MS
        : applyRingSecondsToDuration(Math.ceil(
        effectiveMiningDurationMs(minerRank, masteryResults.instant)
        * masteryResults.actionDurationMultiplier
      ), masteryResults.instant ? 0 : miningRingSeconds);
      const sessionId = crypto.randomUUID();
      const inserted = await client.query<RepeatableSessionRow>(
        `WITH stamp AS (SELECT clock_timestamp() AS started_at)
         INSERT INTO repeatable_resource_sessions (
           id, player_id, node_id, resource_type, operation_key, starting_revision,
           status, effective_duration_ms, started_at, completes_at, expires_at,
           mastery_results,city_id,city_district_type,city_district_revision,
           city_monument_tier,city_bonus_chance,city_bonus_succeeded,
           quoted_owner_player_id,quoted_access_mode,quoted_toll_gold,
           quoted_access_revision,quoted_toll_revision
         )
         SELECT $1::uuid, $2, $3::uuid, $4, $5, $6, 'active', $7::bigint, started_at,
                started_at + ($7::bigint * interval '1 millisecond'),
                started_at + (($7::bigint + $8::bigint) * interval '1 millisecond'),
                $9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
         FROM stamp
         RETURNING id::text, player_id, node_id::text, resource_type, operation_key,
                   starting_revision, status, effective_duration_ms, started_at, completes_at, expires_at,
                   completed_at, cancelled_at, mastery_results,
                   city_id::text,city_district_type,city_district_revision::text,
                   city_monument_tier,city_bonus_chance,city_bonus_succeeded,
                   quoted_owner_player_id,quoted_access_mode,quoted_toll_gold,
                   quoted_access_revision,quoted_toll_revision`,
        [
          sessionId,
          player.playerId,
          node.id,
          node.yield_item_id,
          `repeatable-harvest:${sessionId}`,
          Number(node.harvest_revision),
          effectiveDurationMs,
          MINING_SESSION_EXPIRY_GRACE_MS,
          JSON.stringify(masteryResults),
          cityBonusChance > 0 ? benefit.cityId : null,
          cityBonusChance > 0 ? "mining" : null,
          cityBonusChance > 0 ? benefit.districtRevision : null,
          cityBonusChance > 0 ? benefit.monumentTiers.mining : null,
          cityBonusChance,
          cityBonusSucceeded,
          quotedOwnerPlayerId,
          quotedAccessMode,
          quotedTollGold.toString(),
          Number(node.harvest_access_revision),
          quotedTollRevision.toString()
        ]
      );
      await client.query("COMMIT");
      committed = true;
      return {
        session: sessionSnapshot(inserted.rows[0]!),
        nodePosition: { lat: Number(node.lat), lon: Number(node.lon) },
        replayed: false
      };
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        throw new RepeatableResourceError("HARVEST_ALREADY_ACTIVE", "Mining is already active");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async completeMining(
    player: CollectiblePlayer,
    sessionId: string,
    vision: ResourceVision | null
  ): Promise<RepeatableHarvestResult> {
    const client = await this.pool.connect();
    let completionNodeId: string | undefined;
    try {
      await client.query("BEGIN");
      const session = await lockSession(client, sessionId);
      completionNodeId = session.node_id;
      assertSessionOwner(session, player.playerId);
      if (session.status === "completed") {
        await this.lifecycle.lockAndConvergeNode(client, session.node_id);
        const node = await nodeForSession(client, session.node_id);
        const presentedNode = await this.lifecycle.nodeForPlayer(
          session.node_id,
          player.playerId,
          client
        );
        if (!presentedNode) {
          throw new Error(
            "Completed mining node no longer has publishable permanent-resource authority"
          );
        }
        const rewardQuantity = repeatableResourceYield(node) +
          (session.mastery_results.bonusYield ? 1 : 0) +
          (session.city_bonus_succeeded ? 1 : 0);
        const toll = await this.settleMiningToll(client, session);
        const replay = await this.inventory.replayCompletedOperationInTransaction(client, {
          operationKey: session.operation_key,
          playerId: player.playerId,
          source: "repeatable_resource_harvest",
          sourceEntityType: "repeatable_resource_node",
          sourceEntityId: session.node_id,
          grants: [{
            itemId: session.resource_type,
            variant: null,
            quantity: rewardQuantity
          }]
        });
        if (!replay) throw new Error("Completed mining inventory operation is unavailable");
        const position = { lat: Number(node.lat), lon: Number(node.lon) };
        const droppedItems = await createPhysicalRewardOverflowDropsInTransaction(
          client,
          replay,
          {
            operationKey: `harvest-overflow:${session.operation_key}`,
            droppedByPlayerId: player.playerId,
            regionCode: packageIdForPosition(position),
            zoneId: zoneIdForPosition(position),
            pileId: `harvest:${session.operation_key}`,
            sourceEntityType: "repeatable_resource_node",
            sourceEntityId: node.id,
            position,
            reason: "harvest_inventory_overflow"
          }
        );
        const masteryGrant = await this.grantMiningMastery(client, session);
        await client.query("COMMIT");
        return {
          session: sessionSnapshot(session),
          node: presentedNode,
          inventory: replay.inventory,
          replayed: true,
          masteryGrant,
          droppedItems,
          professionResults: {
            bonusYield: Boolean(session.mastery_results.bonusYield),
            instant: Boolean(session.mastery_results.instant),
            unbrokenVein: Boolean(session.mastery_results.unbrokenVein)
          },
          rewardQuantity,
          tollGold: toll.tollGold,
          walletGold: toll.walletGold,
          walletRevision: toll.walletRevision,
          diagnostics: {
            startingHarvestRevision: Number(session.starting_revision),
            completionHarvestRevision: Number(node.harvest_revision),
            startingCanonicalStateRevision: Number(session.starting_revision),
            completionCanonicalStateRevision:
              Number(node.population_v2_state_revision),
            inventoryRevisionBefore: replay.inventory.revision,
            inventoryRevisionAfter: replay.inventory.revision,
            inventoryOperation: "replayed",
            cityBonusYield: session.city_bonus_succeeded ? 1 : 0
          }
        };
      }
      if (session.status === "cancelled") {
        throw new RepeatableResourceError("HARVEST_CANCELLED", "Mining was cancelled");
      }
      if (session.status === "expired") {
        throw new RepeatableResourceError("HARVEST_EXPIRED", "Mining session expired");
      }
      const databaseNow = dateMs(session.database_now!);
      if (databaseNow < dateMs(session.completes_at)) {
        throw new RepeatableResourceError(
          "HARVEST_TOO_EARLY",
          "Mining is not complete yet",
          dateMs(session.completes_at) - databaseNow
        );
      }
      if (databaseNow >= dateMs(session.expires_at)) {
        await updateSessionStatus(client, session.id, "expired");
        await client.query("COMMIT");
        throw new RepeatableResourceError("HARVEST_EXPIRED", "Mining session expired");
      }

      const node = await this.lockAndValidateNode(client, player, session.node_id, vision, true);
      if (Number(node.harvest_revision) !== Number(session.starting_revision)) {
        throw new RepeatableResourceError(
          "HARVEST_NODE_CHANGED",
          "Mine state changed during mining",
          undefined,
          {
            nodeId: node.id,
            stateRevision:
              Number(node.population_v2_state_revision) * 2 +
              (node.public_state === "ready" ? 1 : 0),
            populationV2StateRevision:
              Number(node.population_v2_state_revision),
            startingHarvestRevision: Number(session.starting_revision),
            completionHarvestRevision: Number(node.harvest_revision),
            projectionStateRevision:
              Number(node.population_v2_state_revision),
            canonicalStateRevision:
              Number(node.population_v2_state_revision),
            canonicalState: node.public_state === "ready" ? "ready" : "harvested",
            authorityFailureReason: "projection-harvest-revision-changed",
            authoritativeDistanceM: Math.round(
              distanceMeters(player.position, {
                lat: Number(node.lat),
                lon: Number(node.lon)
              })
            ),
            reconciliation: "refresh-node"
          }
        );
      }
      const nextRevision = Number(node.harvest_revision) + 1;
      const toll = await this.settleMiningToll(client, session);
      const keepReady = !session.mastery_results.bonusExtraction && Boolean(session.mastery_results.unbrokenVein);
      const updated = await this.transitionPopulationV2Mine(
        client,
        node,
        player.playerId,
        keepReady
      );
      if (!updated.rows[0]) {
        throw new RepeatableResourceError(
          "HARVEST_NODE_CHANGED",
          "Mine state changed during mining",
          undefined,
          {
            nodeId: node.id,
            stateRevision:
              Number(node.population_v2_state_revision) * 2 +
              (node.public_state === "ready" ? 1 : 0),
            populationV2StateRevision:
              Number(node.population_v2_state_revision),
            authoritativeDistanceM: Math.round(
              distanceMeters(player.position, {
                lat: Number(node.lat),
                lon: Number(node.lon)
              })
            ),
            reconciliation: "refresh-node"
          }
        );
      }
      await client.query(
        `INSERT INTO repeatable_resource_harvests (
           operation_key, request_id, node_id, player_id, harvest_revision
         ) VALUES ($1,$2,$3::uuid,$4,$5)`,
        [session.operation_key, session.id, node.id, player.playerId, nextRevision]
      );
      const inventoryBefore = await this.inventory.snapshotInTransaction(
        client,
        player.playerId
      );
      const rewardQuantity = repeatableResourceYield(node) +
        (session.mastery_results.bonusYield ? 1 : 0) +
        (session.city_bonus_succeeded ? 1 : 0);
      const position = { lat: Number(node.lat), lon: Number(node.lon) };
      const settlement = await settlePhysicalItemRewardInTransaction(
        client,
        this.inventory,
        {
          delivery: "inventory_then_ground",
          lines: [{
            itemId: session.resource_type,
            variant: null,
            quantity: rewardQuantity
          }],
          inventoryOperation: {
            operationKey: session.operation_key,
            playerId: player.playerId,
            source: "repeatable_resource_harvest",
            sourceEntityType: "repeatable_resource_node",
            sourceEntityId: node.id,
            metadata: { nodeType: node.node_type, harvestRevision: nextRevision }
          },
          groundDrop: {
            operationKey: `harvest-overflow:${session.operation_key}`,
            droppedByPlayerId: player.playerId,
            regionCode: packageIdForPosition(position),
            zoneId: zoneIdForPosition(position),
            pileId: `harvest:${session.operation_key}`,
            sourceEntityType: "repeatable_resource_node",
            sourceEntityId: node.id,
            position,
            reason: "harvest_inventory_overflow"
          }
        }
      );
      const grant = settlement.inventoryGrant;
      if (!grant) throw new Error("Mining reward did not create an inventory operation");
      if (!grant.applied) throw new Error("Mining reward operation did not apply");
      const masteryGrant = await this.grantMiningMastery(client, session);
      // A utility glove spends one use per completed mine, in the same transaction.
      const gloveId = session.mastery_results.utilityGlove;
      const gloveSpent = gloveId && isUtilityGearDefinitionId(gloveId)
        ? await spendUtilityGearUseInTransaction(client, player.playerId, gloveId)
        : null;
      if (gloveId && !gloveSpent) {
        // The glove went away during a 1-second mine: nothing is granted and the session ends.
        await client.query("ROLLBACK");
        await updateSessionStatus(client, session.id, "cancelled");
        throw new RepeatableResourceError("HARVEST_CANCELLED", UTILITY_GEAR_GONE_MESSAGE);
      }
      const completed = await updateSessionStatus(client, session.id, "completed");
      const presentedNode = await this.lifecycle.nodeForPlayer(
        node.id,
        player.playerId,
        client
      );
      if (!presentedNode) {
        throw new Error(
          "Committed mining node no longer has publishable permanent-resource authority"
        );
      }
      await client.query("COMMIT");
      if (gloveSpent) await this.utilityGear?.afterUse(player.playerId).catch(() => undefined);
      return {
        session: sessionSnapshot(completed),
        node: presentedNode,
        inventory: grant.inventory,
        replayed: false,
        masteryGrant,
        droppedItems: settlement.droppedItems,
        professionResults: {
          bonusYield: Boolean(session.mastery_results.bonusYield),
          instant: Boolean(session.mastery_results.instant),
          unbrokenVein: Boolean(session.mastery_results.unbrokenVein)
        },
        rewardQuantity,
        tollGold: toll.tollGold,
        walletGold: toll.walletGold,
        walletRevision: toll.walletRevision,
        diagnostics: {
          startingHarvestRevision: Number(session.starting_revision),
          completionHarvestRevision: Number(updated.rows[0]!.harvest_revision),
          startingCanonicalStateRevision: Number(session.starting_revision),
          completionCanonicalStateRevision:
            Number(updated.rows[0]!.population_v2_state_revision),
          inventoryRevisionBefore: inventoryBefore.revision,
          inventoryRevisionAfter: grant.inventory.revision,
          inventoryOperation: "applied",
          cityBonusYield: session.city_bonus_succeeded ? 1 : 0
        }
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A committed expiry path has no open transaction to roll back.
      }
      if (isInventoryCapacityError(error)) {
        throw new RepeatableResourceError(
          "HARVEST_INVENTORY_FULL",
          "Carrying capacity is full. Reduce carried weight and mine again.",
          undefined,
          {
            ...(completionNodeId ? { nodeId: completionNodeId } : {}),
            ...(error instanceof InventoryCapacityError && error.diagnostic
              ? {
                  currentWeightGrams: error.diagnostic.currentWeightGrams,
                  maximumWeightGrams: error.diagnostic.maximumWeightGrams,
                  availableWeightGrams: error.diagnostic.availableWeightGrams,
                  requestedYield: error.diagnostic.requestedQuantity
                }
              : {}),
            reconciliation: "refresh-node"
          }
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelMining(playerId: string, sessionId: string): Promise<{ session: HarvestSessionSnapshot; replayed: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await lockSession(client, sessionId);
      assertSessionOwner(session, playerId);
      if (session.status === "completed") {
        throw new RepeatableResourceError("HARVEST_ALREADY_COMPLETED", "Completed mining cannot be cancelled");
      }
      if (session.status === "cancelled" || session.status === "expired") {
        await client.query("COMMIT");
        return { session: sessionSnapshot(session), replayed: true };
      }
      const cancelled = await updateSessionStatus(client, session.id, "cancelled");
      await client.query("COMMIT");
      return { session: sessionSnapshot(cancelled), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async terminateActiveSessionAfterTerminalFailure(
    playerId: string,
    sessionId: string,
    code: string
  ): Promise<RepeatableTerminalCleanupResult> {
    const disposition = repeatableCompletionFailureDisposition(code);
    if (
      disposition !== "terminal-cancelled" &&
      disposition !== "terminal-expired"
    ) {
      throw new Error(`Cannot terminate a mining session for ${code}`);
    }
    const terminalStatus =
      disposition === "terminal-expired" ? "expired" : "cancelled";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<RepeatableSessionRow>(
        `${sessionSelect()}
         WHERE id::text = $1 AND player_id = $2
         FOR UPDATE`,
        [sessionId, playerId]
      );
      const session = selected.rows[0];
      if (!session) {
        await client.query("COMMIT");
        return {
          sessionId,
          nodeId: null,
          statusBefore: null,
          statusAfter: null,
          outcome: "not-found"
        };
      }
      if (session.status !== "active") {
        await client.query("COMMIT");
        return {
          sessionId,
          nodeId: session.node_id,
          statusBefore: session.status,
          statusAfter: session.status,
          outcome: session.status === "completed"
            ? "completed"
            : "already-terminal"
        };
      }
      const updated = await client.query<RepeatableSessionRow>(
        `UPDATE repeatable_resource_sessions
         SET status = $3,
             cancelled_at = CASE
               WHEN $3 = 'cancelled' THEN clock_timestamp()
               ELSE cancelled_at
             END
         WHERE id::text = $1
           AND player_id = $2
           AND status = 'active'
         RETURNING id::text, player_id, node_id::text, resource_type,
                   operation_key, starting_revision, status,
                   effective_duration_ms, started_at, completes_at, expires_at,
                   completed_at, cancelled_at, mastery_results`,
        [sessionId, playerId, terminalStatus]
      );
      const statusAfter = updated.rows[0]?.status ?? session.status;
      await client.query("COMMIT");
      return {
        sessionId,
        nodeId: session.node_id,
        statusBefore: session.status,
        statusAfter,
        outcome: statusAfter === "cancelled" ? "cancelled" : "expired"
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async grantMiningMastery(queryable: Pick<pg.PoolClient, "query">, session: RepeatableSessionRow): Promise<MasteryGrantResult | null> {
    if (!this.masteries || session.mastery_results.utilityGlove === "delver_glove") return null;
    return this.masteries.grantProfessionXpInTransaction(queryable, {
      operationKey: `profession-xp:${session.operation_key}:miner`,
      playerId: session.player_id,
      sourceId: session.node_id,
      activity: { kind: "stone-mine" },
      randomResults: session.mastery_results
    });
  }

  async activeSessionForPlayer(playerId: string): Promise<HarvestSessionSnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await expireSessions(client, playerId, null);
      const result = await client.query<RepeatableSessionRow>(
        `${sessionSelect()}
         WHERE player_id = $1 AND status = 'active'
         ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
        [playerId]
      );
      await client.query("COMMIT");
      return result.rows[0] ? sessionSnapshot(result.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelActiveForPlayer(playerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE repeatable_resource_sessions
       SET status = 'cancelled', cancelled_at = clock_timestamp()
       WHERE player_id = $1 AND status = 'active'`,
      [playerId]
    );
  }

  private async lockAndValidateNode(
    queryable: Pick<pg.PoolClient, "query">,
    player: CollectiblePlayer,
    nodeId: string,
    vision: ResourceVision | null,
    requireReady: boolean
  ): Promise<RepeatableNodeRow> {
    if (!vision) {
      throw new RepeatableResourceError("HARVEST_RESOURCE_VISION_REQUIRED", "Build or visit a flag to reveal resources");
    }
    const locked = await this.lifecycle.lockAndConvergeNode(
      queryable,
      nodeId
    );
    if (!locked) {
      throw new RepeatableResourceError(
        "HARVEST_NODE_NOT_FOUND",
        "Resource node does not exist",
        undefined,
        { nodeId, reconciliation: "remove-node" }
      );
    }
    const { row, canonical } = locked;
    if (locked.authorityFailureReason === "projection-suppressed") {
      throw new RepeatableResourceError(
        "HARVEST_NODE_NOT_FOUND",
        `This ${mineLabel(row.node_type)} is no longer available.`,
        undefined,
        {
          nodeId,
          authorityFailureReason: "projection-suppressed",
          reconciliation: "remove-node"
        }
      );
    }
    if (!canonical || canonical.entity_id !== row.population_v2_entity_id) {
      throw new RepeatableResourceError(
        "HARVEST_NODE_CHANGED",
        `This ${mineLabel(row.node_type)} no longer has canonical authority.`,
        undefined,
        {
          nodeId,
          projectionStateRevision:
            Number(row.population_v2_state_revision),
          authorityFailureReason: "projection-canonical-entity-mismatch",
          reconciliation: "remove-node"
        }
      );
    }
    const canonicalRevision = Number(canonical.state_revision);
    const projectionRevision = Number(row.population_v2_state_revision);
    if (locked.authorityFailureReason) {
      throw new RepeatableResourceError(
        "HARVEST_NODE_CHANGED",
        locked.authorityFailureReason === "projection-definition-mismatch"
          ? `This ${mineLabel(row.node_type)} no longer matches its permanent-resource definition.`
          : locked.authorityFailureReason === "canonical-lifecycle-invalid"
            ? `This ${mineLabel(row.node_type)} has an invalid canonical lifecycle.`
          : `This ${mineLabel(row.node_type)} is not attached to the selected population plan.`,
        undefined,
        {
          nodeId,
          projectionStateRevision: projectionRevision,
          canonicalStateRevision: canonicalRevision,
          canonicalState: canonical.state,
          authorityFailureReason: locked.authorityFailureReason,
          reconciliation: "remove-node"
        }
      );
    }
    if (canonical.state !== "ready") {
      throw new RepeatableResourceError(
        "HARVEST_NODE_DEPLETED",
        `This ${mineLabel(row.node_type)} is depleted.`,
        undefined,
        {
          nodeId,
          projectionStateRevision: projectionRevision,
          canonicalStateRevision: canonicalRevision,
          canonicalState: canonical.state,
          authorityFailureReason: "canonical-state-not-ready",
          reconciliation: "refresh-node"
        }
      );
    }
    const nodePosition = { lat: Number(row.lat), lon: Number(row.lon) };
    const authorityRevision =
      Number(row.population_v2_state_revision) * 2 +
      (row.public_state === "ready" ? 1 : 0);
    const authoritativeDistanceM = distanceMeters(
      player.position,
      nodePosition
    );
    const authoritativeDistanceDiagnosticM = Math.round(
      authoritativeDistanceM
    );
    if (distanceMeters(vision.center, nodePosition) > vision.radiusM) {
      throw new RepeatableResourceError(
        "HARVEST_NODE_NOT_VISIBLE",
        "Resource node is outside Resource Vision",
        undefined,
        {
          nodeId,
          stateRevision: authorityRevision,
          populationV2StateRevision: Number(row.population_v2_state_revision),
          authoritativeDistanceM: authoritativeDistanceDiagnosticM,
          reconciliation: "remove-node"
        }
      );
    }
    if (authoritativeDistanceM > COLLECTIBLE_PICKUP_RADIUS_M) {
      throw new RepeatableResourceError(
        "HARVEST_NODE_OUT_OF_RANGE",
        "Move closer to the resource node",
        undefined,
        {
          nodeId,
          stateRevision: authorityRevision,
          populationV2StateRevision: Number(row.population_v2_state_revision),
          authoritativeDistanceM: authoritativeDistanceDiagnosticM,
          reconciliation: "refresh-node"
        }
      );
    }
    if (requireReady && row.public_state !== "ready") {
      throw new RepeatableResourceError(
        "HARVEST_NODE_DEPLETED",
        "This stone mine is depleted",
        undefined,
        {
          nodeId,
          stateRevision: authorityRevision,
          populationV2StateRevision: Number(row.population_v2_state_revision),
          authoritativeDistanceM: authoritativeDistanceDiagnosticM,
          reconciliation: "refresh-node"
        }
      );
    }
    return row;
  }

  private async transitionPopulationV2Mine(
    queryable: Pick<pg.PoolClient, "query">,
    node: RepeatableNodeRow,
    playerId: string,
    keepReady: boolean
  ): Promise<pg.QueryResult<RepeatableNodeRow>> {
    const expectedRevision = Number(node.population_v2_state_revision);
    if (
      !node.population_v2_entity_id
      || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 0
    ) {
      throw new RepeatableResourceError(
        "HARVEST_NODE_CHANGED",
        "Population v2 stone has an invalid state revision"
      );
    }
    const transitioned = await queryable.query<{ state_revision: number | string }>(
      `WITH event AS MATERIALIZED (
         SELECT clock_timestamp() AS occurred_at
       )
       UPDATE population_entity_state_v2 AS state
       SET state = CASE WHEN $4 THEN 'ready' ELSE 'harvested' END,
           state_revision = state.state_revision + 1,
           state_actor_player_id = CASE WHEN $4 THEN NULL ELSE $3 END,
           killed_or_harvested_at = CASE
             WHEN $4 THEN NULL
             ELSE event.occurred_at
           END,
           respawn_at = CASE
             WHEN $4 THEN NULL
             ELSE event.occurred_at + projection.regeneration_interval
           END,
           durable_runtime_state = '{}'::jsonb,
           updated_at = event.occurred_at
       FROM repeatable_resource_nodes AS projection
       JOIN population_permanent_resource_authority_v2 AS authority
         ON authority.entity_id=projection.population_v2_entity_id
        AND authority.owner_zone_id=
            projection.physical_population_zone_v2_id
        AND authority.node_type=projection.node_type
        AND authority.yield_item_id=projection.yield_item_id
        AND authority.yield_quantity=projection.yield_quantity
        AND authority.regeneration_interval=projection.regeneration_interval
       JOIN population_zone_cutovers_v2 AS cutover
         ON cutover.zone_id=authority.owner_zone_id
        AND cutover.status='stable'
        AND cutover.serving_version='v2'
        AND cutover.cutover_revision=
            projection.population_cutover_revision
       JOIN population_plan_permanent_resources_v2 AS membership
         ON membership.plan_id=cutover.selected_plan_id
        AND membership.entity_id=authority.entity_id,
       event
       WHERE state.entity_id = $1::uuid
         AND state.state = 'ready'
         AND state.state_revision = $2::bigint
         AND projection.id::text = $5
         AND projection.population_v2_entity_id = state.entity_id
         AND projection.population_v2_state_revision = $2::bigint
         AND NOT projection.population_v2_suppressed
       RETURNING state.state_revision`,
      [
        node.population_v2_entity_id,
        expectedRevision,
        playerId,
        keepReady,
        node.id
      ]
    );
    const nextRevision = Number(transitioned.rows[0]?.state_revision);
    if (
      transitioned.rowCount !== 1
      || nextRevision !== expectedRevision + 1
    ) {
      const failure = await this.describeTransitionFailure(
        queryable,
        node,
        expectedRevision
      );
      throw new RepeatableResourceError(
        "HARVEST_NODE_CHANGED",
        failure.message,
        undefined,
        failure.details
      );
    }
    return queryable.query<RepeatableNodeRow>(
      `UPDATE repeatable_resource_nodes AS projection
       SET bonus_extraction_available = $2,
           bonus_extraction_revision = CASE WHEN $2 THEN $4::bigint ELSE NULL END
       FROM population_entity_state_v2 AS canonical
       WHERE projection.id::text = $1
         AND projection.population_v2_entity_id = $3::uuid
         AND canonical.entity_id=projection.population_v2_entity_id
         AND canonical.state_revision=$4::bigint
         AND projection.population_v2_state_revision = $4::bigint
         AND NOT projection.population_v2_suppressed
       RETURNING projection.id::text, projection.node_type,
                 projection.region_code, projection.lat, projection.lon,
                 projection.yield_item_id, projection.yield_quantity,
                 projection.harvest_revision, canonical.respawn_at AS ready_at,
                 CASE WHEN canonical.state='ready'
                   THEN 'ready' ELSE 'depleted'
                 END AS public_state,
                 projection.bonus_extraction_available,
                 projection.bonus_extraction_revision,
                 projection.population_v2_entity_id::text,
                 projection.physical_population_zone_v2_id,
                 canonical.state_revision AS population_v2_state_revision,
                 projection.population_cutover_revision,
                 projection.population_v2_suppressed`,
      [
        node.id,
        keepReady,
        node.population_v2_entity_id,
        nextRevision
      ]
    );
  }

  private async settleMiningToll(
    client: pg.PoolClient,
    session: RepeatableSessionRow
  ): Promise<{ tollGold: string; walletGold: string | null; walletRevision: string | null }> {
    const ownerPlayerId = session.quoted_owner_player_id;
    const amount = BigInt(session.quoted_toll_gold ?? 0);
    if (!ownerPlayerId || ownerPlayerId === session.player_id || amount === 0n) {
      return { tollGold: "0", walletGold: null, walletRevision: null };
    }
    const accounts = await client.query<{ id: string; account_id: string }>(
      `SELECT id, account_id FROM players WHERE id=ANY($1::text[]) ORDER BY id`,
      [[session.player_id, ownerPlayerId]]
    );
    const byPlayer = new Map(accounts.rows.map((row) => [row.id, row.account_id]));
    const payerAccount = byPlayer.get(session.player_id);
    const ownerAccount = byPlayer.get(ownerPlayerId);
    if (!payerAccount || !ownerAccount) throw new Error("Mine toll wallet owner is unavailable");
    for (const id of [session.player_id, ownerPlayerId].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`harvest-toll:${id}`]);
    }
    let debit;
    try {
      debit = await this.wallet.debitForOperationInTransaction(client, {
        playerId: session.player_id, accountId: payerAccount, amount,
        operationKey: `harvest-toll-debit:${session.operation_key}`,
        reason: "public_mine_toll", metadata: { nodeId: session.node_id, ownerPlayerId }
      });
    } catch (error) {
      if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
        throw new RepeatableResourceError("INSUFFICIENT_GOLD", `This public mine costs ${amount} Gold.`);
      }
      throw error;
    }
    await this.wallet.creditForOperationInTransaction(client, {
      playerId: ownerPlayerId, accountId: ownerAccount, amount,
      operationKey: `harvest-toll-credit:${session.operation_key}`,
      reason: "public_mine_toll", metadata: { nodeId: session.node_id, payerPlayerId: session.player_id }
    });
    await client.query(
      `INSERT INTO harvest_toll_operations
         (operation_key, harvest_type, asset_id, payer_player_id, recipient_player_id, toll_gold)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (operation_key) DO NOTHING`,
      [session.operation_key, `${session.resource_type}_mine`, session.node_id, session.player_id, ownerPlayerId, amount.toString()]
    );
    return { tollGold: amount.toString(), walletGold: debit.goldBalance.toString(), walletRevision: debit.version.toString() };
  }

  private async describeTransitionFailure(
    queryable: Pick<pg.PoolClient, "query">,
    node: RepeatableNodeRow,
    expectedRevision: number
  ): Promise<{
    message: string;
    details: RepeatableResourceError["details"];
  }> {
    const state = await queryable.query<{
      projection_entity_id: string | null;
      projection_revision: number | string | null;
      projection_suppressed: boolean | null;
      canonical_entity_id: string | null;
      canonical_state: "ready" | "harvested" | null;
      canonical_revision: number | string | null;
    }>(
      `SELECT projection.population_v2_entity_id::text AS projection_entity_id,
              projection.population_v2_state_revision AS projection_revision,
              projection.population_v2_suppressed AS projection_suppressed,
              canonical.entity_id::text AS canonical_entity_id,
              canonical.state AS canonical_state,
              canonical.state_revision AS canonical_revision
       FROM repeatable_resource_nodes AS projection
       LEFT JOIN population_entity_state_v2 AS canonical
         ON canonical.entity_id = projection.population_v2_entity_id
       WHERE projection.id::text = $1`,
      [node.id]
    );
    const current = state.rows[0];
    const reason: RepeatableMineAuthorityFailureReason =
      current?.projection_suppressed
        ? "projection-suppressed"
        : !current?.canonical_entity_id ||
            current.projection_entity_id !== node.population_v2_entity_id
          ? "projection-canonical-entity-mismatch"
          : current.canonical_state !== "ready"
            ? "canonical-state-not-ready"
            : Number(current.canonical_revision) !== expectedRevision ||
                Number(current.projection_revision) !== expectedRevision
              ? "canonical-state-revision-mismatch"
              : "projection-harvest-revision-changed";
    return {
      message: reason === "canonical-state-not-ready"
        ? `${mineLabel(node.node_type, true)} was depleted during mining.`
        : reason === "projection-suppressed"
          ? `${mineLabel(node.node_type, true)} was suppressed during mining.`
          : `${mineLabel(node.node_type, true)} authority changed during mining.`,
      details: {
        nodeId: node.id,
        ...(current?.projection_revision == null
          ? {}
          : {
              projectionStateRevision: Number(current.projection_revision)
            }),
        ...(current?.canonical_revision == null
          ? {}
          : {
              canonicalStateRevision: Number(current.canonical_revision)
            }),
        ...(current?.canonical_state == null
          ? {}
          : { canonicalState: current.canonical_state }),
        authorityFailureReason: reason,
        reconciliation:
          reason === "projection-suppressed" ||
          reason === "projection-canonical-entity-mismatch"
            ? "remove-node"
            : "refresh-node"
      }
    };
  }
}

async function expireSessions(
  queryable: Pick<pg.PoolClient, "query">,
  playerId: string,
  nodeId: string | null
): Promise<void> {
  await queryable.query(
    `UPDATE repeatable_resource_sessions
     SET status = 'expired'
     WHERE status = 'active' AND expires_at <= clock_timestamp()
       AND (player_id = $1 OR ($2::uuid IS NOT NULL AND node_id = $2::uuid))`,
    [playerId, nodeId]
  );
}

async function findActiveSession(
  queryable: Pick<pg.PoolClient, "query">,
  playerId: string,
  nodeId: string
): Promise<RepeatableSessionRow | null> {
  const result = await queryable.query<RepeatableSessionRow>(
    `${sessionSelect()}
     WHERE status = 'active' AND (player_id = $1 OR node_id::text = $2)
     ORDER BY started_at ASC LIMIT 1 FOR UPDATE`,
    [playerId, nodeId]
  );
  return result.rows[0] ?? null;
}

async function lockSession(
  queryable: Pick<pg.PoolClient, "query">,
  sessionId: string
): Promise<RepeatableSessionRow> {
  const result = await queryable.query<RepeatableSessionRow>(
    `SELECT id::text, player_id, node_id::text, resource_type, operation_key,
            starting_revision, status, effective_duration_ms, started_at, completes_at, expires_at,
            completed_at, cancelled_at, mastery_results,
            city_id::text, city_district_type, city_district_revision::text,
            city_monument_tier, city_bonus_chance, city_bonus_succeeded,
            quoted_owner_player_id, quoted_access_mode, quoted_toll_gold,
            quoted_access_revision, quoted_toll_revision,
            clock_timestamp() AS database_now
     FROM repeatable_resource_sessions
     WHERE id::text = $1 FOR UPDATE`,
    [sessionId]
  );
  const row = result.rows[0];
  if (!row) throw new RepeatableResourceError("HARVEST_NOT_FOUND", "Mining session does not exist");
  return row;
}

async function updateSessionStatus(
  queryable: Pick<pg.PoolClient, "query">,
  sessionId: string,
  status: "completed" | "cancelled" | "expired"
): Promise<RepeatableSessionRow> {
  const result = await queryable.query<RepeatableSessionRow>(
    `UPDATE repeatable_resource_sessions
     SET status = $2,
         completed_at = CASE WHEN $2 = 'completed' THEN clock_timestamp() ELSE completed_at END,
         cancelled_at = CASE WHEN $2 = 'cancelled' THEN clock_timestamp() ELSE cancelled_at END
     WHERE id::text = $1
     RETURNING id::text, player_id, node_id::text, resource_type, operation_key,
               starting_revision, status, effective_duration_ms, started_at, completes_at, expires_at,
               completed_at, cancelled_at, mastery_results,
               city_id::text, city_district_type, city_district_revision::text,
               city_monument_tier, city_bonus_chance, city_bonus_succeeded,
               quoted_owner_player_id, quoted_access_mode, quoted_toll_gold,
               quoted_access_revision, quoted_toll_revision`,
    [sessionId, status]
  );
  return result.rows[0]!;
}

async function nodeForSession(
  queryable: Pick<pg.PoolClient, "query">,
  nodeId: string
): Promise<RepeatableNodeRow> {
  const result = await queryable.query<RepeatableNodeRow>(
    `SELECT projection.id::text, projection.node_type,
            projection.region_code, projection.lat, projection.lon,
            projection.yield_item_id, projection.yield_quantity,
            projection.harvest_revision, canonical.respawn_at AS ready_at,
            CASE WHEN canonical.state='ready'
              THEN 'ready' ELSE 'depleted' END AS public_state,
            projection.bonus_extraction_available,
            projection.bonus_extraction_revision,
            projection.population_v2_entity_id::text,
            projection.physical_population_zone_v2_id,
            canonical.state_revision AS population_v2_state_revision,
            projection.population_cutover_revision,
            projection.population_v2_suppressed
     FROM repeatable_resource_nodes AS projection
     JOIN population_entity_state_v2 AS canonical
       ON canonical.entity_id=projection.population_v2_entity_id
     WHERE projection.id::text = $1
       AND projection.population_v2_entity_id IS NOT NULL`,
    [nodeId]
  );
  if (!result.rows[0]) throw new Error("Repeatable resource node disappeared");
  return result.rows[0];
}

function sessionSelect(): string {
  return `SELECT id::text, player_id, node_id::text, resource_type, operation_key,
                 starting_revision, status, effective_duration_ms, started_at, completes_at, expires_at,
                 completed_at, cancelled_at, mastery_results,
                 city_id::text, city_district_type, city_district_revision::text,
                 city_monument_tier, city_bonus_chance, city_bonus_succeeded,
                 quoted_owner_player_id, quoted_access_mode, quoted_toll_gold,
                 quoted_access_revision, quoted_toll_revision
          FROM repeatable_resource_sessions`;
}

function assertSessionOwner(row: RepeatableSessionRow, playerId: string): void {
  if (row.player_id !== playerId) {
    throw new RepeatableResourceError("HARVEST_NOT_OWNED", "Mining session belongs to another player");
  }
}

function sessionSnapshot(row: RepeatableSessionRow): HarvestSessionSnapshot {
  return {
    sessionId: row.id,
    playerId: row.player_id,
    nodeId: row.node_id,
    resourceType: row.resource_type,
    operationKey: row.operation_key,
    status: row.status,
    startedAt: dateIso(row.started_at),
    completesAt: dateIso(row.completes_at),
    expiresAt: dateIso(row.expires_at),
    completedAt: row.completed_at === null ? null : dateIso(row.completed_at),
    cancelledAt: row.cancelled_at === null ? null : dateIso(row.cancelled_at)
  };
}

function repeatableResourceYield(row: RepeatableNodeRow): number {
  return permanentResourceYield(
    row.node_type,
    row.yield_item_id,
    Number(row.yield_quantity)
  );
}

function mineLabel(nodeType: string, titleCase = false): string {
  const label = nodeType === "coal_mine"
    ? "coal mine"
    : nodeType === "iron_mine"
      ? "iron mine"
      : nodeType === "sulfur_mine"
        ? "sulfur mine"
        : "stone mine";
  return titleCase ? `${label[0]!.toUpperCase()}${label.slice(1)}` : label;
}

const MAX_DEVELOPER_MINE_CONVERGENCE = 128;

/** Miner mastery proc chances shared by overworld mines and dungeon mines. */
export function minerMasteryChances(minerRank: number, bonusExtraction = false): Readonly<{
  instantChance: number;
  bonusYieldChance: number;
  unbrokenChance: number;
}> {
  return {
    instantChance: minerRank >= 8 ? 0.03 : minerRank >= 5 ? 0.02 : 0,
    bonusYieldChance: minerRank >= 8 ? 0.08 : minerRank >= 7 ? 0.06 : minerRank >= 2 ? 0.03 : 0,
    unbrokenChance: bonusExtraction ? 0 : minerRank >= 6 ? 0.03 : 0
  };
}

export function effectiveMiningDurationMs(minerRank: number, instant: boolean): number {
  if (!Number.isInteger(minerRank) || minerRank < 0 || minerRank > 8) {
    throw new Error("Miner rank must be an integer between 0 and 8");
  }
  if (instant) return 0;
  const speedBonus = minerRank >= 8 ? 0.08 : minerRank >= 4 ? 0.06 : minerRank >= 1 ? 0.03 : 0;
  return Math.ceil(STONE_MINE_DURATION_MS * (1 - speedBonus));
}

function dateIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function dateMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function serverRoll(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 4_294_967_296;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "23505";
}
