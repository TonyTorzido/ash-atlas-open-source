import type { LatLon, MobAppearanceVariant, MobArchetypeKey } from "@ash-atlas/shared";
import { randomUUID } from "node:crypto";
import type pg from "pg";

import type { AppLogger } from "../logger.js";
import type { CombatEngine } from "./combat/combatEngine.js";
import { MOB_DEFINITIONS } from "./combat/mobDefinitions.js";

type DeveloperSpawnedMobRow = Readonly<{
  entity_id: string;
  creator_player_id: string | null;
  request_id: string;
  mob_archetype: string;
  appearance_variant: string;
  region_code: string;
  zone_id: string;
  spawn_lat: number;
  spawn_lon: number;
  origin_flag_id: string | null;
}>;

export type DeveloperSpawnedMob = Readonly<{
  entityId: string;
  creatorPlayerId: string | null;
  requestId: string;
  archetype: MobArchetypeKey;
  appearanceVariant: MobAppearanceVariant;
  regionCode: string;
  zoneId: string;
  position: LatLon;
  originFlagId: string | null;
}>;

export type DeveloperSpawnedMobInput = Readonly<{
  creatorPlayerId: string;
  requestId: string;
  archetype: MobArchetypeKey;
  appearanceVariant?: MobAppearanceVariant;
  regionCode: string;
  zoneId: string;
  position: LatLon;
  originFlagId: string | null;
}>;

export class DeveloperSpawnedMobService {
  private readonly ownedEntityIds = new Set<string>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly pool: pg.Pool,
    private readonly combat: CombatEngine,
    private readonly logger: AppLogger
  ) {}

  async spawn(input: DeveloperSpawnedMobInput): Promise<DeveloperSpawnedMob> {
    return this.serializeMutation(() => this.spawnUnserialized(input));
  }

  async recover(): Promise<void> {
    return this.serializeMutation(async () => {
      const result = await this.pool.query<DeveloperSpawnedMobRow>(
        `SELECT entity_id,creator_player_id,request_id,mob_archetype,appearance_variant,
                region_code,zone_id,spawn_lat,spawn_lon,origin_flag_id
           FROM developer_spawned_mobs
          ORDER BY created_at,entity_id`
      );
      for (const row of result.rows) this.ensureProjection(this.fromRow(row));
      this.logger.info(
        { recoveredCount: result.rows.length },
        "recovered persistent developer mobs"
      );
    });
  }

  owns(entityId: string): boolean {
    return this.ownedEntityIds.has(entityId);
  }

  async removeAfterDefeat(entityId: string): Promise<void> {
    return this.serializeMutation(async () => {
      await this.pool.query(
        "DELETE FROM developer_spawned_mobs WHERE entity_id=$1",
        [entityId]
      );
      this.ownedEntityIds.delete(entityId);
    });
  }

  async clearPersisted(): Promise<number> {
    return this.serializeMutation(async () => {
      const result = await this.pool.query<{ entity_id: string }>(
        "DELETE FROM developer_spawned_mobs RETURNING entity_id"
      );
      let removedCount = 0;
      for (const row of result.rows) {
        if (this.combat.despawnMob(row.entity_id)) removedCount += 1;
        this.ownedEntityIds.delete(row.entity_id);
      }
      return removedCount;
    });
  }

  private async spawnUnserialized(
    input: DeveloperSpawnedMobInput
  ): Promise<DeveloperSpawnedMob> {
    this.validateInput(input);
    const entityId = `mob:dev:${randomUUID()}`;
    const definition = MOB_DEFINITIONS[input.archetype];
    const appearanceVariant = "normal";

    await this.pool.query(
      `INSERT INTO developer_spawned_mobs
         (entity_id,creator_player_id,request_id,mob_archetype,appearance_variant,
          region_code,zone_id,spawn_lat,spawn_lon,origin_flag_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (creator_player_id,request_id) DO NOTHING`,
      [
        entityId,
        input.creatorPlayerId,
        input.requestId,
        input.archetype,
        appearanceVariant,
        input.regionCode,
        input.zoneId,
        input.position.lat,
        input.position.lon,
        input.originFlagId
      ]
    );
    const result = await this.pool.query<DeveloperSpawnedMobRow>(
      `SELECT entity_id,creator_player_id,request_id,mob_archetype,appearance_variant,
              region_code,zone_id,spawn_lat,spawn_lon,origin_flag_id
         FROM developer_spawned_mobs
        WHERE creator_player_id=$1 AND request_id=$2`,
      [input.creatorPlayerId, input.requestId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Developer mob spawn was not persisted");
    const persisted = this.fromRow(row);
    this.assertMatchingRequest(persisted, input);
    this.ensureProjection(persisted);
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

  private validateInput(input: DeveloperSpawnedMobInput): void {
    if (input.archetype === "xoral") {
      throw new Error("Xoral developer spawns are owned by the Xoral event service");
    }
    const definition = MOB_DEFINITIONS[input.archetype];
    if (!definition) throw new Error("Unknown developer mob archetype");
    if (input.appearanceVariant === "ashen") {
      throw new Error("The Ashen appearance has been retired");
    }
    if (!input.creatorPlayerId || !input.requestId || !input.regionCode || !input.zoneId) {
      throw new Error("Developer mob spawn identity and location are required");
    }
    if (
      !Number.isFinite(input.position.lat) || input.position.lat < -90 || input.position.lat > 90 ||
      !Number.isFinite(input.position.lon) || input.position.lon < -180 || input.position.lon > 180
    ) {
      throw new Error("Developer mob spawn coordinate is invalid");
    }
  }

  private fromRow(row: DeveloperSpawnedMobRow): DeveloperSpawnedMob {
    if (!Object.hasOwn(MOB_DEFINITIONS, row.mob_archetype)) {
      throw new Error(`Persisted developer mob has unknown archetype ${row.mob_archetype}`);
    }
    if (row.mob_archetype === "xoral") {
      throw new Error("Persisted Xoral developer mob violates event ownership");
    }
    if (row.appearance_variant !== "normal" && row.appearance_variant !== "ashen") {
      throw new Error("Persisted developer mob has invalid appearance variant");
    }
    const archetype = row.mob_archetype as MobArchetypeKey;
    return {
      entityId: row.entity_id,
      creatorPlayerId: row.creator_player_id,
      requestId: row.request_id,
      archetype,
      // Retired Ashen rows stay in the table but restore as normal mobs.
      appearanceVariant: "normal",
      regionCode: row.region_code,
      zoneId: row.zone_id,
      position: { lat: Number(row.spawn_lat), lon: Number(row.spawn_lon) },
      originFlagId: row.origin_flag_id
    };
  }

  private assertMatchingRequest(
    persisted: DeveloperSpawnedMob,
    input: DeveloperSpawnedMobInput
  ): void {
    const expectedAppearance = "normal";
    if (
      persisted.archetype !== input.archetype ||
      persisted.appearanceVariant !== expectedAppearance ||
      persisted.regionCode !== input.regionCode ||
      persisted.zoneId !== input.zoneId ||
      persisted.position.lat !== input.position.lat ||
      persisted.position.lon !== input.position.lon ||
      persisted.originFlagId !== input.originFlagId
    ) {
      throw new Error("Developer mob spawn request was reused with different payload");
    }
  }

  private ensureProjection(mob: DeveloperSpawnedMob): void {
    const existing = this.combat.entity(mob.entityId);
    if (existing) {
      if (
        existing.kind !== "mob" ||
        existing.archetypeKey !== mob.archetype ||
        existing.appearanceVariant !== mob.appearanceVariant
      ) {
        throw new Error(`Combat entity ${mob.entityId} conflicts with persisted developer mob`);
      }
      this.ownedEntityIds.add(mob.entityId);
      return;
    }
    const definition = MOB_DEFINITIONS[mob.archetype];
    this.combat.spawnMob({
      entityId: mob.entityId,
      archetype: mob.archetype,
      worldAi: true,
      position: mob.position,
      homePosition: mob.position,
      regionCode: mob.regionCode,
      zoneId: mob.zoneId,
      originFlagId: mob.originFlagId
    });
    this.ownedEntityIds.add(mob.entityId);
  }
}
