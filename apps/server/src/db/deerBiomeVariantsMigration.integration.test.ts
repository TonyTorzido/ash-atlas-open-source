import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEER_FAMILY_ARCHETYPES,
  KITCHEN_RECIPES,
  KITCHEN_RECIPE_IDS,
  kitchenOutputQuantity
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0915_deer_biome_variants.sql";
const NEW_CUTS = ["frost_deer_cut", "jungle_deer_cut", "marsh_deer_cut", "sand_deer_cut"] as const;
const ANIMAL_VARIANT_CUTS = new Set<string>([
  "frost_wolf_cut", "dune_wolf_cut", "jungle_wolf_cut", "bog_wolf_cut",
  "woolly_hog_cut", "warthog_cut", "jungle_hog_cut", "mud_hog_cut", "javelina_cut",
  "snow_bear_cut", "black_bear_cut", "sun_bear_cut",
  "ice_crab_meat", "sand_crab_meat", "mangrove_crab_meat",
  "frost_frog_legs", "poison_frog_legs", "desert_toad_legs",
  "caiman_tail", "crocodile_tail"
]);

describeDatabase("Deer biome variant migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_deer_variants_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const playerId = `deer-variants-${randomUUID()}`;
  const manorId = randomUUID();
  const kitchenId = randomUUID();
  const legacyJobId = randomUUID();
  const universalJobId = randomUUID();
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-deer-variants-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-deer-variants-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name < TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
        await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
      } else if (name === TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
      }
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
      .resolves.toEqual([TARGET_MIGRATION]);

    // Existing Kitchen jobs survive the constraint re-issue untouched.
    await expect(pool!.query<{ job_id: string; recipe_id: string; output_quantity: number }>(
      `SELECT job_id::text,recipe_id,output_quantity FROM kitchen_jobs
       WHERE job_id IN ($1,$2) ORDER BY recipe_id`,
      [legacyJobId, universalJobId]
    )).resolves.toMatchObject({ rows: [
      { job_id: universalJobId, recipe_id: "crab_meat", output_quantity: 2 },
      { job_id: legacyJobId, recipe_id: "deer_meat", output_quantity: 1 }
    ] });

    // The full startup catalog check lives in the latest catalog migration test
    // (animalBiomeVariantsMigration, 0917), which adds later item rows.
    await expect(pool!.query<{ item_id: string; unit_weight_grams: number }>(
      `SELECT item_id,unit_weight_grams FROM item_definitions
       WHERE item_id = ANY($1::text[]) ORDER BY item_id`,
      [["deer_cut", ...NEW_CUTS]]
    )).resolves.toMatchObject({ rows: ["deer_cut", ...NEW_CUTS].sort()
      .map((item_id) => ({ item_id, unit_weight_grams: 250 })) });

    // Every live recipe, including the new cuts at the Deer Cut yield, fits the constraints.
    // The Wolf/Hog/Bear/Crab/Frog/Alligator variant cuts arrive later, in 0918_animal_biome_variants.sql.
    for (const recipeId of KITCHEN_RECIPE_IDS.filter((id) => !ANIMAL_VARIANT_CUTS.has(id))) {
      const recipe = KITCHEN_RECIPES[recipeId];
      for (const quantity of new Set([recipe.minimumQuantity, recipe.maximumQuantity])) {
        await insertJob(randomUUID(), recipeId, quantity, kitchenOutputQuantity(recipeId, quantity));
      }
    }
    for (const cut of NEW_CUTS) {
      expect(kitchenOutputQuantity(cut, 3)).toBe(kitchenOutputQuantity("deer_cut", 3));
      await expect(insertJob(randomUUID(), cut, 1, 4))
        .rejects.toMatchObject({ constraint: "kitchen_jobs_output_quantity_check" });
    }

    // The weekly Deer leaderboard counts every Deer variant.
    const trigger = await pool!.query<{ prosrc: string }>(
      "SELECT prosrc FROM pg_proc WHERE proname = 'capture_weekly_mob_death'"
    );
    for (const archetype of DEER_FAMILY_ARCHETYPES) {
      expect(trigger.rows[0]?.prosrc).toContain(`WHEN '${archetype}' THEN 'deer_killed'`);
    }

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([]);
  }, 120_000);

  async function seedRepresentativeJobs(): Promise<void> {
    await pool!.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'Deer variant fixture','world-test',35,-106,35,-106,
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
    throw new Error("Deer biome variant migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
