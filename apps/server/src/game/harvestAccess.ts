import {
  COLLECTIBLE_PICKUP_RADIUS_M,
  HARVEST_TOLL_TYPES,
  OIL_WELL_INTERACTION_RADIUS_M,
  distanceMeters,
  type HarvestAccessMode,
  type LatLon,
  type HarvestTollType,
  type HarvestTollsSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

export class HarvestAccessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HarvestAccessError";
  }
}

export class HarvestAccessService {
  // Trust rule (NATIVE_ANTISPOOF_BUILD_PLAN.md 3.3): unsettled owners keep harvest access private.
  private openPolicy: ((ownerPlayerId: string) => Promise<Readonly<{ code: string; message: string }> | null>) | null = null;

  constructor(private readonly pool: pg.Pool) {}

  setOpenPolicy(policy: ((ownerPlayerId: string) => Promise<Readonly<{ code: string; message: string }> | null>) | null): void {
    this.openPolicy = policy;
  }

  async dashboard(ownerPlayerId: string): Promise<HarvestTollsSnapshot> {
    const [settings, mines, wells] = await Promise.all([
      this.pool.query<{ harvest_type: HarvestTollType; toll_gold: string; revision: string }>(
        `SELECT harvest_type, toll_gold::text, revision::text
         FROM player_harvest_toll_settings WHERE owner_player_id=$1`,
        [ownerPlayerId]
      ),
      this.pool.query<{ asset_id: string; harvest_type: HarvestTollType; access_mode: HarvestAccessMode; access_revision: string }>(
        `SELECT id::text AS asset_id, node_type AS harvest_type,
                harvest_access_mode AS access_mode,
                harvest_access_revision::text AS access_revision
         FROM repeatable_resource_nodes WHERE owner_player_id=$1 ORDER BY claimed_at, id`,
        [ownerPlayerId]
      ),
      this.pool.query<{ asset_id: string; access_mode: HarvestAccessMode; access_revision: string }>(
        `SELECT structure_id::text AS asset_id, harvest_access_mode AS access_mode,
                harvest_access_revision::text AS access_revision
         FROM city_structures
         WHERE owner_player_id=$1 AND structure_type='oil_well' AND state='active'
         ORDER BY built_at, structure_id`,
        [ownerPlayerId]
      )
    ]);
    const byType = new Map(settings.rows.map((row) => [row.harvest_type, row]));
    return {
      settings: HARVEST_TOLL_TYPES.map((harvestType) => ({
        harvestType,
        tollGold: byType.get(harvestType)?.toll_gold ?? "0",
        revision: byType.get(harvestType)?.revision ?? "0"
      })),
      assets: [
        ...mines.rows.map((row) => ({
          assetId: row.asset_id,
          harvestType: row.harvest_type,
          label: mineLabel(row.harvest_type),
          accessMode: row.access_mode,
          accessRevision: row.access_revision
        })),
        ...wells.rows.map((row) => ({
          assetId: row.asset_id,
          harvestType: "oil_well" as const,
          label: "Oil Well",
          accessMode: row.access_mode,
          accessRevision: row.access_revision
        }))
      ]
    };
  }

  async updateToll(input: {
    ownerPlayerId: string;
    harvestType: HarvestTollType;
    tollGold: string;
    expectedRevision: string;
  }): Promise<HarvestTollsSnapshot> {
    const toll = BigInt(input.tollGold);
    if (toll < 0n || toll > 9_999_999_999_999_999n) {
      throw new HarvestAccessError("HARVEST_TOLL_INVALID", "Toll must be a valid nonnegative Gold amount.");
    }
    const expectedRevision = BigInt(input.expectedRevision);
    const result = expectedRevision === 0n
      ? await this.pool.query(
          `INSERT INTO player_harvest_toll_settings
             (owner_player_id, harvest_type, toll_gold, revision)
           VALUES ($1,$2,$3::bigint,1)
           ON CONFLICT (owner_player_id, harvest_type) DO NOTHING`,
          [input.ownerPlayerId, input.harvestType, toll.toString()]
        )
      : await this.pool.query(
          `UPDATE player_harvest_toll_settings
           SET toll_gold=$3::bigint, revision=revision + 1
           WHERE owner_player_id=$1 AND harvest_type=$2
             AND revision=$4::bigint`,
          [input.ownerPlayerId, input.harvestType, toll.toString(), expectedRevision.toString()]
        );
    if (result.rowCount !== 1) {
      throw new HarvestAccessError("HARVEST_TOLL_CHANGED", "That toll changed. Refresh and try again.");
    }
    return this.dashboard(input.ownerPlayerId);
  }

  async updateAsset(input: {
    ownerPlayerId: string;
    assetId: string;
    harvestType: HarvestTollType;
    accessMode: HarvestAccessMode;
    expectedRevision: string;
    position: LatLon;
  }): Promise<HarvestTollsSnapshot> {
    if (input.accessMode === "public" && this.openPolicy) {
      const refusal = await this.openPolicy(input.ownerPlayerId);
      if (refusal) throw new HarvestAccessError("PRIVATE_UNTIL_SETTLED", refusal.message);
    }
    const asset = input.harvestType === "oil_well"
      ? await this.pool.query<{ owner_player_id: string | null; lat: number | string; lon: number | string }>(
          `SELECT owner_player_id, lat, lon
           FROM city_structures
           WHERE structure_id=$1::uuid AND structure_type='oil_well' AND state='active'`,
          [input.assetId]
        )
      : await this.pool.query<{ owner_player_id: string | null; lat: number | string; lon: number | string }>(
          `SELECT owner_player_id, lat, lon
           FROM repeatable_resource_nodes
           WHERE id=$1::uuid AND node_type=$2`,
          [input.assetId, input.harvestType]
        );
    const row = asset.rows[0];
    if (!row || row.owner_player_id !== input.ownerPlayerId) {
      throw new HarvestAccessError(
        "HARVEST_ACCESS_FORBIDDEN",
        "Only the structure owner can change harvest access."
      );
    }
    const interactionRadiusM = input.harvestType === "oil_well"
      ? OIL_WELL_INTERACTION_RADIUS_M
      : COLLECTIBLE_PICKUP_RADIUS_M;
    if (distanceMeters(input.position, { lat: Number(row.lat), lon: Number(row.lon) }) > interactionRadiusM) {
      throw new HarvestAccessError(
        "HARVEST_ACCESS_PROXIMITY_REQUIRED",
        `Stand within ${interactionRadiusM} meters of the ${input.harvestType === "oil_well" ? "Oil Well" : "mine"}.`
      );
    }
    const result = input.harvestType === "oil_well"
      ? await this.pool.query(
          `UPDATE city_structures SET harvest_access_mode=$1,
             harvest_access_revision=harvest_access_revision+1
           WHERE structure_id=$2::uuid AND owner_player_id=$3 AND structure_type='oil_well'
             AND state='active' AND harvest_access_revision=$4::bigint`,
          [input.accessMode, input.assetId, input.ownerPlayerId, input.expectedRevision]
        )
      : await this.pool.query(
          `UPDATE repeatable_resource_nodes SET harvest_access_mode=$1,
             harvest_access_revision=harvest_access_revision+1
           WHERE id=$2::uuid AND owner_player_id=$3 AND node_type=$4
             AND harvest_access_revision=$5::bigint`,
          [input.accessMode, input.assetId, input.ownerPlayerId, input.harvestType, input.expectedRevision]
        );
    if (result.rowCount !== 1) {
      throw new HarvestAccessError("HARVEST_ACCESS_CHANGED", "That structure changed. Refresh and try again.");
    }
    return this.dashboard(input.ownerPlayerId);
  }
}

function mineLabel(type: HarvestTollType): string {
  return type === "stone_mine"
    ? "Stone Mine"
    : type === "coal_mine"
      ? "Coal Mine"
      : type === "iron_mine"
        ? "Iron Mine"
        : "Sulfur Mine";
}
