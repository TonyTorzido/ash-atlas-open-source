import {
  DUNGEON_CATALOG,
  findDeveloperDungeonEntranceTemplate,
  portalIds,
  type DungeonCatalog,
  type DungeonEntranceSnapshot,
  type LatLon
} from "@ash-atlas/shared";
import { GOLEM_FORGE_DUNGEON_ID } from "./golemForge.js";
import { GOLEM_FORGE_ENTRANCE_TEMPLATE_ID } from "./golemForgeSites.js";
import { randomUUID } from "node:crypto";
import { boundedPortalRevision } from "./locations/portalRevision.js";
import type pg from "pg";

import type { AppLogger } from "../logger.js";

type DeveloperSpawnedDungeonRow = Readonly<{
  entrance_id: string;
  creator_player_id: string | null;
  request_id: string;
  template_id: string;
  template_revision: string;
  template_portal_revision: string;
  dungeon_revision: string;
  catalog_revision: number;
  placement_revision: number;
  region_code: string;
  spawn_lat: number;
  spawn_lon: number;
  created_at: string | Date;
  deleted_at: string | Date | null;
  expires_at: string | Date | null;
  event_kind: string | null;
}>;

export class DeveloperSpawnedDungeonError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DeveloperSpawnedDungeonError";
  }
}

export type DeveloperSpawnedDungeonEntrance = Readonly<{
  entranceId: string;
  creatorPlayerId: string | null;
  requestId: string;
  templateId: string;
  templateRevision: string;
  templatePortalRevision: string;
  dungeonRevision: string;
  catalogRevision: number;
  placementRevision: number;
  regionCode: string;
  position: LatLon;
  createdAt: string;
  deletedAt: string | null;
  /** World events (the Fallen Prison crash) end on their own; developer placements never expire. */
  expiresAt: string | null;
  /** Null for developer placements; set for world events, which keep the dungeon's normal entry rules. */
  eventKind: string | null;
}>;

export type DeveloperSpawnedDungeonInput = Readonly<{
  creatorPlayerId: string;
  requestId: string;
  templateId: string;
  regionCode: string;
  position: LatLon;
  expiresAt?: Date;
  eventKind?: string;
}>;

export type DeveloperSpawnedDungeonSpawnResult = Readonly<{
  entrance: DeveloperSpawnedDungeonEntrance;
  replayed: boolean;
}>;

export type DeveloperSpawnedDungeonDeletionResult = Readonly<{
  entrance: DeveloperSpawnedDungeonEntrance;
  replayed: boolean;
}>;

/**
 * Durable developer-only dungeon entrance placements.
 *
 * Authored catalog entrances never pass through this service. A placement
 * stores the template revisions used at creation time, while its dungeon
 * content remains owned by the catalog. Deletion is a tombstone so existing
 * dungeon presence and run rows can drain normally.
 */
export class DeveloperSpawnedDungeonService {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly pool: pg.Pool,
    private readonly catalog: DungeonCatalog = DUNGEON_CATALOG,
    private readonly logger?: AppLogger
  ) {}

  async spawn(input: DeveloperSpawnedDungeonInput): Promise<DeveloperSpawnedDungeonSpawnResult> {
    return this.serializeMutation(() => this.spawnUnserialized(input));
  }

  async listActive(): Promise<DeveloperSpawnedDungeonEntrance[]> {
    const result = await this.pool.query<DeveloperSpawnedDungeonRow>(
      `SELECT entrance_id,creator_player_id,request_id,template_id,template_revision,
              template_portal_revision,dungeon_revision,catalog_revision,placement_revision,
              region_code,spawn_lat,spawn_lon,created_at,deleted_at,expires_at,event_kind
         FROM developer_spawned_dungeon_entrances
        WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at,entrance_id`
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  /** Resolves tombstones as well as active placements for portal drain/reconnect paths. */
  async find(entranceId: string, includeDeleted = true): Promise<DeveloperSpawnedDungeonEntrance | null> {
    const result = await this.pool.query<DeveloperSpawnedDungeonRow>(
      `SELECT entrance_id,creator_player_id,request_id,template_id,template_revision,
              template_portal_revision,dungeon_revision,catalog_revision,placement_revision,
              region_code,spawn_lat,spawn_lon,created_at,deleted_at,expires_at,event_kind
         FROM developer_spawned_dungeon_entrances
        WHERE entrance_id=$1
          AND ($2 OR deleted_at IS NULL)`,
      [entranceId, includeDeleted]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  snapshotFor(placement: DeveloperSpawnedDungeonEntrance): DungeonEntranceSnapshot {
    const template = this.templateFor(placement.templateId);
    return {
      entranceId: placement.entranceId,
      dungeonId: template.dungeonId,
      portalId: portalIds.dungeon(placement.entranceId, template.portalId),
      portalRevision: this.portalRevisionFor(placement),
      interactionLabel: template.interactionLabel,
      name: template.name,
      description: template.description,
      regionCode: placement.regionCode,
      lat: placement.position.lat,
      lon: placement.position.lon,
      interactionRadiusM: template.interactionRadiusM,
      footprintRadiusM: template.footprintRadiusM,
      presentation: template.presentation,
      // A derived template has no art: wear the dungeon's own library entrance art (the Forge's tower,
      // the Fallen Prison crash), so every dungeon shows its own entrance.
      assetKey: template.assetKey ?? libraryEntranceAssetKey(this.catalog, template.dungeonId),
      // A developer Golem Forge goes through the real torch lobby, price and gates (it never collapses).
      developerSpawned: placement.eventKind === null && template.dungeonId !== GOLEM_FORGE_DUNGEON_ID,
      templateId: placement.templateId,
      placementRevision: placement.placementRevision,
      createdAt: placement.createdAt,
      dungeonRevision: placement.dungeonRevision,
      ...(this.catalog.dungeons.find((candidate) => candidate.id === template.dungeonId)?.access
        ? { access: structuredClone(this.catalog.dungeons.find((candidate) => candidate.id === template.dungeonId)!.access!) } : {})
    };
  }

  portalRevisionFor(placement: DeveloperSpawnedDungeonEntrance): string {
    return boundedPortalRevision(`developer:${placement.placementRevision}:${placement.templateRevision}:${placement.templatePortalRevision}:${placement.dungeonRevision}`);
  }

  async delete(
    actorPlayerId: string,
    requestId: string,
    entranceId: string
  ): Promise<DeveloperSpawnedDungeonDeletionResult> {
    return this.serializeMutation(() => this.deleteUnserialized(actorPlayerId, requestId, entranceId));
  }

  private async spawnUnserialized(
    input: DeveloperSpawnedDungeonInput
  ): Promise<DeveloperSpawnedDungeonSpawnResult> {
    this.validateIdentityAndPosition(input);
    const existing = await this.findByRequest(input.creatorPlayerId, input.requestId);
    if (existing) {
      this.assertMatchingRequest(existing, input);
      return { entrance: existing, replayed: true };
    }
    const template = this.validateInput(input);
    const dungeon = this.dungeonFor(template.dungeonId);
    const entranceId = `dev-dungeon-${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO developer_spawned_dungeon_entrances (
         entrance_id,creator_player_id,request_id,template_id,template_revision,
         template_portal_revision,dungeon_revision,catalog_revision,placement_revision,
         region_code,spawn_lat,spawn_lon,expires_at,event_kind
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13)
       ON CONFLICT (creator_player_id,request_id) DO NOTHING`,
      [
        entranceId,
        input.creatorPlayerId,
        input.requestId,
        template.id,
        template.revision,
        template.portalRevision,
        dungeon.revision,
        this.catalog.catalogRevision,
        input.regionCode,
        input.position.lat,
        input.position.lon,
        input.expiresAt ?? null,
        input.eventKind ?? null
      ]
    );
    const result = await this.pool.query<DeveloperSpawnedDungeonRow>(
      `SELECT entrance_id,creator_player_id,request_id,template_id,template_revision,
              template_portal_revision,dungeon_revision,catalog_revision,placement_revision,
              region_code,spawn_lat,spawn_lon,created_at,deleted_at,expires_at,event_kind
         FROM developer_spawned_dungeon_entrances
        WHERE creator_player_id=$1 AND request_id=$2`,
      [input.creatorPlayerId, input.requestId]
    );
    const row = result.rows[0];
    if (!row) throw new DeveloperSpawnedDungeonError(
      "PERSISTENCE_FAILED",
      "Developer dungeon entrance was not persisted"
    );
    const placement = this.fromRow(row);
    this.assertMatchingRequest(placement, input);
    const replayed = placement.entranceId !== entranceId;
    this.logger?.info(
      { entranceId: placement.entranceId, creatorPlayerId: input.creatorPlayerId, replayed },
      "developer dungeon entrance placement persisted"
    );
    return { entrance: placement, replayed };
  }

  private async deleteUnserialized(
    actorPlayerId: string,
    requestId: string,
    entranceId: string
  ): Promise<DeveloperSpawnedDungeonDeletionResult> {
    if (!actorPlayerId || !requestId || !entranceId) {
      throw new DeveloperSpawnedDungeonError(
        "INVALID_REQUEST",
        "Developer dungeon entrance deletion identity is required"
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `developer-dungeon-delete-request:${actorPlayerId}:${requestId}`
      ]);
      const prior = await client.query<{ entrance_id: string }>(
        `SELECT entrance_id
           FROM developer_spawned_dungeon_entrance_deletions
          WHERE actor_player_id=$1 AND request_id=$2
          FOR UPDATE`,
        [actorPlayerId, requestId]
      );
      if (prior.rows[0] && prior.rows[0].entrance_id !== entranceId) {
        throw new DeveloperSpawnedDungeonError(
          "REQUEST_ID_REUSED",
          "That deletion request ID was reused for another dungeon entrance"
        );
      }
      const placementResult = await client.query<DeveloperSpawnedDungeonRow>(
        `SELECT entrance_id,creator_player_id,request_id,template_id,template_revision,
                template_portal_revision,dungeon_revision,catalog_revision,placement_revision,
                region_code,spawn_lat,spawn_lon,created_at,deleted_at,expires_at,event_kind
           FROM developer_spawned_dungeon_entrances
          WHERE entrance_id=$1
          FOR UPDATE`,
        [entranceId]
      );
      const row = placementResult.rows[0];
      if (!row) throw new DeveloperSpawnedDungeonError(
        "ENTRANCE_NOT_FOUND",
        "That dungeon entrance is not a developer placement"
      );
      const wasDeleted = row.deleted_at !== null;
      if (!wasDeleted) {
        await client.query(
          `UPDATE developer_spawned_dungeon_entrances
              SET deleted_at=now()
            WHERE entrance_id=$1`,
          [entranceId]
        );
      }
      if (!prior.rows[0]) {
        await client.query(
          `INSERT INTO developer_spawned_dungeon_entrance_deletions
             (actor_player_id,request_id,entrance_id)
           VALUES ($1,$2,$3)`,
          [actorPlayerId, requestId, entranceId]
        );
      }
      const updated = await client.query<DeveloperSpawnedDungeonRow>(
        `SELECT entrance_id,creator_player_id,request_id,template_id,template_revision,
                template_portal_revision,dungeon_revision,catalog_revision,placement_revision,
                region_code,spawn_lat,spawn_lon,created_at,deleted_at,expires_at,event_kind
           FROM developer_spawned_dungeon_entrances
          WHERE entrance_id=$1`,
        [entranceId]
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new DeveloperSpawnedDungeonError(
        "PERSISTENCE_FAILED",
        "Deleted developer dungeon entrance could not be reloaded"
      );
      await client.query("COMMIT");
      const entrance = this.fromRow(updatedRow);
      this.logger?.info(
        { entranceId, actorPlayerId, replayed: wasDeleted || Boolean(prior.rows[0]) },
        "developer dungeon entrance placement tombstoned"
      );
      return { entrance, replayed: wasDeleted || Boolean(prior.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.mutationTail.then(operation, operation);
    this.mutationTail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  private validateInput(input: DeveloperSpawnedDungeonInput) {
    // Active authored templates, or a template derived from any active dungeon that has none.
    const template = findDeveloperDungeonEntranceTemplate(this.catalog, input.templateId);
    if (!template) throw new DeveloperSpawnedDungeonError(
      "TEMPLATE_NOT_FOUND",
      "That dungeon entrance template is unavailable"
    );
    return template;
  }

  private validateIdentityAndPosition(input: DeveloperSpawnedDungeonInput): void {
    if (!input.creatorPlayerId || !input.requestId || !input.templateId || !input.regionCode) {
      throw new DeveloperSpawnedDungeonError(
        "INVALID_REQUEST",
        "Developer dungeon entrance identity and location are required"
      );
    }
    if (input.requestId.length > 128) {
      throw new DeveloperSpawnedDungeonError("INVALID_REQUEST", "Developer request ID is too long");
    }
    if (
      !Number.isFinite(input.position.lat) || input.position.lat < -90 || input.position.lat > 90 ||
      !Number.isFinite(input.position.lon) || input.position.lon < -180 || input.position.lon > 180
    ) {
      throw new DeveloperSpawnedDungeonError("INVALID_POSITION", "Developer dungeon coordinate is invalid");
    }
  }

  private async findByRequest(
    creatorPlayerId: string,
    requestId: string
  ): Promise<DeveloperSpawnedDungeonEntrance | null> {
    const result = await this.pool.query<DeveloperSpawnedDungeonRow>(
      `SELECT entrance_id,creator_player_id,request_id,template_id,template_revision,
              template_portal_revision,dungeon_revision,catalog_revision,placement_revision,
              region_code,spawn_lat,spawn_lon,created_at,deleted_at,expires_at,event_kind
         FROM developer_spawned_dungeon_entrances
        WHERE creator_player_id=$1 AND request_id=$2`,
      [creatorPlayerId, requestId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  private dungeonFor(dungeonId: string) {
    const dungeon = this.catalog.dungeons.find((candidate) =>
      candidate.id === dungeonId && !candidate.retired
    );
    if (!dungeon) throw new DeveloperSpawnedDungeonError(
      "TEMPLATE_NOT_FOUND",
      "That dungeon definition is unavailable"
    );
    return dungeon;
  }

  private templateFor(templateId: string) {
    const template = findDeveloperDungeonEntranceTemplate(this.catalog, templateId, true);
    if (!template) throw new DeveloperSpawnedDungeonError(
      "TEMPLATE_NOT_FOUND",
      "The dungeon entrance template is unavailable"
    );
    return template;
  }

  private assertMatchingRequest(
    persisted: DeveloperSpawnedDungeonEntrance,
    input: DeveloperSpawnedDungeonInput
  ): void {
    if (
      persisted.creatorPlayerId !== input.creatorPlayerId ||
      persisted.requestId !== input.requestId ||
      persisted.templateId !== input.templateId ||
      persisted.regionCode !== input.regionCode ||
      persisted.position.lat !== input.position.lat ||
      persisted.position.lon !== input.position.lon
    ) {
      throw new DeveloperSpawnedDungeonError(
        "REQUEST_ID_REUSED",
        "That spawn request ID was reused with a different payload"
      );
    }
  }

  private fromRow(row: DeveloperSpawnedDungeonRow): DeveloperSpawnedDungeonEntrance {
    return {
      entranceId: row.entrance_id,
      creatorPlayerId: row.creator_player_id,
      requestId: row.request_id,
      templateId: row.template_id,
      templateRevision: row.template_revision,
      templatePortalRevision: row.template_portal_revision,
      dungeonRevision: row.dungeon_revision,
      catalogRevision: Number(row.catalog_revision),
      placementRevision: Number(row.placement_revision),
      regionCode: row.region_code,
      position: { lat: Number(row.spawn_lat), lon: Number(row.spawn_lon) },
      createdAt: toIsoString(row.created_at),
      // An expired event reads as tombstoned, so players inside drain out and nobody new can enter.
      deletedAt: row.deleted_at !== null
        ? toIsoString(row.deleted_at)
        : row.expires_at != null && new Date(row.expires_at).getTime() <= Date.now() ? toIsoString(row.expires_at) : null,
      expiresAt: row.expires_at == null ? null : toIsoString(row.expires_at),
      eventKind: row.event_kind ?? null
    };
  }
}

/** The stock cave art is the client's own fallback, not a dungeon's art. */
const STOCK_ENTRANCE_ASSET_KEY = "apps/client/public/assets/dungeons/shared/orc-cave-entrance.png";

/** The unique entrance art of a dungeon's library entrance (placed or retired), or null when it has none. */
export function libraryEntranceAssetKey(catalog: DungeonCatalog, dungeonId: string): string | null {
  const preferred = dungeonId === GOLEM_FORGE_DUNGEON_ID
    ? catalog.entrances.find((entrance) => entrance.id === GOLEM_FORGE_ENTRANCE_TEMPLATE_ID)
    : undefined;
  return (preferred ?? catalog.entrances.find((entrance) =>
    entrance.dungeonId === dungeonId && entrance.assetKey && entrance.assetKey !== STOCK_ENTRANCE_ASSET_KEY))?.assetKey ?? null;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
