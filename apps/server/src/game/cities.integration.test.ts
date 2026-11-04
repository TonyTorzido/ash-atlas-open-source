import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { CityProfileAffiliationsResolver } from "./cityAffiliations.js";
import {
  applyCitySettlementReconciliation,
  planCitySettlementReconciliation,
  reverseCitySettlementReconciliation
} from "./citySettlementReconciliation.js";
import {
  CityService,
  assertCityFlagAction,
  clearAndPruneCityFlags
} from "./cities.js";
import {
  CITY_FOUNDING_EXPANSION_COUNT,
  CITY_FOUNDING_INITIAL_FLAG_COUNT
} from "./cityFoundingLayout.js";
import { FlagAccessService } from "./flagAccess.js";
import { InventoryService } from "./inventory.js";
import type { PlayerRecord } from "./state.js";
import { WalletService } from "./wallet.js";

const databaseUrl = process.env.SETTLEMENT_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const { Pool } = pg;

const albuquerque = municipality(
  "00000000-0000-4000-8000-0000000000c1",
  "Albuquerque",
  "US-NM",
  "New Mexico"
);
const santaFe = municipality(
  "00000000-0000-4000-8000-000000900002",
  "Santa Fe",
  "US-NM",
  "New Mexico"
);

describeDatabase("city territory PostgreSQL integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl!, max: 12 });
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    for (const [id, name] of [
      ["a", "Ash"], ["b", "Bex"], ["c", "Cy"], ["d", "Dee"], ["e", "Eve"]
    ] as const) {
      await createPlayer(pool, id, name);
    }
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("converts a private founding flag into a reconnect-safe public City Center", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504);
    const unrelated = await createFlag(pool, "a", 35.1044, -106.6504);
    const service = cityService(pool, albuquerque);
    const hallPlacement = player("a", "Ash", 35.0894, -106.6504);

    const founded = await service.foundCity(hallPlacement, {
      requestId: "found-city",
      flagId: source
    });
    const restartedService = cityService(pool, albuquerque);
    const replay = await restartedService.foundCity(hallPlacement, {
      requestId: "found-city",
      flagId: source
    });

    expect(replay).toMatchObject({ city: { id: founded.city.id }, replayed: true });
    expect(new Set(replay.territoryFlagIds)).toEqual(new Set(founded.territoryFlagIds));
    expect(founded.city).toMatchObject({
      lat: 35.0844,
      lon: -106.6504
    });
    const flags = await pool.query<{
      id: string; control_type: string; city_id: string | null; owner_id: string;
      original_owner_player_id: string | null; contributed_by_player_id: string | null;
      lat: number; lon: number;
    }>(
      `SELECT id, control_type, city_id, owner_id, lat, lon,
              original_owner_player_id, contributed_by_player_id
       FROM flags ORDER BY id`
    );
    expect(flags.rows.find(({ id }) => id === source)).toMatchObject({
      control_type: "city_seat",
      city_id: founded.city.id,
      owner_id: "a",
      original_owner_player_id: null,
      contributed_by_player_id: null,
      lat: 35.0844,
      lon: -106.6504
    });
    expect(flags.rows.find(({ id }) => id === unrelated)).toMatchObject({
      control_type: "personal",
      city_id: null
    });
    expect(flags.rows.filter(({ city_id }) => city_id === founded.city.id))
      .toHaveLength(CITY_FOUNDING_INITIAL_FLAG_COUNT);
    expect(flags.rows.filter(({ city_id, control_type }) =>
      city_id === founded.city.id && control_type === "city"
    )).toHaveLength(CITY_FOUNDING_EXPANSION_COUNT);
    await expect(pool.query(
      `SELECT count(*)::int AS count,
              round(min(ST_Distance(expansion.geom::geography, seat.geom::geography)))::int AS minimum_m,
              round(max(ST_Distance(expansion.geom::geography, seat.geom::geography)))::int AS maximum_m
       FROM flags expansion
       JOIN flags seat ON seat.id = $2
       WHERE expansion.city_id = $1 AND expansion.control_type = 'city'`,
      [founded.city.id, source]
    )).resolves.toMatchObject({
      rows: [{
        count: CITY_FOUNDING_EXPANSION_COUNT,
        minimum_m: 700,
        maximum_m: 700
      }]
    });
    await expect(service.getMembership("a")).resolves.toBeNull();
    await expect(new CityProfileAffiliationsResolver(pool).resolve("a")).resolves.toMatchObject({
      settlement: null
    });
    expect(founded.city).toMatchObject({
      founderPlayerId: "a",
      founderUsername: "Ash",
      mayorPlayerId: null,
      mayorConfirmed: false,
      founderMayorClaimDeadline: null,
      constructionPhase: "blueprint",
      constructionCompletedAt: null,
      constructionContributions: [{
        stage: "blueprint",
        playerId: "a",
        contributedAt: expect.any(String)
      }],
      jumpable: false
    });
    await expect(service.getCityApp("a")).resolves.toMatchObject({
      city: {
        id: founded.city.id,
        founderPlayerId: "a",
        mayorPlayerId: null
      },
      membership: null,
      house: null,
      founderClaimDeadline: null,
      playerIsFounder: true,
      mayorVacant: true,
      mayorClaimAllowed: false,
      mayorClaimReason: "Complete city construction before building a City House"
    });
    await expect(pool.query(
      `SELECT mayor_player_id,mayor_confirmed_at,
              EXTRACT(EPOCH FROM (mayor_house_deadline-created_at))::int
                AS founder_claim_seconds,
              (SELECT count(*)::int FROM city_memberships WHERE city_id=cities.id) AS memberships,
              (SELECT count(*)::int FROM city_structures WHERE city_id=cities.id) AS structures
       FROM cities WHERE id=$1`,
      [founded.city.id]
    )).resolves.toMatchObject({
      rows: [{
        mayor_player_id: null,
        mayor_confirmed_at: null,
        founder_claim_seconds: null,
        memberships: 0,
        structures: 0
      }]
    });
    await expect(pool.query(
      `SELECT settlement_founding_policy_id, settlement_founding_policy_fingerprint,
              settlement_resolution_policy_id, settlement_resolution_policy_fingerprint
       FROM cities WHERE id = $1`,
      [founded.city.id]
    )).resolves.toMatchObject({
      rows: [{
        settlement_founding_policy_id: "settlement-founding-v2",
        settlement_founding_policy_fingerprint: "c".repeat(64),
        settlement_resolution_policy_id: "primary-settlement-resolution-v1",
        settlement_resolution_policy_fingerprint: "d".repeat(64)
      }]
    });
    await expect(pool.query(
      `SELECT access_mode, jump_toll_gold::text
       FROM flags WHERE id = $1`,
      [source]
    )).resolves.toMatchObject({
      rows: [{
        access_mode: "public",
        jump_toll_gold: "0"
      }]
    });
    await expect(new FlagAccessService(pool).authorize(source, "e")).resolves.toMatchObject({
      controlType: "city_seat",
      decision: { allowed: true, reasonCode: "ALLOWED_PUBLIC", tollGold: "0" }
    });
  });

  it("advances four distinct contributors atomically with exact costs and durable replay", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504);
    const inventory = new InventoryService(pool);
    const wallet = new WalletService(pool);
    const service = cityService(pool, albuquerque, "main", undefined, {
      inventory,
      wallet
    });
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "construction-blueprint",
      flagId: source
    });

    await inventory.grantItemsForOperation({
      operationKey: "construction-stone-b",
      playerId: "b",
      source: "city_construction_test",
      grants: [{ itemId: "stone", variant: "default", quantity: 120 }]
    });
    const foundation = await service.advanceConstruction("b", {
      requestId: "construction-foundation",
      cityId: founded.city.id,
      action: "build_foundation"
    });
    expect(foundation).toMatchObject({
      replayed: false,
      city: { constructionPhase: "foundation", jumpable: false }
    });
    await expect(pool.query(
      `SELECT quantity::text FROM player_inventory
       WHERE player_id='b' AND resource_type='stone' AND variant='default'`
    )).resolves.toMatchObject({ rows: [{ quantity: "0" }] });
    await expect(service.advanceConstruction("b", {
      requestId: "construction-foundation",
      cityId: founded.city.id,
      action: "build_foundation"
    })).resolves.toMatchObject({ replayed: true });
    await expect(pool.query(
      `SELECT quantity::text FROM player_inventory
       WHERE player_id='b' AND resource_type='stone' AND variant='default'`
    )).resolves.toMatchObject({ rows: [{ quantity: "0" }] });
    await expect(service.advanceConstruction("b", {
      requestId: "construction-frames-same-actor",
      cityId: founded.city.id,
      action: "build_frames"
    })).rejects.toMatchObject({ code: "CITY_CONSTRUCTION_ACTOR_ALREADY_CONTRIBUTED" });

    await expect(service.advanceConstruction("c", {
      requestId: "construction-frames-insufficient",
      cityId: founded.city.id,
      action: "build_frames"
    })).rejects.toMatchObject({ code: "CITY_CONSTRUCTION_INSUFFICIENT_WOOD" });
    await expect(service.getCity(founded.city.id)).resolves.toMatchObject({
      constructionPhase: "foundation",
      constructionContributions: expect.arrayContaining([
        expect.objectContaining({ playerId: "a", stage: "blueprint" }),
        expect.objectContaining({ playerId: "b", stage: "foundation" })
      ])
    });
    await inventory.grantItemsForOperation({
      operationKey: "construction-wood-c",
      playerId: "c",
      source: "city_construction_test",
      grants: [{ itemId: "wood", variant: "default", quantity: 450 }]
    });
    await inventory.grantItemsForOperation({
      operationKey: "construction-wood-e",
      playerId: "e",
      source: "city_construction_test",
      grants: [{ itemId: "wood", variant: "default", quantity: 450 }]
    });
    const framingAttempts = await Promise.allSettled([
      service.advanceConstruction("c", {
        requestId: "construction-frames",
        cityId: founded.city.id,
        action: "build_frames"
      }),
      service.advanceConstruction("e", {
        requestId: "construction-stale-frames",
        cityId: founded.city.id,
        action: "build_frames"
      })
    ]);
    expect(framingAttempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const winnerId = framingAttempts[0]?.status === "fulfilled" ? "c" : "e";
    const loserId = winnerId === "c" ? "e" : "c";
    const rejected = framingAttempts.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "CITY_CONSTRUCTION_PHASE_MISMATCH" }
    });
    await expect(pool.query(
      `SELECT player_id,quantity::text FROM player_inventory
       WHERE player_id=ANY($1::text[]) AND resource_type='wood' AND variant='default'
       ORDER BY player_id`,
      [[winnerId, loserId]]
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        { player_id: winnerId, quantity: "0" },
        { player_id: loserId, quantity: "450" }
      ])
    });

    await expect(service.advanceConstruction("d", {
      requestId: "construction-finish-insufficient",
      cityId: founded.city.id,
      action: "finish"
    })).rejects.toMatchObject({ code: "CITY_CONSTRUCTION_INSUFFICIENT_GOLD" });
    const account = await pool.query<{ account_id: string }>(
      "SELECT account_id::text FROM players WHERE id='d'"
    );
    const walletClient = await pool.connect();
    try {
      await walletClient.query("BEGIN");
      await wallet.creditForOperationInTransaction(walletClient, {
        playerId: "d",
        accountId: account.rows[0]!.account_id,
        amount: 4_500n,
        operationKey: "construction-gold-d",
        reason: "city_construction_test"
      });
      await walletClient.query("COMMIT");
    } finally {
      walletClient.release();
    }
    const finished = await service.advanceConstruction("d", {
      requestId: "construction-finish",
      cityId: founded.city.id,
      action: "finish"
    });
    expect(finished).toMatchObject({
      replayed: false,
      walletGold: "0",
      city: {
        constructionPhase: "complete",
        constructionCompletedAt: expect.any(String),
        founderMayorClaimDeadline: expect.any(String),
        jumpable: true,
        constructionContributions: expect.arrayContaining([
          expect.objectContaining({ playerId: "d", stage: "finishing" })
        ])
      }
    });
    await expect(service.advanceConstruction("d", {
      requestId: "construction-finish",
      cityId: founded.city.id,
      action: "finish"
    })).resolves.toMatchObject({ replayed: true, walletGold: "0" });
    await expect(service.advanceConstruction("d", {
      requestId: "construction-finish",
      cityId: founded.city.id,
      action: "build_frames"
    })).rejects.toMatchObject({ code: "CITY_REQUEST_CONFLICT" });
    await expect(pool.query(
      `SELECT count(*)::int AS count,
              count(DISTINCT actor_player_id)::int AS actors,
              count(DISTINCT stage)::int AS stages
       FROM city_construction_contributions WHERE city_id=$1`,
      [founded.city.id]
    )).resolves.toMatchObject({ rows: [{ count: 4, actors: 4, stages: 4 }] });
  });

  it("annexes one founder flag first, creates one fewer banner, and preserves foreign flags", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504, 500);
    const founderNeighbor = await createFlagAtDistance(pool, "a", source, 500.06, 0, 500);
    const foreignNeighbor = await createFlagAtDistance(pool, "b", source, 500.06, 72, 500);
    const service = cityService(pool, albuquerque);

    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-with-one-annexation",
      flagId: source
    });

    expect(founded.territoryFlagIds).toHaveLength(CITY_FOUNDING_INITIAL_FLAG_COUNT);
    expect(founded.annexedFlags.map(({ flagId }) => flagId)).toEqual([founderNeighbor]);
    await expect(pool.query(
      `SELECT id, owner_id, control_type, city_id,
              original_owner_player_id, contributed_by_player_id
       FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[founderNeighbor, foreignNeighbor]]
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          id: founderNeighbor,
          owner_id: "a",
          control_type: "city",
          city_id: founded.city.id,
          original_owner_player_id: null,
          contributed_by_player_id: null
        }),
        expect.objectContaining({
          id: foreignNeighbor,
          owner_id: "b",
          control_type: "personal",
          city_id: null
        })
      ])
    });
    await expect(pool.query(
      `SELECT reason, count(*)::int AS count
       FROM city_flag_affiliation_history
       WHERE city_id = $1 AND reason IN ('founding_annexation','founding_generated')
       GROUP BY reason ORDER BY reason`,
      [founded.city.id]
    )).resolves.toMatchObject({
      rows: [
        { reason: "founding_annexation", count: 1 },
        { reason: "founding_generated", count: CITY_FOUNDING_EXPANSION_COUNT - 1 }
      ]
    });
  });

  it("annexes several founder flags and creates only the remaining allocation", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504, 500);
    const neighbors = await Promise.all([0, 72, 144].map((bearing) =>
      createFlagAtDistance(pool, "a", source, 500.06, bearing, 500)
    ));

    const founded = await cityService(pool, albuquerque).foundCity(player("a", "Ash"), {
      requestId: "found-with-several-annexations",
      flagId: source
    });

    expect(new Set(founded.annexedFlags.map(({ flagId }) => flagId)))
      .toEqual(new Set(neighbors));
    expect(founded.territoryFlagIds).toHaveLength(CITY_FOUNDING_INITIAL_FLAG_COUNT);
    await expect(pool.query(
      `SELECT reason, count(*)::int AS count
       FROM city_flag_affiliation_history
       WHERE city_id = $1 AND reason IN ('founding_annexation','founding_generated')
       GROUP BY reason ORDER BY reason`,
      [founded.city.id]
    )).resolves.toMatchObject({
      rows: [
        { reason: "founding_annexation", count: neighbors.length },
        {
          reason: "founding_generated",
          count: CITY_FOUNDING_EXPANSION_COUNT - neighbors.length
        }
      ]
    });
  });

  it("annexes all founder flags when they satisfy the target and creates no banners", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504, 500);
    const neighbors = await Promise.all([0, 72, 144, 216, 288].map((bearing) =>
      createFlagAtDistance(pool, "a", source, 500.06, bearing, 500)
    ));
    const service = cityService(pool, albuquerque);

    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-fully-annexed",
      flagId: source
    });
    const replay = await service.foundCity(player("a", "Ash"), {
      requestId: "found-fully-annexed",
      flagId: source
    });

    expect(new Set(founded.annexedFlags.map(({ flagId }) => flagId)))
      .toEqual(new Set(neighbors));
    expect(founded.territoryFlagIds).toHaveLength(CITY_FOUNDING_INITIAL_FLAG_COUNT);
    expect(new Set(replay.territoryFlagIds)).toEqual(new Set(founded.territoryFlagIds));
    await expect(pool.query(
      `SELECT reason, count(*)::int AS count
       FROM city_flag_affiliation_history
       WHERE city_id = $1 AND reason IN ('founding_annexation','founding_generated')
       GROUP BY reason ORDER BY reason`,
      [founded.city.id]
    )).resolves.toMatchObject({
      rows: [{ reason: "founding_annexation", count: CITY_FOUNDING_EXPANSION_COUNT }]
    });
  });

  it("rotates the full ring around protected Kingdom territory without mutating it", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504, 500);
    const kingdomFlag = await createFlagAtDistance(pool, "e", source, 850, 0, 1);
    await convertToKingdomFlag(pool, kingdomFlag, "e");
    const before = await pool.query(
      `SELECT control_type, kingdom_id, owner_id, lat, lon, claim_radius_m
       FROM flags WHERE id = $1`,
      [kingdomFlag]
    );

    const founded = await cityService(pool, albuquerque).foundCity(player("a", "Ash"), {
      requestId: "found-rotated-around-kingdom",
      flagId: source
    });

    expect(founded.territoryFlagIds).toHaveLength(6);
    await expect(pool.query(
      `SELECT control_type, kingdom_id, owner_id, lat, lon, claim_radius_m
       FROM flags WHERE id = $1`,
      [kingdomFlag]
    )).resolves.toMatchObject({ rows: before.rows });
    await expect(pool.query(
      `SELECT count(*)::int AS overlap_count
       FROM flags city_flag
       JOIN flags kingdom_flag ON kingdom_flag.id = $2
       WHERE city_flag.city_id = $1
         AND city_flag.control_type = 'city'
         AND ST_Distance(city_flag.geom::geography, kingdom_flag.geom::geography)
             < city_flag.claim_radius_m + kingdom_flag.claim_radius_m - 0.05`,
      [founded.city.id, kingdomFlag]
    )).resolves.toMatchObject({ rows: [{ overlap_count: 0 }] });
  });

  it("rolls back the city and preserves inventory when Kingdom territory blocks every ring", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504, 500);
    const kingdomFlags: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      kingdomFlags.push(await createFlagAtDistance(
        pool, "e", source, 1_201, index * 72, 500
      ));
    }
    const kingdomId = await createKingdomMembership(pool, "e");
    await pool.query(
      `UPDATE flags
       SET control_type = 'kingdom', kingdom_id = $2,
           kingdom_affiliated_at = now(), kingdom_affiliated_by_player_id = 'e',
           original_owner_player_id = owner_id, contributed_by_player_id = 'e',
           original_personal_color = '#38bdf8'
       WHERE id = ANY($1::uuid[])`,
      [kingdomFlags, kingdomId]
    );
    const inventoryBefore = await pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity), 0)::text AS quantity
       FROM player_inventory WHERE player_id = 'a'`
    );

    await expect(cityService(pool, albuquerque).foundCity(player("a", "Ash"), {
      requestId: "blocked-full-footprint",
      flagId: source
    })).rejects.toMatchObject({
      code: "CITY_FULL_FOOTPRINT_UNAVAILABLE",
      message: expect.stringContaining("minimum territory")
    });

    await expect(pool.query("SELECT count(*)::int AS count FROM cities"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool.query(
      "SELECT control_type, city_id FROM flags WHERE id = $1",
      [source]
    )).resolves.toMatchObject({
      rows: [{ control_type: "personal", city_id: null }]
    });
    await expect(pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity), 0)::text AS quantity
       FROM player_inventory WHERE player_id = 'a'`
    )).resolves.toEqual(inventoryBefore);
  });

  it("rolls back annexation, generated flags, and the city after a late write failure", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504, 500);
    const annexable = await createFlagAtDistance(pool, "a", source, 500.06, 0, 500);
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_founding_generated_history()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.reason = 'founding_generated' THEN
          RAISE EXCEPTION 'forced late founding failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_founding_generated_history
      BEFORE INSERT ON city_flag_affiliation_history
      FOR EACH ROW EXECUTE FUNCTION reject_founding_generated_history();
    `);

    try {
      await expect(cityService(pool, albuquerque).foundCity(player("a", "Ash"), {
        requestId: "late-founding-failure",
        flagId: source
      })).rejects.toThrow("forced late founding failure");
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_founding_generated_history
          ON city_flag_affiliation_history;
        DROP FUNCTION IF EXISTS reject_founding_generated_history();
      `);
    }

    await expect(pool.query("SELECT count(*)::int AS count FROM cities"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool.query(
      `SELECT id, control_type, city_id
       FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[source, annexable]]
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        { id: source, control_type: "personal", city_id: null },
        { id: annexable, control_type: "personal", city_id: null }
      ])
    });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM city_flag_affiliation_history"
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("rejects a real flag-row mutation after World preflight", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504);
    const before = await pool.query<{ updated_at: string }>(
      "SELECT updated_at::text FROM flags WHERE id = $1",
      [source]
    );
    const service = cityService(pool, albuquerque, "main", async () => {
      await pool.query(
        `UPDATE flags
         SET lat = $2, geom = ST_SetSRID(ST_MakePoint(lon, $2), 4326)
         WHERE id = $1`,
        [source, 35.0845]
      );
    });

    await expect(service.foundCity(player("a", "Ash"), {
      requestId: "mutated-after-world-preflight",
      flagId: source
    })).rejects.toMatchObject({ code: "CITY_FLAG_LIFECYCLE_CHANGED" });
    const after = await pool.query<{ updated_at: string; city_id: string | null }>(
      "SELECT updated_at::text, city_id FROM flags WHERE id = $1",
      [source]
    );
    expect(after.rows[0]!.updated_at).not.toBe(before.rows[0]!.updated_at);
    expect(after.rows[0]!.city_id).toBeNull();
  });

  it("enforces one canonical municipality per world under concurrent founding", async () => {
    const firstFlag = await createFlag(pool, "a", 35.0744, -106.6504);
    const secondFlag = await createFlag(pool, "b", 35.0944, -106.6504);
    const service = cityService(pool, albuquerque);
    const attempts = await Promise.allSettled([
      service.foundCity(player("a", "Ash", 35.0744), {
        requestId: "race-a", flagId: firstFlag
      }),
      service.foundCity(player("b", "Bex", 35.0944), {
        requestId: "race-b", flagId: secondFlag
      })
    ]);

    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM cities
       WHERE world_id = 'main' AND canonical_municipality_id = $1`,
      [albuquerque.settlementId]
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("serializes overlapping founding footprints without partial cities", async () => {
    const firstFlag = await createFlag(pool, "a", 35.0844, -106.6504, 500);
    const secondFlag = await createFlagAtDistance(pool, "b", firstFlag, 500.06, 0, 500);
    const secondPosition = await pool.query<{ lat: number; lon: number }>(
      "SELECT lat, lon FROM flags WHERE id = $1",
      [secondFlag]
    );
    const position = secondPosition.rows[0]!;
    const attempts = await Promise.allSettled([
      cityService(pool, albuquerque).foundCity(player("a", "Ash"), {
        requestId: "overlapping-found-a",
        flagId: firstFlag
      }),
      cityService(pool, santaFe).foundCity(
        player("b", "Bex", Number(position.lat), Number(position.lon)),
        {
          requestId: "overlapping-found-b",
          flagId: secondFlag
        }
      )
    ]);

    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(pool.query(
      `SELECT count(DISTINCT city_id)::int AS cities,
              count(*)::int AS flags
       FROM flags WHERE city_id IS NOT NULL`
    )).resolves.toMatchObject({ rows: [{ cities: 1, flags: 6 }] });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM cities"
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("reconciles a retained city authority while preserving its City Center and relationships", async () => {
    const vista = {
      ...municipality(
        "e5da8b8f-ff5e-5557-87f9-abb06cb02ee4",
        "Chalmette Vista",
        "US-LA",
        "Saint Bernard Parish"
      ),
      sourceSettlementId: "00000000-0000-4000-8000-000000900003",
      settlementClass: "hamlet",
      sourceClass: "hamlet"
    };
    const chalmette = {
      ...municipality(
        "5f7c60a1-9cee-537e-9e8a-2923f96871cb",
        "Chalmette",
        "US-LA",
        "Saint Bernard Parish"
      ),
      sourceSettlementId: "00000000-0000-4000-8000-000000900004",
      settlementClass: "town",
      sourceClass: "town",
      settlementReleaseId: "world-settlements-v2",
      settlementReleaseFingerprint: "a".repeat(64),
      resolution: {
        policyId: "primary-settlement-resolution-v1",
        selectedAs: "primary_locality" as const,
        candidateCount: 1
      }
    };
    const source = await createFlag(pool, "a", 29.9511, -90.0715);
    const service = cityService(pool, vista);
    const founded = await service.foundCity(
      player("a", "Ash", 29.9511, -90.0715),
      {
      requestId: "found-vista-before-v2",
      flagId: source
      }
    );
    const before = await pool.query<{
      founder_player_id: string;
      mayor_player_id: string | null;
      created_at: string;
      spatial_revision: string;
    }>(
      `SELECT founder_player_id, mayor_player_id, created_at::text, spatial_revision::text
       FROM cities WHERE id=$1`,
      [founded.city.id]
    );
    const relatedBefore = await pool.query<{
      memberships: string;
      discoveries: string;
      history: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM city_memberships WHERE city_id=$1) memberships,
         (SELECT count(*)::text FROM player_discovered_cities WHERE city_id=$1) discoveries,
         (SELECT count(*)::text FROM city_flag_affiliation_history WHERE city_id=$1) history`,
      [founded.city.id]
    );
    const authority = {
      releaseId: chalmette.settlementReleaseId,
      releaseFingerprint: chalmette.settlementReleaseFingerprint,
      foundingPolicyId: chalmette.foundingPolicyId,
      foundingPolicyFingerprint: chalmette.foundingPolicyFingerprint,
      resolutionPolicyId: chalmette.resolutionPolicyId,
      resolutionPolicyFingerprint: chalmette.resolutionPolicyFingerprint
    };
    const lookupSettlement = async () => ({
      found: true as const,
      inside: true as const,
      settlement: chalmette,
      nearest: null,
      authority
    });
    const plan = await planCitySettlementReconciliation({
      pool,
      lookupSettlement,
      worldId: "main",
      authority
    });
    expect(plan).toMatchObject({ ok: true, inspectedCount: 1, changedCount: 1, conflicts: [] });

    const applied = await applyCitySettlementReconciliation(pool, plan, "integration-test");
    expect(applied).toMatchObject({ applied: true, changedCount: 1 });
    const after = await pool.query(
      `SELECT id, canonical_municipality_id, world_settlement_id,
              world_source_settlement_id, name, settlement_class,
              settlement_release_id, settlement_release_fingerprint,
              settlement_resolution_policy_id, settlement_resolution_policy_fingerprint,
              founder_player_id, mayor_player_id, seat_flag_id, created_at::text,
              spatial_revision::text
       FROM cities WHERE id=$1`,
      [founded.city.id]
    );
    expect(after.rows[0]).toMatchObject({
      id: founded.city.id,
      canonical_municipality_id: chalmette.settlementId,
      world_settlement_id: chalmette.settlementId,
      world_source_settlement_id: chalmette.sourceSettlementId,
      name: "Chalmette",
      settlement_class: "town",
      settlement_release_id: "world-settlements-v2",
      founder_player_id: before.rows[0]!.founder_player_id,
      mayor_player_id: before.rows[0]!.mayor_player_id,
      seat_flag_id: source,
      created_at: before.rows[0]!.created_at,
      spatial_revision: String(Number(before.rows[0]!.spatial_revision) + 1)
    });
    await expect(pool.query(
      "SELECT control_type, city_id FROM flags WHERE id=$1",
      [source]
    )).resolves.toMatchObject({
      rows: [{ control_type: "city_seat", city_id: founded.city.id }]
    });
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::text FROM city_memberships WHERE city_id=$1) memberships,
         (SELECT count(*)::text FROM player_discovered_cities WHERE city_id=$1) discoveries,
         (SELECT count(*)::text FROM city_flag_affiliation_history WHERE city_id=$1) history`,
      [founded.city.id]
    )).resolves.toMatchObject({ rows: relatedBefore.rows });
    await expect(pool.query(
      "SELECT count(*)::text AS count FROM city_settlement_reconciliation_events WHERE run_id=$1",
      [applied.runId]
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });

    const repeat = await planCitySettlementReconciliation({
      pool,
      lookupSettlement,
      worldId: "main",
      authority
    });
    expect(repeat).toMatchObject({ ok: true, changedCount: 0, unchangedCount: 1 });
    await expect(
      applyCitySettlementReconciliation(pool, repeat, "integration-test")
    ).resolves.toEqual({ applied: false, runId: null, changedCount: 0 });
    const reversed = await reverseCitySettlementReconciliation(
      pool,
      applied.runId!,
      "integration-test-rollback"
    );
    expect(reversed).toMatchObject({ applied: true, changedCount: 1 });
    await expect(pool.query(
      `SELECT canonical_municipality_id, name, seat_flag_id
       FROM cities WHERE id=$1`,
      [founded.city.id]
    )).resolves.toMatchObject({
      rows: [{
        canonical_municipality_id: vista.settlementId,
        name: "Chalmette Vista",
        seat_flag_id: source
      }]
    });
  });

  it("allows the same municipality in another world and same-name municipalities in distinct jurisdictions", async () => {
    const mainFlag = await createFlag(pool, "a", 35.0744, -106.6504);
    const mainService = cityService(pool, albuquerque);
    const mainCity = await mainService.foundCity(player("a", "Ash", 35.0744), {
      requestId: "main-world", flagId: mainFlag
    });

    const otherWorldFlag = await createFlag(pool, "b", 35.0944, -106.6504);
    const otherWorldService = cityService(pool, albuquerque, "other-world");
    const otherWorldCity = await otherWorldService.foundCity(
      player("b", "Bex", 35.0944),
      { requestId: "other-world", flagId: otherWorldFlag }
    );
    expect(mainCity.city.id).not.toBe(otherWorldCity.city.id);
    const springfieldIllinois = municipality(randomUUID(), "Springfield", "US-IL", "Illinois");
    const springfieldMissouri = municipality(randomUUID(), "Springfield", "US-MO", "Missouri");
    const illinoisFlag = await createFlag(pool, "d", 35.1144, -106.6504);
    const missouriFlag = await createFlag(pool, "e", 35.1344, -106.6504);
    const illinois = await cityService(pool, springfieldIllinois).foundCity(
      player("d", "Dee", 35.1144),
      { requestId: "springfield-il", flagId: illinoisFlag }
    );
    const missouri = await cityService(pool, springfieldMissouri).foundCity(
      player("e", "Eve", 35.1344),
      { requestId: "springfield-mo", flagId: missouriFlag }
    );

    expect(illinois.city.worldSettlementId).not.toBe(missouri.city.worldSettlementId);
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM cities WHERE name = 'Springfield'"
    )).resolves.toMatchObject({ rows: [{ count: "2" }] });
  });

  it.skip("joins publicly and idempotently without converting any personal flags", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504);
    const personal = await createFlag(pool, "b", 35.1044, -106.6504);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-public", flagId: source
    });

    const joined = await service.joinCity("b", {
      requestId: "join-public", cityId: founded.city.id
    });
    const replay = await service.joinCity("b", {
      requestId: "join-public", cityId: founded.city.id
    });

    expect(joined).toMatchObject({
      membership: { cityId: founded.city.id, role: "member" },
      replayed: false
    });
    expect(replay.replayed).toBe(true);
    await expect(pool.query(
      "SELECT control_type, city_id FROM flags WHERE id = $1",
      [personal]
    )).resolves.toMatchObject({ rows: [{ control_type: "personal", city_id: null }] });
  });

  it.skip("serializes concurrent public joins and permits only one active city per world", async () => {
    const albuquerqueSeat = await createFlag(pool, "a", 35.0844, -106.6504);
    const santaFeSeat = await createFlag(pool, "c", 35.6844, -105.9504);
    const albuquerqueService = cityService(pool, albuquerque);
    const santaFeService = cityService(pool, santaFe);
    const cityA = await albuquerqueService.foundCity(player("a", "Ash"), {
      requestId: "found-concurrent-a", flagId: albuquerqueSeat
    });
    const cityB = await santaFeService.foundCity(
      player("c", "Cy", 35.6844, -105.9504),
      { requestId: "found-concurrent-b", flagId: santaFeSeat }
    );
    await albuquerqueService.joinCity("d", {
      requestId: "join-a-before-b", cityId: cityA.city.id
    });
    await expect(santaFeService.joinCity("d", {
      requestId: "reject-b-after-a", cityId: cityB.city.id
    })).rejects.toMatchObject({
      code: "CITY_INCOMPATIBLE_AFFILIATION",
      message: "You are already a member of Albuquerque. Leave that city before joining Santa Fe."
    });

    const sameCity = await Promise.all([
      albuquerqueService.joinCity("b", {
        requestId: "same-city-1", cityId: cityA.city.id
      }),
      albuquerqueService.joinCity("b", {
        requestId: "same-city-2", cityId: cityA.city.id
      })
    ]);
    expect(sameCity.filter(({ replayed }) => replayed)).toHaveLength(1);
    await albuquerqueService.leaveCity("b", {
      requestId: "leave-before-race", cityId: cityA.city.id
    });

    const differentCities = await Promise.allSettled([
      albuquerqueService.joinCity("b", {
        requestId: "different-city-a", cityId: cityA.city.id
      }),
      santaFeService.joinCity("b", {
        requestId: "different-city-b", cityId: cityB.city.id
      })
    ]);
    expect(differentCities.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(differentCities.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM city_memberships
       WHERE player_id = 'b' AND world_id = 'main' AND left_at IS NULL`
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it.skip("lets ordinary and historical-founder members leave without changing city assets", async () => {
    const seat = await createFlag(pool, "a", 35.0844, -106.6504);
    const memberPersonal = await createFlag(pool, "b", 35.1044, -106.6504);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-leaving", flagId: seat
    });
    await service.joinCity("b", { requestId: "join-leaving", cityId: founded.city.id });

    const left = await service.leaveCity("b", {
      requestId: "leave-member", cityId: founded.city.id
    });
    expect(left.replayed).toBe(false);
    await expect(service.leaveCity("b", {
      requestId: "leave-member", cityId: founded.city.id
    })).resolves.toMatchObject({ replayed: true });
    await expect(service.leaveCity("b", {
      requestId: "leave-member-again", cityId: founded.city.id
    })).resolves.toMatchObject({ replayed: true });

    await expect(service.leaveCity("a", {
      requestId: "mayor-cannot-leave", cityId: founded.city.id
    })).rejects.toMatchObject({
      code: "CITY_MAYOR_MUST_RELINQUISH",
      message: "You must relinquish Mayor before leaving the city."
    });
    await service.relinquishMayor("a", {
      requestId: "relinquish-before-leave", cityId: founded.city.id
    });
    await expect(service.leaveCity("a", {
      requestId: "founder-leaves", cityId: founded.city.id
    })).resolves.toMatchObject({ replayed: false });

    await expect(pool.query(
      `SELECT founder_player_id, mayor_player_id, active, seat_flag_id
       FROM cities WHERE id = $1`,
      [founded.city.id]
    )).resolves.toMatchObject({
      rows: [{
        founder_player_id: "a",
        mayor_player_id: null,
        active: true,
        seat_flag_id: seat
      }]
    });
    await expect(pool.query(
      "SELECT id, control_type, city_id FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[seat, memberPersonal]]
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ id: seat, control_type: "city_seat", city_id: founded.city.id }),
        expect.objectContaining({ id: memberPersonal, control_type: "personal", city_id: null })
      ])
    });
  });

  it.skip("allows multiple historical foundings after explicit relinquish and leave", async () => {
    const firstSeat = await createFlag(pool, "a", 35.0844, -106.6504);
    const secondSeat = await createFlag(pool, "a", 35.6844, -105.9504);
    const firstService = cityService(pool, albuquerque);
    const first = await firstService.foundCity(player("a", "Ash"), {
      requestId: "first-founding", flagId: firstSeat
    });

    await expect(cityService(pool, santaFe).foundCity(
      player("a", "Ash", 35.6844, -105.9504),
      { requestId: "blocked-second-founding", flagId: secondSeat }
    )).rejects.toMatchObject({
      code: "CITY_INCOMPATIBLE_AFFILIATION",
      message: "Leave Albuquerque before founding another city"
    });

    await firstService.relinquishMayor("a", {
      requestId: "relinquish-first-city", cityId: first.city.id
    });
    await firstService.leaveCity("a", {
      requestId: "leave-first-city", cityId: first.city.id
    });
    const second = await cityService(pool, santaFe).foundCity(
      player("a", "Ash", 35.6844, -105.9504),
      { requestId: "second-founding", flagId: secondSeat }
    );

    await expect(pool.query<{
      founder_count: string;
      historical_memberships: string;
      active_memberships: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM cities WHERE founder_player_id = 'a') AS founder_count,
         (SELECT count(*)::text FROM city_memberships WHERE player_id = 'a') AS historical_memberships,
         (SELECT count(*)::text FROM city_memberships
          WHERE player_id = 'a' AND world_id = 'main' AND left_at IS NULL) AS active_memberships`
    )).resolves.toMatchObject({
      rows: [{
        founder_count: "2",
        historical_memberships: "2",
        active_memberships: "1"
      }]
    });
    expect(second.city.founderPlayerId).toBe("a");
  });

  it.skip("rejects public joining for an existing Kingdom member without removing that membership", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-conflict", flagId: source
    });
    const kingdomId = await createKingdomMembership(pool, "b");

    await expect(service.joinCity("b", {
      requestId: "join-conflict", cityId: founded.city.id
    })).rejects.toMatchObject({ code: "CITY_INCOMPATIBLE_AFFILIATION" });
    await expect(pool.query(
      "SELECT status FROM kingdom_memberships WHERE kingdom_id = $1 AND player_id = 'b'",
      [kingdomId]
    )).resolves.toMatchObject({ rows: [{ status: "active" }] });
  });

  it("explicitly converts only connected member flags, beyond the municipality, and rejects foreign bridges", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504, 700);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-expansion", flagId: source
    });
    await createHouseMembership(pool, founded.city.id, "a", "mayor");
    await createHouseMembership(pool, founded.city.id, "b");

    const connected = await createFlagAtDistance(pool, "b", source, 1_400, 90, 700);
    const disconnected = await createFlagAtDistance(pool, "b", source, 5_000, 90, 700);
    const lookupCallsBefore = (service as unknown as { worldLookup: { lookupSettlement: ReturnType<typeof vi.fn> } })
      .worldLookup.lookupSettlement.mock.calls.length;
    const converted = await service.convertCityFlag("b", {
      requestId: "convert-connected", flagId: connected
    });
    expect(converted).toMatchObject({ cityId: founded.city.id, flagId: connected, replayed: false });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM city_memberships WHERE city_id = $1 AND left_at IS NULL",
      [founded.city.id]
    )).resolves.toMatchObject({ rows: [{ count: "2" }] });
    await expect(service.convertCityFlag("b", {
      requestId: "convert-disconnected", flagId: disconnected
    })).rejects.toMatchObject({ code: "CITY_FLAG_NOT_CONNECTED" });
    const lookupCallsAfter = (service as unknown as { worldLookup: { lookupSettlement: ReturnType<typeof vi.fn> } })
      .worldLookup.lookupSettlement.mock.calls.length;
    expect(lookupCallsAfter).toBe(lookupCallsBefore);

    const foreignCandidate = await createFlagAtDistance(pool, "b", connected, 1_400, 90, 700);
    const kingdomTouch = await createFlagAtDistance(pool, "c", foreignCandidate, 1_400, 0, 700);
    await convertToKingdomFlag(pool, kingdomTouch, "c");
    await expect(service.convertCityFlag("b", {
      requestId: "foreign-bridge", flagId: foreignCandidate
    })).rejects.toMatchObject({ code: "CITY_FLAG_FOREIGN_CONNECTION" });
  });

  it("allows bastion flags but explicitly rejects Atlas Shrines without mutation", async () => {
    const seat = await createFlag(pool, "a", 35.0844, -106.6504, 700);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-tier-check", flagId: seat
    });
    await createHouseMembership(pool, founded.city.id, "a", "mayor");
    await createHouseMembership(pool, founded.city.id, "b");

    const hardened = await createFlagAtDistance(pool, "b", seat, 1_400, 45, 700);
    await pool.query(
      "UPDATE flags SET reinforcement_level = 1, health = 200, maximum_health = 200 WHERE id = $1",
      [hardened]
    );
    await expect(
      service.previewCityFlagConversion("b", hardened)
    ).resolves.toMatchObject({ flagId: hardened, cityId: founded.city.id });
    await expect(service.convertCityFlag("b", {
      requestId: "convert-hardened", flagId: hardened
    })).resolves.toMatchObject({ flagId: hardened, replayed: false });
    await expect(service.replayCityFlagConversion("b", {
      requestId: "convert-hardened", flagId: hardened
    })).resolves.toMatchObject({
      flagId: hardened,
      cityId: founded.city.id,
      replayed: true
    });

    const encounterFlag = await createFlagAtDistance(pool, "b", seat, 1_400, 135, 700);
    await pool.query(
      "UPDATE flags SET reinforcement_level = 1, health = 200, maximum_health = 200 WHERE id = $1",
      [encounterFlag]
    );
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
       ) VALUES ($1,$2,'fire',$3,'b',$2,$4)`,
      [randomUUID(), cycleStartedAt, encounterFlag, expiresAt]
    );
    await expect(service.convertCityFlag("b", {
      requestId: "convert-live-encounter", flagId: encounterFlag
    })).rejects.toMatchObject({ code: "CITY_FLAG_LIFECYCLE_CHANGED" });
    await expect(pool.query(
      "SELECT control_type,city_id FROM flags WHERE id=$1",
      [encounterFlag]
    )).resolves.toMatchObject({ rows: [{ control_type: "personal", city_id: null }] });

    const shrine = await createFlagAtDistance(pool, "b", seat, 1_400, 315, 700);
    await pool.query(
      "UPDATE flags SET reinforcement_level = 2 WHERE id = $1",
      [shrine]
    );
    await expect(
      service.previewCityFlagConversion("b", shrine)
    ).rejects.toMatchObject({
      code: "CITY_FLAG_ATLAS_SHRINE_INELIGIBLE",
      message: "Atlas Shrines cannot be contributed to a city"
    });
    await expect(service.convertCityFlag("b", {
      requestId: "convert-shrine", flagId: shrine
    })).rejects.toMatchObject({
      code: "CITY_FLAG_ATLAS_SHRINE_INELIGIBLE"
    });
    await expect(pool.query(
      "SELECT control_type, city_id FROM flags WHERE id = $1",
      [shrine]
    )).resolves.toMatchObject({
      rows: [{ control_type: "personal", city_id: null }]
    });
  });

  it("replaces personal access restrictions when a flag becomes city-controlled", async () => {
    const seat = await createFlag(pool, "a", 35.0844, -106.6504, 700);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-custom-access", flagId: seat
    });
    await createHouseMembership(pool, founded.city.id, "a", "mayor");
    await createHouseMembership(pool, founded.city.id, "b");
    const personalFlag = await createFlagAtDistance(pool, "b", seat, 1_400, 90, 700);
    const access = new FlagAccessService(pool);
    await access.updateSettings({
      ownerPlayerId: "b",
      flagId: personalFlag,
      mode: "private",
      jumpTollGold: "0"
    });
    await pool.query(
      "INSERT INTO player_enemy_marks (owner_id,target_id) VALUES ($1,$2)",
      ["b", "e"]
    );

    await service.convertCityFlag("b", {
      requestId: "convert-personal-access", flagId: personalFlag
    });

    await expect(pool.query(
      `SELECT access_mode, jump_toll_gold::text,
              control_type
       FROM flags WHERE id = $1`,
      [personalFlag]
    )).resolves.toMatchObject({
      rows: [{
        access_mode: "public",
        jump_toll_gold: "0",
        control_type: "city"
      }]
    });
    for (const traveler of ["c", "d", "e"]) {
      await expect(access.authorize(personalFlag, traveler)).resolves.toMatchObject({
        controlType: "city",
        decision: { allowed: true, reasonCode: "ALLOWED_PUBLIC", tollGold: "0" }
      });
    }

    const restartedCities = cityService(pool, albuquerque);
    await expect(restartedCities.getMembership("b")).resolves.toMatchObject({
      cityId: founded.city.id,
      expansionFlagCount: 6,
      expansionFlagLimit: 11
    });
    await expect(restartedCities.getCityInfo("e", founded.city.id)).resolves.toMatchObject({
      memberCount: 2,
      expansionFlagCount: 6,
      expansionFlagLimit: 11
    });
    await expect(new FlagAccessService(pool).authorize(personalFlag, "e")).resolves.toMatchObject({
      decision: { allowed: true, reasonCode: "ALLOWED_PUBLIC" }
    });
  });

  it("derives expansion capacity from durable membership while keeping the City Center free", async () => {
    const seat = await createFlag(pool, "a", 35.0844, -106.6504, 700);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-capacity-members", flagId: seat
    });
    await createHouseMembership(pool, founded.city.id, "a", "mayor");
    await expect(service.getMembership("a")).resolves.toMatchObject({
      expansionFlagCount: 5,
      expansionFlagLimit: 6
    });
    await createHouseMembership(pool, founded.city.id, "b");
    await expect(service.getMembership("a")).resolves.toMatchObject({
      expansionFlagCount: 5,
      expansionFlagLimit: 11
    });
    await createHouseMembership(pool, founded.city.id, "c");
    await expect(service.getMembership("a")).resolves.toMatchObject({
      expansionFlagCount: 5,
      expansionFlagLimit: 16
    });
    await endHouseMembership(pool, founded.city.id, "c");
    await endHouseMembership(pool, founded.city.id, "b");
    await endHouseMembership(pool, founded.city.id, "a");
    await expect(service.getCityInfo("a", founded.city.id)).resolves.toMatchObject({
      memberCount: 0,
      expansionFlagCount: 5,
      expansionFlagLimit: 6
    });
    await expect(pool.query(
      `SELECT
         count(*) FILTER (WHERE control_type = 'city_seat')::int AS seats,
         count(*) FILTER (WHERE control_type = 'city')::int AS expansions
       FROM flags WHERE city_id = $1`,
      [founded.city.id]
    )).resolves.toMatchObject({ rows: [{ seats: 1, expansions: 5 }] });
  });

  it("uses the remaining one-member expansion slot and rejects another", async () => {
    const seat = await createFlag(pool, "a", 35.0844, -106.6504, 700);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-six-capacity", flagId: seat
    });
    await createHouseMembership(pool, founded.city.id, "a", "mayor");
    const expansions: string[] = [];
    for (let index = 0; index < 1; index += 1) {
      const flag = await createFlagAtDistance(pool, "a", seat, 1_400, index * 30, 700);
      expansions.push(flag);
      await service.convertCityFlag("a", {
        requestId: `convert-six-${index}`, flagId: flag
      });
    }
    const seventh = await createFlagAtDistance(pool, "a", seat, 1_400, 30, 700);
    await expect(service.convertCityFlag("a", {
      requestId: "convert-seventh", flagId: seventh
    })).rejects.toMatchObject({
      code: "CITY_EXPANSION_LIMIT_REACHED",
      message: "City expansion limit reached: 6 of 6 flags."
    });
    await expect(pool.query(
      `SELECT
         count(*) FILTER (WHERE control_type = 'city_seat')::int AS seats,
         count(*) FILTER (WHERE control_type = 'city')::int AS expansions,
         bool_and(access_mode = 'public' AND jump_toll_gold = 0) AS fully_public
       FROM flags WHERE city_id = $1`,
      [founded.city.id]
    )).resolves.toMatchObject({
      rows: [{ seats: 1, expansions: 6, fully_public: true }]
    });
    await expect(new FlagAccessService(pool).authorize(expansions[0]!, "e"))
      .resolves.toMatchObject({
        controlType: "city",
        decision: { allowed: true, reasonCode: "ALLOWED_PUBLIC", tollGold: "0" }
      });
  });

  it("preserves over-capacity flags after membership loss and blocks further conversion", async () => {
    const seat = await createFlag(pool, "a", 35.0844, -106.6504, 700);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-over-capacity", flagId: seat
    });
    await createHouseMembership(pool, founded.city.id, "a", "mayor");
    await createHouseMembership(pool, founded.city.id, "b");
    for (let index = 0; index < 6; index += 1) {
      const flag = await createFlagAtDistance(pool, "a", seat, 1_400, index * 30, 700);
      await service.convertCityFlag("a", {
        requestId: `convert-over-${index}`, flagId: flag
      });
    }
    await endHouseMembership(pool, founded.city.id, "b");
    await expect(service.getCityInfo("a", founded.city.id)).resolves.toMatchObject({
      memberCount: 1,
      expansionFlagCount: 11,
      expansionFlagLimit: 6
    });
    const blocked = await createFlagAtDistance(pool, "a", seat, 1_400, 240, 700);
    await expect(service.convertCityFlag("a", {
      requestId: "blocked-over-capacity", flagId: blocked
    })).rejects.toMatchObject({
      code: "CITY_EXPANSION_LIMIT_REACHED",
      message: "City expansion limit reached: 11 of 6 flags (over capacity)."
    });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM flags WHERE city_id = $1 AND control_type = 'city'",
      [founded.city.id]
    )).resolves.toMatchObject({ rows: [{ count: 11 }] });
  });

  it("serializes different members competing for the final expansion slot", async () => {
    const seat = await createFlag(pool, "a", 35.0844, -106.6504, 700);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-concurrent-capacity", flagId: seat
    });
    await createHouseMembership(pool, founded.city.id, "a", "mayor");
    await createHouseMembership(pool, founded.city.id, "b");
    for (let index = 0; index < 5; index += 1) {
      const flag = await createFlagAtDistance(pool, "a", seat, 1_400, index * 30, 700);
      await service.convertCityFlag("a", {
        requestId: `convert-concurrent-fill-${index}`, flagId: flag
      });
    }
    const candidateA = await createFlagAtDistance(pool, "a", seat, 1_400, 150, 700);
    const candidateB = await createFlagAtDistance(pool, "b", seat, 1_400, 180, 700);
    const attempts = await Promise.allSettled([
      service.convertCityFlag("a", {
        requestId: "convert-concurrent-a", flagId: candidateA
      }),
      service.convertCityFlag("b", {
        requestId: "convert-concurrent-b", flagId: candidateB
      })
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(attempts.find(({ status }) => status === "rejected")).toMatchObject({
      reason: {
        code: "CITY_EXPANSION_LIMIT_REACHED",
        message: "City expansion limit reached: 11 of 11 flags."
      }
    });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM flags WHERE city_id = $1 AND control_type = 'city'",
      [founded.city.id]
    )).resolves.toMatchObject({ rows: [{ count: 11 }] });
  });

  it("gives converted flags to the city and breaks flags cut off from the City Center", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504, 700);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-pruning", flagId: source
    });
    await createHouseMembership(pool, founded.city.id, "a", "mayor");
    await createHouseMembership(pool, founded.city.id, "b");
    const bridge = await createFlagAtDistance(pool, "b", source, 1_400, 90, 700);
    await service.convertCityFlag("b", {
      requestId: "convert-bridge", flagId: bridge
    });
    const downstream = await createFlagAtDistance(pool, "b", bridge, 1_400, 90, 700);
    await service.convertCityFlag("b", {
      requestId: "convert-downstream", flagId: downstream
    });

    // The contributor no longer owns the converted flag; the Mayor manages it.
    await expect(pool.query(
      "SELECT owner_id FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[bridge, downstream]]
    )).resolves.toMatchObject({ rows: [{ owner_id: "a" }, { owner_id: "a" }] });
    await expect(pool.query(
      `SELECT metadata->>'originalOwnerPlayerId' AS original FROM city_flag_affiliation_history
       WHERE flag_id = $1 AND action = 'affiliated'`,
      [bridge]
    )).resolves.toMatchObject({ rows: [{ original: "b" }] });
    await expect(
      assertCityFlagAction(pool, "c", founded.city.id)
    ).rejects.toMatchObject({ code: "CITY_PERMISSION_DENIED" });
    await expect(
      assertCityFlagAction(pool, "b", founded.city.id)
    ).rejects.toMatchObject({ code: "CITY_PERMISSION_DENIED" });
    await expect(
      assertCityFlagAction(pool, "a", founded.city.id)
    ).resolves.toBeUndefined();
    const client = await pool.connect();
    await client.query("BEGIN");
    const pruned = await clearAndPruneCityFlags(
      client,
      founded.city.id,
      [bridge],
      "b",
      "flag_deleted",
      "flag_deleted"
    );
    await client.query("COMMIT");
    client.release();

    // The caller deletes the initial flag; the cut-off flag breaks instead of
    // reverting to personal control.
    expect(pruned.affectedFlagIds).toEqual([downstream]);
    await expect(pool.query(
      "SELECT id, control_type, city_id FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[bridge, downstream]]
    )).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: bridge, control_type: "city" })]
    });
    await expect(pool.query(
      "SELECT control_type, city_id FROM flags WHERE id = $1",
      [source]
    )).resolves.toMatchObject({
      rows: [{ control_type: "city_seat", city_id: founded.city.id }]
    });
  });

  it.skip("lets the founding Mayor relinquish and one current member claim vacant control", async () => {
    const source = await createFlag(pool, "a", 35.0844, -106.6504);
    const service = cityService(pool, albuquerque);
    const founded = await service.foundCity(player("a", "Ash"), {
      requestId: "found-mayor", flagId: source
    });
    await service.joinCity("b", { requestId: "join-mayor-b", cityId: founded.city.id });
    await service.joinCity("c", { requestId: "join-mayor-c", cityId: founded.city.id });

    await expect(service.relinquishMayor("b", {
      requestId: "member-relinquish", cityId: founded.city.id
    })).rejects.toMatchObject({ code: "CITY_MAYOR_PERMISSION_DENIED" });
    await expect(service.claimMayor("d", {
      requestId: "nonmember-claim", cityId: founded.city.id
    })).rejects.toMatchObject({ code: "CITY_MAYOR_REQUIRED_MEMBERSHIP" });

    const relinquished = await service.relinquishMayor("a", {
      requestId: "relinquish-mayor", cityId: founded.city.id
    });
    expect(relinquished.city.mayorPlayerId).toBeNull();
    await expect(service.relinquishMayor("a", {
      requestId: "relinquish-mayor", cityId: founded.city.id
    })).resolves.toMatchObject({ replayed: true, city: { mayorPlayerId: null } });
    await expect(service.getMembership("a")).resolves.toMatchObject({ role: "member" });

    const attempts = await Promise.allSettled([
      service.claimMayor("b", { requestId: "claim-mayor-b", cityId: founded.city.id }),
      service.claimMayor("c", { requestId: "claim-mayor-c", cityId: founded.city.id })
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const winner = attempts.find(({ status }) => status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("mayor claim did not succeed");
    const winnerId = winner.value.city.mayorPlayerId;
    expect(winnerId === "b" || winnerId === "c").toBe(true);
    await expect(service.claimMayor(winnerId!, {
      requestId: winnerId === "b" ? "claim-mayor-b" : "claim-mayor-c",
      cityId: founded.city.id
    })).resolves.toMatchObject({ replayed: true, city: { mayorPlayerId: winnerId } });
    await expect(service.getMembership(winnerId!)).resolves.toMatchObject({ role: "mayor" });
    await expect(service.getMembership(winnerId === "b" ? "c" : "b")).resolves.toMatchObject({
      role: "member"
    });
    await expect(assertCityFlagAction(pool, winnerId!, founded.city.id))
      .resolves.toBeUndefined();
    await expect(assertCityFlagAction(pool, "a", founded.city.id))
      .rejects.toMatchObject({ code: "CITY_PERMISSION_DENIED" });
  });
});

function cityService(
  pool: pg.Pool,
  settlement: ReturnType<typeof municipality>,
  worldId = "main",
  beforeLookupResult?: () => Promise<void>,
  construction?: { inventory: InventoryService; wallet: WalletService }
): CityService {
  const lookupSettlement = vi.fn().mockImplementation(async () => {
    await beforeLookupResult?.();
    return {
      found: true,
      inside: true,
      settlement,
      nearest: null,
      authority: {
        releaseId: settlement.settlementReleaseId,
        releaseFingerprint: settlement.settlementReleaseFingerprint,
        foundingPolicyId: settlement.foundingPolicyId,
        foundingPolicyFingerprint: settlement.foundingPolicyFingerprint,
        resolutionPolicyId: settlement.resolutionPolicyId,
        resolutionPolicyFingerprint: settlement.resolutionPolicyFingerprint
      }
    };
  });
  return new CityService(
    pool,
    {
      lookupSettlement,
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
    loadConfig({ WORLD_ID: worldId }),
    { info: vi.fn(), warn: vi.fn() } as unknown as AppLogger,
    {
      settlementAuthority: () => ({
        releaseId: settlement.settlementReleaseId,
        releaseFingerprint: settlement.settlementReleaseFingerprint,
        foundingPolicyId: settlement.foundingPolicyId,
        foundingPolicyFingerprint: settlement.foundingPolicyFingerprint,
        resolutionPolicyId: settlement.resolutionPolicyId,
        resolutionPolicyFingerprint: settlement.resolutionPolicyFingerprint
      }),
      ...(construction ?? {})
    }
  );
}

function municipality(
  settlementId: string,
  name: string,
  regionCode: string,
  jurisdictionName: string
) {
  return {
    settlementId,
    source: "overture",
    sourceSettlementId: settlementId,
    name,
    countryCode: "US",
    regionCode,
    jurisdictionName,
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
      candidateCount: 2
    },
    foundingEligible: true,
    population: null,
    minimumFoundingPopulation: null,
    foundingIneligibilityReason: null
  };
}

function player(playerId: string, username: string, lat = 35.0844, lon = -106.6504): PlayerRecord {
  return {
    playerId,
    username,
    displayColor: "#38bdf8",
    regionCode: "NM",
    position: { lat, lon },
    anchor: { lat, lon },
    moveLeashRadiusM: 900,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date()
  };
}

async function createHouseMembership(
  pool: pg.Pool,
  cityId: string,
  playerId: string,
  role: "member" | "mayor" = "member"
): Promise<void> {
  const structureId = randomUUID();
  const offset = [...playerId].reduce((total, character) => total + character.codePointAt(0)!, 0) /
    10_000_000;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const city = await client.query<{
      world_id: string;
      region_code: string | null;
      hall_lat: number;
      hall_lon: number;
    }>(
      `SELECT world_id,region_code,hall_lat,hall_lon
       FROM cities WHERE id=$1 FOR UPDATE`,
      [cityId]
    );
    const row = city.rows[0]!;
    const lat = Number(row.hall_lat) + 0.001 + offset;
    const lon = Number(row.hall_lon) + offset;
    await client.query(
      `INSERT INTO city_structures (
         structure_id,city_id,structure_type,tier,owner_player_id,world_id,region_code,
         lat,lon,geom,footprint_geom,footprint_radius_m,state,build_operation_key,built_at
       ) VALUES (
         $1,$2,$3,1,$4,$5,$6,$7,$8,
         ST_SetSRID(ST_MakePoint($8,$7),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint($8,$7),4326)::geography,10)::geometry,
         10,'active',$9,now()
       )`,
      [
        structureId,
        cityId,
        role === "mayor" ? "mayor_house" : "city_house",
        playerId,
        row.world_id,
        row.region_code,
        lat,
        lon,
        `city-integration-house:${structureId}`
      ]
    );
    await client.query(
      `INSERT INTO city_memberships (
         membership_id,city_id,player_id,world_id,role,house_structure_id,joined_at
       ) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,now())`,
      [cityId, playerId, row.world_id, role, structureId]
    );
    if (role === "mayor") {
      await client.query(
        `UPDATE cities
         SET mayor_player_id=$2,mayor_confirmed_at=now(),mayor_house_deadline=NULL
         WHERE id=$1`,
        [cityId, playerId]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function endHouseMembership(
  pool: pg.Pool,
  cityId: string,
  playerId: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const membership = await client.query<{ house_structure_id: string; role: string }>(
      `UPDATE city_memberships
       SET left_at=now(),ended_reason='house_destroyed'
       WHERE city_id=$1 AND player_id=$2 AND left_at IS NULL
       RETURNING house_structure_id::text,role`,
      [cityId, playerId]
    );
    if (membership.rows[0]) {
      await client.query(
        `UPDATE city_structures
         SET state='destroyed',destroyed_at=now(),updated_at=now()
         WHERE structure_id=$1::uuid`,
        [membership.rows[0].house_structure_id]
      );
      if (membership.rows[0].role === "mayor") {
        await client.query(
          `UPDATE cities
           SET mayor_player_id=NULL,mayor_confirmed_at=NULL,mayor_house_deadline=NULL
           WHERE id=$1`,
          [cityId]
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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
       id, account_id, username, username_normalized, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
       move_leash_radius_m, online, geom
     ) VALUES ($1,$3,$2,$1,'#38bdf8','NM',35.0844,-106.6504,35.0844,-106.6504,
               900,false,ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326))`,
    [id, username, accountId]
  );
}

async function createFlag(
  pool: pg.Pool,
  ownerId: string,
  lat: number,
  lon: number,
  radius = 700
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,
             ST_SetSRID(ST_MakePoint($4,$3),4326))
     RETURNING id`,
    [ownerId, `${ownerId} flag`, lat, lon, radius]
  );
  return result.rows[0]!.id;
}

async function createFlagAtDistance(
  pool: pg.Pool,
  ownerId: string,
  sourceFlagId: string,
  distanceM: number,
  bearingDegrees: number,
  radius: number
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `WITH projected AS (
       SELECT ST_Project(
         geom::geography,
         $3::double precision,
         radians($4::double precision)
       )::geometry AS geom
       FROM flags WHERE id = $2
     )
     INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
     SELECT gen_random_uuid(),$1,$5,ST_Y(geom),ST_X(geom),$6,geom FROM projected
     RETURNING id`,
    [ownerId, sourceFlagId, distanceM, bearingDegrees, `${ownerId} projected flag`, radius]
  );
  return result.rows[0]!.id;
}

async function createKingdomMembership(pool: pg.Pool, playerId: string): Promise<string> {
  const kingdomId = randomUUID();
  await pool.query(
    `INSERT INTO kingdoms (
       id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id
     ) VALUES ($1,$2,$3,$4,$4,$5)`,
    [kingdomId, `kingdom-${kingdomId.slice(0, 8)}`, `Kingdom ${kingdomId.slice(0, 4)}`, playerId, randomUUID()]
  );
  await pool.query(
    `INSERT INTO kingdom_memberships (
       id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
     ) VALUES (gen_random_uuid(),$1,$2,'leader','active',now(),now())`,
    [kingdomId, playerId]
  );
  return kingdomId;
}

async function convertToKingdomFlag(pool: pg.Pool, flagId: string, ownerId: string): Promise<void> {
  const kingdomId = await createKingdomMembership(pool, ownerId);
  await pool.query(
    `UPDATE flags
     SET control_type = 'kingdom', kingdom_id = $2,
         kingdom_affiliated_at = now(), kingdom_affiliated_by_player_id = $3,
         original_owner_player_id = owner_id, contributed_by_player_id = $3,
         original_personal_color = '#38bdf8'
     WHERE id = $1`,
    [flagId, kingdomId, ownerId]
  );
}
