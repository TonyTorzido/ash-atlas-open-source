import {
  INVENTORY_CATALOG,
  MAP_COMPASS_MAX_DAYS,
  MAP_COMPASS_RECIPE,
  MAP_MARKER_CAP,
  SURVEY_STAKE_KIT_RECIPE,
  MAP_MARKER_MAX_REACH_M,
  VOYAGER_RECORDED_LOCATION_CAP,
  VOYAGER_RECORD_ITEM,
  voyagerRecordCost,
  distanceMeters,
  isFiniteLatLon,
  mapCompassDayKey,
  sanitizeMapMarkerName,
  type LatLon,
  type MapCraftItem,
  type MapMarker,
  type MapMarkersState,
  type MapWaypoint,
  type PlayerInventorySnapshot,
  type ResourceType,
  type WorldMapDestination
} from "@ash-atlas/shared";
import type pg from "pg";

import { InventoryCapacityError, type InventoryService } from "./inventory.js";
import { requireTradeSkillGate, tradeSkillRank } from "./skills/tradeSkillRank.js";

export class MapMarkerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MapMarkerError";
  }
}

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type MapMarkerSpot =
  | Readonly<{ kind: "here" }>
  | Readonly<{ kind: "point"; lat: number; lon: number }>;

export type MapWaypointTarget =
  | Readonly<{ kind: "marker"; markerId: string }>
  | Readonly<{ kind: "recorded"; locationId: string }>
  | Readonly<{ kind: "destination"; destinationKind: string; destinationId: string }>;

export type MapMarkerResult = Readonly<{
  state: MapMarkersState;
  notice?: string;
  inventory?: PlayerInventorySnapshot;
}>;

type MarkerRow = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  created_at: Date | string;
  request_id?: string;
};

export type MapMarkerServiceOptions = Readonly<{
  /** The player's own World Map destinations (estates), used to target a waypoint at one. */
  destinations?: (playerId: string) => Promise<readonly WorldMapDestination[]>;
  now?: () => number;
}>;

const KIT_ITEM = "survey_stake_kit";
const COMPASS_ITEM = "compass";

export class MapMarkerService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: InventoryService,
    private readonly options: MapMarkerServiceOptions = {}
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async state(playerId: string, queryable: Queryable = this.pool): Promise<MapMarkersState> {
    const [markers, waypoint, held, wear, cartographyRank, voyagerRank] = await Promise.all([
      queryable.query<MarkerRow>(
        `SELECT id::text, name, lat, lon, created_at
         FROM player_map_markers
         WHERE player_id = $1
         ORDER BY created_at, id`,
        [playerId]
      ),
      queryable.query<{ marker_id: string | null; label: string; lat: number; lon: number }>(
        `SELECT marker_id::text, label, lat, lon FROM player_map_waypoints WHERE player_id = $1`,
        [playerId]
      ),
      queryable.query<{ resource_type: string; quantity: string }>(
        `SELECT resource_type, sum(quantity)::text AS quantity
         FROM player_inventory
         WHERE player_id = $1 AND resource_type IN ($2, $3) AND quantity > 0
         GROUP BY resource_type`,
        [playerId, KIT_ITEM, COMPASS_ITEM]
      ),
      queryable.query<{ days_used: number }>(
        `SELECT days_used FROM player_compass_wear WHERE player_id = $1`,
        [playerId]
      ),
      tradeSkillRank(queryable, playerId, "cartography"),
      this.activeVoyagerRank(queryable, playerId)
    ]);
    const recorded = voyagerRank > 0
      ? await queryable.query<MarkerRow>(
        `SELECT id::text, name, lat, lon, created_at
         FROM player_recorded_locations
         WHERE player_id = $1
         ORDER BY created_at, id`,
        [playerId]
      )
      : null;
    const quantities = new Map(held.rows.map((row) => [row.resource_type, Number(row.quantity)]));
    const compassHeld = (quantities.get(COMPASS_ITEM) ?? 0) > 0;
    const waypointRow = waypoint.rows[0];
    return {
      markers: markers.rows.map(markerFromRow),
      waypoint: compassHeld && waypointRow
        ? {
            markerId: waypointRow.marker_id,
            label: waypointRow.label,
            lat: Number(waypointRow.lat),
            lon: Number(waypointRow.lon)
          } satisfies MapWaypoint
        : null,
      compass: {
        held: compassHeld,
        daysUsed: compassHeld ? Number(wear.rows[0]?.days_used ?? 0) : 0,
        maxDays: MAP_COMPASS_MAX_DAYS
      },
      kitCount: quantities.get(KIT_ITEM) ?? 0,
      cartographyRank,
      markerCap: MAP_MARKER_CAP,
      ...(recorded
        ? {
            voyager: {
              rank: voyagerRank,
              recordCost: voyagerRecordCost(voyagerRank),
              recordCap: VOYAGER_RECORDED_LOCATION_CAP,
              locations: recorded.rows.map(markerFromRow)
            }
          }
        : {})
    };
  }

  /** Voyager rank while Voyager is the active specialization; 0 otherwise (travel perks are inactive). */
  async activeVoyagerRank(queryable: Queryable, playerId: string): Promise<number> {
    const result = await queryable.query<{ rank: number | null }>(
      `SELECT ranks.rank
       FROM player_specialization_state state
       JOIN player_specialization_ranks ranks
         ON ranks.player_id = state.player_id AND ranks.specialization_id = 'voyager'
       WHERE state.player_id = $1 AND state.active_specialization_id = 'voyager'`,
      [playerId]
    );
    return Number(result.rows[0]?.rank ?? 0);
  }

  /**
   * Voyager: save the player's authoritative position for refined oil (9 / 6 / 3 by rank). A retried
   * request never spends oil twice; at most five locations are kept.
   */
  async recordLocation(playerId: string, position: LatLon, requestId: string, rawName: string): Promise<MapMarkerResult> {
    const name = sanitizeMapMarkerName(rawName);
    if (!name) throw new MapMarkerError("MAP_MARKER_NAME_REQUIRED", "Give the location a name.");
    return await this.transaction(playerId, async (client) => {
      const rank = await this.activeVoyagerRank(client, playerId);
      if (rank < 1) throw new MapMarkerError("VOYAGER_REQUIRED", "Only an active Voyager can record locations.");
      const existing = await client.query(
        `SELECT 1 FROM player_recorded_locations WHERE player_id = $1 AND request_id = $2`,
        [playerId, requestId]
      );
      if (existing.rowCount === 1) {
        return { state: await this.state(playerId, client), inventory: await this.inventory.snapshotInTransaction(client, playerId) };
      }
      if (!isFiniteLatLon(position.lat, position.lon)) {
        throw new MapMarkerError("MAP_MARKER_SPOT_INVALID", "That spot cannot be recorded.");
      }
      const count = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM player_recorded_locations WHERE player_id = $1`,
        [playerId]
      );
      if ((count.rows[0]?.n ?? 0) >= VOYAGER_RECORDED_LOCATION_CAP) {
        throw new MapMarkerError("VOYAGER_LOCATION_CAP", `You can keep ${VOYAGER_RECORDED_LOCATION_CAP} recorded locations. Forget one first.`);
      }
      const cost = voyagerRecordCost(rank);
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `map-markers:record-location:${playerId}:${requestId}`,
          playerId,
          source: "voyager_record_location",
          sourceEntityType: "player",
          sourceEntityId: playerId,
          metadata: { requestId, cost, rank },
          debits: [{ itemId: VOYAGER_RECORD_ITEM, variant: null, quantity: cost }]
        })).inventory;
      } catch (error) {
        if (error instanceof Error && /enough items/iu.test(error.message)) {
          throw new MapMarkerError("VOYAGER_OIL_REQUIRED", `Recording a location costs ${cost} Glimmer Oil.`);
        }
        throw error;
      }
      await client.query(
        `INSERT INTO player_recorded_locations (player_id, request_id, name, lat, lon)
         VALUES ($1, $2, $3, $4, $5)`,
        [playerId, requestId, name, position.lat, position.lon]
      );
      return { state: await this.state(playerId, client), inventory, notice: `Recorded ${name}.` };
    });
  }

  async deleteRecordedLocation(playerId: string, locationId: string): Promise<MapMarkerResult> {
    return await this.transaction(playerId, async (client) => {
      const deleted = await client.query(
        `DELETE FROM player_recorded_locations WHERE id = $1 AND player_id = $2`,
        [locationId, playerId]
      );
      if (deleted.rowCount !== 1) throw new MapMarkerError("MAP_MARKER_NOT_FOUND", "That recorded location no longer exists.");
      return { state: await this.state(playerId, client), notice: "Location forgotten." };
    });
  }

  /** The spot an active Voyager may travel to; throws when not a Voyager or the location is not theirs. */
  async recordedTravelTarget(playerId: string, locationId: string): Promise<LatLon & { name: string }> {
    if (await this.activeVoyagerRank(this.pool, playerId) < 1) {
      throw new MapMarkerError("VOYAGER_REQUIRED", "Only an active Voyager can travel to recorded locations.");
    }
    const row = (await this.pool.query<MarkerRow>(
      `SELECT id::text, name, lat, lon, created_at FROM player_recorded_locations WHERE id = $1 AND player_id = $2`,
      [locationId, playerId]
    )).rows[0];
    if (!row) throw new MapMarkerError("MAP_MARKER_NOT_FOUND", "That recorded location no longer exists.");
    return { lat: Number(row.lat), lon: Number(row.lon), name: row.name };
  }

  /** Craft one Survey Stake Kit or one Compass from existing resources. Replay-safe by request id. */
  async craft(playerId: string, requestId: string, item: MapCraftItem): Promise<MapMarkerResult> {
    const recipe: Readonly<Record<string, number>> = item === "compass" ? MAP_COMPASS_RECIPE : SURVEY_STAKE_KIT_RECIPE;
    const label = item === "compass" ? "Compass" : "Survey Stake Kit";
    return await this.transaction(playerId, async (client) => {
      await requireTradeSkillGate(client, playerId, item === "compass" ? "artisan_compass" : "craft_survey_stake_kit", (message) => new MapMarkerError("MAP_SKILL_REQUIRED", message));
      let inventory: PlayerInventorySnapshot;
      let applied: boolean;
      try {
        const debit = await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `map-markers:craft:${playerId}:${requestId}`,
          playerId,
          source: "map_marker_crafting",
          sourceEntityType: "player",
          sourceEntityId: playerId,
          metadata: { requestId, item, recipe },
          debits: Object.entries(recipe).map(([itemId, quantity]) => ({
            itemId: itemId as ResourceType,
            variant: null,
            quantity
          }))
        });
        inventory = debit.inventory;
        applied = debit.applied;
      } catch (error) {
        if (error instanceof Error && /enough items/iu.test(error.message)) {
          throw new MapMarkerError(
            "MAP_CRAFT_MATERIALS_REQUIRED",
            `Crafting a ${label} requires ${describeRecipe(recipe)}.`
          );
        }
        throw error;
      }
      if (applied && item === "compass" && await this.holdsCompass(client, playerId)) {
        throw new MapMarkerError("MAP_COMPASS_ALREADY_CARRIED", "You already carry a Compass.");
      }
      try {
        inventory = (await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `map-markers:craft-grant:${playerId}:${requestId}`,
          playerId,
          source: "map_marker_crafting",
          sourceEntityType: "player",
          sourceEntityId: playerId,
          metadata: { requestId, item },
          grants: [{ itemId: item, variant: null, quantity: 1 }]
        })).inventory;
      } catch (error) {
        if (error instanceof InventoryCapacityError) {
          throw new MapMarkerError("MAP_CRAFT_NO_ROOM", `You cannot carry another ${label}.`);
        }
        throw error;
      }
      return { state: await this.state(playerId, client), inventory, notice: `Crafted a ${label}.` };
    });
  }

  /**
   * Use one Survey Stake Kit to name a spot: the player's authoritative position, or a tapped point
   * (a building) that must be within reach of it. A retried request never consumes a second kit.
   */
  async create(
    playerId: string,
    position: LatLon,
    requestId: string,
    rawName: string,
    spot: MapMarkerSpot
  ): Promise<MapMarkerResult> {
    const name = sanitizeMapMarkerName(rawName);
    if (!name) throw new MapMarkerError("MAP_MARKER_NAME_REQUIRED", "Give the marker a name.");
    return await this.transaction(playerId, async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM player_map_markers WHERE player_id = $1 AND request_id = $2`,
        [playerId, requestId]
      );
      if (existing.rowCount === 1) {
        return { state: await this.state(playerId, client), inventory: await this.inventory.snapshotInTransaction(client, playerId) };
      }
      const target = spot.kind === "here" ? position : { lat: spot.lat, lon: spot.lon };
      if (!isFiniteLatLon(target.lat, target.lon)) {
        throw new MapMarkerError("MAP_MARKER_SPOT_INVALID", "That spot cannot be marked.");
      }
      if (spot.kind === "point" && distanceMeters(position, target) > MAP_MARKER_MAX_REACH_M) {
        throw new MapMarkerError("MAP_MARKER_TOO_FAR", "That building is too far away to mark.");
      }
      const count = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM player_map_markers WHERE player_id = $1`,
        [playerId]
      );
      if ((count.rows[0]?.n ?? 0) >= MAP_MARKER_CAP) {
        throw new MapMarkerError("MAP_MARKER_CAP", `You can keep ${MAP_MARKER_CAP} markers. Delete one first.`);
      }
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `map-markers:create:${playerId}:${requestId}`,
          playerId,
          source: "map_marker_created",
          sourceEntityType: "player",
          sourceEntityId: playerId,
          metadata: { requestId },
          debits: [{ itemId: KIT_ITEM, variant: null, quantity: 1 }]
        })).inventory;
      } catch (error) {
        if (error instanceof Error && /enough items/iu.test(error.message)) {
          throw new MapMarkerError("SURVEY_STAKE_KIT_REQUIRED", "You need a Survey Stake Kit.");
        }
        throw error;
      }
      await client.query(
        `INSERT INTO player_map_markers (player_id, request_id, name, lat, lon)
         VALUES ($1, $2, $3, $4, $5)`,
        [playerId, requestId, name, target.lat, target.lon]
      );
      return { state: await this.state(playerId, client), inventory, notice: `Marked ${name}.` };
    });
  }

  async rename(playerId: string, markerId: string, rawName: string): Promise<MapMarkerResult> {
    const name = sanitizeMapMarkerName(rawName);
    if (!name) throw new MapMarkerError("MAP_MARKER_NAME_REQUIRED", "Give the marker a name.");
    return await this.transaction(playerId, async (client) => {
      const updated = await client.query(
        `UPDATE player_map_markers
         SET name = $3, updated_at = now()
         WHERE id = $1 AND player_id = $2`,
        [markerId, playerId, name]
      );
      if (updated.rowCount !== 1) throw markerNotFound();
      await client.query(
        `UPDATE player_map_waypoints SET label = $3 WHERE player_id = $1 AND marker_id = $2`,
        [playerId, markerId, name]
      );
      return { state: await this.state(playerId, client) };
    });
  }

  async remove(playerId: string, markerId: string): Promise<MapMarkerResult> {
    return await this.transaction(playerId, async (client) => {
      const deleted = await client.query(
        `DELETE FROM player_map_markers WHERE id = $1 AND player_id = $2`,
        [markerId, playerId]
      );
      if (deleted.rowCount !== 1) throw markerNotFound();
      return { state: await this.state(playerId, client), notice: "Marker deleted." };
    });
  }

  /** One active waypoint at a time; needs a Compass and counts as a day of use. */
  async setWaypoint(playerId: string, requestId: string, target: MapWaypointTarget): Promise<MapMarkerResult> {
    let destination: { label: string; lat: number; lon: number } | null = null;
    let markerId: string | null = null;
    if (target.kind === "destination") {
      if (target.destinationKind === "map_marker") {
        throw new MapMarkerError("MAP_WAYPOINT_INVALID", "Choose a marker or one of your estates.");
      }
      const known = await this.options.destinations?.(playerId) ?? [];
      const found = known.find((candidate) =>
        candidate.kind === target.destinationKind && candidate.id === target.destinationId
      );
      if (!found) throw new MapMarkerError("MAP_WAYPOINT_INVALID", "That destination is not on your map.");
      destination = { label: found.name, lat: found.lat, lon: found.lon };
    }
    return await this.transaction(playerId, async (client) => {
      if (!await this.holdsCompass(client, playerId)) {
        throw new MapMarkerError("MAP_COMPASS_REQUIRED", "You need a Compass to set a waypoint.");
      }
      if (target.kind === "marker") {
        const marker = await client.query<MarkerRow>(
          `SELECT id::text, name, lat, lon, created_at FROM player_map_markers WHERE id = $1 AND player_id = $2`,
          [target.markerId, playerId]
        );
        const row = marker.rows[0];
        if (!row) throw markerNotFound();
        markerId = row.id;
        destination = { label: row.name, lat: Number(row.lat), lon: Number(row.lon) };
      }
      if (target.kind === "recorded") {
        // Voyager: a Compass waypoint can point at any recorded location, however far away.
        if (await this.activeVoyagerRank(client, playerId) < 1) {
          throw new MapMarkerError("VOYAGER_REQUIRED", "Only an active Voyager can point the Compass at a recorded location.");
        }
        const recorded = await client.query<MarkerRow>(
          `SELECT id::text, name, lat, lon, created_at FROM player_recorded_locations WHERE id = $1 AND player_id = $2`,
          [target.locationId, playerId]
        );
        const row = recorded.rows[0];
        if (!row) throw new MapMarkerError("MAP_MARKER_NOT_FOUND", "That recorded location no longer exists.");
        destination = { label: row.name, lat: Number(row.lat), lon: Number(row.lon) };
      }
      if (!destination) throw new MapMarkerError("MAP_WAYPOINT_INVALID", "Choose a marker or one of your estates.");
      await client.query(
        `INSERT INTO player_map_waypoints (player_id, marker_id, label, lat, lon, set_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (player_id) DO UPDATE
         SET marker_id = EXCLUDED.marker_id, label = EXCLUDED.label,
             lat = EXCLUDED.lat, lon = EXCLUDED.lon, set_at = EXCLUDED.set_at`,
        [playerId, markerId, destination.label.slice(0, 64), destination.lat, destination.lon]
      );
      const wear = await this.wearCompass(client, playerId, requestId);
      return { ...(await this.withWear(client, playerId, wear)), notice: wear.broke ? "Your Compass wore out." : `Waypoint set: ${destination.label}.` };
    });
  }

  async clearWaypoint(playerId: string): Promise<MapMarkerResult> {
    return await this.transaction(playerId, async (client) => {
      await client.query(`DELETE FROM player_map_waypoints WHERE player_id = $1`, [playerId]);
      return { state: await this.state(playerId, client) };
    });
  }

  /** Opening the worldwide overview is a use of the Compass. */
  async openCompass(playerId: string, requestId: string): Promise<MapMarkerResult> {
    return await this.transaction(playerId, async (client) => {
      if (!await this.holdsCompass(client, playerId)) {
        throw new MapMarkerError("MAP_COMPASS_REQUIRED", "You need a Compass for the worldwide overview.");
      }
      const wear = await this.wearCompass(client, playerId, requestId);
      return { ...(await this.withWear(client, playerId, wear)), ...(wear.broke ? { notice: "Your Compass wore out." } : {}) };
    });
  }

  async list(playerId: string): Promise<MapMarkerResult> {
    return { state: await this.state(playerId) };
  }

  private async holdsCompass(queryable: Queryable, playerId: string): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM player_inventory WHERE player_id = $1 AND resource_type = $2 AND quantity > 0 LIMIT 1`,
      [playerId, COMPASS_ITEM]
    );
    return result.rowCount === 1;
  }

  /**
   * A day counts once per UTC day of use. On the 30th day of use the Compass wears out: it is
   * removed, its wear and waypoint are cleared. Replaying the same request never wears it twice.
   */
  private async wearCompass(
    client: pg.PoolClient,
    playerId: string,
    requestId: string
  ): Promise<{ broke: boolean }> {
    const today = mapCompassDayKey(this.now());
    const row = await client.query<{ days_used: number; last_used_day: string | null }>(
      `INSERT INTO player_compass_wear (player_id, days_used, last_used_day)
       VALUES ($1, 0, NULL)
       ON CONFLICT (player_id) DO UPDATE SET player_id = EXCLUDED.player_id
       RETURNING days_used, to_char(last_used_day, 'YYYY-MM-DD') AS last_used_day`,
      [playerId]
    );
    const current = row.rows[0];
    if (!current || current.last_used_day === today) return { broke: false };
    const daysUsed = current.days_used + 1;
    if (daysUsed < MAP_COMPASS_MAX_DAYS) {
      await client.query(
        `UPDATE player_compass_wear
         SET days_used = $2, last_used_day = $3::date, updated_at = now()
         WHERE player_id = $1`,
        [playerId, daysUsed, today]
      );
      return { broke: false };
    }
    await this.inventory.debitItemsForOperationInTransaction(client, {
      operationKey: `map-markers:compass-break:${playerId}:${requestId}`,
      playerId,
      source: "map_compass_worn_out",
      sourceEntityType: "player",
      sourceEntityId: playerId,
      metadata: { requestId, daysUsed },
      debits: [{ itemId: COMPASS_ITEM, variant: null, quantity: 1 }]
    });
    await client.query(`DELETE FROM player_compass_wear WHERE player_id = $1`, [playerId]);
    await client.query(`DELETE FROM player_map_waypoints WHERE player_id = $1`, [playerId]);
    return { broke: true };
  }

  private async withWear(
    client: pg.PoolClient,
    playerId: string,
    wear: { broke: boolean }
  ): Promise<MapMarkerResult> {
    return {
      state: await this.state(playerId, client),
      ...(wear.broke ? { inventory: await this.inventory.snapshotInTransaction(client, playerId) } : {})
    };
  }

  private async transaction<T>(playerId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`map-markers:${playerId}`]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function markerFromRow(row: MarkerRow): MapMarker {
  return {
    id: row.id,
    name: row.name,
    lat: Number(row.lat),
    lon: Number(row.lon),
    createdAt: new Date(row.created_at).getTime()
  };
}

function markerNotFound(): MapMarkerError {
  return new MapMarkerError("MAP_MARKER_NOT_FOUND", "That marker is not yours or no longer exists.");
}

function describeRecipe(recipe: Readonly<Record<string, number>>): string {
  return Object.entries(recipe)
    .map(([itemId, quantity]) =>
      `${quantity} ${INVENTORY_CATALOG[itemId as ResourceType]?.displayName ?? itemId}`)
    .join(", ");
}
