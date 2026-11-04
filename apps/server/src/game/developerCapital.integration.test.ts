import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { CityService } from "./cities.js";
import { developerCapitalFlagSlots } from "./developerCapitalLayout.js";
import { InventoryService } from "./inventory.js";
import type { PlayerRecord } from "./state.js";
import { WalletService } from "./wallet.js";

const databaseUrl = process.env.DEVELOPER_CAPITAL_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const { Pool } = pg;
const ANCHOR = { lat: 35.0853, lon: -106.6511 };

describeDatabase("developer capital founding PostgreSQL integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("DEVELOPER_CAPITAL_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl!, max: 12 });
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await createPlayer(pool, "dev", "Default Dev");
    await createPlayer(pool, "other", "Other");
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("dry run lists annexed and excluded flags and writes nothing", async () => {
    const slots = developerCapitalFlagSlots(ANCHOR, 501);
    const personalId = await createFlag(pool, "other", slots[20]!.lat, slots[20]!.lon, 500);
    const kingdomId = await createKingdomFlag(pool, "other", slots[40]!.lat, slots[40]!.lon);
    const before = await counts(pool);
    const service = cityService(pool, "Albuquerque");
    const result = await service.foundDeveloperCapital(player("dev"), {
      requestId: "plan-1",
      dryRun: true,
      leaveCurrentCity: false
    });
    expect(result).toMatchObject({ dryRun: true, city: null });
    expect(result.plan.annexedFlags).toEqual([{
      flagId: personalId,
      previousOwnerPlayerId: "other",
      previousOwnerUsername: "Other",
      lat: slots[20]!.lat,
      lon: slots[20]!.lon,
      filledSlot: 20
    }]);
    expect(result.plan.excludedFlags).toEqual([expect.objectContaining({
      flagId: kingdomId, ownerUsername: "Other", reason: "kingdom"
    })]);
    expect(result.plan.skippedFlags.map(({ slot }) => slot)).toContain(40);
    expect(result.plan.skippedFlags.every(({ reason }) => reason === "existing_territory")).toBe(true);
    expect(result.plan.placedFlags.map(({ slot }) => slot)).not.toContain(20);
    expect(result.plan.structures.map(({ type }) => type)).toEqual([
      "mayor_house", "warehouse", "market"
    ]);
    expect(result.plan.hall).toMatchObject({ ...ANCHOR, snappedFromAnchorM: 0 });
    await expect(counts(pool)).resolves.toEqual(before);
    expect(before).toMatchObject({ cities: 0, flags: 2, structures: 0, venues: 0 });
    await expect(pool.query("SELECT owner_id, control_type FROM flags WHERE id = $1", [personalId]))
      .resolves.toMatchObject({ rows: [{ owner_id: "other", control_type: "personal" }] });
  });

  it("founds the capital once, annexes footprint flags and replays idempotently", async () => {
    const slots = developerCapitalFlagSlots(ANCHOR, 501);
    const annexedId = await createFlag(pool, "other", slots[30]!.lat, slots[30]!.lon, 500);
    const service = cityService(pool, "Albuquerque");
    const founded = await service.foundDeveloperCapital(player("dev"), {
      requestId: "found-1",
      dryRun: false,
      leaveCurrentCity: false
    });
    expect(founded.replayed).toBe(false);
    expect(founded.city).toMatchObject({
      name: "Albuquerque",
      founderPlayerId: "dev",
      mayorPlayerId: "dev",
      mayorConfirmed: true,
      constructionPhase: "complete",
      jumpable: true,
      controllerKind: "player",
      culture: "human"
    });
    expect(founded.plan.annexedFlags.map(({ flagId }) => flagId)).toEqual([annexedId]);
    expect(founded.plan.skippedFlags).toEqual([]);
    expect(founded.plan.placedFlags).toHaveLength(49);
    const cityId = founded.city!.id;
    const flags = await pool.query<{
      control_type: string; owner_id: string; reinforcement_level: number;
      system_controlled: boolean; count: number;
    }>(
      `SELECT control_type, owner_id, reinforcement_level, system_controlled, count(*)::int
       FROM flags WHERE city_id = $1
       GROUP BY control_type, owner_id, reinforcement_level, system_controlled
       ORDER BY control_type`,
      [cityId]
    );
    expect(flags.rows).toEqual([
      { control_type: "city", owner_id: "dev", reinforcement_level: 0, system_controlled: false,
        count: 49 },
      { control_type: "city_seat", owner_id: "dev", reinforcement_level: 0, system_controlled: false,
        count: 1 }
    ]);
    await expect(pool.query(
      `SELECT owner_id, control_type, city_id, city_affiliated_at IS NOT NULL AS affiliated
       FROM flags WHERE id = $1`,
      [annexedId]
    )).resolves.toMatchObject({
      rows: [{ owner_id: "dev", control_type: "city", city_id: cityId, affiliated: true }]
    });
    await expect(pool.query(
      `SELECT flag_owner_player_id, reason FROM city_flag_affiliation_history WHERE flag_id = $1`,
      [annexedId]
    )).resolves.toMatchObject({
      rows: [{ flag_owner_player_id: "other", reason: "developer_capital_annexation" }]
    });
    const structures = await pool.query<{ structure_type: string; state: string; owner_player_id: string | null }>(
      `SELECT structure_type, state, owner_player_id FROM city_structures
       WHERE city_id = $1 ORDER BY structure_type`,
      [cityId]
    );
    expect(structures.rows).toEqual([
      { structure_type: "market", state: "active", owner_player_id: null },
      { structure_type: "mayor_house", state: "active", owner_player_id: "dev" },
      { structure_type: "warehouse", state: "active", owner_player_id: null }
    ]);
    await expect(service.getMembership("dev")).resolves.toMatchObject({
      cityId, role: "mayor"
    });
    await expect(pool.query(
      `SELECT venue.state, venue.active, control.frozen, control.new_orders_enabled
       FROM market_venues venue JOIN market_venue_controls control USING (venue_id)
       WHERE venue.city_id = $1`,
      [cityId]
    )).resolves.toMatchObject({
      rows: [{ state: "active", active: true, frozen: false, new_orders_enabled: true }]
    });
    const market = (await service.structures!.listForCity(cityId)).find(({ type }) => type === "market");
    expect(market).toBeDefined();
    await expect(service.structures!.getActiveMarket(market!.structureId, market!.placementRevision))
      .resolves.not.toBeNull();

    const before = await counts(pool);
    const replay = await cityService(pool, "Albuquerque").foundDeveloperCapital(player("dev"), {
      requestId: "found-1",
      dryRun: false,
      leaveCurrentCity: false
    });
    expect(replay).toMatchObject({ replayed: true, city: { id: cityId } });
    expect(replay.plan).toEqual(founded.plan);
    await expect(counts(pool)).resolves.toEqual(before);

    await expect(service.foundDeveloperCapital(player("dev"), {
      requestId: "found-2",
      dryRun: false,
      leaveCurrentCity: false
    })).rejects.toMatchObject({ code: "CITY_MUNICIPALITY_ALREADY_FOUNDED" });
    await expect(counts(pool)).resolves.toEqual(before);
  });

  it("refuses while the developer is in another city unless leaving is requested", async () => {
    const oldCityId = await createPlayerCity(pool, "dev", "Santa Fe", 35.687, -105.9378);
    const service = cityService(pool, "Albuquerque");
    await expect(service.foundDeveloperCapital(player("dev"), {
      requestId: "found-stay",
      dryRun: false,
      leaveCurrentCity: false
    })).rejects.toMatchObject({
      code: "CITY_INCOMPATIBLE_AFFILIATION",
      message: expect.stringContaining("Santa Fe")
    });
    await expect(pool.query("SELECT count(*)::int AS count FROM cities")).resolves
      .toMatchObject({ rows: [{ count: 1 }] });

    const plan = await service.foundDeveloperCapital(player("dev"), {
      requestId: "plan-leave",
      dryRun: true,
      leaveCurrentCity: false
    });
    expect(plan.plan).toMatchObject({
      leaveRequired: true,
      currentCity: { cityId: oldCityId, cityName: "Santa Fe", role: "mayor" },
      leave: { cityId: oldCityId, houseType: "mayor_house", mayorRelinquished: true }
    });
    await expect(service.getMembership("dev")).resolves.toMatchObject({ cityId: oldCityId });

    const founded = await service.foundDeveloperCapital(player("dev"), {
      requestId: "found-leave",
      dryRun: false,
      leaveCurrentCity: true
    });
    expect(founded.plan.leave).toMatchObject({ cityId: oldCityId });
    await expect(service.getMembership("dev")).resolves.toMatchObject({
      cityId: founded.city!.id, role: "mayor"
    });
    await expect(pool.query(
      `SELECT mayor_player_id, active FROM cities WHERE id = $1`, [oldCityId]
    )).resolves.toMatchObject({ rows: [{ mayor_player_id: null, active: true }] });
    await expect(pool.query(
      `SELECT ended_reason FROM city_memberships WHERE city_id = $1 AND player_id = 'dev'`,
      [oldCityId]
    )).resolves.toMatchObject({ rows: [{ ended_reason: "house_destroyed" }] });
  });

  it("exempts only developer-authorized conversions from the expansion flag cap", async () => {
    const service = cityService(pool, "Albuquerque");
    const founded = await service.foundDeveloperCapital(player("dev"), {
      requestId: "found-cap",
      dryRun: false,
      leaveCurrentCity: false
    });
    const cityId = founded.city!.id;
    await createHouseMembership(pool, cityId, "other");
    const edge = founded.plan.placedFlags.at(-1)!;
    const devFlag = await createFlag(pool, "dev", edge.lat + 0.006, edge.lon, 500);
    const otherFlag = await createFlag(pool, "other", edge.lat + 0.006, edge.lon + 0.012, 500);

    await expect(service.convertCityFlag("dev", { requestId: "convert-dev-capped", flagId: devFlag }))
      .rejects.toMatchObject({ code: "CITY_EXPANSION_LIMIT_REACHED" });
    await expect(service.convertCityFlag("other", { requestId: "convert-other", flagId: otherFlag }))
      .rejects.toMatchObject({ code: "CITY_EXPANSION_LIMIT_REACHED" });
    await expect(service.convertCityFlag(
      "dev",
      { requestId: "convert-dev", flagId: devFlag },
      { exemptFromExpansionLimit: true }
    )).resolves.toMatchObject({ cityId, flagId: devFlag, replayed: false });
    await expect(pool.query("SELECT control_type, city_id FROM flags WHERE id = $1", [devFlag]))
      .resolves.toMatchObject({ rows: [{ control_type: "city", city_id: cityId }] });
  });
});

function cityService(pool: pg.Pool, settlementName: string): CityService {
  const settlement = municipality(settlementName);
  const authority = {
    releaseId: settlement.settlementReleaseId,
    releaseFingerprint: settlement.settlementReleaseFingerprint,
    foundingPolicyId: settlement.foundingPolicyId,
    foundingPolicyFingerprint: settlement.foundingPolicyFingerprint,
    resolutionPolicyId: settlement.resolutionPolicyId,
    resolutionPolicyFingerprint: settlement.resolutionPolicyFingerprint
  };
  return new CityService(
    pool,
    {
      lookupSettlement: vi.fn().mockResolvedValue({
        found: true, inside: true, settlement, nearest: null, authority
      }),
      lookupGameplayEnvironments: async (points: Array<{ lat: number; lon: number }>) =>
        points.map((point) => ({
          ok: true,
          contractVersion: "gameplay-environment-v1" as const,
          runtime: null,
          latitude: point.lat,
          longitude: point.lon,
          packageId: "test-land",
          elevationM: 1,
          terrainClass: "land",
          biome: "temperate",
          ecoregion: "test",
          isLand: true,
          isSaltwater: false,
          insideMajorLake: false,
          raw: {}
        }))
    } as unknown as WorldLookupClient,
    loadConfig({ WORLD_ID: "main" }),
    { info: vi.fn(), warn: vi.fn() } as unknown as AppLogger,
    {
      settlementAuthority: () => authority,
      inventory: new InventoryService(pool),
      wallet: new WalletService(pool)
    }
  );
}

function municipality(name: string) {
  const settlementId = name === "Albuquerque"
    ? "00000000-0000-4000-8000-0000000000c1"
    : "00000000-0000-4000-8000-000000900002";
  return {
    settlementId,
    source: "overture",
    sourceSettlementId: settlementId,
    name,
    countryCode: "US",
    regionCode: "US-NM",
    jurisdictionName: "New Mexico",
    subtype: "city",
    administrativeLevel: "city",
    sourceClass: "city",
    sourceVersion: "2026-06-17.0",
    settlementClass: "city",
    settlementReleaseId: "world-settlements-v1",
    settlementReleaseFingerprint: "f".repeat(64),
    foundingPolicyId: "settlement-founding-v2",
    foundingPolicyFingerprint: "c".repeat(64),
    resolutionPolicyId: "primary-settlement-resolution-v1",
    resolutionPolicyFingerprint: "d".repeat(64),
    resolution: {
      policyId: "primary-settlement-resolution-v1",
      selectedAs: "primary_locality" as const,
      candidateCount: 1
    },
    foundingEligible: true,
    population: null,
    minimumFoundingPopulation: null,
    foundingIneligibilityReason: null
  };
}

function player(playerId: string): PlayerRecord {
  return {
    playerId,
    username: playerId,
    displayColor: "#38bdf8",
    regionCode: "NM",
    position: { ...ANCHOR },
    anchor: { ...ANCHOR },
    moveLeashRadiusM: 900,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date()
  };
}

async function counts(pool: pg.Pool): Promise<Record<string, number>> {
  const result = await pool.query<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM cities) AS cities,
            (SELECT count(*)::int FROM flags) AS flags,
            (SELECT count(*)::int FROM city_structures) AS structures,
            (SELECT count(*)::int FROM city_memberships) AS memberships,
            (SELECT count(*)::int FROM market_venues WHERE city_id IS NOT NULL) AS venues,
            (SELECT count(*)::int FROM city_structure_operations) AS operations`
  );
  return result.rows[0]!;
}

/** An unrelated active, complete player city where `playerId` is the confirmed Mayor. */
async function createPlayerCity(
  pool: pg.Pool,
  playerId: string,
  name: string,
  lat: number,
  lon: number
): Promise<string> {
  const cityId = randomUUID();
  const seatId = randomUUID();
  await pool.query(
    `INSERT INTO cities (
       id, world_id, canonical_municipality_id, world_settlement_id, world_settlement_source,
       world_source_settlement_id, name, country_code, region_code, founder_player_id,
       founding_request_id, construction_phase, construction_completed_at, jumpable,
       seat_flag_id, hall_lat, hall_lon, hall_geom, founding_annex_radius_m
     ) VALUES ($1,'main',$2,$2,'overture',$2,$3,'US','US-NM',$4,$5,'complete',now(),true,
               NULL,$6,$7,ST_SetSRID(ST_MakePoint($7,$6),4326),500)`,
    [cityId, `test:${name}`, name, playerId, randomUUID(), lat, lon]
  );
  await pool.query(
    `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, city_id, access_mode, city_affiliated_at)
     VALUES ($1,$2,'Seat',$3,$4,500,ST_SetSRID(ST_MakePoint($4,$3),4326),'city_seat',$5,'public',now())`,
    [seatId, playerId, lat, lon, cityId]
  );
  await pool.query("UPDATE cities SET seat_flag_id = $2 WHERE id = $1", [cityId, seatId]);
  await createHouseMembership(pool, cityId, playerId, "mayor");
  return cityId;
}

async function createHouseMembership(
  pool: pg.Pool,
  cityId: string,
  playerId: string,
  role: "member" | "mayor" = "member"
): Promise<void> {
  const structureId = randomUUID();
  const city = (await pool.query<{ hall_lat: number; hall_lon: number }>(
    "SELECT hall_lat, hall_lon FROM cities WHERE id = $1",
    [cityId]
  )).rows[0]!;
  const lat = Number(city.hall_lat) + 0.0035;
  const lon = Number(city.hall_lon) + (role === "mayor" ? 0 : 0.004);
  await pool.query(
    `INSERT INTO city_structures (
       structure_id,city_id,structure_type,tier,owner_player_id,world_id,region_code,
       lat,lon,geom,footprint_geom,footprint_radius_m,state,build_operation_key,built_at
     ) VALUES (
       $1,$2,$3,1,$4,'main','US-NM',$5,$6,ST_SetSRID(ST_MakePoint($6,$5),4326),
       ST_Buffer(ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,10)::geometry,
       10,'active',$7,now()
     )`,
    [structureId, cityId, role === "mayor" ? "mayor_house" : "city_house", playerId, lat, lon,
      `capital-test-house:${structureId}`]
  );
  await pool.query(
    `INSERT INTO city_memberships (
       membership_id,city_id,player_id,world_id,role,house_structure_id,joined_at
     ) VALUES (gen_random_uuid(),$1,$2,'main',$3,$4,now())`,
    [cityId, playerId, role, structureId]
  );
  if (role === "mayor") {
    await pool.query(
      "UPDATE cities SET mayor_player_id=$2, mayor_confirmed_at=now() WHERE id=$1",
      [cityId, playerId]
    );
  }
}

async function createPlayer(pool: pg.Pool, id: string, username: string): Promise<void> {
  const accountId = randomUUID();
  await pool.query(
    "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
    [accountId]
  );
  await pool.query(
    `INSERT INTO players (
       id, account_id, username, username_normalized, display_color, region_code, lat, lon,
       anchor_lat, anchor_lon, move_leash_radius_m, online, geom
     ) VALUES ($1,$3,$2,$1,'#38bdf8','NM',35.0853,-106.6511,35.0853,-106.6511,
               900,false,ST_SetSRID(ST_MakePoint(-106.6511,35.0853),4326))`,
    [id, username, accountId]
  );
}

async function createKingdomFlag(
  pool: pg.Pool,
  ownerId: string,
  lat: number,
  lon: number
): Promise<string> {
  const flagId = await createFlag(pool, ownerId, lat, lon, 500);
  const kingdomId = randomUUID();
  await pool.query(
    `INSERT INTO kingdoms (
       id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id
     ) VALUES ($1,$2,$3,$4,$4,$5)`,
    [kingdomId, `kingdom-${kingdomId.slice(0, 8)}`, `Kingdom ${kingdomId.slice(0, 4)}`, ownerId, randomUUID()]
  );
  await pool.query(
    `INSERT INTO kingdom_memberships (
       id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
     ) VALUES (gen_random_uuid(),$1,$2,'leader','active',now(),now())`,
    [kingdomId, ownerId]
  );
  await pool.query(
    `UPDATE flags
     SET control_type = 'kingdom', kingdom_id = $2,
         kingdom_affiliated_at = now(), kingdom_affiliated_by_player_id = $3,
         original_owner_player_id = owner_id, contributed_by_player_id = $3,
         original_personal_color = '#38bdf8'
     WHERE id = $1`,
    [flagId, kingdomId, ownerId]
  );
  return flagId;
}

async function createFlag(
  pool: pg.Pool,
  ownerId: string,
  lat: number,
  lon: number,
  radius: number
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,ST_SetSRID(ST_MakePoint($4,$3),4326))
     RETURNING id`,
    [ownerId, `${ownerId} flag`, lat, lon, radius]
  );
  return result.rows[0]!.id;
}
