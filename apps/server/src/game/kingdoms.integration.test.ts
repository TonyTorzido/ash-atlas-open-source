import { randomUUID } from "node:crypto";

import { KINGDOM_FOUNDING_MIN_PLAYER_LEVEL, type KingdomStateSnapshot } from "@ash-atlas/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldLookupResult } from "../world/worldTypes.js";
import { FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";
import {
  KingdomService,
  type FoundKingdomInput,
  type KingdomServiceHooks
} from "./kingdoms.js";
import type { PlayerRecord } from "./state.js";

const databaseUrl = process.env.KINGDOM_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("KingdomService PostgreSQL integration", () => {
  let pool: pg.Pool;
  let now: Date;
  let worldResult: WorldLookupResult;
  const fixturePlayerIds = new Set<string>();
  const foundingSourceFlagIds = new Map<string, string>();

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = createPool({ databaseUrl: databaseUrl! });
  });

  beforeEach(() => {
    now = new Date("2026-07-10T12:00:00.000Z");
    worldResult = landWorld();
  });

  afterEach(async () => {
    await cleanupFixtures(pool, [...fixturePlayerIds]);
    fixturePlayerIds.clear();
    foundingSourceFlagIds.clear();
  });

  afterAll(async () => {
    await pool?.end();
  });

  function service(
    extraConfig: Record<string, string | number | boolean> = {},
    hooks: KingdomServiceHooks = {},
    autoCreateSourceFlag = true
  ): KingdomService {
    const config = loadConfig({
      NODE_ENV: "test",
      KINGDOMS_FREE_CONSTRUCTION: "true",
      KINGDOM_PERK_QUALIFICATION_SECONDS: "0",
      KINGDOM_CHAT_RATE_MAX: "100",
      KINGDOM_CHAT_RATE_WINDOW_SECONDS: "10",
      ...Object.fromEntries(Object.entries(extraConfig).map(([key, value]) => [key, String(value)]))
    });
    const world = {
      lookupGameplayEnvironment: vi.fn(async () => worldResult),
      lookupGameplayEnvironments: vi.fn(async (points: readonly unknown[]) =>
        points.map(() => worldResult))
    } as unknown as WorldLookupClient;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AppLogger;
    const domain = new KingdomService(pool, world, config, logger, () => new Date(now), hooks);
    const foundKingdom = domain.foundKingdom.bind(domain);
    const quoteFounding = domain.quoteFounding.bind(domain);
    if (autoCreateSourceFlag) {
      domain.foundKingdom = async (founder, input) => foundKingdom(founder, {
        ...input,
        sourceFlagId: input.sourceFlagId ?? await ensureFoundingSourceFlag(founder)
      });
      domain.quoteFounding = async (founder, input) => quoteFounding(founder, {
        ...input,
        sourceFlagId: input.sourceFlagId ?? await ensureFoundingSourceFlag(founder)
      });
    }
    return domain;
  }

  async function ensureFoundingSourceFlag(founder: PlayerRecord): Promise<string> {
    const existing = foundingSourceFlagIds.get(founder.playerId);
    if (existing) return existing;
    const flagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,$3,$4,$5,200,ST_SetSRID(ST_MakePoint($5,$4),4326))`,
      [flagId, founder.playerId, `${founder.username} Founding Flag`,
        founder.position.lat, founder.position.lon]
    );
    foundingSourceFlagIds.set(founder.playerId, flagId);
    return flagId;
  }

  function flagService(extraConfig: Record<string, string | number | boolean> = {}): FlagService {
    const config = loadConfig({
      NODE_ENV: "test",
      WORLD_REQUIRED_RELEASE_ID: "release-test",
      ...Object.fromEntries(Object.entries(extraConfig).map(([key, value]) => [key, String(value)]))
    });
    const world = {
      lookupGameplayEnvironment: vi.fn(async () => worldResult)
    } as unknown as WorldLookupClient;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AppLogger;
    return new FlagService(pool, world, config, logger);
  }

  async function player(
    username: string,
    position = { lat: 35.0844, lon: -106.6504 }
  ): Promise<PlayerRecord> {
    const playerId = randomUUID();
    fixturePlayerIds.add(playerId);
    await pool.query(
      `INSERT INTO players (
         id, username, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES ($1,$2,'#38bdf8','NM',$3,$4,$3,$4,900,true,
         ST_SetSRID(ST_MakePoint($4,$3),4326))`,
      [playerId, username, position.lat, position.lon]
    );
    await pool.query(
      `INSERT INTO player_progression_profiles (player_id,level)
       VALUES ($1,$2) ON CONFLICT (player_id) DO UPDATE SET level=excluded.level`,
      [playerId, KINGDOM_FOUNDING_MIN_PLAYER_LEVEL]
    );
    return {
      playerId,
      username,
      displayColor: "#38bdf8",
      regionCode: "NM",
      position: { ...position },
      anchor: { ...position },
      moveLeashRadiusM: 900,
      movementRevision: 0,
      target: null,
      online: true,
      updatedAt: new Date(now)
    };
  }

  async function found(
    founder: PlayerRecord,
    displayName: string,
    requestId = `found-${randomUUID()}`
  ) {
    return service().foundKingdom(founder, {
      requestId,
      displayName,
      description: "Integration fixture",
      emblemKey: "test.banner"
    });
  }

  async function creditTreasury(
    kingdomId: string,
    balances: Array<{ resourceType: "wood" | "stone" | "leather" | "balsam_resin"; quantity: number }>
  ): Promise<void> {
    for (const balance of balances) {
      await pool.query(
        `INSERT INTO kingdom_treasury_balances (
           kingdom_id, resource_type, variant, quantity
         ) VALUES ($1,$2,'default',$3)
         ON CONFLICT (kingdom_id, resource_type, variant)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [kingdomId, balance.resourceType, balance.quantity]
      );
    }
  }

  async function createFlagAtDistance(
    owner: PlayerRecord,
    seatId: string,
    distanceM: number,
    bearingDegrees: number,
    name = `Flag ${randomUUID().slice(0, 5)}`
  ): Promise<string> {
    const flagId = randomUUID();
    const point = await pool.query<{ lat: number; lon: number }>(
      `SELECT ST_Y(projected::geometry) AS lat, ST_X(projected::geometry) AS lon
       FROM (
         SELECT ST_Project(
           seat.geom::geography,
           $2::double precision,
           radians($3::double precision)
         ) AS projected
         FROM kingdom_seats seat WHERE seat.id = $1
       ) point`,
      [seatId, distanceM, bearingDegrees]
    );
    const { lat, lon } = point.rows[0]!;
    await pool.query(
      `INSERT INTO flags (
         id, owner_id, name, lat, lon, claim_radius_m, geom
       ) VALUES ($1,$2,$3,$4,$5,100,ST_SetSRID(ST_MakePoint($5,$4),4326))`,
      [flagId, owner.playerId, name, lat, lon]
    );
    return flagId;
  }

  async function createFlagAtFlagDistance(
    owner: PlayerRecord,
    sourceFlagId: string,
    distanceM: number,
    bearingDegrees: number,
    name: string
  ): Promise<string> {
    const flagId = randomUUID();
    const point = await pool.query<{ lat: number; lon: number }>(
      `SELECT ST_Y(projected::geometry) AS lat, ST_X(projected::geometry) AS lon
       FROM (
         SELECT ST_Project(
           source.geom::geography,
           $2::double precision,
           radians($3::double precision)
         ) AS projected
         FROM flags source WHERE source.id = $1
       ) point`,
      [sourceFlagId, distanceM, bearingDegrees]
    );
    const { lat, lon } = point.rows[0]!;
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,$3,$4,$5,100,ST_SetSRID(ST_MakePoint($5,$4),4326))`,
      [flagId, owner.playerId, name, lat, lon]
    );
    return flagId;
  }

  async function affiliateFlagWithTestCity(
    founderPlayerId: string,
    seatFlagId: string,
    name: string
  ): Promise<string> {
    const cityId = randomUUID();
    const municipalityId = `test-municipality-${cityId}`;
    await pool.query(
      `INSERT INTO cities (
         id, world_id, canonical_municipality_id,
         world_settlement_id, world_settlement_source, world_source_settlement_id,
         name, country_code, founder_player_id, founding_request_id, seat_flag_id,
         hall_lat, hall_lon, hall_geom, founding_annex_radius_m
       )
       SELECT $1,'main',$2,$2,'test',$2,$3,'US',$4,$5,flag.id,
              flag.lat,flag.lon,flag.geom,flag.claim_radius_m
       FROM flags flag
       WHERE flag.id = $6`,
      [
        cityId,
        municipalityId,
        name,
        founderPlayerId,
        `found-${cityId}`,
        seatFlagId
      ]
    );
    await pool.query(
      `UPDATE flags
       SET control_type = 'city_seat',
           city_id = $2,
           city_affiliated_at = now(),
           city_affiliated_by_player_id = NULL,
           original_owner_player_id = NULL,
           contributed_by_player_id = NULL,
           original_personal_color = NULL
       WHERE id = $1`,
      [seatFlagId, cityId]
    );
    return cityId;
  }

  async function addActiveCityMembership(member: PlayerRecord, name: string): Promise<string> {
    const seatFlagId = await ensureFoundingSourceFlag(member);
    const cityId = await affiliateFlagWithTestCity(member.playerId, seatFlagId, name);
    const structureId = randomUUID();
    await pool.query(
      `INSERT INTO city_structures (
         structure_id, city_id, structure_type, tier, owner_player_id, world_id,
         region_code, lat, lon, geom, footprint_geom, footprint_radius_m,
         placement_revision, state, build_operation_key, built_at
       )
       SELECT $1,$2,'city_house',1,$3,'main','NM',flag.lat,flag.lon,flag.geom,
              ST_Buffer(flag.geom::geography, 10)::geometry,10,1,'active',$4,$5
       FROM flags flag WHERE flag.id = $6`,
      [structureId, cityId, member.playerId, `city-house-test:${structureId}`, now, seatFlagId]
    );
    await pool.query(
      `INSERT INTO city_memberships (
         membership_id, city_id, player_id, role, joined_at, left_at,
         world_id, house_structure_id
       ) VALUES ($1,$2,$3,'member',$4,NULL,'main',$5)`,
      [randomUUID(), cityId, member.playerId, now, structureId]
    );
    return cityId;
  }

  async function pointAtDistance(
    origin: { lat: number; lon: number },
    distanceM: number,
    bearingDegrees = 0
  ): Promise<{ lat: number; lon: number }> {
    const point = await pool.query<{ lat: number; lon: number }>(
      `SELECT ST_Y(projected::geometry) AS lat, ST_X(projected::geometry) AS lon
       FROM (
         SELECT ST_Project(
           ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
           $3::double precision,
           radians($4::double precision)
         ) AS projected
       ) point`,
      [origin.lon, origin.lat, distanceM, bearingDegrees]
    );
    return point.rows[0]!;
  }

  async function joinKingdom(
    domain: KingdomService,
    leaderId: string,
    memberId: string,
    requestPrefix: string
  ): Promise<void> {
    const invited = await domain.invitePlayer(leaderId, {
      requestId: `${requestPrefix}-invite`,
      targetPlayerId: memberId
    });
    const invitation = invited.state!.invitations.find(
      ({ targetPlayerId, status }) => targetPlayerId === memberId && status === "pending"
    )!;
    await domain.respondToInvitation(memberId, {
      requestId: `${requestPrefix}-accept`,
      invitationId: invitation.id,
      response: "accept"
    });
  }

  it("founds atomically at the immutable authoritative position and replays without duplication", async () => {
    const founder = await player("FounderA");
    const domain = service();
    const input: FoundKingdomInput = {
      requestId: "found-authority",
      displayName: "Ember Guard",
      description: "  A real Kingdom.  ",
      emblemKey: "ember.guard",
      displayColor: "#f97316"
    };
    const first = await domain.foundKingdom(founder, input);
    founder.position = { lat: 36, lon: -105 };
    const replay = await domain.foundKingdom(founder, input);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(first.spatialChanges).toMatchObject([{
      previous: null,
      current: { entityType: "seat", kingdomId: first.state!.kingdom!.id }
    }]);
    expect(replay.spatialChanges).toEqual([]);
    expect(first.state!.kingdom).toMatchObject({
      displayName: "Ember Guard",
      displayColor: "#f97316",
      memberCount: 1,
      seat: {
        lat: 35.0844,
        lon: -106.6504,
        completedUnderFreeConstruction: true,
        environment: { isLand: true, isSaltwater: false, worldPackageId: "world-test" }
      }
    });
    const counts = await pool.query<{ kingdoms: string; memberships: string; seats: string }>(
      `SELECT
         (SELECT count(*) FROM kingdoms WHERE founder_player_id = $1)::text AS kingdoms,
         (SELECT count(*) FROM kingdom_memberships WHERE player_id = $1)::text AS memberships,
         (SELECT count(*) FROM kingdom_seats s JOIN kingdoms k ON k.id = s.kingdom_id
          WHERE k.founder_player_id = $1)::text AS seats`,
      [founder.playerId]
    );
    expect(counts.rows[0]).toEqual({ kingdoms: "1", memberships: "1", seats: "1" });

    const publicKingdom = await domain.getPublicKingdom(first.state!.kingdom!.id);
    expect(publicKingdom).toMatchObject({
      id: first.state!.kingdom!.id,
      displayName: "Ember Guard",
      memberCount: 1
    });
    expect(publicKingdom).not.toHaveProperty("roster");
    expect(publicKingdom).not.toHaveProperty("chatHistory");
    expect(publicKingdom).not.toHaveProperty("treasury");
  });

  it("quotes, spends, replays, and completes paid founding durably", async () => {
    const founder = await player("PaidFounder");
    await grantInventory(pool, founder.playerId, "wood", 465);
    await grantInventory(pool, founder.playerId, "stone", 550);
    await grantInventory(pool, founder.playerId, "iron", 425);
    await grantInventory(pool, founder.playerId, "refined_oil", 1_150);
    const domain = service({ KINGDOMS_FREE_CONSTRUCTION: false });
    const input = { requestId: "paid-found", displayName: "Paid Realm" };

    const quoted = await domain.quoteFounding(founder, input);
    expect(quoted).toMatchObject({ informational: true, quote: {
      freeConstruction: false,
      adjustedCost: [
        { resourceType: "refined_oil", quantity: 1_150 },
        { resourceType: "wood", quantity: 450 },
        { resourceType: "stone", quantity: 550 },
        { resourceType: "iron", quantity: 425 }
      ]
    }, sourceFlag: {
      id: foundingSourceFlagIds.get(founder.playerId),
      lat: founder.position.lat,
      lon: founder.position.lon,
      claimRadiusM: 200
    }, eligible: true, disabledReason: null });
    const founded = await domain.foundKingdom(founder, input);
    expect(founded.state!.kingdom!.seat).toMatchObject({
      sourceFlagId: quoted.sourceFlag!.id,
      constructionState: "complete",
      completedUnderFreeConstruction: false
    });
    expect(founded.state!.kingdom!.seat!.completedAt).not.toBeNull();
    expect(founded.spatialChanges).toHaveLength(1);
    const balances = await pool.query<{ resource_type: string; quantity: string }>(
      `SELECT resource_type, quantity::text FROM player_inventory
       WHERE player_id = $1 AND resource_type IN ('wood','stone') ORDER BY resource_type`,
      [founder.playerId]
    );
    expect(balances.rows).toEqual([
      { resource_type: "stone", quantity: "0" },
      { resource_type: "wood", quantity: "15" }
    ]);
    expect((await domain.foundKingdom(founder, input)).replayed).toBe(true);
    const debitEvents = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events
       WHERE player_id = $1 AND source = 'kingdom_construction'`,
      [founder.playerId]
    );
    expect(debitEvents.rows[0]?.count).toBe("4");

    const recovered = await service({ KINGDOMS_FREE_CONSTRUCTION: false }).getState(founder);
    expect(recovered.kingdom!.seat).toMatchObject({ constructionState: "complete" });
    expect(await domain.getSeatTravelDestination(recovered.kingdom!.seat!.id)).toMatchObject({
      id: recovered.kingdom!.seat!.id,
      kingdomId: recovered.kingdom!.id,
      lat: founder.position.lat,
      lon: founder.position.lon,
      claimRadiusM: 200
    });
    expect((await pool.query<{
      control_type: string; kingdom_founding_request_id: string | null; kingdom_founding_reserved_at: Date | null;
    }>(
      `SELECT control_type, kingdom_founding_request_id, kingdom_founding_reserved_at
       FROM flags WHERE id = $1`,
      [quoted.sourceFlag!.id]
    )).rows[0]).toEqual({
      control_type: "kingdom_seat",
      kingdom_founding_request_id: null,
      kingdom_founding_reserved_at: null
    });
    const foundingJobs = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kingdom_construction_jobs WHERE actor_player_id = $1",
      [founder.playerId]
    );
    expect(foundingJobs.rows[0]?.count).toBe("0");

    founder.position = { lat: 35.0849, lon: -106.6504 };
    const cot = await service({ KINGDOMS_FREE_CONSTRUCTION: false }).placeCot(founder, { requestId: "paid-cot" });
    expect(cot.state!.cots[0]).toMatchObject({ constructionState: "under_construction" });
    expect((await service({ KINGDOMS_FREE_CONSTRUCTION: false }).placeCot(founder, { requestId: "paid-cot" })).replayed)
      .toBe(true);
    founder.position = { lat: 35.0844, lon: -106.6498 };
    const decoration = await service({ KINGDOMS_FREE_CONSTRUCTION: false }).placeDecoration(founder, {
      requestId: "paid-banner", typeId: "banner", kingdomOwned: true
    });
    expect(decoration.state!.decorations[0]).toMatchObject({
      constructionState: "under_construction", capacityCost: 1
    });
    expect((await pool.query<{ quantity: string }>(
      `SELECT quantity::text AS quantity FROM player_inventory
       WHERE player_id = $1 AND resource_type = 'wood'`, [founder.playerId]
    )).rows[0]?.quantity).toBe("0");
    now = new Date(now.getTime() + 120_000);
    const completedObjects = await service({ KINGDOMS_FREE_CONSTRUCTION: false }).getState(founder);
    expect(completedObjects.cots[0]?.constructionState).toBe("complete");
    expect(completedObjects.decorations[0]?.constructionState).toBe("complete");
  });

  it("rolls back all paid founding work when resources are insufficient", async () => {
    const founder = await player("PoorFounder");
    await grantInventory(pool, founder.playerId, "wood", 450);
    const paid = service({ KINGDOMS_FREE_CONSTRUCTION: false });
    await expect(paid.quoteFounding(founder, {
      requestId: "poor-found-quote", displayName: "Poor Realm"
    })).resolves.toMatchObject({
      eligible: true,
      affordable: false,
      affordability: [
        { resourceType: "refined_oil", requiredQuantity: 1_150, availableQuantity: 0, missingQuantity: 1_150 },
        { resourceType: "wood", requiredQuantity: 450, availableQuantity: 450, missingQuantity: 0 },
        { resourceType: "stone", requiredQuantity: 550, availableQuantity: 0, missingQuantity: 550 },
        { resourceType: "iron", requiredQuantity: 425, availableQuantity: 0, missingQuantity: 425 }
      ]
    });
    await expect(paid.foundKingdom(founder, {
      requestId: "poor-found", displayName: "Poor Realm"
    })).rejects.toMatchObject({ code: "KINGDOM_CONSTRUCTION_INSUFFICIENT_RESOURCES" });
    const balance = await pool.query<{ quantity: string }>(
      `SELECT quantity::text AS quantity FROM player_inventory
       WHERE player_id = $1 AND resource_type = 'wood' AND variant = 'default'`,
      [founder.playerId]
    );
    expect(balance.rows[0]?.quantity).toBe("450");
    expect(await pool.query("SELECT id FROM kingdoms WHERE founder_player_id = $1", [founder.playerId]))
      .toMatchObject({ rowCount: 0 });
  });

  it("requires player level 5 to found a Kingdom (quote blocker and confirmation)", async () => {
    const founder = await player("LowLevelFounder");
    await pool.query("UPDATE player_progression_profiles SET level = 4 WHERE player_id = $1", [founder.playerId]);
    const domain = service();
    await expect(domain.quoteFounding(founder, { requestId: "low-quote", displayName: "Low Realm" }))
      .resolves.toMatchObject({ eligible: false, blockerCode: "KINGDOM_FOUNDING_LEVEL_REQUIRED" });
    await expect(domain.foundKingdom(founder, { requestId: "low-found", displayName: "Low Realm" }))
      .rejects.toMatchObject({ code: "KINGDOM_FOUNDING_LEVEL_REQUIRED" });
    await pool.query("UPDATE player_progression_profiles SET level = 5 WHERE player_id = $1", [founder.playerId]);
    await expect(domain.quoteFounding(founder, { requestId: "ok-quote", displayName: "Low Realm" }))
      .resolves.toMatchObject({ eligible: true });

  });

  it("allows a City member to found a Kingdom while preserving both memberships", async () => {
    const founder = await player("CityMemberFounder", { lat: 35.9, lon: -106.4 });
    await addActiveCityMembership(founder, "Founding Conflict City");
    founder.position = await pointAtDistance(founder.position, 500, 90);
    const sourceFlagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,'Unaffiliated personal flag',$3,$4,200,
         ST_SetSRID(ST_MakePoint($4,$3),4326))`,
      [sourceFlagId, founder.playerId, founder.position.lat, founder.position.lon]
    );
    const domain = service({}, {}, false);

    await expect(domain.quoteFounding(founder, {
      requestId: "city-member-quote",
      displayName: "City Member Realm",
      sourceFlagId
    })).resolves.toMatchObject({
      eligible: true,
      blockerCode: null,
      sourceFlag: { id: sourceFlagId }
    });
    await expect(domain.foundKingdom(founder, {
      requestId: "city-member-confirm",
      displayName: "City Member Realm",
      sourceFlagId
    })).resolves.toMatchObject({ state: { membership: { playerId: founder.playerId } } });
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int FROM city_memberships WHERE player_id=$1 AND left_at IS NULL) AS cities,
         (SELECT count(*)::int FROM kingdom_memberships WHERE player_id=$1 AND status='active') AS kingdoms`,
      [founder.playerId]
    )).resolves.toMatchObject({ rows: [{ cities: 1, kingdoms: 1 }] });
  });

  it("rechecks name availability after an informational founding quote", async () => {
    const founder = await player("QuotedFounder", { lat: 35.0844, lon: -106.6504 });
    await grantInventory(pool, founder.playerId, "wood", 450);
    await grantInventory(pool, founder.playerId, "stone", 550);
    await grantInventory(pool, founder.playerId, "iron", 425);
    await grantInventory(pool, founder.playerId, "refined_oil", 1_150);
    const paid = service({ KINGDOMS_FREE_CONSTRUCTION: false });
    const input = { requestId: "name-quote", displayName: "Contested Name" };
    await paid.quoteFounding(founder, input);

    const winner = await player("NameWinner", { lat: 36.2, lon: -105.2 });
    await found(winner, "Contested Name");
    await expect(paid.foundKingdom(founder, input))
      .rejects.toMatchObject({ code: "KINGDOM_NAME_UNAVAILABLE" });
    const balance = await pool.query<{ quantity: string }>(
      `SELECT quantity::text AS quantity FROM player_inventory
       WHERE player_id = $1 AND resource_type = 'wood'`, [founder.playerId]
    );
    expect(balance.rows[0]?.quantity).toBe("450");
  });

  it("fails closed for unavailable authority and rejects authoritative water", async () => {
    const founder = await player("FounderWater");
    const domain = service();
    worldResult = { ...landWorld(), ok: false, isLand: null, isSaltwater: null, insideMajorLake: null };
    await expect(domain.foundKingdom(founder, {
      requestId: "world-offline",
      displayName: "Offline Keep"
    })).rejects.toMatchObject({ code: "KINGDOM_WORLD_AUTHORITY_UNAVAILABLE" });

    worldResult = { ...landWorld(), isLand: false, insideMajorLake: true };
    await expect(domain.foundKingdom(founder, {
      requestId: "water",
      displayName: "Water Keep"
    })).rejects.toMatchObject({ code: "KINGDOM_WATER_REJECTED" });
    expect(await pool.query("SELECT id FROM kingdoms WHERE founder_player_id = $1", [founder.playerId]))
      .toMatchObject({ rowCount: 0 });
  });

  it("revalidates membership at the private-state emission boundary", async () => {
    const leader = await player("RevocationLeader");
    const member = await player("RevocationMember");
    const kingdomId = (await found(leader, "Revocation Realm")).state!.kingdom!.id;
    await pool.query(
      `INSERT INTO kingdom_memberships (
         id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
       ) VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), kingdomId, member.playerId, now]
    );
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const atBoundary = new Promise<void>((resolve) => { reached = resolve; });
    let intercepted = false;
    const domain = service({}, {
      beforePrivateStateEmission: async (playerId) => {
        if (playerId !== member.playerId || intercepted) return;
        intercepted = true;
        reached();
        await paused;
      }
    });

    const pendingState = domain.getState(member.playerId);
    await atBoundary;
    await pool.query(
      `UPDATE kingdom_memberships
       SET status = 'removed', ended_at = $2, end_reason = 'test-revocation'
       WHERE player_id = $1 AND status = 'active'`,
      [member.playerId, now]
    );
    release();

    await expect(pendingState).resolves.toMatchObject({
      membership: null,
      kingdom: null,
      roster: [],
      chatHistory: [],
      treasury: [],
      cots: [],
      decorations: []
    });
    await expect(domain.activeChatRecipients(kingdomId, [leader.playerId, member.playerId]))
      .resolves.toEqual([leader.playerId]);
  });

  it("retries private state once when same-Kingdom role or membership identity changes", async () => {
    const leader = await player("RoleRaceLeader");
    const officer = await player("RoleRaceOfficer");
    const banned = await player("RoleRaceBanned");
    const kingdomId = (await found(leader, "Role Race Realm")).state!.kingdom!.id;
    const officerMembershipId = randomUUID();
    await pool.query(
      `INSERT INTO kingdom_memberships (
         id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
       ) VALUES ($1,$2,$3,'officer','active',$4,$4),
                ($5,$2,$6,'member','active',$4,$4)`,
      [officerMembershipId, kingdomId, officer.playerId, now, randomUUID(), banned.playerId]
    );
    await service().memberAction(leader.playerId, {
      requestId: "role-race-ban",
      targetPlayerId: banned.playerId,
      action: "ban"
    });
    await grantInventory(pool, leader.playerId, "wood", 5);
    await service().donate(leader.playerId, {
      requestId: "role-race-donation",
      resourceType: "wood",
      quantity: 5
    });

    const demoted = await racedState(officer.playerId, async () => {
      await pool.query("UPDATE kingdom_memberships SET role = 'member' WHERE id = $1", [officerMembershipId]);
    });
    expect(demoted.membership).toMatchObject({ membershipId: officerMembershipId, role: "member" });
    expect(demoted.permissions).not.toContain("view_treasury_ledger");
    expect(demoted.donationHistory).toBeNull();
    expect(demoted.roster.some(({ status }) => status === "banned")).toBe(false);

    const promoted = await racedState(officer.playerId, async () => {
      await pool.query("UPDATE kingdom_memberships SET role = 'officer' WHERE id = $1", [officerMembershipId]);
    });
    expect(promoted.membership?.role).toBe("officer");
    expect(promoted.permissions).toContain("view_treasury_ledger");
    expect(promoted.donationHistory).toHaveLength(1);

    const promotedLeader = await racedState(officer.playerId, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE kingdom_memberships SET role = 'officer' WHERE player_id = $1 AND status = 'active'",
          [leader.playerId]
        );
        await client.query("UPDATE kingdom_memberships SET role = 'leader' WHERE id = $1", [officerMembershipId]);
        await client.query("UPDATE kingdoms SET leader_player_id = $2 WHERE id = $1", [kingdomId, officer.playerId]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });
    expect(promotedLeader.membership?.role).toBe("leader");

    const replacementMembershipId = randomUUID();
    const replaced = await racedState(officer.playerId, async () => {
      await pool.query(
        `UPDATE kingdom_memberships
         SET status = 'removed', ended_at = $2, end_reason = 'replacement-test'
         WHERE id = $1`,
        [officerMembershipId, now]
      );
      await pool.query(
        `INSERT INTO kingdom_memberships (
           id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
         ) VALUES ($1,$2,$3,'member','active',$4,$4)`,
        [replacementMembershipId, kingdomId, officer.playerId, now]
      );
    });
    expect(replaced.membership).toMatchObject({
      membershipId: replacementMembershipId,
      role: "member"
    });

    async function racedState(
      playerId: string,
      transition: () => Promise<void>
    ): Promise<KingdomStateSnapshot> {
      let release!: () => void;
      const paused = new Promise<void>((resolve) => { release = resolve; });
      let reached!: () => void;
      const atBoundary = new Promise<void>((resolve) => { reached = resolve; });
      let intercepted = false;
      const domain = service({}, {
        beforePrivateStateEmission: async (emittingPlayerId) => {
          if (emittingPlayerId !== playerId || intercepted) return;
          intercepted = true;
          reached();
          await paused;
        }
      });
      const pending = domain.getState(playerId);
      await atBoundary;
      await transition();
      release();
      return pending;
    }
  });

  it("does not emit old private state when membership switches Kingdoms or dissolves", async () => {
    const leaderA = await player("SwitchLeaderA");
    const leaderB = await player("SwitchLeaderB", { lat: 35.2, lon: -106.65 });
    const member = await player("SwitchMember");
    const kingdomA = (await found(leaderA, "Switch Realm A")).state!.kingdom!.id;
    const kingdomB = (await found(leaderB, "Switch Realm B")).state!.kingdom!.id;
    const membershipA = randomUUID();
    await pool.query(
      `INSERT INTO kingdom_memberships (
         id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
       ) VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [membershipA, kingdomA, member.playerId, now]
    );
    const switched = await pausedState(async () => {
      await pool.query(
        `UPDATE kingdom_memberships SET status = 'removed', ended_at = $2,
           end_reason = 'switch-test' WHERE id = $1`,
        [membershipA, now]
      );
      await pool.query(
        `INSERT INTO kingdom_memberships (
           id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
         ) VALUES ($1,$2,$3,'member','active',$4,$4)`,
        [randomUUID(), kingdomB, member.playerId, now]
      );
    });
    expect(switched.kingdom?.id).toBe(kingdomB);
    expect(switched.chatHistory.every(({ kingdomId }) => kingdomId === kingdomB)).toBe(true);

    const dissolved = await pausedState(async () => {
      await pool.query(
        `UPDATE kingdoms SET status = 'dissolved', dissolved_at = $2 WHERE id = $1`,
        [kingdomB, now]
      );
      await pool.query(
        `UPDATE kingdom_memberships SET status = 'removed', ended_at = $2,
           end_reason = 'dissolve-test' WHERE player_id = $1 AND status = 'active'`,
        [member.playerId, now]
      );
    });
    expect(dissolved).toMatchObject({
      membership: null,
      kingdom: null,
      roster: [],
      chatHistory: [],
      treasury: []
    });

    async function pausedState(transition: () => Promise<void>): Promise<KingdomStateSnapshot> {
      let release!: () => void;
      const paused = new Promise<void>((resolve) => { release = resolve; });
      let reached!: () => void;
      const atBoundary = new Promise<void>((resolve) => { reached = resolve; });
      let intercepted = false;
      const domain = service({}, {
        beforePrivateStateEmission: async (playerId) => {
          if (playerId !== member.playerId || intercepted) return;
          intercepted = true;
          reached();
          await paused;
        }
      });
      const pending = domain.getState(member.playerId);
      await atBoundary;
      await transition();
      release();
      return pending;
    }
  });

  it("returns an explicit degraded success and replays a committed donation exactly once", async () => {
    const leader = await player("DegradedDonationLeader");
    await found(leader, "Degraded Donation Realm");
    await grantInventory(pool, leader.playerId, "wood", 20);
    const domain = service({}, {
      beforePostCommitStateLoad: () => { throw new Error("injected post-commit state failure"); }
    });
    const first = await domain.donate(leader.playerId, {
      requestId: "degraded-donation",
      resourceType: "wood",
      quantity: 10
    });
    const replay = await domain.donate(leader.playerId, {
      requestId: "degraded-donation",
      resourceType: "wood",
      quantity: 10
    });
    expect(first).toMatchObject({ state: null, stateRefreshRequired: true, replayed: false });
    expect(replay).toMatchObject({ state: null, stateRefreshRequired: true, replayed: true });
    const exact = await pool.query<{
      inventory: string;
      treasury: string;
      donations: string;
      xp_rows: string;
      lifetime_xp: string;
    }>(
      `SELECT
         (SELECT quantity::text FROM player_inventory
          WHERE player_id = $1 AND resource_type = 'wood' AND variant = 'default') AS inventory,
         (SELECT quantity::text FROM kingdom_treasury_balances
          WHERE kingdom_id = (SELECT kingdom_id FROM kingdom_memberships WHERE player_id = $1 AND status = 'active')
            AND resource_type = 'wood' AND variant = 'default') AS treasury,
         (SELECT count(*)::text FROM kingdom_donations WHERE donor_player_id = $1) AS donations,
         (SELECT count(*)::text FROM kingdom_xp_ledger WHERE actor_player_id = $1) AS xp_rows,
         (SELECT lifetime_xp::text FROM kingdoms
          WHERE id = (SELECT kingdom_id FROM kingdom_memberships WHERE player_id = $1 AND status = 'active')) AS lifetime_xp`,
      [leader.playerId]
    );
    expect(exact.rows[0]).toEqual({
      inventory: "10",
      treasury: "10",
      donations: "1",
      xp_rows: "0",
      lifetime_xp: "0"
    });
  });

  it("uses the explicit degraded response contract for founding, leave, objects, and dissolution", async () => {
    const leader = await player("DegradedGenericLeader");
    const member = await player("DegradedGenericMember");
    const domain = service({}, {
      beforePostCommitStateLoad: () => { throw new Error("injected state reconstruction failure"); }
    });
    const founded = await domain.foundKingdom(leader, {
      requestId: "degraded-found",
      displayName: "Degraded Generic Realm"
    });
    expect(founded).toMatchObject({ state: null, stateRefreshRequired: true });
    const kingdom = await pool.query<{ id: string }>(
      "SELECT id FROM kingdoms WHERE founder_player_id = $1",
      [leader.playerId]
    );
    const kingdomId = kingdom.rows[0]!.id;
    await pool.query(
      `INSERT INTO kingdom_memberships (
         id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
       ) VALUES ($1,$2,$3,'member','active',$4,$4)`,
      [randomUUID(), kingdomId, member.playerId, now]
    );
    const cotPlayer = { ...leader, position: { lat: leader.position.lat + 0.0002, lon: leader.position.lon } };
    const decorationPlayer = {
      ...leader,
      position: { lat: leader.position.lat - 0.0002, lon: leader.position.lon }
    };
    await expect(domain.placeCot(cotPlayer, { requestId: "degraded-cot" }))
      .resolves.toMatchObject({ state: null, stateRefreshRequired: true });
    await expect(domain.placeDecoration(decorationPlayer, {
      requestId: "degraded-decoration",
      typeId: "banner",
      kingdomOwned: true
    })).resolves.toMatchObject({ state: null, stateRefreshRequired: true });
    await expect(domain.leaveKingdom(member.playerId, "degraded-leave"))
      .resolves.toMatchObject({ state: null, stateRefreshRequired: true });
    await expect(domain.dissolveKingdom(leader.playerId, "degraded-dissolve"))
      .resolves.toMatchObject({ state: null, stateRefreshRequired: true });
  });

  it("enforces normalized-name uniqueness and serializes simultaneous overlapping founding", async () => {
    const first = await player("FounderOne", { lat: 35.0844, lon: -106.6504 });
    const second = await player("FounderTwo", await pointAtDistance(first.position, 500));
    const attempts = await Promise.allSettled([
      service().foundKingdom(first, { requestId: "race-one", displayName: "First Hold" }),
      service().foundKingdom(second, { requestId: "race-two", displayName: "Second Hold" })
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.find(({ status }) => status === "rejected")).toMatchObject({
      reason: expect.objectContaining({
        code: "KINGDOM_SEAT_TOO_CLOSE"
      })
    });

    const winner = attempts.find((attempt) => attempt.status === "fulfilled");
    const winningName = winner?.status === "fulfilled"
      ? winner.value.state!.kingdom!.displayName
      : "First Hold";
    const third = await player("FounderThree", { lat: 35.11, lon: -106.65 });
    await expect(service().foundKingdom(third, {
      requestId: "same-name",
      displayName: winningName.toUpperCase()
    })).rejects.toMatchObject({ code: "KINGDOM_NAME_UNAVAILABLE" });

    const distantA = await player("DistantRaceA", { lat: 33, lon: -108 });
    const distantB = await player("DistantRaceB", { lat: 40, lon: -100 });
    const distantAttempts = await Promise.all([
      service().foundKingdom(distantA, { requestId: "distant-race-a", displayName: "Distant Hold A" }),
      service().foundKingdom(distantB, { requestId: "distant-race-b", displayName: "Distant Hold B" })
    ]);
    expect(distantAttempts.every(({ replayed }) => !replayed)).toBe(true);
  });

  it("uses authoritative metre geography for spacing and distant placement", async () => {
    const founder = await player("GeographyFounder");
    await found(founder, "Geography Anchor Realm");

    const spacingPosition = await pointAtDistance(founder.position, 500);
    const measured = await pool.query<{ distance_m: number }>(
      `SELECT ST_Distance(
         ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
         ST_SetSRID(ST_MakePoint($3,$4),4326)::geography
       ) AS distance_m`,
      [founder.position.lon, founder.position.lat, spacingPosition.lon, spacingPosition.lat]
    );
    expect(Number(measured.rows[0]!.distance_m)).toBeCloseTo(500, 2);
    const spacingCandidate = await player("GeographySpacing", spacingPosition);
    await expect(service().quoteFounding(spacingCandidate, {
      requestId: "geography-spacing", displayName: "Geography Spacing Realm"
    })).resolves.toMatchObject({ eligible: false, blockerCode: "KINGDOM_SEAT_TOO_CLOSE" });

    const boundarySafePosition = await pointAtDistance(founder.position, 651, 180);
    const boundaryCandidate = await player("GeographyBoundary", boundarySafePosition);
    await expect(service().quoteFounding(boundaryCandidate, {
      requestId: "geography-boundary", displayName: "Geography Boundary Realm"
    })).resolves.toMatchObject({ position: boundarySafePosition });

    const distantCandidate = await player("GeographyDistant", { lat: -35.0844, lon: 73.3496 });
    await expect(service().quoteFounding(distantCandidate, {
      requestId: "geography-distant", displayName: "Geography Distant Realm"
    })).resolves.toMatchObject({ position: distantCandidate.position });
  });

  it("handles invite, decline, cancel, expiry, acceptance, and one-active-membership races", async () => {
    const leaderA = await player("LeaderInviteA", { lat: 35.0844, lon: -106.6504 });
    const leaderB = await player("LeaderInviteB", { lat: 35.1144, lon: -106.6504 });
    const target = await player("InviteTarget");
    await found(leaderA, "Invite Alpha");
    await found(leaderB, "Invite Beta");
    const domain = service();

    const declinedInvite = await domain.invitePlayer(leaderA.playerId, {
      requestId: "invite-decline",
      targetPlayerId: target.playerId
    });
    const declineId = declinedInvite.state!.invitations.find(
      ({ targetPlayerId, status }) => targetPlayerId === target.playerId && status === "pending"
    )!.id;
    const declined = await domain.respondToInvitation(target.playerId, {
      requestId: "decline",
      invitationId: declineId,
      response: "decline"
    });
    expect(declined.notificationPlayerIds).toEqual([leaderA.playerId, target.playerId].sort());

    const cancelled = await domain.invitePlayer(leaderA.playerId, {
      requestId: "invite-cancel",
      targetPlayerId: target.playerId
    });
    const cancelId = cancelled.state!.invitations.find(
      ({ targetPlayerId, status }) => targetPlayerId === target.playerId && status === "pending"
    )!.id;
    const cancelResult = await domain.cancelInvitation(
      leaderA.playerId,
      { requestId: "cancel", invitationId: cancelId }
    );
    expect(cancelResult.notificationPlayerIds).toEqual([leaderA.playerId, target.playerId].sort());

    const expiring = await domain.invitePlayer(leaderA.playerId, {
      requestId: "invite-expire",
      targetPlayerId: target.playerId
    });
    const expiryId = expiring.state!.invitations.find(
      ({ targetPlayerId, status }) => targetPlayerId === target.playerId && status === "pending"
    )!.id;
    const unrelatedTarget = await player("UnrelatedExpiryTarget");
    const unrelated = await domain.invitePlayer(leaderB.playerId, {
      requestId: "unrelated-expiry",
      targetPlayerId: unrelatedTarget.playerId
    });
    const unrelatedId = unrelated.state!.invitations.find(
      ({ targetPlayerId }) => targetPlayerId === unrelatedTarget.playerId
    )!.id;
    now = new Date(now.getTime() + 73 * 60 * 60_000);
    await expect(domain.respondToInvitation(target.playerId, {
      requestId: "accept-expired",
      invitationId: expiryId,
      response: "accept"
    })).rejects.toMatchObject({ code: "KINGDOM_INVITATION_EXPIRED" });
    await domain.getState(target.playerId);
    const expiryStatuses = await pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM kingdom_invitations WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[expiryId, unrelatedId]]
    );
    expect(Object.fromEntries(expiryStatuses.rows.map((row) => [row.id, row.status])))
      .toEqual({ [expiryId]: "expired", [unrelatedId]: "pending" });

    now = new Date("2026-07-10T12:00:00.000Z");
    await pool.query(
      "UPDATE kingdom_invitations SET status = 'expired', responded_at = $2 WHERE id = $1",
      [expiryId, now]
    );
    const inviteA = await domain.invitePlayer(leaderA.playerId, {
      requestId: "invite-race-a",
      targetPlayerId: target.playerId
    });
    const inviteB = await domain.invitePlayer(leaderB.playerId, {
      requestId: "invite-race-b",
      targetPlayerId: target.playerId
    });
    const invitationA = inviteA.state!.invitations.find(
      ({ targetPlayerId, status }) => targetPlayerId === target.playerId && status === "pending"
    )!.id;
    const invitationB = inviteB.state!.invitations.find(
      ({ targetPlayerId, status }) => targetPlayerId === target.playerId && status === "pending"
    )!.id;
    const accepts = await Promise.allSettled([
      domain.respondToInvitation(target.playerId, {
        requestId: "accept-race-a",
        invitationId: invitationA,
        response: "accept"
      }),
      domain.respondToInvitation(target.playerId, {
        requestId: "accept-race-b",
        invitationId: invitationB,
        response: "accept"
      })
    ]);
    expect(accepts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(await pool.query(
      "SELECT id FROM kingdom_memberships WHERE player_id = $1 AND status = 'active'",
      [target.playerId]
    )).toMatchObject({ rowCount: 1 });
  });

  it("allows City members to be invited to and join a Kingdom", async () => {
    const leader = await player("CityConflictLeader");
    const cityMember = await player("CityConflictTarget", { lat: 35.3, lon: -106.3 });
    const raceTarget = await player("CityRaceTarget", { lat: 35.5, lon: -106.5 });
    await found(leader, "City Conflict Realm");
    await addActiveCityMembership(cityMember, "Invitation Conflict City");
    const domain = service();

    const cityMemberInvitation = await domain.invitePlayer(leader.playerId, {
      requestId: "invite-city-member",
      targetPlayerId: cityMember.playerId
    });
    const cityMemberInvitationId = cityMemberInvitation.state!.invitations.find(
      ({ targetPlayerId, status }) => targetPlayerId === cityMember.playerId && status === "pending"
    )!.id;
    await expect(domain.respondToInvitation(cityMember.playerId, {
      requestId: "accept-city-member",
      invitationId: cityMemberInvitationId,
      response: "accept"
    })).resolves.toMatchObject({ state: { membership: { playerId: cityMember.playerId } } });

    const invitation = await domain.invitePlayer(leader.playerId, {
      requestId: "invite-before-city",
      targetPlayerId: raceTarget.playerId
    });
    const invitationId = invitation.state!.invitations.find(
      ({ targetPlayerId, status }) =>
        targetPlayerId === raceTarget.playerId && status === "pending"
    )!.id;
    await addActiveCityMembership(raceTarget, "Acceptance Race City");
    await expect(domain.respondToInvitation(raceTarget.playerId, {
      requestId: "accept-after-city",
      invitationId,
      response: "accept"
    })).resolves.toMatchObject({ state: { membership: { playerId: raceTarget.playerId } } });
    await expect(pool.query(
      `SELECT player_id,
              EXISTS (SELECT 1 FROM city_memberships cm WHERE cm.player_id=km.player_id AND cm.left_at IS NULL) AS in_city
       FROM kingdom_memberships km
       WHERE player_id = ANY($1::text[]) AND status='active'
       ORDER BY player_id`,
      [[cityMember.playerId, raceTarget.playerId]]
    )).resolves.toMatchObject({ rows: [
      { player_id: cityMember.playerId, in_city: true },
      { player_id: raceTarget.playerId, in_city: true }
    ].sort((left, right) => left.player_id.localeCompare(right.player_id)) });
  });

  it("bounds invitation audiences to exact affected pending invitations despite historical rows", async () => {
    const leaderA = await player("AudienceLeaderA");
    const leaderB = await player("AudienceLeaderB", { lat: 35.2, lon: -106.65 });
    const oldLeader = await player("AudienceOldLeader", { lat: 35.4, lon: -106.65 });
    const officerA = await player("AudienceOfficerA");
    const officerB = await player("AudienceOfficerB");
    const oldOfficer = await player("AudienceOldOfficer");
    const ordinaryA = await player("AudienceOrdinaryA");
    const target = await player("AudienceTarget");
    const kingdomA = (await found(leaderA, "Audience Realm A")).state!.kingdom!.id;
    const kingdomB = (await found(leaderB, "Audience Realm B")).state!.kingdom!.id;
    const oldKingdom = (await found(oldLeader, "Audience Old Realm")).state!.kingdom!.id;
    for (const [kingdomId, playerId, role] of [
      [kingdomA, officerA.playerId, "officer"],
      [kingdomB, officerB.playerId, "officer"],
      [oldKingdom, oldOfficer.playerId, "officer"],
      [kingdomA, ordinaryA.playerId, "member"]
    ] as const) {
      await pool.query(
        `INSERT INTO kingdom_memberships (
           id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
         ) VALUES ($1,$2,$3,$4,'active',$5,$5)`,
        [randomUUID(), kingdomId, playerId, role, now]
      );
    }
    await pool.query(
      `INSERT INTO kingdom_invitations (
         id, kingdom_id, target_player_id, invited_by_player_id,
         request_id, status, created_at, expires_at, responded_at
       )
       SELECT md5('historical-invitation-' || series)::uuid, $1, $2, $3,
              'historical-' || series, 'declined', $4::timestamptz,
              $4::timestamptz + interval '1 day', $4::timestamptz
       FROM generate_series(1, 1000) series`,
      [oldKingdom, target.playerId, oldLeader.playerId, now]
    );
    const domain = service();
    const invitationA = await domain.invitePlayer(leaderA.playerId, {
      requestId: "audience-current-a",
      targetPlayerId: target.playerId
    });
    const invitationB = await domain.invitePlayer(leaderB.playerId, {
      requestId: "audience-current-b",
      targetPlayerId: target.playerId
    });
    expect(invitationA.notificationPlayerIds).toEqual([
      leaderA.playerId,
      officerA.playerId,
      target.playerId
    ].sort());
    expect(invitationA.notificationPlayerIds).not.toContain(ordinaryA.playerId);
    const invitationAId = invitationA.state!.invitations.find(
      ({ kingdomId, status }) => kingdomId === kingdomA && status === "pending"
    )!.id;
    expect((await domain.getState(ordinaryA.playerId)).invitations).toEqual([]);
    expect((await domain.getState(officerA.playerId)).invitations).toContainEqual(
      expect.objectContaining({ id: invitationAId, targetPlayerId: target.playerId })
    );

    const accepted = await domain.respondToInvitation(target.playerId, {
      requestId: "audience-accept-a",
      invitationId: invitationAId,
      response: "accept"
    });
    expect(accepted.notificationPlayerIds).toEqual([
      target.playerId,
      leaderA.playerId,
      officerA.playerId,
      leaderB.playerId,
      officerB.playerId
    ].sort());
    expect(accepted.notificationPlayerIds).not.toContain(oldLeader.playerId);
    expect(accepted.notificationPlayerIds).not.toContain(oldOfficer.playerId);
    expect(accepted.notificationPlayerIds).not.toContain(ordinaryA.playerId);
    expect(invitationB.notificationPlayerIds).toHaveLength(3);
  });

  it("enforces capacity and role authority through removal, ban, unban, transfer, and leave", async () => {
    const leader = await player("RoleLeader");
    const roleFounded = await found(leader, "Role Realm");
    const sourceFlagId = roleFounded.state!.kingdom!.seat!.sourceFlagId!;
    const officer = await player("RoleOfficer");
    const member = await player("RoleMember");
    const domain = service();

    const officerInvite = await domain.invitePlayer(leader.playerId, {
      requestId: "invite-officer",
      targetPlayerId: officer.playerId
    });
    await domain.respondToInvitation(officer.playerId, {
      requestId: "accept-officer",
      invitationId: officerInvite.state!.invitations.find(
        ({ targetPlayerId, status }) => targetPlayerId === officer.playerId && status === "pending"
      )!.id,
      response: "accept"
    });
    await domain.memberAction(leader.playerId, {
      requestId: "promote-officer",
      targetPlayerId: officer.playerId,
      action: "promote"
    });
    const memberInvite = await domain.invitePlayer(officer.playerId, {
      requestId: "invite-member",
      targetPlayerId: member.playerId
    });
    await domain.respondToInvitation(member.playerId, {
      requestId: "accept-member",
      invitationId: memberInvite.state!.invitations.find(
        ({ targetPlayerId, status }) => targetPlayerId === member.playerId && status === "pending"
      )!.id,
      response: "accept"
    });
    await expect(domain.muteMember(officer.playerId, {
      requestId: "mute-self", targetPlayerId: officer.playerId, action: "mute"
    })).rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await domain.memberAction(leader.playerId, {
      requestId: "promote-equal", targetPlayerId: member.playerId, action: "promote"
    });
    await expect(domain.memberAction(officer.playerId, {
      requestId: "remove-equal", targetPlayerId: member.playerId, action: "remove"
    })).rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await domain.memberAction(leader.playerId, {
      requestId: "demote-equal", targetPlayerId: member.playerId, action: "demote"
    });
    await expect(domain.memberAction(member.playerId, {
      requestId: "member-moderates", targetPlayerId: officer.playerId, action: "remove"
    })).rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await expect(domain.memberAction(officer.playerId, {
      requestId: "remove-leader",
      targetPlayerId: leader.playerId,
      action: "remove"
    })).rejects.toMatchObject({ code: "KINGDOM_LEADER_PROTECTED" });
    await domain.memberAction(officer.playerId, {
      requestId: "remove-member",
      targetPlayerId: member.playerId,
      action: "remove"
    });
    await expect(domain.sendChat(member.playerId, { requestId: "removed-chat", content: "No access" }))
      .rejects.toMatchObject({ code: "KINGDOM_MEMBERSHIP_REQUIRED" });

    const reinvite = await domain.invitePlayer(leader.playerId, {
      requestId: "reinvite-member",
      targetPlayerId: member.playerId
    });
    await domain.respondToInvitation(member.playerId, {
      requestId: "reaccept-member",
      invitationId: reinvite.state!.invitations.find(
        ({ targetPlayerId, status }) => targetPlayerId === member.playerId && status === "pending"
      )!.id,
      response: "accept"
    });
    await domain.memberAction(leader.playerId, {
      requestId: "ban-member",
      targetPlayerId: member.playerId,
      action: "ban"
    });
    expect((await domain.getState(leader.playerId)).roster).toContainEqual(
      expect.objectContaining({ playerId: member.playerId, status: "banned" })
    );
    await domain.memberAction(leader.playerId, {
      requestId: "demote-banned-viewer",
      targetPlayerId: officer.playerId,
      action: "demote"
    });
    expect((await domain.getState(officer.playerId)).roster).not.toContainEqual(
      expect.objectContaining({ playerId: member.playerId, status: "banned" })
    );
    await domain.memberAction(leader.playerId, {
      requestId: "restore-officer",
      targetPlayerId: officer.playerId,
      action: "promote"
    });
    await expect(domain.invitePlayer(leader.playerId, {
      requestId: "invite-banned",
      targetPlayerId: member.playerId
    })).rejects.toMatchObject({ code: "KINGDOM_MEMBER_BANNED" });
    await domain.memberAction(leader.playerId, {
      requestId: "unban-member",
      targetPlayerId: member.playerId,
      action: "unban"
    });

    await domain.memberAction(leader.playerId, {
      requestId: "transfer",
      targetPlayerId: officer.playerId,
      action: "transfer_leadership"
    });
    await domain.leaveKingdom(leader.playerId, "old-leader-leaves");
    const transferredState = await domain.getState(officer.playerId);
    expect(transferredState.membership).toMatchObject({ role: "leader" });
    expect(transferredState.kingdom!.seat).toMatchObject({
      id: roleFounded.state!.kingdom!.seat!.id,
      sourceFlagId
    });
    expect((await pool.query<{ control_type: string; kingdom_id: string | null }>(
      "SELECT control_type, kingdom_id FROM flags WHERE id = $1", [sourceFlagId]
    )).rows[0]).toEqual({
      control_type: "kingdom_seat",
      kingdom_id: roleFounded.state!.kingdom!.id
    });
    expect((await domain.getState(leader.playerId)).membership).toBeNull();

    const capacityTarget = await player("CapacityTarget");
    const kingdomId = (await domain.getState(officer.playerId)).kingdom!.id;
    const capacityInvite = await domain.invitePlayer(officer.playerId, {
      requestId: "capacity-invite",
      targetPlayerId: capacityTarget.playerId
    });
    for (let index = 0; index < 9; index += 1) {
      const extra = await player(`Capacity${index}`);
      await pool.query(
        `INSERT INTO kingdom_memberships (
           id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
         ) VALUES ($1,$2,$3,'member','active',$4,$4)`,
        [randomUUID(), kingdomId, extra.playerId, now]
      );
    }
    await expect(domain.respondToInvitation(capacityTarget.playerId, {
      requestId: "capacity-accept",
      invitationId: capacityInvite.state!.invitations.find(
        ({ targetPlayerId, status }) => targetPlayerId === capacityTarget.playerId && status === "pending"
      )!.id,
      response: "accept"
    })).rejects.toMatchObject({ code: "KINGDOM_MEMBER_CAPACITY_REACHED" });
  });

  it("persists bounded private chat with replay, mute, membership, and block enforcement", async () => {
    const leader = await player("ChatLeader");
    const member = await player("ChatMember");
    const outsider = await player("ChatOutsider");
    await found(leader, "Chat Realm");
    const domain = service({ KINGDOM_CHAT_RETENTION_LIMIT: 3 });
    const invitation = await domain.invitePlayer(leader.playerId, {
      requestId: "chat-invite",
      targetPlayerId: member.playerId
    });
    await domain.respondToInvitation(member.playerId, {
      requestId: "chat-accept",
      invitationId: invitation.state!.invitations.find(
        ({ targetPlayerId, status }) => targetPlayerId === member.playerId && status === "pending"
      )!.id,
      response: "accept"
    });

    const first = await domain.sendChat(member.playerId, { requestId: "chat-one", content: "  Hello realm  " });
    const replay = await domain.sendChat(member.playerId, { requestId: "chat-one", content: "  Hello realm  " });
    expect(first).toMatchObject({ message: { content: "Hello realm" }, replayed: false });
    expect(first.recipientPlayerIds).toEqual(expect.arrayContaining([leader.playerId, member.playerId]));
    expect(replay).toMatchObject({
      message: null,
      messageId: first.message!.id,
      recipientPlayerIds: [],
      replayed: true
    });
    const replayRow = await pool.query<{ response: Record<string, unknown> }>(
      `SELECT response FROM kingdom_requests
       WHERE actor_player_id = $1 AND request_id = 'chat-one'`,
      [member.playerId]
    );
    expect(replayRow.rows[0]?.response).toEqual({
      kingdomId: first.kingdomId,
      messageId: first.message!.id
    });
    expect(JSON.stringify(replayRow.rows[0]?.response)).not.toContain("Hello realm");
    expect(replayRow.rows[0]?.response).not.toHaveProperty("recipientPlayerIds");
    await expect(domain.sendChat(outsider.playerId, { requestId: "outsider", content: "Leak" }))
      .rejects.toMatchObject({ code: "KINGDOM_MEMBERSHIP_REQUIRED" });

    await domain.muteMember(leader.playerId, {
      requestId: "mute-member",
      targetPlayerId: member.playerId,
      action: "mute",
      mutedUntil: "2026-07-10T13:00:00.000Z"
    });
    await expect(domain.sendChat(member.playerId, { requestId: "muted", content: "Muted" }))
      .rejects.toMatchObject({ code: "KINGDOM_CHAT_MUTED" });
    await domain.muteMember(leader.playerId, {
      requestId: "unmute-member",
      targetPlayerId: member.playerId,
      action: "unmute"
    });
    expect((await domain.getState(member.playerId)).membership!.chatMute).toEqual({ state: "not_muted" });
    await domain.muteMember(leader.playerId, {
      requestId: "mute-member-indefinitely",
      targetPlayerId: member.playerId,
      action: "mute"
    });
    expect((await domain.getState(member.playerId)).membership!.chatMute)
      .toEqual({ state: "muted_indefinitely" });
    await expect(domain.sendChat(member.playerId, { requestId: "muted-indefinitely", content: "Muted" }))
      .rejects.toMatchObject({ code: "KINGDOM_CHAT_MUTED" });
    await domain.muteMember(leader.playerId, {
      requestId: "unmute-member-indefinitely",
      targetPlayerId: member.playerId,
      action: "unmute"
    });

    await pool.query(
      "INSERT INTO player_blocks (blocker_id, blocked_id) VALUES ($1,$2)",
      [leader.playerId, member.playerId]
    );
    const blocked = await domain.sendChat(member.playerId, { requestId: "blocked", content: "Blocked recipient" });
    expect(blocked.recipientPlayerIds).not.toContain(leader.playerId);
    expect((await domain.getState(leader.playerId)).chatHistory).toEqual([]);
    expect((await domain.getState(member.playerId)).chatHistory).toContainEqual(
      expect.objectContaining({ id: blocked.message!.id, content: "Blocked recipient" })
    );
    for (let index = 0; index < 4; index += 1) {
      now = new Date(now.getTime() + 1_000);
      await domain.sendChat(member.playerId, { requestId: `retained-${index}`, content: `Message ${index}` });
    }
    const kingdomId = (await domain.getState(member.playerId)).kingdom!.id;
    const retained = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM kingdom_chat_messages WHERE kingdom_id = $1",
      [kingdomId]
    );
    expect(retained.rows[0]?.count).toBe("3");
    expect((await pool.query(
      "SELECT 1 FROM kingdom_chat_messages WHERE id = $1",
      [first.message!.id]
    )).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM kingdom_requests
       WHERE actor_player_id = $1 AND request_id = 'chat-one'`,
      [member.playerId]
    )).rowCount).toBe(1);
  });

  it("moves inventory to treasury atomically, replays safely, serializes overspend, and grants zero XP", async () => {
    const leader = await player("DonateLeader");
    await found(leader, "Treasury Realm");
    await grantInventory(pool, leader.playerId, "wood", 100);
    const domain = service();

    const first = await domain.donate(leader.playerId, {
      requestId: "donate-first",
      resourceType: "wood",
      quantity: 40
    });
    const replay = await domain.donate(leader.playerId, {
      requestId: "donate-first",
      resourceType: "wood",
      quantity: 40
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(first.state!.donationHistory?.[0]).not.toHaveProperty("requestId");
    const concurrent = await Promise.allSettled([
      domain.donate(leader.playerId, { requestId: "donate-race-a", resourceType: "wood", quantity: 40 }),
      domain.donate(leader.playerId, { requestId: "donate-race-b", resourceType: "wood", quantity: 40 })
    ]);
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(concurrent.find(({ status }) => status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "KINGDOM_DONATION_INSUFFICIENT_BALANCE" })
    });

    const kingdomId = first.state!.kingdom!.id;
    const balances = await pool.query<{
      player_quantity: number;
      treasury_quantity: string;
      ledger_quantity: string;
      lifetime_xp: string;
      inventory_delta: string;
    }>(
      `SELECT
         (SELECT quantity FROM player_inventory
          WHERE player_id = $1 AND resource_type = 'wood' AND variant = 'default') AS player_quantity,
         (SELECT quantity::text FROM kingdom_treasury_balances
          WHERE kingdom_id = $2 AND resource_type = 'wood' AND variant = 'default') AS treasury_quantity,
         (SELECT COALESCE(sum(quantity),0)::text FROM kingdom_donations WHERE kingdom_id = $2) AS ledger_quantity,
         (SELECT lifetime_xp::text FROM kingdoms WHERE id = $2) AS lifetime_xp,
         (SELECT COALESCE(sum(delta_quantity),0)::text FROM inventory_events
          WHERE player_id = $1 AND source = 'kingdom_donation') AS inventory_delta`,
      [leader.playerId, kingdomId]
    );
    expect(balances.rows[0]).toEqual({
      player_quantity: "20",
      treasury_quantity: "80",
      ledger_quantity: "80",
      lifetime_xp: "0",
      inventory_delta: "-80"
    });
    expect(first.state!.donationHistory?.[0]?.kingdomXpGranted).toBe(0);
    expect((await pool.query(
      "SELECT 1 FROM kingdom_xp_ledger WHERE kingdom_id = $1",
      [kingdomId]
    )).rowCount).toBe(0);
    await expect(domain.donate(leader.playerId, {
      requestId: "donate-too-much",
      resourceType: "wood",
      quantity: 21
    })).rejects.toMatchObject({ code: "KINGDOM_DONATION_INSUFFICIENT_BALANCE" });
  });

  it("refuses new advancement projects now that member XP levels the Kingdom", async () => {
    const leader = await player("RetiredProjectLeader");
    const kingdomId = (await found(leader, "Retired Project Realm")).state!.kingdom!.id;
    await creditTreasury(kingdomId, [
      { resourceType: "wood", quantity: 150 },
      { resourceType: "stone", quantity: 100 },
      { resourceType: "leather", quantity: 50 }
    ]);
    await expect(service().startAdvancementProject(leader.playerId, {
      requestId: "retired-project",
      targetLevel: 2
    })).rejects.toMatchObject({ code: "KINGDOM_ADVANCEMENT_RETIRED" });
    const untouched = await pool.query<{ projects: string; debits: string }>(
      `SELECT
         (SELECT count(*)::text FROM kingdom_projects WHERE kingdom_id = $1) AS projects,
         (SELECT count(*)::text FROM kingdom_treasury_expenditures WHERE kingdom_id = $1) AS debits`,
      [kingdomId]
    );
    expect(untouched.rows[0]).toEqual({ projects: "0", debits: "0" });
  });

  it("preserves capacities and perks from a higher persisted legacy level", async () => {
    const leader = await player("LegacyLevelLeader");
    const kingdomId = (await found(leader, "Legacy Level Realm")).state!.kingdom!.id;
    await pool.query(
      "UPDATE kingdoms SET level = 4, current_xp = 0, lifetime_xp = 0 WHERE id = $1",
      [kingdomId]
    );
    await pool.query(
      "UPDATE kingdom_memberships SET perk_qualified_at = $2 WHERE kingdom_id = $1",
      [kingdomId, now]
    );

    const domain = service();
    await expect(domain.getState(leader.playerId)).resolves.toMatchObject({
      kingdom: { level: 4 },
      progression: {
        level: 4,
        nextLevelXp: 436_000,
        capacities: {
          memberCapacity: 30,
          cotCapacity: 30,
          decorationCapacity: 70
        }
      }
    });
    // Perks are chosen, not unlocked by level: a level 4 kingdom created
    // after the perk tree has none until its leader picks them.
    await expect(domain.statModifiers(leader.playerId)).resolves.toMatchObject({
      qualified: true,
      perkIds: [],
      attackBonus: 0,
      defenseBonus: 0
    });
  });

  it("unlocks qualified perks from authoritative Kingdom XP and revokes them on leave", async () => {
    const leader = await player("PerkLeader");
    const member = await player("PerkMember");
    await found(leader, "Perk Realm");
    const domain = service();
    const invitation = await domain.invitePlayer(leader.playerId, {
      requestId: "perk-invite",
      targetPlayerId: member.playerId
    });
    await domain.respondToInvitation(member.playerId, {
      requestId: "perk-accept",
      invitationId: invitation.state!.invitations.find(
        ({ targetPlayerId, status }) => targetPlayerId === member.playerId && status === "pending"
      )!.id,
      response: "accept"
    });
    // Member XP reached the level 2 threshold (the feed itself is covered by
    // kingdomMemberXpMigration.integration.test.ts).
    await pool.query(
      "UPDATE kingdoms SET current_xp = 46000, lifetime_xp = 46000 WHERE id = (SELECT kingdom_id FROM kingdom_memberships WHERE player_id = $1 AND status = 'active')",
      [leader.playerId]
    );
    now = new Date(now.getTime() + 10 * 60_000 + 1);
    const leveled = await domain.getState(leader.playerId);
    expect(leveled.progression).toMatchObject({
      level: 2,
      perks: expect.arrayContaining([
        expect.objectContaining({ id: "boundary_writ", unlocked: true, selected: false, active: false })
      ])
    });
    expect(await domain.statModifiers(member.playerId)).toMatchObject({ attackBonus: 0, defenseBonus: 0 });
    await pool.query(
      `INSERT INTO kingdom_treasury_balances (kingdom_id, resource_type, variant, quantity)
       VALUES ($1,'bricks','default',23500), ($1,'refined_oil','default',1150)
       ON CONFLICT (kingdom_id, resource_type, variant) DO UPDATE SET quantity=EXCLUDED.quantity`,
      [leveled.kingdom!.id]
    );
    await domain.chooseKingdomPerk(leader.playerId, {
      requestId: "perk-choose", perkId: "boundary_writ", expectedCurrentPerkId: null
    });
    expect(await domain.statModifiers(member.playerId)).toMatchObject({
      kingdomId: leveled.kingdom!.id,
      perkIds: ["boundary_writ"],
      defenseBonus: 2,
      attackBonus: 2,
      qualified: true
    });
    await domain.leaveKingdom(member.playerId, "perk-leave");
    expect(await domain.statModifiers(member.playerId)).toEqual({
      kingdomId: null,
      attackBonus: 0,
      defenseBonus: 0,
      perkIds: [],
      qualified: false
    });
  });

  it("places cots and decorations from authoritative positions with replay, collision, and permission checks", async () => {
    const leader = await player("BuildLeader");
    const member = await player("BuildMember", { lat: 35.0844, lon: -106.64985 });
    await found(leader, "Builder Realm");
    const domain = service();
    const invitation = await domain.invitePlayer(leader.playerId, {
      requestId: "build-invite",
      targetPlayerId: member.playerId
    });
    await domain.respondToInvitation(member.playerId, {
      requestId: "build-accept",
      invitationId: invitation.state!.invitations.find(
        ({ targetPlayerId, status }) => targetPlayerId === member.playerId && status === "pending"
      )!.id,
      response: "accept"
    });

    leader.position = { lat: 35.0849, lon: -106.6504 };
    const cot = await domain.placeCot(leader, { requestId: "cot-one", rotation: 15 });
    const cotReplay = await domain.placeCot(leader, { requestId: "cot-one", rotation: 15 });
    const cotId = cot.state!.cots[0]!.id;
    expect(cot.state!.cots).toHaveLength(1);
    expect(cot.spatialChanges).toMatchObject([{
      previous: null,
      current: { entityType: "object", id: cotId, objectKind: "cot" }
    }]);
    expect(cotReplay).toMatchObject({ replayed: true, state: { cots: [{ rotation: 15 }] } });
    await expect(domain.placeCot(leader, { requestId: "cot-two" }))
      .rejects.toMatchObject({ code: "KINGDOM_COT_ALREADY_PLACED" });
    await expect(domain.mutateCot(member, {
      requestId: "pack-another-cot",
      cotId,
      action: "pack"
    })).rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    leader.position = { lat: 35.0852, lon: -106.6504 };
    const movedCot = await domain.mutateCot(leader, {
      requestId: "move-own-cot",
      cotId,
      action: "move",
      rotation: 45
    });
    expect(movedCot.state!.cots[0]).toMatchObject({ id: cotId, lat: 35.0852, rotation: 45 });
    expect(movedCot.spatialChanges).toMatchObject([{
      previous: { object: { lat: 35.0849 } },
      current: { object: { lat: 35.0852 } }
    }]);
    const packedCot = await domain.mutateCot(leader, {
      requestId: "pack-own-cot",
      cotId,
      action: "pack"
    });
    expect(packedCot.state!.cots).toHaveLength(0);
    expect(packedCot.spatialChanges).toMatchObject([{
      previous: { entityType: "object", id: cotId },
      current: null
    }]);
    await expect(domain.placeDecoration(member, {
      requestId: "locked-training-post",
      typeId: "training_post",
      kingdomOwned: true
    })).rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    const banner = await domain.placeDecoration(member, {
      requestId: "banner-one",
      typeId: "banner",
      kingdomOwned: false,
      rotation: 30
    });
    const bannerId = banner.state!.decorations[0]!.id;
    expect(banner.state!.decorations[0]).toMatchObject({
      typeId: "banner",
      personalOwnerPlayerId: member.playerId,
      kingdomOwned: false,
      completedUnderFreeConstruction: true
    });
    const nearbyObserver = await player("NearbyObserver", { lat: 35.0844, lon: -106.6497 });
    const nearbyState = await domain.getState(nearbyObserver);
    expect(nearbyState.nearbyObjects).toContainEqual(expect.objectContaining({
      id: bannerId,
      kingdomId: banner.state!.kingdom!.id,
      kind: "decoration",
      typeId: "banner"
    }));
    expect(nearbyState.nearbyObjects?.some((object) => "personalOwnerPlayerId" in object)).toBe(false);
    const distantObserver = await player("DistantObserver", { lat: 36.0, lon: -106.0 });
    expect((await domain.getState(distantObserver)).nearbyObjects).toEqual([]);
    await expect(domain.placeDecoration(member, {
      requestId: "banner-collision",
      typeId: "crate",
      kingdomOwned: false
    })).rejects.toMatchObject({ code: "KINGDOM_PLACEMENT_COLLISION" });

    member.position = { lat: 35.0839, lon: -106.6504 };
    const moved = await domain.mutateDecoration(member, {
      requestId: "move-banner",
      decorationId: bannerId,
      action: "move",
      rotation: 90
    });
    expect(moved.state!.decorations[0]).toMatchObject({ id: bannerId, lat: 35.0839, rotation: 90 });
    expect(moved.spatialChanges).toMatchObject([{
      previous: { entityType: "object", id: bannerId },
      current: { object: { lat: 35.0839, rotation: 90 } }
    }]);
    const removed = await domain.mutateDecoration(member, {
      requestId: "remove-banner",
      decorationId: bannerId,
      action: "remove"
    });
    expect(removed.state!.decorations).toHaveLength(0);
    expect(removed.spatialChanges).toMatchObject([{
      previous: { entityType: "object", id: bannerId },
      current: null
    }]);
    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM kingdom_audit_events
       WHERE entity_id = $1 ORDER BY created_at, id`,
      [bannerId]
    );
    expect(audit.rows.map(({ event_type }) => event_type)).toEqual([
      "decoration_placed",
      "decoration_moved",
      "decoration_removed"
    ]);
  });

  it("emits revisioned removals for a departing member's cot and personal decorations only", async () => {
    const leader = await player("CleanupLeader");
    const member = await player("CleanupMember", { lat: 35.0849, lon: -106.6504 });
    await found(leader, "Cleanup Realm");
    const domain = service();
    const invitation = await domain.invitePlayer(leader.playerId, {
      requestId: "cleanup-invite", targetPlayerId: member.playerId
    });
    await domain.respondToInvitation(member.playerId, {
      requestId: "cleanup-accept",
      invitationId: invitation.state!.invitations.find(
        ({ targetPlayerId, status }) => targetPlayerId === member.playerId && status === "pending"
      )!.id,
      response: "accept"
    });
    const cot = await domain.placeCot(member, { requestId: "cleanup-cot" });
    member.position = { lat: 35.0844, lon: -106.6498 };
    const personal = await domain.placeDecoration(member, {
      requestId: "cleanup-personal", typeId: "banner", kingdomOwned: false
    });
    leader.position = { lat: 35.0841, lon: -106.6504 };
    const kingdomOwned = await domain.placeDecoration(leader, {
      requestId: "cleanup-kingdom", typeId: "crate", kingdomOwned: true
    });

    const left = await domain.leaveKingdom(member.playerId, "cleanup-leave");
    const removals = left.spatialChanges?.filter(({ current }) => current === null) ?? [];
    expect(removals.map(({ previous }) => previous!.id).sort()).toEqual([
      cot.state!.cots[0]!.id,
      personal.state!.decorations.find(({ personalOwnerPlayerId }) => personalOwnerPlayerId === member.playerId)!.id
    ].sort());
    expect(removals.every(({ spatialRevision }) => /^\d+$/.test(spatialRevision))).toBe(true);
    expect(left.spatialChanges?.at(-1)?.current).toMatchObject({
      entityType: "seat",
      kingdom: { memberCount: 1 }
    });
    const retained = await pool.query<{ status: string }>(
      "SELECT status FROM kingdom_decorations WHERE id = $1",
      [kingdomOwned.state!.decorations.find(({ kingdomOwned: owned }) => owned)!.id]
    );
    expect(retained.rows[0]?.status).toBe("active");
    const replay = await domain.leaveKingdom(member.playerId, "cleanup-leave");
    expect(replay).toMatchObject({ replayed: true, spatialChanges: [] });
  });

  it("serializes rapid cot moves with distinct durable revisions and replay silence", async () => {
    const leader = await player("RevisionLeader");
    await found(leader, "Revision Realm");
    const domain = service();
    leader.position = { lat: 35.0849, lon: -106.6504 };
    const placed = await domain.placeCot(leader, { requestId: "revision-cot" });
    const cotId = placed.state!.cots[0]!.id;

    leader.position = { lat: 35.0852, lon: -106.6504 };
    const firstPromise = domain.mutateCot(leader, { requestId: "revision-move-a", cotId, action: "move" });
    leader.position = { lat: 35.0844, lon: -106.6498 };
    const secondPromise = domain.mutateCot(leader, { requestId: "revision-move-b", cotId, action: "move" });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const revisions = [first.spatialChanges![0]!.spatialRevision, second.spatialChanges![0]!.spatialRevision];
    expect(new Set(revisions).size).toBe(2);
    expect(revisions.every((revision) => BigInt(revision) > BigInt(placed.spatialChanges![0]!.spatialRevision)))
      .toBe(true);
    const persisted = await pool.query<{ spatial_revision: string }>(
      "SELECT spatial_revision FROM kingdom_cots WHERE id = $1", [cotId]
    );
    expect(revisions).toContain(String(persisted.rows[0]!.spatial_revision));
    const replay = await domain.mutateCot(leader, {
      requestId: "revision-move-a", cotId, action: "move"
    });
    expect(replay).toMatchObject({ replayed: true, spatialChanges: [] });
  });

  it("requires an owned nearby source flag and revalidates the exact selection", async () => {
    const founder = await player("SourceRequiredFounder");
    const domain = service({}, {}, false);
    await expect(domain.quoteFounding(founder, {
      requestId: "no-source", displayName: "No Source Realm"
    })).resolves.toMatchObject({
      eligible: false,
      blockerCode: "KINGDOM_FOUNDING_NO_FLAG_TERRITORY",
      sourceFlag: null
    });

    const sourceFlagId = await ensureFoundingSourceFlag(founder);
    const quote = await domain.quoteFounding(founder, {
      requestId: "source-quote", displayName: "Source Realm", sourceFlagId
    });
    expect(quote).toMatchObject({
      position: founder.position,
      territoryRadiusM: 200,
      sourceFlag: { id: sourceFlagId, name: "SourceRequiredFounder Founding Flag", claimRadiusM: 200 },
      eligible: true,
      disabledReason: null
    });

    const outsider = await player("SourceOutsider", { ...founder.position });
    await expect(domain.quoteFounding(outsider, {
      requestId: "foreign-source", displayName: "Foreign Source Realm", sourceFlagId
    })).resolves.toMatchObject({
      eligible: false,
      blockerCode: "KINGDOM_FLAG_NOT_OWNER",
      sourceFlag: { id: sourceFlagId, ownedByPlayer: false }
    });

    founder.position = await pointAtDistance(quote.position, 200.06);
    await expect(domain.foundKingdom(founder, {
      requestId: "moved-source", displayName: "Source Realm", sourceFlagId
    })).rejects.toMatchObject({ code: "KINGDOM_FOUNDING_OUTSIDE_TERRITORY" });

    founder.position = { ...quote.position };
    await pool.query("UPDATE flags SET owner_id = $2 WHERE id = $1", [sourceFlagId, outsider.playerId]);
    await expect(domain.foundKingdom(founder, {
      requestId: "changed-owner", displayName: "Source Realm", sourceFlagId
    })).rejects.toMatchObject({ code: "KINGDOM_FOUNDING_FLAG_OWNERSHIP_CHANGED" });
  });

  it("accepts the canonical territory edge and rejects the first point beyond it", async () => {
    const founder = await player("TerritoryEdgeFounder", { lat: 35.7, lon: -106.1 });
    const sourceFlagId = await ensureFoundingSourceFlag(founder);
    const sourcePosition = { ...founder.position };
    const domain = service({}, {}, false);

    founder.position = await pointAtDistance(sourcePosition, 200.05, 90);
    await expect(domain.quoteFounding(founder, {
      requestId: "accepted-territory-edge",
      displayName: "Edge Realm",
      sourceFlagId
    })).resolves.toMatchObject({
      sourceFlag: { id: sourceFlagId, lat: sourcePosition.lat, lon: sourcePosition.lon },
      seatPosition: founder.position
    });

    founder.position = await pointAtDistance(sourcePosition, 200.051, 90);
    await expect(domain.quoteFounding(founder, {
      requestId: "outside-territory-edge",
      displayName: "Outside Realm",
      sourceFlagId
    })).resolves.toMatchObject({
      eligible: false,
      blockerCode: "KINGDOM_FOUNDING_OUTSIDE_TERRITORY"
    });
  });

  it("selects the lowest stable flag ID when eligible owned territories overlap equally", async () => {
    const founder = await player("DeterministicFounder", { lat: 35.8, lon: -106.2 });
    const lowerId = "00000000-0000-4000-8000-000000000010";
    const higherId = "00000000-0000-4000-8000-000000000020";
    await pool.query(
      `WITH centers AS (
         SELECT ST_Project(
                  ST_SetSRID(ST_MakePoint($5,$4),4326)::geography,
                  100,
                  radians(bearing)
                )::geometry AS geom,
                id, name
         FROM (VALUES ($1::uuid, 'Lower ID'::text, 90::double precision),
                      ($2::uuid, 'Higher ID'::text, 270::double precision))
              values(id, name, bearing)
       )
       INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       SELECT id,$3,name,ST_Y(geom),ST_X(geom),150,geom
       FROM centers
       ORDER BY id`,
      [lowerId, higherId, founder.playerId, founder.position.lat, founder.position.lon]
    );

    await expect(service({}, {}, false).quoteFounding(founder, {
      requestId: "deterministic-source",
      displayName: "Deterministic Realm"
    })).resolves.toMatchObject({ sourceFlag: { id: lowerId } });
  });

  it("prefers an eligible owned flag over an ineligible overlapping flag", async () => {
    const founder = await player("EligibleOverlapFounder", { lat: 35.95, lon: -106.25 });
    const other = await player("EligibleOverlapOther", { ...founder.position });
    const ownedFlagId = randomUUID();
    const foreignFlagId = randomUUID();
    const ownedPosition = await pointAtDistance(founder.position, 250, 90);
    const foreignPosition = await pointAtDistance(founder.position, 250, 270);
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom) VALUES
       ($1,$3,'Owned eligible flag',$5,$6,300,ST_SetSRID(ST_MakePoint($6,$5),4326)),
       ($2,$4,'Foreign ineligible flag',$7,$8,300,ST_SetSRID(ST_MakePoint($8,$7),4326))`,
      [ownedFlagId, foreignFlagId, founder.playerId, other.playerId,
        ownedPosition.lat, ownedPosition.lon, foreignPosition.lat, foreignPosition.lon]
    );

    await expect(service({}, {}, false).quoteFounding(founder, {
      requestId: "prefer-eligible-overlap",
      displayName: "Preferred Realm"
    })).resolves.toMatchObject({
      eligible: true,
      sourceFlag: { id: ownedFlagId }
    });
    expect(foreignFlagId).not.toBe(ownedFlagId);
  });

  it("selects a deterministic specific blocker when only ineligible flags overlap", async () => {
    const founder = await player("BlockedOverlapFounder", { lat: 35.97, lon: -106.27 });
    const ownerA = await player("BlockedOverlapA", { ...founder.position });
    const ownerB = await player("BlockedOverlapB", { ...founder.position });
    const lowerId = "00000000-0000-4000-8000-000000000030";
    const higherId = "00000000-0000-4000-8000-000000000040";
    const lowerPosition = await pointAtDistance(founder.position, 250, 90);
    const higherPosition = await pointAtDistance(founder.position, 250, 270);
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom) VALUES
       ($1,$3,'Lower foreign flag',$5,$6,300,ST_SetSRID(ST_MakePoint($6,$5),4326)),
       ($2,$4,'Higher foreign flag',$7,$8,300,ST_SetSRID(ST_MakePoint($8,$7),4326))`,
      [lowerId, higherId, ownerA.playerId, ownerB.playerId,
        lowerPosition.lat, lowerPosition.lon, higherPosition.lat, higherPosition.lon]
    );

    await expect(service({}, {}, false).quoteFounding(founder, {
      requestId: "deterministic-blocker",
      displayName: "Blocked Realm"
    })).resolves.toMatchObject({
      eligible: false,
      blockerCode: "KINGDOM_FLAG_NOT_OWNER",
      sourceFlag: { id: lowerId, ownerDisplayName: ownerA.username }
    });
  });

  it("rejects a city-controlled flag as a founding source", async () => {
    const founder = await player("CityFlagFounder", { lat: 36.2, lon: -105.2 });
    const sourceFlagId = await ensureFoundingSourceFlag(founder);
    const cityId = await affiliateFlagWithTestCity(
      founder.playerId,
      sourceFlagId,
      "Founding Source City"
    );

    await expect(service({}, {}, false).quoteFounding(founder, {
      requestId: "city-source", displayName: "City Source Realm", sourceFlagId
    })).resolves.toMatchObject({
      eligible: false,
      blockerCode: "KINGDOM_FLAG_CITY_AFFILIATED",
      sourceFlag: { id: sourceFlagId }
    });
    expect(cityId).toBeTruthy();
  });

  it("preserves overlapping personal flags when founding and replays without mutation", async () => {
    const avery = await player("AveryFounder");
    const other = await player("NearbyOwner", { ...avery.position });
    const flagA = await ensureFoundingSourceFlag(avery);
    const flagB = await createFlagAtFlagDistance(avery, flagA, 250, 0, "Flag B");
    const flagC = await createFlagAtFlagDistance(avery, flagA, 250, 180, "Flag C");
    const flagD = await createFlagAtFlagDistance(avery, flagA, 400, 90, "Flag D");
    const otherFlag = await createFlagAtFlagDistance(other, flagA, 250, 90, "Other Personal");
    const domain = service({}, {}, false);
    const input = {
      requestId: "preserve-overlapping-founder-flags",
      displayName: "Avery Kingdom",
      sourceFlagId: flagA
    };

    await expect(domain.quoteFounding(avery, input)).resolves.toMatchObject({
      sourceFlag: { id: flagA },
      absorbedFlagCount: 0
    });
    const founded = await domain.foundKingdom(avery, input);
    const kingdomId = founded.state!.kingdom!.id;
    expect(founded.affectedFlagIds).toEqual([flagA]);
    expect(founded.state!.kingdom!.seat!.sourceFlagId).toBe(flagA);
    expect(founded.state!.kingdomFlags).toEqual([]);

    const stored = await pool.query<{
      id: string; owner_id: string; control_type: string; kingdom_id: string | null;
      contributed_by_player_id: string | null; original_owner_player_id: string | null;
    }>(
      `SELECT id, owner_id, control_type, kingdom_id,
              contributed_by_player_id, original_owner_player_id
       FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[flagA, flagB, flagC, flagD, otherFlag]]
    );
    const byId = new Map(stored.rows.map((row) => [row.id, row]));
    expect(byId.get(flagA)).toMatchObject({
      owner_id: avery.playerId, control_type: "kingdom_seat", kingdom_id: kingdomId,
      contributed_by_player_id: null, original_owner_player_id: avery.playerId
    });
    for (const id of [flagB, flagC, flagD]) {
      expect(byId.get(id)).toMatchObject({
        owner_id: avery.playerId, control_type: "personal", kingdom_id: null,
        contributed_by_player_id: null, original_owner_player_id: null
      });
    }
    expect(byId.get(otherFlag)).toMatchObject({
      owner_id: other.playerId, control_type: "personal", kingdom_id: null
    });

    const mapFlags = new Map((await flagService().listFlags()).map((flag) => [flag.id, flag]));
    expect(mapFlags.get(flagA)).toMatchObject({ controlType: "kingdom_seat", kingdomId });
    expect(mapFlags.get(flagB)).toMatchObject({ controlType: "personal", kingdomId: null });
    expect(mapFlags.get(flagC)).toMatchObject({ controlType: "personal", kingdomId: null });
    expect(mapFlags.get(flagD)).toMatchObject({ controlType: "personal", kingdomId: null });
    expect(mapFlags.get(otherFlag)).toMatchObject({
      controlType: "personal", kingdomId: null, ownerColor: "#3366cc"
    });

    const historyBeforeReplay = await pool.query<{ count: string }>(
      `SELECT count(*) FROM kingdom_flag_affiliation_history
       WHERE kingdom_id = $1 AND reason = 'founding_overlap_absorption'`,
      [kingdomId]
    );
    expect(Number(historyBeforeReplay.rows[0]?.count)).toBe(0);
    const replay = await domain.foundKingdom(avery, input);
    expect(replay.replayed).toBe(true);
    expect(replay.affectedFlagIds).toBeUndefined();
    const historyAfterReplay = await pool.query<{ count: string }>(
      `SELECT count(*) FROM kingdom_flag_affiliation_history
       WHERE kingdom_id = $1 AND reason = 'founding_overlap_absorption'`,
      [kingdomId]
    );
    expect(Number(historyAfterReplay.rows[0]?.count)).toBe(0);
  });

  it("keeps existing organization territory from being crossed during founding", async () => {
    const cityFounder = await player("OverlapCityFounder", { lat: 36.2, lon: -105.2 });
    const citySource = await ensureFoundingSourceFlag(cityFounder);
    const cityFlag = await createFlagAtFlagDistance(
      cityFounder, citySource, 250, 0, "City Affiliated Overlap"
    );
    const cityId = await affiliateFlagWithTestCity(
      cityFounder.playerId,
      cityFlag,
      "Overlap City"
    );
    await expect(service({}, {}, false).quoteFounding(cityFounder, {
      requestId: "city-overlap-quote", displayName: "City Overlap Realm", sourceFlagId: citySource
    })).resolves.toMatchObject({
      eligible: false,
      blockerCode: "KINGDOM_FLAG_FOREIGN_CONNECTION",
      sourceFlag: { id: citySource }
    });
    expect(cityId).toBeTruthy();

    const existingLeader = await player("ExistingOverlapLeader");
    const existing = await found(existingLeader, "Existing Overlap Realm");
    const controlledFounder = await player("ControlledOverlapFounder", { lat: 37.2, lon: -104.2 });
    const controlledSource = await ensureFoundingSourceFlag(controlledFounder);
    const controlledFlag = await createFlagAtFlagDistance(
      controlledFounder, controlledSource, 250, 0, "Already Controlled Overlap"
    );
    await pool.query(
      `UPDATE flags SET control_type = 'kingdom', kingdom_id = $2,
          kingdom_affiliated_at = $3, kingdom_affiliated_by_player_id = $4,
          original_owner_player_id = owner_id, contributed_by_player_id = $4,
          original_personal_color = '#38bdf8'
       WHERE id = $1`,
      [controlledFlag, existing.state!.kingdom!.id, now, controlledFounder.playerId]
    );
    await expect(service({}, {}, false).quoteFounding(controlledFounder, {
      requestId: "controlled-overlap-quote",
      displayName: "Controlled Overlap Realm",
      sourceFlagId: controlledSource
    })).resolves.toMatchObject({
      eligible: false,
      blockerCode: "KINGDOM_FLAG_FOREIGN_CONNECTION",
      sourceFlag: { id: controlledSource }
    });
  });

  it("transforms the selected flag into the exact Seat and leaves non-overlapping flags personal", async () => {
    const founder = await player("TransformFounder");
    const sourceFlagId = await ensureFoundingSourceFlag(founder);
    const sourcePosition = { ...founder.position };
    const secondPosition = await pointAtDistance(sourcePosition, 500, 90);
    const secondFlagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,'Unchanged Personal Flag',$3,$4,100,
         ST_SetSRID(ST_MakePoint($4,$3),4326))`,
      [secondFlagId, founder.playerId, secondPosition.lat, secondPosition.lon]
    );
    founder.position = await pointAtDistance(sourcePosition, 150, 90);
    const domain = service({}, {}, false);
    const founded = await domain.foundKingdom(founder, {
      requestId: "transform-source", displayName: "Transform Realm", sourceFlagId
    });
    const seat = founded.state!.kingdom!.seat!;
    expect(founded.affectedFlagIds).toEqual([sourceFlagId]);
    expect(seat).toMatchObject({
      sourceFlagId,
      lat: founder.position.lat,
      lon: founder.position.lon,
      territoryRadiusM: 200,
      constructionState: "complete"
    });
    await expect(domain.quoteFounding(founder, {
      requestId: "second-kingdom", displayName: "Second Transform Realm", sourceFlagId
    })).resolves.toMatchObject({ eligible: false, blockerCode: "KINGDOM_FLAG_ALREADY_AFFILIATED" });

    const transformed = await pool.query<{
      control_type: string; kingdom_id: string | null; claim_radius_m: number;
      lat: number; lon: number;
      kingdom_founding_request_id: string | null; original_personal_color: string | null;
      original_owner_player_id: string | null;
    }>(
      `SELECT control_type, kingdom_id, claim_radius_m, lat, lon, kingdom_founding_request_id,
              original_personal_color, original_owner_player_id
       FROM flags WHERE id = $1`,
      [sourceFlagId]
    );
    expect(transformed.rows[0]).toEqual({
      control_type: "kingdom_seat",
      kingdom_id: founded.state!.kingdom!.id,
      claim_radius_m: 200,
      lat: sourcePosition.lat,
      lon: sourcePosition.lon,
      kingdom_founding_request_id: null,
      original_personal_color: "#38bdf8",
      original_owner_player_id: founder.playerId
    });
    expect((await pool.query<{ metadata: { sourceFlagId?: string; sourceFlagRadiusM?: number } }>(
      `SELECT metadata FROM kingdom_audit_events
       WHERE kingdom_id = $1 AND event_type = 'kingdom_founded'`,
      [founded.state!.kingdom!.id]
    )).rows[0]?.metadata).toMatchObject({ sourceFlagId, sourceFlagRadiusM: 200 });
    expect(await flagService().listFlags()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: sourceFlagId,
        controlType: "kingdom_seat",
        kingdomId: founded.state!.kingdom!.id,
        kingdomSeatId: founded.state!.kingdom!.seat!.id,
        kingdomSeatConstructionState: "complete",
        kingdomSeatLat: founder.position.lat,
        kingdomSeatLon: founder.position.lon,
        lat: sourcePosition.lat,
        lon: sourcePosition.lon,
        claimRadiusM: 200
      })
    ]));
    const seatViewportFlags = await flagService().listFlags({
      west: founder.position.lon - 0.0001,
      south: founder.position.lat - 0.0001,
      east: founder.position.lon + 0.0001,
      north: founder.position.lat + 0.0001
    });
    expect(seatViewportFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sourceFlagId, kingdomSeatLat: founder.position.lat })
    ]));
    const territoryViewportFlags = await flagService().listFlags({
      west: sourcePosition.lon - 0.0001,
      south: sourcePosition.lat - 0.0001,
      east: sourcePosition.lon + 0.0001,
      north: sourcePosition.lat + 0.0001
    });
    expect(territoryViewportFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sourceFlagId, lat: sourcePosition.lat })
    ]));
    await expect(flagService().getMapFlag(sourceFlagId)).resolves.toMatchObject({
      id: sourceFlagId,
      controlType: "kingdom_seat",
      kingdomSeatId: founded.state!.kingdom!.seat!.id
    });
    expect(await flagService().listFlags()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: secondFlagId, controlType: "personal" })])
    );
    await expect(flagService().deleteFlag(sourceFlagId, founder.playerId))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED", statusCode: 403 });
    await expect(flagService().renameFlag(sourceFlagId, "Personal Rename", founder.playerId))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED", statusCode: 403 });

    await domain.dissolveKingdom(founder.playerId, "restore-source");
    const restored = await pool.query<{
      control_type: string; kingdom_id: string | null; claim_radius_m: number;
      kingdom_founding_request_id: string | null; kingdom_founding_reserved_at: Date | null;
    }>(
      `SELECT control_type, kingdom_id, claim_radius_m,
              kingdom_founding_request_id, kingdom_founding_reserved_at
       FROM flags WHERE id = $1`,
      [sourceFlagId]
    );
    expect(restored.rows[0]).toEqual({
      control_type: "personal",
      kingdom_id: null,
      claim_radius_m: 200,
      kingdom_founding_request_id: null,
      kingdom_founding_reserved_at: null
    });
    expect(await flagService().listFlags()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sourceFlagId, controlType: "personal" }),
      expect.objectContaining({ id: secondFlagId, controlType: "personal" })
    ]));
  });

  it("uses ordinary flag placement beside a Kingdom while retaining founding spacing", async () => {
    const leader = await player("SourceBoundaryLeader", { lat: 34.2, lon: -105.2 });
    const outsider = await player("SourceBoundaryOutsider", { lat: 34.3, lon: -105.3 });
    await found(leader, "Source Boundary Realm");
    const serviceFlags = flagService({ FLAG_CLAIM_RADIUS_M: 100 });

    outsider.position = await pointAtDistance(leader.position, 250, 90);
    const created = await serviceFlags.createForPlayer(outsider, "Overlapping Personal Flag");
    expect(created.flag).toMatchObject({
      controlType: "personal",
      ownerId: outsider.playerId,
      kingdomId: null,
      claimRadiusM: 100
    });
    expect((await service().getState(outsider)).kingdomFlags).toEqual([]);

    await expect(service().quoteFounding(outsider, {
      requestId: "overlap-is-not-founding",
      displayName: "Still Too Close Realm",
      sourceFlagId: created.flag.id
    })).resolves.toMatchObject({ eligible: false, blockerCode: "KINGDOM_FLAG_FOREIGN_CONNECTION" });
  });

  it("protects a paid completed Seat and restores its source when dissolved", async () => {
    const pendingFounder = await player("PendingBlocker");
    await grantInventory(pool, pendingFounder.playerId, "wood", 450);
    await grantInventory(pool, pendingFounder.playerId, "stone", 550);
    await grantInventory(pool, pendingFounder.playerId, "iron", 425);
    await grantInventory(pool, pendingFounder.playerId, "refined_oil", 1_150);
    const paid = service({ KINGDOMS_FREE_CONSTRUCTION: false });
    const pending = await paid.foundKingdom(pendingFounder, {
      requestId: "pending-blocker", displayName: "Pending Blocker Realm"
    });
    expect((await paid.foundKingdom(pendingFounder, {
      requestId: "pending-blocker", displayName: "Pending Blocker Realm"
    })).replayed).toBe(true);

    expect((await new InventoryService(pool).getInventorySnapshot(pendingFounder.playerId)).totals)
      .toMatchObject({ wood: 0, stone: 0, iron: 0, refined_oil: 0 });

    const sourceFlagId = pending.state!.kingdom!.seat!.sourceFlagId!;
    const reservation = await pool.query<{
      control_type: string; kingdom_founding_request_id: string | null;
      kingdom_founding_reserved_at: Date | null;
    }>(
      `SELECT control_type, kingdom_founding_request_id, kingdom_founding_reserved_at
       FROM flags WHERE id = $1`,
      [sourceFlagId]
    );
    expect(reservation.rows[0]).toMatchObject({
      control_type: "kingdom_seat",
      kingdom_founding_request_id: null
    });
    expect(reservation.rows[0]?.kingdom_founding_reserved_at).toBeNull();
    await expect(flagService().getMapFlag(sourceFlagId)).resolves.toMatchObject({
      id: sourceFlagId,
      controlType: "kingdom_seat",
      kingdomSeatId: pending.state!.kingdom!.seat!.id,
      kingdomSeatConstructionState: "complete"
    });
    expect(await paid.getSeatTravelDestination(pending.state!.kingdom!.seat!.id)).toMatchObject({
      id: pending.state!.kingdom!.seat!.id,
      kingdomId: pending.state!.kingdom!.id
    });
    await expect(flagService().deleteFlag(sourceFlagId, pendingFounder.playerId))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await expect(flagService().renameFlag(sourceFlagId, "Renamed", pendingFounder.playerId))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });

    const candidate = await player("PendingCandidate", { ...pendingFounder.position });
    await expect(pool.query("UPDATE flags SET owner_id = $2 WHERE id = $1", [sourceFlagId, candidate.playerId]))
      .rejects.toMatchObject({ code: "23514" });
    const citySeatFlag = await createFlagAtFlagDistance(
      candidate,
      sourceFlagId,
      5_000,
      90,
      "Reservation Test City Center"
    );
    const cityId = await affiliateFlagWithTestCity(
      candidate.playerId,
      citySeatFlag,
      "Reservation Test City"
    );
    await expect(pool.query("UPDATE flags SET city_id = $2 WHERE id = $1", [sourceFlagId, cityId]))
      .rejects.toMatchObject({ code: "23514", constraint: "flags_city_kingdom_exclusive" });
    const overlappingPosition = await pointAtDistance(pendingFounder.position, 250, 90);
    await expect(pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,'Pending Overlap',$3,$4,100,
         ST_SetSRID(ST_MakePoint($4,$3),4326))`,
      [randomUUID(), candidate.playerId, overlappingPosition.lat, overlappingPosition.lon]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(service({}, {}, false).foundKingdom(candidate, {
      requestId: "reuse-reserved-source",
      displayName: "Pending Candidate Realm",
      sourceFlagId
    })).rejects.toMatchObject({ code: "KINGDOM_FOUNDING_FLAG_OWNERSHIP_CHANGED" });

    await paid.dissolveKingdom(pendingFounder.playerId, "cancel-pending-founding");
    const restored = await pool.query<{
      control_type: string; kingdom_id: string | null;
      kingdom_founding_request_id: string | null; kingdom_founding_reserved_at: Date | null;
    }>(
      `SELECT control_type, kingdom_id,
              kingdom_founding_request_id, kingdom_founding_reserved_at
       FROM flags WHERE id = $1`,
      [sourceFlagId]
    );
    expect(restored.rows[0]).toEqual({
      control_type: "personal",
      kingdom_id: null,
      kingdom_founding_request_id: null,
      kingdom_founding_reserved_at: null
    });
  });

  it("converts only one explicitly selected flag while preserving two same-owner personal flags", async () => {
    const avery = await player("Avery");
    const founded = await found(avery, "Kingdom A");
    const domain = service();
    const seat = founded.state!.kingdom!.seat!;
    const flag1 = await createFlagAtDistance(avery, seat.id, 800, 0, "Flag 1");
    const flag2 = await createFlagAtDistance(avery, seat.id, 300, 90, "Flag 2");
    const flag3 = await createFlagAtDistance(avery, seat.id, 800, 180, "Flag 3");

    const converted = await domain.convertKingdomFlag(avery.playerId, {
      requestId: "explicit-flag-2", flagId: flag2
    });
    expect(converted.affectedFlagIds).toEqual([flag2]);

    const encounterFlag = await createFlagAtDistance(avery, seat.id, 300, 270, "Encounter Flag");
    await pool.query(
      "UPDATE flags SET reinforcement_level=1,health=200,maximum_health=200 WHERE id=$1",
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
       ) VALUES ($1,$2,'lightning',$3,$4,$2,$5)`,
      [randomUUID(), cycleStartedAt, encounterFlag, avery.playerId, expiresAt]
    );
    await expect(domain.convertKingdomFlag(avery.playerId, {
      requestId: "live-encounter", flagId: encounterFlag
    })).rejects.toMatchObject({ code: "KINGDOM_FLAG_LIFECYCLE_CHANGED" });
    await expect(pool.query(
      "SELECT control_type,kingdom_id FROM flags WHERE id=$1",
      [encounterFlag]
    )).resolves.toMatchObject({ rows: [{ control_type: "personal", kingdom_id: null }] });

    const stored = await pool.query<{
      id: string; control_type: string; kingdom_id: string | null;
      original_owner_player_id: string | null; contributed_by_player_id: string | null;
    }>(
      `SELECT id, control_type, kingdom_id, original_owner_player_id, contributed_by_player_id
       FROM flags WHERE id = ANY($1::uuid[]) ORDER BY name`,
      [[flag1, flag2, flag3]]
    );
    expect(stored.rows.map(({ id, control_type, kingdom_id }) => ({ id, control_type, kingdom_id }))).toEqual([
      { id: flag1, control_type: "personal", kingdom_id: null },
      { id: flag2, control_type: "kingdom", kingdom_id: founded.state!.kingdom!.id },
      { id: flag3, control_type: "personal", kingdom_id: null }
    ]);
    expect(stored.rows[1]).toMatchObject({
      original_owner_player_id: avery.playerId,
      contributed_by_player_id: avery.playerId
    });

    const flags = flagService();
    const reload = await flags.listFlags(undefined, 50);
    const byId = new Map(reload.map((flag) => [flag.id, flag]));
    expect(byId.get(flag1)).toMatchObject({ controlType: "personal", ownerColor: "#3366cc", kingdomId: null });
    expect(byId.get(flag2)).toMatchObject({
      controlType: "kingdom", kingdomColor: "#7c3aed", contributedByPlayerId: avery.playerId
    });
    expect(byId.get(flag3)).toMatchObject({ controlType: "personal", ownerColor: "#3366cc", kingdomId: null });

    const colorChange = await domain.updateIdentity(avery.playerId, {
      requestId: "recolor-kingdom-a",
      displayColor: "#22c55e"
    });
    expect(colorChange.affectedFlagIds).toEqual([flag2]);
    expect(colorChange.state?.kingdom?.displayColor).toBe("#22c55e");
    const recolored = new Map((await flags.listFlags(undefined, 50)).map((flag) => [flag.id, flag]));
    expect(recolored.get(flag1)).toMatchObject({ controlType: "personal", ownerColor: "#3366cc" });
    expect(recolored.get(flag2)).toMatchObject({ controlType: "kingdom", kingdomColor: "#22c55e" });
    expect(recolored.get(flag3)).toMatchObject({ controlType: "personal", ownerColor: "#3366cc" });

    const reconnected = await service().getState(avery);
    expect(reconnected.kingdomFlags?.map(({ flagId }) => flagId)).toEqual([flag2]);
  });

  it("converts only owner flags touching the authoritative Seat or connected network", async () => {
    const leader = await player("FlagNetworkLeader");
    const outsider = await player("FlagNetworkOutsider");
    const founded = await found(leader, "Connected Realm");
    const domain = service();
    const seat = founded.state!.kingdom!.seat!;
    const boundary = await createFlagAtDistance(leader, seat.id, 300, 90, "Boundary Flag");
    const overlapping = await createFlagAtDistance(leader, seat.id, 250, 180, "Overlapping Flag");
    const chained = await createFlagAtDistance(leader, seat.id, 500, 90, "Chain Flag");
    const third = await createFlagAtDistance(leader, seat.id, 700, 90, "Third Flag");
    const separated = await createFlagAtDistance(leader, seat.id, 300.2, 270, "Separated Flag");
    const outsiderFlag = await createFlagAtDistance(outsider, seat.id, 300, 0, "Outsider Flag");

    await expect(domain.getKingdomFlagEligibility(leader.playerId, boundary)).resolves.toMatchObject({
      eligible: true,
      connectionAnchor: { kind: "seat", id: seat.id }
    });
    await expect(pool.query<{ control_type: string; kingdom_id: string | null }>(
      "SELECT control_type, kingdom_id FROM flags WHERE id = $1",
      [overlapping]
    )).resolves.toMatchObject({ rows: [{ control_type: "personal", kingdom_id: null }] });
    expect((await domain.getState(leader)).kingdomFlags?.map(({ flagId }) => flagId))
      .not.toContain(overlapping);
    await expect(domain.convertKingdomFlag(leader.playerId, { requestId: "boundary", flagId: boundary }))
      .resolves.toMatchObject({ replayed: false, affectedFlagIds: [boundary] });
    const boundaryPosition = await pool.query<{ lat: number; lon: number }>(
      "SELECT lat, lon FROM flags WHERE id = $1",
      [boundary]
    );
    leader.position = await pointAtDistance(boundaryPosition.rows[0]!, 150, 0);
    const overlappingKingdomFlag = (await flagService({ FLAG_CLAIM_RADIUS_M: 100 }).createForPlayer(
      leader,
      "Personal Beside Kingdom Flag"
    )).flag.id;
    await expect(pool.query<{ control_type: string; kingdom_id: string | null }>(
      "SELECT control_type, kingdom_id FROM flags WHERE id = $1",
      [overlappingKingdomFlag]
    )).resolves.toMatchObject({ rows: [{ control_type: "personal", kingdom_id: null }] });
    expect((await domain.getState(leader)).kingdomFlags?.map(({ flagId }) => flagId))
      .not.toContain(overlappingKingdomFlag);
    await expect(domain.convertKingdomFlag(leader.playerId, { requestId: "chain", flagId: chained }))
      .resolves.toMatchObject({ replayed: false, affectedFlagIds: [chained] });
    await expect(domain.convertKingdomFlag(leader.playerId, { requestId: "third", flagId: third }))
      .resolves.toMatchObject({ replayed: false, affectedFlagIds: [third] });

    await expect(domain.getKingdomFlagEligibility(leader.playerId, separated)).resolves.toMatchObject({
      eligible: false,
      reasonCode: "KINGDOM_FLAG_NOT_CONNECTED"
    });
    await expect(domain.convertKingdomFlag(leader.playerId, { requestId: "not-owner", flagId: outsiderFlag }))
      .rejects.toMatchObject({ code: "KINGDOM_FLAG_NOT_PERSONALLY_CONTROLLED" });
    await expect(domain.convertKingdomFlag(outsider.playerId, { requestId: "nonmember", flagId: outsiderFlag }))
      .rejects.toMatchObject({ code: "KINGDOM_MEMBERSHIP_REQUIRED" });

    const state = await domain.getState(leader);
    expect(new Set(state.kingdomFlags?.map(({ flagId }) => flagId)))
      .toEqual(new Set([boundary, chained, third]));
    expect(state.kingdomFlags?.find(({ flagId }) => flagId === boundary)?.directlyTouchesSeat).toBe(true);
    expect(state.kingdomFlags?.filter(({ flagId }) => flagId !== boundary)
      .every(({ directlyTouchesSeat }) => !directlyTouchesSeat)).toBe(true);
  });

  it("caps Kingdom Flags at 36 per member active in 6 days and keeps kingdoms 2.4 km apart", async () => {
    const leader = await player("LimitsLeader");
    const founded = await found(leader, "Limits Realm");
    const domain = service();
    const seat = founded.state!.kingdom!.seat!;
    expect(founded.state!.structureCapacity).toEqual({ used: 0, capacity: 36, activeMembers: 1 });
    const east = await createFlagAtDistance(leader, seat.id, 300, 90, "Limits East");
    const north = await createFlagAtDistance(leader, seat.id, 300, 0, "Limits North");

    // Capacity: with no member active in the last 6 days the cap is 0 (denied); active again, 36 (allowed).
    await pool.query("UPDATE players SET last_seen_at = now() - interval '8 days' WHERE id = $1", [leader.playerId]);
    await expect(domain.convertKingdomFlag(leader.playerId, { requestId: "limits-inactive", flagId: east }))
      .rejects.toMatchObject({ code: "KINGDOM_STRUCTURE_CAPACITY_REACHED" });
    await pool.query("UPDATE players SET last_seen_at = now() WHERE id = $1", [leader.playerId]);
    await expect(domain.convertKingdomFlag(leader.playerId, { requestId: "limits-active", flagId: east }))
      .resolves.toMatchObject({ replayed: false, affectedFlagIds: [east] });
    expect((await domain.getState(leader)).structureCapacity).toEqual({ used: 1, capacity: 36, activeMembers: 1 });

    // Spacing: a Castle 2,850 m north keeps its territory 2,450 m from ours (allowed) ...
    const rival = await player("LimitsRival", await pointAtDistance(leader.position, 2_850, 0));
    await expect(found(rival, "Limits Rival Realm")).resolves.toMatchObject({ replayed: false });
    // ... one 1,500 m south would be 1,100 m away (denied) ...
    const crowding = await player("LimitsCrowding", await pointAtDistance(leader.position, 1_500, 180));
    await expect(service().quoteFounding(crowding, { requestId: "limits-crowding", displayName: "Limits Crowding Realm" }))
      .resolves.toMatchObject({ eligible: false, blockerCode: "KINGDOM_SPACING_TOO_CLOSE" });
    // ... and our new Kingdom Flag 300 m north would come within 2,250 m of the rival (denied).
    await expect(domain.convertKingdomFlag(leader.playerId, { requestId: "limits-north", flagId: north }))
      .rejects.toMatchObject({ code: "KINGDOM_SPACING_TOO_CLOSE" });
  });

  it("converts only the selected overlapping personal flag and preserves other eligibility gates", async () => {
    const leader = await player("MixedGeometryLeader");
    const founded = await found(leader, "Mixed Geometry Realm");
    const domain = service();
    const seat = founded.state!.kingdom!.seat!;
    const target = await createFlagAtDistance(leader, seat.id, 300, 0, "Conversion Target");
    const personalConflict = await createFlagAtDistance(leader, seat.id, 300, 30, "Personal Conflict");

    await expect(domain.getKingdomFlagEligibility(leader.playerId, target)).resolves.toMatchObject({
      eligible: true,
      reasonCode: null,
      connectionAnchor: { kind: "seat", id: seat.id }
    });
    await expect(domain.convertKingdomFlag(leader.playerId, {
      requestId: "mixed-overlap", flagId: target
    })).resolves.toMatchObject({ replayed: false, affectedFlagIds: [target] });

    const stored = await pool.query<{
      id: string; control_type: string; kingdom_id: string | null; owner_id: string;
    }>(
      "SELECT id, control_type, kingdom_id, owner_id FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[target, personalConflict]]
    );
    const controls = new Map(stored.rows.map((row) => [row.id, row]));
    expect(controls.get(target)).toMatchObject({
      control_type: "kingdom",
      kingdom_id: founded.state!.kingdom!.id,
      owner_id: leader.playerId
    });
    expect(controls.get(personalConflict)).toMatchObject({
      control_type: "personal",
      kingdom_id: null,
      owner_id: leader.playerId
    });
    const snapshots = new Map((await flagService().listFlags()).map((flag) => [flag.id, flag]));
    expect(snapshots.get(personalConflict)).toMatchObject({
      controlType: "personal",
      ownerId: leader.playerId,
      ownerColor: "#3366cc"
    });
    expect((await domain.getState(leader)).kingdomFlags?.map(({ flagId }) => flagId))
      .toEqual([target]);

    const disconnected = await createFlagAtDistance(leader, seat.id, 1_000, 180, "Disconnected Personal");
    await expect(domain.getKingdomFlagEligibility(leader.playerId, disconnected)).resolves.toMatchObject({
      eligible: false,
      reasonCode: "KINGDOM_FLAG_NOT_CONNECTED"
    });

    const cityFlag = await createFlagAtDistance(leader, seat.id, 300, 60, "City Personal");
    await affiliateFlagWithTestCity(
      leader.playerId,
      cityFlag,
      "Conversion Gate City"
    );
    await expect(domain.getKingdomFlagEligibility(leader.playerId, cityFlag)).resolves.toMatchObject({
      eligible: false,
      reasonCode: "KINGDOM_FLAG_CITY_AFFILIATED"
    });
  });

  it("rejects incomplete roots, former members, banned members, and invalid bridge identities", async () => {
    const leader = await player("AuthorityLeader");
    const former = await player("FormerMember");
    const banned = await player("BannedMember");
    const foreignLeader = await player("ForeignLeader", { lat: 36, lon: -105 });
    const founded = await found(leader, "Authority Realm");
    const foreign = await found(foreignLeader, "Foreign Realm");
    const domain = service();
    const seat = founded.state!.kingdom!.seat!;

    const pendingCandidate = await createFlagAtDistance(leader, seat.id, 300, 180, "Pending Root Candidate");
    await pool.query(
      "UPDATE kingdom_seats SET construction_state = 'under_construction', completed_at = NULL WHERE id = $1",
      [seat.id]
    );
    await expect(domain.getKingdomFlagEligibility(leader.playerId, pendingCandidate)).resolves.toMatchObject({
      eligible: false,
      reasonCode: "KINGDOM_SEAT_INCOMPLETE"
    });
    await expect(domain.getSeatTravelDestination(seat.id)).resolves.toBeNull();
    await pool.query(
      "UPDATE kingdom_seats SET construction_state = 'complete', completed_at = $2 WHERE id = $1",
      [seat.id, now]
    );

    await joinKingdom(domain, leader.playerId, former.playerId, "former");
    const formerFlag = await createFlagAtDistance(former, seat.id, 300, 45, "Former Flag");
    await domain.memberAction(leader.playerId, {
      requestId: "remove-former", targetPlayerId: former.playerId, action: "remove"
    });
    await expect(domain.convertKingdomFlag(former.playerId, { requestId: "former-convert", flagId: formerFlag }))
      .rejects.toMatchObject({ code: "KINGDOM_MEMBERSHIP_REQUIRED" });

    await joinKingdom(domain, leader.playerId, banned.playerId, "banned");
    const bannedFlag = await createFlagAtDistance(banned, seat.id, 300, 135, "Banned Flag");
    await domain.memberAction(leader.playerId, {
      requestId: "ban-member-flags", targetPlayerId: banned.playerId, action: "ban"
    });
    await expect(domain.convertKingdomFlag(banned.playerId, { requestId: "banned-convert", flagId: bannedFlag }))
      .rejects.toMatchObject({ code: "KINGDOM_MEMBERSHIP_REQUIRED" });

    const foreignBridge = await createFlagAtDistance(foreignLeader, seat.id, 300, 90, "Foreign Bridge");
    await pool.query(
      `UPDATE flags SET control_type = 'kingdom', kingdom_id = $2, kingdom_affiliated_at = $3,
         kingdom_affiliated_by_player_id = $4, original_owner_player_id = owner_id,
         contributed_by_player_id = $4, original_personal_color = '#38bdf8' WHERE id = $1`,
      [foreignBridge, foreign.state!.kingdom!.id, now, foreignLeader.playerId]
    );
    const foreignCandidate = await createFlagAtDistance(leader, seat.id, 500, 90, "Foreign Candidate");
    await expect(domain.getKingdomFlagEligibility(leader.playerId, foreignCandidate)).resolves.toMatchObject({
      eligible: false,
      reasonCode: "KINGDOM_FLAG_NOT_CONNECTED"
    });

    const normalBridge = await createFlagAtDistance(leader, seat.id, 300, 270, "Normal Bridge");
    const normalCandidate = await createFlagAtDistance(leader, seat.id, 500, 270, "Normal Candidate");
    await expect(domain.getKingdomFlagEligibility(leader.playerId, normalCandidate)).resolves.toMatchObject({
      eligible: false,
      reasonCode: "KINGDOM_FLAG_NOT_CONNECTED"
    });
    expect(normalBridge).toBeTruthy();

    await expect(domain.convertKingdomFlag(leader.playerId, {
      requestId: "missing-incomplete-flag",
      flagId: randomUUID()
    })).rejects.toMatchObject({ code: "KINGDOM_FLAG_LIFECYCLE_CHANGED" });
  });

  it("preserves alternate network paths and serializes conversion against deletion and membership removal", async () => {
    const leader = await player("ConcurrencyLeader");
    const member = await player("ConcurrencyMember");
    const founded = await found(leader, "Concurrency Realm");
    const domain = service();
    const seat = founded.state!.kingdom!.seat!;

    const rootA = await createFlagAtDistance(leader, seat.id, 300, 60, "Root A");
    const rootB = await createFlagAtDistance(leader, seat.id, 300, 120, "Root B");
    const shared = await createFlagAtDistance(leader, seat.id, 392.1, 90, "Shared Path");
    for (const [requestId, flagId] of [["root-a", rootA], ["root-b", rootB], ["shared", shared]] as const) {
      await domain.convertKingdomFlag(leader.playerId, { requestId, flagId });
    }
    const preview = await domain.getKingdomFlagRemovalPreview(leader.playerId, rootA);
    expect(preview.downstreamCount).toBe(0);
    await domain.removeKingdomFlag(leader.playerId, {
      requestId: "remove-one-path",
      flagId: rootA,
      expectedNetworkRevision: preview.networkRevision!
    });
    const alternate = await pool.query<{ kingdom_id: string | null }>(
      "SELECT kingdom_id FROM flags WHERE id = $1", [shared]
    );
    expect(alternate.rows[0]?.kingdom_id).toBe(founded.state!.kingdom!.id);

    const deleteRace = await createFlagAtDistance(leader, seat.id, 300, 200, "Delete Race");
    const flags = flagService();
    await Promise.allSettled([
      domain.convertKingdomFlag(leader.playerId, { requestId: "delete-race-convert", flagId: deleteRace }),
      flags.deleteFlag(deleteRace, leader.playerId)
    ]);
    const raced = await pool.query<{ kingdom_id: string | null }>(
      "SELECT kingdom_id FROM flags WHERE id = $1", [deleteRace]
    );
    expect(raced.rows.length === 0 || raced.rows[0]?.kingdom_id === founded.state!.kingdom!.id).toBe(true);

    await joinKingdom(domain, leader.playerId, member.playerId, "concurrent-member");
    const memberFlag = await createFlagAtDistance(member, seat.id, 300, 330, "Member Race");
    await Promise.allSettled([
      domain.convertKingdomFlag(member.playerId, { requestId: "member-race-convert", flagId: memberFlag }),
      domain.memberAction(leader.playerId, {
        requestId: "member-race-remove", targetPlayerId: member.playerId, action: "remove"
      })
    ]);
    const memberFinal = await pool.query<{ kingdom_id: string | null }>(
      "SELECT kingdom_id FROM flags WHERE id = $1", [memberFlag]
    );
    expect([null, founded.state!.kingdom!.id]).toContain(memberFinal.rows[0]?.kingdom_id ?? null);
  });

  it("replays conversion once and prunes every downstream flag when a bridge is removed", async () => {
    const leader = await player("BridgeLeader");
    const founded = await found(leader, "Bridge Realm");
    const domain = service();
    const seat = founded.state!.kingdom!.seat!;
    const root = await createFlagAtDistance(leader, seat.id, 300, 90, "Root Flag");
    const bridge = await createFlagAtDistance(leader, seat.id, 500, 90, "Bridge Flag");
    const leaf = await createFlagAtDistance(leader, seat.id, 700, 90, "Leaf Flag");
    for (const [requestId, flagId] of [["root", root], ["bridge", bridge], ["leaf", leaf]] as const) {
      await domain.convertKingdomFlag(leader.playerId, { requestId, flagId });
    }
    const replay = await domain.convertKingdomFlag(leader.playerId, { requestId: "root", flagId: root });
    expect(replay).toMatchObject({ replayed: true, affectedFlagIds: [] });
    const historyBefore = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM kingdom_flag_affiliation_history WHERE flag_id = $1 AND action = 'affiliated'",
      [root]
    );
    expect(historyBefore.rows[0]?.count).toBe("1");

    const preview = await domain.getKingdomFlagRemovalPreview(leader.playerId, bridge);
    expect(preview).toMatchObject({ allowed: true, downstreamCount: 1 });
    const removed = await domain.removeKingdomFlag(leader.playerId, {
      requestId: "remove-bridge",
      flagId: bridge,
      expectedNetworkRevision: preview.networkRevision!
    });
    expect(new Set(removed.affectedFlagIds)).toEqual(new Set([bridge, leaf]));
    const affiliations = await pool.query<{ id: string; kingdom_id: string | null; owner_id: string }>(
      "SELECT id, kingdom_id, owner_id FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[root, bridge, leaf]]
    );
    expect(affiliations.rows.find(({ id }) => id === root)?.kingdom_id).toBe(founded.state!.kingdom!.id);
    expect(affiliations.rows.filter(({ id }) => id !== root).every(({ kingdom_id }) => kingdom_id === null)).toBe(true);
    expect(affiliations.rows.every(({ owner_id }) => owner_id === leader.playerId)).toBe(true);
    const actions = await pool.query<{ action: string }>(
      "SELECT action FROM kingdom_flag_affiliation_history WHERE flag_id = ANY($1::uuid[]) ORDER BY created_at, id",
      [[bridge, leaf]]
    );
    expect(actions.rows.map(({ action }) => action).sort()).toEqual(["affiliated", "affiliated", "pruned", "released"]);
    expect(removed.state!.activityHistory.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining([
        "kingdom_flag_contributed",
        "kingdom_flag_released",
        "kingdom_flag_pruned"
      ])
    );
  });

  it("retains contributed flags and their connected network when the contributor leaves", async () => {
    const leader = await player("DepartureLeader");
    const member = await player("DepartureMember");
    const founded = await found(leader, "Departure Realm");
    const domain = service();
    const invitation = await domain.invitePlayer(leader.playerId, {
      requestId: "flag-member-invite", targetPlayerId: member.playerId
    });
    await domain.respondToInvitation(member.playerId, {
      requestId: "flag-member-accept",
      invitationId: invitation.state!.invitations.find(
        ({ targetPlayerId, status }) => targetPlayerId === member.playerId && status === "pending"
      )!.id,
      response: "accept"
    });
    const seat = founded.state!.kingdom!.seat!;
    const memberRoot = await createFlagAtDistance(member, seat.id, 300, 90, "Member Root");
    const leaderLeaf = await createFlagAtDistance(leader, seat.id, 500, 90, "Leader Leaf");
    await domain.convertKingdomFlag(member.playerId, { requestId: "member-root", flagId: memberRoot });
    await domain.convertKingdomFlag(leader.playerId, { requestId: "leader-leaf", flagId: leaderLeaf });

    const left = await domain.leaveKingdom(member.playerId, "member-leaves-network");
    expect(left.affectedFlagIds).toEqual([]);
    const flags = await pool.query<{ id: string; control_type: string; kingdom_id: string | null; owner_id: string }>(
      "SELECT id, control_type, kingdom_id, owner_id FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[memberRoot, leaderLeaf]]
    );
    expect(flags.rows.every(({ control_type, kingdom_id }) =>
      control_type === "kingdom" && kingdom_id === founded.state!.kingdom!.id)).toBe(true);
    expect(flags.rows.find(({ id }) => id === memberRoot)?.owner_id).toBe(member.playerId);
    expect(flags.rows.find(({ id }) => id === leaderLeaf)?.owner_id).toBe(leader.playerId);
  });

  it("retains Kingdom control when contributors are kicked or banned", async () => {
    const leader = await player("RetainLeader");
    const kicked = await player("RetainKicked");
    const banned = await player("RetainBanned");
    const founded = await found(leader, "Retention Realm");
    const domain = service();
    await joinKingdom(domain, leader.playerId, kicked.playerId, "retain-kicked");
    await joinKingdom(domain, leader.playerId, banned.playerId, "retain-banned");
    const seat = founded.state!.kingdom!.seat!;
    const kickedFlag = await createFlagAtDistance(kicked, seat.id, 300, 90, "Kicked Contribution");
    const bannedFlag = await createFlagAtDistance(banned, seat.id, 300, 270, "Banned Contribution");
    await domain.convertKingdomFlag(kicked.playerId, { requestId: "kicked-contribution", flagId: kickedFlag });
    await domain.convertKingdomFlag(banned.playerId, { requestId: "banned-contribution", flagId: bannedFlag });

    await domain.memberAction(leader.playerId, {
      requestId: "kick-contributor", targetPlayerId: kicked.playerId, action: "remove"
    });
    await domain.memberAction(leader.playerId, {
      requestId: "ban-contributor", targetPlayerId: banned.playerId, action: "ban"
    });

    const retained = await pool.query<{ id: string; control_type: string; kingdom_id: string }>(
      "SELECT id, control_type, kingdom_id FROM flags WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[kickedFlag, bannedFlag]]
    );
    expect(retained.rows).toHaveLength(2);
    expect(retained.rows.every((row) => row.control_type === "kingdom" &&
      row.kingdom_id === founded.state!.kingdom!.id)).toBe(true);
  });

  it("forbids Kingdom flag renaming and enforces role authority for release and destruction", async () => {
    const leader = await player("FlagAuthorityLeader");
    const contributor = await player("FlagAuthorityContributor");
    const founded = await found(leader, "Flag Authority Realm");
    const domain = service();
    await joinKingdom(domain, leader.playerId, contributor.playerId, "flag-authority");
    const flagId = await createFlagAtDistance(
      contributor,
      founded.state!.kingdom!.seat!.id,
      300,
      90,
      "Contributed Flag"
    );
    await domain.convertKingdomFlag(contributor.playerId, {
      requestId: "authority-contribute",
      flagId
    });
    const flags = flagService();

    await expect(flags.renameFlag(flagId, "Member Rename", contributor.playerId))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await expect(domain.removeKingdomFlag(contributor.playerId, {
      requestId: "member-release",
      flagId,
      expectedNetworkRevision: founded.state!.kingdom!.spatialRevision
    })).rejects.toMatchObject({ code: "KINGDOM_FLAG_RELEASE_PERMISSION_REQUIRED" });
    await expect(flags.deleteFlag(flagId, contributor.playerId))
      .rejects.toMatchObject({ code: "KINGDOM_FLAG_DESTROY_PERMISSION_REQUIRED" });

    await pool.query("UPDATE players SET display_color = '#ef4444' WHERE id = $1", [contributor.playerId]);

    await domain.memberAction(leader.playerId, {
      requestId: "promote-flag-manager",
      targetPlayerId: contributor.playerId,
      action: "promote"
    });
    await expect(flags.renameFlag(flagId, "Officer Rename", contributor.playerId))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await expect(flags.deleteFlag(flagId, contributor.playerId))
      .rejects.toMatchObject({ code: "KINGDOM_FLAG_DESTROY_PERMISSION_REQUIRED" });

    const preview = await domain.getKingdomFlagRemovalPreview(contributor.playerId, flagId);
    await expect(domain.removeKingdomFlag(contributor.playerId, {
      requestId: "officer-release",
      flagId,
      expectedNetworkRevision: preview.networkRevision!
    })).resolves.toMatchObject({ affectedFlagIds: [flagId] });
    await expect(flags.getFlag(flagId)).resolves.toMatchObject({
      controlType: "personal",
      ownerColor: "#3366cc",
      originalPersonalColor: "#38bdf8"
    });
    await domain.convertKingdomFlag(contributor.playerId, {
      requestId: "officer-recontribute",
      flagId
    });
    await expect(flags.deleteFlag(flagId, leader.playerId)).resolves.toMatchObject({
      affectedFlagIds: []
    });
    await expect(pool.query("SELECT id FROM flags WHERE id = $1", [flagId]))
      .resolves.toMatchObject({ rows: [] });
  });

  it("dissolves transactionally while archiving access and objects but preserving financial history", async () => {
    const leader = await player("DissolveLeader");
    const invited = await player("DissolveInvited");
    await found(leader, "Archive Realm");
    const domain = service();
    const kingdomId = (await domain.getState(leader)).kingdom!.id;
    const seatId = (await domain.getState(leader)).kingdom!.seat!.id;
    const kingdomFlag = await createFlagAtDistance(leader, seatId, 300, 90, "Dissolve Flag");
    await domain.convertKingdomFlag(leader.playerId, { requestId: "dissolve-flag", flagId: kingdomFlag });
    await domain.invitePlayer(leader.playerId, {
      requestId: "pending-at-dissolve",
      targetPlayerId: invited.playerId
    });
    leader.position = { lat: 35.0849, lon: -106.6504 };
    await domain.placeCot(leader, { requestId: "dissolve-cot" });
    leader.position = { lat: 35.0844, lon: -106.64985 };
    await domain.placeDecoration(leader, {
      requestId: "dissolve-decoration",
      typeId: "banner",
      kingdomOwned: true
    });
    await grantInventory(pool, leader.playerId, "wood", 10);
    await domain.donate(leader.playerId, {
      requestId: "dissolve-donation",
      resourceType: "wood",
      quantity: 10
    });
    await creditTreasury(kingdomId, [
      { resourceType: "wood", quantity: 160 },
      { resourceType: "stone", quantity: 100 },
      { resourceType: "leather", quantity: 50 }
    ]);
    const result = await domain.dissolveKingdom(leader.playerId, "dissolve-request");
    expect(result.state!.membership).toBeNull();
    expect(result.state!.kingdom).toBeNull();
    expect(result.spatialChanges).toHaveLength(3);
    expect(result.spatialChanges?.every(({ previous, current }) =>
      previous !== null && current === null)).toBe(true);
    await expect(domain.sendChat(leader.playerId, { requestId: "after-dissolve", content: "No access" }))
      .rejects.toMatchObject({ code: "KINGDOM_MEMBERSHIP_REQUIRED" });

    const lifecycle = await pool.query<{
      kingdom_status: string;
      active_members: string;
      pending_invitations: string;
      seat_status: string;
      cot_status: string;
      decoration_status: string;
      donations: string;
      treasury: string;
      affiliated_flags: string;
      project_status: string | null;
      project_refunds: string;
    }>(
      `SELECT
         (SELECT status FROM kingdoms WHERE id = $1) AS kingdom_status,
         (SELECT count(*)::text FROM kingdom_memberships WHERE kingdom_id = $1 AND status = 'active') AS active_members,
         (SELECT count(*)::text FROM kingdom_invitations WHERE kingdom_id = $1 AND status = 'pending') AS pending_invitations,
         (SELECT status FROM kingdom_seats WHERE kingdom_id = $1 ORDER BY created_at DESC LIMIT 1) AS seat_status,
         (SELECT status FROM kingdom_cots WHERE kingdom_id = $1 ORDER BY created_at DESC LIMIT 1) AS cot_status,
         (SELECT status FROM kingdom_decorations WHERE kingdom_id = $1 ORDER BY created_at DESC LIMIT 1) AS decoration_status,
         (SELECT count(*)::text FROM kingdom_donations WHERE kingdom_id = $1) AS donations,
         (SELECT COALESCE(sum(quantity),0)::text FROM kingdom_treasury_balances WHERE kingdom_id = $1) AS treasury,
         (SELECT count(*)::text FROM flags WHERE kingdom_id = $1) AS affiliated_flags,
         (SELECT status FROM kingdom_projects WHERE kingdom_id = $1 ORDER BY started_at DESC LIMIT 1) AS project_status,
         (SELECT count(*)::text FROM kingdom_treasury_expenditures
          WHERE kingdom_id = $1 AND direction = 'refund') AS project_refunds`,
      [kingdomId]
    );
    expect(lifecycle.rows[0]).toEqual({
      kingdom_status: "dissolved",
      active_members: "0",
      pending_invitations: "0",
      seat_status: "archived",
      cot_status: "archived",
      decoration_status: "archived",
      donations: "1",
      treasury: "310",
      affiliated_flags: "0",
      project_status: null,
      project_refunds: "0"
    });
    const preserved = await pool.query<{ owner_id: string; control_type: string; kingdom_id: string | null }>(
      "SELECT owner_id, control_type, kingdom_id FROM flags WHERE id = $1",
      [kingdomFlag]
    );
    expect(preserved.rows[0]).toEqual({
      owner_id: leader.playerId, control_type: "personal", kingdom_id: null
    });
    await expect(pool.query<{ action: string }>(
      `SELECT action FROM kingdom_flag_affiliation_history
       WHERE flag_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [kingdomFlag]
    )).resolves.toMatchObject({ rows: [{ action: "restored_on_dissolution" }] });
  });

  it("reuses a restored source flag after its former Castle is archived", async () => {
    const founder = await player("RefoundingLeader");
    const sourceFlagId = await ensureFoundingSourceFlag(founder);
    const domain = service();
    const first = await domain.foundKingdom(founder, {
      requestId: "first-source-lifecycle",
      displayName: "First Source Realm",
      sourceFlagId
    });
    const firstKingdomId = first.state!.kingdom!.id;
    const firstSeatId = first.state!.kingdom!.seat!.id;

    await domain.dissolveKingdom(founder.playerId, "archive-first-source-seat");
    const second = await domain.foundKingdom(founder, {
      requestId: "second-source-lifecycle",
      displayName: "Second Source Realm",
      sourceFlagId
    });

    expect(second.state!.kingdom).toMatchObject({
      displayName: "Second Source Realm",
      seat: { sourceFlagId }
    });
    expect(second.state!.kingdom!.id).not.toBe(firstKingdomId);
    expect(second.state!.kingdom!.seat!.id).not.toBe(firstSeatId);
    await expect(pool.query<{
      id: string; kingdom_id: string; source_flag_id: string; status: string;
    }>(
      `SELECT id, kingdom_id, source_flag_id, status
       FROM kingdom_seats WHERE source_flag_id = $1 ORDER BY created_at, id`,
      [sourceFlagId]
    )).resolves.toMatchObject({ rows: [
      { id: firstSeatId, kingdom_id: firstKingdomId, source_flag_id: sourceFlagId, status: "archived" },
      {
        id: second.state!.kingdom!.seat!.id,
        kingdom_id: second.state!.kingdom!.id,
        source_flag_id: sourceFlagId,
        status: "active"
      }
    ] });
  });
});

function landWorld(): WorldLookupResult {
  return {
    ok: true,
    packageId: "world-test",
    elevationM: 1_620,
    terrainClass: "plains",
    biome: "temperate grassland",
    ecoregion: "test ecoregion",
    isLand: true,
    isSaltwater: false,
    insideMajorLake: false,
    slope: 2,
    worldReleaseId: "release-test",
    worldReleaseVersion: "2026.07",
    environmentSchemaVersion: "1",
    generatorVersion: "environment-profile-world-test-v1",
    sourceVersions: { terrain: "1" },
    raw: {}
  };
}

async function grantInventory(
  pool: pg.Pool,
  playerId: string,
  resourceType: "wood" | "stone" | "food" | "ore" | "water" | "leather" | "balsam_resin" | "iron" | "refined_oil",
  quantity: number
): Promise<void> {
  const operationKey = `kingdom-test-grant:${playerId}:${resourceType}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO inventory_operations (operation_key, player_id, source)
       VALUES ($1,$2,'kingdom_test_seed')`,
      [operationKey, playerId]
    );
    await client.query(
      `INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
       VALUES ($1,$2,'default',$3,1)`,
      [playerId, resourceType, quantity]
    );
    await client.query(
      `INSERT INTO inventory_events (
         operation_key, player_id, item_id, variant, delta_quantity,
         quantity_after, version_after, source
       ) VALUES ($1,$2,$3,'default',$4,$4,1,'kingdom_test_seed')`,
      [operationKey, playerId, resourceType, quantity]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupFixtures(pool: pg.Pool, playerIds: string[]): Promise<void> {
  if (playerIds.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const kingdoms = await client.query<{ id: string }>(
      "SELECT id FROM kingdoms WHERE founder_player_id = ANY($1::text[])",
      [playerIds]
    );
    const kingdomIds = kingdoms.rows.map(({ id }) => id);
    const cities = await client.query<{ id: string }>(
      "SELECT id FROM cities WHERE founder_player_id = ANY($1::text[])",
      [playerIds]
    );
    const cityIds = cities.rows.map(({ id }) => id);
    if (cityIds.length > 0) {
      await client.query(
        "DELETE FROM city_flag_affiliation_history WHERE city_id = ANY($1::uuid[])",
        [cityIds]
      );
      await client.query(
        "DELETE FROM city_mutations WHERE city_id = ANY($1::uuid[])",
        [cityIds]
      );
      await client.query(
        "DELETE FROM city_memberships WHERE city_id = ANY($1::uuid[])",
        [cityIds]
      );
      await client.query(
        "DELETE FROM city_structures WHERE city_id = ANY($1::uuid[])",
        [cityIds]
      );
      await client.query(
        `UPDATE flags
         SET control_type = 'personal', city_id = NULL,
             city_affiliated_at = NULL, city_affiliated_by_player_id = NULL
         WHERE city_id = ANY($1::uuid[])`,
        [cityIds]
      );
      await client.query("DELETE FROM cities WHERE id = ANY($1::uuid[])", [cityIds]);
    }
    if (kingdomIds.length > 0) {
      for (const [table, trigger] of [
        ["kingdom_audit_events", "kingdom_audit_events_append_only"],
        ["kingdom_donations", "kingdom_donations_append_only"],
        ["kingdom_xp_ledger", "kingdom_xp_ledger_append_only"],
        ["kingdom_treasury_expenditures", "kingdom_treasury_expenditures_append_only"]
      ]) {
        await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      }
      for (const table of [
        "kingdom_requests",
        "kingdom_flag_affiliation_history",
        "kingdom_audit_events",
        "kingdom_construction_jobs",
        "kingdom_treasury_expenditures",
        "kingdom_projects",
        "kingdom_decorations",
        "kingdom_cots",
        "kingdom_xp_ledger",
        "kingdom_donations",
        "kingdom_treasury_balances",
        "kingdom_chat_mutes",
        "kingdom_chat_messages",
        "kingdom_invitations",
        "kingdom_memberships",
        "kingdom_seats"
      ]) {
        await client.query(`DELETE FROM ${table} WHERE kingdom_id = ANY($1::uuid[])`, [kingdomIds]);
      }
      for (const [table, trigger] of [
        ["kingdom_audit_events", "kingdom_audit_events_append_only"],
        ["kingdom_donations", "kingdom_donations_append_only"],
        ["kingdom_xp_ledger", "kingdom_xp_ledger_append_only"],
        ["kingdom_treasury_expenditures", "kingdom_treasury_expenditures_append_only"]
      ]) {
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
      await client.query("DELETE FROM flags WHERE owner_id = ANY($1::text[])", [playerIds]);
      // Tables added by later batches that also reference kingdoms: clear them generically.
      const referencing = await client.query<{ table_name: string; column_name: string }>(
        `SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.confrelid = 'kingdoms'::regclass AND c.contype = 'f' AND c.confdeltype <> 'c'
           AND c.conrelid::regclass::text <> 'flags'`
      );
      await client.query("SET LOCAL session_replication_role = replica");
      for (const { table_name: table, column_name: column } of referencing.rows) {
        await client.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [kingdomIds]);
      }
      await client.query("SET LOCAL session_replication_role = origin");
      await client.query("DELETE FROM kingdoms WHERE id = ANY($1::uuid[])", [kingdomIds]);
    }
    await client.query("DELETE FROM flags WHERE owner_id = ANY($1::text[])", [playerIds]);
    await client.query(
      "ALTER TABLE flag_destruction_refunds DISABLE TRIGGER flag_destruction_refunds_immutable"
    );
    await client.query(
      "ALTER TABLE flag_material_spend DISABLE TRIGGER flag_material_spend_immutable"
    );
    await client.query(
      `DELETE FROM flag_destruction_refunds
       WHERE paid_by_player_id = ANY($1::text[])
          OR operation_key IN (
            SELECT operation_key FROM flag_destruction_operations
            WHERE actor_player_id = ANY($1::text[])
          )`,
      [playerIds]
    );
    await client.query(
      "DELETE FROM flag_material_spend WHERE paid_by_player_id = ANY($1::text[])",
      [playerIds]
    );
    await client.query(
      "DELETE FROM flag_destruction_operations WHERE actor_player_id = ANY($1::text[])",
      [playerIds]
    );
    await client.query(
      "ALTER TABLE flag_material_spend ENABLE TRIGGER flag_material_spend_immutable"
    );
    await client.query(
      "ALTER TABLE flag_destruction_refunds ENABLE TRIGGER flag_destruction_refunds_immutable"
    );
    await client.query("ALTER TABLE inventory_events DISABLE TRIGGER inventory_events_immutable");
    await client.query("ALTER TABLE inventory_operations DISABLE TRIGGER inventory_operations_immutable");
    await client.query("ALTER TABLE player_inventory DISABLE TRIGGER player_inventory_identity_guard");
    await client.query("ALTER TABLE weekly_leaderboard_events DISABLE TRIGGER weekly_leaderboard_events_immutable");
    await client.query("DELETE FROM inventory_events WHERE player_id = ANY($1::text[])", [playerIds]);
    await client.query("DELETE FROM inventory_operations WHERE player_id = ANY($1::text[])", [playerIds]);
    await client.query("ALTER TABLE inventory_operations ENABLE TRIGGER inventory_operations_immutable");
    await client.query("ALTER TABLE inventory_events ENABLE TRIGGER inventory_events_immutable");
    await client.query("DELETE FROM player_inventory WHERE player_id = ANY($1::text[])", [playerIds]);
    await client.query("DELETE FROM player_inventory_capacities WHERE player_id = ANY($1::text[])", [playerIds]);
    await client.query("DELETE FROM weekly_leaderboard_events WHERE player_id = ANY($1::text[])", [playerIds]);
    await client.query("ALTER TABLE weekly_leaderboard_events ENABLE TRIGGER weekly_leaderboard_events_immutable");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("ALTER TABLE economy_events DISABLE TRIGGER economy_events_immutable");
    await client.query("DELETE FROM economy_events WHERE player_id = ANY($1::text[])", [playerIds]);
    await client.query("ALTER TABLE economy_events ENABLE TRIGGER economy_events_immutable");
    await client.query("ALTER TABLE player_inventory ENABLE TRIGGER player_inventory_identity_guard");
    await client.query("DELETE FROM players WHERE id = ANY($1::text[])", [playerIds]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
