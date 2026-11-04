import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import {
  generatePopulationZoneV2Plan,
  isPermanentMineEntityKind,
  populationZoneV2PlanContentHash,
  populationZoneV3ConservativeHabitat,
  type GeneratedPopulationZoneV2Plan
} from "../game/populationZonesV2Plan.js";
import {
  populationZoneV2Halo,
  populationZoneV2IdForPoint,
  type PopulationZoneV2Id
} from "../game/populationZonesV2Geometry.js";
import {
  populationZoneV2PlanId,
  type PopulationZoneV2PlanIdentity
} from "../game/populationZonesV2Identity.js";
import {
  PostgresPopulationZonesV2Store
} from "../game/populationZonesV2Store.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = "0764_permanent_mine_cutover_continuity.sql";

describeDatabase("permanent mine cutover continuity migration", () => {
  const sourceMigrations = fileURLToPath(
    new URL("../../../../db/migrations", import.meta.url)
  );
  const databaseName = `ash_atlas_stability_mine_cutover_${randomUUID()
    .replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseUrl = "";
  let precedingMigrations = "";

  beforeAll(async () => {
    const parsed = assertDisposableDatabase(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname='ash_atlas_telemetry_exporter'
      ) THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-mine-cutover-")
    );
    for (const name of await readdir(sourceMigrations)) {
      if (!name.endsWith(".sql") || name === migration) continue;
      await copyFile(
        path.join(sourceMigrations, name),
        path.join(precedingMigrations, name)
      );
    }
    await runMigrations(databaseUrl, {
      migrationsDirectory: precedingMigrations
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin?.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("repairs only stale selected-plan membership and rejects an incomplete cutover", async () => {
    const store = new PostgresPopulationZonesV2Store(pool);
    const fixture = fixturePlanWithPermanentMine();
    const priorPlan = planForSpawnRules(
      fixture.plan,
      "population-spawn-rules-v2-migration-prior",
      fixture.plan.slots
    );
    await completePlan(store, priorPlan);
    const mine = (await store.loadReadyEntitiesForZones([fixture.zoneId]))
      .find((entity) => isPermanentMineEntityKind(entity.entityKind));
    if (!mine) throw new Error("migration fixture mine was not ready");
    await store.transitionEntityState({
      entityId: mine.entityId,
      expectedStateRevision: mine.stateRevision,
      state: "harvested",
      eventAt: new Date("2099-06-01T00:00:00.000Z"),
      durableRuntimeState: { migrationContinuity: "preserved" }
    });
    await pool.query(
      `UPDATE repeatable_resource_nodes
       SET population_flag_suppressed=true
       WHERE population_v2_entity_id=$1::uuid`,
      [mine.entityId]
    );
    const before = await mineSnapshot(pool, mine.entityId);
    const targetPlan = planForSpawnRules(
      fixture.plan,
      "population-spawn-rules-v2-migration-target",
      fixture.plan.slots.filter((slot) =>
        !isPermanentMineEntityKind(slot.entityKind)
      )
    );
    await store.ensurePlanForZone(requestForPlan(targetPlan));
    await pool.query(
      `UPDATE population_zone_cutovers_v2
       SET selected_plan_id=$2::uuid,
           cutover_revision=cutover_revision + 1,
           updated_at=clock_timestamp()
       WHERE zone_id=$1`,
      [fixture.zoneId, targetPlan.planId]
    );
    await expect(pool.query(
      `SELECT 1
       FROM population_plan_permanent_resources_v2
       WHERE plan_id=$1::uuid AND entity_id=$2::uuid`,
      [targetPlan.planId, mine.entityId]
    )).resolves.toMatchObject({ rowCount: 0 });

    await expect(runMigrations(databaseUrl)).resolves.toEqual([migration]);
    const after = await mineSnapshot(pool, mine.entityId);
    expect(after).toEqual({
      ...before,
      cutover_revision: after.cutover_revision,
      population_cutover_revision: after.cutover_revision,
      selected_plan_id: targetPlan.planId,
      selected_membership: true
    });
    expect(after.cutover_revision).not.toBe(before.cutover_revision);
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);

    const rejectedPlan = planForSpawnRules(
      fixture.plan,
      "population-spawn-rules-v2-migration-rejected",
      targetPlan.slots
    );
    await store.ensurePlanForZone(requestForPlan(rejectedPlan));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE population_zone_cutovers_v2
         SET selected_plan_id=$2::uuid,
             cutover_revision=cutover_revision + 1,
             updated_at=clock_timestamp()
         WHERE zone_id=$1`,
        [fixture.zoneId, rejectedPlan.planId]
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "population_permanent_mine_cutover_continuity"
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }, 120_000);
});

function fixturePlanWithPermanentMine(): Readonly<{
  zoneId: PopulationZoneV2Id;
  plan: GeneratedPopulationZoneV2Plan;
}> {
  const worldEnvironmentIdentityKey = "8".repeat(64);
  const worldPipelineSha = "8".repeat(40);
  const origin = populationZoneV2IdForPoint({ lat: 40.7608, lon: -111.891 });
  for (const zoneId of populationZoneV2Halo(origin, 12)) {
    const plan = generatePopulationZoneV2Plan({
      zoneId,
      worldEnvironmentIdentityKey,
      worldPipelineSha,
      habitatForZone: (candidate) => populationZoneV3ConservativeHabitat({
        zoneId: candidate,
        worldEnvironmentIdentityKey
      })
    });
    if (plan.slots.some((slot) =>
      isPermanentMineEntityKind(slot.entityKind)
    )) {
      return { zoneId, plan };
    }
  }
  throw new Error("migration fixture could not find a permanent-mine plan");
}

function planForSpawnRules(
  source: GeneratedPopulationZoneV2Plan,
  spawnRulesVersion: string,
  slots: GeneratedPopulationZoneV2Plan["slots"]
): GeneratedPopulationZoneV2Plan {
  const identity = {
    ...source.identity,
    spawnRulesVersion
  } as unknown as PopulationZoneV2PlanIdentity;
  const draft = {
    ...source,
    identity,
    planId: populationZoneV2PlanId(identity),
    slots,
    contentHash: ""
  };
  return { ...draft, contentHash: populationZoneV2PlanContentHash(draft) };
}

function requestForPlan(plan: GeneratedPopulationZoneV2Plan) {
  return {
    identity: plan.identity,
    planId: plan.planId,
    worldPipelineSha: plan.worldPipelineSha,
    regionCode: plan.habitat.regionCode
  };
}

async function completePlan(
  store: PostgresPopulationZonesV2Store,
  plan: GeneratedPopulationZoneV2Plan
): Promise<void> {
  const request = requestForPlan(plan);
  await store.ensurePlanForZone(request);
  const claim = await store.claimPlan(request.identity, randomUUID(), 30_000);
  if (!claim) throw new Error("migration fixture plan could not be claimed");
  await store.completePlan(claim, plan);
}

async function mineSnapshot(pool: pg.Pool, entityId: string) {
  const result = await pool.query(
    `SELECT projection.population_v2_plan_id::text,
            projection.lat AS latitude, projection.lon AS longitude,
            projection.harvest_revision::text,
            projection.ready_at, projection.last_harvested_by,
            projection.population_v2_state_revision::text,
            projection.population_cutover_revision::text,
            projection.population_flag_suppressed,
            projection.population_v2_suppressed,
            canonical.state, canonical.state_revision::text,
            canonical.killed_or_harvested_at, canonical.respawn_at,
            canonical.durable_runtime_state,
            cutover.selected_plan_id::text,
            cutover.cutover_revision::text,
            membership.entity_id IS NOT NULL AS selected_membership
     FROM repeatable_resource_nodes AS projection
     JOIN population_entity_state_v2 AS canonical
       ON canonical.entity_id=projection.population_v2_entity_id
     JOIN population_zone_cutovers_v2 AS cutover
       ON cutover.zone_id=projection.physical_population_zone_v2_id
     LEFT JOIN population_plan_permanent_resources_v2 AS membership
       ON membership.plan_id=cutover.selected_plan_id
      AND membership.entity_id=projection.population_v2_entity_id
     WHERE projection.population_v2_entity_id=$1::uuid`,
    [entityId]
  );
  return result.rows[0];
}

function assertDisposableDatabase(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !parsed.pathname.slice(1).startsWith("ash_atlas_stability")
  ) {
    throw new Error("mine cutover migration verification requires ash_atlas_stability");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
