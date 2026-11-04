import {
  CISTERN_WARRENS_INDOOR_UNITS_PER_STORED_UNIT,
  cisternWarrensIndoorPointToStored,
  cisternWarrensStoredPointToIndoor,
  interiorRegionCode,
  interiorZoneId,
  type PlayerLocationSnapshot,
  type PortalEndpoint
} from "@ash-atlas/shared";
import { createHash } from "node:crypto";
import type pg from "pg";
import { zoneIdForPosition } from "../spatialZones.js";

type LocationRow = {
  region_code: string; lat: number; lon: number; location_kind: "world" | "interior";
  location_type: "manor" | "salon" | "cistern_warrens" | "dungeon" | "greenhouse" | null; location_id: string | null;
  location_instance_id: string | null; location_space_id: string | null;
  location_local_x: number | null; location_local_y: number | null;
  location_facing: number | null; location_revision: string | number;
  last_portal_id: string | null; last_transition_request_id: string | null;
  last_transition_request_hash: string | null;
};

export class PlayerLocationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PlayerLocationError";
  }
}

export class PlayerLocationService {
  constructor(private readonly pool: pg.Pool) {}

  async load(playerId: string): Promise<PlayerLocationSnapshot> {
    const result = await this.pool.query<LocationRow>(`${SELECT_LOCATION} WHERE id=$1`, [playerId]);
    const row = result.rows[0];
    if (!row) throw new PlayerLocationError("PLAYER_NOT_FOUND", "Player location is unavailable.");
    return rowToLocation(row);
  }

  async replayPortalTransition(
    playerId: string,
    requestId: string,
    requestHash: string
  ): Promise<PlayerLocationSnapshot | null> {
    const result = await this.pool.query<LocationRow>(`${SELECT_LOCATION} WHERE id=$1`, [playerId]);
    const row = result.rows[0];
    if (!row) throw new PlayerLocationError("PLAYER_NOT_FOUND", "Player location is unavailable.");
    if (row.last_transition_request_id !== requestId) return null;
    if (row.last_transition_request_hash !== requestHash) {
      throw new PlayerLocationError(
        "REQUEST_ID_REUSED",
        "That portal request ID was already used for another transition."
      );
    }
    return rowToLocation(row);
  }

  async commitPortalTransition(input: Readonly<{
    playerId: string;
    requestId: string;
    portalId: string;
    expectedRevision: number;
    destination: PortalEndpoint;
    requestHash?: string;
  }>): Promise<{ location: PlayerLocationSnapshot; replayed: boolean }> {
    const requestHash = input.requestHash ?? transitionRequestHash(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<LocationRow>(`${SELECT_LOCATION} WHERE id=$1 FOR UPDATE`, [input.playerId]);
      const current = locked.rows[0];
      if (!current) throw new PlayerLocationError("PLAYER_NOT_FOUND", "Player location is unavailable.");
      if (current.last_transition_request_id === input.requestId) {
        if (current.last_transition_request_hash !== requestHash) {
          throw new PlayerLocationError("REQUEST_ID_REUSED", "That portal request ID was already used for another transition.");
        }
        await client.query("COMMIT");
        return { location: rowToLocation(current), replayed: true };
      }
      if (Number(current.location_revision) !== input.expectedRevision) {
        throw new PlayerLocationError("STALE_LOCATION", "Your location changed before the portal could be used.");
      }
      const values = destinationValues(input.destination);
      const updated = await client.query<LocationRow>(
        `UPDATE players SET
           location_kind=$2, location_type=$3, location_id=$4,
           location_instance_id=$5, location_space_id=$6,
           location_local_x=$7, location_local_y=$8, location_facing=$9,
           region_code=COALESCE($10,region_code), lat=COALESCE($11,lat), lon=COALESCE($12,lon),
           geom=CASE WHEN $11::double precision IS NULL OR $12::double precision IS NULL
             THEN geom ELSE ST_SetSRID(ST_MakePoint($12,$11),4326) END,
           location_revision=location_revision+1, last_portal_id=$13,
           last_transition_request_id=$14, last_transition_request_hash=$15
         WHERE id=$1 RETURNING region_code,lat,lon,location_kind,location_type,
           location_id,location_instance_id,location_space_id,location_local_x,
           location_local_y,location_facing,location_revision,last_portal_id,
           last_transition_request_id,last_transition_request_hash`,
        [input.playerId, ...values, input.portalId, input.requestId, requestHash]
      );
      await client.query("COMMIT");
      return { location: rowToLocation(updated.rows[0]!), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async persistInteriorPosition(input: Readonly<{
    playerId: string; instanceId: string; spaceId: string; x: number; y: number; facing?: number;
  }>): Promise<void> {
    const result = await this.pool.query(
      `UPDATE players SET
         location_local_x=CASE WHEN location_type='cistern_warrens'
           THEN $4::double precision/$7::double precision ELSE $4 END,
         location_local_y=CASE WHEN location_type='cistern_warrens'
           THEN $5::double precision/$7::double precision ELSE $5 END,
         location_facing=$6
       WHERE id=$1 AND location_kind='interior'
         AND location_instance_id=$2 AND location_space_id=$3`,
      [input.playerId, input.instanceId, input.spaceId, input.x, input.y, input.facing ?? null,
        CISTERN_WARRENS_INDOOR_UNITS_PER_STORED_UNIT]
    );
    if (result.rowCount !== 1) {
      throw new PlayerLocationError("LOCATION_CHANGED", "The active interior space changed before position persistence.");
    }
  }
}

const SELECT_LOCATION = `SELECT region_code,lat,lon,location_kind,location_type,location_id,
  location_instance_id,location_space_id,location_local_x,location_local_y,
  location_facing,location_revision,last_portal_id,last_transition_request_id,
  last_transition_request_hash FROM players`;

function destinationValues(endpoint: PortalEndpoint): readonly unknown[] {
  const position = endpoint.kind === "interior" && endpoint.locationType === "cistern_warrens"
    ? cisternWarrensIndoorPointToStored(endpoint.position)
    : endpoint.kind === "interior" ? endpoint.position : null;
  return endpoint.kind === "world"
    ? ["world", null, null, null, null, null, null, null, endpoint.regionCode, endpoint.position.lat, endpoint.position.lon]
    : ["interior", endpoint.locationType, endpoint.locationId, endpoint.instanceId,
        endpoint.spaceId, position!.x, position!.y, endpoint.facing ?? null,
        null, null, null];
}

function rowToLocation(row: LocationRow): PlayerLocationSnapshot {
  const revision = Number(row.location_revision);
  if (row.location_kind === "world") {
    return {
      kind: "world", regionCode: row.region_code,
      zoneId: zoneIdForPosition({ lat: Number(row.lat), lon: Number(row.lon) }),
      position: { lat: Number(row.lat), lon: Number(row.lon) }, revision,
      ...(row.last_portal_id ? { lastPortalId: row.last_portal_id } : {})
    };
  }
  if (!row.location_type || !row.location_id || !row.location_instance_id ||
      !row.location_space_id || row.location_local_x === null || row.location_local_y === null ||
      !row.last_portal_id) {
    throw new PlayerLocationError("INVALID_LOCATION", "The durable interior location is incomplete.");
  }
  const storedPosition = { x: Number(row.location_local_x), y: Number(row.location_local_y) };
  const position = row.location_type === "cistern_warrens"
    ? cisternWarrensStoredPointToIndoor(storedPosition)
    : storedPosition;
  return {
    kind: "interior", locationType: row.location_type, locationId: row.location_id,
    instanceId: row.location_instance_id, spaceId: row.location_space_id,
    regionCode: interiorRegionCode(row.location_instance_id),
    zoneId: interiorZoneId(row.location_instance_id, row.location_space_id),
    position,
    ...(row.location_facing === null ? {} : { facing: Number(row.location_facing) }),
    revision, lastPortalId: row.last_portal_id
  };
}

function transitionRequestHash(input: Readonly<{
  portalId: string; expectedRevision: number; destination: PortalEndpoint;
}>): string {
  return createHash("sha256").update(JSON.stringify({
    portalId: input.portalId, expectedRevision: input.expectedRevision,
    destination: input.destination
  })).digest("hex");
}
