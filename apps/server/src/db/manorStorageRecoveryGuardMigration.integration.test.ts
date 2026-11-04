import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = "0855_manor_storage_recovery_guard.sql";

describeDatabase("Manor storage recovery guard migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const databaseName = `ash_atlas_stability_manor_guard_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let migrationsDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableDatabase(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-manor-storage-guard-")
    );
    await writeFile(
      path.join(migrationsDirectory, "0001_fixture.sql"),
      fixtureSql,
      "utf8"
    );
    await writeFile(
      path.join(migrationsDirectory, MIGRATION),
      await readFile(fileURLToPath(new URL(`../../../../db/migrations/${MIGRATION}`, import.meta.url))),
      "utf8"
    );
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin.end();
    if (migrationsDirectory) {
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("rejects unset writes while allowing transaction-local recovery writes", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([
      "0001_fixture.sql",
      MIGRATION
    ]);

    const equipmentId = randomUUID();
    const backpackId = randomUUID();
    await pool!.query(
      `INSERT INTO equipment_instances (instance_id,location)
       VALUES ($1,'world_drop')`,
      [equipmentId]
    );
    await pool!.query(
      `INSERT INTO player_backpack_instances (instance_id,location)
       VALUES ($1,'world_drop')`,
      [backpackId]
    );

    await expect(pool!.query(
      `INSERT INTO manor_storage_stacks (stack_id,quantity)
       VALUES ($1,1)`,
      [randomUUID()]
    )).rejects.toThrow("Manor Storage is retired");
    await expect(pool!.query(
      `INSERT INTO manor_storage_overflow (stack_id,quantity)
       VALUES ($1,1)`,
      [randomUUID()]
    )).rejects.toThrow("Manor Storage is retired");
    await expect(pool!.query(
      `UPDATE equipment_instances
          SET location='manor_storage'
        WHERE instance_id=$1`,
      [equipmentId]
    )).rejects.toThrow("Manor Storage is retired");
    await expect(pool!.query(
      `UPDATE player_backpack_instances
          SET location='manor_storage'
        WHERE instance_id=$1`,
      [backpackId]
    )).rejects.toThrow("Manor Storage is retired");

    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('ash_atlas.manor_storage_recovery','1',true)"
      );
      await client.query(
        `INSERT INTO manor_storage_stacks (stack_id,quantity)
         VALUES ($1,1)`,
        [randomUUID()]
      );
      await client.query(
        `UPDATE equipment_instances
            SET location='manor_storage'
          WHERE instance_id=$1`,
        [equipmentId]
      );
      await client.query(
        `UPDATE player_backpack_instances
            SET location='manor_storage'
          WHERE instance_id=$1`,
        [backpackId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await expect(pool!.query(
      `SELECT location FROM equipment_instances WHERE instance_id=$1`,
      [equipmentId]
    )).resolves.toMatchObject({ rows: [{ location: "manor_storage" }] });
    await expect(pool!.query(
      `SELECT location FROM player_backpack_instances WHERE instance_id=$1`,
      [backpackId]
    )).resolves.toMatchObject({ rows: [{ location: "manor_storage" }] });
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
  }, 30_000);
});

const fixtureSql = `
CREATE TABLE manor_storage_stacks (
  stack_id uuid PRIMARY KEY,
  quantity bigint NOT NULL
);
CREATE TABLE manor_storage_overflow (
  stack_id uuid PRIMARY KEY,
  quantity bigint NOT NULL
);
CREATE TABLE equipment_instances (
  instance_id uuid PRIMARY KEY,
  location text NOT NULL
);
CREATE TABLE player_backpack_instances (
  instance_id uuid PRIMARY KEY,
  location text NOT NULL
);
CREATE OR REPLACE FUNCTION reject_retired_manor_storage_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER manor_storage_stacks_retired_guard
BEFORE INSERT OR UPDATE OR DELETE ON manor_storage_stacks
FOR EACH ROW EXECUTE FUNCTION reject_retired_manor_storage_write();
CREATE TRIGGER manor_storage_overflow_retired_guard
BEFORE INSERT OR UPDATE OR DELETE ON manor_storage_overflow
FOR EACH ROW EXECUTE FUNCTION reject_retired_manor_storage_write();
CREATE TRIGGER equipment_instances_manor_storage_retired_guard
BEFORE INSERT OR UPDATE OR DELETE ON equipment_instances
FOR EACH ROW EXECUTE FUNCTION reject_retired_manor_storage_write();
CREATE TRIGGER player_backpacks_manor_storage_retired_guard
BEFORE INSERT OR UPDATE OR DELETE ON player_backpack_instances
FOR EACH ROW EXECUTE FUNCTION reject_retired_manor_storage_write();
`;

function assertDisposableDatabase(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error("Manor storage guard test requires local ash_atlas_stability");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
