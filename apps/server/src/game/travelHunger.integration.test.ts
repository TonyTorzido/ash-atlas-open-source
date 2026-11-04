import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import type { AppConfig } from "../config.js";
import { PlayerService, type TravelHungerPersistenceInput } from "./players.js";

const databaseUrl =
  process.env.TRAVEL_HUNGER_TEST_DATABASE_URL ?? process.env.MANOR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("PlayerService travel Hunger integration", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const suffix = randomUUID().slice(0, 8);
  const playerId = `travel-hunger-${suffix}`;
  const service = new PlayerService(pool, {} as AppConfig);
  const travel: TravelHungerPersistenceInput = {
    requestId: "travel-request-1",
    destinationIdentity: JSON.stringify({ kind: "world", id: "destination-a" }),
    distanceM: 1_250_000,
    maxRangeM: 5_000_000
  };

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await pool.query(
      `INSERT INTO players (
         id, username, personal_flag_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, hunger,
         hunger_base_capacity, geom
       ) VALUES ($1,'Travel Hunger Test','blue','GLOBAL',40,-105,40,-105,100,true,2000,2000,
                 ST_SetSRID(ST_MakePoint(-105,40),4326))`,
      [playerId]
    );
  });

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM travel_hunger_consumption_operations WHERE player_id = $1`,
      [playerId]
    );
    await pool.query(
      `UPDATE players SET lat=40, lon=-105, anchor_lat=40, anchor_lon=-105,
                          hunger=2000, hunger_base_capacity=2000,
                          geom=ST_SetSRID(ST_MakePoint(-105,40),4326)
       WHERE id=$1`,
      [playerId]
    );
  }, 60_000);

  afterAll(async () => {
    await pool.query(
      `DELETE FROM travel_hunger_consumption_operations WHERE player_id = $1`,
      [playerId]
    );
    await pool.query(`DELETE FROM players WHERE id = $1`, [playerId]);
    await pool.end();
  });

  it("debits exact cost with relocation persistence and replays once", async () => {
    const first = await service.persistTravelSnapshot(
      snapshot({ lat: 41, lon: -104, anchorLat: 41, anchorLon: -104 }),
      travel
    );
    expect(first).toMatchObject({
      replayed: false,
      cost: 25,
      hungerBefore: 2000,
      hungerAfter: 1975
    });
    await expect(pool.query<{ hunger: number; lat: number; lon: number }>(
      `SELECT hunger, lat, lon FROM players WHERE id=$1`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ hunger: 1975, lat: 41, lon: -104 }] });

    const replay = await service.persistTravelSnapshot(
      snapshot({ lat: 41, lon: -104, anchorLat: 41, anchorLon: -104 }),
      travel
    );
    expect(replay).toMatchObject({ replayed: true, cost: 25, hungerAfter: 1975 });
    await expect(service.persistTravelSnapshot(
      snapshot({ lat: 42, lon: -103, anchorLat: 42, anchorLon: -103 }),
      { ...travel, destinationIdentity: JSON.stringify({ kind: "world", id: "destination-b" }) }
    )).rejects.toMatchObject({
      code: "TRAVEL_HUNGER_REPLAY_CONFLICT",
      message: "This travel request was already used for another journey."
    });
    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM travel_hunger_consumption_operations WHERE player_id=$1`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("rejects insufficient Hunger without creating a debit or movement", async () => {
    await pool.query(`UPDATE players SET hunger=0 WHERE id=$1`, [playerId]);
    await expect(service.persistTravelSnapshot(
      snapshot({ lat: 41, lon: -104, anchorLat: 41, anchorLon: -104 }),
      travel
    )).rejects.toMatchObject({
      code: "INSUFFICIENT_HUNGER",
      requiredHunger: 25,
      currentHunger: 0,
      message: "You need 25 Hunger to make that journey."
    });
    await expect(pool.query<{ hunger: number; lat: number }>(
      `SELECT hunger, lat FROM players WHERE id=$1`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ hunger: 0, lat: 40 }] });
  });

  it("rolls back movement and the debit when the commit hook fails", async () => {
    await expect(service.persistTravelSnapshot(
      snapshot({ lat: 41, lon: -104, anchorLat: 41, anchorLon: -104 }),
      { ...travel, requestId: "rollback" },
      undefined,
      {},
      async () => {
        throw new Error("publish failed");
      }
    )).rejects.toThrow("publish failed");
    await expect(pool.query<{ hunger: number; lat: number; lon: number; count: string }>(
      `SELECT p.hunger, p.lat, p.lon, count(o.operation_key)::text AS count
       FROM players p
       LEFT JOIN travel_hunger_consumption_operations o ON o.player_id=p.id
       WHERE p.id=$1 GROUP BY p.hunger, p.lat, p.lon`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ hunger: 2000, lat: 40, lon: -105, count: "0" }] });
  });

  it("serializes concurrent requests so one debit cannot overspend", async () => {
    await pool.query(`UPDATE players SET hunger=25 WHERE id=$1`, [playerId]);
    const attempts = await Promise.allSettled([
      service.persistTravelSnapshot(
        snapshot({ lat: 41, lon: -104, anchorLat: 41, anchorLon: -104 }),
        { ...travel, requestId: "concurrent-a" }
      ),
      service.persistTravelSnapshot(
        snapshot({ lat: 42, lon: -103, anchorLat: 42, anchorLon: -103 }),
        { ...travel, requestId: "concurrent-b" }
      )
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    await expect(pool.query<{ hunger: number; count: string }>(
      `SELECT p.hunger, count(o.operation_key)::text AS count
       FROM players p
       LEFT JOIN travel_hunger_consumption_operations o ON o.player_id=p.id
       WHERE p.id=$1 GROUP BY p.hunger`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ hunger: 0, count: "1" }] });
  });

  it("preserves a future Hunger value above base capacity while debiting", async () => {
    await pool.query(`UPDATE players SET hunger=2500 WHERE id=$1`, [playerId]);
    const result = await service.persistTravelSnapshot(
      snapshot({ lat: 41, lon: -104, anchorLat: 41, anchorLon: -104, hunger: 2500 }),
      { ...travel, requestId: "over-cap" }
    );
    expect(result.hungerAfter).toBe(2475);
    await expect(pool.query<{ hunger: number }>(
      `SELECT hunger FROM players WHERE id=$1`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ hunger: 2475 }] });
  });

  function snapshot(input: {
    lat: number;
    lon: number;
    anchorLat: number;
    anchorLon: number;
    hunger?: number;
  }) {
    return {
      playerId,
      username: "Travel Hunger Test",
      displayColor: null,
      personalFlagColor: "blue" as const,
      regionCode: "GLOBAL",
      zoneId: "world:GLOBAL",
      lat: input.lat,
      lon: input.lon,
      anchorLat: input.anchorLat,
      anchorLon: input.anchorLon,
      moveLeashRadiusM: 100,
      movementRevision: 1,
      targetLat: null,
      targetLon: null,
      moving: false,
      currentFlagId: null,
      online: true,
      updatedAt: new Date().toISOString(),
      hunger: { current: input.hunger ?? 2000, baseCapacity: 2000 }
    };
  }
});
