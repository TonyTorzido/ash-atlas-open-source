import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAP_COMPASS_MAX_DAYS, MAP_MARKER_CAP, type ResourceType } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { validateItemDefinitionCatalog } from "./items.js";
import { InventoryService } from "./inventory.js";
import { MapMarkerError, MapMarkerService } from "./mapMarkers.js";
import { seedTradeSkillRank } from "./skills/tradeSkillTestSeed.js";
import { WorldMapService } from "./worldMap.js";

const databaseUrl = process.env.SETTLEMENT_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const here = { lat: 35.0844, lon: -106.6504 };

describeDatabase("map markers and compass PostgreSQL authority", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let nowMs = Date.parse("2026-10-03T12:00:00Z");
  let service: MapMarkerService;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    inventory = new InventoryService(pool);
    service = new MapMarkerService(pool, inventory, { now: () => nowMs });
    await validateItemDefinitionCatalog(pool);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await createPlayer("a");
    await createPlayer("b");
    await seedTradeSkillRank(pool, "a", "cartography", 1);
    nowMs = Date.parse("2026-10-03T12:00:00Z");
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  async function createPlayer(id: string): Promise<void> {
    await pool.query(
      `INSERT INTO players (
         id, username, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES ($1,$1,'#38bdf8','NM',35.0844,-106.6504,35.0844,-106.6504,
                 900,false,ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326))`,
      [id]
    );
  }

  async function give(playerId: string, itemId: string, quantity: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `test:${playerId}:${itemId}:${randomUUID()}`,
      playerId,
      source: "test_grant",
      grants: [{ itemId: itemId as ResourceType, variant: null, quantity }]
    });
  }

  async function held(playerId: string, itemId: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT COALESCE(sum(quantity),0)::text AS quantity FROM player_inventory WHERE player_id=$1 AND resource_type=$2",
      [playerId, itemId]
    );
    return Number(result.rows[0]!.quantity);
  }

  it("upgrades populated data once and leaves the second migration run empty", async () => {
    const url = new URL(databaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.pathname.startsWith("/ash_atlas_stability")) throw new Error("Requires a local disposable database");
    const name = `ash_atlas_stability_map_markers_${randomUUID().replaceAll("-", "")}`;
    url.pathname = `/${name}`;
    const migration = "1016_map_markers_compass.sql";
    const source = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
    const preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-map-markers-migration-"));
    let historical: pg.Pool | undefined;
    let created = false;
    try {
      for (const file of await readdir(source)) {
        if (file.endsWith(".sql") && file < migration) await copyFile(path.join(source, file), path.join(preceding, file));
      }
      await pool.query(`CREATE DATABASE "${name}"`);
      created = true;
      await runMigrations(url.toString(), { migrationsDirectory: preceding });
      historical = new DisposableTestPool({ connectionString: url.toString(), max: 1 });
      await historical.query(
        `INSERT INTO players (id, username, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
           move_leash_radius_m, online, geom)
         VALUES ('retained','Retained','#38bdf8','NM',35.0844,-106.6504,35.0844,-106.6504,900,false,
                 ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326))`
      );
      await copyFile(path.join(source, migration), path.join(preceding, migration));
      await expect(runMigrations(url.toString(), { migrationsDirectory: preceding })).resolves.toEqual([migration]);
      await expect(runMigrations(url.toString(), { migrationsDirectory: preceding })).resolves.toEqual([]);
      await expect(historical.query("SELECT id FROM players")).resolves.toMatchObject({ rows: [{ id: "retained" }] });
      await expect(historical.query("SELECT item_id FROM item_definitions WHERE item_id IN ('compass','survey_stake_kit') ORDER BY 1"))
        .resolves.toMatchObject({ rows: [{ item_id: "compass" }, { item_id: "survey_stake_kit" }] });
    } finally {
      await historical?.end();
      if (created) await pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await rm(preceding, { recursive: true, force: true });
    }
  }, 120_000);

  it("creates a marker for one kit, replays safely, and sanitizes the name", async () => {
    await give("a", "survey_stake_kit", 2);
    const first = await service.create("a", here, "req-1", "  <b>Camp</b>\u0000   Spot \\ ".padEnd(80, "x"), { kind: "here" });
    expect(first.state.markers).toHaveLength(1);
    const name = first.state.markers[0]!.name;
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).not.toMatch(/[<>\\\u0000]/u);
    expect(name.startsWith("b Camp /b Spot")).toBe(true);
    expect(await held("a", "survey_stake_kit")).toBe(1);

    const replay = await service.create("a", here, "req-1", "Renamed Ignored", { kind: "here" });
    expect(replay.state.markers).toHaveLength(1);
    expect(replay.state.markers[0]!.name).toBe(name);
    expect(await held("a", "survey_stake_kit")).toBe(1);

    await expect(service.create("a", here, "req-2", "   ", { kind: "here" })).rejects.toMatchObject({ code: "MAP_MARKER_NAME_REQUIRED" });
    await expect(service.create("a", here, "req-3", "Far", { kind: "point", lat: 36.5, lon: -106.65 }))
      .rejects.toMatchObject({ code: "MAP_MARKER_TOO_FAR" });
    expect(await held("a", "survey_stake_kit")).toBe(1);
  });

  it("refuses a marker without a kit and enforces the per-player cap", async () => {
    await expect(service.create("a", here, "nokit", "None", { kind: "here" })).rejects.toMatchObject({ code: "SURVEY_STAKE_KIT_REQUIRED" });
    await give("a", "survey_stake_kit", 1);
    for (let index = 0; index < MAP_MARKER_CAP; index += 1) {
      await pool.query(
        "INSERT INTO player_map_markers (player_id, request_id, name, lat, lon) VALUES ('a',$1,$2,35,-106)",
        [`seed-${index}`, `Seed ${index}`]
      );
    }
    await expect(service.create("a", here, "over", "Over", { kind: "here" })).rejects.toMatchObject({ code: "MAP_MARKER_CAP" });
    expect(await held("a", "survey_stake_kit")).toBe(1);
  });

  it("keeps markers private to their owner and owner-only for rename and delete", async () => {
    await give("a", "survey_stake_kit", 1);
    const created = await service.create("a", here, "own", "Mine", { kind: "here" });
    const markerId = created.state.markers[0]!.id;
    const worldMap = new WorldMapService(pool, { WORLD_ID: "main" }, { capitalAnchor: { lat: 0, lon: 0 }, topCityLimit: 0, featuredCacheTtlMs: 0 });

    const own = await worldMap.snapshot("a");
    expect(own.markers).toEqual([expect.objectContaining({ kind: "map_marker", id: markerId, name: "Mine" })]);
    expect(own.destinations).toEqual([]);
    expect((await worldMap.snapshot("b")).markers).toEqual([]);
    expect((await service.list("b")).state.markers).toEqual([]);

    await expect(service.rename("b", markerId, "Stolen")).rejects.toBeInstanceOf(MapMarkerError);
    await expect(service.remove("b", markerId)).rejects.toMatchObject({ code: "MAP_MARKER_NOT_FOUND" });
    await expect(service.rename("a", markerId, "Renamed")).resolves.toMatchObject({ state: { markers: [{ name: "Renamed" }] } });
    await expect(service.remove("a", markerId)).resolves.toMatchObject({ state: { markers: [] } });
  });

  it("refuses the kit and compass crafts without Cartography rank 1", async () => {
    await give("b", "elder_acorn", 1);
    await give("b", "flax_fiber", 5);
    await give("b", "cloth", 2);
    await expect(service.craft("b", "deny-kit", "survey_stake_kit")).rejects.toMatchObject({
      code: "MAP_SKILL_REQUIRED",
      message: "Needs Cartography rank 1 to craft a Survey Stake Kit."
    });
    await expect(service.craft("b", "deny-compass", "compass")).rejects.toMatchObject({ code: "MAP_SKILL_REQUIRED" });
    expect(await held("b", "elder_acorn")).toBe(1);
  });

  it("crafts the kit and a single compass, and gates waypoints on holding one", async () => {
    await expect(service.craft("a", "c0", "survey_stake_kit")).rejects.toMatchObject({ code: "MAP_CRAFT_MATERIALS_REQUIRED" });
    await give("a", "elder_acorn", 1);
    await give("a", "flax_fiber", 5);
    await give("a", "cloth", 2);
    await service.craft("a", "c1", "survey_stake_kit");
    await service.craft("a", "c1", "survey_stake_kit").catch(() => undefined);
    expect(await held("a", "survey_stake_kit")).toBe(1);

    await give("a", "survey_stake_kit", 1);
    const created = await service.create("a", here, "wp", "Home", { kind: "here" });
    const markerId = created.state.markers[0]!.id;
    await expect(service.setWaypoint("a", "w0", { kind: "marker", markerId })).rejects.toMatchObject({ code: "MAP_COMPASS_REQUIRED" });

    await give("a", "crude_oil", 34);
    await give("a", "wood", 13);
    await give("a", "slag", 7);
    await service.craft("a", "compass-1", "compass");
    expect(await held("a", "compass")).toBe(1);
    await give("a", "crude_oil", 34);
    await give("a", "wood", 13);
    await give("a", "slag", 7);
    await expect(service.craft("a", "compass-2", "compass")).rejects.toMatchObject({ code: "MAP_COMPASS_ALREADY_CARRIED" });
    expect(await held("a", "crude_oil")).toBe(34);

    const set = await service.setWaypoint("a", "w1", { kind: "marker", markerId });
    expect(set.state.waypoint).toMatchObject({ markerId, label: "Home" });
    expect(set.state.compass).toMatchObject({ held: true, daysUsed: 1 });
  });

  it("wears the compass once per day and breaks it after 30 days of use", async () => {
    await give("a", "crude_oil", 34);
    await give("a", "wood", 13);
    await give("a", "slag", 7);
    await service.craft("a", "compass", "compass");

    const first = await service.openCompass("a", "o1");
    expect(first.state.compass.daysUsed).toBe(1);
    expect((await service.openCompass("a", "o2")).state.compass.daysUsed).toBe(1);

    for (let day = 2; day < MAP_COMPASS_MAX_DAYS; day += 1) {
      nowMs += 24 * 60 * 60 * 1000;
      expect((await service.openCompass("a", `day-${day}`)).state.compass.daysUsed).toBe(day);
    }
    nowMs += 24 * 60 * 60 * 1000;
    const broken = await service.openCompass("a", "day-last");
    expect(broken.state.compass.held).toBe(false);
    expect(broken.notice).toMatch(/wore out/u);
    expect(await held("a", "compass")).toBe(0);
    await expect(service.openCompass("a", "after")).rejects.toMatchObject({ code: "MAP_COMPASS_REQUIRED" });
  }, 60_000);

  async function makeVoyager(playerId: string, rank: number, active = true): Promise<void> {
    await pool.query(
      `INSERT INTO player_specialization_ranks (player_id, specialization_id, rank, points_spent)
       VALUES ($1, 'voyager', $2, 0)
       ON CONFLICT (player_id, specialization_id) DO UPDATE SET rank = EXCLUDED.rank`,
      [playerId, rank]
    );
    await pool.query(
      `INSERT INTO player_specialization_state (player_id, active_specialization_id) VALUES ($1, $2)
       ON CONFLICT (player_id) DO UPDATE SET active_specialization_id = EXCLUDED.active_specialization_id`,
      [playerId, active ? "voyager" : null]
    );
  }

  it("records a location for refined oil once per request, by rank, with a five-slot cap", async () => {
    await expect(service.recordLocation("a", here, "r0", "Nope")).rejects.toMatchObject({ code: "VOYAGER_REQUIRED" });
    await makeVoyager("a", 1, false);
    await give("a", "refined_oil", 40);
    await expect(service.recordLocation("a", here, "r0", "Inactive")).rejects.toMatchObject({ code: "VOYAGER_REQUIRED" });
    expect((await service.list("a")).state.voyager).toBeUndefined();

    await makeVoyager("a", 1);
    const first = await service.recordLocation("a", here, "r1", "Camp");
    expect(first.state.voyager).toMatchObject({ rank: 1, recordCost: 9, recordCap: 5, locations: [{ name: "Camp" }] });
    expect(await held("a", "refined_oil")).toBe(31);
    const replay = await service.recordLocation("a", here, "r1", "Camp again");
    expect(replay.state.voyager!.locations).toHaveLength(1);
    expect(await held("a", "refined_oil")).toBe(31);

    await makeVoyager("a", 3);
    await service.recordLocation("a", here, "r2", "Two");
    expect(await held("a", "refined_oil")).toBe(25);
    await makeVoyager("a", 5);
    await service.recordLocation("a", here, "r3", "Three");
    expect(await held("a", "refined_oil")).toBe(22);
    await service.recordLocation("a", here, "r4", "Four");
    await service.recordLocation("a", here, "r5", "Five");
    expect(await held("a", "refined_oil")).toBe(16);
    await expect(service.recordLocation("a", here, "r6", "Six")).rejects.toMatchObject({ code: "VOYAGER_LOCATION_CAP" });
    expect(await held("a", "refined_oil")).toBe(16);

    const drain = await pool.connect();
    try {
      await drain.query("BEGIN");
      await inventory.debitItemsForOperationInTransaction(drain, {
        operationKey: `test:drain:${randomUUID()}`,
        playerId: "a",
        source: "test_debit",
        sourceEntityType: "player",
        sourceEntityId: "a",
        metadata: {},
        debits: [{ itemId: "refined_oil" as ResourceType, variant: null, quantity: 14 }]
      });
      await drain.query("COMMIT");
    } finally {
      drain.release();
    }
    await service.deleteRecordedLocation("a", first.state.voyager!.locations[0]!.id);
    await expect(service.recordLocation("a", here, "r7", "Poor")).rejects.toMatchObject({ code: "VOYAGER_OIL_REQUIRED" });
    expect(await held("a", "refined_oil")).toBe(2);
  });

  it("serves the same marker state after a reconnect, with the Voyager block only for a Voyager", async () => {
    await makeVoyager("a", 3);
    await give("a", "refined_oil", 10);
    await service.recordLocation("a", here, "rc1", "Camp");
    const before = (await service.list("a")).state;
    const reconnected = new MapMarkerService(pool, new InventoryService(pool), { now: () => nowMs });
    const after = (await reconnected.list("a")).state;
    expect(after).toEqual(before);
    expect(after.voyager).toMatchObject({ rank: 3, recordCost: 6, locations: [{ name: "Camp" }] });
    const plain = (await reconnected.list("b")).state;
    expect(Object.keys(plain)).not.toContain("voyager");
  });

  it("keeps recorded locations private and usable only by an active Voyager", async () => {
    await makeVoyager("a", 1);
    await give("a", "refined_oil", 10);
    const recorded = await service.recordLocation("a", { lat: 36.1, lon: -105.9 }, "p1", "Far camp");
    const locationId = recorded.state.voyager!.locations[0]!.id;
    await expect(service.recordedTravelTarget("a", locationId)).resolves.toMatchObject({ lat: 36.1, lon: -105.9 });
    await expect(service.recordedTravelTarget("b", locationId)).rejects.toMatchObject({ code: "VOYAGER_REQUIRED" });
    await makeVoyager("b", 1);
    await expect(service.recordedTravelTarget("b", locationId)).rejects.toMatchObject({ code: "MAP_MARKER_NOT_FOUND" });
    await expect(service.deleteRecordedLocation("b", locationId)).rejects.toMatchObject({ code: "MAP_MARKER_NOT_FOUND" });

    await give("a", "crude_oil", 34);
    await give("a", "wood", 13);
    await give("a", "slag", 7);
    await service.craft("a", "compass-v", "compass");
    const waypoint = await service.setWaypoint("a", "wv", { kind: "recorded", locationId });
    expect(waypoint.state.waypoint).toMatchObject({ label: "Far camp", lat: 36.1, lon: -105.9 });
    await makeVoyager("a", 1, false);
    await expect(service.recordedTravelTarget("a", locationId)).rejects.toMatchObject({ code: "VOYAGER_REQUIRED" });
    await expect(service.setWaypoint("a", "wv2", { kind: "recorded", locationId })).rejects.toMatchObject({ code: "VOYAGER_REQUIRED" });
  });

  it("upgrades populated data through the recorded-location migration and leaves the second run empty", async () => {
    const url = new URL(databaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.pathname.startsWith("/ash_atlas_stability")) throw new Error("Requires a local disposable database");
    const name = `ash_atlas_stability_voyager_${randomUUID().replaceAll("-", "")}`;
    url.pathname = `/${name}`;
    const migration = "1107_voyager_recorded_locations.sql";
    const source = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
    const preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-voyager-migration-"));
    let historical: pg.Pool | undefined;
    let created = false;
    try {
      for (const file of await readdir(source)) {
        if (file.endsWith(".sql") && file < migration) await copyFile(path.join(source, file), path.join(preceding, file));
      }
      await pool.query(`CREATE DATABASE "${name}"`);
      created = true;
      await runMigrations(url.toString(), { migrationsDirectory: preceding });
      historical = new DisposableTestPool({ connectionString: url.toString(), max: 1 });
      await historical.query(
        `INSERT INTO players (id, username, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
           move_leash_radius_m, online, geom)
         VALUES ('retained','Retained','#38bdf8','NM',35.0844,-106.6504,35.0844,-106.6504,900,false,
                 ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326))`
      );
      await copyFile(path.join(source, migration), path.join(preceding, migration));
      await expect(runMigrations(url.toString(), { migrationsDirectory: preceding })).resolves.toEqual([migration]);
      await expect(runMigrations(url.toString(), { migrationsDirectory: preceding })).resolves.toEqual([]);
      await expect(historical.query("SELECT id FROM players")).resolves.toMatchObject({ rows: [{ id: "retained" }] });
      await expect(historical.query("SELECT count(*)::int AS n FROM player_recorded_locations")).resolves.toMatchObject({ rows: [{ n: 0 }] });
    } finally {
      await historical?.end();
      if (created) await pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await rm(preceding, { recursive: true, force: true });
    }
  }, 120_000);
});
