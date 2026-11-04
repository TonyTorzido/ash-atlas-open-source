import {
  HOLLIN_ORCHARD_PLANT_KEY,
  HOLLIN_ORCHARD_YIELD_ITEM,
  HOLLIN_ORCHARD_YIELD_QUANTITY,
  PLANT_BOOK_ROSTER,
  isActiveResourceType,
  type ResourceType,
  type LatLon,
  type PlantBookKey
} from "@ash-atlas/shared";
import { randomUUID } from "node:crypto";
import type pg from "pg";

import type { AppLogger } from "../logger.js";

type DeveloperSpawnedPlantRow = Readonly<{
  entity_id: string;
  creator_player_id: string | null;
  request_id: string;
  plant_key: string;
  resource_type: string;
  quantity: number | string;
  region_code: string;
  zone_id: string;
  spawn_lat: number | string;
  spawn_lon: number | string;
  state: string;
  state_revision: number | string;
  created_at: Date | string;
  harvested_at: Date | string | null;
  harvested_by_player_id: string | null;
}>;

export type DeveloperSpawnedPlant = Readonly<{
  entityId: string;
  creatorPlayerId: string | null;
  requestId: string;
  plantKey: PlantBookKey;
  resourceType: ResourceType;
  quantity: number;
  regionCode: string;
  zoneId: string;
  position: LatLon;
  state: "available" | "harvested";
  stateRevision: number;
  createdAt: string;
  harvestedAt: string | null;
  harvestedByPlayerId: string | null;
}>;

export type DeveloperSpawnedPlantInput = Readonly<{
  creatorPlayerId: string;
  requestId: string;
  plantKey: PlantBookKey;
  regionCode: string;
  zoneId: string;
  position: LatLon;
}>;

const PLANT_DEFINITIONS = new Map<string, { itemId: ResourceType; harvestQuantity: number }>([
  ...PLANT_BOOK_ROSTER.map((entry) => [entry.plantKey, entry] as const),
  // Hollin orchard trees ride the same durable plant rows; they are not Creature Book plants.
  [HOLLIN_ORCHARD_PLANT_KEY, { itemId: HOLLIN_ORCHARD_YIELD_ITEM, harvestQuantity: HOLLIN_ORCHARD_YIELD_QUANTITY }] as const
]);

export const DEVELOPER_PLANT_ENTITY_PREFIX = "plant:dev:";

export class DeveloperSpawnedPlantService {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Pick<AppLogger, "info">
  ) {}

  async spawn(input: DeveloperSpawnedPlantInput): Promise<DeveloperSpawnedPlant> {
    return this.serializeMutation(() => this.spawnUnserialized(input));
  }

  async recover(): Promise<readonly DeveloperSpawnedPlant[]> {
    return this.serializeMutation(async () => {
      const result = await this.pool.query<DeveloperSpawnedPlantRow>(
        `SELECT entity_id,creator_player_id,request_id,plant_key,resource_type,quantity,
                region_code,zone_id,spawn_lat,spawn_lon,state,state_revision,created_at,
                harvested_at,harvested_by_player_id
           FROM developer_spawned_plants
          ORDER BY created_at,entity_id`
      );
      const plants = result.rows.map((row) => this.fromRow(row));
      this.logger.info(
        { recoveredCount: plants.length },
        "recovered persistent developer plants"
      );
      return plants;
    });
  }

  async listAvailableInVision(input: Readonly<{
    center: LatLon;
    radiusM: number;
    regionCode?: string;
  }>): Promise<readonly DeveloperSpawnedPlant[]> {
    const conditions = [
      "state = 'available'",
      `ST_DWithin(
        ST_SetSRID(ST_MakePoint(spawn_lon, spawn_lat), 4326)::geography,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
        $3
      )`
    ];
    const parameters: unknown[] = [input.center.lat, input.center.lon, input.radiusM];
    if (input.regionCode) {
      conditions.push("region_code = $4");
      parameters.push(input.regionCode);
    }
    const result = await this.pool.query<DeveloperSpawnedPlantRow>(
      `SELECT entity_id,creator_player_id,request_id,plant_key,resource_type,quantity,
              region_code,zone_id,spawn_lat,spawn_lon,state,state_revision,created_at,
              harvested_at,harvested_by_player_id
         FROM developer_spawned_plants
        WHERE ${conditions.join(" AND ")}
        ORDER BY ST_Distance(
          ST_SetSRID(ST_MakePoint(spawn_lon, spawn_lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
        ), entity_id
        LIMIT 150`,
      parameters
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  async clearPersisted(): Promise<number> {
    return this.serializeMutation(async () => {
      const result = await this.pool.query<{ entity_id: string }>(
        "DELETE FROM developer_spawned_plants WHERE plant_key <> 'hollin_orchard_tree' RETURNING entity_id"
      );
      return result.rows.length;
    });
  }

  private async spawnUnserialized(
    input: DeveloperSpawnedPlantInput
  ): Promise<DeveloperSpawnedPlant> {
    this.validateInput(input);
    const entityId = `${DEVELOPER_PLANT_ENTITY_PREFIX}${randomUUID()}`;
    const definition = PLANT_DEFINITIONS.get(input.plantKey);
    if (!definition) throw new Error("Unknown developer plant key");

    await this.pool.query(
      `INSERT INTO developer_spawned_plants
         (entity_id,creator_player_id,request_id,plant_key,resource_type,quantity,
          region_code,zone_id,spawn_lat,spawn_lon)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (creator_player_id,request_id) DO NOTHING`,
      [
        entityId,
        input.creatorPlayerId,
        input.requestId,
        input.plantKey,
        definition.itemId,
        definition.harvestQuantity,
        input.regionCode,
        input.zoneId,
        input.position.lat,
        input.position.lon
      ]
    );
    const result = await this.pool.query<DeveloperSpawnedPlantRow>(
      `SELECT entity_id,creator_player_id,request_id,plant_key,resource_type,quantity,
              region_code,zone_id,spawn_lat,spawn_lon,state,state_revision,created_at,
              harvested_at,harvested_by_player_id
         FROM developer_spawned_plants
        WHERE creator_player_id=$1 AND request_id=$2`,
      [input.creatorPlayerId, input.requestId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Developer plant spawn was not persisted");
    const persisted = this.fromRow(row);
    this.assertMatchingRequest(persisted, input);
    return persisted;
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.mutationTail.then(operation, operation);
    this.mutationTail = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  }

  private validateInput(input: DeveloperSpawnedPlantInput): void {
    if (!PLANT_DEFINITIONS.has(input.plantKey)) {
      throw new Error("Unknown developer plant key");
    }
    if (!input.creatorPlayerId || !input.requestId || !input.regionCode || !input.zoneId) {
      throw new Error("Developer plant spawn identity and location are required");
    }
    if (
      !Number.isFinite(input.position.lat) || input.position.lat < -90 || input.position.lat > 90 ||
      !Number.isFinite(input.position.lon) || input.position.lon < -180 || input.position.lon > 180
    ) {
      throw new Error("Developer plant spawn coordinate is invalid");
    }
  }

  private fromRow(row: DeveloperSpawnedPlantRow): DeveloperSpawnedPlant {
    const definition = PLANT_DEFINITIONS.get(row.plant_key as PlantBookKey);
    if (!definition) {
      throw new Error(`Persisted developer plant has unknown key ${row.plant_key}`);
    }
    if (row.resource_type !== definition.itemId || !isActiveResourceType(definition.itemId)) {
      throw new Error("Persisted developer plant has an invalid resource type");
    }
    if (row.state !== "available" && row.state !== "harvested") {
      throw new Error("Persisted developer plant has an invalid state");
    }
    const stateRevision = Number(row.state_revision);
    if (!Number.isSafeInteger(stateRevision) || stateRevision < 0) {
      throw new Error("Persisted developer plant has an invalid state revision");
    }
    const quantity = Number(row.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error("Persisted developer plant has an invalid quantity");
    }
    return {
      entityId: row.entity_id,
      creatorPlayerId: row.creator_player_id,
      requestId: row.request_id,
      plantKey: row.plant_key as PlantBookKey,
      resourceType: definition.itemId,
      quantity,
      regionCode: row.region_code,
      zoneId: row.zone_id,
      position: { lat: Number(row.spawn_lat), lon: Number(row.spawn_lon) },
      state: row.state,
      stateRevision,
      createdAt: new Date(row.created_at).toISOString(),
      harvestedAt: row.harvested_at === null ? null : new Date(row.harvested_at).toISOString(),
      harvestedByPlayerId: row.harvested_by_player_id
    };
  }

  private assertMatchingRequest(
    persisted: DeveloperSpawnedPlant,
    input: DeveloperSpawnedPlantInput
  ): void {
    if (
      persisted.plantKey !== input.plantKey ||
      persisted.regionCode !== input.regionCode ||
      persisted.zoneId !== input.zoneId ||
      persisted.position.lat !== input.position.lat ||
      persisted.position.lon !== input.position.lon
    ) {
      throw new Error("Developer plant spawn request was reused with different payload");
    }
  }
}
