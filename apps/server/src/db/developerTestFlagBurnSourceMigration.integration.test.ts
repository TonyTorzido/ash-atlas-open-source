import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";
import { FlagService } from "../game/flags.js";
import { InventoryService } from "../game/inventory.js";
import { PERSONAL_FLAG_WARFARE_KIND } from "../game/structureWarfare.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = "0840_developer_test_flag_burn_source.sql";

describeDatabase("developer test Flag burn source migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_dev_burn_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const sourceMigrations = fileURLToPath(
    new URL("../../../../db/migrations", import.meta.url)
  );
  const developerId = `developer-burn-${suffix}`;
  const victimId = `victim-burn-${suffix}`;
  const hostileId = `hostile-burn-${suffix}`;
  const retainedFlagId = randomUUID();
  const selfFlagId = randomUUID();
  const hostileFlagId = randomUUID();
  const retainedOperationId = randomUUID();
  let databaseUrl = "";
  let precedingMigrations = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-pre-0840-developer-burn-")
    );
    for (const name of (await readdir(sourceMigrations))
      .filter((entry) => entry.endsWith(".sql") && entry < migration)
      .sort()) {
      await copyFile(
        path.join(sourceMigrations, name),
        path.join(precedingMigrations, name)
      );
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 6 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("upgrades populated burns and routes developer burns through the player lifecycle", async () => {
    const database = pool!;
    await database.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES
         ($1,'Developer Burn','world-test',35,-106,35,-106,600,true,
          ST_SetSRID(ST_MakePoint(-106,35),4326)),
         ($2,'Victim Burn','world-test',35,-106,35,-106,600,true,
          ST_SetSRID(ST_MakePoint(-106,35),4326)),
         ($3,'Hostile Burn','world-test',35,-106,35,-106,600,true,
          ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [developerId, victimId, hostileId]
    );
    await insertFlag(database, retainedFlagId, victimId, "Retained Flag", 35, -106);
    await database.query(
      `WITH times AS (SELECT clock_timestamp() AS started_at)
       INSERT INTO flag_burn_operations (
         operation_id,burner_player_id,victim_player_id,flag_id,request_id,
         flag_name,flag_lat,flag_lon,notice_message,started_at,completes_at,
         status,reinforcement_level,burn_duration_ms,damage_cycle_id,
         remaining_duration_ms,paused_at
       )
       SELECT $1,$2,$3,$4,'retained-burn','Retained Flag',35,-106,
              'Retained burn',times.started_at,times.started_at+interval '25 seconds',
              'active',0,25000,gen_random_uuid(),25000,NULL
       FROM times`,
      [retainedOperationId, hostileId, victimId, retainedFlagId]
    );
    const retainedBefore = await database.query(
      `SELECT operation_id::text,burner_player_id,victim_player_id,flag_id::text,
              status,source_kind
       FROM flag_burn_operations WHERE operation_id=$1`,
      [retainedOperationId]
    );

    await copyFile(
      path.join(sourceMigrations, migration),
      path.join(precedingMigrations, migration)
    );
    await expect(
      runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations })
    ).resolves.toEqual([migration]);
    await expect(
      database.query(
        `SELECT operation_id::text,burner_player_id,victim_player_id,flag_id::text,
                status,source_kind,developer_test_creator_id
         FROM flag_burn_operations WHERE operation_id=$1`,
        [retainedOperationId]
      )
    ).resolves.toMatchObject({
      rows: [{
        operation_id: retainedOperationId,
        burner_player_id: hostileId,
        victim_player_id: victimId,
        flag_id: retainedFlagId,
        status: "active",
        source_kind: "player",
        developer_test_creator_id: null
      }]
    });
    expect(retainedBefore.rows).toEqual([{
      operation_id: retainedOperationId,
      burner_player_id: hostileId,
      victim_player_id: victimId,
      flag_id: retainedFlagId,
      status: "active",
      source_kind: "player"
    }]);
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);

    await insertFlag(database, selfFlagId, developerId, "Owned Flag", 34.9997, -106);
    await insertFlag(database, hostileFlagId, victimId, "Hostile Flag", 35, -105.99965);
    const developerFlagId = randomUUID();
    await insertFlag(database, developerFlagId, developerId, "Developer Tower", 35, -106, true, 3);
    await database.query(
      `INSERT INTO developer_spawned_test_flags (
         flag_id,creator_player_id,request_id,target_kind,spawn_lat,spawn_lon
       ) VALUES ($1,$2,'developer-tower','tower',35,-106)`,
      [developerFlagId, developerId]
    );
    await database.query(
      `UPDATE flags
       SET health=375,damage_cycle_id=gen_random_uuid()
       WHERE id=$1`,
      [developerFlagId]
    );

    const inventory = new InventoryService(database);
    const flags = new FlagService(
      database,
      {} as never,
      {} as never,
      { info: vi.fn(), warn: vi.fn() } as never,
      inventory
    );
    await grantTorch(inventory, developerId, "developer-tower-torch");
    const player = {
      position: { lat: 35, lon: -106 },
      target: null,
      online: true
    } as const;
    const started = await flags.structureWarfare.reserveIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: developerId,
      structureId: developerFlagId,
      requestId: "developer-tower-burn",
      player
    });
    expect(started.replayed).toBe(false);
    await expect(
      database.query(
        `SELECT source_kind,developer_test_creator_id,burner_player_id,victim_player_id
         FROM flag_burn_operations WHERE operation_id=$1`,
        [started.operation.operationId]
      )
    ).resolves.toMatchObject({
      rows: [{
        source_kind: "developer_test",
        developer_test_creator_id: developerId,
        burner_player_id: developerId,
        victim_player_id: developerId
      }]
    });
    expect(await quantity(database, developerId, "torch")).toBe(0);
    await expect(
      database.query<{ health: number; maximum_health: number; burning_reason: string | null }>(
        `SELECT health,maximum_health,burning_reason FROM flags WHERE id=$1`,
        [developerFlagId]
      )
    ).resolves.toMatchObject({
      rows: [{ health: 375, maximum_health: 2_400, burning_reason: "flag_burn" }]
    });
    const replayed = await flags.structureWarfare.reserveIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: developerId,
      structureId: developerFlagId,
      requestId: "developer-tower-burn",
      player
    });
    expect(replayed.replayed).toBe(true);
    expect(await quantity(database, developerId, "torch")).toBe(0);

    await grantTorch(inventory, developerId, "owned-flag-torch");
    await expect(flags.structureWarfare.reserveIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: developerId,
      structureId: selfFlagId,
      requestId: "owned-flag-burn",
      player
    })).rejects.toMatchObject({ code: "FLAG_BURN_TARGET_INVALID" });
    expect(await quantity(database, developerId, "torch")).toBe(1);

    await grantTorch(inventory, hostileId, "hostile-flag-torch");
    const hostile = await flags.structureWarfare.reserveIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND,
      playerId: hostileId,
      structureId: hostileFlagId,
      requestId: "hostile-flag-burn",
      player: { ...player, position: { lat: 35, lon: -105.99965 } }
    });
    expect(hostile.replayed).toBe(false);
    await expect(
      database.query(
        `SELECT source_kind,developer_test_creator_id
         FROM flag_burn_operations WHERE operation_id=$1`,
        [hostile.operation.operationId]
      )
    ).resolves.toMatchObject({ rows: [{ source_kind: "player", developer_test_creator_id: null }] });
    expect(await quantity(database, hostileId, "torch")).toBe(0);

    await expect(
      database.query(
        `INSERT INTO flag_burn_operations (
           burner_player_id,victim_player_id,flag_id,request_id,flag_name,
           flag_lat,flag_lon,notice_message,started_at,completes_at,
           status,reinforcement_level,burn_duration_ms,damage_cycle_id,
           remaining_duration_ms,source_kind
         ) VALUES ($1,$1,gen_random_uuid(),'invalid-self','Invalid self',35,-106,
                   'Invalid self',now(),now()+interval '25 seconds','active',0,25000,
                   gen_random_uuid(),0,'player')`,
        [developerId]
      )
    ).rejects.toMatchObject({ constraint: "flag_burn_operations_source_check" });
    await expect(
      database.query(
        `INSERT INTO flag_burn_operations (
           burner_player_id,victim_player_id,flag_id,request_id,flag_name,
           flag_lat,flag_lon,notice_message,started_at,completes_at,
           status,reinforcement_level,burn_duration_ms,damage_cycle_id,
           remaining_duration_ms,source_kind,developer_test_creator_id
         ) VALUES ($1,$1,$2,'invalid-developer-source','Invalid developer source',35,-106,
                   'Invalid developer source',now(),now()+interval '25 seconds','active',0,25000,
                   gen_random_uuid(),0,'developer_test',$1)`,
        [developerId, selfFlagId]
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining("marked developer test target")
    });
  }, 120_000);

  async function insertFlag(
    database: DisposableTestPool,
    id: string,
    ownerId: string,
    name: string,
    lat: number,
    lon: number,
    developerTestTarget = false,
    reinforcementLevel = 0
  ): Promise<void> {
    await database.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,resource_vision_radius_m,
         control_type,anchor_kind,system_controlled,reinforcement_level,
         access_mode,developer_test_target,geom
       ) VALUES ($1,$2,$3,$4,$5,20,650,'personal','flag',false,$6,'public',$7,
                 ST_SetSRID(ST_MakePoint($5,$4),4326))`,
      [id, ownerId, name, lat, lon, reinforcementLevel, developerTestTarget]
    );
  }

  async function grantTorch(
    inventory: InventoryService,
    playerId: string,
    key: string
  ): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `${key}:${playerId}`,
      playerId,
      source: "developer_test_flag_burn_migration",
      sourceEntityType: "developer_test_flag_burn_migration",
      sourceEntityId: playerId,
      grants: [{ itemId: "torch", variant: "default", quantity: 1 }]
    });
  }

  async function quantity(
    database: DisposableTestPool,
    playerId: string,
    itemId: string
  ): Promise<number> {
    const result = await database.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity),0)::text AS quantity
       FROM player_inventory WHERE player_id=$1 AND resource_type=$2 AND variant='default'`,
      [playerId, itemId]
    );
    return Number(result.rows[0]?.quantity ?? 0);
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error(
      "developer test Flag burn migration verification requires local ash_atlas_stability"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
