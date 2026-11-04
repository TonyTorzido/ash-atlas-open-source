import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GIVING_BERRY_ITEM_ID,
  GIVING_SAPLING_ITEM_ID,
  GROWN_TREE_BERRY_REGROW_MS,
  SAPLING_DAY_MS,
  SAPLING_GROWTH_BUCKETS,
  SAPLING_PLANTABLE_BIOMES,
  WORLD_ZONE_BIOMES,
  type WorldZoneBiome,
  type LatLon,
  nearestTreeLatticePoint,
  treeLatticePoint
} from "@ash-atlas/shared";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { loadConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { CollectibleService, type CollectiblePlayer } from "./collectibles.js";
import { GivingSaplingService, SaplingError, type SaplingViewChange } from "./givingSaplings.js";
import { fanOutSaplingViewChanges } from "./givingSaplingFanout.js";
import { HarvestSessionService } from "./harvestSessions.js";
import { InventoryService } from "./inventory.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const ORIGIN: LatLon = { lat: 35, lon: -106 };
const START_MS = Date.parse("2026-10-03T12:00:00Z");

/** A point `northM` metres north of the origin (0.001 degrees of latitude is about 111 m). */
function at(northM: number): LatLon {
  return { lat: ORIGIN.lat + northM / 111_195, lon: ORIGIN.lon };
}

describeDatabase("Giving Tree saplings PostgreSQL lifecycle", () => {
  const databaseName = `ash_atlas_stability_saplings_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let inventory: InventoryService;
  let nowMs = START_MS;
  let terrain: "land" | "water" | "unknown" = "land";
  let territoryOwner: string | null = null;
  let knownTrees: { id: string; position: LatLon }[] = [];
  let biome: WorldZoneBiome = "greenwood";
  /** The healing-aura index as the service keeps it: tree id to position, plus every call made. */
  const aura = new Map<string, LatLon>();
  const auraCalls: string[] = [];
  const viewChanges: SaplingViewChange[] = [];
  let service: GivingSaplingService;
  let owner: string;
  let other: string;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.pathname.startsWith("/ash_atlas_stability")) {
      throw new Error("Sapling tests require the local disposable stability database");
    }
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN; END IF; END $$"
    );
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    parsed.pathname = `/${databaseName}`;
    await runMigrations(parsed.toString());
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 6 });
    inventory = new InventoryService(pool);
    service = makeService();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin?.end();
  });

  function makeService(): GivingSaplingService {
    return new GivingSaplingService(pool, inventory, {
      terrainAt: async () => terrain,
      territoryOwnerAt: async () => territoryOwner,
      biomeAt: async () => biome,
      nearbyTrees: () => knownTrees,
      onViewChange: (changes) => { viewChanges.push(...changes); },
      aura: {
        upsert: (tree) => { auraCalls.push(`upsert:${tree.id}`); aura.set(tree.id, { lat: tree.lat, lon: tree.lon }); },
        remove: (id) => { auraCalls.push(`remove:${id}`); aura.delete(id); }
      },
      now: () => nowMs
    });
  }

  beforeEach(async () => {
    biome = "greenwood";
    aura.clear();
    auraCalls.length = 0;
    viewChanges.length = 0;
    nowMs = START_MS;
    terrain = "land";
    territoryOwner = null;
    knownTrees = [];
    await pool.query("DELETE FROM harvest_sessions");
    await pool.query("DELETE FROM player_saplings");
    // Inventory rows are append-only, so every test gets fresh players.
    // A fresh service starts with an empty in-memory index, matching the emptied table.
    service = makeService();
    owner = await createPlayer("Planter");
    other = await createPlayer("Passerby");
  });

  async function createPlayer(name: string): Promise<string> {
    const id = `sapling-${name}-${randomUUID()}`;
    await pool.query(
      `INSERT INTO players (id, username, region_code, lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom)
       VALUES ($1, $2, 'GLOBAL', 35, -106, 35, -106, 900, false, ST_SetSRID(ST_MakePoint(-106, 35), 4326))`,
      [id, `${name}-${randomUUID().slice(0, 6)}`]
    );
    return id;
  }

  async function give(playerId: string, itemId: string, quantity: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `test-grant:${randomUUID()}`,
      playerId,
      source: "test",
      grants: [{ itemId: itemId as never, variant: "default", quantity }]
    });
  }

  async function count(playerId: string, itemId: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT coalesce(sum(quantity), 0)::text AS quantity FROM player_inventory WHERE player_id = $1 AND resource_type = $2",
      [playerId, itemId]
    );
    return Number(result.rows[0]!.quantity);
  }

  const plantArgs = (position: LatLon, requestId = randomUUID(), source: "berry" | "sapling" = "berry") => ({
    playerId: owner, requestId, regionCode: "GLOBAL", position, source, aggressive: false, worldPresent: true
  });

  async function plantAt(position: LatLon): Promise<string> {
    await give(owner, GIVING_BERRY_ITEM_ID, 1);
    const result = await service.plant(plantArgs(position));
    return result.sapling!.saplingId;
  }

  async function tendDaily(saplingId: string, days: number[], tenderId = other, rank = 0, position: LatLon = ORIGIN): Promise<void> {
    for (const day of days) {
      nowMs = START_MS + day * SAPLING_DAY_MS;
      await service.tend({ playerId: tenderId, saplingId, position, groveLoreRank: rank });
    }
  }

  async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SaplingError);
    expect((error as SaplingError).code).toBe(code);
  }

  describe("planting", () => {
    it("plants on open land, spends one berry and owns the sapling", async () => {
      await give(owner, GIVING_BERRY_ITEM_ID, 2);
      const result = await service.plant(plantArgs(ORIGIN));
      expect(result).toMatchObject({ replayed: false, sapling: { state: "sapling", ownerPlayerId: owner } });
      expect(await count(owner, GIVING_BERRY_ITEM_ID)).toBe(1);
      expect([...aura.keys()]).toEqual([`sapling:${result.sapling!.saplingId}`]);
      expect(auraCalls).toEqual([`upsert:sapling:${result.sapling!.saplingId}`]);
    });

    it("denies planting while aggressive, off the world, on water, or without a berry", async () => {
      await give(owner, GIVING_BERRY_ITEM_ID, 1);
      await expectCode(service.plant({ ...plantArgs(ORIGIN), aggressive: true }), "SAPLING_AGGRESSIVE");
      await expectCode(service.plant({ ...plantArgs(ORIGIN), worldPresent: false }), "SAPLING_WORLD_REQUIRED");
      terrain = "water";
      await expectCode(service.plant(plantArgs(ORIGIN)), "SAPLING_WATER");
      terrain = "unknown";
      await expectCode(service.plant(plantArgs(ORIGIN)), "SAPLING_TERRAIN_UNAVAILABLE");
      terrain = "land";
      await expectCode(service.plant(plantArgs(ORIGIN, randomUUID(), "sapling")), "SAPLING_NO_SAPLING");
      await expectCode(service.plant({ ...plantArgs(ORIGIN), playerId: other }), "SAPLING_NO_BERRY");
      expect((await pool.query("SELECT 1 FROM player_saplings")).rowCount).toBe(0);
    });

    it("respects flag territory: refused on another player's land, allowed on your own or unclaimed land", async () => {
      await give(owner, GIVING_BERRY_ITEM_ID, 3);
      territoryOwner = other;
      await expectCode(service.plant(plantArgs(ORIGIN)), "SAPLING_TERRITORY_OWNED_BY_OTHER");
      territoryOwner = owner;
      await expect(service.plant(plantArgs(ORIGIN))).resolves.toMatchObject({ replayed: false });
      territoryOwner = null;
      await expect(service.plant(plantArgs(at(100)))).resolves.toMatchObject({ replayed: false });
    });

    it("keeps 90 m from other saplings and from known trees", async () => {
      await plantAt(ORIGIN);
      await give(owner, GIVING_BERRY_ITEM_ID, 3);
      await expectCode(service.plant(plantArgs(at(60))), "SAPLING_TOO_CLOSE");
      await expect(service.plant(plantArgs(at(120)))).resolves.toMatchObject({ replayed: false });
      knownTrees = [{ id: "wild", position: at(300) }];
      await expectCode(service.plant(plantArgs(at(375))), "SAPLING_TOO_CLOSE");
      knownTrees = [{ id: "wild", position: at(500) }];
      await expect(service.plant(plantArgs(at(375)))).resolves.toMatchObject({ replayed: false });
    });

    it("re-snaps a planting target to the tree lattice, range-checks it and keeps every rule", async () => {
      const stand = nearestTreeLatticePoint(ORIGIN);
      const lattice = { lat: stand.lat, lon: stand.lon };
      await give(owner, GIVING_BERRY_ITEM_ID, 6);
      // A target a few metres off the lattice point is moved onto it.
      const offTarget = { lat: lattice.lat + 4 / 111_195, lon: lattice.lon };
      const planted = await service.plant({ ...plantArgs(lattice), target: offTarget });
      expect(planted.sapling!.lat).toBeCloseTo(lattice.lat, 9);
      expect(planted.sapling!.lon).toBeCloseTo(lattice.lon, 9);
      // The same lattice point cannot be planted twice (spacing).
      await expectCode(service.plant({ ...plantArgs(lattice), target: offTarget }), "SAPLING_TOO_CLOSE");
      // A target beyond the interact range of the player is refused, even though it snaps to a real point.
      await expectCode(service.plant({ ...plantArgs(lattice), target: at(500) }), "SAPLING_OUT_OF_RANGE");
      // Existing rules still apply to the snapped point.
      const neighbour = treeLatticePoint(stand.row, stand.col + 1);
      territoryOwner = other;
      await expectCode(service.plant({ ...plantArgs(neighbour), target: neighbour }), "SAPLING_TERRITORY_OWNED_BY_OTHER");
      territoryOwner = null;
      terrain = "water";
      await expectCode(service.plant({ ...plantArgs(neighbour), target: neighbour }), "SAPLING_WATER");
      terrain = "land";
      // A lattice neighbour is exactly the spacing away and is allowed.
      const next = await service.plant({ ...plantArgs(neighbour), target: neighbour });
      expect(next.sapling!.lon).toBeCloseTo(neighbour.lon, 9);
      expect(await count(owner, GIVING_BERRY_ITEM_ID)).toBe(4);
    });

    it("has no cap on growing saplings per player", async () => {
      const total = 14;
      for (let index = 0; index < total; index += 1) await plantAt(at(index * 100));
      expect((await pool.query("SELECT 1 FROM player_saplings WHERE status = 'sapling'")).rowCount).toBe(total);
      expect(service.liveTreeCount).toBe(total);
      expect(await count(owner, GIVING_BERRY_ITEM_ID)).toBe(0);
    });

    it("is replay-safe: one request plants once and spends one berry", async () => {
      await give(owner, GIVING_BERRY_ITEM_ID, 2);
      const requestId = randomUUID();
      const results = await Promise.all([
        service.plant(plantArgs(ORIGIN, requestId)),
        service.plant(plantArgs(ORIGIN, requestId))
      ]);
      expect(results.filter((result) => result.replayed)).toHaveLength(1);
      expect((await pool.query("SELECT 1 FROM player_saplings")).rowCount).toBe(1);
      expect(await count(owner, GIVING_BERRY_ITEM_ID)).toBe(1);
      await expect(service.plant(plantArgs(ORIGIN, requestId))).resolves.toMatchObject({ replayed: true });
      expect(await count(owner, GIVING_BERRY_ITEM_ID)).toBe(1);
    });
  });

  describe("tending and maturity", () => {
    it("cannot be tended before the next day, then any player in range may tend it", async () => {
      const id = await plantAt(ORIGIN);
      nowMs += SAPLING_DAY_MS / 2;
      await expectCode(service.tend({ playerId: other, saplingId: id, position: ORIGIN, groveLoreRank: 0 }), "SAPLING_TEND_TOO_SOON");
      nowMs += SAPLING_DAY_MS / 2;
      await expectCode(service.tend({ playerId: other, saplingId: id, position: at(50), groveLoreRank: 0 }), "SAPLING_OUT_OF_RANGE");
      const tended = await service.tend({ playerId: other, saplingId: id, position: at(5), groveLoreRank: 3 });
      expect(tended.sapling).toMatchObject({ state: "sapling", fastGrowth: false });
      expect(Date.parse(tended.sapling!.maturesAt!)).toBe(START_MS + 6 * SAPLING_DAY_MS);
      expect(Date.parse(tended.sapling!.diesAt!)).toBe(nowMs + 2 * SAPLING_DAY_MS);
    });

    it("dies when nobody tends it for 2 days and leaves the world", async () => {
      const id = await plantAt(ORIGIN);
      nowMs += 2 * SAPLING_DAY_MS - 1;
      expect(service.listNear(ORIGIN, 500)).toHaveLength(1);
      nowMs += 1;
      expect(service.listNear(ORIGIN, 500)).toHaveLength(0);
      await service.sweepDue();
      expect(aura.size).toBe(0);
      expect((await pool.query("SELECT status FROM player_saplings WHERE id = $1", [id])).rows[0]).toEqual({ status: "dead" });
      await expectCode(service.tend({ playerId: owner, saplingId: id, position: ORIGIN, groveLoreRank: 2 }), "SAPLING_NOT_GROWING");
      await give(owner, GIVING_BERRY_ITEM_ID, 1);
      await expect(service.plant(plantArgs(ORIGIN))).resolves.toMatchObject({ replayed: false });
    });

    it("matures into a Giving Tree after 6 tended days and then regrows berries every 5 hours", async () => {
      const id = await plantAt(ORIGIN);
      await tendDaily(id, [1, 2, 3, 4, 5]);
      nowMs = START_MS + 6 * SAPLING_DAY_MS - 1;
      expect(service.listNear(ORIGIN, 500)[0]).toMatchObject({ state: "sapling" });
      nowMs += 1;
      const [grown] = service.listNear(ORIGIN, 500);
      expect(grown).toMatchObject({ state: "grown", berryAvailable: true, growth: SAPLING_GROWTH_BUCKETS });
      await service.sweepDue();
      expect(aura.size).toBe(1);

      const gathered = await service.gather({ playerId: other, saplingId: id, position: ORIGIN });
      expect(gathered.sapling).toMatchObject({ berryAvailable: false });
      expect(await count(other, GIVING_BERRY_ITEM_ID)).toBe(1);
      await expectCode(service.gather({ playerId: other, saplingId: id, position: ORIGIN }), "SAPLING_BERRIES_NOT_READY");
      nowMs += GROWN_TREE_BERRY_REGROW_MS;
      await service.gather({ playerId: other, saplingId: id, position: ORIGIN });
      expect(await count(other, GIVING_BERRY_ITEM_ID)).toBe(2);
      await expectCode(service.tend({ playerId: owner, saplingId: id, position: ORIGIN, groveLoreRank: 2 }), "SAPLING_NOT_GROWING");
    });

    it("Grove Lore rank 2 owner tending matures it in 4 days; a stranger's tending does not", async () => {
      const fastId = await plantAt(ORIGIN);
      const slowId = await plantAt(at(100));
      nowMs += SAPLING_DAY_MS;
      const fast = await service.tend({ playerId: owner, saplingId: fastId, position: ORIGIN, groveLoreRank: 2 });
      expect(fast.sapling).toMatchObject({ fastGrowth: true });
      await service.tend({ playerId: other, saplingId: slowId, position: at(100), groveLoreRank: 3 });
      for (const day of [2, 3]) {
        nowMs = START_MS + day * SAPLING_DAY_MS;
        await service.tend({ playerId: owner, saplingId: fastId, position: ORIGIN, groveLoreRank: 2 });
        await service.tend({ playerId: other, saplingId: slowId, position: at(100), groveLoreRank: 3 });
      }
      nowMs = START_MS + 4 * SAPLING_DAY_MS - 1;
      expect(service.listNear(ORIGIN, 500).find((entry) => entry.id === fastId)).toMatchObject({ state: "sapling" });
      nowMs += 1;
      const listed = service.listNear(ORIGIN, 500);
      expect(listed.find((entry) => entry.id === fastId)).toMatchObject({ state: "grown" });
      expect(listed.find((entry) => entry.id === slowId)).toMatchObject({ state: "sapling" });
    });

    it("an owner below rank 2 gets no speed-up", async () => {
      const id = await plantAt(ORIGIN);
      nowMs += SAPLING_DAY_MS;
      const result = await service.tend({ playerId: owner, saplingId: id, position: ORIGIN, groveLoreRank: 1 });
      expect(result.sapling).toMatchObject({ fastGrowth: false });
    });
  });

  describe("Grove Lore double harvest on Gather", () => {
    async function growTrees(total: number): Promise<string[]> {
      const ids: string[] = [];
      for (let index = 0; index < total; index += 1) {
        const position = at(index * 100);
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO player_saplings (owner_player_id, request_id, region_code, lat, lon, status, planted_at, last_tended_at,
             death_at, mature_at, matured_at, berry_ready_at)
           VALUES ($1, $2, 'GLOBAL', $3, $4, 'grown', $5, $5, $5, $5, $5, $5) RETURNING id`,
          [owner, randomUUID(), position.lat, position.lon, new Date(START_MS - 10 * SAPLING_DAY_MS)]
        );
        ids.push(inserted.rows[0]!.id);
      }
      return ids;
    }

    it("never doubles without Grove Lore, sometimes doubles at rank 3, and a replayed gather grants once", async () => {
      const ids = await growTrees(60);
      for (const [index, id] of ids.entries()) {
        await service.gather({ playerId: other, saplingId: id, position: at(index * 100), groveLoreRank: 0 });
      }
      expect(await count(other, GIVING_BERRY_ITEM_ID)).toBe(60);

      const third = await createPlayer("Gatherer");
      nowMs += GROWN_TREE_BERRY_REGROW_MS;
      for (const [index, id] of ids.entries()) {
        await service.gather({ playerId: third, saplingId: id, position: at(index * 100), groveLoreRank: 3 });
      }
      const gathered = await count(third, GIVING_BERRY_ITEM_ID);
      expect(gathered).toBeGreaterThan(60);
      expect(gathered).toBeLessThanOrEqual(120);

      // The same berry batch can never pay twice, even after a restore of the ready time.
      const first = ids[0]!;
      const batch = (await pool.query<{ berry_ready_at: Date }>("SELECT berry_ready_at FROM player_saplings WHERE id = $1", [first])).rows[0]!;
      await pool.query("UPDATE player_saplings SET berry_ready_at = $2 WHERE id = $1", [first, new Date(batch.berry_ready_at.getTime() - GROWN_TREE_BERRY_REGROW_MS)]);
      const before = await count(third, GIVING_BERRY_ITEM_ID);
      await service.gather({ playerId: third, saplingId: first, position: at(0), groveLoreRank: 3 });
      expect(await count(third, GIVING_BERRY_ITEM_ID)).toBe(before);
    });
  });

  describe("sick saplings", () => {
    it("stop healing once tending is due, and heal again when tended", async () => {
      const id = await plantAt(ORIGIN);
      const treeId = `sapling:${id}`;
      expect(aura.has(treeId)).toBe(true);
      nowMs += SAPLING_DAY_MS - 1;
      await service.sweepDue();
      expect(aura.has(treeId)).toBe(true);
      nowMs += 1;
      await service.sweepDue();
      expect(aura.has(treeId)).toBe(false);
      // Sick, but alive and still choosable on the map.
      expect(service.listNear(ORIGIN, 500)[0]).toMatchObject({ state: "sapling", phase: "needs_tending" });
      await service.tend({ playerId: other, saplingId: id, position: ORIGIN, groveLoreRank: 0 });
      expect(aura.has(treeId)).toBe(true);
    });

    it("are left out of the aura at boot, while healthy saplings and grown trees are loaded", async () => {
      const sickId = await plantAt(ORIGIN);
      const healthyId = await plantAt(at(100));
      nowMs += SAPLING_DAY_MS;
      await service.tend({ playerId: other, saplingId: healthyId, position: at(100), groveLoreRank: 0 });
      aura.clear();
      auraCalls.length = 0;
      const rebooted = makeService();
      await rebooted.loadIndex();
      expect([...aura.keys()]).toEqual([`sapling:${healthyId}`]);
      expect(aura.has(`sapling:${sickId}`)).toBe(false);
    });
  });

  describe("incremental aura index", () => {
    it("updates one tree per change and the sweep touches only due rows", async () => {
      const first = await plantAt(ORIGIN);
      nowMs += SAPLING_DAY_MS / 2;
      const second = await plantAt(at(100));
      const third = await plantAt(at(200));
      expect(auraCalls).toEqual([`upsert:sapling:${first}`, `upsert:sapling:${second}`, `upsert:sapling:${third}`]);
      auraCalls.length = 0;

      // Only the first sapling's tend timer is due.
      nowMs = START_MS + SAPLING_DAY_MS;
      expect(await service.sweepDue()).toBe(1);
      expect(auraCalls).toEqual([`remove:sapling:${first}`]);
      auraCalls.length = 0;
      // The swept row's next due_at is in the future, so a second sweep finds nothing.
      expect(await service.sweepDue()).toBe(0);

      await service.tend({ playerId: other, saplingId: first, position: ORIGIN, groveLoreRank: 0 });
      expect(auraCalls).toEqual([`upsert:sapling:${first}`]);
      auraCalls.length = 0;
      await service.pull({ playerId: owner, saplingId: second, position: at(100), groveLoreRank: 3 });
      expect(auraCalls).toEqual([`remove:sapling:${second}`]);
      expect(aura.has(`sapling:${third}`)).toBe(true);
    });

    it("keeps due_at on the next change only (tend due, then death or maturity)", async () => {
      const id = await plantAt(ORIGIN);
      const dueAt = async (): Promise<number> =>
        (await pool.query<{ due_at: Date }>("SELECT due_at FROM player_saplings WHERE id = $1", [id])).rows[0]!.due_at.getTime();
      expect(await dueAt()).toBe(START_MS + SAPLING_DAY_MS);
      nowMs += SAPLING_DAY_MS;
      await service.sweepDue();
      expect(await dueAt()).toBe(START_MS + 2 * SAPLING_DAY_MS);
    });
  });

  describe("biomes", () => {
    it("plants in tree biomes and refuses the rest, naming the biome", async () => {
      await give(owner, GIVING_BERRY_ITEM_ID, WORLD_ZONE_BIOMES.length);
      let spot = 0;
      for (const candidate of WORLD_ZONE_BIOMES) {
        biome = candidate;
        const attempt = service.plant(plantArgs(at(spot * 100)));
        if ((SAPLING_PLANTABLE_BIOMES as readonly string[]).includes(candidate)) {
          await expect(attempt).resolves.toMatchObject({ replayed: false });
          spot += 1;
        } else {
          const error = await attempt.then(() => null, (caught: unknown) => caught);
          expect(error).toBeInstanceOf(SaplingError);
          expect((error as SaplingError).code).toBe("SAPLING_BIOME");
        }
      }
      for (const denied of ["badlands", "steppe", "tundra", "frozen_waste", "coast", "open_ocean", "lake"] as const) {
        biome = denied;
        await expectCode(service.plant(plantArgs(at(9_000))), "SAPLING_BIOME");
      }
      biome = "badlands";
      await expect(service.plant(plantArgs(at(9_000)))).rejects.toThrow("Badlands");
      for (const allowed of ["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "wilds"] as const) {
        expect(SAPLING_PLANTABLE_BIOMES).toContain(allowed);
      }
    });
  });

  describe("chopping grown player trees", () => {
    function collectibles(): CollectibleService {
      return new CollectibleService(pool, {} as WorldLookupClient, loadConfig({ NODE_ENV: "test" }),
        { info() {}, warn() {} } as Pick<AppLogger, "info" | "warn">);
    }

    async function growTree(position: LatLon): Promise<string> {
      const id = await plantAt(position);
      await tendDaily(id, [1, 2, 3, 4, 5], owner, 0, position);
      nowMs = START_MS + 6 * SAPLING_DAY_MS;
      await service.sweepDue();
      return id;
    }

    it("removes the tree for good, pays Wood once, and a replayed completion does not pay twice", async () => {
      const id = await growTree(ORIGIN);
      const nodeId = `sapling:${id}`;
      expect(aura.has(nodeId)).toBe(true);
      const chopperId = other;
      const chopper: CollectiblePlayer = { playerId: chopperId, regionCode: "GLOBAL", position: ORIGIN };
      const vision = { flagId: randomUUID(), flagName: "Grove", center: ORIGIN, movementLeashRadiusM: 900, paddingM: 50, radiusM: 950 };
      const sessions = new HarvestSessionService(pool, collectibles());
      const revision = (await service.detail(id))!.stateRevision;

      const started = await sessions.startHarvest(chopper, nodeId, vision, "primary", revision);
      expect(started.session.resourceType).toBe("wood");
      await pool.query(
        `UPDATE harvest_sessions SET started_at = clock_timestamp() - interval '40 seconds',
           completes_at = clock_timestamp() - interval '1 second', expires_at = clock_timestamp() + interval '60 seconds'
         WHERE id = $1::uuid`, [started.session.sessionId]);
      const done = await sessions.completeHarvest(chopper, started.session.sessionId, vision);
      expect(done.nodeRemoved).toBe(true);
      expect(done.inventory.totals.wood).toBeGreaterThanOrEqual(4);
      const wood = await count(chopperId, "wood");

      // The handler's post-commit hook drops it from the aura; it never comes back.
      service.forgetChoppedTree(nodeId);
      expect(aura.has(nodeId)).toBe(false);
      expect((await pool.query("SELECT status, chopped_by_player_id FROM player_saplings WHERE id = $1", [id])).rows[0])
        .toEqual({ status: "chopped", chopped_by_player_id: chopperId });
      expect(service.listNear(ORIGIN, 500)).toHaveLength(0);
      const rebooted = makeService();
      expect(await rebooted.loadIndex()).toBe(0);

      const replay = await sessions.completeHarvest(chopper, started.session.sessionId, vision);
      expect(replay.replayed).toBe(true);
      expect(await count(chopperId, "wood")).toBe(wood);
      await expect(sessions.startHarvest({ ...chopper, playerId: owner }, nodeId, vision, "primary"))
        .rejects.toMatchObject({ code: "HARVEST_NODE_ALREADY_HARVESTED" });
      await expectCode(service.gather({ playerId: owner, saplingId: id, position: ORIGIN }), "SAPLING_NO_BERRIES");
    });

    it("refuses saplings that are not grown, and trees out of reach", async () => {
      const young = await plantAt(ORIGIN);
      const chopper: CollectiblePlayer = { playerId: other, regionCode: "GLOBAL", position: ORIGIN };
      const vision = { flagId: randomUUID(), flagName: "Grove", center: ORIGIN, movementLeashRadiusM: 900, paddingM: 50, radiusM: 950 };
      const sessions = new HarvestSessionService(pool, collectibles());
      await expect(sessions.startHarvest(chopper, `sapling:${young}`, vision, "primary"))
        .rejects.toMatchObject({ code: "HARVEST_NODE_ALREADY_HARVESTED" });
      await expect(sessions.startHarvest(chopper, "sapling:not-a-uuid", vision, "primary"))
        .rejects.toMatchObject({ code: "HARVEST_NODE_NOT_FOUND" });
      const grownId = await growTree(at(100));
      await expect(sessions.startHarvest({ ...chopper, position: ORIGIN }, `sapling:${grownId}`, vision, "primary"))
        .rejects.toMatchObject({ code: "HARVEST_TOO_FAR" });
    });
  });

  describe("served from memory, compact, pushed as deltas", () => {
    it("lists compact rows from the in-memory index without touching the database", async () => {
      const near = await plantAt(ORIGIN);
      const far = await plantAt(at(2_000));
      const query = vi.spyOn(pool, "query");
      const connect = vi.spyOn(pool, "connect");
      const list = service.listNear(ORIGIN, 800);
      expect(list).toEqual([{
        id: near, lat: ORIGIN.lat, lon: ORIGIN.lon, state: "sapling", growth: 0, phase: "healthy", berryAvailable: false
      }]);
      expect(Object.keys(list[0]!).sort()).toEqual(["berryAvailable", "growth", "id", "lat", "lon", "phase", "state"]);
      expect(service.listNear(at(2_000), 800).map((item) => item.id)).toEqual([far]);
      expect(query).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      query.mockRestore();
      connect.mockRestore();
      // Nearest first, bounded by the limit.
      expect(service.listNear(ORIGIN, 5_000, 1).map((item) => item.id)).toEqual([near]);
    });

    it("buckets growth and reports phase as time passes", async () => {
      await plantAt(ORIGIN);
      nowMs += SAPLING_DAY_MS;
      expect(service.listNear(ORIGIN, 100)[0]).toMatchObject({ growth: 1, phase: "needs_tending" });
      nowMs += SAPLING_DAY_MS * 0.8;
      expect(service.listNear(ORIGIN, 100)[0]).toMatchObject({ phase: "dying" });
    });

    it("gives the owner and exact timers only through a single-tree detail request", async () => {
      const id = await plantAt(ORIGIN);
      const detail = await service.detail(id);
      expect(detail).toMatchObject({ saplingId: id, ownerPlayerId: owner, state: "sapling", stateRevision: 0 });
      expect(detail!.ownerUsername).toMatch(/^Planter-/u);
      expect(detail!.maturesAt).toBe(new Date(START_MS + 6 * SAPLING_DAY_MS).toISOString());
      expect(await service.detail(randomUUID())).toBeNull();
      expect(await service.detail("not-a-uuid")).toBeNull();
      await service.pull({ playerId: owner, saplingId: id, position: ORIGIN, groveLoreRank: 3 });
      expect(await service.detail(id)).toBeNull();
    });

    it("emits one compact view change per changed tree, and none for a quiet sweep", async () => {
      const first = await plantAt(ORIGIN);
      expect(viewChanges.map((change) => [change.upsert?.id, change.removedId, change.position.lat])).toEqual([[first, null, ORIGIN.lat]]);
      viewChanges.length = 0;
      expect(await service.sweepDue()).toBe(0);
      expect(viewChanges).toEqual([]);

      nowMs += SAPLING_DAY_MS;
      await service.sweepDue();
      expect(viewChanges).toHaveLength(1);
      expect(viewChanges[0]!.upsert).toMatchObject({ id: first, phase: "needs_tending" });
      viewChanges.length = 0;
      await service.tend({ playerId: other, saplingId: first, position: ORIGIN, groveLoreRank: 0 });
      expect(viewChanges[0]!.upsert).toMatchObject({ id: first, phase: "healthy" });
      viewChanges.length = 0;
      await service.pull({ playerId: owner, saplingId: first, position: ORIGIN, groveLoreRank: 3 });
      expect(viewChanges).toEqual([{ position: { lat: ORIGIN.lat, lon: ORIGIN.lon }, upsert: null, removedId: first }]);
    });

    it("rebuilds the same view after a restart or reconnect from the database", async () => {
      await plantAt(ORIGIN);
      const second = await plantAt(at(100));
      nowMs += SAPLING_DAY_MS;
      await service.tend({ playerId: other, saplingId: second, position: at(100), groveLoreRank: 0 });
      const before = service.listNear(ORIGIN, 800);
      const rebooted = makeService();
      expect(await rebooted.loadIndex()).toBe(2);
      expect(rebooted.listNear(ORIGIN, 800)).toEqual(before);
    });

    it("pushes a delta to nearby players only, batched per player", async () => {
      const first = await plantAt(ORIGIN);
      const second = await plantAt(at(100));
      const sent: Array<{ playerId: string; upserts: string[]; removed: string[] }> = [];
      const players = new Map<string, LatLon | null>([
        ["near", at(50)], ["edge", at(700)], ["far", at(5_000)], ["indoors", null]
      ]);
      const fanned = fanOutSaplingViewChanges(viewChanges.slice(), {
        nearbyPlayerIds: () => [...players.keys()],
        playerPosition: (playerId) => players.get(playerId) ?? null,
        send: (playerId, message) => sent.push({ playerId, upserts: message.upserts.map((item) => item.id), removed: message.removed }),
        now: () => nowMs
      });
      expect(fanned).toBe(2);
      expect(sent).toEqual([
        { playerId: "near", upserts: [first, second], removed: [] },
        { playerId: "edge", upserts: [first, second], removed: [] }
      ]);
      expect(sent.map((entry) => entry.playerId)).not.toContain("far");
      expect(sent.map((entry) => entry.playerId)).not.toContain("indoors");
    });
  });

  describe("pulling (Grove Lore rank 3)", () => {
    it("needs rank 3, then returns a portable item that replants as a fresh sapling", async () => {
      const id = await plantAt(ORIGIN);
      await expectCode(service.pull({ playerId: owner, saplingId: id, position: ORIGIN, groveLoreRank: 2 }), "SAPLING_PULL_RANK_REQUIRED");
      const pulled = await service.pull({ playerId: owner, saplingId: id, position: ORIGIN, groveLoreRank: 3 });
      expect(pulled).toMatchObject({ replayed: false, sapling: null });
      expect(await count(owner, GIVING_SAPLING_ITEM_ID)).toBe(1);
      expect(aura.size).toBe(0);
      await expectCode(service.tend({ playerId: owner, saplingId: id, position: ORIGIN, groveLoreRank: 2 }), "SAPLING_NOT_GROWING");

      nowMs += SAPLING_DAY_MS;
      const replanted = await service.plant(plantArgs(at(500), randomUUID(), "sapling"));
      expect(replanted.sapling).toMatchObject({ state: "sapling", plantedAt: new Date(nowMs).toISOString() });
      expect(await count(owner, GIVING_SAPLING_ITEM_ID)).toBe(0);
    });

    it("grants once even if the request is repeated or raced", async () => {
      const id = await plantAt(ORIGIN);
      const args = { playerId: owner, saplingId: id, position: ORIGIN, groveLoreRank: 3 };
      const results = await Promise.all([service.pull(args), service.pull(args)]);
      expect(results.filter((result) => result.replayed)).toHaveLength(1);
      await expect(service.pull(args)).resolves.toMatchObject({ replayed: true });
      expect(await count(owner, GIVING_SAPLING_ITEM_ID)).toBe(1);
    });

    it("lets you pull someone else's sapling on unclaimed or your own land, not on land claimed by another", async () => {
      const id = await plantAt(ORIGIN);
      const unclaimedId = await plantAt(at(100));
      const args = { playerId: other, saplingId: id, position: ORIGIN, groveLoreRank: 3 };
      territoryOwner = owner;
      await expectCode(service.pull(args), "SAPLING_TERRITORY_OWNED_BY_OTHER");
      territoryOwner = other;
      await expect(service.pull(args)).resolves.toMatchObject({ replayed: false });
      expect(await count(other, GIVING_SAPLING_ITEM_ID)).toBe(1);
      territoryOwner = null;
      await expect(service.pull({ ...args, saplingId: unclaimedId, position: at(100) })).resolves.toMatchObject({ replayed: false });
    });

    it("cannot pull a grown tree", async () => {
      const id = await plantAt(ORIGIN);
      await tendDaily(id, [1, 2, 3, 4, 5], owner);
      nowMs = START_MS + 6 * SAPLING_DAY_MS;
      await expectCode(service.pull({ playerId: owner, saplingId: id, position: ORIGIN, groveLoreRank: 3 }), "SAPLING_NOT_GROWING");
    });
  });
});
