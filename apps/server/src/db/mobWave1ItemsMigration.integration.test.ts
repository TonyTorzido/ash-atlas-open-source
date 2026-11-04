import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INVENTORY_CATALOG,
  KITCHEN_RECIPES,
  KITCHEN_RECIPE_IDS,
  kitchenOutputQuantity
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateItemDefinitionCatalog } from "../game/items.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1020_mob_wave_1_items.sql";
/**
 * The mob value pass (1060+) ships after 1020 is live and changes what 1020 created (Kitchen
 * constraints, Mammoth Cut rarity), so the rehearsal applies it after 1020, as production will.
 */
const isLaterDependent = (name: string): boolean => name >= "1060";
/** The wave 1 meat cuts and fish fillets (plus Mammoth Cut). */
const NEW_ITEMS = [
  "jungle_tapir_cut", "jaguar_cut", "mandrill_cut", "capercaillie_meat", "elk_cut",
  "red_squirrel_cut", "badger_cut", "grey_squirrel_cut", "stag_beetle_cut", "great_grey_owl_meat",
  "flying_squirrel_cut", "plains_bison_cut", "prairie_dog_cut", "burrowing_owl_meat",
  "giraffe_cut", "lioness_cut", "spotted_hyena_cut", "sitatunga_cut", "emperor_dragonfly_cut",
  "mountain_ibex_cut", "wild_yak_cut", "alpine_marmot_cut", "wild_scrub_goat_cut",
  "crested_porcupine_cut", "spur_thighed_tortoise_cut", "dromedary_cut", "fennec_fox_cut",
  "sidewinder_cut", "desert_lion_cut", "saiga_cut", "wild_horse_cut", "steppe_marmot_cut",
  "lemming_cut", "snow_goose_meat", "mammoth_cut", "emperor_penguin_meat", "peary_caribou_cut",
  "ice_worm_cut", "sea_otter_cut", "herring_gull_meat", "spiny_lobster_tail",
  "hammerhead_shark_steak", "manta_ray_wing", "humpback_whale_cut", "muskellunge_fillet",
  "mute_swan_meat", "pike_fillet", "snapping_turtle_cut", "beaver_cut", "otter_cut",
  "salmon_fillet"
] as const;

describeDatabase("Mob wave 1 item migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_mob_wave_1_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const playerId = `mob-wave-1-${randomUUID()}`;
  const manorId = randomUUID();
  const kitchenId = randomUUID();
  const legacyJobId = randomUUID();
  const universalJobId = randomUUID();
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  const dependentMigrations: string[] = [];
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-mob-wave-1-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-mob-wave-1-target-"));
    // Production already holds the later-numbered trunk migrations (1021+), so the
    // populated database gets every other migration and this one is applied last.
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (isLaterDependent(name)) dependentMigrations.push(name);
      if (name !== TARGET_MIGRATION && !isLaterDependent(name)) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
      }
      await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedRepresentativeJobs();
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("upgrades a populated database, matches the startup catalog, and is empty on a second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([TARGET_MIGRATION, ...dependentMigrations]);

    // Existing Kitchen jobs survive the constraint re-issue untouched.
    await expect(pool!.query<{ job_id: string; recipe_id: string; output_quantity: number }>(
      `SELECT job_id::text,recipe_id,output_quantity FROM kitchen_jobs
       WHERE job_id IN ($1,$2) ORDER BY recipe_id`,
      [legacyJobId, universalJobId]
    )).resolves.toMatchObject({ rows: [
      { job_id: universalJobId, recipe_id: "crab_meat", output_quantity: 2 },
      { job_id: legacyJobId, recipe_id: "deer_meat", output_quantity: 1 }
    ] });

    // The server refuses to boot on any catalog mismatch; the migrated rows must match exactly.
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();
    const rows = await pool!.query<{ item_id: string; unit_weight_grams: number }>(
      `SELECT item_id,unit_weight_grams FROM item_definitions WHERE item_id = ANY($1::text[])`,
      [[...NEW_ITEMS]]
    );
    expect(rows.rows.map((row) => row.item_id).sort()).toEqual([...NEW_ITEMS].sort());
    for (const row of rows.rows) expect(row.unit_weight_grams, row.item_id).toBe(250);
    for (const itemId of NEW_ITEMS) {
      expect(INVENTORY_CATALOG[itemId]?.inventoryGroup, itemId).toMatch(/^(meat|fish)$/u);
    }

    // Every live recipe, including the new cuts at their own yield, fits the constraints.
    for (const recipeId of KITCHEN_RECIPE_IDS) {
      const recipe = KITCHEN_RECIPES[recipeId];
      for (const quantity of new Set([recipe.minimumQuantity, recipe.maximumQuantity])) {
        await insertJob(randomUUID(), recipeId, quantity, kitchenOutputQuantity(recipeId, quantity));
      }
    }
    // 1062 retired the per-cut yield pin (the server owns yields); the output bound remains.
    for (const itemId of NEW_ITEMS) {
      await expect(insertJob(randomUUID(), itemId, 1, 1001))
        .rejects.toMatchObject({ constraint: "kitchen_jobs_output_quantity_check" });
    }

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([]);
  }, 120_000);

  async function seedRepresentativeJobs(): Promise<void> {
    await pool!.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'Mob wave 1 fixture','world-test',35,-106,35,-106,
         900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId]
    );
    await pool!.query(
      `INSERT INTO player_manors (
         id,owner_player_id,world_region_code,world_lat,world_lon,built_at,geom
       ) VALUES ($1,$2,'world-test',35,-106,clock_timestamp(),ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [manorId, playerId]
    );
    await pool!.query(
      `INSERT INTO player_kitchens (
         kitchen_id,manor_id,owner_player_id,world_id,region_code,lat,lon,geom
       ) VALUES ($1,$2,$3,'test-world','world-test',35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [kitchenId, manorId, playerId]
    );
    await insertJob(legacyJobId, "deer_meat", 10, 1);
    await insertJob(universalJobId, "crab_meat", 1, 2);
  }

  async function insertJob(
    jobId: string,
    recipeId: string,
    requestedInputQuantity: number,
    outputQuantity: number
  ): Promise<void> {
    await pool!.query(
      `INSERT INTO kitchen_jobs (
         job_id,kitchen_id,owner_player_id,recipe_id,requested_input_quantity,
         output_quantity,started_at,completes_at
       ) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp()+interval '5 seconds')`,
      [jobId, kitchenId, playerId, recipeId, requestedInputQuantity, outputQuantity]
    );
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Mob wave 1 item migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
