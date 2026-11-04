import { randomUUID } from "node:crypto";

import {
  LOOM_PROCESS_DURATION_MS,
  LOOM_QUEUE_CAPACITY,
  type LoomWorldSnapshot
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "./inventory.js";
import { LoomService } from "./looms.js";
import type { PlayerRecord } from "./state.js";

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Loom shared exterior access PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let nowMs: number;
  let loom: LoomWorldSnapshot;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
    inventory = new InventoryService(pool);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await createPlayer("owner", "Ash");
    await createPlayer("guest", "Bex");
    const manor = await pool.query<{ id: string }>(
      "INSERT INTO player_manors (owner_player_id) VALUES ('owner') RETURNING id"
    );
    await pool.query(
      `UPDATE player_manors
       SET world_region_code='world-test',world_lat=35,world_lon=-106,
           built_at=now(),geom=ST_SetSRID(ST_MakePoint(-106,35),4326)
       WHERE id=$1`,
      [manor.rows[0]!.id]
    );
    const inserted = await pool.query<{ loom_id: string }>(
      `INSERT INTO player_looms (
         manor_id,owner_player_id,world_id,region_code,lat,lon,geom
       ) VALUES (
         $1,'owner','test-world','world-test',35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )
       RETURNING loom_id`,
      [manor.rows[0]!.id]
    );
    loom = {
      loomId: inserted.rows[0]!.loom_id,
      manorId: manor.rows[0]!.id,
      ownerPlayerId: "owner",
      ownerUsername: "Ash",
      regionCode: "world-test",
      lat: 35,
      lon: -106,
      builtAt: new Date().toISOString(),
      placementRevision: 1
    };
    nowMs = Date.UTC(2026, 0, 1);
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("lets a nearby non-owner open and start with their own Flax while scoping visible jobs", async () => {
    await grant("owner", 2);
    await grant("guest", 2);
    const service = loomService();

    const ownerStart = await service.start(owner(), "owner-start", loom.loomId, "flax_fiber", 2);
    expect(ownerStart.state).toMatchObject({ occupiedSlots: 1, jobs: [{ outputQuantity: 1 }] });

    const guestState = await service.state(guest(), loom.loomId);
    expect(guestState).toMatchObject({ occupiedSlots: 1, jobs: [] });

    const guestStart = await service.start(guest(), "guest-start", loom.loomId, "flax_fiber", 2);
    expect(guestStart).toMatchObject({
      replayed: false,
      inventory: { totals: { flax_fiber: 0 } },
      state: { occupiedSlots: 2, jobs: [{ outputQuantity: 1 }] }
    });
  });

  it("enforces one global five-slot queue and schedules jobs after every player's work", async () => {
    await grant("owner", 4);
    await grant("guest", 6);
    const service = loomService();

    await service.start(owner(), "owner-one", loom.loomId, "flax_fiber", 2);
    await service.start(owner(), "owner-two", loom.loomId, "flax_fiber", 2);
    const guestOne = await service.start(guest(), "guest-one", loom.loomId, "flax_fiber", 2);
    await service.start(guest(), "guest-two", loom.loomId, "flax_fiber", 2);
    const guestThree = await service.start(guest(), "guest-three", loom.loomId, "flax_fiber", 2);

    expect(guestThree.state).toMatchObject({
      queueCapacity: LOOM_QUEUE_CAPACITY,
      occupiedSlots: LOOM_QUEUE_CAPACITY,
      jobs: [
        {},
        {},
        {}
      ]
    });
    expect(Date.parse(guestOne.state.jobs[0]!.startedAt) - nowMs)
      .toBe(2 * LOOM_PROCESS_DURATION_MS);
    await expect(service.start(guest(), "over-capacity", loom.loomId, "flax_fiber", 2))
      .rejects.toMatchObject({ code: "LOOM_QUEUE_FULL" });
  });

  it("collects only the actor's ready jobs, keeps other jobs private, and scopes replay", async () => {
    await grant("owner", 2);
    await grant("guest", 4);
    const service = loomService();
    await service.start(owner(), "owner-start", loom.loomId, "flax_fiber", 2);
    await service.start(guest(), "guest-start", loom.loomId, "flax_fiber", 2);
    const guestReplay = await service.start(guest(), "guest-start", loom.loomId, "flax_fiber", 2);
    expect(guestReplay).toMatchObject({
      replayed: true,
      state: { occupiedSlots: 2, jobs: [{ outputQuantity: 1 }] }
    });

    nowMs += 2 * LOOM_PROCESS_DURATION_MS;
    const collected = await service.collect(guest(), "guest-collect", loom.loomId);
    expect(collected).toMatchObject({
      collectedQuantity: 1,
      inventory: { totals: { cloth: 1 } },
      state: { occupiedSlots: 1, jobs: [] }
    });
    await expect(service.collect(guest(), "guest-cannot-take-owner-job", loom.loomId))
      .rejects.toMatchObject({ code: "LOOM_JOB_REQUIRED" });
    await expect(service.state(owner(), loom.loomId)).resolves.toMatchObject({
      occupiedSlots: 1,
      jobs: [{ readyQuantity: 1 }]
    });
  });

  it("replays a nearby non-owner collection without duplicating output or crossing actors", async () => {
    await grant("guest", 2);
    const service = loomService();
    await service.start(guest(), "guest-start", loom.loomId, "flax_fiber", 2);
    nowMs += LOOM_PROCESS_DURATION_MS;

    const first = await service.collect(guest(), "guest-collect-replay", loom.loomId);
    const guestInventoryAfterFirst = await inventory.getInventorySnapshot("guest");
    const replay = await service.collect(guest(), "guest-collect-replay", loom.loomId);
    const guestInventoryAfterReplay = await inventory.getInventorySnapshot("guest");

    expect(replay).toMatchObject({
      replayed: true,
      collectedQuantity: first.collectedQuantity,
      state: first.state,
      inventory: first.inventory
    });
    expect(guestInventoryAfterReplay).toEqual(guestInventoryAfterFirst);
    await expect(service.collect(owner(), "guest-collect-replay", loom.loomId))
      .rejects.toMatchObject({ code: "LOOM_JOB_REQUIRED" });
    expect((await inventory.getInventorySnapshot("owner")).totals.cloth ?? 0).toBe(0);
  });

  it("gives an active rank-5 Artificer faster jobs and the bulk bonus exactly once across replays", async () => {
    await pool.query(
      `INSERT INTO player_specialization_ranks (player_id,specialization_id,rank,points_spent) VALUES ('guest','artificer',5,5)`
    );
    await pool.query(
      `INSERT INTO player_specialization_state (player_id,active_specialization_id) VALUES ('guest','artificer')
       ON CONFLICT (player_id) DO UPDATE SET active_specialization_id='artificer'`
    );
    await grant("guest", 24);
    await grant("owner", 24);
    const service = loomService();
    const first = await service.start(guest(), "artificer-start", loom.loomId, "flax_fiber", 24);
    const replay = await service.start(guest(), "artificer-start", loom.loomId, "flax_fiber", 24);
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true });
    const jobSql = `SELECT output_quantity, bonus_quantity,
        (extract(epoch FROM completes_at - started_at) * 1000)::float8 AS ms
      FROM loom_jobs WHERE owner_player_id=$1`;
    const rows = await pool.query<{ output_quantity: number; bonus_quantity: number; ms: number }>(jobSql, ["guest"]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ output_quantity: 14, bonus_quantity: 2 });
    const plain = await service.start(owner(), "plain-start", loom.loomId, "flax_fiber", 24);
    expect(plain.replayed).toBe(false);
    const plainRow = await pool.query<{ output_quantity: number; bonus_quantity: number; ms: number }>(jobSql, ["owner"]);
    expect(plainRow.rows[0]).toMatchObject({ output_quantity: 12, bonus_quantity: 0 });
    expect(rows.rows[0]!.ms).toBeCloseTo(plainRow.rows[0]!.ms * 0.7, 0);
    nowMs += 40 * LOOM_PROCESS_DURATION_MS;
    const collected = await service.collect(guest(), "artificer-collect", loom.loomId);
    expect(collected.collectedQuantity).toBe(14);
    const again = await service.collect(guest(), "artificer-collect", loom.loomId);
    expect(again).toMatchObject({ replayed: true, collectedQuantity: 14 });
    expect((await inventory.getInventorySnapshot("guest")).totals.cloth).toBe(14);
  });

  it("rejects access outside the station range even for a non-owner", async () => {
    const service = loomService();
    const farGuest = guest(35.01, -106.01);

    await expect(service.state(farGuest, loom.loomId)).rejects.toMatchObject({ code: "LOOM_RANGE_REQUIRED" });
    await expect(service.start(farGuest, "far-start", loom.loomId, "flax_fiber", 2))
      .rejects.toMatchObject({ code: "LOOM_RANGE_REQUIRED" });
    await expect(service.state({ ...guest(), regionCode: "other-region" }, loom.loomId))
      .rejects.toMatchObject({ code: "LOOM_RANGE_REQUIRED" });
    await expect(new LoomService(pool, "other-world", inventory, () => nowMs).state(guest(), loom.loomId))
      .rejects.toMatchObject({ code: "LOOM_RANGE_REQUIRED" });
  });

  function loomService(): LoomService {
    return new LoomService(pool, "test-world", inventory, () => nowMs);
  }

  async function grant(playerId: string, quantity: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `loom-access-test:${playerId}:${randomUUID()}`,
      playerId,
      source: "loom_access_test",
      grants: [{ itemId: "flax_fiber", variant: null, quantity }]
    });
  }

  async function createPlayer(playerId: string, username: string): Promise<void> {
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES (
         $1,$2,'world-test',35,-106,35,-106,
         2000,true,ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [playerId, username]
    );
  }
});

function owner(lat = 35, lon = -106): PlayerRecord {
  return player("owner", "Ash", lat, lon);
}

function guest(lat = 35, lon = -106): PlayerRecord {
  return player("guest", "Bex", lat, lon);
}

function player(playerId: string, username: string, lat: number, lon: number): PlayerRecord {
  return {
    playerId,
    username,
    displayColor: null,
    regionCode: "world-test",
    position: { lat, lon },
    anchor: { lat: 35, lon: -106 },
    moveLeashRadiusM: 2_000,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date()
  };
}
