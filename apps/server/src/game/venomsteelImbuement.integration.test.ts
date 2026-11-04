import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { AchievementService } from "./achievements.js";
import { EquipmentService } from "./equipment.js";
import { InventoryService } from "./inventory.js";
import { JewelStationService } from "./jewelStation.js";

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Venomsteel durable authority", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let equipment: EquipmentService;
  let achievements: AchievementService;
  let jewelStation: JewelStationService;
  let instanceId: string;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
    inventory = new InventoryService(pool);
    equipment = new EquipmentService(pool);
    achievements = new AchievementService(pool, () => Date.UTC(2026, 0, 1));
    jewelStation = new JewelStationService(pool, inventory, equipment, achievements);
  }, 60_000);

  beforeEach(async () => {
    await achievements?.flushAndRelease("venom-player");
    await pool.query("TRUNCATE players CASCADE");
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES (
         'venom-player','Ash','world-test',35,-106,35,-106,
         2000,true,ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`
    );
    await pool.query(
      `INSERT INTO player_progression_profiles (player_id,level)
       VALUES ('venom-player',0)`
    );
    await pool.query(
      `INSERT INTO player_equipment_state (player_id)
       VALUES ('venom-player')`
    );
    const creationKey = `venom-equipment:${randomUUID()}`;
    instanceId = randomUUID();
    await pool.query(
      `INSERT INTO equipment_operations (operation_key,player_id,action,completed_at)
       VALUES ($1,'venom-player','starter_loadout',now())`,
      [creationKey]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,equipped_slot,
         inventory_slot_index,item_level,balance_version,created_by_operation_key
       ) VALUES ($1,'double_axe','venom-player','inventory',NULL,NULL,0,1,$2)`,
      [instanceId, creationKey]
    );
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("aggregates concurrent poison damage and unlocks Bitter Blood once", async () => {
    await achievements.recordPoisonDamage("venom-player", 249);
    expect(await achievements.snapshot("venom-player")).toMatchObject({
      achievements: [{ value: 249, completed: false }]
    });
    await expect(pool.query(
      `SELECT value::int FROM player_stats
       WHERE player_id='venom-player' AND stat_key='poison_damage_taken'`
    )).resolves.toMatchObject({ rows: [] });

    const crossing = await Promise.all(
      Array.from({ length: 5 }, () =>
        achievements.recordPoisonDamage("venom-player", 1))
    );
    expect(crossing.filter((result) => result.newlyUnlocked)).toHaveLength(1);
    expect(await achievements.snapshot("venom-player")).toMatchObject({
      achievements: [{ value: 254, completed: true }]
    });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM player_achievements
       WHERE player_id='venom-player' AND achievement_id='bitter_blood'`
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("checkpoints accumulated poison progress and restores it on reconnect", async () => {
    await achievements.connectRuntime("venom-player");
    await achievements.recordPoisonDamage("venom-player", 184);
    await achievements.flushAndRelease("venom-player");

    await expect(achievements.connectRuntime("venom-player")).resolves.toMatchObject({
      achievements: [{ value: 184, completed: false }]
    });
  });

  it("drains fire-and-forget poison progress before releasing the runtime", async () => {
    await achievements.connectRuntime("venom-player");
    const recording = achievements.recordPoisonDamage("venom-player", 184);
    await achievements.flushAndRelease("venom-player");
    await recording;

    await expect(achievements.connectRuntime("venom-player")).resolves.toMatchObject({
      achievements: [{ value: 184, completed: false }]
    });
  });

  it("does not grant unlock authority until the achievement transaction commits", async () => {
    let failNextConnect = true;
    const retryingPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        if (failNextConnect) {
          failNextConnect = false;
          throw new Error("injected achievement persistence failure");
        }
        return pool.connect();
      }
    } as unknown as pg.Pool;
    const retryingAchievements = new AchievementService(
      retryingPool,
      () => Date.UTC(2026, 0, 1)
    );
    await retryingAchievements.connectRuntime("venom-player");

    await expect(retryingAchievements.recordPoisonDamage("venom-player", 250))
      .rejects.toThrow("injected achievement persistence failure");
    expect(retryingAchievements.achievementIds("venom-player")).not
      .toContain("bitter_blood");
    await expect(retryingAchievements.snapshot("venom-player")).resolves.toMatchObject({
      achievements: [{ value: 250, completed: false, completedAt: null }]
    });
    await expect(pool.query(
      `SELECT 1 FROM player_achievements
       WHERE player_id='venom-player' AND achievement_id='bitter_blood'`
    )).resolves.toMatchObject({ rows: [] });

    await expect(retryingAchievements.flushPlayer("venom-player")).resolves.toBe(true);
    expect(retryingAchievements.achievementIds("venom-player")).toContain("bitter_blood");
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM player_achievements
       WHERE player_id='venom-player' AND achievement_id='bitter_blood'`
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(retryingAchievements.flushPlayer("venom-player")).resolves.toBe(false);
    await retryingAchievements.flushAndRelease("venom-player");
  });

  it("requires Bitter Blood before consuming a Venomsteel Core", async () => {
    await inventory.grantItemsForOperation({
      operationKey: `venom-materials:${randomUUID()}`,
      playerId: "venom-player",
      source: "venomsteel_test",
      grants: [
        { itemId: "enchantment_stone", variant: "opal", quantity: 1 },
        { itemId: "venomsteel_core", variant: null, quantity: 1 }
      ]
    });

    const prepared = await Promise.all([
      jewelStation.prepare("venom-player", "prepare-once", instanceId, "opal"),
      jewelStation.prepare("venom-player", "prepare-once", instanceId, "opal")
    ]);
    expect(prepared.filter((result) => result.replayed)).toHaveLength(1);
    expect(prepared[0]!.state.inventory.totals.enchantment_stone).toBe(0);

    await expect(jewelStation.imbue(
      "venom-player",
      "imbue-locked",
      instanceId
    )).rejects.toMatchObject({ code: "JEWEL_ACHIEVEMENT_REQUIRED" });
    await expect(jewelStation.state("venom-player")).resolves.toMatchObject({
      equipment: {
        instances: expect.arrayContaining([expect.objectContaining({
          instanceId,
          enchantmentIdentity: "enh:v1:opal:prepared"
        })])
      },
      inventory: { totals: { venomsteel_core: 1 } }
    });

    await achievements.recordPoisonDamage("venom-player", 250);
    const imbued = await Promise.all([
      jewelStation.imbue("venom-player", "imbue-once", instanceId),
      jewelStation.imbue("venom-player", "imbue-once", instanceId)
    ]);
    expect(imbued.filter((result) => result.replayed)).toHaveLength(1);
    expect(imbued[0]!.state.inventory.totals.venomsteel_core).toBe(0);
    await expect(pool.query(
      "SELECT enchantment_identity FROM equipment_instances WHERE instance_id=$1",
      [instanceId]
    )).resolves.toMatchObject({ rows: [{ enchantment_identity: "enh:v1:opal:venomsteel" }] });

    await expect(equipment.equip("venom-player", instanceId, "melee", "equip-unlocked"))
      .resolves.toMatchObject({ applied: true, equipment: { instances: expect.any(Array) } });
  });

  it("prepares an unequipped starter Sword", async () => {
    await pool.query(
      "UPDATE equipment_instances SET definition_id='starter_sword' WHERE instance_id=$1",
      [instanceId]
    );
    await inventory.grantItemsForOperation({
      operationKey: `starter-sword-materials:${randomUUID()}`,
      playerId: "venom-player",
      source: "starter_sword_jewel_test",
      grants: [{ itemId: "enchantment_stone", variant: "diamond", quantity: 1 }]
    });

    await expect(jewelStation.prepare(
      "venom-player",
      "prepare-starter-sword",
      instanceId,
      "diamond"
    )).resolves.toMatchObject({
      replayed: false,
      state: {
        equipment: {
          instances: expect.arrayContaining([
            expect.objectContaining({
              instanceId,
              definitionId: "starter_sword",
              enchantmentIdentity: "enh:v1:diamond:prepared"
            })
          ])
        }
      }
    });
  });

  it("replays pre-metal-hash Jewel Station operations after deployment", async () => {
    await pool.query(
      "UPDATE equipment_instances SET enchantment_identity='enh:v1:diamond:prepared' WHERE instance_id=$1",
      [instanceId]
    );
    await pool.query(
      `INSERT INTO equipment_operations (
         operation_key,player_id,action,instance_id,request_hash,result,completed_at
       ) VALUES ($1,'venom-player','prepare',$2,$3,'{}'::jsonb,now())`,
      [
        "equipment:venom-player:legacy-prepare",
        instanceId,
        legacyJewelRequestHash("venom-player", "prepare", instanceId, "diamond")
      ]
    );

    await expect(jewelStation.prepare(
      "venom-player",
      "legacy-prepare",
      instanceId,
      "diamond"
    )).resolves.toMatchObject({ replayed: true, gemstone: "diamond" });

    await pool.query(
      "UPDATE equipment_instances SET enchantment_identity='enh:v1:diamond:venomsteel' WHERE instance_id=$1",
      [instanceId]
    );
    await pool.query(
      `INSERT INTO equipment_operations (
         operation_key,player_id,action,instance_id,request_hash,result,completed_at
       ) VALUES ($1,'venom-player','imbue',$2,$3,'{}'::jsonb,now())`,
      [
        "equipment:venom-player:legacy-imbue",
        instanceId,
        legacyJewelRequestHash("venom-player", "imbue", instanceId, null)
      ]
    );

    await expect(jewelStation.imbue(
      "venom-player",
      "legacy-imbue",
      instanceId
    )).resolves.toMatchObject({ replayed: true, gemstone: "diamond", metal: "venomsteel" });
  });

  it("supports armor while rejecting non-armor accessories before consuming materials", async () => {
    await achievements.recordPoisonDamage("venom-player", 250);
    const armorInstanceId = randomUUID();
    const ringInstanceId = randomUUID();
    for (const [candidateId, definitionId] of [
      [armorInstanceId, "chain_armor"],
      [ringInstanceId, "training_ring"]
    ] as const) {
      const creationKey = `venom-equipment:${randomUUID()}`;
      await pool.query(
        `INSERT INTO equipment_operations (operation_key,player_id,action,completed_at)
         VALUES ($1,'venom-player','starter_loadout',now())`,
        [creationKey]
      );
      await pool.query(
        `INSERT INTO equipment_instances (
           instance_id,definition_id,owner_player_id,location,equipped_slot,
           inventory_slot_index,item_level,balance_version,created_by_operation_key
         ) VALUES ($1,$2,'venom-player','inventory',NULL,NULL,0,1,$3)`,
        [candidateId, definitionId, creationKey]
      );
    }
    await inventory.grantItemsForOperation({
      operationKey: `venom-armor-materials:${randomUUID()}`,
      playerId: "venom-player",
      source: "venomsteel_test",
      grants: [
        { itemId: "enchantment_stone", variant: "opal", quantity: 1 },
        { itemId: "enchantment_stone", variant: "ruby", quantity: 1 },
        { itemId: "venomsteel_core", variant: null, quantity: 1 }
      ]
    });

    await jewelStation.prepare("venom-player", "prepare-armor", armorInstanceId, "opal");
    await jewelStation.imbue("venom-player", "imbue-armor", armorInstanceId);
    await expect(pool.query(
      "SELECT enchantment_identity FROM equipment_instances WHERE instance_id=$1",
      [armorInstanceId]
    )).resolves.toMatchObject({ rows: [{ enchantment_identity: "enh:v1:opal:venomsteel" }] });

    await expect(jewelStation.prepare(
      "venom-player",
      "reject-ring",
      ringInstanceId,
      "ruby"
    )).rejects.toMatchObject({ code: "EQUIPMENT_NOT_ELIGIBLE" });
    await expect(jewelStation.state("venom-player")).resolves.toMatchObject({
      inventory: {
        items: expect.arrayContaining([expect.objectContaining({
          resourceType: "enchantment_stone",
          variant: "ruby",
          quantity: 1
        })])
      }
    });
  });

  it("serializes Jewel preparation with inventory movement without deadlocking", async () => {
    await inventory.grantItemsForOperation({
      operationKey: `venom-lock-order:${randomUUID()}`,
      playerId: "venom-player",
      source: "venomsteel_test",
      grants: [{ itemId: "enchantment_stone", variant: "opal", quantity: 1 }]
    });

    const [prepared, moved] = await Promise.all([
      jewelStation.prepare("venom-player", "prepare-with-move", instanceId, "opal"),
      inventory.moveStack("venom-player", "move-during-prepare", instanceId, 2)
    ]);

    expect(prepared.state.equipment.instances.find(
      ({ instanceId: candidate }) => candidate === instanceId
    )?.enchantmentIdentity).toBe("enh:v1:opal:prepared");
    expect(moved.playerId).toBe("venom-player");
  });
});

function legacyJewelRequestHash(
  playerId: string,
  action: "prepare" | "imbue",
  instanceId: string,
  gemstone: "diamond" | null
): string {
  return createHash("sha256")
    .update(JSON.stringify([playerId, action, instanceId, gemstone]))
    .digest("hex");
}
