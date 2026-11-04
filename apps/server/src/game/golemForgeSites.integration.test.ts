import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { DUNGEON_CATALOG, type DungeonCatalog, type LatLon, type ResourceType } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { CisternWarrensRuntime } from "./dungeon.js";
import { dungeonEntryCostAuthorities } from "./dungeonEntryCost.js";
import {
  GOLEM_FORGE_COLLAPSE_DELAY_MS,
  GOLEM_FORGE_COLLAPSED_DISPLAY_MS,
  GolemForgeSiteService,
  golemForgeEntranceId,
  golemForgeSlotPosition,
  parseGolemForgeEntranceId
} from "./golemForgeSites.js";
import { InventoryService } from "./inventory.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const REGION = "x1k:2b";
/** Slots 1, 2, 4 and 5 of the test region are land; everything else is sea. */
const LAND_SLOTS = [1, 2, 4, 5];
const PAYER = "gfs-payer";
const FREE = "gfs-free";
const OLD = "gfs-old";

/**
 * Golem Forge sites against a real database: deterministic slot cycling (independent of process state),
 * collapse 24 h after the Forgemaster, an hour of collapsed entrance, then the next land slot; collapse
 * refunds unused admissions exactly once, even when repeated, raced, or rerun by a restarted server.
 */
describeDatabase("golem forge sites and collapse", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_gf_sites_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const land = new Set(LAND_SLOTS.map((slot) => JSON.stringify(golemForgeSlotPosition(REGION, slot))));
  const isLand = (position: LatLon) => land.has(JSON.stringify(position));
  let clock = Date.UTC(2026, 9, 5, 12);
  let pool: DisposableTestPool | undefined;
  let inventory: InventoryService;
  const services = () => new GolemForgeSiteService({ pool: pool!, worldLookup: undefined, isLand, now: () => clock });
  const runtimeWith = (sites: GolemForgeSiteService) => {
    const combat = new Proxy({}, { get: () => vi.fn(() => null) });
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    const forge = catalog.dungeons.find((dungeon) => dungeon.id === "golem_forge")!;
    forge.access = { entryCost: forge.access!.entryCost!, lockoutDays: 6 };
    return new CisternWarrensRuntime(pool as unknown as pg.Pool, combat as never, undefined, undefined, {
      partyIdForPlayer: () => "party-s", golemForgeSites: sites, ...dungeonEntryCostAuthorities(inventory)
    }, catalog, undefined, undefined, undefined, { now: () => clock });
  };

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
        !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
      throw new Error("The Golem Forge sites test requires a local disposable stability database");
    }
    parsed.pathname = `/${databaseName}`;
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(parsed.toString(), { migrationsDirectory: sourceMigrations });
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 8 });
    inventory = new InventoryService(pool as unknown as pg.Pool);
    for (const playerId of [PAYER, FREE, OLD]) {
      const accountId = randomUUID();
      await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
      await pool.query(
        `INSERT INTO players (id,account_id,username,username_normalized,region_code,lat,lon,
           anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
         VALUES ($1,$2,$1,$1,'GLOBAL',35,-106,35,-106,100,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
        [playerId, accountId]
      );
      await inventory.grantItemsForOperation({
        operationKey: `gfs-seed:${playerId}`, playerId, source: "dungeon_resource_harvest",
        sourceEntityType: "dungeon_resource", sourceEntityId: "seed", metadata: {},
        grants: [{ itemId: "refined_oil" as ResourceType, variant: null, quantity: 100 },
          { itemId: "wood" as ResourceType, variant: null, quantity: 10 }]
      });
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }, 30_000);

  const holdings = async (playerId: string) => Object.fromEntries((await pool!.query<{ resource_type: string; quantity: string }>(
    "SELECT resource_type,quantity::text FROM player_inventory WHERE player_id=$1 AND resource_type IN ('refined_oil','wood')",
    [playerId])).rows.map((row) => [row.resource_type, Number(row.quantity)]));

  it("opens the first land slot deterministically and cycles to the next land slot after each collapse", async () => {
    expect(parseGolemForgeEntranceId(golemForgeEntranceId(REGION, 4))).toEqual({ regionKey: REGION, slot: 4 });
    const first = await services().site(REGION);
    // A second, fresh service (a restarted server) sees the same site with nothing stored.
    await expect(services().site(REGION)).resolves.toEqual(first);
    expect(first).toMatchObject({ slot: 1, entranceId: golemForgeEntranceId(REGION, 1), state: "open", collapseAt: null });
    await expect(pool!.query("SELECT count(*)::int AS count FROM golem_forge_sites")).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(services().sitesNear(first!.position, 1_000)).resolves.toEqual([first]);

    const diedAt = clock;
    await services().recordForgemasterDeath(first!.entranceId, diedAt);
    await services().recordForgemasterDeath(first!.entranceId, diedAt + 60_000);
    await expect(services().site(REGION)).resolves.toMatchObject({ slot: 1, state: "open", collapseAt: diedAt + GOLEM_FORGE_COLLAPSE_DELAY_MS });
    clock = diedAt + GOLEM_FORGE_COLLAPSE_DELAY_MS;
    await expect(services().site(REGION)).resolves.toMatchObject({ slot: 1, state: "collapsed" });
    clock += GOLEM_FORGE_COLLAPSED_DISPLAY_MS;
    const results = await Promise.all([services().site(REGION), services().site(REGION)]);
    expect(results.map((site) => site?.slot)).toEqual([2, 2]);
    await expect(pool!.query("SELECT cycle,collapse_at FROM golem_forge_sites WHERE region_key=$1", [REGION]))
      .resolves.toMatchObject({ rows: [{ cycle: 2, collapse_at: null }] });
    // A late death record for the old site changes nothing.
    await services().recordForgemasterDeath(first!.entranceId, clock);
    await expect(services().site(REGION)).resolves.toMatchObject({ slot: 2, state: "open", collapseAt: null });
    await services().recordForgemasterDeath(golemForgeEntranceId(REGION, 2), clock);
    clock += GOLEM_FORGE_COLLAPSE_DELAY_MS + GOLEM_FORGE_COLLAPSED_DISPLAY_MS;
    await expect(services().site(REGION)).resolves.toMatchObject({ slot: 4, state: "open" });
  }, 60_000);

  it("refunds unused admissions exactly once on collapse, across repeats, races and a restart, then refuses entry", async () => {
    const site = (await services().site(REGION))!;
    const runtime = runtimeWith(services());
    await runtime.startTorchRun({ entranceId: site.entranceId, members: [
      { playerId: PAYER, name: "Payer", torches: 2 }, { playerId: FREE, name: "Free", torches: 0 }
    ], expectedBossesAlive: 3 });
    await expect(holdings(PAYER)).resolves.toEqual({ refined_oil: 56, wood: 8 });
    await services().recordForgemasterDeath(site.entranceId, clock);
    clock += GOLEM_FORGE_COLLAPSE_DELAY_MS;
    const collapsed = await services().collapsedSites();
    expect(collapsed.map((entry) => entry.entranceId)).toEqual([site.entranceId]);
    await Promise.all([runtime.collapseGolemForge(collapsed[0]!), runtime.collapseGolemForge(collapsed[0]!)]);
    await runtime.collapseGolemForge(collapsed[0]!);
    // A restarted server (new runtime and service, same database) collapses it again: nothing more is paid.
    await runtimeWith(services()).collapseGolemForge((await services().collapsedSites())[0]!);
    await expect(holdings(PAYER)).resolves.toEqual({ refined_oil: 100, wood: 10 });
    await expect(holdings(FREE)).resolves.toEqual({ refined_oil: 100, wood: 10 });
    await expect(pool!.query(
      "SELECT count(*)::int AS count FROM inventory_operations WHERE source='dungeon_entry_refund' AND player_id=$1", [PAYER]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool!.query("SELECT count(*)::int AS count FROM dungeon_run_admissions WHERE refunded_at IS NULL"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(runtime.authorizeEntry(PAYER, site.entranceId)).rejects.toMatchObject({ code: "DUNGEON_COLLAPSED" });
    await expect(runtime.startTorchRun({ entranceId: site.entranceId, members: [{ playerId: PAYER, name: "Payer", torches: 1 }] }))
      .rejects.toMatchObject({ code: "DUNGEON_COLLAPSED" });
    // After the collapsed hour the region moves on; the old entrance is gone.
    clock += GOLEM_FORGE_COLLAPSED_DISPLAY_MS;
    await runtime.collapseGolemForge(collapsed[0]!);
    await expect(services().site(REGION)).resolves.toMatchObject({ slot: 5, state: "open" });
    await expect(runtime.authorizeEntryGates(PAYER, site.entranceId)).rejects.toMatchObject({ code: "DUNGEON_NOT_FOUND" });
  }, 60_000);

  it("retired 40,000 km² rows never become sites, still collapse once, then go inert", async () => {
    const legacyDone = "1k:2b";
    const legacyDying = "1k:2c";
    await pool!.query(
      `INSERT INTO golem_forge_sites (region_key,cycle,collapse_at) VALUES ($1,3,$2),($3,0,$4),($5,0,NULL)`,
      [legacyDone, new Date(clock - GOLEM_FORGE_COLLAPSED_DISPLAY_MS - 1), legacyDying, new Date(clock + 60_000), "1k:2d"]
    );
    const runtime = runtimeWith(services());
    for (const regionKey of [legacyDone, legacyDying, "1k:2d"]) await expect(services().site(regionKey)).resolves.toBeNull();
    await expect(runtime.authorizeEntryGates(PAYER, golemForgeEntranceId("1k:2d", 0))).rejects.toMatchObject({ code: "DUNGEON_NOT_FOUND" });
    // The done row went inert on that read; the dying one is still due to collapse (refund, eject) at its time.
    const rows = await pool!.query<{ region_key: string; collapse_at: Date | null }>(
      "SELECT region_key,collapse_at FROM golem_forge_sites WHERE region_key = ANY($1::text[]) ORDER BY region_key", [[legacyDone, legacyDying]]);
    expect(rows.rows.map((row) => [row.region_key, row.collapse_at !== null])).toEqual([[legacyDone, false], [legacyDying, true]]);
    clock += 60_000;
    const due = (await services().collapsedSites()).find((entry) => entry.regionKey === legacyDying)!;
    expect(due.position).toEqual(golemForgeSlotPosition(legacyDying, 0));
    expect(due.position).not.toEqual({ lat: 0, lon: 0 });
    await runtime.collapseGolemForge(due);
    clock += GOLEM_FORGE_COLLAPSED_DISPLAY_MS;
    await runtime.collapseGolemForge(due);
    expect((await services().collapsedSites()).some((entry) => entry.regionKey === legacyDying)).toBe(false);
    // Current-family regions are untouched by the retired rows.
    await expect(services().site(REGION)).resolves.toMatchObject({ state: "open" });
  }, 60_000);

  it("retires a never-collapsed retired-family Forge: refunds unused admissions once (repeat, restart) and records the move-on", async () => {
    const legacyId = "golem_forge_1k_2e_0";
    const site = (await services().site(REGION))!;
    const runtime = runtimeWith(services());
    await runtime.startTorchRun({ entranceId: site.entranceId, members: [{ playerId: OLD, name: "Old", torches: 2 }],
      expectedBossesAlive: 3 });
    // Stand-in for an admission paid at an old-family Forge before the ladder release.
    // (The admission references its run: both move to the old instance id in one statement.)
    await pool!.query(
      `WITH moved AS (UPDATE dungeon_run_admissions SET instance_id=$2 WHERE player_id=$3 RETURNING run_id)
       UPDATE dungeon_instance_runs SET instance_id=$2 WHERE instance_id=$1 AND run_id IN (SELECT run_id FROM moved)`,
      [`dungeon:${site.entranceId}`, `dungeon:${legacyId}`, OLD]
    );
    await expect(holdings(OLD)).resolves.toEqual({ refined_oil: 56, wood: 8 });
    for (const attempt of [0, 1, 2]) {
      const sites = attempt === 2 ? services() : new GolemForgeSiteService({ pool: pool!, worldLookup: undefined, isLand, now: () => clock });
      const retired = await sites.retireLegacySite(legacyId);
      expect(retired).toMatchObject({ entranceId: legacyId, state: "collapsed" });
      await (attempt === 2 ? runtimeWith(sites) : runtime).collapseGolemForge(retired!);
    }
    await expect(pool!.query(
      "SELECT count(*)::int AS count FROM inventory_operations WHERE source='dungeon_entry_refund' AND player_id='gfs-old'"
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(holdings(OLD)).resolves.toEqual({ refined_oil: 100, wood: 10 });
    await expect(pool!.query("SELECT count(*)::int AS count FROM dungeon_run_admissions WHERE player_id=$1 AND refunded_at IS NULL", [OLD]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool!.query("SELECT cycle,collapse_at FROM golem_forge_sites WHERE region_key='1k:2e'"))
      .resolves.toMatchObject({ rows: [{ cycle: 1, collapse_at: null }] });
    await expect(services().siteForEntrance(legacyId)).resolves.toBeNull();
  }, 60_000);
});
