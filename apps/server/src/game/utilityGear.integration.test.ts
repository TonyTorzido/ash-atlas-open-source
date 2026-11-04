import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { EquipmentService } from "./equipment.js";
import { InventoryService } from "./inventory.js";
import { spendUtilityGearUseInTransaction, wornUtilityGearReady } from "./utilityGear.js";
import { UtilityGearProximityService } from "./utilityGearProximity.js";
import { coinwrightBonusGold } from "@ash-atlas/shared";
import { GivingSaplingService } from "./givingSaplings.js";
import { WalletService } from "./wallet.js";
import { PathfinderMarkService } from "./pathfinderMarks.js";
import { FlagAccessService } from "./flagAccess.js";
import { WorldMapService } from "./worldMap.js";
import type { PlayerRecord } from "./state.js";

const databaseUrl = safeDisposableDatabaseUrl(process.env.TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("utility gear PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let equipment: EquipmentService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await runMigrations(databaseUrl!);
  }, 180_000);

  afterAll(async () => { await pool?.end(); });

  beforeEach(() => {
    inventory = new InventoryService(pool);
    equipment = new EquipmentService(pool, { inventory });
  });

  async function player(atlasPass: boolean, materials = true): Promise<string> {
    const accountId = randomUUID();
    const playerId = `gear-${randomUUID().slice(0, 8)}`;
    await pool.query("INSERT INTO accounts (id) VALUES ($1)", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1, $2, $3, '#38bdf8', 'NM', 35, -106, 35, -106, 900, false,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326))`,
      [playerId, accountId, `U${playerId.slice(-8)}`]
    );
    await pool.query("INSERT INTO player_progression_profiles (player_id) VALUES ($1)", [playerId]);
    if (atlasPass) {
      await pool.query(
        `INSERT INTO premium_subscriptions (account_id, platform, original_transaction_id, sku, environment, status, current_period_end)
         VALUES ($1, 'web', $2, 'atlas_pass_monthly', 'sandbox', 'active', now() + interval '20 days')`,
        [accountId, `sub-${accountId}`]
      );
    }
    if (materials) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `seed:${playerId}`, playerId, source: "test", sourceEntityType: "test", sourceEntityId: playerId,
          grants: [
            { itemId: "leather", variant: null, quantity: 30 },
            { itemId: "cloth", variant: null, quantity: 40 }
          ]
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      // Lumen only enters through purchase and admin grant paths.
      const lumen = await pool.connect();
      try {
        await lumen.query("BEGIN");
        await inventory.grantItemsForOperationInTransaction(lumen, {
          operationKey: `seed-lumen:${playerId}`, playerId, source: "lumen_admin_grant", sourceEntityType: "test", sourceEntityId: playerId,
          grants: [{ itemId: "lumen", variant: null, quantity: 100 }]
        });
        await lumen.query("COMMIT");
      } catch (error) {
        await lumen.query("ROLLBACK");
        throw error;
      } finally {
        lumen.release();
      }
    }
    await equipment.ensureStarterLoadout(playerId);
    return playerId;
  }

  async function held(playerId: string, itemId: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT COALESCE(sum(quantity),0) AS quantity FROM player_inventory WHERE player_id=$1 AND resource_type=$2",
      [playerId, itemId]
    );
    return Number(result.rows[0]!.quantity);
  }

  async function wear(instanceId: string): Promise<void> {
    await pool.query(
      "UPDATE equipment_instances SET location='equipped', equipped_slot='gloves' WHERE instance_id=$1",
      [instanceId]
    );
  }

  async function spend(playerId: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const spent = await spendUtilityGearUseInTransaction(client, playerId, "lumber_glove");
      await client.query("COMMIT");
      return spent;
    } finally {
      client.release();
    }
  }

  it("lets an Atlas Pass member craft, charging once on a replayed request", async () => {
    const playerId = await player(true);
    const requestId = randomUUID();
    const first = await equipment.craftUtilityGear(playerId, requestId, "lumber_glove");
    expect(first.replayed).toBe(false);
    const again = await equipment.craftUtilityGear(playerId, requestId, "lumber_glove");
    expect(again.replayed).toBe(true);
    expect(again.instanceId).toBe(first.instanceId);
    expect(await held(playerId, "lumen")).toBe(88);
    expect(await held(playerId, "leather")).toBe(26);
    expect(await held(playerId, "cloth")).toBe(37);
    const rows = await pool.query<{ uses_remaining: number }>(
      "SELECT uses_remaining FROM equipment_instances WHERE owner_player_id=$1 AND definition_id='lumber_glove'",
      [playerId]
    );
    expect(rows.rows).toEqual([{ uses_remaining: 120 }]);
    const shown = first.equipment.instances.find((item) => item.instanceId === first.instanceId);
    expect(shown?.usesRemaining).toBe(120);
  });

  it("denies crafting without an Atlas Pass and leaves the materials alone", async () => {
    const playerId = await player(false);
    await expect(equipment.craftUtilityGear(playerId, randomUUID(), "delver_glove"))
      .rejects.toMatchObject({ code: "UTILITY_GEAR_PASS_REQUIRED" });
    expect(await held(playerId, "lumen")).toBe(100);
  });

  it("refuses to craft with short materials", async () => {
    const playerId = await player(true, false);
    await expect(equipment.craftUtilityGear(playerId, randomUUID(), "artisan_glove")).rejects.toBeTruthy();
  });

  it("only puts utility gear on or takes it off at home", async () => {
    const playerId = await player(true);
    const crafted = await equipment.craftUtilityGear(playerId, randomUUID(), "delver_glove");
    await expect(equipment.equip(playerId, crafted.instanceId, "gloves", randomUUID()))
      .rejects.toMatchObject({ code: "EQUIPMENT_UTILITY_AT_HOME_ONLY" });
  });

  it("counts uses down to 0, destroys the glove and equips the next one", async () => {
    const playerId = await player(true);
    const first = await equipment.craftUtilityGear(playerId, randomUUID(), "lumber_glove");
    const second = await equipment.craftUtilityGear(playerId, randomUUID(), "lumber_glove");
    await wear(first.instanceId);
    await pool.query("UPDATE equipment_instances SET uses_remaining=2 WHERE instance_id=$1", [first.instanceId]);

    expect(await spend(playerId)).toMatchObject({ remaining: 1, destroyed: false });
    const last = await spend(playerId);
    expect(last).toMatchObject({ remaining: 0, destroyed: true, replacementInstanceId: second.instanceId });

    const rows = await pool.query<{ instance_id: string; location: string; equipped_slot: string | null; uses_remaining: number }>(
      "SELECT instance_id::text, location, equipped_slot, uses_remaining FROM equipment_instances WHERE owner_player_id=$1 AND definition_id='lumber_glove'",
      [playerId]
    );
    const byId = new Map(rows.rows.map((row) => [row.instance_id, row]));
    expect(byId.get(first.instanceId)).toMatchObject({ location: "destroyed", uses_remaining: 0, equipped_slot: null });
    expect(byId.get(second.instanceId)).toMatchObject({ location: "equipped", equipped_slot: "gloves", uses_remaining: 120 });
    // A destroyed glove can never be spent again.
    expect(await spend(playerId)).toMatchObject({ remaining: 119 });
  });

  it("only counts a glove as ready for a 1-second action when it is worn with a use left", async () => {
    const playerId = await player(true);
    const glove = await equipment.craftUtilityGear(playerId, randomUUID(), "lumber_glove");
    expect(await wornUtilityGearReady(pool, playerId, "lumber_glove")).toBe(false);
    await wear(glove.instanceId);
    expect(await wornUtilityGearReady(pool, playerId, "lumber_glove")).toBe(true);
    expect(await wornUtilityGearReady(pool, playerId, "delver_glove")).toBe(false);
    await pool.query("UPDATE equipment_instances SET uses_remaining=0 WHERE instance_id=$1", [glove.instanceId]);
    expect(await wornUtilityGearReady(pool, playerId, "lumber_glove")).toBe(false);
    expect(await spend(playerId)).toBeNull();
  });

  it("stops at 0 and does not go negative with nothing left to equip", async () => {
    const playerId = await player(true);
    const only = await equipment.craftUtilityGear(playerId, randomUUID(), "lumber_glove");
    await wear(only.instanceId);
    await pool.query("UPDATE equipment_instances SET uses_remaining=1 WHERE instance_id=$1", [only.instanceId]);
    expect(await spend(playerId)).toMatchObject({ remaining: 0, destroyed: true, replacementInstanceId: null });
    expect(await spend(playerId)).toBeNull();
  });
  async function insertInstance(
    playerId: string,
    definitionId: string,
    location: "equipped" | "world_drop",
    options: { slot?: string; uses?: number | null; level?: number; enchantment?: string | null } = {}
  ): Promise<string> {
    const instanceId = randomUUID();
    const operationKey = `seed-instance:${instanceId}`;
    await pool.query(
      "INSERT INTO equipment_operations (operation_key, player_id, action, instance_id, completed_at) VALUES ($1,$2,'package_grant',NULL,now())",
      [operationKey, playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (instance_id, definition_id, owner_player_id, location, equipped_slot,
         created_by_operation_key, item_level, enchantment_identity, uses_remaining)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [instanceId, definitionId, playerId, location, options.slot ?? null, operationKey,
        options.level ?? 0, options.enchantment ?? null, options.uses ?? null]
    );
    return instanceId;
  }

  async function dropOnGround(playerId: string, definitionId: string, options: { level?: number; enchantment?: string | null } = {}): Promise<string> {
    const instanceId = await insertInstance(playerId, definitionId, "world_drop", options);
    const dropId = randomUUID();
    await pool.query(
      "INSERT INTO equipment_operations (operation_key, player_id, action, instance_id, completed_at) VALUES ($1,$2,'ground_drop',$3,now())",
      [`seed-drop:${dropId}`, playerId, instanceId]
    );
    await pool.query(
      `INSERT INTO world_equipment_drops (id, operation_key, equipment_instance_id, item_id, dropped_by, region_code, zone_id,
         pile_id, status, lat, lon, geom, expires_at)
       VALUES ($1,$2,$3,$4,$5,'NM','NM',$6,'active',35,-106, ST_SetSRID(ST_MakePoint(-106, 35), 4326), now() + interval '1 hour')`,
      [dropId, `seed-drop:${dropId}`, instanceId, definitionId, playerId, `pile:${dropId}`]
    );
    return instanceId;
  }

  async function gold(playerId: string): Promise<bigint> {
    const account = await pool.query<{ account_id: string }>("SELECT account_id FROM players WHERE id=$1", [playerId]);
    return BigInt((await new WalletService(pool).snapshot(playerId, account.rows[0]!.account_id)).gold);
  }

  function atDrop(playerId: string): PlayerRecord {
    return { playerId, regionCode: "NM", position: { lat: 35, lon: -106 }, online: true } as unknown as PlayerRecord;
  }

  it("dumps a plain ground item once for its dump gold even when claimed twice concurrently", async () => {
    const playerId = await player(true, false);
    await pool.query("UPDATE world_equipment_drops SET status='expired', expired_at=now() WHERE status='active'");
    const boot = await insertInstance(playerId, "lodestone_boot", "equipped", { slot: "boots", uses: 400 });
    const plain = await dropOnGround(playerId, "training_heavy_gloves");
    const enchanted = await dropOnGround(playerId, "training_heavy_boots", { enchantment: "metal:iron" });
    const upgraded = await dropOnGround(playerId, "training_heavy_helm", { level: 2 });
    const service = new UtilityGearProximityService({
      pool,
      wallet: new WalletService(pool),
      hooks: { afterUse: async () => undefined },
      onlineWorldPlayers: () => []
    });
    const results = await Promise.all([service.lodestoneSweep(atDrop(playerId)), service.lodestoneSweep(atDrop(playerId))]);
    expect(results[0]! + results[1]!).toBe(1);
    expect(await gold(playerId)).toBe(25n);
    const rows = await pool.query<{ instance_id: string; location: string; uses_remaining: number | null }>(
      "SELECT instance_id::text, location, uses_remaining FROM equipment_instances WHERE instance_id = ANY($1::uuid[])",
      [[boot, plain, enchanted, upgraded]]
    );
    const byId = new Map(rows.rows.map((row) => [row.instance_id, row]));
    expect(byId.get(plain)?.location).toBe("destroyed");
    expect(byId.get(enchanted)?.location).toBe("world_drop");
    expect(byId.get(upgraded)?.location).toBe("world_drop");
    expect(byId.get(boot)?.uses_remaining).toBe(399);
    // A third pass finds nothing left to take.
    expect(await service.lodestoneSweep(atDrop(playerId))).toBe(0);
    expect(await gold(playerId)).toBe(25n);
  });
  async function giveGold(playerId: string, amount: bigint): Promise<void> {
    const account = await pool.query<{ account_id: string }>("SELECT account_id FROM players WHERE id=$1", [playerId]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await new WalletService(pool).creditForOperationInTransaction(client, {
        playerId, accountId: account.rows[0]!.account_id, amount, operationKey: `seed-gold:${playerId}`, reason: "test"
      });
      await client.query("COMMIT");
    } finally { client.release(); }
  }

  it("denies a Lumen item to non-members, including the Lodestone Boot", async () => {
    const playerId = await player(false);
    await expect(equipment.craftUtilityGear(playerId, randomUUID(), "lodestone_boot"))
      .rejects.toMatchObject({ code: "UTILITY_GEAR_PASS_REQUIRED" });
  });

  it("crafts the Coinwright Glove for a non-member with Leatherworking 3 and 290 gold, charging once", async () => {
    const playerId = await player(false);
    const accountId = (await pool.query<{ account_id: string }>("SELECT account_id FROM players WHERE id=$1", [playerId])).rows[0]!.account_id;
    await giveGold(playerId, 300n);
    await expect(equipment.craftUtilityGear(playerId, randomUUID(), "coinwright_glove", accountId))
      .rejects.toMatchObject({ code: "EQUIPMENT_CRAFT_SKILL_REQUIRED" });
    await pool.query("INSERT INTO player_skill_ranks (player_id, skill_id, rank) VALUES ($1,'leatherworking',3)", [playerId]);
    const requestId = randomUUID();
    const first = await equipment.craftUtilityGear(playerId, requestId, "coinwright_glove", accountId);
    const again = await equipment.craftUtilityGear(playerId, requestId, "coinwright_glove", accountId);
    expect(again.replayed).toBe(true);
    expect(await gold(playerId)).toBe(10n);
    expect(await held(playerId, "lumen")).toBe(100);
    expect(first.equipment.instances.find((item) => item.instanceId === first.instanceId)?.usesRemaining).toBe(90);
  });

  it("adds 22% rounded down per item and one wear per dump", async () => {
    expect([4, 25, 150].map(coinwrightBonusGold)).toEqual([0, 5, 33]);
    const playerId = await player(true, false);
    await pool.query("UPDATE world_equipment_drops SET status='expired', expired_at=now() WHERE status='active'");
    await insertInstance(playerId, "lodestone_boot", "equipped", { slot: "boots", uses: 400 });
    const glove = await insertInstance(playerId, "coinwright_glove", "equipped", { slot: "gloves", uses: 100 });
    await dropOnGround(playerId, "training_heavy_gloves");
    const service = new UtilityGearProximityService({
      pool, wallet: new WalletService(pool), hooks: { afterUse: async () => undefined }, onlineWorldPlayers: () => []
    });
    expect(await service.lodestoneSweep(atDrop(playerId))).toBe(1);
    expect(await gold(playerId)).toBe(30n);
    const row = await pool.query<{ uses_remaining: number }>("SELECT uses_remaining FROM equipment_instances WHERE instance_id=$1", [glove]);
    expect(row.rows[0]!.uses_remaining).toBe(99);
  });
  it("charges the Tiller pool 12 per planted sapling and 1 per own-sapling tend", async () => {
    const playerId = await player(true, false);
    const boot = await insertInstance(playerId, "tiller_boot", "equipped", { slot: "boots", uses: 2000 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `seed-saplings:${playerId}`, playerId, source: "test", sourceEntityType: "test", sourceEntityId: playerId,
        grants: [{ itemId: "giving_tree_sapling", variant: "default", quantity: 3 }]
      });
      await client.query("COMMIT");
    } finally { client.release(); }
    const saplings = new GivingSaplingService(pool, inventory, {
      terrainAt: async () => "land",
      territoryOwnerAt: async () => null
    });
    saplings.setTillerBoot({
      spendUses: async (tx, id, count) => (await spendUtilityGearUseInTransaction(tx, id, "tiller_boot", count)) !== null,
      afterUse: async () => undefined
    });
    const grid = await saplings.plantGrid({
      playerId, requestId: randomUUID(), regionCode: "NM", position: { lat: 35, lon: -106 }, aggressive: false, worldPresent: true
    });
    expect(grid.planted).toBe(3);
    expect(await held(playerId, "giving_tree_sapling")).toBe(0);
    const uses = async () => (await pool.query<{ uses_remaining: number }>("SELECT uses_remaining FROM equipment_instances WHERE instance_id=$1", [boot])).rows[0]!.uses_remaining;
    expect(await uses()).toBe(1964);

    const own = await pool.query<{ id: string; lat: number; lon: number }>("SELECT id::text, lat, lon FROM player_saplings WHERE owner_player_id=$1 ORDER BY id LIMIT 1", [playerId]);
    const row = own.rows[0]!;
    await pool.query("UPDATE player_saplings SET last_tended_at = now() - interval '30 hours', death_at = now() + interval '18 hours' WHERE id=$1", [row.id]);
    const at = { lat: row.lat, lon: row.lon };
    expect(await saplings.autoTend({ playerId, saplingId: row.id, position: at, groveLoreRank: 0 })).toBe(true);
    expect(await uses()).toBe(1963);
    // Tended just now: a second pass is too soon and costs nothing.
    expect(await saplings.autoTend({ playerId, saplingId: row.id, position: at, groveLoreRank: 0 })).toBe(false);
    expect(await uses()).toBe(1963);
  });

  describe("Pathfinder Boot", () => {
    async function publicFlag(ownerId: string, _lon: number): Promise<string> {
      // Fresh spot per call: claims may not overlap, and earlier runs leave flags behind.
      const lon = -95 + Math.random() * 10;
      const flagId = randomUUID();
      await pool.query(
        `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom,access_mode)
         VALUES ($1,$2,$3,35,$4,50,ST_SetSRID(ST_MakePoint($4,35),4326),'public')`,
        [flagId, ownerId, `Marked ${flagId.slice(0, 6)}`, lon]
      );
      return flagId;
    }
    function services(clock: { now: Date }) {
      const access = new FlagAccessService(pool);
      const marks = new PathfinderMarkService(
        pool, access, async () => [], async () => undefined, () => clock.now
      );
      const worldMap = new WorldMapService(pool, { WORLD_ID: "test" }, {
        now: () => clock.now,
        pathfinderMarkTravelAllowed: async (playerId, flagId) => {
          const authorization = await access.authorize(flagId, playerId);
          return authorization.decision.allowed && authorization.decision.tollGold === "0";
        }
      });
      return { marks, worldMap };
    }
    const usesOf = async (instanceId: string) =>
      (await pool.query<{ uses_remaining: number }>("SELECT uses_remaining FROM equipment_instances WHERE instance_id=$1", [instanceId])).rows[0]!.uses_remaining;

    it("denies the craft to non-members and crafts it for members, 130 uses", async () => {
      const outsider = await player(false);
      await expect(equipment.craftUtilityGear(outsider, randomUUID(), "pathfinder_boot"))
        .rejects.toMatchObject({ code: "UTILITY_GEAR_PASS_REQUIRED" });
      const member = await player(true);
      const seed = await pool.connect();
      try {
        await seed.query("BEGIN");
        await inventory.grantItemsForOperationInTransaction(seed, {
          operationKey: `seed-balsam:${member}`, playerId: member, source: "test", sourceEntityType: "test", sourceEntityId: member,
          grants: [{ itemId: "balsam_resin", variant: null, quantity: 2 }]
        });
        await seed.query("COMMIT");
      } finally { seed.release(); }
      const crafted = await equipment.craftUtilityGear(member, randomUUID(), "pathfinder_boot");
      expect(await usesOf(crafted.instanceId)).toBe(130);
      expect(await held(member, "lumen")).toBe(94);
    });

    it("marks a visitable building for 31 hours, replaces it with a new mark and charges replays once", async () => {
      const owner = await player(false, false);
      const traveller = await player(false);
      const boot = await insertInstance(traveller, "pathfinder_boot", "equipped", { slot: "boots", uses: 100 });
      const clock = { now: new Date("2026-10-05T00:00:00Z") };
      const { marks, worldMap } = services(clock);
      const first = await publicFlag(owner, -105.9);
      const second = await publicFlag(owner, -105.8);

      const requestId = randomUUID();
      const result = await marks.mark(traveller, requestId, first);
      expect(result.replayed).toBe(false);
      expect((await marks.mark(traveller, requestId, first)).replayed).toBe(true);
      expect(await usesOf(boot)).toBe(99);

      const listed = async () => (await worldMap.snapshot(traveller)).destinations.filter((d) => d.kind === "pathfinder_mark");
      expect((await listed()).map((d) => d.id)).toEqual([first]);
      expect((await worldMap.getOwnedAtlasShrine(traveller, first))?.id).toBe(first);

      await marks.mark(traveller, randomUUID(), second);
      expect((await listed()).map((d) => d.id)).toEqual([second]);
      expect(await worldMap.getOwnedAtlasShrine(traveller, first)).toBeNull();
      expect(await usesOf(boot)).toBe(98);

      clock.now = new Date(clock.now.getTime() + 31 * 3_600_000 - 1000);
      expect((await worldMap.getOwnedAtlasShrine(traveller, second))?.id).toBe(second);
      clock.now = new Date(clock.now.getTime() + 2000);
      expect(await listed()).toEqual([]);
      expect(await worldMap.getOwnedAtlasShrine(traveller, second)).toBeNull();
    });

    it("refuses travel to a mark once its owner adds a toll or bans the traveller", async () => {
      const owner = await player(false, false);
      const traveller = await player(false);
      await insertInstance(traveller, "pathfinder_boot", "equipped", { slot: "boots", uses: 100 });
      const clock = { now: new Date() };
      const { marks, worldMap } = services(clock);
      const flag = await publicFlag(owner, -105.6);
      await marks.mark(traveller, randomUUID(), flag);
      expect((await worldMap.getOwnedAtlasShrine(traveller, flag))?.id).toBe(flag);

      await pool.query("UPDATE flags SET jump_toll_gold = 25 WHERE id = $1", [flag]);
      expect(await worldMap.getOwnedAtlasShrine(traveller, flag)).toBeNull();

      await pool.query("UPDATE flags SET jump_toll_gold = 0, access_mode = 'private' WHERE id = $1", [flag]);
      expect(await worldMap.getOwnedAtlasShrine(traveller, flag)).toBeNull();
    });

    it("refuses an own building and a mark without a worn boot", async () => {
      const owner = await player(false);
      const clock = { now: new Date() };
      const { marks } = services(clock);
      const flag = await publicFlag(owner, -105.7);
      await insertInstance(owner, "pathfinder_boot", "equipped", { slot: "boots", uses: 100 });
      await expect(marks.mark(owner, randomUUID(), flag)).rejects.toMatchObject({ code: "PATHFINDER_MARK_ALREADY_DESTINATION" });
      const bare = await player(false);
      await expect(marks.mark(bare, randomUUID(), flag)).rejects.toMatchObject({ code: "PATHFINDER_MARK_NO_BOOT" });
    });
  });
});

function safeDisposableDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new URL(value);
  if (parsed.hostname !== "127.0.0.1" || parsed.port === "35432" || !parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("TEST_DATABASE_URL must target a local ash_atlas_stability database outside the retained port");
  }
  return parsed.toString();
}
