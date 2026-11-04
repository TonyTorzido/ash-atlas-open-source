import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProgressionService } from "../game/progression.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATIONS = ["1150_kingdom_level_cap_nine.sql", "1151_kingdom_member_xp.sql"];

describeDatabase("kingdom level cap 9 + member XP populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_kingdom_xp_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let migrationDirectory = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  const leader = `kxp-a-${suffix}`;
  const member = `kxp-b-${suffix}`;
  const outsider = `kxp-c-${suffix}`;
  const smallLeader = `kxp-d-${suffix}`;
  const bigKingdom = randomUUID();
  const smallKingdom = randomUUID();
  const projectId = randomUUID();

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-kingdom-xp-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATIONS[0]!)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(migrationDirectory, name));
    }
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter')
       THEN CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN; END IF; END $$`
    );
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });

    for (const playerId of [leader, member, outsider, smallLeader]) {
      const accountId = randomUUID();
      await pool.query(`INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')`, [accountId]);
      await pool.query(
        `INSERT INTO players (
           id,account_id,username,username_normalized,display_color,region_code,
           lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
         ) VALUES (
           $1,$2,$1,$1,'#38bdf8','GLOBAL',35,-106,35,-106,650,false,
           ST_SetSRID(ST_MakePoint(-106,35),4326)
         )`,
        [playerId, accountId]
      );
    }
    // A level 5 kingdom from the project era, mid-way through the 5 -> 6 project.
    await insertKingdom(bigKingdom, `kxp big ${suffix}`, leader, 5, 3_000);
    await insertMembership(bigKingdom, leader, "leader");
    await insertMembership(bigKingdom, member, "member");
    await pool.query(
      `INSERT INTO kingdom_treasury_balances (kingdom_id, resource_type, variant, quantity)
       VALUES ($1,'wood','default',10)`,
      [bigKingdom]
    );
    await pool.query(
      `INSERT INTO kingdom_projects (
         id, kingdom_id, project_type, rules_version, target_level, status, actor_player_id, request_id,
         cost_snapshot, xp_snapshot, started_at, completes_at
       ) VALUES ($1,$2,'advancement',1,6,'pending',$3,'start-6',$4::jsonb,$5::jsonb,now(),now() + interval '1 hour')`,
      [
        projectId,
        bigKingdom,
        leader,
        JSON.stringify([
          { resourceType: "wood", variant: "default", quantity: 1_650 },
          { resourceType: "stone", variant: "default", quantity: 1_300 }
        ]),
        JSON.stringify({ levelBefore: 5, lifetimeXpBefore: 3_000, targetLifetimeXp: 6_000, xpDelta: 3_000 })
      ]
    );
    // A level 1 kingdom just below the new level 2 threshold (46,000).
    await insertKingdom(smallKingdom, `kxp small ${suffix}`, smallLeader, 1, 34_000);
    await insertMembership(smallKingdom, smallLeader, "leader");
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  it("refunds in-flight projects once, raises the caps, and is a no-op when replayed", async () => {
    for (const name of TARGET_MIGRATIONS) {
      await copyFile(path.join(migrations, name), path.join(migrationDirectory, name));
    }
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual(TARGET_MIGRATIONS);

    const after = await snapshot();
    expect(after.project).toBe("cancelled");
    expect(after.treasury).toEqual({ stone: 1_300, wood: 1_660 });
    expect(after.refunds).toEqual([
      ["stone", 1_300, 0, 1_300],
      ["wood", 1_650, 10, 1_660]
    ]);
    expect(after.audits).toBe(1);
    expect(after.kingdoms[bigKingdom]).toEqual([5, 3_000]);

    // The old ledger check capped level_after at 5; a 5 -> 9 row is now valid.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO kingdom_xp_ledger (id, kingdom_id, source_type, request_id, xp_delta, xp_before, xp_after,
           level_before, level_after, level_definition_version)
         VALUES ($1,$2,'member_xp','probe',1,0,1,5,9,3)`,
        [randomUUID(), bigKingdom]
      );
      await client.query("UPDATE kingdoms SET level = 9 WHERE id = $1", [bigKingdom]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    // Empty second run: the runner skips both files, and replaying their SQL changes nothing.
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([]);
    for (const name of TARGET_MIGRATIONS) {
      const sql = await readFile(path.join(migrations, name), "utf8");
      const replay = await pool.connect();
      try {
        await replay.query("BEGIN");
        await replay.query(sql);
        await replay.query("COMMIT");
      } catch (error) {
        await replay.query("ROLLBACK");
        throw error;
      } finally {
        replay.release();
      }
    }
    expect(await snapshot()).toEqual(after);
  }, 120_000);

  it("feeds member XP 1:1 under the daily cap, once per grant, and levels up from XP", async () => {
    const progression = new ProgressionService(pool);
    const grant = (playerId: string, key: string, xp: number) => progression.grantXp({
      operationKey: key, playerId, sourceType: "combat", requestedXp: xp
    });

    // Two members earning at once: 30,000 earned, only 23,000 credited.
    await Promise.all([grant(leader, `kxp-1-${suffix}`, 15_000), grant(member, `kxp-2-${suffix}`, 15_000)]);
    // The same grant replayed (and replayed concurrently) adds nothing.
    const replays = await Promise.all([grant(leader, `kxp-1-${suffix}`, 15_000), grant(leader, `kxp-1-${suffix}`, 15_000)]);
    expect(replays.every((result) => result.replayed)).toBe(true);
    // Players outside any kingdom feed nothing.
    await grant(outsider, `kxp-3-${suffix}`, 5_000);

    const days = await pool.query<{ kingdom_id: string; earned_xp: string; credited_xp: number; grant_count: number }>(
      "SELECT kingdom_id, earned_xp::text, credited_xp, grant_count FROM kingdom_member_xp_days ORDER BY kingdom_id"
    );
    expect(days.rows).toEqual([
      { kingdom_id: bigKingdom, earned_xp: "30000", credited_xp: 23_000, grant_count: 2 }
    ]);
    const state = await snapshot();
    // Stored level 5 is kept (26,000 XP is below every new threshold above 1).
    expect(state.kingdoms[bigKingdom]).toEqual([5, 26_000]);

    // Crossing a threshold raises the stored level and writes one ledger row.
    await grant(smallLeader, `kxp-4-${suffix}`, 12_000);
    await grant(smallLeader, `kxp-4-${suffix}`, 12_000);
    expect((await snapshot()).kingdoms[smallKingdom]).toEqual([2, 46_000]);
    const ledger = await pool.query<{ source_type: string; xp_delta: number; level_before: number; level_after: number }>(
      "SELECT source_type, xp_delta, level_before, level_after FROM kingdom_xp_ledger WHERE kingdom_id = $1",
      [smallKingdom]
    );
    expect(ledger.rows).toEqual([{ source_type: "member_xp", xp_delta: 12_000, level_before: 1, level_after: 2 }]);
    const levelUps = await pool.query(
      "SELECT 1 FROM kingdom_audit_events WHERE kingdom_id = $1 AND event_type = 'kingdom_level_up'",
      [smallKingdom]
    );
    expect(levelUps.rowCount).toBe(1);
  }, 120_000);

  async function insertKingdom(id: string, name: string, founder: string, level: number, lifetimeXp: number) {
    await pool.query(
      `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id,
         founding_request_id, level, current_xp, lifetime_xp)
       VALUES ($1,$2,$2,$3,$3,$4,$5,$6,$6)`,
      [id, name, founder, `found-${id}`, level, lifetimeXp]
    );
  }

  async function insertMembership(kingdomId: string, playerId: string, role: string) {
    await pool.query(
      `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'active', now(), now())`,
      [kingdomId, playerId, role]
    );
  }

  async function snapshot() {
    const project = await pool.query<{ status: string }>("SELECT status FROM kingdom_projects WHERE id = $1", [projectId]);
    const treasury = await pool.query<{ resource_type: string; quantity: string }>(
      `SELECT resource_type, quantity::text FROM kingdom_treasury_balances WHERE kingdom_id = $1 ORDER BY resource_type`,
      [bigKingdom]
    );
    const refunds = await pool.query<{ resource_type: string; quantity: number; balance_before: string; balance_after: string }>(
      `SELECT resource_type, quantity, balance_before::text, balance_after::text FROM kingdom_treasury_expenditures
       WHERE project_id = $1 AND direction = 'refund' ORDER BY resource_type`,
      [projectId]
    );
    const audits = await pool.query(
      "SELECT 1 FROM kingdom_audit_events WHERE entity_id = $1 AND event_type = 'advancement_project_cancelled'",
      [projectId]
    );
    const kingdoms = await pool.query<{ id: string; level: number; lifetime_xp: string }>(
      "SELECT id, level, lifetime_xp::text FROM kingdoms WHERE id = ANY($1::uuid[])",
      [[bigKingdom, smallKingdom]]
    );
    return {
      project: project.rows[0]?.status,
      treasury: Object.fromEntries(treasury.rows.map((row) => [row.resource_type, Number(row.quantity)])),
      refunds: refunds.rows.map((row) =>
        [row.resource_type, row.quantity, Number(row.balance_before), Number(row.balance_after)]),
      audits: audits.rowCount,
      kingdoms: Object.fromEntries(kingdoms.rows.map((row) => [row.id, [row.level, Number(row.lifetime_xp)]]))
    };
  }
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("MIGRATION_RUNNER_TEST_ADMIN_URL must be a PostgreSQL URL");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Kingdom member XP migration test requires a loopback admin database");
  }
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("Kingdom member XP migration test requires a disposable ash_atlas_stability admin database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
