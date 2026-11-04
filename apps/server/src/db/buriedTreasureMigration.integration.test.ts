import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

const adminUrl = process.env.TREASURE_MIGRATION_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = "1014_buried_treasure.sql";

describeDatabase("Buried treasure migration", () => {
  const databaseName = `ash_atlas_stability_treasure_mig_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let directory = "";
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) throw new Error("Local database required");
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    const source = path.resolve(process.cwd(), "../../db/migrations");
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-treasure-mig-"));
    await mkdir(directory, { recursive: true });
    for (const file of (await readdir(source)).filter((name) => name.endsWith(".sql") && name < MIGRATION)) {
      await copyFile(path.join(source, file), path.join(directory, file));
    }
    await copyFile(path.join(source, MIGRATION), path.join(directory, `.${MIGRATION}.pending`));
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 60_000);

  it("upgrades a populated database, keeps its rows, and a second run is a no-op", async () => {
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
    const accountId = randomUUID();
    await pool!.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool!.query(
      `INSERT INTO players (id, account_id, username, username_normalized, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom)
       VALUES ('kept',$1,'kept','kept','#38bdf8','NM',36,-106,36,-106,900,true,ST_SetSRID(ST_MakePoint(-106,36),4326))`,
      [accountId]
    );
    await copyFile(path.join(directory, `.${MIGRATION}.pending`), path.join(directory, MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: directory })).resolves.toEqual([MIGRATION]);
    expect((await pool!.query("SELECT id FROM players")).rows).toEqual([{ id: "kept" }]);
    expect((await pool!.query("SELECT item_id, market_tradable, max_stack FROM item_definitions WHERE item_id='shovel'")).rows)
      .toEqual([{ item_id: "shovel", market_tradable: false, max_stack: 25 }]);
    await pool!.query(
      `INSERT INTO buried_treasures (treasure_id, tier, geom, expires_at)
       VALUES ($1::uuid, 'gold', ST_SetSRID(ST_MakePoint(-106,36),4326), now() + interval '1 hour')`,
      [randomUUID()]
    );
    await expect(pool!.query(
      `INSERT INTO buried_treasures (treasure_id, tier, geom, expires_at)
       VALUES ($1::uuid, 'diamond', ST_SetSRID(ST_MakePoint(-106,36),4326), now() + interval '1 hour')`,
      [randomUUID()]
    )).rejects.toMatchObject({ code: "23514" });
    await expect(runMigrations(databaseUrl, { migrationsDirectory: directory })).resolves.toEqual([]);
    expect(Number((await pool!.query("SELECT count(*) FROM buried_treasures")).rows[0].count)).toBe(1);
  }, 600_000);
});
