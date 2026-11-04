import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FIELD_CONSUMABLE_RECIPES, type FieldConsumableItemId } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { DungeonSkillService } from "./dungeonSkills.js";
import { FieldConsumableError, FieldConsumableService } from "./fieldConsumables.js";
import { InventoryService } from "./inventory.js";
import { validateItemDefinitionCatalog } from "./items.js";
import { PlayerService } from "./players.js";
import { SkillService } from "./skills/skillService.js";
import { GameState } from "./state.js";
import { waterSiteCandidatesNear } from "./waterSitePlacement.js";
import { WaterSiteError, WaterSiteService } from "./waterSites.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const databaseSuite = adminUrl ? describe : describe.skip;
const MIGRATIONS = ["1064_water_pearl_dives_whirlpools.sql", "1065_tidecraft_items.sql"];
/** Off the Florida coast; the fake World lookup calls every point coastal ocean. */
const ORIGIN = { lat: 25.7, lon: -80.1 };

databaseSuite("1064/1065 Tidecraft migrations, pearl diving, whirlpool fares and Tidecraft items", () => {
  const databaseName = `ash_atlas_stability_tide_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const playerId = `tide-${randomUUID().slice(0, 8)}`;
  const config = loadConfig({ NODE_ENV: "test" });
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;
  let directory = "";
  let databaseUrl = "";

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/ash_atlas_stability") {
      throw new Error("Migration tests require a local disposable ash_atlas_stability admin");
    }
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-tide-"));
    const migrations = path.resolve(process.cwd(), "../../db/migrations");
    for (const file of await readdir(migrations)) {
      if (file.endsWith(".sql") && file.localeCompare(MIGRATIONS[0]!) < 0) {
        await copyFile(path.join(migrations, file), path.join(directory, file));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    // Populated: a player with a stored tonic buff before the new buff kind exists.
    await pool.query(
      `INSERT INTO players (
         id, username, personal_flag_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, hunger,
         hunger_base_capacity, geom
       ) VALUES ($1,'Tide Test','blue','GLOBAL',$2,$3,$2,$3,600,false,2000,2000,
                 ST_SetSRID(ST_MakePoint($3,$2),4326))`,
      [playerId, ORIGIN.lat, ORIGIN.lon]
    );
    await pool.query(
      `INSERT INTO player_field_buffs (player_id, buff_id, operation_key, started_at, ends_at)
       VALUES ($1, 'anti_venom', 'seed', now(), now() + interval '1 hour')`,
      [playerId]
    );
    for (const migration of MIGRATIONS) await copyFile(path.join(migrations, migration), path.join(directory, migration));
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual(MIGRATIONS);
  }, 900_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const inventory = () => new InventoryService(pool!);
  const total = async (itemId: string) => Number((await pool!.query<{ quantity: string }>(
    "SELECT COALESCE(SUM(quantity), 0)::text AS quantity FROM player_inventory WHERE player_id = $1 AND resource_type = $2",
    [playerId, itemId]
  )).rows[0]?.quantity ?? 0);
  const grant = (key: string, grants: Array<{ itemId: string; quantity: number }>) => inventory().grantItemsForOperation({
    operationKey: `tide-seed:${playerId}:${key}`,
    playerId,
    source: "test_seed",
    grants: grants.map((entry) => ({ itemId: entry.itemId as never, variant: null, quantity: entry.quantity }))
  });
  const setRank = (rank: number) => pool!.query(
    `INSERT INTO player_skill_ranks (player_id, skill_id, rank, points_spent) VALUES ($1, 'tidecraft', $2, $2)
     ON CONFLICT (player_id, skill_id) DO UPDATE SET rank = EXCLUDED.rank`,
    [playerId, rank]
  );
  const coastalOcean = {
    lookupGameplayEnvironments: vi.fn(async (points: readonly { lat: number; lon: number }[]) =>
      points.map(() => ({ ok: true, surfaceKind: "water", waterKind: "ocean", coastlineDistanceM: 800 })) as never)
  };

  async function connectedState(position: { lat: number; lon: number }): Promise<GameState> {
    const players = new PlayerService(pool!, config);
    const loaded = await players.loadPlayer(playerId);
    const gameState = new GameState(config);
    gameState.connectPlayer({ ...loaded!, lat: position.lat, lon: position.lon, anchorLat: position.lat, anchorLon: position.lon } as never);
    gameState.relocateToAnchor(playerId, position);
    return gameState;
  }

  it("keeps the stored buffs, passes the item catalog and has an empty second run", async () => {
    const buffs = await pool!.query("SELECT buff_id FROM player_field_buffs WHERE player_id = $1", [playerId]);
    expect(buffs.rows).toEqual([{ buff_id: "anti_venom" }]);
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([]);
    await expect(pool!.query(
      "INSERT INTO player_field_buffs (player_id, buff_id, operation_key, started_at, ends_at) VALUES ($1, 'bogus', 'x', now(), now() + interval '1 hour')",
      [playerId]
    )).rejects.toThrow();
  });

  it("dives once per bed per 7 hours, replays without a second pearl, and yields by rank", async () => {
    const bed = waterSiteCandidatesNear(ORIGIN, 5_000).find((site) => site.kind === "pearl_bed")!;
    const gameState = await connectedState(bed.position);
    let roll = 0.9;
    const sites = new WaterSiteService({
      pool: pool!, inventory: inventory(), worldLookup: coastalOcean, gameState,
      logger: { warn: vi.fn() }, random: () => roll
    });

    await expect(sites.dive(playerId, bed.siteId, "dive-0")).rejects.toMatchObject({ code: "TIDECRAFT_RANK_REQUIRED" });
    await setRank(1);
    gameState.setAfloat(playerId, false);
    await expect(sites.dive(playerId, bed.siteId, "dive-0")).rejects.toMatchObject({ code: "WATER_SITE_NOT_AFLOAT" });
    gameState.setAfloat(playerId, true, true);

    const before = await total("pearl");
    const first = await sites.dive(playerId, bed.siteId, "dive-1");
    expect(first).toMatchObject({ pearls: 1, replayed: false });
    expect(await total("pearl")).toBe(before + 1);

    // Replay: same request id, the first answer again and no second pearl.
    const replay = await sites.dive(playerId, bed.siteId, "dive-1");
    expect(replay).toMatchObject({ pearls: 1, replayed: true });
    expect(await total("pearl")).toBe(before + 1);

    // A new request inside 7 hours is refused.
    await expect(sites.dive(playerId, bed.siteId, "dive-2")).rejects.toMatchObject({ code: "PEARL_DIVE_COOLDOWN" });
    expect(await total("pearl")).toBe(before + 1);

    const age = () => pool!.query(
      "UPDATE player_pearl_dives SET last_dived_at = now() - interval '7 hours 1 minute' WHERE player_id = $1",
      [playerId]
    );
    await age();
    await setRank(2);
    roll = 0.9;
    expect((await sites.dive(playerId, bed.siteId, "dive-3")).pearls).toBe(1);
    await age();
    roll = 0.1;
    expect((await sites.dive(playerId, bed.siteId, "dive-4")).pearls).toBe(2);
    await age();
    await setRank(3);
    roll = 0.99;
    expect((await sites.dive(playerId, bed.siteId, "dive-5")).pearls).toBe(2);
    expect(await total("pearl")).toBe(before + 1 + 1 + 2 + 2);

    // Too far from the bed.
    await age();
    gameState.relocateToAnchor(playerId, { lat: bed.position.lat + 0.01, lon: bed.position.lon });
    gameState.setAfloat(playerId, true, true);
    await expect(sites.dive(playerId, bed.siteId, "dive-6")).rejects.toMatchObject({ code: "WATER_SITE_TOO_FAR" });
  });

  it("charges a whirlpool fare atomically with the relocation and never twice", async () => {
    const whirlpool = waterSiteCandidatesNear(ORIGIN, 60_000).find((site) => site.kind === "whirlpool")!;
    const gameState = await connectedState(whirlpool.position);
    gameState.setAfloat(playerId, true, true);
    await setRank(1);
    const sites = new WaterSiteService({
      pool: pool!, inventory: inventory(), worldLookup: coastalOcean, gameState, logger: { warn: vi.fn() }
    });
    const platesBefore = await total("shellback_plate");
    await expect(sites.planWhirlpool(playerId, whirlpool.siteId, "whirl-1")).rejects.toMatchObject({ code: "WHIRLPOOL_PLATES_REQUIRED" });

    await grant("plates", [{ itemId: "shellback_plate", quantity: 40 }]);
    const plan = await sites.planWhirlpool(playerId, whirlpool.siteId, "whirl-1");
    expect(plan.destination).toEqual(whirlpool.partner!.position);
    expect(plan.distanceM).toBeGreaterThanOrEqual(5_000);

    const relocate = async (requestId: string) => {
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE players SET lat = $2, lon = $3, geom = ST_SetSRID(ST_MakePoint($3, $2), 4326) WHERE id = $1",
          [playerId, plan.destination.lat, plan.destination.lon]
        );
        await sites.chargeWhirlpoolInTransaction(client, playerId, requestId, whirlpool.siteId);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    const position = async () => (await pool!.query<{ lat: number }>("SELECT lat FROM players WHERE id = $1", [playerId])).rows[0]!.lat;
    const startLat = await position();
    const startLon = (await pool!.query<{ lon: number }>("SELECT lon FROM players WHERE id = $1", [playerId])).rows[0]!.lon;

    await relocate("whirl-1");
    expect(await total("shellback_plate")).toBe(platesBefore + 40 - 34);
    expect(await position()).toBeCloseTo(plan.destination.lat, 6);

    // Replay of the same trip: refused inside the transaction, no move and no second fare.
    await pool!.query(
      "UPDATE players SET lat = $2, lon = $3, geom = ST_SetSRID(ST_MakePoint($3, $2), 4326) WHERE id = $1",
      [playerId, startLat, startLon]
    );
    await expect(relocate("whirl-1")).rejects.toMatchObject({ code: "WHIRLPOOL_ALREADY_USED" });
    expect(await position()).toBe(startLat);
    await expect(sites.planWhirlpool(playerId, whirlpool.siteId, "whirl-1")).rejects.toMatchObject({ code: "WHIRLPOOL_ALREADY_USED" });

    // Not enough plates for a second trip: the relocation rolls back.
    await expect(relocate("whirl-2")).rejects.toMatchObject({ code: "WHIRLPOOL_PLATES_REQUIRED" });
    expect(await position()).toBe(startLat);
    expect(await total("shellback_plate")).toBe(platesBefore + 6);

    // Denied without rank and when not afloat.
    await pool!.query("DELETE FROM player_skill_ranks WHERE player_id = $1 AND skill_id = 'tidecraft'", [playerId]);
    await grant("plates-2", [{ itemId: "shellback_plate", quantity: 34 }]);
    await expect(sites.planWhirlpool(playerId, whirlpool.siteId, "whirl-3")).rejects.toMatchObject({ code: "TIDECRAFT_RANK_REQUIRED" });
    await setRank(1);
    gameState.setAfloat(playerId, false);
    await expect(sites.planWhirlpool(playerId, whirlpool.siteId, "whirl-3")).rejects.toMatchObject({ code: "WATER_SITE_NOT_AFLOAT" });
  });

  it("discovers Tidecraft for 20 Abyssal Orbs at a Drowned City site, once", async () => {
    await pool!.query("DELETE FROM player_skill_ranks WHERE player_id = $1 AND skill_id = 'tidecraft'", [playerId]);
    const site = waterSiteCandidatesNear(ORIGIN, 400_000).find((candidate) => candidate.kind === "drowned_city_site")!;
    const gameState = await connectedState(site.position);
    await pool!.query(
      "INSERT INTO player_progression_profiles (player_id, level) VALUES ($1, 20) ON CONFLICT (player_id) DO NOTHING",
      [playerId]
    );
    const skills = new SkillService(pool!);
    await skills.getOrCreate(playerId);
    const dungeonSkills = new DungeonSkillService(pool!, inventory(), skills);
    const sites = new WaterSiteService({
      pool: pool!, inventory: inventory(), worldLookup: coastalOcean, gameState, logger: { warn: vi.fn() },
      turnIn: (id, skillId, requestId) => dungeonSkills.turnIn(id, skillId, requestId)
    });
    await grant("orbs", [{ itemId: "abyssal_orb", quantity: 19 }]);
    await expect(sites.presentOrbs(playerId, site.siteId, "orbs-1")).rejects.toMatchObject({ code: "TIDECRAFT_ORBS_REQUIRED" });
    expect(await total("abyssal_orb")).toBe(19);

    await grant("orbs-2", [{ itemId: "abyssal_orb", quantity: 1 }]);
    const discovered = await sites.presentOrbs(playerId, site.siteId, "orbs-2");
    expect(discovered.message).toMatch(/Tidecraft/u);
    expect(await total("abyssal_orb")).toBe(0);
    expect((await sites.tidecraftState(playerId)).discovered).toBe(true);

    await expect(sites.presentOrbs(playerId, site.siteId, "orbs-3")).rejects.toMatchObject({ code: "TIDECRAFT_ALREADY_KNOWN" });
    expect(await total("abyssal_orb")).toBe(0);

    gameState.relocateToAnchor(playerId, { lat: site.position.lat + 0.01, lon: site.position.lon });
    await expect(sites.presentOrbs(playerId, site.siteId, "orbs-4")).rejects.toBeInstanceOf(WaterSiteError);
  });

  it("gates each Tidecraft recipe on rank and debits exactly its inputs", async () => {
    const service = new FieldConsumableService(pool!, inventory());
    const items: Array<[FieldConsumableItemId, number]> = [
      ["tidewater_draught", 1], ["undertow_snare", 1], ["stillwater_orb", 2], ["free_step_ward", 2], ["masons_tome", 3]
    ];
    await grant("craft-materials", [
      { itemId: "pearl", quantity: 25 }, { itemId: "shellback_plate", quantity: 250 }, { itemId: "lichen", quantity: 5 },
      { itemId: "bloom_petal", quantity: 5 }, { itemId: "sulfur", quantity: 5 }, { itemId: "abyssal_orb", quantity: 5 },
      { itemId: "griffin_plume", quantity: 10 }, { itemId: "iron", quantity: 10 }
    ]);
    for (const [itemId, rank] of items) {
      await setRank(rank - 1 || 1);
      if (rank > 1) {
        await expect(service.craft(playerId, `craft-denied-${itemId}`, itemId)).rejects.toMatchObject({ code: "FIELD_CRAFT_SKILL_REQUIRED" });
      }
      await setRank(rank);
      const recipe = FIELD_CONSUMABLE_RECIPES[itemId];
      const before = Object.fromEntries(await Promise.all(recipe.inputs.map(async (input) => [input.itemId, await total(input.itemId)] as const)));
      const outputBefore = await total(itemId);
      const crafted = await service.craft(playerId, `craft-${itemId}`, itemId);
      expect(crafted).toMatchObject({ quantity: recipe.output, replayed: false });
      for (const input of recipe.inputs) expect(await total(input.itemId)).toBe(before[input.itemId]! - input.quantity);
      expect(await total(itemId)).toBe(outputBefore + recipe.output);
      // Replay: no second debit or output.
      expect((await service.craft(playerId, `craft-${itemId}`, itemId)).replayed).toBe(true);
      expect(await total(itemId)).toBe(outputBefore + recipe.output);
    }
    await pool!.query("DELETE FROM player_skill_ranks WHERE player_id = $1 AND skill_id = 'tidecraft'", [playerId]);
    await expect(service.craft(playerId, "craft-no-rank", "tidewater_draught")).rejects.toBeInstanceOf(FieldConsumableError);
  });

  it("times the Tidewater Draught by rank and halves one repair per Mason's Tome", async () => {
    const service = new FieldConsumableService(pool!, inventory());
    await grant("draughts", [{ itemId: "tidewater_draught", quantity: 2 }, { itemId: "masons_tome", quantity: 2 }]);
    await setRank(1);
    const hour = (await service.consumeBuff(playerId, "drink-1", "tidewater_draught")).buffs.find((buff) => buff.buffId === "tidewater")!;
    expect(hour.endsAt! - hour.startedAt).toBe(75 * 60 * 1_000);
    await setRank(3);
    const twoHours = (await service.consumeBuff(playerId, "drink-2", "tidewater_draught")).buffs.find((buff) => buff.buffId === "tidewater")!;
    expect(twoHours.endsAt! - twoHours.startedAt).toBe(150 * 60 * 1_000);
    await service.clearTidewater(playerId);
    expect((await service.activeBuffs(playerId)).map((buff) => buff.buffId)).not.toContain("tidewater");

    const tomes = await total("masons_tome");
    await expect(service.applyMasonsTome(playerId, "tome-0")).rejects.toMatchObject({ code: "MASONS_TOME_NO_REPAIR" });
    expect(await total("masons_tome")).toBe(tomes);
    const flagId = randomUUID();
    await pool!.query(
      `INSERT INTO flag_repair_operations (
         owner_player_id, flag_id, burn_operation_id, damage_cycle_id, request_id, flag_name, flag_lat, flag_lon,
         started_at, completes_at, paused_burn_remaining_ms, repair_kit_quantity, stone_quantity,
         repair_mode, maximum_health, full_repair_ms
       ) VALUES ($1, $2, NULL, gen_random_uuid(), 'repair-1', 'Test Flag', 0, 0,
                 now() - interval '20 minutes', now() + interval '40 minutes', 0, 0, 0, 'progressive', 1000, 3600000)`,
      [playerId, flagId]
    );
    const earned = async () => (await pool!.query<{ due: number; remaining_s: number; full: string }>(
      `SELECT FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - started_at)) * 1000 * maximum_health / full_repair_ms)::int AS due,
              EXTRACT(EPOCH FROM (completes_at - clock_timestamp()))::int AS remaining_s, full_repair_ms::text AS full
       FROM flag_repair_operations WHERE flag_id = $1`,
      [flagId]
    )).rows[0]!;
    const before = await earned();
    const used = await service.applyMasonsTome(playerId, "tome-1");
    expect(used).toMatchObject({ replayed: false, flagId });
    const after = await earned();
    expect(after.full).toBe("1800000");
    expect(Math.abs(after.due - before.due)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.remaining_s - before.remaining_s / 2)).toBeLessThanOrEqual(2);
    expect(await total("masons_tome")).toBe(tomes - 1);
    expect((await service.applyMasonsTome(playerId, "tome-1")).replayed).toBe(true);
    await expect(service.applyMasonsTome(playerId, "tome-2")).rejects.toMatchObject({ code: "MASONS_TOME_ALREADY_USED" });
    expect(await total("masons_tome")).toBe(tomes - 1);
  });
});
