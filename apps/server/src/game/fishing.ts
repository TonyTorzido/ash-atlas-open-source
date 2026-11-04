import { createHash, randomInt, randomUUID } from "node:crypto";

import {
  FISHING_ACTIVE_ENCOUNTER_TIMEOUT_MS,
  FISHING_ACTIVE_RECONNECT_GRACE_MS,
  FISHING_BASE_CAST_RANGE_M,
  FISHING_BEHAVIOR_PROFILES,
  FISHING_BITE_DELAY_MAX_MS,
  FISHING_BITE_DELAY_MIN_MS,
  FISHING_CONTROL_DIRECTIONS,
  FISHING_CONTROL_MAX_STEP_MS,
  FISHING_CONTROL_UPDATE_INTERVAL_MS,
  FISHING_HUT_BUILD_COST,
  FISHING_HUT_BUILD_DURATION_MS,
  FISHING_HUT_INTERACTION_RADIUS_M,
  FISHING_HUT_MAX_WATER_DISTANCE_M,
  FISHING_HUT_PASSIVE_CAPACITY,
  FISHING_HUT_PASSIVE_INTERVAL_MS,
  FISHING_ROD_MAX_USES,
  FISHING_ROD_RECIPE_COST,
  FISHING_MAX_CAST_RANGE_M,
  FISHING_SPECIALIZATION_DURATION_MS,
  FISHING_SPECIALIZATION_TYPES,
  FISHING_UPGRADE_EFFECTS,
  FISHING_UPGRADE_GOLD_COSTS,
  FISHING_UPGRADE_MAX_RANK,
  FISHING_UPGRADE_TRACKS,
  FISHING_SPECIALIZATION_HANDLING_EFFECT,
  FISHING_STAMINA_MAX,
  activeFoodAccumulatorContribution,
  activeFoodFromAccumulator,
  advanceFishingFight,
  fishingBiteEventAt,
  fishingCatchScore,
  fishingBehaviorAt,
  fishingFightCanLand,
  fishingFightSnapped,
  FISHING_TRUE_STRIKE_WINDOW_MS,
  distanceMeters,
  isFiniteLatLon,
  passiveFishProducedSince,
  selectFreshwaterWaterbody,
  selectFishingWaterbody,
  type FishingBehaviorProfile,
  type FishingCatchSnapshot,
  type FishingControlDirection,
  type FishingEncounterPhase,
  type FishingEncounterSnapshot,
  type FishingFightState,
  type FishingHutBuildSnapshot,
  type FishingHutWorldSnapshot,
  type FishingRecordSnapshot,
  type FishingStateSnapshot,
  type FishingWeeklyAnglerSnapshot,
  type FishingWaterbodyCandidate,
  type FishingWaterbodyKind,
  type FishingUpgradeSnapshot,
  type FishingUpgradeTrack,
  type FishingSpecializationSnapshot,
  type FishingSpecializationType,
  type FreshwaterWaterbodyIdentity,
  type GeoContext,
  type LatLon,
  type DroppedItemSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import {
  fittingInventoryQuantityInTransaction,
  InventoryCapacityError,
  type InventoryService,
  type InventoryGrantResult
} from "./inventory.js";
import { createSystemGroundDropsInTransaction } from "./droppedItems.js";
import type { PlayerRecord } from "./state.js";
import { packageIdForPosition } from "./spatialZones.js";
import { evaluateOutdoorStationClearance, OUTDOOR_STATION_CLEARANCE_M } from "./stationPlacementClearance.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import type { WalletService } from "./wallet.js";
import { geoContextFromPersisted, geoContextFromWorldEnvironment } from "./geoContext.js";

type FishingHutRow = {
  fishing_hut_id: string;
  owner_player_id: string;
  owner_username: string;
  world_id: string;
  region_code: string;
  lat: number;
  lon: number;
  waterbody_kind: "lake" | "river" | "ocean";
  waterbody_source_id: string;
  waterbody_name: string;
  waterbody_distance_m: number;
  world_source_revision: string | null;
  passive_last_produced_at: Date | string;
  passive_stored_quantity: number;
  passive_capacity: number;
  placement_revision: string | number;
  built_at: Date | string;
};

type ValidatedCast = Readonly<{
  waterbody: FreshwaterWaterbodyIdentity;
  regionName: string;
  countryName: string;
  geoContext: GeoContext;
}>;

/** Keep the retained food item contract while exposing the authoritative water type. */
export function fishingCatchSpecies(
  waterbodyKind: FishingWaterbodyKind | null | undefined,
  persistedSpecies?: string | null
): string {
  const normalizedPersistedSpecies = persistedSpecies?.trim();
  if (
    normalizedPersistedSpecies &&
    normalizedPersistedSpecies !== "freshwater_fish" &&
    normalizedPersistedSpecies !== "ashen_fish"
  ) {
    return normalizedPersistedSpecies;
  }
  return waterbodyKind === "ocean" ? "ocean_fish" : "freshwater_fish";
}

/** The generator maps its normalized size score linearly onto catch length. */
export function fishingCatchPercentileFromSize(lengthIn: number): number {
  const baseLength = 8;
  const lengthRange = 25;
  const percentile = (lengthIn - baseLength) / lengthRange;
  if (!Number.isFinite(percentile)) return 0;
  return Math.max(0, Math.min(1, percentile));
}

type BuildRow = {
  build_id: string;
  owner_player_id: string;
  request_id: string;
  request_hash: string;
  world_id: string;
  region_code: string;
  lat: number;
  lon: number;
  waterbody_kind: "lake" | "river" | "ocean";
  waterbody_source_id: string;
  waterbody_name: string;
  waterbody_distance_m: number;
  world_source_revision: string | null;
  world_source_metadata: Record<string, unknown>;
  status: "constructing" | "completed" | "cancelled";
  started_at: Date | string;
  completes_at: Date | string;
  fishing_hut_id: string | null;
  cancel_reason: string | null;
};

type EncounterRow = {
  encounter_id: string;
  player_id: string;
  fishing_hut_id: string | null;
  waterbody_kind: "lake" | "river" | "ocean" | null;
  waterbody_source_id: string | null;
  waterbody_name: string | null;
  rod_id: string | null;
  rod_uses_remaining: number | null;
  waterbody_source_revision: string | null;
  waterbody_candidates: FishingWaterbodyCandidate[];
  origin_lat: number | null;
  origin_lon: number | null;
  region_name: string | null;
  country_name: string | null;
  country_id: string | null;
  admin1_id: string | null;
  admin1_name: string | null;
  canonical_waterbody_id: string | null;
  gameplay_water_type: "lake" | "river" | "ocean" | null;
  canonical_display_name: string | null;
  waterbody_resolution_state: "resolved" | "unresolved" | "ambiguous" | "invalid" | "not_applicable" | null;
  marine_parent_id: string | null;
  marine_parent_name: string | null;
  presentation_name: string | null;
  presentation_relation: "exact" | "near" | "unnamed" | "open_ocean" | null;
  presentation_distance_m: number | null;
  geo_context_captured_at: Date | string | null;
  cast_range_m: number;
  matching_specialization: boolean;
  phase: FishingEncounterPhase;
  behavior_profile: FishingBehaviorProfile;
  seed: string | number;
  difficulty: number;
  ashen: boolean;
  cast_quality: number | null;
  cast_lat: number | null;
  cast_lon: number | null;
  length_in: number | null;
  weight_lb: number | null;
  size_percentile: number | null;
  score: number | null;
  perfect: boolean;
  tension: number;
  distance: number;
  stamina: number;
  slack_ms: number;
  critical_ms: number;
  fish_direction: FishingControlDirection;
  fish_pull: number;
  control_direction: FishingControlDirection;
  control_reeling: boolean;
  execution_quality: number;
  started_at: Date | string;
  bite_at: Date | string;
  hooked_at: Date | string | null;
  last_action_at: Date | string;
  reconnect_deadline_at: Date | string;
  disconnected_at: Date | string | null;
  completed_at: Date | string | null;
};

type OperationRow = {
  action: "build" | "collect" | "start" | "cast" | "hook" | "control" | "land" | "cancel" | "craft_rod" | "upgrade" | "specialize";
  request_hash: string;
  fishing_hut_id: string | null;
  encounter_id: string | null;
  result_quantity: number;
  result_jsonb?: Record<string, unknown> | null;
};

export class FishingError extends Error {
  constructor(readonly code: string, message: string, readonly suggestedPosition?: { lat: number; lon: number }) {
    super(message);
    this.name = "FishingError";
  }
}

export type FishingBuildRequestResult =
  | Readonly<{ status: "constructing"; build: FishingHutBuildSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean }>
  | Readonly<{ status: "completed"; hut: FishingHutWorldSnapshot; inventory: PlayerInventorySnapshot; replayed: true }>
  | Readonly<{ status: "cancelled"; buildId: string; inventory: PlayerInventorySnapshot; replayed: true }>;

export type FishingBuildCompletion = Readonly<{
  playerId: string;
  requestId: string;
  hut: FishingHutWorldSnapshot;
  inventory: PlayerInventorySnapshot;
}>;

export type FishingBuildCancellation = Readonly<{
  playerId: string;
  requestId: string;
  buildId: string;
  inventory: PlayerInventorySnapshot;
  droppedItems: DroppedItemSnapshot[];
  reason: string;
}>;

export type FishingMutationResult = Readonly<{
  state: FishingStateSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
}>;

export type FishingCollectionResult = FishingMutationResult & Readonly<{ collectedQuantity: number }>;
export type FishingEncounterResult = Readonly<{
  state: FishingStateSnapshot;
  replayed: boolean;
  inventory?: PlayerInventorySnapshot;
  collectedQuantity?: number;
}>;

export type FishingProgressionResult = Readonly<{
  state: FishingStateSnapshot;
  inventory: PlayerInventorySnapshot;
  upgrades: readonly FishingUpgradeSnapshot[];
  specialization: FishingSpecializationSnapshot;
  replayed: boolean;
  rodId?: string;
  walletGold?: string;
  walletVersion?: string;
}>;

export type FishingRodGrantRequest = Readonly<{
  operationKey: string;
  playerId: string;
  quantity: bigint | number;
  source: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  metadata?: Record<string, unknown>;
  allowPartial?: boolean;
}>;

export type FishingRodGrantResult = Readonly<{
  applied: boolean;
  inventory: PlayerInventorySnapshot;
  grants: readonly InventoryGrantResult[];
}>;

export class FishingService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly worldId: string,
    private readonly inventory: Pick<InventoryService, "debitItemsForOperationInTransaction" | "grantItemsForOperationInTransaction" | "snapshotInTransaction">,
    private readonly worldLookup: Pick<WorldLookupClient, "lookupGameplayEnvironment" | "lookupCanonicalWaterbodyNear"> & Partial<Pick<WorldLookupClient, "lookupCanonicalWaterbodiesNear">>,
    private readonly now: () => number = Date.now,
    private readonly randomIntFn: (min: number, max: number) => number = randomInt,
    private readonly wallet?: Pick<WalletService, "debitForOperationInTransaction" | "snapshotInTransaction">
  ) {}

  async listNear(player: PlayerRecord, radiusM = 50_000): Promise<FishingHutWorldSnapshot[]> {
    const result = await this.pool.query<FishingHutRow>(
      `${HUT_SELECT} WHERE hut.removed_at IS NULL AND hut.world_id=$1 AND hut.region_code=$2
         AND ST_DWithin(hut.geom::geography,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$5)
       ORDER BY ST_Distance(hut.geom::geography,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography),hut.fishing_hut_id`,
      [this.worldId, player.regionCode, player.position.lon, player.position.lat, Math.min(Math.max(radiusM, 1), 50_000)]
    );
    return result.rows.map((row) => mapHut(row, this.now()));
  }

  async build(player: PlayerRecord, requestId: string): Promise<FishingBuildRequestResult> {
    requireRequestId(requestId);
    requirePosition(player);
    const world = await this.lookupFreshwater(player);
    const hash = requestHash("build", player.playerId, player.position.lat, player.position.lon);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      await lockBuildChannel(client, player.playerId);
      const replay = await buildForRequest(client, player.playerId, requestId);
      if (replay) {
        if (replay.request_hash !== hash) throw new FishingError("FISHING_REPLAY_CONFLICT", "The Fishing Hut request ID was already used.");
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        if (replay.status === "completed" && replay.fishing_hut_id) {
          const hut = await requireHut(client, replay.fishing_hut_id);
          await client.query("COMMIT");
          return { status: "completed", hut: mapHut(hut, this.now()), inventory, replayed: true };
        }
        if (replay.status === "cancelled") {
          await client.query("COMMIT");
          return { status: "cancelled", buildId: replay.build_id, inventory, replayed: true };
        }
        await client.query("COMMIT");
        return { status: "constructing", build: mapBuild(replay), inventory, replayed: true };
      }
      if (await activeBuild(client, player.playerId, true)) {
        throw new FishingError("FISHING_BUILD_ACTIVE", "Finish or cancel the current construction first.");
      }
      if (await hasActiveHut(client, player.playerId)) {
        throw new FishingError("FISHING_OWNER_LIMIT", "You may only own one Fishing Hut.");
      }
      for (const table of ["furnace_build_jobs", "tannery_build_jobs", "butcher_build_jobs", "loom_build_jobs", "kitchen_build_jobs"] as const) {
        if ((await client.query(`SELECT 1 FROM ${table} WHERE owner_player_id=$1 AND status='constructing' LIMIT 1`, [player.playerId])).rows[0]) {
          throw new FishingError("FISHING_BUILD_ACTIVE", "Finish the current station construction first.");
        }
      }
      await requirePersonalTerritory(client, player);
      await requireFishingClearance(client, this.worldId, player.regionCode, player.position);
      const buildId = randomUUID();
      const startedAt = this.now();
      const completesAt = startedAt + FISHING_HUT_BUILD_DURATION_MS;
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `fishing:build:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "fishing_hut_construction",
          sourceEntityType: "fishing_hut_build",
          sourceEntityId: buildId,
          metadata: { requestId, waterbody: world },
          debits: [
            { itemId: "stone", variant: null, quantity: FISHING_HUT_BUILD_COST.stone },
            { itemId: "wood", variant: null, quantity: FISHING_HUT_BUILD_COST.wood }
          ]
        })).inventory;
      } catch (error) {
        if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
          throw new FishingError("FISHING_BUILD_MATERIALS_REQUIRED", `Building a Fishing Hut requires ${FISHING_HUT_BUILD_COST.wood} Wood and ${FISHING_HUT_BUILD_COST.stone} Stone.`);
        }
        throw error;
      }
      const inserted = await client.query<BuildRow>(
        `INSERT INTO fishing_hut_build_jobs (
          build_id,owner_player_id,request_id,request_hash,world_id,region_code,lat,lon,geom,
          waterbody_kind,waterbody_source_id,waterbody_name,waterbody_distance_m,
          world_source_revision,world_source_metadata,started_at,completes_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,ST_SetSRID(ST_MakePoint($8,$7),4326),$9,$10,$11,$12,$13,$14,
          to_timestamp($15/1000.0),to_timestamp($16/1000.0)) RETURNING ${BUILD_FIELDS}`,
        [buildId, player.playerId, requestId, hash, this.worldId, player.regionCode, player.position.lat, player.position.lon,
          world.kind, world.sourceId, world.displayName, world.distanceM, world.sourceRevision ?? null,
          JSON.stringify(await this.worldMetadata(player)), startedAt, completesAt]
      );
      const build = requireRow(inserted.rows[0], "Fishing Hut construction could not be started");
      await client.query("COMMIT");
      return { status: "constructing", build: mapBuild(build), inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async activeBuildForPlayer(playerId: string): Promise<Readonly<{ requestId: string; build: FishingHutBuildSnapshot; inventory: PlayerInventorySnapshot }> | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await activeBuild(client, playerId, false);
      if (!row) { await client.query("COMMIT"); return null; }
      const inventory = await this.inventory.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      return { requestId: row.request_id, build: mapBuild(row), inventory };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async cancelBuildForMovement(playerId: string): Promise<FishingBuildCancellation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockBuildChannel(client, playerId);
      const build = await activeBuild(client, playerId, true);
      if (!build) { await client.query("COMMIT"); return null; }
      const cancelled = await this.cancelBuildInTransaction(client, build, "movement");
      await client.query("COMMIT");
      return cancelled;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async reconcileDueBuilds(limit = 100): Promise<Readonly<{ completed: FishingBuildCompletion[]; cancelled: FishingBuildCancellation[] }>> {
    const due = await this.pool.query<{ build_id: string }>(
      `SELECT build_id FROM fishing_hut_build_jobs WHERE status='constructing' AND completes_at <= clock_timestamp() ORDER BY completes_at,build_id LIMIT $1`, [limit]
    );
    const completed: FishingBuildCompletion[] = [];
    const cancelled: FishingBuildCancellation[] = [];
    for (const row of due.rows) {
      const result = await this.completeBuild(row.build_id);
      if (!result) continue;
      if ("hut" in result) completed.push(result); else cancelled.push(result);
    }
    return { completed, cancelled };
  }

  async state(player: PlayerRecord, fishingHutId: string | null = null): Promise<FishingStateSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const hut = fishingHutId ? await this.requireInRange(client, player, fishingHutId, false) : null;
      // State reads can advance the authoritative bite cycle. Keep the row
      // locked through that transition so two timer/reconnect reads cannot
      // race while re-arming the same encounter.
      const encounter = await this.refreshEncounter(client, player.playerId, fishingHutId, true);
      const state = await this.stateInTransaction(client, player, hut, encounter);
      await client.query("COMMIT");
      return state;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async refreshEncounter(client: pg.PoolClient, playerId: string, fishingHutId: string | null, lock: boolean): Promise<EncounterRow | null> {
    let encounter = await activeEncounter(client, playerId, lock);
    if (!encounter || (fishingHutId && encounter.fishing_hut_id && encounter.fishing_hut_id !== fishingHutId)) return null;
    const nowMs = this.now();
    const reconnectDeadline = new Date(encounter.reconnect_deadline_at).getTime();
    const lastAction = new Date(encounter.last_action_at).getTime();
    // A cast that is already on the water, or a bite that is between cues,
    // remains live until the player cancels/leaves. Fight inactivity still has
    // the existing authoritative timeout and disconnected encounters still
    // have the reconnect grace window.
    const waitingPhase = encounter.phase === "cast" || encounter.phase === "bite";
    if ((encounter.disconnected_at !== null && nowMs > reconnectDeadline) || (!waitingPhase && nowMs - lastAction > FISHING_ACTIVE_ENCOUNTER_TIMEOUT_MS)) {
      await client.query(`UPDATE fishing_encounters SET phase='expired',control_direction='neutral',control_reeling=false,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE encounter_id=$1`, [encounter.encounter_id]);
      return null;
    }
    if (encounter.disconnected_at !== null) {
      await client.query(
        `UPDATE fishing_encounters SET disconnected_at=NULL,control_direction='neutral',control_reeling=false,last_action_at=to_timestamp($2/1000.0),reconnect_deadline_at=to_timestamp($3/1000.0),updated_at=clock_timestamp() WHERE encounter_id=$1`,
        [encounter.encounter_id, nowMs, nowMs + FISHING_ACTIVE_RECONNECT_GRACE_MS]
      );
      encounter = { ...encounter, disconnected_at: null, last_action_at: new Date(nowMs), reconnect_deadline_at: new Date(nowMs + FISHING_ACTIVE_RECONNECT_GRACE_MS) };
    }
    const biteAt = new Date(encounter.bite_at).getTime();
    if (encounter.phase === "cast" && nowMs >= biteAt) {
      await client.query(`UPDATE fishing_encounters SET phase='bite',updated_at=clock_timestamp() WHERE encounter_id=$1`, [encounter.encounter_id]);
      encounter = { ...encounter, phase: "bite" };
    }
    // Once the server-owned bite timeline has ended, re-arm this same cast.
    // Keeping the cast point and encounter id makes a missed hook recoverable
    // without creating a second encounter or requiring a new cast target.
    if (encounter.phase === "bite" && fishingBiteEventAt(Number(encounter.seed), biteAt, nowMs) === null) {
      return this.rearmWaitingEncounter(client, encounter, nowMs);
    }
    return encounter;
  }

  async collect(player: PlayerRecord, requestId: string, fishingHutId: string): Promise<FishingCollectionResult> {
    requireRequestId(requestId);
    requirePosition(player);
    const hash = requestHash("collect", player.playerId, fishingHutId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "collect", hash);
        const hut = await this.requireInRange(client, player, replay.fishing_hut_id!, false);
        const state = await this.stateInTransaction(client, player, hut, null);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { state, inventory, collectedQuantity: replay.result_quantity, replayed: true };
      }
      const hut = await this.requireInRange(client, player, fishingHutId, true);
      if (hut.owner_player_id !== player.playerId) {
        throw new FishingError("FISHING_OWNER_ONLY", "Only the Fishing Hut owner can collect its passive fish.");
      }
      const stored = Number(hut.passive_stored_quantity);
      const last = new Date(hut.passive_last_produced_at).getTime();
      const nowMs = this.now();
      const produced = passiveFishProducedSince(last, nowMs, stored);
      if (stored <= 0 && produced <= 0) throw new FishingError("FISHING_PASSIVE_EMPTY", "No Freshwater Fish is ready to collect yet.");
      const collected = stored + produced;
      const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `fishing:collect:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "fishing_hut_passive",
        sourceEntityType: "fishing_hut",
        sourceEntityId: fishingHutId,
        metadata: { requestId, produced },
        grants: [{ itemId: "freshwater_fish", variant: null, quantity: collected }],
        allowPartial: true
      });
      const granted = grant.grants[0]?.grantedQuantity ?? 0;
      const nextStored = Math.max(0, collected - granted);
      const nextLast = produced >= FISHING_HUT_PASSIVE_CAPACITY - stored ? nowMs : last + produced * FISHING_HUT_PASSIVE_INTERVAL_MS;
      await client.query(
        `UPDATE player_fishing_huts SET passive_stored_quantity=$2,passive_last_produced_at=to_timestamp($3/1000.0),updated_at=clock_timestamp() WHERE fishing_hut_id=$1`,
        [fishingHutId, nextStored, nextLast]
      );
      await client.query(
        `INSERT INTO fishing_operations(operation_key,player_id,request_id,action,request_hash,fishing_hut_id,result_quantity)
         VALUES($1,$2,$3,'collect',$4,$5,$6)`,
        [operationKey(player.playerId, requestId), player.playerId, requestId, hash, fishingHutId, granted]
      );
      const updated = await requireHut(client, fishingHutId);
      const state = await this.stateInTransaction(client, player, updated, null);
      await client.query("COMMIT");
      return { state, inventory: grant.inventory, collectedQuantity: granted, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  /** Craft one individually durable rod at the hut. */
  async craftRod(player: PlayerRecord, requestId: string, fishingHutId: string): Promise<FishingProgressionResult> {
    requireRequestId(requestId);
    requirePosition(player);
    const hash = requestHash("craft_rod", player.playerId, fishingHutId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      const hut = await this.requireInRange(client, player, fishingHutId, true);
      if (replay) {
        requireMatchingOperation(replay, "craft_rod", hash);
        const progression = await ensureFishingProgression(client, player.playerId, this.now());
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        const state = await this.stateInTransaction(client, player, hut, null);
        await client.query("COMMIT");
        return { state, inventory, ...progression, replayed: true, ...(replay.result_jsonb?.rodId ? { rodId: String(replay.result_jsonb.rodId) } : {}) };
      }
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `fishing:craft-rod:${player.playerId}:${requestId}`,
          playerId: player.playerId,
          source: "fishing_rod_crafting",
          sourceEntityType: "fishing_hut",
          sourceEntityId: fishingHutId,
          metadata: { requestId, recipe: FISHING_ROD_RECIPE_COST },
          debits: [
            { itemId: "wood", variant: null, quantity: FISHING_ROD_RECIPE_COST.wood },
            { itemId: "flax_fiber", variant: null, quantity: FISHING_ROD_RECIPE_COST.flaxFiber }
          ]
        })).inventory;
      } catch (error) {
        if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
          throw new FishingError("FISHING_ROD_MATERIALS_REQUIRED", `Crafting a Fishing Rod requires ${FISHING_ROD_RECIPE_COST.wood} Wood and ${FISHING_ROD_RECIPE_COST.flaxFiber} Flax Fiber.`);
        }
        throw error;
      }
      const rod = await client.query<{ rod_id: string }>(
        `INSERT INTO fishing_rods(player_id,uses_remaining) VALUES($1,$2) RETURNING rod_id::text`,
        [player.playerId, FISHING_ROD_MAX_USES]
      );
      const rodId = requireRow(rod.rows[0], "Fishing Rod crafting failed").rod_id;
      inventory = (await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `fishing:craft-rod-grant:${player.playerId}:${requestId}`,
        playerId: player.playerId,
        source: "fishing_rod_crafting",
        sourceEntityType: "fishing_rod",
        sourceEntityId: rodId,
        metadata: { requestId, usesRemaining: FISHING_ROD_MAX_USES },
        grants: [{ itemId: "fishing_rod", variant: rodId, quantity: 1 }]
      })).inventory;
      await client.query(
        `INSERT INTO fishing_operations(operation_key,player_id,request_id,action,request_hash,fishing_hut_id,result_jsonb)
         VALUES($1,$2,$3,'craft_rod',$4,$5,$6::jsonb)`,
        [operationKey(player.playerId, requestId), player.playerId, requestId, hash, fishingHutId, JSON.stringify({ rodId })]
      );
      const progression = await ensureFishingProgression(client, player.playerId, this.now());
      const state = await this.stateInTransaction(client, player, hut, null);
      await client.query("COMMIT");
      return { state, inventory, ...progression, replayed: false, rodId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  /**
   * Grant individually durable rods for an authoritative developer/package
   * flow. Every rod gets its own fishing_rods row before its inventory
   * variant is granted; the per-rod inventory operation keys make a retry
   * replay the same identities without creating another rod.
   */
  async grantDurableRodsInTransaction(
    queryable: Pick<pg.Pool | pg.PoolClient, "query">,
    input: FishingRodGrantRequest
  ): Promise<FishingRodGrantResult> {
    const quantity = normalizeRodGrantQuantity(input.quantity);
    const grants: InventoryGrantResult[] = [];
    let applied = false;
    for (let index = 0; index < quantity; index += 1) {
      const operationKey = `${input.operationKey}:rod:${index}`;
      const existing = await queryable.query<{
        source: string;
        source_entity_type: string | null;
        source_entity_id: string | null;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT source,source_entity_type,source_entity_id,metadata
         FROM inventory_operations WHERE operation_key=$1`,
        [operationKey]
      );
      let rodId: string;
      if (existing.rows[0]) {
        const candidate = existing.rows[0].metadata?.fishingRodId;
        if (typeof candidate !== "string" || !candidate) {
          throw new Error("Fishing Rod grant operation metadata is incomplete");
        }
        rodId = candidate;
      } else {
        if (input.allowPartial && (await fittingInventoryQuantityInTransaction(
          queryable,
          input.playerId,
          "fishing_rod",
          1n
        )) < 1n) {
          break;
        }
        const inserted = await queryable.query<{ rod_id: string }>(
          `INSERT INTO fishing_rods(player_id,uses_remaining)
           VALUES($1,$2) RETURNING rod_id::text`,
          [input.playerId, FISHING_ROD_MAX_USES]
        );
        rodId = requireRow(inserted.rows[0], "Fishing Rod could not be initialized").rod_id;
      }
      const result = await this.inventory.grantItemsForOperationInTransaction(
        queryable,
        {
          operationKey,
          playerId: input.playerId,
          source: input.source,
          sourceEntityType: input.sourceEntityType ?? "fishing_rod",
          sourceEntityId: input.sourceEntityId ?? rodId,
          metadata: {
            ...(input.metadata ?? {}),
            fishingRodId: rodId,
            usesRemaining: FISHING_ROD_MAX_USES
          },
          grants: [{ itemId: "fishing_rod", variant: rodId, quantity: 1 }]
        }
      );
      const grant = result.grants[0];
      if (!grant) throw new Error("Fishing Rod grant result is incomplete");
      if (grant.grantedQuantity === 0) {
        if (input.allowPartial) {
          if (!existing.rows[0]) {
            await queryable.query(
              `DELETE FROM fishing_rods WHERE rod_id=$1::uuid AND player_id=$2`,
              [rodId, input.playerId]
            );
          }
          break;
        }
        throw new InventoryCapacityError([grant], undefined);
      }
      grants.push(grant);
      applied = applied || result.applied;
    }
    return {
      applied,
      inventory: await this.inventory.snapshotInTransaction(queryable, input.playerId),
      grants
    };
  }

  async upgrade(player: PlayerRecord, requestId: string, fishingHutId: string, track: FishingUpgradeTrack): Promise<FishingProgressionResult> {
    requireRequestId(requestId);
    if (!FISHING_UPGRADE_TRACKS.includes(track)) throw new FishingError("FISHING_UPGRADE_INVALID", "Unknown fishing training track.");
    const hash = requestHash("upgrade", player.playerId, fishingHutId, track);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const hut = await this.requireInRange(client, player, fishingHutId, true);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "upgrade", hash);
        const progression = await ensureFishingProgression(client, player.playerId, this.now());
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        const state = await this.stateInTransaction(client, player, hut, null);
        await client.query("COMMIT");
        return { state, inventory, ...progression, replayed: true };
      }
      const progressionRow = await ensureFishingProgressionRow(client, player.playerId);
      const column = upgradeRankColumn(track);
      const rank = Number(progressionRow[column] ?? 0);
      if (rank >= FISHING_UPGRADE_MAX_RANK) throw new FishingError("FISHING_UPGRADE_MAXED", "That fishing training track is already at max rank.");
      const cost = FISHING_UPGRADE_GOLD_COSTS[rank] ?? 0;
      if (!this.wallet) throw new FishingError("FISHING_UPGRADE_UNAVAILABLE", "Fishing training purchases are unavailable.");
      const account = await client.query<{ account_id: string }>(`SELECT account_id FROM players WHERE id=$1`, [player.playerId]);
      const accountId = requireRow(account.rows[0], "Player wallet ownership is unavailable.").account_id;
      let walletResult;
      try {
        walletResult = await this.wallet.debitForOperationInTransaction(client, {
          playerId: player.playerId, accountId, amount: BigInt(cost),
          operationKey: `fishing:upgrade:${player.playerId}:${requestId}`,
          reason: "fishing_training_upgrade",
          metadata: { requestId, track, fromRank: rank, toRank: rank + 1 }
        });
      } catch (error) {
        if (error instanceof Error && /enough gold|insufficient/i.test(error.message)) throw new FishingError("FISHING_UPGRADE_GOLD_REQUIRED", `Rank ${rank + 1} requires ${cost} Gold.`);
        throw error;
      }
      await client.query(`UPDATE fishing_player_progression SET ${column}=$2,updated_at=clock_timestamp() WHERE player_id=$1`, [player.playerId, rank + 1]);
      await client.query(`INSERT INTO fishing_operations(operation_key,player_id,request_id,action,request_hash,fishing_hut_id,result_jsonb) VALUES($1,$2,$3,'upgrade',$4,$5,$6::jsonb)`, [operationKey(player.playerId, requestId), player.playerId, requestId, hash, fishingHutId, JSON.stringify({ track, rank: rank + 1 })]);
      const progression = await ensureFishingProgression(client, player.playerId, this.now());
      const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
      const state = await this.stateInTransaction(client, player, hut, null);
      await client.query("COMMIT");
      return { state, inventory, ...progression, replayed: false, walletGold: walletResult.goldBalance.toString(), walletVersion: walletResult.version.toString() };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async specialize(player: PlayerRecord, requestId: string, fishingHutId: string, type: FishingSpecializationType): Promise<FishingProgressionResult> {
    requireRequestId(requestId);
    if (!FISHING_SPECIALIZATION_TYPES.includes(type)) throw new FishingError("FISHING_SPECIALIZATION_INVALID", "Choose river, lake, or ocean specialization.");
    const hash = requestHash("specialize", player.playerId, fishingHutId, type);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const hut = await this.requireInRange(client, player, fishingHutId, true);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "specialize", hash);
        const progression = await ensureFishingProgression(client, player.playerId, this.now());
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        const state = await this.stateInTransaction(client, player, hut, null);
        await client.query("COMMIT");
        return { state, inventory, ...progression, replayed: true };
      }
      const current = await ensureFishingProgressionRow(client, player.playerId);
      const nowMs = this.now();
      if (current.specialization_type && current.specialization_unlocks_at && new Date(current.specialization_unlocks_at).getTime() > nowMs) {
        throw new FishingError("FISHING_SPECIALIZATION_LOCKED", `Your ${current.specialization_type} specialization is locked until ${new Date(current.specialization_unlocks_at).toISOString()}.`);
      }
      const unlocksAt = nowMs + FISHING_SPECIALIZATION_DURATION_MS;
      await client.query(`UPDATE fishing_player_progression SET specialization_type=$2,specialization_selected_at=to_timestamp($3/1000.0),specialization_unlocks_at=to_timestamp($4/1000.0),updated_at=clock_timestamp() WHERE player_id=$1`, [player.playerId, type, nowMs, unlocksAt]);
      await client.query(`INSERT INTO fishing_operations(operation_key,player_id,request_id,action,request_hash,fishing_hut_id,result_jsonb) VALUES($1,$2,$3,'specialize',$4,$5,$6::jsonb)`, [operationKey(player.playerId, requestId), player.playerId, requestId, hash, fishingHutId, JSON.stringify({ type, unlocksAt })]);
      const progression = await ensureFishingProgression(client, player.playerId, nowMs);
      const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
      const state = await this.stateInTransaction(client, player, hut, null);
      await client.query("COMMIT");
      return { state, inventory, ...progression, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  /** Start a universal cast from the player's current standing position. */
  async start(player: PlayerRecord, requestId: string, fishingRodId: string, legacyFishingHutId?: string): Promise<FishingEncounterResult> {
    requireRequestId(requestId);
    requirePosition(player);
    requireStationary(player);
    const hash = requestHash("start", player.playerId, fishingRodId, legacyFishingHutId ?? "");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, "start", hash);
        const hut = replay.fishing_hut_id ? await this.requireInRange(client, player, replay.fishing_hut_id, false) : null;
        const encounter = replay.encounter_id ? await requireEncounter(client, replay.encounter_id) : null;
        const state = await this.stateInTransaction(client, player, hut, encounter);
        await client.query("COMMIT");
        return { state, replayed: true };
      }
      // The old direct service call accepted a hut ID. Keep that narrow
      // compatibility path for retained tests, while the realtime contract
      // now supplies the explicit rod identity and no hut is required.
      let hut: FishingHutRow | null = null;
      if (legacyFishingHutId) hut = await this.requireInRange(client, player, legacyFishingHutId, true);
      else {
        const maybeHut = await client.query<{ fishing_hut_id: string }>(`SELECT fishing_hut_id FROM player_fishing_huts WHERE fishing_hut_id=$1::uuid AND removed_at IS NULL`, [fishingRodId]);
        if (maybeHut.rows[0]) hut = await this.requireInRange(client, player, fishingRodId, true);
      }
      let rod = await findUsableRod(client, player.playerId, legacyFishingHutId ? fishingRodId : (hut ? null : fishingRodId));
      if (!rod && hut && !legacyFishingHutId) {
        // Compatibility for pre-rod direct service callers. The player-facing
        // protocol never starts from a hut without an explicit rod.
        rod = await this.createCompatibilityRod(client, player.playerId);
      }
      if (!rod) throw new FishingError("FISHING_ROD_REQUIRED", "Own a Fishing Rod with uses remaining before fishing.");
      const progression = await ensureFishingProgressionRow(client, player.playerId);
      const active = await activeEncounter(client, player.playerId, true);
      if (active) throw new FishingError("FISHING_ENCOUNTER_ACTIVE", "Finish the current fishing encounter first.");
      const seed = this.randomIntFn(0, 2_000_000_000);
      const behaviorProfile = FISHING_BEHAVIOR_PROFILES[seed % FISHING_BEHAVIOR_PROFILES.length]!;
      const behavior = fishingBehaviorAt(behaviorProfile, seed, 0);
      const difficulty = 0.35 + ((seed >>> 3) % 45) / 100;
      const biteAt = this.now() + FISHING_BITE_DELAY_MIN_MS + (seed % (FISHING_BITE_DELAY_MAX_MS - FISHING_BITE_DELAY_MIN_MS + 1));
      const nowMs = this.now();
      const castRangeM = Math.min(
        FISHING_MAX_CAST_RANGE_M,
        FISHING_BASE_CAST_RANGE_M + Number(FISHING_UPGRADE_EFFECTS.cast_range_m[Number(progression.cast_range_rank ?? 0)] ?? 0)
      );
      const candidates = hut
        ? [hutWaterbody(hut)]
        : await this.lookupFishingWaterbodies(player, castRangeM);
      if (candidates.length === 0) throw new FishingError("FISHING_CAST_WATER_REQUIRED", "No authoritative river, lake, or ocean water is within casting range.");
      const selected = hut ? candidates[0] : candidates.length === 1 ? candidates[0] : null;
      const inserted = await client.query<EncounterRow>(
        `INSERT INTO fishing_encounters(
          player_id,fishing_hut_id,rod_id,waterbody_kind,waterbody_source_id,waterbody_name,waterbody_candidates,
          waterbody_source_revision,origin_lat,origin_lon,region_name,country_name,cast_range_m,phase,
          behavior_profile,seed,difficulty,ashen,bite_at,reconnect_deadline_at,last_action_at,fish_direction,fish_pull,stamina
        ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,'cast',$14,$15,$16,$17,to_timestamp($18/1000.0),to_timestamp($19/1000.0),to_timestamp($18/1000.0),$20,$21,$22)
         RETURNING ${ENCOUNTER_FIELDS}`,
        [player.playerId, hut?.fishing_hut_id ?? null, rod.rod_id, selected?.kind ?? null, selected?.sourceId ?? null, selected?.displayName ?? null,
          JSON.stringify(candidates), selected?.sourceRevision ?? null, player.position.lat, player.position.lon,
          await this.worldGeography(player), await this.worldCountry(player), castRangeM,
          behaviorProfile, seed, difficulty, false, biteAt, nowMs + FISHING_ACTIVE_RECONNECT_GRACE_MS,
          behavior.direction, behavior.pull, FISHING_STAMINA_MAX]
      );
      const encounter = requireRow(inserted.rows[0], "Fishing encounter could not be started");
      await client.query(
        `INSERT INTO fishing_operations(operation_key,player_id,request_id,action,request_hash,fishing_hut_id,encounter_id)
         VALUES($1,$2,$3,'start',$4,$5,$6)`,
        [operationKey(player.playerId, requestId), player.playerId, requestId, hash, hut?.fishing_hut_id ?? null, encounter.encounter_id]
      );
      const state = await this.stateInTransaction(client, player, hut, encounter);
      await client.query("COMMIT");
      return { state, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async cast(player: PlayerRecord, requestId: string, encounterId: string, timing: number, castPoint: LatLon, selectedWaterbody?: Readonly<{ kind: FishingWaterbodyKind; sourceId: string | null }>): Promise<FishingEncounterResult> {
    if (!Number.isFinite(timing) || timing < 0 || timing > 1) throw new FishingError("FISHING_INVALID_CAST", "Cast timing must be between 0 and 1.");
    if (!isFiniteLatLon(castPoint.lat, castPoint.lon)) throw new FishingError("FISHING_CAST_INVALID", "Choose a valid spot on the map.");
    return this.mutateEncounter(player, requestId, encounterId, "cast", async (client, encounter) => {
      if (encounter.phase !== "cast") throw new FishingError("FISHING_CAST_INVALID", "The cast window has passed.");
      if (encounter.cast_lat !== null || encounter.cast_lon !== null) throw new FishingError("FISHING_CAST_INVALID", "That line has already been cast.");
      const origin = encounter.origin_lat !== null && encounter.origin_lon !== null
        ? { lat: Number(encounter.origin_lat), lon: Number(encounter.origin_lon) }
        : player.position;
      const castRangeM = Math.min(FISHING_MAX_CAST_RANGE_M, Math.max(0, Number(encounter.cast_range_m ?? FISHING_BASE_CAST_RANGE_M)));
      if (distanceMeters(castPoint, origin) > castRangeM) {
        throw new FishingError("FISHING_CAST_OUT_OF_RANGE", `Choose water within ${castRangeM}m of your standing position.`);
      }
      const validatedCast = await this.validateCastPoint(player, encounter, castPoint, selectedWaterbody);
      // The exact cast-square response is the only authority for the bound
      // identity and name. Nearby start candidates identify eligible choices,
      // but must never replace the exact cell's canonical display name.
      const waterbody = validatedCast.waterbody;
      const rod = await client.query<{ uses_remaining: number }>(`SELECT uses_remaining FROM fishing_rods WHERE rod_id=$1::uuid AND player_id=$2 FOR UPDATE`, [encounter.rod_id, player.playerId]);
      if (!rod.rows[0] || Number(rod.rows[0].uses_remaining) <= 0) throw new FishingError("FISHING_ROD_DEPLETED", "That Fishing Rod has no uses remaining.");
      await client.query(`UPDATE fishing_rods SET uses_remaining=uses_remaining-1,updated_at=clock_timestamp() WHERE rod_id=$1::uuid AND player_id=$2`, [encounter.rod_id, player.playerId]);
      const matchingSpecialization = await this.matchesSpecialization(client, player.playerId, waterbody.kind);
      const quality = Math.max(0, 1 - Math.abs(timing - 0.5) * 2);
      const initialExecutionQuality = 0.35 + quality * 0.3;
      const nowMs = this.now();
      const geo = validatedCast.geoContext;
      const geoWater = geo.water;
      await client.query(`UPDATE fishing_encounters SET cast_lat=$2,cast_lon=$3,waterbody_kind=$4,waterbody_source_id=$5,waterbody_name=$6,waterbody_source_revision=$7,region_name=$8,country_name=$9,country_id=$10,admin1_id=$11,admin1_name=$12,canonical_waterbody_id=$13,gameplay_water_type=$14,canonical_display_name=$15,waterbody_resolution_state=$16,marine_parent_id=$17,marine_parent_name=$18,presentation_name=$19,presentation_relation=$20,presentation_distance_m=$21,geo_context_captured_at=clock_timestamp(),matching_specialization=$22,cast_quality=$23,execution_quality=$24,control_direction='neutral',control_reeling=false,phase=CASE WHEN bite_at <= to_timestamp($25/1000.0) THEN 'bite' ELSE phase END,last_action_at=to_timestamp($25/1000.0),disconnected_at=NULL,reconnect_deadline_at=to_timestamp($26/1000.0),updated_at=clock_timestamp() WHERE encounter_id=$1`, [encounterId, castPoint.lat, castPoint.lon, waterbody.kind, waterbody.sourceId, waterbody.displayName, waterbody.sourceRevision ?? null, validatedCast.regionName, validatedCast.countryName, geo.country.id, geo.admin1.id, geo.admin1.name, geoWater.canonicalWaterbodyId, geoWater.gameplayWaterType, geoWater.canonicalDisplayName, geoWater.resolutionState, geoWater.marineParentId, geoWater.marineParentName, geoWater.presentationName, geoWater.presentationRelation, geoWater.presentationDistanceM, matchingSpecialization, quality, initialExecutionQuality, nowMs, nowMs + FISHING_ACTIVE_RECONNECT_GRACE_MS]);
      return { quantity: 0 };
    }, [
      "cast",
      timing,
      castPoint.lat,
      castPoint.lon,
      selectedWaterbody?.kind ?? "",
      selectedWaterbody?.sourceId ?? ""
    ]);
  }

  async hook(player: PlayerRecord, requestId: string, encounterId: string): Promise<FishingEncounterResult> {
    return this.mutateEncounter(player, requestId, encounterId, "hook", async (client, encounter) => {
      const nowMs = this.now();
      const biteAt = new Date(encounter.bite_at).getTime();
      if (encounter.phase === "cast" && nowMs >= biteAt) {
        await client.query(`UPDATE fishing_encounters SET phase='bite' WHERE encounter_id=$1`, [encounterId]);
        encounter.phase = "bite";
      }
      const biteEvent = fishingBiteEventAt(Number(encounter.seed), biteAt, nowMs);
      if (encounter.phase === "bite" && biteEvent === null) {
        await this.rearmWaitingEncounter(client, encounter, nowMs);
        return { quantity: 0 };
      }
      if (encounter.phase === "bite" && biteEvent?.kind !== "true_strike") {
        // The hook action is intentionally available for every visible cue.
        // A tap on a nibble/fake nibble is a false hook, but it starts the
        // next server-owned waiting cycle instead of ending the encounter.
        await this.rearmWaitingEncounter(client, encounter, nowMs);
        return { quantity: 0 };
      }
      if (encounter.phase !== "bite" || biteEvent?.kind !== "true_strike") {
        const message = biteEvent?.kind === "fake_nibble"
          ? "That tug was only a false nibble. Wait for the true strike."
          : biteEvent?.kind === "nibble"
            ? "The float only twitched. Wait for the true strike."
            : nowMs < biteAt
              ? "The fish has not struck yet."
              : "The strike passed before the hook set.";
        throw new FishingError("FISHING_HOOK_MISSED", message);
      }
      const hookQuality = Math.max(0, 1 - (nowMs - biteEvent.startedAt) / FISHING_TRUE_STRIKE_WINDOW_MS);
      // Fight behavior starts at the actual hook, not at encounter creation.
      // Persist the first cue so the first control step is judged against the
      // direction the player saw when the fight opened.
      const hookBehavior = fishingBehaviorAt(encounter.behavior_profile, Number(encounter.seed), 0);
      await client.query(
        `UPDATE fishing_encounters SET phase='fighting',hooked_at=to_timestamp($4/1000.0),fish_direction=$2,fish_pull=$3,control_direction='neutral',control_reeling=false,execution_quality=GREATEST(0,LEAST(1,execution_quality + $5)),last_action_at=to_timestamp($4/1000.0),disconnected_at=NULL,reconnect_deadline_at=to_timestamp($6/1000.0),updated_at=clock_timestamp() WHERE encounter_id=$1`,
        [encounterId, hookBehavior.direction, hookBehavior.pull, nowMs, hookQuality * 0.2, nowMs + FISHING_ACTIVE_RECONNECT_GRACE_MS]
      );
      return { quantity: 0 };
    });
  }

  private async rearmWaitingEncounter(client: pg.PoolClient, encounter: EncounterRow, nowMs: number): Promise<EncounterRow> {
    const nextBiteAt = nextFishingBiteAt(Number(encounter.seed), nowMs);
    await client.query(
      `UPDATE fishing_encounters SET phase='cast',bite_at=to_timestamp($2/1000.0),hooked_at=NULL,
         control_direction='neutral',control_reeling=false,last_action_at=to_timestamp($3/1000.0),disconnected_at=NULL,
         reconnect_deadline_at=to_timestamp($4/1000.0),updated_at=clock_timestamp()
       WHERE encounter_id=$1`,
      [encounter.encounter_id, nextBiteAt, nowMs, nowMs + FISHING_ACTIVE_RECONNECT_GRACE_MS]
    );
    return {
      ...encounter,
      phase: "cast",
      bite_at: new Date(nextBiteAt),
      hooked_at: null,
      control_direction: "neutral",
      control_reeling: false,
      last_action_at: new Date(nowMs),
      disconnected_at: null,
      reconnect_deadline_at: new Date(nowMs + FISHING_ACTIVE_RECONNECT_GRACE_MS)
    };
  }

  async control(player: PlayerRecord, requestId: string, encounterId: string, direction: FishingControlDirection, reeling: boolean): Promise<FishingEncounterResult> {
    if (!FISHING_CONTROL_DIRECTIONS.includes(direction)) throw new FishingError("FISHING_INVALID_CONTROL", "Unknown fishing control.");
    return this.mutateEncounter(player, requestId, encounterId, "control", async (client, encounter) => {
      if (encounter.phase === "hooked") encounter.phase = "fighting";
      if (encounter.phase !== "fighting") throw new FishingError("FISHING_NOT_FIGHTING", "The fishing line is not in a fight.");
      // Controls are intent transitions. Integrate the intent that was stored
      // for the preceding interval, then persist the new intent for the next
      // one. A delayed first press therefore cannot retroactively apply while
      // the player was reading the HUD.
      const nowMs = this.now();
      const elapsedMs = Math.max(0, Math.min(FISHING_CONTROL_MAX_STEP_MS, nowMs - new Date(encounter.last_action_at).getTime()));
      const priorDirection = encounter.control_direction;
      const priorReeling = encounter.control_reeling;
      const displayedDirection = encounter.fish_direction;
      const directionCountersPull = fishingControlCountersPull(priorDirection, displayedDirection);
      const next = advanceFishingFight({
        distance: Number(encounter.distance), stamina: Number(encounter.stamina), tension: Number(encounter.tension),
        slackMs: Number(encounter.slack_ms), criticalMs: Number(encounter.critical_ms),
        fishDirection: displayedDirection, fishPull: Number(encounter.fish_pull)
      }, { direction: priorDirection, reeling: priorReeling, elapsedMs });
      const progression = await ensureFishingProgressionRow(client, player.playerId);
      const reelEffect = Number(progression.reel_power_rank ?? 0) * 0.05;
      const lineEffect = Number(progression.line_control_rank ?? 0) * 0.05;
      const specializationEffect = encounter.matching_specialization ? FISHING_SPECIALIZATION_HANDLING_EFFECT : 0;
      const distanceEffect = priorReeling ? Math.min(0.25, reelEffect + specializationEffect) : 0;
      const tensionEffect = Math.min(0.25, lineEffect + specializationEffect);
      const tunedTension = tensionEffect > 0 ? next.tension + (50 - next.tension) * tensionEffect : next.tension;
      const tunedNext: FishingFightState = {
        ...next,
        distance: Math.max(0, next.distance * (1 - distanceEffect)),
        tension: Math.max(0, Math.min(100, tunedTension)),
        slackMs: tunedTension < 15 ? next.slackMs : 0,
        criticalMs: tunedTension >= 92 ? next.criticalMs : 0
      };
      const snapped = fishingFightSnapped(tunedNext);
      const hookedAtMs = encounter.hooked_at
        ? new Date(encounter.hooked_at).getTime()
        : new Date(encounter.last_action_at).getTime();
      const nextBehavior = fishingBehaviorAt(encounter.behavior_profile, Number(encounter.seed), Math.max(0, nowMs - hookedAtMs));
      const nextPull = nextBehavior.pull;
      const qualityWeight = elapsedMs / FISHING_CONTROL_UPDATE_INTERVAL_MS;
      const qualityDelta = qualityWeight * (directionCountersPull ? 0.01 : priorDirection === "neutral" ? -0.005 : -0.02);
      await client.query(
        `UPDATE fishing_encounters SET phase=$2,tension=$3,distance=$4,stamina=$5,slack_ms=$6,critical_ms=$7,
           fish_direction=$8,fish_pull=$9,control_direction=$10,control_reeling=$11,
           execution_quality=GREATEST(0,LEAST(1,execution_quality + $12)),last_action_at=to_timestamp($13/1000.0),disconnected_at=NULL,reconnect_deadline_at=to_timestamp($14/1000.0),updated_at=clock_timestamp()
         WHERE encounter_id=$1`,
        [encounterId, snapped ? "escaped" : "fighting", tunedNext.tension, tunedNext.distance, tunedNext.stamina, tunedNext.slackMs, tunedNext.criticalMs, nextBehavior.direction, nextPull, snapped ? "neutral" : direction, snapped ? false : reeling, qualityDelta, nowMs, nowMs + FISHING_ACTIVE_RECONNECT_GRACE_MS]
      );
      return { quantity: 0 };
    }, ["control", direction, reeling ? 1 : 0]);
  }

  async land(player: PlayerRecord, requestId: string, encounterId: string): Promise<FishingEncounterResult> {
    return this.mutateEncounter(player, requestId, encounterId, "land", async (client, encounter) => {
      if (encounter.phase !== "fighting" && encounter.phase !== "hooked") throw new FishingError("FISHING_NOT_LANDABLE", "This fish cannot be landed now.");
      // Landing is a discrete action. Validate the exact authoritative state
      // shown by the fight HUD instead of applying an implicit neutral step
      // that could move an otherwise landable fish out of range while the
      // request is in flight. Fight time advances through bounded controls.
      const elapsedMs = 0;
      const next = advanceFishingFight({
        distance: Number(encounter.distance), stamina: Number(encounter.stamina), tension: Number(encounter.tension),
        slackMs: Number(encounter.slack_ms), criticalMs: Number(encounter.critical_ms), fishDirection: encounter.fish_direction, fishPull: Number(encounter.fish_pull)
      }, { direction: "neutral", reeling: false, elapsedMs });
      if (fishingFightSnapped(next) || !fishingFightCanLand(next)) throw new FishingError("FISHING_LANDING_FAILED", "Keep the line taut and tire the fish before landing it.");
      const metrics = catchMetrics(Number(encounter.seed), Number(encounter.difficulty), Number(encounter.execution_quality));
      const score = fishingCatchScore(metrics);
      const perfect = metrics.executionQuality >= 0.9 && next.criticalMs === 0 && next.slackMs === 0;
      const fishItemId = "freshwater_fish";
      let inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
      let resultQuantity = 0;
      const accumulator = await client.query<{ accumulator_milli: string | number }>(
        `INSERT INTO fishing_food_accumulators(player_id,accumulator_milli) VALUES($1,0) ON CONFLICT(player_id) DO UPDATE SET updated_at=clock_timestamp() RETURNING accumulator_milli`, [player.playerId]
      );
      const oldMilli = Number(accumulator.rows[0]?.accumulator_milli ?? 0);
      const conversion = activeFoodFromAccumulator(oldMilli + activeFoodAccumulatorContribution(metrics.weightLb));
      if (conversion.fish > 0) {
        inventory = (await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `fishing:land:${player.playerId}:${requestId}`,
          playerId: player.playerId, source: "fishing_active", sourceEntityType: "fishing_encounter", sourceEntityId: encounter.encounter_id,
          metadata: { requestId, score, weightLb: metrics.weightLb }, grants: [{ itemId: "freshwater_fish", variant: null, quantity: conversion.fish }]
        })).inventory;
        resultQuantity = conversion.fish;
      }
      await client.query(`UPDATE fishing_food_accumulators SET accumulator_milli=$2,updated_at=clock_timestamp() WHERE player_id=$1`, [player.playerId, conversion.remainderMilli]);
      await client.query(`INSERT INTO fishing_operations(operation_key,player_id,request_id,action,request_hash,fishing_hut_id,encounter_id,result_quantity) VALUES($1,$2,$3,'land',$4,$5,$6,$7)`, [operationKey(player.playerId, requestId), player.playerId, requestId, requestHash("land", player.playerId, encounter.encounter_id, "land"), encounter.fishing_hut_id, encounter.encounter_id, resultQuantity]);
      const startedMs = new Date(encounter.started_at).getTime();
      const caughtAt = new Date(this.now());
      if (!encounter.waterbody_kind || !encounter.waterbody_name) {
        throw new FishingError("FISHING_CAST_WATER_REQUIRED", "The catch has no authoritative waterbody.");
      }
      const persistedCanonicalWaterbodyId = encounter.waterbody_resolution_state === "resolved"
        ? encounter.canonical_waterbody_id?.trim() || null
        : null;
      const persistedWaterbodyResolutionState = encounter.waterbody_resolution_state === "resolved" && !persistedCanonicalWaterbodyId
        ? "invalid"
        : encounter.waterbody_resolution_state ?? "unresolved";
      const persistedCanonicalDisplayName = persistedCanonicalWaterbodyId
        ? encounter.canonical_display_name?.trim() || null
        : null;
      await client.query(
        `UPDATE fishing_encounters SET phase='landed',length_in=$2,weight_lb=$3,size_percentile=$4,score=$5,perfect=$6,
           execution_quality=$7,tension=$8,distance=$9,stamina=$10,control_direction='neutral',control_reeling=false,completed_at=$11,result_quantity=$12,updated_at=clock_timestamp() WHERE encounter_id=$1`,
        [encounter.encounter_id, metrics.lengthIn, metrics.weightLb, metrics.sizePercentile, score, perfect, metrics.executionQuality, next.tension, next.distance, next.stamina, caughtAt, resultQuantity]
      );
      await client.query(
        `INSERT INTO fishing_catch_records(encounter_id,player_id,fishing_hut_id,waterbody_kind,waterbody_source_id,waterbody_name,fish_item_id,fish_species,percentile,ashen,behavior_profile,difficulty,world_source_revision,waterbody_source_revision,environment_schema_version,region_name,country_name,country_id,admin1_id,admin1_name,canonical_waterbody_id,gameplay_water_type,canonical_display_name,waterbody_resolution_state,marine_parent_id,marine_parent_name,presentation_name,presentation_relation,presentation_distance_m,cast_lat,cast_lon,catch_lat,catch_lon,caught_at,length_in,weight_lb,score,perfect,duration_ms,source,week_start,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,'active',
           (timezone('America/Denver',clock_timestamp())::date - ((extract(isodow from timezone('America/Denver',clock_timestamp()))::int)-1)),clock_timestamp())
         ON CONFLICT(encounter_id) DO NOTHING`,
        [encounter.encounter_id, player.playerId, encounter.fishing_hut_id, encounter.waterbody_kind, encounter.waterbody_source_id, encounter.waterbody_name, fishItemId, fishingCatchSpecies(encounter.waterbody_kind), metrics.sizePercentile, false, encounter.behavior_profile, encounter.difficulty, encounter.waterbody_source_revision, encounter.waterbody_source_revision, "gameplay-environment-v1", encounter.region_name ?? "Unknown region", encounter.country_name ?? "Unknown country", encounter.country_id, encounter.admin1_id, encounter.admin1_name ?? encounter.region_name, persistedCanonicalWaterbodyId, encounter.gameplay_water_type ?? encounter.waterbody_kind, persistedCanonicalDisplayName, persistedWaterbodyResolutionState, encounter.marine_parent_id, encounter.marine_parent_name, encounter.presentation_name ?? persistedCanonicalDisplayName ?? encounter.waterbody_name, encounter.presentation_relation ?? "exact", encounter.presentation_distance_m, encounter.cast_lat, encounter.cast_lon, encounter.cast_lat, encounter.cast_lon, caughtAt, metrics.lengthIn, metrics.weightLb, score, perfect, Math.max(0, this.now() - startedMs)]
      );
      return { quantity: resultQuantity, inventory };
    }, ["land"]);
  }

  async cancel(player: PlayerRecord, requestId: string, encounterId: string): Promise<FishingEncounterResult> {
    return this.mutateEncounter(player, requestId, encounterId, "cancel", async (client, encounter) => {
      await client.query(`UPDATE fishing_encounters SET phase='cancelled',control_direction='neutral',control_reeling=false,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE encounter_id=$1`, [encounter.encounter_id]);
      return { quantity: 0 };
    }, ["cancel"]);
  }

  async activeEncounterForPlayer(playerId: string): Promise<FishingEncounterSnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const encounter = await this.refreshEncounter(client, playerId, null, true);
      await client.query("COMMIT");
      return encounter ? mapEncounter(encounter, this.now()) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  /** Mark a retryable socket loss without ending the durable encounter. */
  async markDisconnected(playerId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const encounter = await activeEncounter(client, playerId, true);
      if (encounter) {
        const nowMs = this.now();
        await client.query(
          `UPDATE fishing_encounters SET control_direction='neutral',control_reeling=false,disconnected_at=to_timestamp($2/1000.0),reconnect_deadline_at=to_timestamp($3/1000.0),updated_at=clock_timestamp() WHERE encounter_id=$1`,
          [encounter.encounter_id, nowMs, nowMs + FISHING_ACTIVE_RECONNECT_GRACE_MS]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  /** End an encounter on a terminal logout/close so it cannot be resumed later. */
  async cancelForDisconnect(playerId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const encounter = await activeEncounter(client, playerId, true);
      if (encounter) {
        await client.query(`UPDATE fishing_encounters SET phase='cancelled',control_direction='neutral',control_reeling=false,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE encounter_id=$1`, [encounter.encounter_id]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async resumeState(player: PlayerRecord): Promise<FishingStateSnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const encounter = await this.refreshEncounter(client, player.playerId, null, true);
      if (!encounter) { await client.query("COMMIT"); return null; }
      const hut = encounter.fishing_hut_id ? await requireHut(client, encounter.fishing_hut_id) : null;
      const state = await this.stateInTransaction(client, player, hut, encounter);
      await client.query("COMMIT");
      return state;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async cancelForMovement(playerId: string): Promise<FishingEncounterSnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const encounter = await activeEncounter(client, playerId, true);
      if (!encounter) { await client.query("COMMIT"); return null; }
      await client.query(`UPDATE fishing_encounters SET phase='cancelled',control_direction='neutral',control_reeling=false,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE encounter_id=$1`, [encounter.encounter_id]);
      await client.query("COMMIT");
      return mapEncounter({ ...encounter, phase: "cancelled" }, this.now());
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async records(player: PlayerRecord, fishingHutId: string | null = null): Promise<FishingRecordSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const hut = fishingHutId ? await this.requireInRange(client, player, fishingHutId, false) : null;
      const activeFilter = "source='active'";
      const [heaviest, highest, personalWeight, personalScore, personalPerfect, weekly, weeklyTop, recent] = await Promise.all([
        client.query<EncounterRecordRow>(`${RECORD_SELECT} WHERE ${activeFilter} ORDER BY weight_lb DESC,created_at ASC,catch_id LIMIT 1`),
        client.query<EncounterRecordRow>(`${RECORD_SELECT} WHERE ${activeFilter} ORDER BY score DESC,created_at ASC,catch_id LIMIT 1`),
        client.query<EncounterRecordRow>(`${RECORD_SELECT} WHERE ${activeFilter} AND player_id=$1 ORDER BY weight_lb DESC,created_at ASC,catch_id LIMIT 1`, [player.playerId]),
        client.query<EncounterRecordRow>(`${RECORD_SELECT} WHERE ${activeFilter} AND player_id=$1 ORDER BY score DESC,created_at ASC,catch_id LIMIT 1`, [player.playerId]),
        client.query<EncounterRecordRow>(`${RECORD_SELECT} WHERE ${activeFilter} AND player_id=$1 AND perfect ORDER BY score DESC,weight_lb DESC,created_at ASC,catch_id LIMIT 1`, [player.playerId]),
        client.query<{ sum: string | number }>(`SELECT COALESCE(SUM(score),0)::int AS sum FROM (SELECT score FROM fishing_catch_records WHERE source='active' AND player_id=$1 AND week_start=(timezone('America/Denver',clock_timestamp())::date - ((extract(isodow from timezone('America/Denver',clock_timestamp()))::int)-1)) ORDER BY score DESC,created_at ASC,catch_id LIMIT 5) best`, [player.playerId]),
        client.query<WeeklyAnglerRow>(`WITH ranked AS (
          SELECT catches.player_id,owner.username,catches.score,
            row_number() OVER (PARTITION BY catches.player_id ORDER BY catches.score DESC,catches.created_at ASC,catches.catch_id) AS rank
          FROM fishing_catch_records catches
          JOIN players owner ON owner.id=catches.player_id
          WHERE catches.source='active' AND catches.week_start=(timezone('America/Denver',clock_timestamp())::date - ((extract(isodow from timezone('America/Denver',clock_timestamp()))::int)-1))
        )
        SELECT player_id,username,SUM(score)::int AS score,COUNT(*)::int AS catch_count
        FROM ranked WHERE rank <= 5
        GROUP BY player_id,username
        ORDER BY SUM(score) DESC,player_id
        LIMIT 5`),
        client.query<EncounterRecordRow>(`${RECORD_SELECT} WHERE ${activeFilter} AND player_id=$1 ORDER BY created_at DESC,catch_id LIMIT 5`, [player.playerId])
      ]);
      await client.query("COMMIT");
      return {
        waterbody: hut ? hutWaterbody(hut) : null,
        heaviest: heaviest.rows[0] ? mapCatch(heaviest.rows[0]) : null,
        highestScore: highest.rows[0] ? mapCatch(highest.rows[0]) : null,
        personalBestWeight: personalWeight.rows[0] ? mapCatch(personalWeight.rows[0]) : null,
        personalBestScore: personalScore.rows[0] ? mapCatch(personalScore.rows[0]) : null,
        personalBestPerfect: personalPerfect.rows[0] ? mapCatch(personalPerfect.rows[0]) : null,
        ashenCatches: [], // legacy wire field: older clients still require it
        weeklyBestFiveScore: Number(weekly.rows[0]?.sum ?? 0),
        weeklyTopAnglers: weeklyTop.rows.map((row) => ({
          playerId: row.player_id,
          username: row.username,
          score: Number(row.score),
          catchCount: Number(row.catch_count)
        } satisfies FishingWeeklyAnglerSnapshot)),
        recentCatches: recent.rows.map(mapCatch)
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async mutateEncounter(player: PlayerRecord, requestId: string, encounterId: string, action: OperationRow["action"], fn: (client: pg.PoolClient, encounter: EncounterRow, hut: FishingHutRow | null) => Promise<{ quantity: number; inventory?: PlayerInventorySnapshot }>, hashParts: readonly (string | number)[] = []): Promise<FishingEncounterResult> {
    requireRequestId(requestId);
    requirePosition(player);
    const hash = requestHash(action, player.playerId, encounterId, ...hashParts);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOperation(client, player.playerId, requestId);
      const replay = await previousOperation(client, player.playerId, requestId);
      if (replay) {
        requireMatchingOperation(replay, action, hash);
        const hut = replay.fishing_hut_id ? await this.requireInRange(client, player, replay.fishing_hut_id, false) : null;
        const encounter = replay.encounter_id ? await requireEncounter(client, replay.encounter_id) : null;
        const state = await this.stateInTransaction(client, player, hut, encounter);
        await client.query("COMMIT");
        return { state, replayed: true, ...(action === "land" ? { collectedQuantity: replay.result_quantity } : {}) };
      }
      let encounter = await requireEncounter(client, encounterId, true);
      if (encounter.player_id !== player.playerId) throw new FishingError("FISHING_NOT_OWNER", "That fishing encounter belongs to another player.");
      const nowMs = this.now();
      const reconnectDeadline = new Date(encounter.reconnect_deadline_at).getTime();
      const lastAction = new Date(encounter.last_action_at).getTime();
      const waitingPhase = encounter.phase === "cast" || encounter.phase === "bite";
      if ((encounter.disconnected_at !== null && nowMs > reconnectDeadline) || (!waitingPhase && nowMs - lastAction > FISHING_ACTIVE_ENCOUNTER_TIMEOUT_MS)) {
        await client.query(`UPDATE fishing_encounters SET phase='expired',control_direction='neutral',control_reeling=false,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE encounter_id=$1`, [encounter.encounter_id]);
        await client.query("COMMIT");
        throw new FishingError("FISHING_ENCOUNTER_EXPIRED", "The fishing encounter expired before that action arrived.");
      }
      if (encounter.disconnected_at !== null) {
        await client.query(
          `UPDATE fishing_encounters SET disconnected_at=NULL,control_direction='neutral',control_reeling=false,last_action_at=to_timestamp($2/1000.0),reconnect_deadline_at=to_timestamp($3/1000.0),updated_at=clock_timestamp() WHERE encounter_id=$1`,
          [encounter.encounter_id, nowMs, nowMs + FISHING_ACTIVE_RECONNECT_GRACE_MS]
        );
        encounter = { ...encounter, disconnected_at: null, last_action_at: new Date(nowMs), reconnect_deadline_at: new Date(nowMs + FISHING_ACTIVE_RECONNECT_GRACE_MS) };
      }
      const hut = encounter.fishing_hut_id ? await this.requireInRange(client, player, encounter.fishing_hut_id, false) : null;
      const result = await fn(client, encounter, hut);
      if (action !== "land") {
        await client.query(
          `INSERT INTO fishing_operations(operation_key,player_id,request_id,action,request_hash,fishing_hut_id,encounter_id,result_quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [operationKey(player.playerId, requestId), player.playerId, requestId, action, hash, encounter.fishing_hut_id, encounter.encounter_id, result.quantity]
        );
      }
      const updatedEncounter = await requireEncounter(client, encounterId);
      const state = await this.stateInTransaction(client, player, hut, updatedEncounter);
      await client.query("COMMIT");
      return {
        state,
        replayed: false,
        ...(result.inventory ? { inventory: result.inventory } : {}),
        collectedQuantity: result.quantity
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async stateInTransaction(client: pg.PoolClient, player: PlayerRecord, hut: FishingHutRow | null, encounter: EncounterRow | null): Promise<FishingStateSnapshot> {
    const best = await client.query<{ weight: number | null; score: number | null }>(
      `SELECT max(weight_lb) AS weight,max(score) AS score FROM fishing_catch_records WHERE source='active' AND player_id=$1`, [player.playerId]
    );
    const weekly = await client.query<{ sum: string | number }>(
      `SELECT COALESCE(SUM(score),0)::int AS sum FROM (SELECT score FROM fishing_catch_records WHERE source='active' AND player_id=$1 AND week_start=(timezone('America/Denver',clock_timestamp())::date - ((extract(isodow from timezone('America/Denver',clock_timestamp()))::int)-1)) ORDER BY score DESC,created_at ASC,catch_id LIMIT 5) best`, [player.playerId]
    );
    let catchId: string | null = null;
    if (encounter?.phase === "landed") {
      const catchResult = await client.query<{ catch_id: string }>(
        `SELECT catch_id FROM fishing_catch_records WHERE encounter_id=$1::uuid AND source='active' LIMIT 1`,
        [encounter.encounter_id]
      );
      catchId = catchResult.rows[0]?.catch_id ?? null;
    }
    const progression = await ensureFishingProgression(client, player.playerId, this.now());
    return {
      hut: (hut ? mapHut(hut, this.now()) : null) as unknown as FishingHutWorldSnapshot,
      encounter: encounter ? mapEncounter(encounter, this.now(), catchId) : null,
      personalBestWeightLb: best.rows[0]?.weight == null ? null : Number(best.rows[0].weight),
      personalBestScore: best.rows[0]?.score == null ? null : Number(best.rows[0].score),
      weeklyBestFiveScore: Number(weekly.rows[0]?.sum ?? 0),
      serverTime: this.now(),
      upgrades: progression.upgrades,
      specialization: progression.specialization
    };
  }

  private async requireInRange(queryable: Pick<pg.Pool | pg.PoolClient, "query">, player: PlayerRecord, fishingHutId: string, lock: boolean): Promise<FishingHutRow> {
    const result = await queryable.query<FishingHutRow>(`${HUT_SELECT} WHERE hut.fishing_hut_id=$1::uuid AND hut.removed_at IS NULL AND hut.world_id=$2 AND hut.region_code=$3
      AND ST_DWithin(hut.geom::geography,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,$6) ${lock ? "FOR UPDATE OF hut" : ""}`,
      [fishingHutId, this.worldId, player.regionCode, player.position.lon, player.position.lat, FISHING_HUT_INTERACTION_RADIUS_M]);
    if (!result.rows[0]) throw new FishingError("FISHING_RANGE_REQUIRED", `Move within ${FISHING_HUT_INTERACTION_RADIUS_M}m of the Fishing Hut to use it.`);
    return result.rows[0];
  }

  private async lookupFreshwater(player: PlayerRecord): Promise<FreshwaterWaterbodyIdentity> {
    let result: WorldGameplayEnvironmentResult;
    try { result = await this.worldLookup.lookupGameplayEnvironment(player.position.lat, player.position.lon); }
    catch { throw new FishingError("FISHING_WORLD_UNAVAILABLE", "Freshwater placement authority is unavailable. Try again shortly."); }
    if (!result.ok) throw new FishingError("FISHING_WORLD_UNAVAILABLE", result.failure?.message ?? "Freshwater placement authority is unavailable.");
    if (!isCanonicalFishingLand(result)) {
      throw new FishingError("FISHING_WATER_REQUIRED", "Fishing Huts must be placed on land within 500m of an authoritative waterbody.");
    }
    let canonicalWaterbody;
    try {
      const candidates = this.worldLookup.lookupCanonicalWaterbodiesNear
        ? await this.worldLookup.lookupCanonicalWaterbodiesNear(
          player.position,
          result,
          FISHING_HUT_MAX_WATER_DISTANCE_M
        )
        : [await this.worldLookup.lookupCanonicalWaterbodyNear(
          player.position,
          result,
          FISHING_HUT_MAX_WATER_DISTANCE_M
        )];
      // Hut construction remains freshwater-only even when the universal
      // search also finds a nearer ocean candidate.
      canonicalWaterbody = candidates.find((candidate) => candidate.kind === "lake" || candidate.kind === "river")
        ?? candidates[0];
    } catch {
      throw new FishingError("FISHING_WORLD_UNAVAILABLE", "Freshwater placement authority is unavailable. Try again shortly.");
    }
    if (!canonicalWaterbody || !canonicalWaterbody.searchComplete) {
      throw new FishingError("FISHING_WORLD_UNAVAILABLE", "Freshwater placement authority is unavailable. Try again shortly.");
    }
    const waterbody = selectFreshwaterWaterbody({
      isLand: result.isLand === true,
      isSaltwater: result.isSaltwater === true,
      insideMajorLake: result.insideMajorLake === true,
      majorLakeId: result.majorLakeId ?? null,
      majorLakeName: result.majorLakeName ?? null,
      majorLakeDistanceM: result.majorLakeDistanceM ?? null,
      majorLakeSearchComplete: result.majorLakeSearchComplete === true,
      namedRiverId: result.namedRiverId ?? null,
      namedRiverName: result.namedRiverName ?? null,
      riverDistanceM: result.riverDistanceM ?? null,
      namedRiverSearchComplete: result.namedRiverSearchComplete === true,
      sourceRevision: canonicalWaterbody.sourceRevision ?? null,
      canonicalWaterbody
    });
    if (!waterbody || waterbody.distanceM > FISHING_HUT_MAX_WATER_DISTANCE_M) {
      throw new FishingError("FISHING_WATER_REQUIRED", "Fishing Huts must be placed on land within 500m of an authoritative waterbody.");
    }
    const gameplayRegionCode = packageIdForPosition(player.position);
    if (player.regionCode !== gameplayRegionCode || result.packageId !== gameplayRegionCode) {
      throw new FishingError("FISHING_REGION_MISMATCH", "The World region changed; try placing the hut again.");
    }
    return waterbody;
  }

  private async validateCastPoint(player: PlayerRecord, encounter: EncounterRow, castPoint: LatLon, selectedWaterbody?: Readonly<{ kind: FishingWaterbodyCandidate["kind"]; sourceId: string | null }>): Promise<ValidatedCast> {
    let world: WorldGameplayEnvironmentResult;
    try {
      world = await this.worldLookup.lookupGameplayEnvironment(castPoint.lat, castPoint.lon);
    } catch {
      throw new FishingError("FISHING_WORLD_UNAVAILABLE", "Fishing water authority is unavailable. Try the cast again shortly.");
    }
    if (!world.ok) {
      throw new FishingError("FISHING_WORLD_UNAVAILABLE", world.failure?.message ?? "Fishing water authority is unavailable. Try the cast again shortly.");
    }
    const gameplayRegionCode = packageIdForPosition(player.position);
    const castRegionCode = packageIdForPosition(castPoint);
    if (
      player.regionCode !== gameplayRegionCode ||
      world.packageId !== castRegionCode
    ) {
      throw new FishingError("FISHING_REGION_MISMATCH", "The World region changed; try the cast again.");
    }
    let canonicalWaterbody;
    try {
      canonicalWaterbody = await this.worldLookup.lookupCanonicalWaterbodyNear(castPoint, world, 0);
    } catch {
      throw new FishingError("FISHING_WORLD_UNAVAILABLE", "Fishing water authority is unavailable. Try the cast again shortly.");
    }
    if (!canonicalWaterbody.searchComplete) {
      throw new FishingError("FISHING_WORLD_UNAVAILABLE", "Fishing water authority could not complete this exact square lookup.");
    }
    const waterbody = selectFishingWaterbody(canonicalWaterbody, 0);
    if (
      !waterbody ||
      !isFishableCanonicalSurface(world, waterbody.kind) ||
      !Number.isFinite(canonicalWaterbody.distanceM ?? Number.NaN) ||
      (canonicalWaterbody.distanceM as number) !== 0
    ) {
      throw new FishingError("FISHING_CAST_WATER_REQUIRED", "Cast onto a final authoritative river, lake, or ocean square.");
    }
    if (selectedWaterbody && (selectedWaterbody.kind !== waterbody.kind || selectedWaterbody.sourceId !== waterbody.sourceId)) {
      throw new FishingError("FISHING_CAST_WATERBODY_REQUIRED", "That square is not part of the selected waterbody.");
    }
    const candidates = encounter.waterbody_candidates ?? [];
    if (candidates.length > 1 && !selectedWaterbody && !encounter.waterbody_kind) {
      throw new FishingError("FISHING_WATERBODY_SELECTION_REQUIRED", "Choose a waterbody before choosing a cast square.");
    }
    if (candidates.length > 0 && !candidates.some((candidate) => candidate.kind === waterbody.kind && candidate.sourceId === waterbody.sourceId)) {
      throw new FishingError("FISHING_CAST_WATERBODY_REQUIRED", "Cast onto one of the waterbodies offered for this encounter.");
    }
    if (encounter.waterbody_kind && (waterbody.kind !== encounter.waterbody_kind || waterbody.sourceId !== encounter.waterbody_source_id)) {
      throw new FishingError("FISHING_CAST_WATERBODY_REQUIRED", `Cast onto ${encounter.waterbody_name ?? "the selected waterbody"}.`);
    }
    const geoContext = geoContextFromWorldEnvironment(world, { proximities: [canonicalWaterbody] });
    return {
      waterbody,
      regionName: world.regionName?.trim() || world.regionCode?.trim() || "Unknown region",
      countryName: world.countryName?.trim() || world.countryCode?.trim() || "Unknown country",
      geoContext
    };
  }

  private async lookupFishingWaterbodies(player: PlayerRecord, maxDistanceM: number): Promise<FishingWaterbodyCandidate[]> {
    let world: WorldGameplayEnvironmentResult;
    try {
      world = await this.worldLookup.lookupGameplayEnvironment(player.position.lat, player.position.lon);
    } catch {
      throw new FishingError("FISHING_WORLD_UNAVAILABLE", "Fishing water authority is unavailable. Try again shortly.");
    }
    if (!world.ok) throw new FishingError("FISHING_WORLD_UNAVAILABLE", world.failure?.message ?? "Fishing water authority is unavailable.");
    const raw = this.worldLookup.lookupCanonicalWaterbodiesNear
      ? await this.worldLookup.lookupCanonicalWaterbodiesNear(player.position, world, maxDistanceM)
      : [await this.worldLookup.lookupCanonicalWaterbodyNear(player.position, world, maxDistanceM)];
    if (raw.some((candidate) => !candidate.searchComplete)) {
      throw new FishingError("FISHING_WORLD_UNAVAILABLE", "Fishing water authority could not complete the exact casting-area search.");
    }
    return raw.map((candidate) => selectFishingWaterbody(candidate, maxDistanceM)).filter((candidate): candidate is FishingWaterbodyCandidate => candidate !== null);
  }

  private async createCompatibilityRod(client: pg.PoolClient, playerId: string): Promise<{ rod_id: string; uses_remaining: number }> {
    const inserted = await client.query<{ rod_id: string; uses_remaining: number }>(
      `INSERT INTO fishing_rods(player_id,uses_remaining) VALUES($1,$2) RETURNING rod_id::text,uses_remaining`,
      [playerId, FISHING_ROD_MAX_USES]
    );
    const rod = requireRow(inserted.rows[0], "Fishing Rod could not be initialized");
    await this.inventory.grantItemsForOperationInTransaction(client, {
      operationKey: `fishing:legacy-rod:${playerId}:${rod.rod_id}`,
      playerId,
      source: "fishing_legacy_compatibility",
      sourceEntityType: "fishing_rod",
      sourceEntityId: rod.rod_id,
      grants: [{ itemId: "fishing_rod", variant: rod.rod_id, quantity: 1 }]
    });
    return rod;
  }

  private async matchesSpecialization(client: pg.PoolClient, playerId: string, kind: FishingWaterbodyCandidate["kind"]): Promise<boolean> {
    const row = await client.query<{ specialization_type: FishingSpecializationType | null; specialization_unlocks_at: Date | string | null }>(
      `SELECT specialization_type,specialization_unlocks_at FROM fishing_player_progression WHERE player_id=$1`, [playerId]
    );
    const current = row.rows[0];
    return Boolean(current?.specialization_type === kind && current.specialization_unlocks_at && new Date(current.specialization_unlocks_at).getTime() > this.now());
  }

  private async worldGeography(player: PlayerRecord): Promise<string> {
    try {
      const result = await this.worldLookup.lookupGameplayEnvironment(player.position.lat, player.position.lon);
      return result.regionName?.trim() || result.regionCode?.trim() || "Unknown region";
    } catch { return "Unknown region"; }
  }

  private async worldCountry(player: PlayerRecord): Promise<string> {
    try {
      const result = await this.worldLookup.lookupGameplayEnvironment(player.position.lat, player.position.lon);
      return result.countryName?.trim() || result.countryCode?.trim() || "Unknown country";
    } catch { return "Unknown country"; }
  }

  private async worldMetadata(player: PlayerRecord): Promise<Record<string, unknown>> {
    try {
      const result = await this.worldLookup.lookupGameplayEnvironment(player.position.lat, player.position.lon);
      return { release: result.release ?? null, worldReleaseId: result.worldReleaseId ?? null, sourceVersions: result.sourceVersions ?? {}, environmentSchemaVersion: result.environmentSchemaVersion ?? null };
    } catch { return {}; }
  }

  private async completeBuild(buildId: string): Promise<FishingBuildCompletion | FishingBuildCancellation | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ owner_player_id: string }>(`SELECT owner_player_id FROM fishing_hut_build_jobs WHERE build_id=$1::uuid`, [buildId]);
      if (!owner.rows[0]) { await client.query("COMMIT"); return null; }
      await lockBuildChannel(client, owner.rows[0].owner_player_id);
      const result = await client.query<BuildRow>(`SELECT ${BUILD_FIELDS} FROM fishing_hut_build_jobs WHERE build_id=$1::uuid FOR UPDATE`, [buildId]);
      const build = result.rows[0];
      if (!build || build.status !== "constructing" || new Date(build.completes_at).getTime() > this.now()) { await client.query("COMMIT"); return null; }
      if (await hasActiveHut(client, build.owner_player_id) || !(await hasPersonalTerritoryByPoint(client, build.owner_player_id, { lat: Number(build.lat), lon: Number(build.lon) }))) {
        const cancelled = await this.cancelBuildInTransaction(client, build, "revalidation-failed");
        await client.query("COMMIT");
        return cancelled;
      }
      const inserted = await client.query<{ fishing_hut_id: string }>(
        `INSERT INTO player_fishing_huts(owner_player_id,world_id,region_code,lat,lon,geom,waterbody_kind,waterbody_source_id,waterbody_name,waterbody_distance_m,world_source_revision,world_source_metadata,built_at)
         VALUES($1,$2,$3,$4,$5,ST_SetSRID(ST_MakePoint($5,$4),4326),$6,$7,$8,$9,$10,$11,to_timestamp($12/1000.0)) RETURNING fishing_hut_id`,
        [build.owner_player_id, build.world_id, build.region_code, build.lat, build.lon, build.waterbody_kind, build.waterbody_source_id, build.waterbody_name, build.waterbody_distance_m, build.world_source_revision, JSON.stringify(build.world_source_metadata ?? {}), new Date(build.completes_at).getTime()]
      );
      const hutId = requireRow(inserted.rows[0], "Fishing Hut placement failed").fishing_hut_id;
      await client.query(`UPDATE fishing_hut_build_jobs SET status='completed',fishing_hut_id=$2::uuid,updated_at=clock_timestamp() WHERE build_id=$1::uuid`, [build.build_id, hutId]);
      await client.query(`INSERT INTO fishing_operations(operation_key,player_id,request_id,action,request_hash,fishing_hut_id) VALUES($1,$2,$3,'build',$4,$5)`, [operationKey(build.owner_player_id, build.request_id), build.owner_player_id, build.request_id, build.request_hash, hutId]);
      const hut = await requireHut(client, hutId);
      const inventory = await this.inventory.snapshotInTransaction(client, build.owner_player_id);
      await client.query("COMMIT");
      return { playerId: build.owner_player_id, requestId: build.request_id, hut: mapHut(hut, this.now()), inventory };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async cancelBuildInTransaction(client: pg.PoolClient, build: BuildRow, reason: string): Promise<FishingBuildCancellation> {
    const refund = await this.inventory.grantItemsForOperationInTransaction(client, {
      operationKey: `fishing:build:${build.owner_player_id}:${build.request_id}:refund`, playerId: build.owner_player_id,
      source: "fishing_hut_construction_cancelled", sourceEntityType: "fishing_hut_build", sourceEntityId: build.build_id,
      metadata: { requestId: build.request_id, reason }, allowPartial: true,
      grants: [{ itemId: "stone", variant: null, quantity: FISHING_HUT_BUILD_COST.stone }, { itemId: "wood", variant: null, quantity: FISHING_HUT_BUILD_COST.wood }]
    });
    const droppedItems = await createSystemGroundDropsInTransaction(client, {
      operationKey: `fishing:build:${build.owner_player_id}:${build.request_id}:refund-drop`, droppedByPlayerId: build.owner_player_id,
      regionCode: build.region_code, position: { lat: Number(build.lat), lon: Number(build.lon) }, reason: "fishing_hut_construction_cancelled",
      lines: [{ itemId: "stone", quantity: Math.max(0, FISHING_HUT_BUILD_COST.stone - (refund.grants.find((grant) => grant.itemId === "stone")?.grantedQuantity ?? 0)), variant: null }, { itemId: "wood", quantity: Math.max(0, FISHING_HUT_BUILD_COST.wood - (refund.grants.find((grant) => grant.itemId === "wood")?.grantedQuantity ?? 0)), variant: null }].filter((line) => line.quantity > 0)
    });
    await client.query(`UPDATE fishing_hut_build_jobs SET status='cancelled',cancel_reason=$2,updated_at=clock_timestamp() WHERE build_id=$1::uuid AND status='constructing'`, [build.build_id, reason]);
    return { playerId: build.owner_player_id, requestId: build.request_id, buildId: build.build_id, inventory: refund.inventory, droppedItems, reason };
  }
}

type EncounterRecordRow = {
  catch_id: string;
  encounter_id: string;
  fishing_hut_id: string | null;
  player_id: string;
  player_username: string;
  waterbody_kind: "lake" | "river" | "ocean";
  waterbody_source_id: string | null;
  waterbody_name: string;
  fish_item_id: "freshwater_fish" | "ashen_fish";
  ashen: boolean;
  behavior_profile: FishingBehaviorProfile;
  difficulty: number;
  world_source_revision: string | null;
  environment_schema_version: string | null;
  length_in: number;
  weight_lb: number;
  score: number;
  perfect: boolean;
  duration_ms: number;
  waterbody_source_revision: string | null;
  fish_species: string;
  percentile: number;
  region_name: string;
  country_name: string;
  country_id: string | null;
  admin1_id: string | null;
  admin1_name: string | null;
  canonical_waterbody_id: string | null;
  gameplay_water_type: "lake" | "river" | "ocean" | null;
  canonical_display_name: string | null;
  waterbody_resolution_state: "resolved" | "unresolved" | "ambiguous" | "invalid" | "not_applicable" | null;
  marine_parent_id: string | null;
  marine_parent_name: string | null;
  presentation_name: string | null;
  presentation_relation: "exact" | "near" | "unnamed" | "open_ocean" | null;
  presentation_distance_m: number | null;
  cast_lat: number | null;
  cast_lon: number | null;
  catch_lat: number | null;
  catch_lon: number | null;
  caught_at: Date | string | null;
  source: "active" | "passive";
  created_at: Date | string;
};

type WeeklyAnglerRow = {
  player_id: string;
  username: string;
  score: string | number;
  catch_count: string | number;
};

const HUT_SELECT = `SELECT hut.fishing_hut_id,hut.owner_player_id,owner.username AS owner_username,hut.world_id,hut.region_code,hut.lat,hut.lon,
  hut.waterbody_kind,hut.waterbody_source_id,hut.waterbody_name,hut.waterbody_distance_m,hut.world_source_revision,
  hut.passive_last_produced_at,hut.passive_stored_quantity,hut.passive_capacity,hut.placement_revision::text,hut.built_at
  FROM player_fishing_huts hut JOIN players owner ON owner.id=hut.owner_player_id`;
const BUILD_FIELDS = `build_id,owner_player_id,request_id,request_hash,world_id,region_code,lat,lon,waterbody_kind,waterbody_source_id,waterbody_name,waterbody_distance_m,world_source_revision,world_source_metadata,status,started_at,completes_at,fishing_hut_id,cancel_reason`;
const ENCOUNTER_FIELDS = `encounter_id,player_id,fishing_hut_id,waterbody_kind,waterbody_source_id,waterbody_name,rod_id,(SELECT uses_remaining FROM fishing_rods rod WHERE rod.rod_id=fishing_encounters.rod_id) AS rod_uses_remaining,waterbody_source_revision,waterbody_candidates,origin_lat,origin_lon,region_name,country_name,country_id,admin1_id,admin1_name,canonical_waterbody_id,gameplay_water_type,canonical_display_name,waterbody_resolution_state,marine_parent_id,marine_parent_name,presentation_name,presentation_relation,presentation_distance_m,geo_context_captured_at,cast_range_m,matching_specialization,phase,behavior_profile,seed,difficulty,ashen,cast_lat,cast_lon,cast_quality,length_in,weight_lb,size_percentile,score,perfect,tension,distance,stamina,slack_ms,critical_ms,fish_direction,fish_pull,control_direction,control_reeling,execution_quality,started_at,bite_at,hooked_at,last_action_at,reconnect_deadline_at,disconnected_at,completed_at`;
const RECORD_SELECT = `SELECT catches.catch_id,catches.encounter_id,catches.fishing_hut_id,catches.player_id,owner.username AS player_username,catches.waterbody_kind,catches.waterbody_source_id,catches.waterbody_name,catches.fish_item_id,catches.ashen,catches.behavior_profile,catches.difficulty,catches.world_source_revision,catches.environment_schema_version,catches.waterbody_source_revision,catches.length_in,catches.weight_lb,catches.score,catches.perfect,catches.duration_ms,catches.fish_species,
  COALESCE(NULLIF(catches.percentile,0),(SELECT encounter.size_percentile FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id),catches.percentile) AS percentile,
  COALESCE(NULLIF(catches.region_name,'Unknown region'),(SELECT NULLIF(BTRIM(encounter.region_name),'') FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id),catches.region_name,'Unknown region') AS region_name,
  COALESCE(NULLIF(catches.country_name,'Unknown country'),(SELECT NULLIF(BTRIM(encounter.country_name),'') FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id),catches.country_name,'Unknown country') AS country_name,
  COALESCE(catches.country_id,(SELECT encounter.country_id FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id)) AS country_id,
  COALESCE(catches.admin1_id,(SELECT encounter.admin1_id FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id)) AS admin1_id,
  COALESCE(NULLIF(BTRIM(catches.admin1_name),''),(SELECT NULLIF(BTRIM(encounter.admin1_name),'') FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id),NULLIF(BTRIM(catches.region_name),'')) AS admin1_name,
  COALESCE(catches.canonical_waterbody_id,(SELECT encounter.canonical_waterbody_id FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id)) AS canonical_waterbody_id,
  COALESCE(catches.gameplay_water_type,(SELECT encounter.gameplay_water_type FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id)) AS gameplay_water_type,
  COALESCE(NULLIF(BTRIM(catches.canonical_display_name),''),(SELECT NULLIF(BTRIM(encounter.canonical_display_name),'') FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id)) AS canonical_display_name,
  COALESCE(catches.waterbody_resolution_state,(SELECT encounter.waterbody_resolution_state FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id)) AS waterbody_resolution_state,
  COALESCE(catches.marine_parent_id,(SELECT encounter.marine_parent_id FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id)) AS marine_parent_id,
  COALESCE(NULLIF(BTRIM(catches.marine_parent_name),''),(SELECT NULLIF(BTRIM(encounter.marine_parent_name),'') FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id)) AS marine_parent_name,
  COALESCE(NULLIF(BTRIM(catches.presentation_name),''),(SELECT NULLIF(BTRIM(encounter.presentation_name),'') FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id)) AS presentation_name,
  COALESCE(catches.presentation_relation,(SELECT encounter.presentation_relation FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id)) AS presentation_relation,
  COALESCE(catches.presentation_distance_m,(SELECT encounter.presentation_distance_m FROM fishing_encounters encounter WHERE encounter.encounter_id=catches.encounter_id)) AS presentation_distance_m,
  catches.cast_lat,catches.cast_lon,catches.catch_lat,catches.catch_lon,catches.caught_at,catches.source,catches.created_at FROM fishing_catch_records catches JOIN players owner ON owner.id=catches.player_id`;

async function requireHut(queryable: Pick<pg.Pool | pg.PoolClient, "query">, fishingHutId: string): Promise<FishingHutRow> {
  const result = await queryable.query<FishingHutRow>(`${HUT_SELECT} WHERE hut.fishing_hut_id=$1::uuid AND hut.removed_at IS NULL`, [fishingHutId]);
  return requireRow(result.rows[0], "Fishing Hut no longer exists");
}
async function buildForRequest(queryable: Pick<pg.Pool | pg.PoolClient, "query">, playerId: string, requestId: string): Promise<BuildRow | null> {
  const result = await queryable.query<BuildRow>(`SELECT ${BUILD_FIELDS} FROM fishing_hut_build_jobs WHERE owner_player_id=$1 AND request_id=$2`, [playerId, requestId]);
  return result.rows[0] ?? null;
}
async function activeBuild(queryable: Pick<pg.Pool | pg.PoolClient, "query">, playerId: string, lock: boolean): Promise<BuildRow | null> {
  const result = await queryable.query<BuildRow>(`SELECT ${BUILD_FIELDS} FROM fishing_hut_build_jobs WHERE owner_player_id=$1 AND status='constructing' ORDER BY started_at,build_id LIMIT 1 ${lock ? "FOR UPDATE" : ""}`, [playerId]);
  return result.rows[0] ?? null;
}
async function hasActiveHut(queryable: Pick<pg.Pool | pg.PoolClient, "query">, playerId: string): Promise<boolean> {
  const result = await queryable.query(`SELECT 1 FROM player_fishing_huts WHERE owner_player_id=$1 AND removed_at IS NULL LIMIT 1`, [playerId]);
  return result.rows[0] !== undefined;
}
async function activeEncounter(queryable: Pick<pg.Pool | pg.PoolClient, "query">, playerId: string, lock: boolean): Promise<EncounterRow | null> {
  const result = await queryable.query<EncounterRow>(`SELECT ${ENCOUNTER_FIELDS} FROM fishing_encounters WHERE player_id=$1 AND phase IN ('cast','bite','hooked','fighting') ORDER BY started_at,encounter_id LIMIT 1 ${lock ? "FOR UPDATE" : ""}`, [playerId]);
  return result.rows[0] ?? null;
}

async function findUsableRod(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string,
  rodId: string | null
): Promise<{ rod_id: string; uses_remaining: number } | null> {
  const result = await queryable.query<{ rod_id: string; uses_remaining: number }>(
    `SELECT rods.rod_id::text,rods.uses_remaining FROM fishing_rods rods
     JOIN player_inventory inventory
       ON inventory.player_id=rods.player_id
      AND inventory.resource_type='fishing_rod'
      AND inventory.variant=rods.rod_id::text
      AND inventory.quantity > 0
     WHERE rods.player_id=$1 AND rods.uses_remaining > 0 ${rodId ? "AND rods.rod_id=$2::uuid" : ""}
     ORDER BY rods.created_at,rods.rod_id LIMIT 1`,
    rodId ? [playerId, rodId] : [playerId]
  );
  return result.rows[0] ?? null;
}

type FishingProgressionRow = {
  cast_range_rank: number;
  reel_power_rank: number;
  line_control_rank: number;
  specialization_type: FishingSpecializationType | null;
  specialization_selected_at: Date | string | null;
  specialization_unlocks_at: Date | string | null;
};

async function ensureFishingProgressionRow(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string
): Promise<FishingProgressionRow> {
  await queryable.query(`INSERT INTO fishing_player_progression(player_id) VALUES($1) ON CONFLICT(player_id) DO NOTHING`, [playerId]);
  const result = await queryable.query<FishingProgressionRow>(
    `SELECT cast_range_rank,reel_power_rank,line_control_rank,specialization_type,specialization_selected_at,specialization_unlocks_at
     FROM fishing_player_progression WHERE player_id=$1 FOR UPDATE`, [playerId]
  );
  return requireRow(result.rows[0], "Fishing progression could not be loaded");
}

async function ensureFishingProgression(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string,
  nowMs: number
): Promise<{ upgrades: readonly FishingUpgradeSnapshot[]; specialization: FishingSpecializationSnapshot }> {
  const row = await ensureFishingProgressionRow(queryable, playerId);
  const tracks: Array<[FishingUpgradeTrack, number]> = [
    ["cast_range", Number(row.cast_range_rank)],
    ["reel_power", Number(row.reel_power_rank)],
    ["line_control", Number(row.line_control_rank)]
  ];
  const upgrades = tracks.map(([track, rank]) => {
    const effectKey = track === "cast_range" ? "cast_range_m" : track;
    const effects = FISHING_UPGRADE_EFFECTS[effectKey];
    const nextRank = rank < FISHING_UPGRADE_MAX_RANK ? rank + 1 : null;
    return {
      track,
      rank,
      maxRank: FISHING_UPGRADE_MAX_RANK,
      nextRank,
      nextCostGold: nextRank === null ? null : FISHING_UPGRADE_GOLD_COSTS[rank] ?? null,
      effect: effects[rank] ?? 0,
      nextEffect: nextRank === null ? null : effects[nextRank] ?? null
    } satisfies FishingUpgradeSnapshot;
  });
  const unlocksAt = row.specialization_unlocks_at ? new Date(row.specialization_unlocks_at) : null;
  const selectedAt = row.specialization_selected_at ? new Date(row.specialization_selected_at) : null;
  return {
    upgrades,
    specialization: {
      selectedType: row.specialization_type,
      selectedAt: selectedAt?.toISOString() ?? null,
      unlocksAt: unlocksAt?.toISOString() ?? null,
      canChange: !unlocksAt || unlocksAt.getTime() <= nowMs
    }
  };
}

function upgradeRankColumn(track: FishingUpgradeTrack): "cast_range_rank" | "reel_power_rank" | "line_control_rank" {
  return track === "cast_range" ? "cast_range_rank" : track === "reel_power" ? "reel_power_rank" : "line_control_rank";
}
async function requireEncounter(queryable: Pick<pg.Pool | pg.PoolClient, "query">, encounterId: string, lock = false): Promise<EncounterRow> {
  const result = await queryable.query<EncounterRow>(`SELECT ${ENCOUNTER_FIELDS} FROM fishing_encounters WHERE encounter_id=$1::uuid ${lock ? "FOR UPDATE" : ""}`, [encounterId]);
  return requireRow(result.rows[0], "Fishing encounter no longer exists");
}
async function lockOperation(client: pg.PoolClient, playerId: string, requestId: string): Promise<void> { await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fishing-operation:${playerId}:${requestId}`]); }
async function lockBuildChannel(client: pg.PoolClient, playerId: string): Promise<void> { await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`outdoor-station-build-player:${playerId}`]); }
async function previousOperation(queryable: Pick<pg.Pool | pg.PoolClient, "query">, playerId: string, requestId: string): Promise<OperationRow | null> {
  const result = await queryable.query<OperationRow>(`SELECT action,request_hash,fishing_hut_id,encounter_id,result_quantity,result_jsonb FROM fishing_operations WHERE player_id=$1 AND request_id=$2`, [playerId, requestId]);
  return result.rows[0] ?? null;
}
function requireMatchingOperation(operation: OperationRow, action: OperationRow["action"], hash: string): void { if (operation.action !== action || operation.request_hash !== hash) throw new FishingError("FISHING_REPLAY_CONFLICT", "That request ID was already used for a different fishing action."); }
function operationKey(playerId: string, requestId: string): string { return `fishing:${playerId}:${requestId}`; }
function requestHash(action: string, ...parts: Array<string | number>): string { return createHash("sha256").update(JSON.stringify([action, ...parts])).digest("hex"); }
function fishingControlCountersPull(controlDirection: FishingControlDirection, fishDirection: FishingControlDirection): boolean {
  return fishDirection !== "neutral"
    && controlDirection !== "neutral"
    && ((fishDirection === "left" && controlDirection === "right") || (fishDirection === "right" && controlDirection === "left"));
}
function requireRequestId(requestId: string): void { if (!requestId || requestId.length > 128) throw new FishingError("FISHING_INVALID_REQUEST", "A valid request ID is required."); }
function normalizeRodGrantQuantity(quantity: bigint | number): number {
  const normalized = typeof quantity === "bigint" ? quantity : BigInt(quantity);
  if (normalized !== 1n) {
    throw new FishingError("FISHING_ROD_GRANT_QUANTITY_INVALID", "Fishing Rod grants must contain exactly one durable rod.");
  }
  return 1;
}
function requirePosition(player: PlayerRecord): void { if (!Number.isFinite(player.position.lat) || !Number.isFinite(player.position.lon)) throw new FishingError("FISHING_INVALID_POSITION", "Your world position is unavailable."); }
function nextFishingBiteAt(seed: number, nowMs: number): number {
  const range = FISHING_BITE_DELAY_MAX_MS - FISHING_BITE_DELAY_MIN_MS + 1;
  const offset = Math.abs(Number.isFinite(seed) ? Math.trunc(seed) : 0) % range;
  return nowMs + FISHING_BITE_DELAY_MIN_MS + offset;
}
function isCanonicalFishingLand(world: WorldGameplayEnvironmentResult): boolean {
  if (world.surfaceKind !== "land" || world.waterKind !== null) return false;
  if (
    world.riverSurface?.isRiver === true ||
    world.lakeSurface?.isLake === true ||
    world.oceanCoastSurface?.isOceanCoast === true
  ) return false;
  return [world.riverSurface, world.lakeSurface, world.oceanCoastSurface].some((surface) => (
    surface !== null &&
    surface !== undefined &&
    Number.isSafeInteger(surface.rowId) &&
    Number.isSafeInteger(surface.columnId) &&
    surface.rowId >= 0 &&
    surface.columnId >= 0 &&
    Number.isFinite(surface.cellSizeM) &&
    surface.cellSizeM > 0
  ));
}
function requireStationary(player: PlayerRecord): void { if (player.target) throw new FishingError("FISHING_MUST_BE_STATIONARY", "Stop moving before you start fishing."); }
function requireRow<T>(value: T | undefined, message: string): T { if (!value) throw new FishingError("FISHING_CONFLICT", message); return value; }

async function requirePersonalTerritory(client: pg.PoolClient, player: PlayerRecord): Promise<void> {
  if (!(await hasPersonalTerritoryByPoint(client, player.playerId, player.position))) throw new FishingError("FISHING_PERSONAL_TERRITORY_REQUIRED", "Fishing Huts must be placed inside your personal territory.");
}
async function hasPersonalTerritoryByPoint(client: Pick<pg.Pool | pg.PoolClient, "query">, playerId: string, point: { lat: number; lon: number }): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM flags WHERE owner_id=$1 AND control_type='personal' AND ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint($3,$2),4326)::geography,claim_radius_m) LIMIT 1`, [playerId, point.lat, point.lon]);
  return result.rows[0] !== undefined;
}
async function requireFishingClearance(client: pg.PoolClient, worldId: string, regionCode: string, requested: { lat: number; lon: number }): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`outdoor-station-clearance:${worldId}:${regionCode}`]);
  const points = await client.query<{ lat: number; lon: number }>(
    `SELECT lat,lon FROM player_furnaces WHERE removed_at IS NULL AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon FROM player_tanneries WHERE removed_at IS NULL AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon FROM player_butchers WHERE removed_at IS NULL AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon FROM player_kitchens WHERE removed_at IS NULL AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon FROM player_fishing_huts WHERE removed_at IS NULL AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon FROM furnace_build_jobs WHERE status='constructing' AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon FROM tannery_build_jobs WHERE status='constructing' AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon FROM butcher_build_jobs WHERE status='constructing' AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon FROM kitchen_build_jobs WHERE status='constructing' AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon FROM fishing_hut_build_jobs WHERE status='constructing' AND world_id=$1 AND region_code=$2`, [worldId, regionCode]
  );
  const evaluation = evaluateOutdoorStationClearance(requested, points.rows);
  if (!evaluation.allowed) throw new FishingError("FISHING_CLEARANCE_REQUIRED", `Fishing Huts must be at least ${OUTDOOR_STATION_CLEARANCE_M}m apart.`, evaluation.suggestedPosition);
}

function hutWaterbody(row: FishingHutRow): FreshwaterWaterbodyIdentity { return { kind: row.waterbody_kind, sourceId: row.waterbody_source_id, displayName: row.waterbody_name, distanceM: Number(row.waterbody_distance_m), sourceRevision: row.world_source_revision }; }
function mapHut(row: FishingHutRow, nowMs: number): FishingHutWorldSnapshot {
  const stored = Number(row.passive_stored_quantity);
  const produced = passiveFishProducedSince(new Date(row.passive_last_produced_at).getTime(), nowMs, stored);
  return { fishingHutId: row.fishing_hut_id, ownerPlayerId: row.owner_player_id, ownerUsername: row.owner_username, worldId: row.world_id, regionCode: row.region_code, lat: Number(row.lat), lon: Number(row.lon), builtAt: new Date(row.built_at).toISOString(), placementRevision: Number(row.placement_revision), waterbody: hutWaterbody(row), passiveStoredQuantity: stored, passiveCapacity: Number(row.passive_capacity), passiveReadyQuantity: Math.min(Number(row.passive_capacity) - stored, produced) };
}
function mapBuild(row: BuildRow): FishingHutBuildSnapshot { const startedAt = new Date(row.started_at).getTime(); const completesAt = new Date(row.completes_at).getTime(); return { buildId: row.build_id, position: { lat: Number(row.lat), lon: Number(row.lon) }, waterbody: { kind: row.waterbody_kind, sourceId: row.waterbody_source_id, displayName: row.waterbody_name, distanceM: Number(row.waterbody_distance_m), sourceRevision: row.world_source_revision }, startedAt, completesAt, durationMs: completesAt - startedAt }; }
function mapEncounter(row: EncounterRow, nowMs: number, catchId: string | null = null): FishingEncounterSnapshot {
  const resolvedWaterbody = row.waterbody_kind && row.waterbody_name
    ? { kind: row.waterbody_kind, sourceId: row.waterbody_source_id, displayName: row.waterbody_name, distanceM: 0, sourceRevision: row.waterbody_source_revision }
    : null;
  const geoContext = geoContextFromPersisted({
    latitude: row.cast_lat,
    longitude: row.cast_lon,
    countryId: row.country_id,
    countryName: row.country_name,
    admin1Id: row.admin1_id,
    admin1Name: row.admin1_name ?? row.region_name,
    gameplayWaterType: row.gameplay_water_type ?? row.waterbody_kind,
    canonicalWaterbodyId: row.canonical_waterbody_id ?? row.waterbody_source_id,
    canonicalDisplayName: row.canonical_display_name ?? row.waterbody_name,
    waterbodyResolutionState: row.waterbody_resolution_state,
    marineParentId: row.marine_parent_id,
    marineParentName: row.marine_parent_name,
    presentationName: row.presentation_name ?? row.waterbody_name,
    presentationRelation: row.presentation_relation,
    presentationDistanceM: row.presentation_distance_m
  });
  const catchSnapshot = row.phase === "landed" && row.length_in != null && row.weight_lb != null && row.score != null && resolvedWaterbody ? {
    catchId: catchId ?? "", encounterId: row.encounter_id, fishItemId: "freshwater_fish", ashen: false,
    behaviorProfile: row.behavior_profile, difficulty: Number(row.difficulty), lengthIn: Number(row.length_in), weightLb: Number(row.weight_lb), score: Number(row.score),
    perfect: row.perfect, durationMs: Math.max(0, nowMs - new Date(row.started_at).getTime()), waterbody: resolvedWaterbody,
    caughtAt: new Date(row.completed_at ?? row.last_action_at).toISOString(), ...(row.rod_id ? { rodId: row.rod_id } : {}),
    fishSpecies: fishingCatchSpecies(row.waterbody_kind),
    percentile: fishingCatchPercentileFromSize(Number(row.length_in)),
    geography: { region: row.region_name ?? "Unknown region", country: row.country_name ?? "Unknown country" },
    ...(geoContext ? { geoContext } : {}), source: "active"
  } satisfies FishingCatchSnapshot : null;
  const biteAt = new Date(row.bite_at).getTime();
  return { encounterId: row.encounter_id, fishingHutId: row.fishing_hut_id, ...(row.rod_id ? { rodId: row.rod_id } : {}), ...(row.rod_uses_remaining == null ? {} : { rodUsesRemaining: Number(row.rod_uses_remaining) }), castRangeM: Number(row.cast_range_m), phase: row.phase, waterbody: resolvedWaterbody, waterbodyCandidates: row.waterbody_candidates ?? [], castPoint: row.cast_lat !== null && row.cast_lon !== null ? { lat: Number(row.cast_lat), lon: Number(row.cast_lon) } : null, behaviorProfile: row.behavior_profile, difficulty: Number(row.difficulty), ashen: row.ashen, castQuality: row.cast_quality == null ? null : Number(row.cast_quality), biteAt, biteEvent: row.phase === "bite" ? fishingBiteEventAt(Number(row.seed), biteAt, nowMs) : null, serverTime: nowMs, tension: Number(row.tension), distance: Number(row.distance), stamina: Number(row.stamina), slackMs: Number(row.slack_ms), criticalMs: Number(row.critical_ms), fishDirection: row.fish_direction, fishPull: Number(row.fish_pull), executionQuality: Number(row.execution_quality), catch: catchSnapshot, reconnectDeadlineAt: new Date(row.reconnect_deadline_at).getTime() };
}

/** Admit only a World-authoritative water surface of the requested gameplay class. */
export function isFishableCanonicalSurface(
  world: Pick<WorldGameplayEnvironmentResult, "surfaceKind" | "isLand" | "isSaltwater" | "waterKind"> & {
    riverSurface?: Readonly<{ isRiver: boolean; waterKind: "river" | null }> | null;
    lakeSurface?: Readonly<{ isLake: boolean; waterKind: "lake" | null }> | null;
    oceanCoastSurface?: Readonly<{ isOceanCoast: boolean; waterKind: "ocean" | null }> | null;
  },
  kind: FishingWaterbodyKind
): boolean {
  if (
    world.surfaceKind !== "water" ||
    world.isLand !== false ||
    world.waterKind !== kind ||
    (kind === "ocean" ? world.isSaltwater !== true : world.isSaltwater !== false)
  ) return false;
  if (kind === "river") return world.riverSurface?.isRiver === true && world.riverSurface.waterKind === "river";
  if (kind === "lake") return world.lakeSurface?.isLake === true && world.lakeSurface.waterKind === "lake";
  // The ocean grid record is required for both coastal and deep-ocean cells;
  // false membership is a valid deep-ocean result.
  return world.oceanCoastSurface !== null && world.oceanCoastSurface !== undefined;
}

function mapCatch(row: EncounterRecordRow): FishingCatchSnapshot {
  const lengthIn = Number(row.length_in);
  const geoContext = geoContextFromPersisted({
    latitude: row.catch_lat ?? row.cast_lat,
    longitude: row.catch_lon ?? row.cast_lon,
    countryId: row.country_id,
    countryName: row.country_name,
    admin1Id: row.admin1_id,
    admin1Name: row.admin1_name ?? row.region_name,
    gameplayWaterType: row.gameplay_water_type ?? row.waterbody_kind,
    canonicalWaterbodyId: row.canonical_waterbody_id ?? row.waterbody_source_id,
    canonicalDisplayName: row.canonical_display_name ?? row.waterbody_name,
    waterbodyResolutionState: row.waterbody_resolution_state,
    marineParentId: row.marine_parent_id,
    marineParentName: row.marine_parent_name,
    presentationName: row.presentation_name ?? row.waterbody_name,
    presentationRelation: row.presentation_relation,
    presentationDistanceM: row.presentation_distance_m
  });
  return {
    catchId: row.catch_id,
    encounterId: row.encounter_id,
    player: { playerId: row.player_id, username: row.player_username },
    // Retired Ashen catches stay in the table and read back as ordinary fish.
    fishItemId: "freshwater_fish",
    ashen: false,
    behaviorProfile: row.behavior_profile,
    difficulty: Number(row.difficulty),
    lengthIn,
    weightLb: Number(row.weight_lb),
    score: Number(row.score),
    perfect: row.perfect,
    durationMs: Number(row.duration_ms),
    waterbody: {
      kind: row.waterbody_kind,
      sourceId: row.waterbody_source_id,
      displayName: row.waterbody_name,
      distanceM: 0,
      sourceRevision: row.waterbody_source_revision ?? row.world_source_revision
    },
    caughtAt: new Date(row.caught_at ?? row.created_at).toISOString(),
    fishSpecies: fishingCatchSpecies(row.waterbody_kind, row.fish_species),
    percentile: fishingCatchPercentileFromSize(lengthIn),
    geography: { region: row.region_name, country: row.country_name },
    ...(geoContext ? { geoContext } : {}),
    source: row.source
  };
}
function catchMetrics(seed: number, difficulty: number, executionQuality: number): { executionQuality: number; difficulty: number; sizePercentile: number; lengthIn: number; weightLb: number } {
  const normalized = deterministicUnit(seed ^ 0x9e3779b9);
  const sizePercentile = Math.max(0, Math.min(1, normalized));
  const lengthIn = 8 + sizePercentile * 25;
  const weightLb = Math.max(0.5, Math.round(((lengthIn * lengthIn * 0.008) + normalized * 2) * 100) / 100);
  return { executionQuality: Math.max(0, Math.min(1, executionQuality)), difficulty: Math.max(0, Math.min(1, difficulty)), sizePercentile, lengthIn, weightLb };
}
function deterministicUnit(seed: number): number { let value = seed | 0; value = Math.imul(value ^ (value >>> 16), 0x45d9f3b); value = Math.imul(value ^ (value >>> 16), 0x45d9f3b); value ^= value >>> 16; return (value >>> 0) / 0xffffffff; }
