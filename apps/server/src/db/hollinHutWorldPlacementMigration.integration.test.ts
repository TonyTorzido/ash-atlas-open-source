import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { vi } from "vitest";

import { hollinHutEntityId } from "@ash-atlas/shared";

import {
  HollinHutService,
  PostgresHollinHutStore,
  hollinHutSpawnAdopter,
  poolTransaction,
  type HollinHutDeps
} from "../game/hollinHuts.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATIONS = ["1012_hollin_hut_world_placement.sql", "1019_hollin_hut_grudge.sql", "1099_hollin_hut_lifetime.sql"];
const TARGET_MIGRATION = TARGET_MIGRATIONS[0]!;

describeDatabase("Hollin Hut world placement migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_hollin_world_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-hollin-world-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-hollin-world-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name < TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
        await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
      } else if (TARGET_MIGRATIONS.includes(name)) {
        await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
      }
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    // Populated upgrade: a developer-spawned hut already exists before the migration runs.
    await pool.query(
      `INSERT INTO hollin_huts (hut_id,creator_player_id,request_id,region_code,zone_id,lat,lon)
       VALUES ('hollin-hut:00000000-0000-0000-0000-000000000001',NULL,'legacy','us','z',35,-106)`
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("keeps the existing hut, makes creatorless world huts idempotent per request, and is empty on a second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual(TARGET_MIGRATIONS);
    await expect(pool!.query("SELECT count(*)::int AS n FROM hollin_huts")).resolves.toMatchObject({ rows: [{ n: 1 }] });

    const store = new PostgresHollinHutStore(pool!);
    const input = { creatorPlayerId: null as unknown as string, requestId: "world:abc", regionCode: "us", zoneId: "z", position: { lat: 36, lon: -105 } };
    const first = await store.insertHut(input, "hollin-hut:00000000-0000-0000-0000-000000000002");
    const replay = await store.insertHut(input, "hollin-hut:00000000-0000-0000-0000-000000000003");
    expect(replay.hutId).toBe(first.hutId);
    expect(first.creatorPlayerId).toBeNull();
    await expect(pool!.query("SELECT count(*)::int AS n FROM hollin_huts")).resolves.toMatchObject({ rows: [{ n: 2 }] });

    // Population V2 huts: adopted once per entity id, source recorded, orphaned when no slot exists.
    const entityId = "00000000-0000-8000-8000-0000000000aa";
    const adoptInput = { populationEntityId: entityId, regionCode: "us", zoneId: "z", position: { lat: 36.5, lon: -105 }, expiresAt: new Date(Date.now() + 86_400_000) };
    const adopted = (await store.adoptPopulationHut(adoptInput, new Date()))!;
    const again = (await store.adoptPopulationHut(adoptInput, new Date()))!;
    expect(again.hutId).toBe(adopted.hutId);
    expect(adopted).toMatchObject({ hutId: `hollin-hut:${entityId}`, source: "population", populationEntityId: entityId, creatorPlayerId: null });
    expect((await store.listOrphanedPopulationHuts()).map((hut) => hut.hutId)).toEqual([adopted.hutId]);
    expect(await store.isInsideClaimedTerritory({ lat: 36.5, lon: -105 })).toBe(false);
    expect(await store.getGrudgeUntil("nobody")).toBeNull();
    await store.ensureOrchardTrees(adopted, [{ entityId: `plant:dev:hollin-orchard:${adopted.hutId}:0`, position: { lat: 36.5, lon: -105 } }]);
    await store.deleteHut(adopted.hutId);
    await expect(pool!.query("SELECT count(*)::int AS n FROM hollin_huts WHERE hut_id=$1", [adopted.hutId])).resolves.toMatchObject({ rows: [{ n: 0 }] });
    await expect(pool!.query("SELECT count(*)::int AS n FROM developer_spawned_plants WHERE entity_id LIKE $1", [`%${adopted.hutId}%`])).resolves.toMatchObject({ rows: [{ n: 0 }] });

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([]);
  }, 120_000);

  it("adopts spawned Population V2 hut bodies idempotently across a restart, keeps orphans standing, and retires expired huts", async () => {
    await runMigrations(databaseUrl, { migrationsDirectory: targetDirectory });
    const live = "00000000-0000-8000-8000-0000000000b1";
    const orphan = "00000000-0000-8000-8000-0000000000b2";
    const generationId = "00000000-0000-8000-8000-0000000000c1";
    const planId = "00000000-0000-8000-8000-0000000000d1";
    // Only the live hut has a Population V2 slot; the other's generation was cleaned up. The slot's
    // parent rows (plan, generation) are not needed here, so FK checks are skipped for the insert.
    const client = await pool!.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await client.query(
        `INSERT INTO population_spawn_slots_v2
           (plan_id,slot_id,entity_id,candidate_id,entity_kind,archetype,encounter_id,latitude,longitude,geom,
            anchor_latitude,anchor_longitude,anchor_geom,environment_snapshot,suppression_class,generation_id)
         VALUES ($1,$2,$3,'cand','hollin_hut','hollin_hut',$4,40,-100,
                 ST_SetSRID(ST_MakePoint(-100,40),4326)::geography,40,-100,
                 ST_SetSRID(ST_MakePoint(-100,40),4326)::geography,'{}'::jsonb,'none',$5)`,
        [planId, "00000000-0000-8000-8000-0000000000e1", live, "00000000-0000-8000-8000-0000000000f1", generationId]
      );
      await client.query("SET session_replication_role = DEFAULT");
    } finally {
      client.release();
    }

    const build = () => {
      const bodies = new Map<string, unknown>();
      const combat = {
        spawnMob: vi.fn((input: { entityId: string }) => { bodies.set(input.entityId, input); return input; }),
        despawnMob: vi.fn((id: string) => bodies.delete(id)),
        despawnPopulationManagedMob: vi.fn(() => true),
        entity: vi.fn((id: string) => bodies.get(id) ?? null),
        directMobTarget: vi.fn(() => true), cancelCombat: vi.fn(() => true),
        healMob: vi.fn(() => 0), healEntity: vi.fn(() => 0)
      };
      const service = new HollinHutService({
        store: new PostgresHollinHutStore(pool!), combat,
        wallet: {} as never, inventory: {} as never,
        ranks: { ensureLoaded: async () => undefined, rankOf: () => 0 },
        transaction: poolTransaction(pool!)
      } as unknown as HollinHutDeps);
      return { service, combat, bodies };
    };
    // Far from the developer huts above (and from each other), so the 30 km rule admits both.
    const position = { lat: 40, lon: -100 };
    const orphanPosition = { lat: 45, lon: -90 };
    const orchardCount = async (hutId: string) => Number((await pool!.query(
      "SELECT count(*)::int AS n FROM developer_spawned_plants WHERE entity_id LIKE $1", [`%${hutId}%`]
    )).rows[0].n);

    const first = build();
    const adopt = hollinHutSpawnAdopter(first.service);
    await adopt({ entityKind: "hollin_hut", entityId: live }, position);
    await adopt({ entityKind: "hollin_hut", entityId: orphan }, orphanPosition);
    await adopt({ entityKind: "wolf", entityId: "00000000-0000-8000-8000-0000000000b3" }, position); // not a hut: ignored
    await expect(pool!.query("SELECT hut_id,source,population_entity_id FROM hollin_huts WHERE source='population' ORDER BY hut_id"))
      .resolves.toMatchObject({ rows: [
        { hut_id: `hollin-hut:${live}`, source: "population", population_entity_id: live },
        { hut_id: `hollin-hut:${orphan}`, source: "population", population_entity_id: orphan }
      ] });
    expect(await orchardCount(live)).toBe(4);
    // Population V2 owns the body: the service built the farmers only.
    expect(first.combat.spawnMob.mock.calls.filter(([input]) => (input as { entityId: string }).entityId === live)).toHaveLength(0);

    // Restart: a fresh service over the same database recovers both huts, and the bodies wake again.
    const second = build();
    await expect(second.service.recover()).resolves.toBeGreaterThanOrEqual(2);
    expect(second.service.ownsHutEntity(live)).toBe(true);
    const adoptAgain = hollinHutSpawnAdopter(second.service);
    await adoptAgain({ entityKind: "hollin_hut", entityId: live }, position);
    await expect(pool!.query("SELECT count(*)::int AS n FROM hollin_huts WHERE population_entity_id=$1", [live]))
      .resolves.toMatchObject({ rows: [{ n: 1 }] });
    expect(await orchardCount(live)).toBe(4);

    // Only the hut whose slot is gone is an orphan. It keeps standing: the sweep hands its body to
    // the service (life 1) with its orchard intact.
    const orphanHutId = `hollin-hut:${orphan}`;
    await expect(new PostgresHollinHutStore(pool!).listOrphanedPopulationHuts().then((huts) => huts.map((hut) => hut.hutId)))
      .resolves.toEqual([orphanHutId]);
    await second.service.tick();
    await expect(pool!.query("SELECT hut_id,life FROM hollin_huts WHERE population_entity_id IS NOT NULL ORDER BY hut_id"))
      .resolves.toMatchObject({ rows: [{ hut_id: `hollin-hut:${live}`, life: 0 }, { hut_id: orphanHutId, life: 1 }] });
    expect(second.bodies.has(hollinHutEntityId(orphanHutId, 1))).toBe(true);
    expect(await orchardCount(orphan)).toBe(4);
    expect(second.service.ownsHutEntity(orphan)).toBe(false);
    expect(second.service.ownsHutEntity(hollinHutEntityId(orphanHutId, 1))).toBe(true);
    expect(second.service.ownsHutEntity(live)).toBe(true);
    await expect(new PostgresHollinHutStore(pool!).listOrphanedPopulationHuts()).resolves.toEqual([]);

    // The old body waking again is sent away, never doubled.
    await adoptAgain({ entityKind: "hollin_hut", entityId: orphan }, orphanPosition);
    expect(second.combat.despawnPopulationManagedMob).toHaveBeenCalledWith(orphan);
    await expect(pool!.query("SELECT count(*)::int AS n FROM hollin_huts WHERE population_entity_id=$1", [orphan]))
      .resolves.toMatchObject({ rows: [{ n: 1 }] });

    // Expiry retires the hut with its orchard and body.
    await pool!.query("UPDATE hollin_huts SET expires_at=now() - interval '1 minute' WHERE hut_id=$1", [orphanHutId]);
    await second.service.tick();
    await expect(pool!.query("SELECT count(*)::int AS n FROM hollin_huts WHERE hut_id=$1", [orphanHutId]))
      .resolves.toMatchObject({ rows: [{ n: 0 }] });
    expect(await orchardCount(orphan)).toBe(0);
    expect(second.bodies.has(hollinHutEntityId(orphanHutId, 1))).toBe(false);
    expect(second.service.ownsHutEntity(live)).toBe(true);
  }, 120_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Hollin Hut migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
