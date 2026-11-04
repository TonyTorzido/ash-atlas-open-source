import { randomUUID } from "node:crypto";

import type { FlagSnapshot } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import {
  PostgresResourceVisionJobStore,
  ResourceVisionJobCapacityError,
  resourceVisionJobIdentity
} from "./resourceVisionJobStore.js";

const databaseUrl = process.env.RESOURCE_JOBS_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("durable resource vision job PostgreSQL integration", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
  const config = loadConfig({ NODE_ENV: "test" });
  const playerId = `resource-jobs-${randomUUID()}`;
  const flags = [snapshot(randomUUID(), playerId, 35), snapshot(randomUUID(), playerId, 35.02)];

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await pool.query(
      `INSERT INTO players (
         id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES ($1,$1,'GLOBAL',35,-106,35,-106,600,true,
                 ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId]
    );
    for (const flag of flags) {
      await pool.query(
        `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
         VALUES ($1,$2,$3,$4,$5,500,ST_SetSRID(ST_MakePoint($5,$4),4326))`,
        [flag.id, playerId, flag.name, flag.lat, flag.lon]
      );
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM resource_vision_jobs WHERE flag_id = ANY($1::uuid[])`, [
      flags.map((flag) => flag.id)
    ]);
    await pool.query(`DELETE FROM flags WHERE id = ANY($1::uuid[])`, [flags.map((flag) => flag.id)]);
    await pool.query(`DELETE FROM players WHERE id = $1`, [playerId]);
    await pool.end();
  });

  it("deduplicates one hundred callers and fences an expired worker generation", async () => {
    const first = new PostgresResourceVisionJobStore(pool, 10);
    const second = new PostgresResourceVisionJobStore(pool, 10);
    const contract = job(flags[0]!);

    const admissions = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        (index % 2 === 0 ? first : second).submit(contract)
      )
    );
    expect(admissions.filter((entry) => entry.admitted)).toHaveLength(1);

    const stale = await first.claim("worker-a", 20);
    expect(stale).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(await second.recoverExpired()).toBe(1);
    const replacement = await second.claim("worker-b", 5_000);
    expect(replacement?.ownerGeneration).toBe((stale?.ownerGeneration ?? 0) + 1);
    expect(await first.complete(stale!)).toBe(false);
    expect(await second.complete(replacement!)).toBe(true);
    expect(await first.status(contract.jobKey)).toBe("completed");
  });

  it("enforces bounded unique admission while allowing capacity after completion", async () => {
    const store = new PostgresResourceVisionJobStore(pool, 1);
    const firstContract = job(flags[0]!, "resource-layout-capacity-a");
    const secondContract = job(flags[1]!, "resource-layout-capacity-b");
    await store.submit(firstContract);
    await expect(store.submit(secondContract)).rejects.toBeInstanceOf(ResourceVisionJobCapacityError);

    const claimed = await store.claim("capacity-worker", 5_000);
    expect(claimed?.jobKey).toBe(firstContract.jobKey);
    await store.complete(claimed!);
    await expect(store.submit(secondContract)).resolves.toMatchObject({ admitted: true });
  });

  it("promotes an existing speculative job when an active flag visit needs it", async () => {
    const store = new PostgresResourceVisionJobStore(pool, 10);
    const speculative = job(
      flags[0]!,
      "resource-layout-priority-promotion",
      "flag-created"
    );
    const activeVisit = job(
      flags[0]!,
      "resource-layout-priority-promotion",
      "flag-visit"
    );
    expect(activeVisit.jobKey).toBe(speculative.jobKey);

    await expect(store.submit(speculative)).resolves.toMatchObject({ admitted: true });
    await expect(store.submit(activeVisit)).resolves.toMatchObject({
      admitted: false,
      status: "pending"
    });

    const claimed = await store.claim("priority-worker", 5_000);
    expect(claimed).toMatchObject({
      jobKey: speculative.jobKey,
      priority: 0,
      payload: { reason: "flag-visit" }
    });
    await store.complete(claimed!);
  });

  it("claims one exact prepared-build job without consuming another queued job", async () => {
    const store = new PostgresResourceVisionJobStore(pool, 10);
    const prepared = job(
      flags[0]!,
      "resource-layout-prepared-claim",
      "flag-build"
    );
    const other = job(
      flags[1]!,
      "resource-layout-other-claim",
      "flag-created"
    );
    await store.submit(other);
    await store.submit(prepared);

    const claimed = await store.claimByKey(
      prepared.jobKey,
      "prepared-build-worker",
      5_000
    );
    expect(claimed).toMatchObject({
      jobKey: prepared.jobKey,
      payload: { reason: "flag-build" }
    });
    expect(await store.status(other.jobKey)).toBe("pending");
    expect(await store.complete(claimed!)).toBe(true);
  });

  function job(
    flag: FlagSnapshot,
    layoutVersion = "resource-layout-v2",
    reason: "flag-build" | "flag-created" | "flag-visit" = "flag-created"
  ) {
    return resourceVisionJobIdentity(
      {
        flag,
        regionCode: "GLOBAL",
        movementLeashRadiusM: 600,
        reason
      },
      650,
      config,
      layoutVersion
    );
  }
});

function snapshot(id: string, ownerId: string, lat: number): FlagSnapshot {
  return {
    controlType: "personal",
    id,
    ownerId,
    name: `Resource job ${id.slice(0, 8)}`,
    lat,
    lon: -106,
    packageId: null,
    elevationM: null,
    terrainClass: null,
    biome: null,
    ecoregion: null,
    claimRadiusM: 500,
    cityId: null,
    createdAt: new Date().toISOString()
  };
}
