import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  KITCHEN_RECIPES,
  KITCHEN_RECIPE_IDS,
  kitchenOutputQuantity
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const BIOME_VARIANT_CUT_PATTERN =
  /^(frost_deer|jungle_deer|marsh_deer|sand_deer|frost_wolf|dune_wolf|jungle_wolf|bog_wolf|woolly_hog|warthog|jungle_hog|mud_hog|javelina|snow_bear|black_bear|sun_bear)_cut$|^(ice|sand|mangrove)_crab_meat$|^(frost_frog|poison_frog|desert_toad)_legs$|^(caiman|crocodile)_tail$/u;
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0845_kitchen_freshwater_fish_constraints.sql";

describeDatabase("Freshwater Fish Kitchen constraint migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_kitchen_constraints_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const playerId = `kitchen-constraints-${randomUUID()}`;
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
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-kitchen-constraints-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-kitchen-constraints-target-"));
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
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("preserves populated jobs, accepts every recipe boundary, and rejects invalid alignments", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    await expect(pool!.query<{
      job_id: string;
      recipe_id: string;
      requested_input_quantity: number;
      output_quantity: number;
      collected_quantity: number;
    }>(
      `SELECT job_id::text,recipe_id,requested_input_quantity,output_quantity,collected_quantity
       FROM kitchen_jobs
       WHERE job_id IN ($1,$2)
       ORDER BY recipe_id`,
      [legacyJobId, universalJobId]
    )).resolves.toMatchObject({ rows: [
      {
        job_id: universalJobId,
        recipe_id: "crab_meat",
        requested_input_quantity: 1,
        output_quantity: 2,
        collected_quantity: 0
      },
      {
        job_id: legacyJobId,
        recipe_id: "deer_meat",
        requested_input_quantity: 10,
        output_quantity: 1,
        collected_quantity: 0
      }
    ] });

    const boundaryJobIds: string[] = [];
    // Biome variant cuts arrive later, in 0915_deer_biome_variants.sql and 0918_animal_biome_variants.sql.
    for (const recipeId of KITCHEN_RECIPE_IDS.filter((id) => !BIOME_VARIANT_CUT_PATTERN.test(id))) {
      const recipe = KITCHEN_RECIPES[recipeId];
      for (const quantity of new Set([recipe.minimumQuantity, recipe.maximumQuantity])) {
        const jobId = randomUUID();
        boundaryJobIds.push(jobId);
        await insertJob(jobId, recipeId, quantity, kitchenOutputQuantity(recipeId, quantity));
      }
    }
    await expect(pool!.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM kitchen_jobs WHERE job_id = ANY($1::uuid[])",
      [boundaryJobIds]
    )).resolves.toMatchObject({ rows: [{ count: boundaryJobIds.length }] });

    await expect(insertJob(randomUUID(), "freshwater_fish", 11, 1))
      .rejects.toMatchObject({
        constraint: expect.stringMatching(/^kitchen_jobs_(requested_input_quantity|output_quantity)_check$/u)
      });
    await expect(insertJob(randomUUID(), "freshwater_fish", 10, 2))
      .rejects.toMatchObject({ constraint: "kitchen_jobs_output_quantity_check" });
    await expect(insertJob(randomUUID(), "crab_meat", 1, 1))
      .rejects.toMatchObject({ constraint: "kitchen_jobs_output_quantity_check" });
    await expect(insertJob(randomUUID(), "not_a_kitchen_recipe", 1, 1))
      .rejects.toMatchObject({
        constraint: expect.stringMatching(/^kitchen_jobs_(recipe_id|output_quantity)_check$/u)
      });

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([]);
  }, 120_000);

  async function seedRepresentativeJobs(): Promise<void> {
    await pool!.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'Kitchen constraint fixture','world-test',35,-106,35,-106,
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
    throw new Error("Kitchen constraint migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
