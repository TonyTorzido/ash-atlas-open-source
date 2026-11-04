import { randomUUID } from "node:crypto";

import { resourceVisionRadiusForLeash } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { PlayerService } from "./players.js";
import { GameState } from "./state.js";

const databaseUrl = process.env.ACTIVE_RUNTIME_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("active runtime PostgreSQL persistence", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const playerId = `active-runtime-${randomUUID()}`;
  const unrelatedPlayerId = `active-runtime-unrelated-${randomUUID()}`;
  const flagId = randomUUID();
  const config = loadConfig({ NODE_ENV: "test" });
  const durableVisionRadiusM = resourceVisionRadiusForLeash(1_250);
  const players = new PlayerService(pool, config);

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
         ) VALUES
           ($1,'Runtime Test','GLOBAL',10,20,10,20,1250,false,
            ST_SetSRID(ST_MakePoint(20,10),4326)),
           ($2,'Unrelated Runtime Test','GLOBAL',12,22,12,22,1250,false,
            ST_SetSRID(ST_MakePoint(22,12),4326))`,
      [playerId, unrelatedPlayerId]
    );
    await pool.query(
      `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
       VALUES ($1,$2,'Mesa Camp',10,20,1000,ST_SetSRID(ST_MakePoint(20,10),4326))`,
      [flagId, playerId]
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM flags WHERE id = $1", [flagId]);
    await pool.query("DELETE FROM players WHERE id = ANY($1::text[])", [[playerId, unrelatedPlayerId]]);
    await pool.end();
  });

  it("evicts after persistence and reconstructs the same flag view on reconnect", async () => {
    const state = new GameState(config);
    state.connectPlayer((await players.loadPlayer(playerId))!);
    state.setResourceVision(playerId, {
      flagId,
      flagName: "Mesa Camp",
      center: { lat: 10, lon: 20 },
      movementLeashRadiusM: 1_250,
      paddingM: durableVisionRadiusM - 1_250,
      radiusM: durableVisionRadiusM
    });
    state.markOffline(playerId);
    const persistence = state.capturePlayerPersistence(playerId);

    await players.persistPlayerSnapshot(persistence.snapshot);
    expect(state.acknowledgePlayerPersistence(persistence)).toBe(true);
    expect(state.getPlayer(playerId)).toBeUndefined();

    const reloaded = await players.loadPlayer(playerId);
    expect(reloaded?.resourceVision).toMatchObject({
      flagId,
      flagName: "Mesa Camp",
      center: { lat: 10, lon: 20 },
      radiusM: durableVisionRadiusM
    });
    state.connectPlayer(reloaded!);
    expect(state.getGameplayViewCircle(playerId)).toMatchObject({
      anchorType: "flag",
      anchorId: flagId,
      center: { lat: 10, lon: 20 },
      radiusM: durableVisionRadiusM
    });
    expect(state.playerIdsAtFlag(flagId)).toEqual([playerId]);
  });

  it("persists open-land position with a null durable flag and reloads normally", async () => {
    const state = new GameState(config);
    state.connectPlayer((await players.loadPlayer(playerId))!);
    state.teleportPlayer(playerId, { lat: 11, lon: 21 }, "GLOBAL");
    const syntheticAreaId = randomUUID();
    state.setResourceVision(playerId, {
      flagId: syntheticAreaId,
      flagName: "Open area",
      destinationKind: "area",
      center: { lat: 11, lon: 21 },
      movementLeashRadiusM: 1_250,
      paddingM: 0,
      radiusM: config.FLAG_RESOURCE_VISION_RADIUS_M
    });
    const snapshot = state.snapshotForPlayer(playerId);

    expect(snapshot.currentFlagId).toBeNull();
    await expect(players.persistPlayerSnapshot(snapshot)).resolves.toBeUndefined();
    await expect(pool.query(
      "SELECT lat,lon,current_flag_id FROM players WHERE id=$1",
      [playerId]
    )).resolves.toMatchObject({
      rows: [{ lat: 11, lon: 21, current_flag_id: null }]
    });

    const reloaded = await players.loadPlayer(playerId);
    expect(reloaded).toMatchObject({
      position: { lat: 11, lon: 21 },
      resourceVision: {
        destinationKind: "area",
        center: { lat: 11, lon: 21 },
        movementLeashRadiusM: 1_250,
        paddingM: durableVisionRadiusM - 1_250,
        radiusM: durableVisionRadiusM
      }
    });
    expect(await pool.query("SELECT count(*)::int AS count FROM flags WHERE id=$1", [flagId]))
      .toMatchObject({ rows: [{ count: 1 }] });
  });

  it("sanitizes an invalid flag ID without blocking unrelated player persistence", async () => {
    const malformedState = new GameState(config);
    malformedState.connectPlayer((await players.loadPlayer(playerId))!);
    malformedState.teleportPlayer(playerId, { lat: 11.5, lon: 21.5 }, "GLOBAL");
    const malformedSnapshot = {
      ...malformedState.snapshotForPlayer(playerId),
      currentFlagId: randomUUID()
    };
    const unrelatedState = new GameState(config);
    unrelatedState.connectPlayer((await players.loadPlayer(unrelatedPlayerId))!);
    unrelatedState.teleportPlayer(unrelatedPlayerId, { lat: 13, lon: 23 }, "GLOBAL");

    await expect(Promise.all([
      players.persistPlayerSnapshot(malformedSnapshot),
      players.persistPlayerSnapshot(unrelatedState.snapshotForPlayer(unrelatedPlayerId))
    ])).resolves.toHaveLength(2);
    const rows = await pool.query<{
      id: string;
      lat: number;
      lon: number;
      current_flag_id: string | null;
    }>(
      `SELECT id,lat,lon,current_flag_id
       FROM players
       WHERE id=ANY($1::text[])
       ORDER BY id`,
      [[playerId, unrelatedPlayerId]]
    );
    expect(rows.rows).toEqual([
      { id: playerId, lat: 11.5, lon: 21.5, current_flag_id: null },
      { id: unrelatedPlayerId, lat: 13, lon: 23, current_flag_id: null }
    ].sort((left, right) => left.id.localeCompare(right.id)));
  });
});
