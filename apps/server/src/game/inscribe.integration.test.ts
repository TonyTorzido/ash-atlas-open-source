import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { AchievementService } from "./achievements.js";
import { EquipmentService } from "./equipment.js";
import { InscriptionStatsRecorder } from "./inscriptionStats.js";
import { InventoryService } from "./inventory.js";
import { JewelStationService } from "./jewelStation.js";

const databaseUrl = safeDisposableDatabaseUrl(process.env.TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("inscribe PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let equipment: EquipmentService;
  let jewel: JewelStationService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await runMigrations(databaseUrl!);
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
    inventory = new InventoryService(pool);
    equipment = new EquipmentService(pool, { inventory });
    jewel = new JewelStationService(pool, inventory, equipment, new AchievementService(pool));
  }, 180_000);

  afterAll(async () => { await pool?.end(); });

  async function player(lumen = 420): Promise<string> {
    const accountId = randomUUID();
    const playerId = `ins-${randomUUID().slice(0, 8)}`;
    const manorId = randomUUID();
    await pool.query("INSERT INTO accounts (id) VALUES ($1)", [accountId]);
    await pool.query(
      `INSERT INTO players (id, account_id, username, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom)
       VALUES ($1,$2,$3,'#38bdf8','NM',35,-106,35,-106,900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId, `U${playerId.slice(-8)}`]
    );
    await pool.query("INSERT INTO player_progression_profiles (player_id) VALUES ($1)", [playerId]);
    await pool.query(
      `INSERT INTO player_manors (id,owner_player_id,world_region_code,world_lat,world_lon,built_at,geom)
       VALUES ($1,$2,'NM',35,-106,clock_timestamp(),ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [manorId, playerId]
    );
    await pool.query(
      "UPDATE players SET location_kind='interior', location_type='manor', location_id=$2 WHERE id=$1",
      [playerId, manorId]
    );
    await equipment.ensureStarterLoadout(playerId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `seed-lumen:${playerId}`, playerId, source: "lumen_admin_grant",
        sourceEntityType: "test", sourceEntityId: playerId,
        grants: [{ itemId: "lumen", variant: null, quantity: lumen }]
      });
      await client.query("COMMIT");
    } finally { client.release(); }
    return playerId;
  }

  async function weapon(playerId: string, level: number): Promise<string> {
    const instanceId = randomUUID();
    const operationKey = `seed-instance:${instanceId}`;
    await pool.query(
      "INSERT INTO equipment_operations (operation_key, player_id, action, instance_id, completed_at) VALUES ($1,$2,'package_grant',NULL,now())",
      [operationKey, playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (instance_id, definition_id, owner_player_id, location, equipped_slot,
         created_by_operation_key, item_level) VALUES ($1,'double_axe',$2,'inventory',NULL,$3,$4)`,
      [instanceId, playerId, operationKey, level]
    );
    return instanceId;
  }

  async function lumen(playerId: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT COALESCE(sum(quantity),0) AS quantity FROM player_inventory WHERE player_id=$1 AND resource_type='lumen'",
      [playerId]
    );
    return Number(result.rows[0]!.quantity);
  }

  const uniqueName = (): string => `Blade ${randomUUID().slice(0, 8)}`;

  it("refuses an item below +18 and charges nothing", async () => {
    const playerId = await player();
    const low = await weapon(playerId, 17);
    await expect(jewel.inscribe(playerId, randomUUID(), low, uniqueName()))
      .rejects.toMatchObject({ code: "INSCRIPTION_LEVEL_TOO_LOW" });
    expect(await lumen(playerId)).toBe(420);
  });

  it("refuses a duplicate name case-insensitively and rolls the Lumen back", async () => {
    const playerId = await player();
    const first = await weapon(playerId, 18);
    const second = await weapon(playerId, 19);
    const name = uniqueName();
    await jewel.inscribe(playerId, randomUUID(), first, name);
    await expect(jewel.inscribe(playerId, randomUUID(), second, name.toUpperCase()))
      .rejects.toMatchObject({ code: "INSCRIPTION_NAME_TAKEN" });
    expect(await lumen(playerId)).toBe(280);
    await expect(jewel.inscribe(playerId, randomUUID(), second, "x!"))
      .rejects.toMatchObject({ code: "INSCRIPTION_NAME_INVALID" });
    await expect(jewel.inscribe(playerId, randomUUID(), second, "Fuck Blade", () => false))
      .rejects.toMatchObject({ code: "INSCRIPTION_NAME_REJECTED" });
  });

  it("charges a replayed request once, and a re-inscription by another owner keeps the stats", async () => {
    const playerId = await player();
    const item = await weapon(playerId, 25);
    const requestId = randomUUID();
    const name = uniqueName();
    const first = await jewel.inscribe(playerId, requestId, item, name);
    const again = await jewel.inscribe(playerId, requestId, item, name);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(await lumen(playerId)).toBe(280);

    const recorder = new InscriptionStatsRecorder(pool);
    recorder.add(item, "totalDamageDealt", 40);
    recorder.add(item, "hits", 2);
    expect(recorder.pendingCount()).toBe(1);
    await recorder.flush();
    expect(recorder.pendingCount()).toBe(0);
    recorder.add(item, "totalDamageDealt", 10);
    recorder.max(item, "highestDamageTaken", 7);
    recorder.max(item, "highestDamageTaken", 3);
    await recorder.flush();

    // Another player buys it and re-inscribes: new name and inscriber, same counters.
    const buyer = await player();
    await pool.query("UPDATE equipment_instances SET owner_player_id=$2 WHERE instance_id=$1", [item, buyer]);
    const renamed = uniqueName();
    await jewel.inscribe(buyer, randomUUID(), item, renamed);
    expect(await lumen(buyer)).toBe(280);
    const row = (await pool.query<{ inscription_name: string; inscribed_by_name: string; inscription_stats: Record<string, number> }>(
      "SELECT inscription_name, inscribed_by_name, inscription_stats FROM equipment_instances WHERE instance_id=$1", [item]
    )).rows[0]!;
    expect(row.inscription_name).toBe(renamed);
    expect(row.inscribed_by_name).toBe(`U${buyer.slice(-8)}`);
    expect(row.inscription_stats).toMatchObject({ totalDamageDealt: 50, hits: 2, highestDamageTaken: 7 });
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
