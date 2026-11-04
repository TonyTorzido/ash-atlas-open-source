import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { loadConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { FlagService } from "./flags.js";
import { lockFlagControlGeometry } from "./flagControlGeometry.js";

const databaseUrl = process.env.FLAG_PLACEMENT_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("database-backed flag placement invariant", () => {
  const ownerA = `flag-placement-${randomUUID()}`;
  const ownerB = `flag-placement-${randomUUID()}`;
  const createdFlagIds: string[] = [];
  const first = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const second = new pg.Pool({ connectionString: databaseUrl, max: 4 });

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await Promise.all([insertPlayer(first, ownerA), insertPlayer(first, ownerB)]);
  });

  afterAll(async () => {
    await first.query("DELETE FROM flags WHERE id = ANY($1::uuid[])", [createdFlagIds]);
    await first.query("DELETE FROM players WHERE id = ANY($1::text[])", [[ownerA, ownerB]]);
    await Promise.all([first.end(), second.end()]);
  });

  it("allows overlapping edges when the new center is outside the existing claim", async () => {
    const base = await insertFlag(first, ownerA, -45, 120);
    const overlappingEdges = await insertFlag(second, ownerB, -44.9865, 120);
    expect([base, overlappingEdges]).toHaveLength(2);
  });

  it("rejects own and enemy centers inside the same existing claim", async () => {
    const base = await insertFlag(first, ownerA, -30, 120);
    const own = randomUUID();
    const enemy = randomUUID();
    createdFlagIds.push(own, enemy);
    const attempts = await Promise.allSettled([
      insertFlagWithId(first, own, ownerA, -29.997, 120),
      insertFlagWithId(second, enemy, ownerB, -29.996, 120)
    ]);
    expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(true);
    const rows = await first.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM flags WHERE id = ANY($1::uuid[])",
      [[own, enemy]]
    );
    expect(rows.rows[0]?.count).toBe("0");
    expect(base).toBeTypeOf("string");
  });

  it("serializes exact-coordinate writers and leaves no dependent state for the loser", async () => {
    const left = randomUUID();
    const right = randomUUID();
    createdFlagIds.push(left, right);
    const attempts = await Promise.allSettled([
      insertFlagWithId(first, left, ownerA, -15, 120),
      insertFlagWithId(second, right, ownerB, -15, 120)
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const loser = attempts[0]?.status === "rejected" ? left : right;
    const partial = await first.query<{ flags: string; visions: string; jobs: string }>(
      `SELECT
         (SELECT count(*)::text FROM flags WHERE id = $1) AS flags,
         (SELECT count(*)::text FROM flag_resource_visions WHERE flag_id = $1) AS visions,
         (SELECT count(*)::text FROM resource_vision_jobs WHERE flag_id = $1) AS jobs`,
      [loser]
    );
    expect(partial.rows[0]).toEqual({ flags: "0", visions: "0", jobs: "0" });
  });

  it("serializes conflicting writers across the antimeridian", async () => {
    const left = randomUUID();
    const right = randomUUID();
    createdFlagIds.push(left, right);
    const attempts = await Promise.allSettled([
      insertFlagWithId(first, left, ownerA, 10, 179.999),
      insertFlagWithId(second, right, ownerB, 10, -179.999)
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("allows distant personal flag transactions to remain concurrent", async () => {
    const left = await first.connect();
    const right = await second.connect();
    try {
      await left.query("BEGIN");
      await insertFlagWithQueryable(left, randomUUID(), ownerA, 0, -120);

      await right.query("BEGIN");
      await right.query("SET LOCAL statement_timeout = '500ms'");
      await expect(
        insertFlagWithQueryable(right, randomUUID(), ownerB, 0, 120)
      ).resolves.toBeTypeOf("string");
      await right.query("ROLLBACK");
      await left.query("ROLLBACK");
    } finally {
      right.release();
      left.release();
    }
  });

  it("makes rare organization topology mutations exclude personal geometry writes", async () => {
    const organization = await first.connect();
    const personal = await second.connect();
    try {
      await organization.query("BEGIN");
      await lockFlagControlGeometry(organization);
      await personal.query("BEGIN");
      await personal.query("SET LOCAL statement_timeout = '100ms'");
      await expect(
        insertFlagWithQueryable(personal, randomUUID(), ownerB, 20, -60)
      ).rejects.toMatchObject({ code: "57014" });
      await personal.query("ROLLBACK");
      await organization.query("ROLLBACK");
    } finally {
      personal.release();
      organization.release();
    }
  });

  it("uses the geography GiST index for the covering-claim admission query", async () => {
    await insertFlag(first, ownerA, 30, 30);
    const plan = await first.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       WITH query_point AS (
         SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS geog
       )
       SELECT flag.id
       FROM flags flag
       CROSS JOIN query_point
       WHERE ST_DWithin(flag.geom::geography, query_point.geog, 10000.05)
         AND ST_DWithin(
           flag.geom::geography,
           query_point.geog,
           flag.claim_radius_m + 0.05
         )
       LIMIT 1`,
      [30, 30]
    );
    expect(JSON.stringify(plan.rows)).toContain("flags_geography_gix");
  });

  it("resolves indexed covering and nearest candidates under a row lock", async () => {
    const flagId = await insertFlag(first, ownerA, 45, 120);
    const service = new FlagService(
      first,
      {} as WorldLookupClient,
      loadConfig({ NODE_ENV: "test" }),
      {} as AppLogger
    );
    const client = await first.connect();
    try {
      await client.query("BEGIN");
      await expect(service.resolveTerritoryAtPoint(45, 120, client, true)).resolves.toMatchObject({
        claimed: true,
        ownerPlayerId: ownerA,
        nearestFlagId: flagId,
        coveringFlagCount: 1
      });
      await expect(service.resolveTerritoryAtPoint(47, 120, client, true)).resolves.toMatchObject({
        claimed: false,
        nearestFlagId: flagId,
        coveringFlagCount: 0
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  async function insertFlag(pool: pg.Pool, ownerId: string, lat: number, lon: number): Promise<string> {
    const id = randomUUID();
    createdFlagIds.push(id);
    return insertFlagWithId(pool, id, ownerId, lat, lon);
  }
});

async function insertPlayer(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id, username, region_code, lat, lon, anchor_lat, anchor_lon,
       move_leash_radius_m, online, geom
     ) VALUES ($1,$1,'GLOBAL',0,0,0,0,1250,false,
               ST_SetSRID(ST_MakePoint(0,0),4326))`,
    [id]
  );
}

async function insertFlagWithId(
  pool: pg.Pool,
  id: string,
  ownerId: string,
  lat: number,
  lon: number
): Promise<string> {
  await pool.query(
    `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
     VALUES ($1,$2,$5,$3,$4,1000,ST_SetSRID(ST_MakePoint($4,$3),4326))`,
    [id, ownerId, lat, lon, id]
  );
  return id;
}

async function insertFlagWithQueryable(
  queryable: Pick<pg.PoolClient, "query">,
  id: string,
  ownerId: string,
  lat: number,
  lon: number
): Promise<string> {
  await queryable.query(
    `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
     VALUES ($1,$2,$5,$3,$4,1000,ST_SetSRID(ST_MakePoint($4,$3),4326))`,
    [id, ownerId, lat, lon, id]
  );
  return id;
}
