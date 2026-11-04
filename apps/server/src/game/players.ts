import { createHash } from "node:crypto";

import {
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  clampHungerForOrdinaryWrite,
  GPS_RELOCATION_COOLDOWN_MS,
  hungerSnapshot,
  normalizeHungerCurrent,
  normalizeHungerBaseCapacity,
  personalFlagColorFromHex,
  resourceVisionRadiusForLeash,
  TRAVEL_INVITE_AFTER_RELOCATION_COOLDOWN_MS,
  travelHungerCost,
  type PersonalFlagColor,
  type PlayerSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppConfig } from "../config.js";
import { resourceVisionForArea } from "./resourceVision.js";
import { stylesFromRow } from "./salon.js";
import type { AppLogger } from "../logger.js";
import { sanitizePlayerColor } from "./validation.js";
import {
  displayColorForPlayer,
  type PlayerRecord,
  zoneIdForRegion
} from "./state.js";

type PlayerRow = {
  id: string;
  username: string;
  display_color: string | null;
  body_variant_id?: string;
  personal_flag_color: PersonalFlagColor;
  region_code: string;
  lat: number;
  lon: number;
  anchor_lat: number;
  anchor_lon: number;
  move_leash_radius_m: number;
  online: boolean;
  updated_at: Date;
  last_relocated_at?: Date | string | null;
  current_flag_id?: string | null;
  current_kingdom_seat_id?: string | null;
  current_flag_name?: string | null;
  current_flag_lat?: number | null;
  current_flag_lon?: number | null;
  current_flag_resource_vision_radius_m?: number | null;
  resource_vision_center_lat?: number | null;
  resource_vision_center_lon?: number | null;
  hair_appearance_id?: string | null;
  eyes_appearance_id?: string | null;
  nose_mouth_appearance_id?: string | null;
  nose_appearance_id?: string | null;
  mouth_appearance_id?: string | null;
  mask_appearance_id?: string | null;
  beard_appearance_id?: string | null;
  legs_overlay_appearance_id?: string | null;
  skin_tone_id?: string | null;
  eyes_feature_x?: number | null;
  eyes_feature_y?: number | null;
  nose_feature_x?: number | null;
  nose_feature_y?: number | null;
  mouth_feature_x?: number | null;
  mouth_feature_y?: number | null;
  base_appearance_revision?: number;
  hunger?: number | string | null;
  hunger_base_capacity?: number | string | null;
  afloat?: boolean | null;
};

export type RelocationStatus = Readonly<{
  lastRelocatedAt: Date | null;
  relocationAvailableAt: number | null;
  travelInviteAvailableAt: number | null;
  serverTime: number;
}>;

export class PlayerRelocationCooldownError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("You can relocate again after the 7-day cooldown.");
    this.name = "PlayerRelocationCooldownError";
  }
}

export type PlayerPersistenceOptions = Readonly<{
  lastRelocatedAt?: Date | null;
  /**
   * When rolling back a relocation, only restore lastRelocatedAt if this
   * write still owns the timestamp. A concurrent relocation must keep its
   * newer durable cooldown instead of being cleared by the rollback.
   */
  restoreRelocationIfCurrent?: Date;
  requireRelocationCooldownAvailable?: boolean;
  /** Travel is the first path that must preserve future Hunger over-capacity. */
  hungerWriteMode?: "ordinary" | "exact";
}>;

export type TravelHungerPersistenceInput = Readonly<{
  requestId: string;
  destinationIdentity: string;
  distanceM: number;
  maxRangeM: number;
}>;

export type TravelHungerPersistenceResult = Readonly<{
  replayed: boolean;
  cost: number;
  hungerBefore: number;
  hungerAfter: number;
  baseCapacity: number;
}>;

export type TravelHungerAvailability = Readonly<{
  cost: number;
  currentHunger: number;
  baseCapacity: number;
  replayed: boolean;
  replayConflict: boolean;
}>;

export class TravelHungerInsufficientError extends Error {
  readonly code = "INSUFFICIENT_HUNGER" as const;

  constructor(
    readonly requiredHunger: number,
    readonly currentHunger: number
  ) {
    super(`You need ${requiredHunger} Hunger to make that journey.`);
    this.name = "TravelHungerInsufficientError";
  }
}

export class TravelHungerReplayConflictError extends Error {
  readonly code = "TRAVEL_HUNGER_REPLAY_CONFLICT" as const;

  constructor() {
    super("This travel request was already used for another journey.");
    this.name = "TravelHungerReplayConflictError";
  }
}

export class PlayerService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AppConfig,
    private readonly logger?: Pick<AppLogger, "warn">
  ) {}

  async loadPlayer(playerId: string): Promise<PlayerRecord | null> {
    const result = await this.pool.query<PlayerRow>(
      `
       SELECT p.id, p.username, p.display_color, p.body_variant_id, p.personal_flag_color,
              p.hair_appearance_id, p.eyes_appearance_id, p.nose_mouth_appearance_id,
              p.nose_appearance_id, p.mouth_appearance_id,
              p.beard_appearance_id, p.mask_appearance_id, p.legs_overlay_appearance_id,
              p.skin_tone_id,
              p.eyes_feature_x, p.eyes_feature_y, p.nose_feature_x, p.nose_feature_y,
              p.mouth_feature_x, p.mouth_feature_y,
              p.base_appearance_revision,
              p.region_code, p.lat, p.lon,
              p.anchor_lat, p.anchor_lon, p.move_leash_radius_m, p.online, p.updated_at,
              p.last_relocated_at,
              p.hunger, p.hunger_base_capacity, p.afloat,
              p.resource_vision_center_lat, p.resource_vision_center_lon,
              p.current_flag_id, p.current_kingdom_seat_id,
             COALESCE(f.name, kingdom.display_name || ' Castle') AS current_flag_name,
             COALESCE(f.lat, seat.lat) AS current_flag_lat,
             COALESCE(f.lon, seat.lon) AS current_flag_lon,
             COALESCE(
                f.resource_vision_radius_m,
                seat_source_flag.resource_vision_radius_m
              ) AS current_flag_resource_vision_radius_m
       FROM players p
       LEFT JOIN flags f ON f.id = p.current_flag_id
       LEFT JOIN kingdom_seats seat ON seat.id = p.current_kingdom_seat_id
       LEFT JOIN flags seat_source_flag ON seat_source_flag.id = seat.source_flag_id
       LEFT JOIN kingdoms kingdom ON kingdom.id = seat.kingdom_id
       WHERE p.id = $1
      `,
      [playerId]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (attachedVisionCenterDiffersFromAnchor(row)) {
      this.logger?.warn({
        playerId: row.id,
        persistedAnchor: {
          lat: Number(row.anchor_lat),
          lon: Number(row.anchor_lon)
        },
        persistedVisionCenter: persistedVisionCenter(row)
      }, "detected attached resource vision center for connection-time anchor repair");
    }
    return rowToPlayerRecord(row, this.config.FLAG_RESOURCE_VISION_RADIUS_M);
  }

  async markOnline(playerId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE players
      SET online = true,
          last_seen_at = now()
      WHERE id = $1
      `,
      [playerId]
    );
  }

  async updatePlayerColor(playerId: string, color: string): Promise<PlayerSnapshot> {
    const normalizedColor = sanitizePlayerColor(color);
    const personalFlagColor = personalFlagColorFromHex(normalizedColor);
    if (!personalFlagColor) {
      throw new Error("player flag color must be one of the five supported colors");
    }
    const result = await this.pool.query<PlayerRow>(
      `
      UPDATE players
      SET display_color = $2,
          personal_flag_color = $3,
          last_seen_at = now()
      WHERE id = $1
      RETURNING id, username, display_color, personal_flag_color,
                region_code, lat, lon, anchor_lat, anchor_lon,
                 move_leash_radius_m, online, updated_at,
                 hunger, hunger_base_capacity
      `,
      [playerId, normalizedColor, personalFlagColor]
    );
    return rowToPlayerSnapshot(requireRow(result.rows[0]));
  }

  async markOffline(playerId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE players
      SET online = false,
          last_seen_at = now()
      WHERE id = $1
      `,
      [playerId]
    );
  }

  async markManyOffline(playerIds: string[]): Promise<void> {
    if (playerIds.length === 0) {
      return;
    }
    await this.pool.query(
      `
      UPDATE players
      SET online = false,
          last_seen_at = now()
      WHERE id = ANY($1::text[])
      `,
      [playerIds]
    );
  }

  async persistPlayerSnapshot(
    player: PlayerSnapshot,
    statementTimeoutMs?: number,
    options: PlayerPersistenceOptions = {},
    beforeCommit?: (client: pg.PoolClient) => Promise<void>
  ): Promise<void> {
    const query = playerPersistenceQuery(player, options);
    if (statementTimeoutMs !== undefined || beforeCommit) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        if (statementTimeoutMs !== undefined) {
          await client.query("SELECT set_config('statement_timeout', $1, true)", [
            `${Math.max(1, Math.floor(statementTimeoutMs))}ms`
          ]);
        }
        if (options.requireRelocationCooldownAvailable) {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('travel-invite-send:' || $1, 0))",
            [player.playerId]
          );
        }
        const result = await client.query(query.text, query.values);
        assertPlayerPersistenceResult(result, options);
        await beforeCommit?.(client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      return;
    }
    const result = await this.pool.query(query.text, query.values);
    assertPlayerPersistenceResult(result, options);
  }

  async persistPlayerSnapshotInTransaction(
    client: Pick<pg.PoolClient, "query">,
    player: PlayerSnapshot,
    statementTimeoutMs?: number,
    options: PlayerPersistenceOptions = {}
  ): Promise<void> {
    const query = playerPersistenceQuery(player, options);
    if (statementTimeoutMs !== undefined) {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${Math.max(1, Math.floor(statementTimeoutMs))}ms`
      ]);
    }
    if (options.requireRelocationCooldownAvailable) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('travel-invite-send:' || $1, 0))",
        [player.playerId]
      );
    }
    const result = await client.query(query.text, query.values);
    assertPlayerPersistenceResult(result, options);
  }

  /**
   * Persist a deliberate travel relocation and its Hunger debit atomically.
   * The player row lock in consumeTravelHungerInTransaction serializes travel
   * with food and other Hunger mutations for this player.
   */
  async persistTravelSnapshot(
    player: PlayerSnapshot,
    travel: TravelHungerPersistenceInput,
    statementTimeoutMs?: number,
    options: PlayerPersistenceOptions = {},
    beforeCommit?: (
      client: pg.PoolClient,
      result: TravelHungerPersistenceResult
    ) => Promise<void>
  ): Promise<TravelHungerPersistenceResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.persistTravelSnapshotInTransaction(
        client,
        player,
        travel,
        statementTimeoutMs,
        options
      );
      if (!result.replayed) {
        await beforeCommit?.(client, result);
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async persistTravelSnapshotInTransaction(
    client: Pick<pg.PoolClient, "query">,
    player: PlayerSnapshot,
    travel: TravelHungerPersistenceInput,
    statementTimeoutMs?: number,
    options: PlayerPersistenceOptions = {}
  ): Promise<TravelHungerPersistenceResult> {
    if (statementTimeoutMs !== undefined) {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${Math.max(1, Math.floor(statementTimeoutMs))}ms`
      ]);
    }
    const result = await this.consumeTravelHungerInTransaction(
      client,
      player.playerId,
      travel
    );
    if (result.replayed) return result;
    const persistedPlayer: PlayerSnapshot = {
      ...player,
      hunger: {
        current: result.hungerAfter,
        baseCapacity: result.baseCapacity
      }
    };
    await this.persistPlayerSnapshotInTransaction(
      client,
      persistedPlayer,
      statementTimeoutMs,
      { ...options, hungerWriteMode: "exact" }
    );
    return result;
  }

  async travelHungerAvailability(
    playerId: string,
    travel: TravelHungerPersistenceInput
  ): Promise<TravelHungerAvailability> {
    const result = await this.pool.query<{
      hunger: number | string | null;
      hunger_base_capacity: number | string | null;
    }>(
      `
      SELECT hunger, hunger_base_capacity
      FROM players
      WHERE id = $1
      `,
      [playerId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("travel Hunger player row was not found");
    }
    const existing = await this.pool.query<{ request_hash: string }>(
      `
      SELECT request_hash
      FROM travel_hunger_consumption_operations
      WHERE player_id = $1 AND request_id = $2
      `,
      [playerId, travel.requestId]
    );
    const operation = existing.rows[0];
    const operationHash = travelHungerOperationHash(travel);
    return {
      cost: travelHungerCost(travel.distanceM, travel.maxRangeM),
      currentHunger: normalizeHungerCurrent(row.hunger),
      baseCapacity: normalizeHungerBaseCapacity(row.hunger_base_capacity),
      replayed: operation?.request_hash === operationHash,
      replayConflict: operation !== undefined && operation.request_hash !== operationHash
    };
  }

  async consumeTravelHungerInTransaction(
    client: Pick<pg.PoolClient, "query">,
    playerId: string,
    travel: TravelHungerPersistenceInput
  ): Promise<TravelHungerPersistenceResult> {
    const playerResult = await client.query<{
      hunger: number | string | null;
      hunger_base_capacity: number | string | null;
    }>(
      `
      SELECT hunger, hunger_base_capacity
      FROM players
      WHERE id = $1
      FOR UPDATE
      `,
      [playerId]
    );
    const row = playerResult.rows[0];
    if (!row) {
      throw new Error("travel Hunger player row was not found");
    }
    const currentHunger = normalizeHungerCurrent(row.hunger);
    const baseCapacity = normalizeHungerBaseCapacity(row.hunger_base_capacity);
    const operationHash = travelHungerOperationHash(travel);
    const existing = await client.query<{
      request_hash: string;
      cost: number | string;
      hunger_before: number | string;
      hunger_after: number | string;
      distance_m: number | string;
      max_range_m: number | string;
    }>(
      `
      SELECT request_hash, cost, hunger_before, hunger_after, distance_m, max_range_m
      FROM travel_hunger_consumption_operations
      WHERE player_id = $1 AND request_id = $2
      FOR UPDATE
      `,
      [playerId, travel.requestId]
    );
    const operation = existing.rows[0];
    if (operation) {
      if (operation.request_hash !== operationHash) {
        throw new TravelHungerReplayConflictError();
      }
      return {
        replayed: true,
        cost: Number(operation.cost),
        hungerBefore: Number(operation.hunger_before),
        hungerAfter: currentHunger,
        baseCapacity
      };
    }
    const cost = travelHungerCost(travel.distanceM, travel.maxRangeM);
    if (currentHunger < cost) {
      throw new TravelHungerInsufficientError(cost, currentHunger);
    }
    const hungerAfter = currentHunger - cost;
    const operationKey = `travel-hunger:${playerId}:${travel.requestId}`;
    await client.query(
      `
      INSERT INTO travel_hunger_consumption_operations (
        operation_key, player_id, request_id, request_hash,
        destination_identity, distance_m, max_range_m, cost,
        hunger_before, hunger_after
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,
      [
        operationKey,
        playerId,
        travel.requestId,
        operationHash,
        travel.destinationIdentity,
        travel.distanceM,
        travel.maxRangeM,
        cost,
        currentHunger,
        hungerAfter
      ]
    );
    await client.query(
      `
      UPDATE players
      SET hunger = $2,
          last_seen_at = now()
      WHERE id = $1
      `,
      [playerId, hungerAfter]
    );
    return {
      replayed: false,
      cost,
      hungerBefore: currentHunger,
      hungerAfter,
      baseCapacity
    };
  }

  async relocationStatus(playerId: string, now = Date.now()): Promise<RelocationStatus> {
    const result = await this.pool.query<{ last_relocated_at: Date | string | null }>(
      "SELECT last_relocated_at FROM players WHERE id = $1",
      [playerId]
    );
    const raw = result.rows[0]?.last_relocated_at ?? null;
    const lastRelocatedAt = raw === null ? null : asDate(raw);
    const relocationAvailableAt = lastRelocatedAt
      ? lastRelocatedAt.getTime() + GPS_RELOCATION_COOLDOWN_MS
      : null;
    const travelInviteAvailableAt = lastRelocatedAt
      ? lastRelocatedAt.getTime() + TRAVEL_INVITE_AFTER_RELOCATION_COOLDOWN_MS
      : null;
    return {
      lastRelocatedAt,
      relocationAvailableAt,
      travelInviteAvailableAt,
      serverTime: now
    };
  }

  async persistPlayerSnapshotMeasured(
    player: PlayerSnapshot
  ): Promise<{ statements: number; poolWaitMs: number }> {
    const waitStartedAt = performance.now();
    const client = await this.pool.connect();
    const poolWaitMs = performance.now() - waitStartedAt;
    try {
      const query = playerPersistenceQuery(player);
      await client.query(query.text, query.values);
      return { statements: 1, poolWaitMs };
    } finally {
      client.release();
    }
  }

  async listOnlinePlayers(regionCode = this.config.REGION_CODE): Promise<PlayerSnapshot[]> {
    const result = await this.pool.query<PlayerRow>(
      `
      SELECT id, username, display_color, personal_flag_color,
             region_code, lat, lon, anchor_lat, anchor_lon,
             move_leash_radius_m, online, updated_at,
             hunger, hunger_base_capacity
      FROM players
      WHERE region_code = $1
        AND online = true
      ORDER BY username ASC, id ASC
      `,
      [regionCode]
    );
    return result.rows.map(rowToPlayerSnapshot);
  }
}

export function rowToPlayerRecord(
  row: PlayerRow,
  fallbackResourceVisionRadiusM = DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
): PlayerRecord {
  const movementLeashRadiusM = Number(row.move_leash_radius_m);
  const storedResourceVisionRadiusM =
    row.current_flag_resource_vision_radius_m === null ||
    row.current_flag_resource_vision_radius_m === undefined
      ? fallbackResourceVisionRadiusM
      : Number(row.current_flag_resource_vision_radius_m);
  const resourceVisionRadiusM = Math.max(
    storedResourceVisionRadiusM,
    resourceVisionRadiusForLeash(movementLeashRadiusM)
  );
  const anchor = {
    lat: Number(row.anchor_lat),
    lon: Number(row.anchor_lon)
  };
  const durableResourceVision = (row.current_flag_id ?? row.current_kingdom_seat_id) &&
    row.current_flag_name &&
    row.current_flag_lat !== null && row.current_flag_lat !== undefined &&
    row.current_flag_lon !== null && row.current_flag_lon !== undefined
      ? {
          flagId: (row.current_flag_id ?? row.current_kingdom_seat_id)!,
          flagName: row.current_flag_name,
          ...(row.current_kingdom_seat_id ? { destinationKind: "kingdom_seat" as const } : {}),
          center: persistedVisionCenter(row),
          movementLeashRadiusM,
          paddingM: resourceVisionRadiusM - movementLeashRadiusM,
          radiusM: resourceVisionRadiusM
        }
      : null;
  return {
    playerId: row.id,
    username: row.username,
    displayColor: row.display_color ?? displayColorForPlayer(row.id),
    personalFlagColor: row.personal_flag_color,
    regionCode: row.region_code,
    position: {
      lat: Number(row.lat),
      lon: Number(row.lon)
    },
    anchor,
    moveLeashRadiusM: movementLeashRadiusM,
    movementRevision: 0,
    target: null,
    online: Boolean(row.online),
    bodyVariantId: "default",
    salonStyles: stylesFromRow(row),
    salonAppearanceRevision: Number(row.base_appearance_revision ?? 0),
    hunger: hungerSnapshot(row.hunger, row.hunger_base_capacity),
    afloat: row.afloat === true,
    updatedAt: row.updated_at,
    resourceVision: durableResourceVision ?? resourceVisionForArea({
      regionCode: row.region_code,
      position: anchor,
      movementLeashRadiusM,
      visibleRadiusM: resourceVisionRadiusM
    })
  };
}

function attachedVisionCenterDiffersFromAnchor(row: PlayerRow): boolean {
  if (
    !(row.current_flag_id ?? row.current_kingdom_seat_id) ||
    row.current_flag_lat === null || row.current_flag_lat === undefined ||
    row.current_flag_lon === null || row.current_flag_lon === undefined
  ) {
    return false;
  }
  const center = persistedVisionCenter(row);
  return center.lat !== Number(row.anchor_lat) ||
    center.lon !== Number(row.anchor_lon);
}

function persistedVisionCenter(row: PlayerRow): { lat: number; lon: number } {
  return {
    lat: Number(row.resource_vision_center_lat ?? row.current_flag_lat),
    lon: Number(row.resource_vision_center_lon ?? row.current_flag_lon)
  };
}

function rowToPlayerSnapshot(row: PlayerRow): PlayerSnapshot {
  return {
    playerId: row.id,
    username: row.username,
    displayColor: row.display_color ?? displayColorForPlayer(row.id),
    personalFlagColor: row.personal_flag_color,
    regionCode: row.region_code,
    zoneId: zoneIdForRegion(row.region_code),
    lat: Number(row.lat),
    lon: Number(row.lon),
    anchorLat: Number(row.anchor_lat),
    anchorLon: Number(row.anchor_lon),
    moveLeashRadiusM: Number(row.move_leash_radius_m),
    movementRevision: 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    currentFlagId: row.current_flag_id ?? row.current_kingdom_seat_id ?? null,
    ...(row.current_kingdom_seat_id ? { currentKingdomSeatId: row.current_kingdom_seat_id } : {}),
    online: Boolean(row.online),
    updatedAt: row.updated_at.toISOString(),
    hunger: hungerSnapshot(row.hunger, row.hunger_base_capacity)
  };
}

function requireRow(row: PlayerRow | undefined): PlayerRow {
  if (!row) {
    throw new Error("player query did not return a row");
  }
  return row;
}

function playerPersistenceQuery(
  player: PlayerSnapshot,
  options: PlayerPersistenceOptions = {}
): { text: string; values: unknown[] } {
  const restoresRelocationIfCurrent = options.restoreRelocationIfCurrent !== undefined;
  const marksRelocation = options.lastRelocatedAt !== undefined && !restoresRelocationIfCurrent;
  const requiresRelocationCooldown = options.requireRelocationCooldownAvailable === true;
  return {
    text: `
      WITH authoritative_flag AS (
        SELECT id
        FROM flags
        WHERE $9::text IS NOT NULL
          AND id::text = $9::text
      )
      UPDATE players
      SET lat = $2,
          lon = $3,
          region_code = $8,
          spatial_package_id = $8,
          spatial_zone_id = 'world:' || $8,
          anchor_lat = $4,
          anchor_lon = $5,
          resource_vision_center_lat = CASE
            WHEN $9::text IS NOT NULL OR $10::uuid IS NOT NULL THEN $4::double precision
            ELSE NULL
          END,
          resource_vision_center_lon = CASE
            WHEN $9::text IS NOT NULL OR $10::uuid IS NOT NULL THEN $5::double precision
            ELSE NULL
          END,
          move_leash_radius_m = $6,
          online = $7,
          current_flag_id = (SELECT id FROM authoritative_flag),
          current_kingdom_seat_id = $10,
          last_relocated_at = CASE
            WHEN $14::boolean
              AND last_relocated_at IS NOT DISTINCT FROM $15::timestamptz
              THEN $12::timestamptz
            WHEN $11::boolean THEN $12::timestamptz
            ELSE last_relocated_at
          END,
          hunger = $16,
          afloat = $18,
          last_seen_at = now(),
          geom = ST_SetSRID(ST_MakePoint($3, $2), 4326)
      WHERE id = $1
        AND (
          $13::boolean = false
          OR last_relocated_at IS NULL
          OR last_relocated_at <= $12::timestamptz - ($17::bigint * interval '1 millisecond')
        )
    `,
    values: [
      player.playerId,
      player.lat,
      player.lon,
      player.anchorLat,
      player.anchorLon,
      player.moveLeashRadiusM,
      player.online,
      player.regionCode,
      player.currentKingdomSeatId ? null : player.currentFlagId ?? null,
      player.currentKingdomSeatId ?? null,
      marksRelocation,
      options.lastRelocatedAt ?? null,
      requiresRelocationCooldown,
      restoresRelocationIfCurrent,
      options.restoreRelocationIfCurrent ?? null,
      options.hungerWriteMode === "exact"
        ? normalizeHungerCurrent(player.hunger?.current)
        : clampHungerForOrdinaryWrite(player.hunger?.current),
      GPS_RELOCATION_COOLDOWN_MS,
      player.afloat === true
    ]
  };
}

function assertPlayerPersistenceResult(
  result: { rowCount?: number | null } | undefined,
  options: PlayerPersistenceOptions
): void {
  if (!options.requireRelocationCooldownAvailable) return;
  if ((result?.rowCount ?? 0) > 0) return;
  throw new PlayerRelocationCooldownError(0);
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function travelHungerOperationHash(
  travel: TravelHungerPersistenceInput
): string {
  // Distance is derived from the live authoritative origin. Keep it out of
  // the replay identity so retrying the same request after arrival remains an
  // idempotent no-op instead of looking like a changed request.
  return createHash("sha256")
    .update(travel.destinationIdentity)
    .digest("hex");
}
