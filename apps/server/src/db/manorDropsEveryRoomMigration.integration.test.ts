import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0877_manor_drops_every_room.sql";
const TABLES = ["world_equipment_drops", "world_item_drops", "world_backpack_drops"] as const;
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Manor drops in every room migration", () => {
  const databaseName = `ash_atlas_stability_manor_every_room_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let pool: pg.Pool;
  let preceding = "";

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (parsed.hostname !== "127.0.0.1" || !parsed.pathname.includes("ash_atlas_stability")) {
      throw new Error("MIGRATION_RUNNER_TEST_ADMIN_URL must target the local ash_atlas_stability lab");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-pre-0877-"));
    const source = path.resolve(process.cwd(), "../../db/migrations");
    for (const name of (await readdir(source)).filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)) {
      await copyFile(path.join(source, name), path.join(preceding, name));
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(databaseUrl, { migrationsDirectory: preceding });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
    if (preceding) await rm(preceding, { recursive: true, force: true });
  }, 60_000);

  const definitions = async () => (await pool.query<{ table_name: string; definition: string }>(
    `SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE contype = 'c' AND conrelid = ANY($1::regclass[])
        AND pg_get_constraintdef(oid) LIKE '%manor_id%space_id%'`, [TABLES as unknown as string[]])).rows;

  it("pins space_id to the two legacy spaces before and to any non-empty room id after, and reruns cleanly", async () => {
    expect((await definitions()).every((row) => row.definition.includes("manor_foyer"))).toBe(true);
    await runMigrations(databaseUrl); // populated upgrade: applies 0877 over the 0876 schema
    const upgraded = await definitions();
    expect(upgraded.map((row) => row.table_name).sort()).toEqual([...TABLES].sort());
    for (const row of upgraded) {
      expect(row.definition).not.toContain("manor_foyer");
      expect(row.definition).toContain("length(space_id) > 0");
    }
    await runMigrations(databaseUrl); // empty second run
    expect(await definitions()).toEqual(upgraded);
  }, 180_000);
});
