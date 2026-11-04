import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "./inventory.js";
import { CinderLanternService, cinderLanternDoublesDrops } from "./cinderLanterns.js";
import { WalletService } from "./wallet.js";
import { WanderingMerchantService } from "./wanderingMerchants.js";

const databaseUrl = safeDisposableDatabaseUrl(process.env.SETTLEMENT_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Wandering Merchant and Cinder Lantern PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let wallet: WalletService;
  let merchants: WanderingMerchantService;
  let lanterns: CinderLanternService;
  let clock = 1_800_000_000_000;
  const owner = "merchant-owner";
  const stranger = "merchant-stranger";
  const accountOf: Record<string, string> = { [owner]: randomUUID(), [stranger]: randomUUID() };
  const entrance = { lat: 35.0844, lon: -106.6504 };
  const transaction = async <T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await runMigrations(databaseUrl!);
  }, 120_000);

  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await pool.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [Object.values(accountOf)]);
    for (const playerId of [owner, stranger]) {
      await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountOf[playerId]]);
      await pool.query(
        `INSERT INTO players (
           id,account_id,username,username_normalized,region_code,lat,lon,anchor_lat,anchor_lon,
           move_leash_radius_m,online,geom
         ) VALUES ($1,$2,$1,$1,'NM',$3,$4,$3,$4,900,true,ST_SetSRID(ST_MakePoint($4,$3),4326))`,
        [playerId, accountOf[playerId], entrance.lat, entrance.lon]
      );
      await pool.query(
        `INSERT INTO player_progression_profiles (player_id,level) VALUES ($1,20)
         ON CONFLICT (player_id) DO UPDATE SET level=20`, [playerId]
      );
    }
    inventory = new InventoryService(pool);
    wallet = new WalletService(pool);
    clock = 1_800_000_000_000;
    merchants = new WanderingMerchantService({ pool, wallet, inventory, transaction, now: () => clock });
    lanterns = new CinderLanternService({ pool, inventory, transaction });
    await transaction((client) => wallet.creditForOperationInTransaction(client, {
      playerId: owner, accountId: accountOf[owner]!, amount: 100_000n, operationKey: "seed-gold", reason: "test"
    }));
  });

  async function spawn(spawnKey = "dungeon-complete:run-1"): Promise<string> {
    const id = await merchants.spawn({
      playerId: owner, spawnKey, dungeonId: "fangrock_cavern", dungeonName: "Fangrock Cavern",
      entranceId: "entrance-1", regionCode: "NM", entrance
    });
    expect(id).not.toBeNull();
    return id!;
  }

  const near = (playerId: string) => ({ playerId, position: entrance });

  it("spawns once per completion and only the owner can see or buy", async () => {
    const merchantId = await spawn();
    expect(await merchants.spawn({
      playerId: owner, spawnKey: "dungeon-complete:run-1", dungeonId: "fangrock_cavern", dungeonName: "x",
      entranceId: "entrance-1", regionCode: "NM", entrance
    })).toBeNull();
    expect(await merchants.listActive(owner)).toHaveLength(1);
    expect(await merchants.listActive(stranger)).toHaveLength(0);
    const shop = await merchants.shopFor(near(owner), accountOf[owner]!, merchantId);
    const cases = shop.lines.find((line) => line.itemId === "lamp_sheath")!;
    expect(cases).toMatchObject({ unitPriceGold: "20000", remaining: 3 });
    expect(shop.lines).toHaveLength(4);
    await expect(merchants.shopFor(near(stranger), accountOf[stranger]!, merchantId)).rejects.toMatchObject({ code: "MERCHANT_NOT_FOUND" });
    await expect(merchants.buy(near(stranger), accountOf[stranger]!, {
      requestId: "r1", merchantId, itemId: "lamp_sheath", quantity: 1, expectedUnitPriceGold: "20000"
    })).rejects.toMatchObject({ code: "MERCHANT_NOT_FOUND" });
  });

  it("debits gold and grants once for a replayed request, and caps Lamp Sheaths at 3", async () => {
    const merchantId = await spawn();
    const buy = (requestId: string, quantity: number) => merchants.buy(near(owner), accountOf[owner]!, {
      requestId, merchantId, itemId: "lamp_sheath", quantity, expectedUnitPriceGold: "20000"
    });
    const first = await buy("r1", 1);
    const replay = await buy("r1", 1);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.walletGold).toBe("80000");
    expect(replay.inventory.totals.lamp_sheath).toBe(1);
    const bad = await merchants.buy(near(owner), accountOf[owner]!, {
      requestId: "r2", merchantId, itemId: "lamp_sheath", quantity: 1, expectedUnitPriceGold: "1"
    }).catch((error: unknown) => error);
    expect(bad).toMatchObject({ code: "MERCHANT_PRICE_CHANGED" });
    await buy("r3", 2);
    await expect(buy("r4", 1)).rejects.toMatchObject({ code: "MERCHANT_SOLD_OUT" });
    const gold = await wallet.snapshot(owner, accountOf[owner]!);
    expect(gold.gold).toBe("40000");
  });

  it("denies an expired merchant", async () => {
    const merchantId = await spawn();
    clock += 31 * 60_000;
    await expect(merchants.shopFor(near(owner), accountOf[owner]!, merchantId)).rejects.toMatchObject({ code: "MERCHANT_GONE" });
    await expect(merchants.buy(near(owner), accountOf[owner]!, {
      requestId: "late", merchantId, itemId: "lamp_sheath", quantity: 1, expectedUnitPriceGold: "20000"
    })).rejects.toMatchObject({ code: "MERCHANT_GONE" });
    expect(await merchants.listActive(owner)).toHaveLength(0);
    expect(await merchants.purgeExpired()).toBe(1);
  });

  it("crafts a lantern, spends a charge per run instead of the torch, triples drops, and destroys it at 0", async () => {
    await inventory.grantItemsForOperation({
      operationKey: "seed-craft", playerId: owner, source: "test",
      grants: [
        { itemId: "lamp_sheath", variant: "default", quantity: 1 },
        { itemId: "crystal", variant: "default", quantity: 3400 }
      ]
    });
    const crafted = await lanterns.craft(owner, "craft-1");
    expect(crafted).toMatchObject({ replayed: false, charges: 9 });
    expect((await lanterns.craft(owner, "craft-1")).replayed).toBe(true);
    expect(crafted.inventory.totals.cinder_lantern).toBe(1);
    expect(crafted.inventory.totals.crystal).toBe(0);
    expect(await lanterns.hasCharge(owner)).toBe(true);
    expect(await lanterns.hasCharge(stranger)).toBe(false);

    const enter = async (runId: string) => transaction((client) => lanterns.useChargeForEntryInTransaction(client, owner, runId));
    expect(await enter(randomUUID())).toBe(true);
    const run = randomUUID();
    expect(await enter(run)).toBe(true);
    expect(await enter(run)).toBe(true); // replay of the same run: no extra charge
    expect(await lanterns.charges(owner)).toBe(7);
    expect(await transaction((client) => lanterns.useChargeForEntryInTransaction(client, stranger, randomUUID()))).toBe(false);

    await pool.query("INSERT INTO dungeon_instance_runs (instance_id,run_id) VALUES ('inst-1',$1)", [run]);
    await pool.query(
      `INSERT INTO dungeon_presence (player_id,entrance_id,dungeon_id,instance_id,run_id,session_id,space_id,local_x,local_y,return_region_code,return_lat,return_lon)
       VALUES ($1,'e','fangrock_cavern','inst-1',$2,$3,'room',0,0,'NM',35,-106)`,
      [owner, run, randomUUID()]
    );
    expect(await cinderLanternDoublesDrops(pool, owner)).toBe(true);
    expect(await cinderLanternDoublesDrops(pool, stranger)).toBe(false);
    await pool.query("DELETE FROM dungeon_presence WHERE player_id=$1", [owner]);
    expect(await cinderLanternDoublesDrops(pool, owner)).toBe(false);

    for (let index = 0; index < 7; index += 1) expect(await enter(randomUUID())).toBe(true);
    expect(await lanterns.charges(owner)).toBe(0);
    expect(await lanterns.hasCharge(owner)).toBe(false);
    const left = await pool.query(
      "SELECT quantity FROM player_inventory WHERE player_id=$1 AND resource_type='cinder_lantern'", [owner]
    );
    expect(left.rows.every((row: { quantity: number }) => Number(row.quantity) === 0)).toBe(true);
  });

  it("crafts a Challenger's Lantern for 24 Lumen once, spends one charge per run and flags the run", async () => {
    await inventory.grantItemsForOperation({
      operationKey: "seed-challenger-case", playerId: owner, source: "test",
      grants: [{ itemId: "lamp_sheath", variant: "default", quantity: 2 }]
    });
    await inventory.grantItemsForOperation({
      operationKey: "seed-challenger-lumen", playerId: owner, source: "lumen_admin_grant",
      grants: [{ itemId: "lumen", variant: "default", quantity: 69 }]
    });
    const crafted = await lanterns.craft(owner, "champ-1", "challenger");
    expect(crafted).toMatchObject({ replayed: false, charges: 12 });
    expect(crafted.inventory.totals.challengers_lantern).toBe(1);
    expect(crafted.inventory.totals.lumen).toBe(45);
    expect((await lanterns.craft(owner, "champ-1", "challenger")).replayed).toBe(true);
    expect((await inventory.getInventorySnapshot(owner)).totals.lumen).toBe(45);
    await expect(lanterns.craft(owner, "champ-2", "challenger")).rejects.toMatchObject({ code: "LANTERN_ALREADY_OWNED" });
    expect((await inventory.getInventorySnapshot(owner)).totals.lumen).toBe(45);

    const run = randomUUID();
    const enter = () => transaction((client) => lanterns.useChargeForEntryInTransaction(client, owner, run));
    expect(await enter()).toBe(true);
    expect(await enter()).toBe(true);
    expect(await lanterns.charges(owner, "challenger")).toBe(11);
    expect(lanterns.challengerRunActive(owner, run)).toBe(true);
    expect(lanterns.challengerRunActive(owner, randomUUID())).toBe(false);

    // Carrying both: exactly one lantern pays, the one chosen on the entry request.
    await inventory.grantItemsForOperation({
      operationKey: "seed-both-cinder", playerId: owner, source: "test",
      grants: [
        { itemId: "lamp_sheath", variant: "default", quantity: 1 },
        { itemId: "crystal", variant: "default", quantity: 3400 }
      ]
    });
    await lanterns.craft(owner, "both-cinder");
    await expect(lanterns.chooseEntryLantern(stranger, "challenger")).rejects.toMatchObject({ code: "LANTERN_UNAVAILABLE" });
    const second = randomUUID();
    await lanterns.chooseEntryLantern(owner, "cinder");
    expect(await transaction((client) => lanterns.useChargeForEntryInTransaction(client, owner, second))).toBe(true);
    expect(await lanterns.charges(owner, "cinder")).toBe(8);
    expect(await lanterns.charges(owner, "challenger")).toBe(11);
    expect(lanterns.challengerRunActive(owner, second)).toBe(false);
    const third = randomUUID();
    await lanterns.chooseEntryLantern(owner, "challenger");
    expect(await transaction((client) => lanterns.useChargeForEntryInTransaction(client, owner, third))).toBe(true);
    expect(await lanterns.charges(owner, "challenger")).toBe(10);
    expect(await lanterns.charges(owner, "cinder")).toBe(8);
    expect(lanterns.challengerRunActive(owner, third)).toBe(true);
  });

  it("migration 1011 is idempotent on a second run", async () => {
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
    const defs = await pool.query("SELECT item_id FROM item_definitions WHERE item_id IN ('lamp_sheath','cinder_lantern')");
    expect(defs.rowCount).toBe(2);
  });
});

function safeDisposableDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new URL(value);
  if (parsed.hostname !== "127.0.0.1" || parsed.port === "35432" || !parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("SETTLEMENT_TEST_DATABASE_URL must target a local ash_atlas_stability database outside the retained port");
  }
  return parsed.toString();
}
