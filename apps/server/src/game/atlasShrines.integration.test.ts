import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";

const databaseUrl = validatedDatabaseUrl(process.env.SETTLEMENT_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Atlas Shrine PostgreSQL authority", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let flags: FlagService;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
    inventory = new InventoryService(pool);
    flags = new FlagService(
      pool,
      {} as WorldLookupClient,
      loadConfig({ NODE_ENV: "test" }),
      { info() {}, warn() {} } as unknown as AppLogger,
      inventory
    );
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await createPlayer("owner", 0);
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("unlocks sequential slots atomically, survives replay, and enforces level and the 8 slot cap, grandfathering more", async () => {
    expect(await flags.atlasShrineProgression("owner")).toMatchObject({
      unlockedSlots: 0,
      builtShrines: 0
    });
    await grant("owner", "atlas_shrine_shard", 1);
    await expect(flags.unlockAtlasShrineSlot("owner", randomUUID()))
      .rejects.toMatchObject({ code: "ATLAS_SHRINE_LEVEL_REQUIRED" });
    expect(await quantities("owner")).toMatchObject({ atlas_shrine_shard: 1 });

    await setLevel("owner", 1);
    const requestId = randomUUID();
    const unlocked = await flags.unlockAtlasShrineSlot("owner", requestId);
    expect(unlocked).toMatchObject({
      replayed: false,
      progression: { unlockedSlots: 1, nextSlot: 2 }
    });
    expect(await quantities("owner")).toMatchObject({ atlas_shrine_shard: 0 });
    await expect(flags.unlockAtlasShrineSlot("owner", requestId))
      .resolves.toMatchObject({ replayed: true, progression: { unlockedSlots: 1 } });

    await setLevel("owner", 2);
    await grant("owner", "atlas_shrine_shard", 2);
    const concurrent = await Promise.allSettled([
      flags.unlockAtlasShrineSlot("owner", randomUUID()),
      flags.unlockAtlasShrineSlot("owner", randomUUID())
    ]);
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(await flags.atlasShrineProgression("owner"))
      .toMatchObject({ unlockedSlots: 2, nextSlot: 3 });
    expect(await quantities("owner")).toMatchObject({ atlas_shrine_shard: 0 });

    await setUnlocked("owner", 7);
    await setLevel("owner", 8);
    await grant("owner", "atlas_shrine_shard", 8);
    await expect(flags.unlockAtlasShrineSlot("owner", randomUUID()))
      .resolves.toMatchObject({ progression: { unlockedSlots: 8, nextSlot: null } });
    await expect(flags.unlockAtlasShrineSlot("owner", randomUUID()))
      .rejects.toMatchObject({ code: "ATLAS_SHRINE_SLOTS_MAXED" });
    expect(await quantities("owner")).toMatchObject({ atlas_shrine_shard: 0 });

    // Grandfathered: a player above the cap of 8 keeps their slots but cannot add more.
    await setUnlocked("owner", 15);
    await setLevel("owner", 25);
    await grant("owner", "atlas_shrine_shard", 16);
    await expect(flags.atlasShrineProgression("owner"))
      .resolves.toMatchObject({ unlockedSlots: 15, nextSlot: null });
    await expect(flags.unlockAtlasShrineSlot("owner", randomUUID()))
      .rejects.toMatchObject({ code: "ATLAS_SHRINE_SLOTS_MAXED" });
    expect(await flags.atlasShrineProgression("owner")).toMatchObject({ unlockedSlots: 15 });
    expect(await quantities("owner")).toMatchObject({ atlas_shrine_shard: 16 });
  });

  it("spends 12 wood + 8 stone to construct, preserves flag identity and metadata, and frees capacity on destruction", async () => {
    await setLevel("owner", 1);
    await setUnlocked("owner", 1);
    await grant("owner", "stone", 30);
    await grant("owner", "wood", 30);
    await grant("owner", "atlas_shrine_shard", 5);
    const firstId = await createFlag("owner", "First Waystone", 35.1, -106.7);
    const playerBefore = await playerAuthority("owner");

    const stone = await flags.upgradeFlagTier("owner", firstId, "stone", randomUUID());
    expect(stone.flag).toMatchObject({
      id: firstId,
      name: "First Waystone",
      accessMode: "public",
      lat: 35.1,
      lon: -106.7,
      upgradeTier: "stone",
      health: 220,
      maximumHealth: 220
    });
    expect(await quantities("owner")).toMatchObject({ stone: 25, atlas_shrine_shard: 5 });

    const shrine = await flags.upgradeFlagTier(
      "owner",
      firstId,
      "atlas_shrine",
      randomUUID()
    );
    expect(shrine.flag).toMatchObject({
      id: firstId,
      ownerId: "owner",
      name: "Atlas Shrine 1",
      atlasShrineSlotNumber: 1,
      accessMode: "public",
      upgradeTier: "atlas_shrine",
      health: 3_300,
      maximumHealth: 3_300
    });
    expect(await quantities("owner")).toMatchObject({ stone: 17, wood: 18, atlas_shrine_shard: 5 });
    expect(await playerAuthority("owner")).toEqual(playerBefore);

    const secondId = await createFlag("owner", "Second Waystone", 35.2, -106.8);
    await flags.upgradeFlagTier("owner", secondId, "stone", randomUUID());
    expect(await quantities("owner")).toMatchObject({ stone: 12, atlas_shrine_shard: 5 });
    await expect(flags.upgradeFlagTier("owner", secondId, "atlas_shrine", randomUUID()))
      .rejects.toMatchObject({ code: "ATLAS_SHRINE_CAPACITY_REQUIRED" });
    expect(await quantities("owner")).toMatchObject({ stone: 12, atlas_shrine_shard: 5 });

    const destructionRequestId = randomUUID();
    await expect(flags.deleteFlag(firstId, "owner", false, destructionRequestId))
      .resolves.toMatchObject({
        replayed: false,
        refundInventories: [{
          playerId: "owner",
          inventory: { totals: { stone: 16, atlas_shrine_shard: 5 } }
        }]
      });
    await expect(flags.deleteFlag(firstId, "owner", false, destructionRequestId))
      .resolves.toMatchObject({ replayed: true });
    expect(await quantities("owner")).toMatchObject({ stone: 16, atlas_shrine_shard: 5 });
    expect(await flags.atlasShrineProgression("owner")).toMatchObject({
      unlockedSlots: 1,
      builtShrines: 0,
      availableCapacity: 1
    });
    const replacement = await flags.upgradeFlagTier(
      "owner",
      secondId,
      "atlas_shrine",
      randomUUID()
    );
    expect(replacement.flag).toMatchObject({
      name: "Atlas Shrine 1",
      atlasShrineSlotNumber: 1
    });
    expect(await quantities("owner")).toMatchObject({ stone: 8, atlas_shrine_shard: 5 });
    expect(await flags.atlasShrineProgression("owner")).toMatchObject({
      unlockedSlots: 1,
      builtShrines: 1,
      availableCapacity: 0
    });
  });

  it("keeps a pending legendary encounter attached after repair and blocks Atlas conversion", async () => {
    await setUnlocked("owner", 1);
    await grant("owner", "stone", 15);
    const flagId = await createFlag("owner", "Burning Waystone", 35.1, -106.7);
    await flags.upgradeFlagTier("owner", flagId, "stone", randomUUID());
    const cycleStartedAt = new Date("2099-08-24T12:00:00.000Z");
    const expiresAt = new Date(cycleStartedAt.getTime() + 86_400_000);
    await pool.query(
      `INSERT INTO legendary_bird_cycles (cycle_started_at,expires_at)
       VALUES ($1,$2) ON CONFLICT (cycle_started_at) DO NOTHING`,
      [cycleStartedAt, expiresAt]
    );
    await pool.query(
      `INSERT INTO legendary_bird_events (
         event_id,cycle_started_at,bird_species,flag_id,owner_player_id,selected_at,expires_at
       ) VALUES ($1,$2,'fire',$3,'owner',$2,$4)`,
      [randomUUID(), cycleStartedAt, flagId, expiresAt]
    );
    await pool.query(
      `UPDATE flags SET health=100,burning_started_at=$2,burning_until=$3,
              burning_reason='legendary_event' WHERE id=$1`,
      [flagId, cycleStartedAt, expiresAt]
    );

    await expect(flags.repairBurningStoneFlag("owner", flagId)).resolves.toMatchObject({
      health: 220,
      burning: false,
      legendaryBirdSpecies: "fire"
    });
    await expect(flags.upgradeFlagTier("owner", flagId, "atlas_shrine", randomUUID()))
      .rejects.toMatchObject({ code: "ATLAS_SHRINE_FLAG_BURNING" });
    expect(await quantities("owner")).toMatchObject({ stone: 10 });
  });

  it("permits only the owner to rename an active personal Atlas Shrine", async () => {
    await createPlayer("other", 1);
    await setUnlocked("owner", 1);
    await grant("owner", "stone", 15);
    await grant("owner", "wood", 12);
    const ordinaryId = await createFlag("owner", "Ordinary", 35.1, -106.7);
    await expect(flags.renameFlag(ordinaryId, "Forbidden", "owner"))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await flags.upgradeFlagTier("owner", ordinaryId, "stone", randomUUID());
    await flags.upgradeFlagTier("owner", ordinaryId, "atlas_shrine", randomUUID());
    await expect(flags.renameFlag(ordinaryId, "North Shrine", "other"))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await expect(flags.renameFlag(ordinaryId, "North Shrine", "owner"))
      .resolves.toMatchObject({ id: ordinaryId, name: "North Shrine" });
    await expect(flags.renameFlag(ordinaryId, "123456789012345", "owner"))
      .resolves.toMatchObject({ name: "123456789012345" });
    await expect(flags.renameFlag(ordinaryId, "1234567890123456", "owner"))
      .rejects.toThrow("15 characters or fewer");
    await expect(flags.renameFlag(ordinaryId, "   ", "owner"))
      .resolves.toMatchObject({ name: "Atlas Shrine 1", atlasShrineSlotNumber: 1 });
    await expect(flags.renameFlag(ordinaryId, "", "owner"))
      .resolves.toMatchObject({ name: "Atlas Shrine 1" });
  });

  it("serializes concurrent construction and assigns distinct lowest available slots", async () => {
    await setUnlocked("owner", 2);
    await grant("owner", "stone", 16);
    await grant("owner", "wood", 24);
    const left = await createFlag("owner", "Left", 35.3, -106.9, 1);
    const right = await createFlag("owner", "Right", 35.4, -107, 1);

    const results = await Promise.allSettled([
      flags.upgradeFlagTier("owner", left, "atlas_shrine", randomUUID()),
      flags.upgradeFlagTier("owner", right, "atlas_shrine", randomUUID())
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    const constructed = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.flag] : []
    );
    expect(constructed.map((flag) => flag.atlasShrineSlotNumber).sort())
      .toEqual([1, 2]);
    expect(constructed.map((flag) => flag.name).sort())
      .toEqual(["Atlas Shrine 1", "Atlas Shrine 2"]);
    expect(await flags.atlasShrineProgression("owner")).toMatchObject({
      unlockedSlots: 2,
      builtShrines: 2
    });
    expect(await quantities("owner")).toMatchObject({ stone: 0, wood: 0 });
  });

  it("replays shrine construction with its original slot and name", async () => {
    await setUnlocked("owner", 1);
    await grant("owner", "stone", 8);
    await grant("owner", "wood", 12);
    const flagId = await createFlag("owner", "Replay", 35.5, -107.1, 1);
    const requestId = randomUUID();

    const first = await flags.upgradeFlagTier(
      "owner",
      flagId,
      "atlas_shrine",
      requestId
    );
    const replay = await flags.upgradeFlagTier(
      "owner",
      flagId,
      "atlas_shrine",
      requestId
    );
    expect(first).toMatchObject({
      replayed: false,
      flag: { name: "Atlas Shrine 1", atlasShrineSlotNumber: 1 }
    });
    expect(replay).toMatchObject({
      replayed: true,
      flag: { name: "Atlas Shrine 1", atlasShrineSlotNumber: 1 }
    });
  });

  it("allows city and Kingdom flags to become stone but never Atlas Shrines", async () => {
    await createPlayer("city-owner", 1);
    await createPlayer("kingdom-owner", 1);
    await grant("city-owner", "stone", 15);
    await grant("kingdom-owner", "stone", 15);
    const cityFlagId = await createCityControlledFlag("city-owner");
    const kingdomFlagId = await createKingdomControlledFlag("kingdom-owner");

    await expect(flags.upgradeFlagTier(
      "city-owner",
      cityFlagId,
      "stone",
      randomUUID()
    )).resolves.toMatchObject({ flag: { upgradeTier: "stone", controlType: "city" } });
    await expect(flags.upgradeFlagTier(
      "kingdom-owner",
      kingdomFlagId,
      "stone",
      randomUUID()
    )).resolves.toMatchObject({ flag: { upgradeTier: "stone", controlType: "kingdom" } });
    expect(await quantities("city-owner")).toMatchObject({ stone: 10 });
    expect(await quantities("kingdom-owner")).toMatchObject({ stone: 10 });

    await expect(flags.upgradeFlagTier(
      "city-owner",
      cityFlagId,
      "atlas_shrine",
      randomUUID()
    )).rejects.toMatchObject({ code: "ATLAS_SHRINE_PERSONAL_ONLY" });
    await expect(flags.upgradeFlagTier(
      "kingdom-owner",
      kingdomFlagId,
      "atlas_shrine",
      randomUUID()
    )).rejects.toMatchObject({ code: "ATLAS_SHRINE_PERSONAL_ONLY" });
    expect(await quantities("city-owner")).toMatchObject({ stone: 10 });
    expect(await quantities("kingdom-owner")).toMatchObject({ stone: 10 });
  });

  it("Atlas Shrine: another player can attack an Atlas Shrine (3,300 HP); its owner cannot", async () => {
    await createPlayer("raider", 1);
    await setUnlocked("owner", 1);
    await grant("owner", "stone", 10);
    await grant("owner", "wood", 12);
    const shrineId = await createFlag("owner", "Shrine", 35.6, -107.2, 1);
    await flags.upgradeFlagTier("owner", shrineId, "atlas_shrine", randomUUID());
    const atShrine = { position: { lat: 35.6, lon: -107.2 }, target: null, online: true };

    await expect(flags.attackFlag("owner", shrineId, randomUUID(), atShrine))
      .rejects.toMatchObject({ code: "FLAG_ATTACK_TARGET_INVALID" });
    await expect(flags.attackFlag("raider", shrineId, randomUUID(), atShrine))
      .resolves.toMatchObject({ damage: 25, flag: { health: 3_275, maximumHealth: 3_300 } });
  });

  it("Buoy: another player can attack a Buoy (220 HP); its owner cannot", async () => {
    await createPlayer("raider", 1);
    const buoyId = randomUUID();
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, anchor_kind, access_mode, geom)
       VALUES ($1,'owner','Buoy',35.7,-107.3,'buoy','public',ST_SetSRID(ST_MakePoint(-107.3,35.7),4326))`,
      [buoyId]
    );
    const atBuoy = { position: { lat: 35.7, lon: -107.3 }, target: null, online: true };
    await expect(flags.attackFlag("owner", buoyId, randomUUID(), atBuoy))
      .rejects.toMatchObject({ code: "FLAG_ATTACK_TARGET_INVALID" });
    await expect(flags.attackFlag("raider", buoyId, randomUUID(), atBuoy))
      .resolves.toMatchObject({ damage: 25, flag: { health: 195, maximumHealth: 220 } });
  });

  async function createPlayer(playerId: string, level: number): Promise<void> {
    await pool.query(
      `INSERT INTO players (
         id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES ($1,$1,'GLOBAL',35,-106,35,-106,1250,false,
                 ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId]
    );
    await setLevel(playerId, level);
  }

  async function setLevel(playerId: string, level: number): Promise<void> {
    await pool.query(
      `INSERT INTO player_progression_profiles (player_id, level)
       VALUES ($1,$2)
       ON CONFLICT (player_id) DO UPDATE SET level = EXCLUDED.level`,
      [playerId, level]
    );
  }

  async function setUnlocked(playerId: string, unlockedSlots: number): Promise<void> {
    await pool.query(
      `INSERT INTO player_atlas_shrine_progression (player_id, unlocked_slots)
       VALUES ($1,$2)
       ON CONFLICT (player_id) DO UPDATE
       SET unlocked_slots = EXCLUDED.unlocked_slots`,
      [playerId, unlockedSlots]
    );
  }

  async function grant(
    playerId: string,
    itemId: "stone" | "wood" | "atlas_shrine_shard",
    quantity: number
  ): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `atlas-shrine-test:${randomUUID()}`,
      playerId,
      source: "atlas_shrine_test",
      grants: [{ itemId, variant: null, quantity }]
    });
  }

  async function createFlag(
    playerId: string,
    name: string,
    lat: number,
    lon: number,
    reinforcementLevel = 0
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO flags (
         id, owner_id, name, lat, lon, claim_radius_m, resource_vision_radius_m,
         access_mode, reinforcement_level, health, maximum_health, geom
       ) VALUES (
         $1,$2,$3,$4,$5,1000,1250,'public',$6::smallint,
         CASE WHEN $6::smallint=1 THEN 220 ELSE NULL END,
         CASE WHEN $6::smallint=1 THEN 220 ELSE NULL END,
         ST_SetSRID(ST_MakePoint($5,$4),4326)
       )`,
      [id, playerId, name, lat, lon, reinforcementLevel]
    );
    return id;
  }

  async function createCityControlledFlag(playerId: string): Promise<string> {
    const cityId = randomUUID();
    const seatFlagId = await createFlag(playerId, "City Center", 36, -108);
    await pool.query(
      `INSERT INTO cities (
         id,world_id,canonical_municipality_id,world_settlement_id,
         world_settlement_source,world_source_settlement_id,name,country_code,
         region_code,founder_player_id,mayor_player_id,founding_request_id,
         seat_flag_id,hall_lat,hall_lon,hall_geom,founding_annex_radius_m
       ) VALUES (
         $1,'main',$2,$2,'test',$2,'Shrine Test City','US','US-NM',$3,$3,$4,$5,
         36,-108,ST_SetSRID(ST_MakePoint(-108,36),4326),1000
       )`,
      [cityId, `settlement-${cityId}`, playerId, `found-${cityId}`, seatFlagId]
    );
    await pool.query(
      `UPDATE flags
       SET control_type='city_seat',city_id=$2,city_affiliated_at=now()
       WHERE id=$1`,
      [seatFlagId, cityId]
    );
    await pool.query(
      `WITH house AS (
         INSERT INTO city_structures (
           structure_id,city_id,structure_type,tier,owner_player_id,world_id,
           lat,lon,geom,footprint_geom,footprint_radius_m,state,
           build_operation_key,built_at
         ) VALUES (
           gen_random_uuid(),$1,'mayor_house',1,$2,'main',36,-108,
           ST_SetSRID(ST_MakePoint(-108,36),4326),
           ST_Buffer(ST_SetSRID(ST_MakePoint(-108,36),4326)::geography,10)::geometry,
           10,'active',$3,now()
         ) RETURNING structure_id
       )
       INSERT INTO city_memberships (
         city_id,player_id,world_id,role,house_structure_id
       )
       SELECT $1,$2,'main','mayor',structure_id FROM house`,
      [cityId, playerId, `city-house-${cityId}`]
    );
    const flagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,resource_vision_radius_m,
         access_mode,control_type,city_id,city_affiliated_at,geom
       ) VALUES (
         $1,$2,'City Expansion',36.03,-108,1000,1250,'public','city',$3,now(),
         ST_SetSRID(ST_MakePoint(-108,36.03),4326)
       )`,
      [flagId, playerId, cityId]
    );
    return flagId;
  }

  async function createKingdomControlledFlag(playerId: string): Promise<string> {
    const kingdomId = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (
         id,normalized_name,display_name,founder_player_id,leader_player_id,
         founding_request_id
       ) VALUES ($1,$2,'Shrine Test Kingdom',$3,$3,$4)`,
      [kingdomId, `shrine-${kingdomId.slice(0, 20)}`, playerId, randomUUID()]
    );
    await pool.query(
      `INSERT INTO kingdom_memberships (
         id,kingdom_id,player_id,role,status,joined_at,perk_qualified_at
       ) VALUES ($1,$2,$3,'leader','active',now(),now())`,
      [randomUUID(), kingdomId, playerId]
    );
    const flagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,resource_vision_radius_m,
         access_mode,control_type,kingdom_id,kingdom_affiliated_at,
         original_owner_player_id,contributed_by_player_id,
         original_personal_color,geom
       ) VALUES (
         $1,$2,'Kingdom Flag',37,-109,1000,1250,'private','kingdom',$3,now(),
         $2,$2,'#38bdf8',ST_SetSRID(ST_MakePoint(-109,37),4326)
       )`,
      [flagId, playerId, kingdomId]
    );
    return flagId;
  }

  async function quantities(playerId: string): Promise<Record<string, number>> {
    const snapshot = await inventory.getInventorySnapshot(playerId);
    return snapshot.totals;
  }

  async function playerAuthority(playerId: string): Promise<Record<string, unknown>> {
    return (await pool.query(
      `SELECT lat,lon,anchor_lat,anchor_lon,current_flag_id,
              resource_vision_center_lat,resource_vision_center_lon
       FROM players WHERE id = $1`,
      [playerId]
    )).rows[0] ?? {};
  }
});

function validatedDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/\/ash_atlas_stability[^/?]*/.test(value)) {
    throw new Error("SETTLEMENT_TEST_DATABASE_URL must target an ash_atlas_stability database");
  }
  return value;
}
