import { randomUUID } from "node:crypto";

import {
  FISHING_HUT_BUILD_COST,
  FISHING_HUT_BUILD_DURATION_MS,
  FISHING_ACTIVE_ENCOUNTER_TIMEOUT_MS,
  fishingBiteTimeline,
  FISHING_HUT_PASSIVE_CAPACITY,
  FISHING_HUT_PASSIVE_INTERVAL_MS,
  FISHING_STAMINA_MAX
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import { FishingService } from "./fishing.js";
import { InventoryService } from "./inventory.js";
import { packageIdForPosition } from "./spatialZones.js";
import type { PlayerRecord } from "./state.js";

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Freshwater Fishing PostgreSQL authority", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let nowMs: number;
  let worldMode: "freshwater" | "canonical-river" | "saltwater" | "inland" | "unresolved-ocean" | "stale-package";
  let castMode: "valid" | "land" | "wrong-waterbody" | "saltwater" | "stale-package";
  let exactCastIdentity = false;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
    inventory = new InventoryService(pool);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await pool.query("DELETE FROM flags WHERE owner_id IN ('owner','guest')");
    await createPlayer("owner", "Ash");
    await createPlayer("guest", "Bex");
    await pool.query(
      `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
       VALUES ($1,'owner','Ash territory',35,-106,500,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [randomUUID()]
    );
    nowMs = Date.UTC(2026, 0, 1);
    worldMode = "freshwater";
    castMode = "valid";
    exactCastIdentity = false;
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("requires authoritative freshwater and personal territory, then persists the selected waterbody in records", async () => {
    const service = fishingService();
    await grantBuildMaterials();

    worldMode = "saltwater";
    await expect(service.build(owner(), "saltwater-build"))
      .rejects.toMatchObject({ code: "FISHING_WATER_REQUIRED" });
    worldMode = "freshwater";
    await expect(service.build(owner(35.01, -106), "outside-territory"))
      .rejects.toMatchObject({ code: "FISHING_PERSONAL_TERRITORY_REQUIRED" });

    const started = await service.build(owner(), "waterbody-build");
    expect(started).toMatchObject({
      status: "constructing",
      replayed: false,
      build: { durationMs: FISHING_HUT_BUILD_DURATION_MS, waterbody: { kind: "lake", sourceId: "lake-01", displayName: "Mirror Lake" } }
    });
    nowMs += FISHING_HUT_BUILD_DURATION_MS;
    const completed = await service.reconcileDueBuilds();
    const hut = completed.completed[0]?.hut;
    expect(hut).toMatchObject({
      ownerPlayerId: "owner",
      waterbody: { kind: "lake", sourceId: "lake-01", displayName: "Mirror Lake", distanceM: 50, sourceRevision: "world-r1" }
    });
    expect(hut).toBeDefined();

    const encounterId = randomUUID();
    await pool.query(
      `INSERT INTO fishing_encounters (
         encounter_id,player_id,fishing_hut_id,waterbody_kind,waterbody_source_id,waterbody_name,
         phase,behavior_profile,seed,difficulty,length_in,weight_lb,size_percentile,score,perfect,region_name,country_name,bite_at,reconnect_deadline_at,completed_at
       ) VALUES ($1,'owner',$2,'lake','lake-01','Mirror Lake','landed','runner',7,.45,24,4.5,.64,840,true,'Test Region','Test Country',
         to_timestamp($3/1000.0),to_timestamp($3/1000.0),to_timestamp($3/1000.0))`,
      [encounterId, hut!.fishingHutId, nowMs]
    );
    await pool.query(
      `INSERT INTO fishing_catch_records (
         encounter_id,player_id,fishing_hut_id,waterbody_kind,waterbody_source_id,waterbody_name,
         fish_item_id,ashen,behavior_profile,difficulty,world_source_revision,environment_schema_version,length_in,weight_lb,score,perfect,duration_ms,week_start
       ) VALUES ($1,'owner',$2,'lake','lake-01','Mirror Lake','freshwater_fish',false,'runner',.45,'world-r1','gameplay-environment-v1',24,4.5,840,true,1200,
         (timezone('America/Denver',clock_timestamp())::date - ((extract(isodow from timezone('America/Denver',clock_timestamp()))::int)-1)))`,
      [encounterId, hut!.fishingHutId]
    );
    await expect(service.records(owner(), hut!.fishingHutId)).resolves.toMatchObject({
      waterbody: { kind: "lake", sourceId: "lake-01", displayName: "Mirror Lake", distanceM: 50 },
      heaviest: {
        weightLb: 4.5,
        score: 840,
        fishSpecies: "freshwater_fish",
        percentile: 0.64,
        geography: { region: "Test Region", country: "Test Country" },
        waterbody: { sourceRevision: "world-r1" }
      },
      highestScore: { weightLb: 4.5, score: 840 },
      personalBestWeight: { weightLb: 4.5 },
      personalBestScore: { score: 840 },
      weeklyBestFiveScore: 840,
      weeklyTopAnglers: [{ playerId: "owner", username: "Ash", score: 840, catchCount: 1 }]
    });
  });

  it("uses the World gameplay package rather than its administrative region code", async () => {
    await grantBuildMaterials();
    const started = await fishingService().build(owner(), "administrative-region-code");
    expect(started).toMatchObject({
      status: "constructing",
      build: { waterbody: { kind: "lake", sourceId: "lake-01", displayName: "Mirror Lake" } }
    });
  });

  it("retries when the player or World gameplay package is stale", async () => {
    await grantBuildMaterials();
    worldMode = "stale-package";
    await expect(fishingService().build(owner(), "stale-world-package"))
      .rejects.toMatchObject({ code: "FISHING_REGION_MISMATCH" });

    worldMode = "freshwater";
    await expect(fishingService().build(
      owner(35, -106, "world_v1_lat34_lon-107"),
      "stale-player-package"
    )).rejects.toMatchObject({ code: "FISHING_REGION_MISMATCH" });
  });

  it("serializes construction requests and replays the winning request without a second debit", async () => {
    await grantBuildMaterials();
    const service = fishingService();
    const requestIds = ["concurrent-a", "concurrent-b"] as const;
    const settled = await Promise.allSettled(requestIds.map((requestId) => service.build(owner(), requestId)));
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "FISHING_BUILD_ACTIVE" }
    });

    const winnerIndex = settled.findIndex((result) => result.status === "fulfilled");
    const winnerRequestId = requestIds[winnerIndex]!;
    await expect(service.build(owner(), winnerRequestId)).resolves.toMatchObject({
      status: "constructing",
      replayed: true
    });
    const totals = await inventory.getInventorySnapshot("owner");
    expect(totals.totals.wood).toBe(0);
    expect(totals.totals.stone).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM fishing_hut_build_jobs WHERE owner_player_id='owner'")).rows[0]?.count).toBe(1);
  });

  it("caps passive output, preserves overflow, and replays collection idempotently", async () => {
    await grantBuildMaterials();
    const service = fishingService();
    const started = await service.build(owner(), "passive-build");
    nowMs += FISHING_HUT_BUILD_DURATION_MS;
    const completed = await service.reconcileDueBuilds();
    const hutId = completed.completed[0]!.hut.fishingHutId;
    await pool.query(
      `UPDATE player_fishing_huts
       SET passive_last_produced_at=to_timestamp($1/1000.0),passive_stored_quantity=4
       WHERE fishing_hut_id=$2`,
      [nowMs - 20 * FISHING_HUT_PASSIVE_INTERVAL_MS, hutId]
    );
    const first = await service.collect(owner(), "passive-collect", hutId);
    expect(first.collectedQuantity).toBe(FISHING_HUT_PASSIVE_CAPACITY);
    expect(first.state.hut.passiveStoredQuantity).toBe(0);
    await expect(service.collect(owner(), "passive-collect", hutId)).resolves.toMatchObject({
      replayed: true,
      collectedQuantity: FISHING_HUT_PASSIVE_CAPACITY
    });
    expect((await inventory.getInventorySnapshot("owner")).totals.freshwater_fish).toBe(FISHING_HUT_PASSIVE_CAPACITY);
    expect(started.status).toBe("constructing");
  });

  it("keeps an active encounter server-owned, resumes duplicate starts, and settles one ordinary catch", async () => {
    await grantBuildMaterials();
    const service = fishingService([123]);
    await service.build(owner(), "active-build");
    nowMs += FISHING_HUT_BUILD_DURATION_MS;
    const completed = await service.reconcileDueBuilds();
    const hutId = completed.completed[0]!.hut.fishingHutId;

    const started = await service.start(owner(), "active-start", hutId);
    expect(started).toMatchObject({
      replayed: false,
      state: { encounter: { phase: "cast", ashen: false, behaviorProfile: expect.any(String), stamina: FISHING_STAMINA_MAX } }
    });
    await expect(service.start(owner(35.0001, -106), "active-start", hutId))
      .resolves.toMatchObject({ replayed: true, state: { encounter: { ashen: false } } });
    await expect(service.start(owner(), "active-start-two", hutId))
      .rejects.toMatchObject({ code: "FISHING_ENCOUNTER_ACTIVE" });

    const encounterId = started.state.encounter!.encounterId;
    await pool.query(
      `UPDATE fishing_encounters
       SET phase='fighting',distance=10,stamina=20,tension=45,execution_quality=.5,fish_direction='left',fish_pull=1.8,
           control_direction='neutral',control_reeling=false,hooked_at=to_timestamp($2/1000.0),last_action_at=to_timestamp($2/1000.0)
       WHERE encounter_id=$1`,
      [encounterId, nowMs - 30_000]
    );
    const delayedFirstControl = await service.control(owner(), "active-control-delayed", encounterId, "left", true);
    expect(delayedFirstControl).toMatchObject({
      replayed: false,
      state: { encounter: { encounterId, phase: "fighting" } }
    });
    await expect(pool.query(
      `SELECT tension,execution_quality,control_direction,control_reeling
       FROM fishing_encounters WHERE encounter_id=$1`,
      [encounterId]
    )).resolves.toMatchObject({ rows: [{ tension: 43, execution_quality: 0.495, control_direction: "left", control_reeling: true }] });
    await pool.query(
      `UPDATE fishing_encounters SET last_action_at=to_timestamp($2/1000.0) WHERE encounter_id=$1`,
      [encounterId, nowMs]
    );
    nowMs += 250;
    const releasedControl = await service.control(owner(), "active-control-release", encounterId, "neutral", false);
    expect(releasedControl).toMatchObject({ state: { encounter: { encounterId, phase: "fighting" } } });
    await expect(pool.query(
      `SELECT tension,execution_quality,control_direction,control_reeling
       FROM fishing_encounters WHERE encounter_id=$1`,
      [encounterId]
    )).resolves.toMatchObject({ rows: [{ tension: 43.1275, execution_quality: 0.505, control_direction: "neutral", control_reeling: false }] });
    await pool.query(
      `UPDATE fishing_encounters
       SET distance=10,stamina=20,tension=45,last_action_at=to_timestamp($2/1000.0)
       WHERE encounter_id=$1`,
      [encounterId, nowMs]
    );
    const landed = await service.land(owner(), "active-land", encounterId);
    expect(landed).toMatchObject({
      replayed: false,
      collectedQuantity: expect.any(Number),
      state: { encounter: { phase: "landed", catch: { fishItemId: "freshwater_fish", ashen: false } } }
    });
    await expect(service.land(owner(), "active-land", encounterId)).resolves.toMatchObject({
      replayed: true,
      collectedQuantity: landed.collectedQuantity
    });
    expect((await inventory.getInventorySnapshot("owner")).totals.freshwater_fish).toBe(landed.collectedQuantity);
    await expect(service.records(owner(), hutId)).resolves.toMatchObject({ ashenCatches: [] });
    await expect(pool.query(
      `SELECT waterbody_source_id,canonical_waterbody_id,canonical_display_name,waterbody_resolution_state,presentation_name,presentation_relation
       FROM fishing_catch_records WHERE encounter_id=$1`,
      [encounterId]
    )).resolves.toMatchObject({
      rows: [{
        waterbody_source_id: "lake-01",
        canonical_waterbody_id: null,
        canonical_display_name: null,
        waterbody_resolution_state: "unresolved",
        presentation_name: "Mirror Lake",
        presentation_relation: "exact"
      }]
    });
  });

  it("does not reward a fake nibble and accepts the later true strike", async () => {
    await grantBuildMaterials();
    const service = fishingService([123]);
    await service.build(owner(), "bite-build");
    nowMs += FISHING_HUT_BUILD_DURATION_MS;
    const completed = await service.reconcileDueBuilds();
    const hutId = completed.completed[0]!.hut.fishingHutId;
    const started = await service.start(owner(), "bite-start", hutId);
    const encounterId = started.state.encounter!.encounterId;
    const timeline = fishingBiteTimeline(123, started.state.encounter!.biteAt);

    nowMs = started.state.encounter!.biteAt - 1;
    await expect(service.hook(owner(), "bite-early", encounterId))
      .rejects.toMatchObject({ code: "FISHING_HOOK_MISSED" });
    nowMs = timeline[0]!.startedAt + 10;
    await expect(service.state(owner(), hutId)).resolves.toMatchObject({
      encounter: { phase: "bite", biteEvent: { kind: "nibble" } }
    });

    nowMs = timeline[1]!.startedAt + 10;
    const falseHook = await service.hook(owner(), "bite-fake", encounterId);
    expect(falseHook).toMatchObject({
      replayed: false,
      state: { encounter: { encounterId, phase: "cast", castPoint: null } }
    });
    await expect(service.state(owner(), hutId)).resolves.toMatchObject({
      encounter: { phase: "cast", castPoint: null }
    });
    await expect(service.hook(owner(), "bite-fake", encounterId)).resolves.toMatchObject({
      replayed: true,
      state: { encounter: { encounterId, phase: "cast" } }
    });
    const beforeTrueStrike = await pool.query<{ count: string }>(
      "SELECT COALESCE(SUM(quantity),0)::int AS count FROM player_inventory WHERE player_id='owner' AND resource_type='freshwater_fish'"
    );
    expect(Number(beforeTrueStrike.rows[0]?.count ?? 0)).toBe(0);

    const nextTimeline = fishingBiteTimeline(123, falseHook.state.encounter!.biteAt);
    nowMs = nextTimeline[2]!.startedAt + 10;
    await expect(service.hook(owner(), "bite-valid", encounterId)).resolves.toMatchObject({
      state: { encounter: { phase: "fighting", biteEvent: null } }
    });
  });

  it("keeps a cast waiting through a missed bite and reconnect without expiring it", async () => {
    await grantBuildMaterials();
    const service = fishingService([789]);
    await service.build(owner(), "rearm-build");
    nowMs += FISHING_HUT_BUILD_DURATION_MS;
    const completed = await service.reconcileDueBuilds();
    const hutId = completed.completed[0]!.hut.fishingHutId;
    const started = await service.start(owner(), "rearm-start", hutId);
    const encounterId = started.state.encounter!.encounterId;
    const castPoint = { lat: 35.0005, lon: -106.0005 };
    const firstBiteAt = nowMs + 1_000;
    await pool.query(
      `UPDATE fishing_encounters
       SET phase='cast',cast_lat=$2,cast_lon=$3,cast_quality=.8,bite_at=to_timestamp($4/1000.0),last_action_at=to_timestamp($5/1000.0)
       WHERE encounter_id=$1`,
      [encounterId, castPoint.lat, castPoint.lon, firstBiteAt, nowMs]
    );
    const firstTimeline = fishingBiteTimeline(789, firstBiteAt);

    nowMs = firstTimeline[2]!.endsAt + 1;
    const missed = await service.state(owner(), hutId);
    expect(missed).toMatchObject({
      encounter: { encounterId, phase: "cast", castPoint }
    });
    expect(missed.encounter!.biteAt).toBeGreaterThan(nowMs);

    await service.markDisconnected("owner");
    await expect(pool.query(
      `SELECT control_direction,control_reeling
       FROM fishing_encounters WHERE encounter_id=$1`,
      [encounterId]
    )).resolves.toMatchObject({ rows: [{ control_direction: "neutral", control_reeling: false }] });
    nowMs += 1_000;
    const resumed = await service.resumeState(owner());
    expect(resumed).toMatchObject({ encounter: { encounterId, phase: "cast", castPoint } });
    expect(resumed!.encounter!.reconnectDeadlineAt).toBeGreaterThan(nowMs);

    nowMs = resumed!.encounter!.biteAt + FISHING_ACTIVE_ENCOUNTER_TIMEOUT_MS + 1;
    const stillWaiting = await service.state(owner(), hutId);
    expect(stillWaiting).toMatchObject({ encounter: { encounterId, phase: "cast", castPoint } });
    expect(stillWaiting.encounter!.biteAt).toBeGreaterThan(nowMs);
  });

  it("accepts land beside the final river grid when legacy river fields disagree", async () => {
    worldMode = "canonical-river";
    await grantBuildMaterials();
    const service = fishingService();
    const started = await service.build(owner(), "canonical-river-build");
    expect(started).toMatchObject({
      status: "constructing",
      build: {
        waterbody: {
          kind: "river",
          sourceId: "river-grid-rio-grande",
          displayName: "Rio Grande",
          distanceM: 90
        }
      }
    });
  });

  it("binds only an exact associated final-grid water cell and replays the bound cast", async () => {
    await grantBuildMaterials();
    worldMode = "canonical-river";
    const service = fishingService([456]);
    await service.build(owner(), "cast-build");
    nowMs += FISHING_HUT_BUILD_DURATION_MS;
    const completed = await service.reconcileDueBuilds();
    const hutId = completed.completed[0]!.hut.fishingHutId;
    const started = await service.start(owner(), "cast-start", hutId);
    const encounterId = started.state.encounter!.encounterId;
    const castPoint = { lat: 35.0005, lon: -106.0005 };

    exactCastIdentity = true;
    const cast = await service.cast(owner(), "cast-valid", encounterId, 0.5, castPoint);
    expect(cast).toMatchObject({
      state: {
        encounter: {
          castPoint,
          waterbody: { displayName: "Exact Rio Grande" },
          catch: null
        }
      },
      replayed: false
    });
    expect(cast.state.encounter).toMatchObject({
      waterbody: { kind: "river", sourceId: "river-grid-rio-grande", displayName: "Exact Rio Grande" }
    });
    await expect(pool.query(
      `SELECT waterbody_name,region_name,country_name FROM fishing_encounters WHERE encounter_id=$1`,
      [encounterId]
    )).resolves.toMatchObject({
      rows: [{ waterbody_name: "Exact Rio Grande", region_name: "Test Region", country_name: "Test Country" }]
    });
    await expect(service.cast(owner(), "cast-valid", encounterId, 0.5, castPoint)).resolves.toMatchObject({
      replayed: true,
      state: { encounter: { castPoint } }
    });
    await expect(service.resumeState(owner())).resolves.toMatchObject({
      encounter: { encounterId, castPoint }
    });
    await expect(service.cast(owner(), "cast-conflict", encounterId, 0.5, { lat: 35.0006, lon: -106.0006 }))
      .rejects.toMatchObject({ code: "FISHING_CAST_INVALID" });

    await service.cancel(owner(), "cast-cancel", encounterId);
    const second = await service.start(owner(), "cast-second-start", hutId);
    const secondEncounterId = second.state.encounter!.encounterId;
    castMode = "land";
    await expect(service.cast(owner(), "cast-land", secondEncounterId, 0.5, castPoint))
      .rejects.toMatchObject({ code: "FISHING_CAST_WATER_REQUIRED" });
    castMode = "wrong-waterbody";
    await expect(service.cast(owner(), "cast-wrong-body", secondEncounterId, 0.5, castPoint))
      .rejects.toMatchObject({ code: "FISHING_CAST_WATERBODY_REQUIRED" });
    castMode = "saltwater";
    await expect(service.cast(owner(), "cast-saltwater", secondEncounterId, 0.5, castPoint))
      .rejects.toMatchObject({ code: "FISHING_CAST_WATER_REQUIRED" });
    castMode = "stale-package";
    await expect(service.cast(owner(), "cast-stale-package", secondEncounterId, 0.5, castPoint))
      .rejects.toMatchObject({ code: "FISHING_REGION_MISMATCH" });
    await expect(service.cast(owner(), "cast-too-far", secondEncounterId, 0.5, { lat: 35.01, lon: -106 }))
      .rejects.toMatchObject({ code: "FISHING_CAST_OUT_OF_RANGE" });
  });

  it("keeps the exact lake identity returned for the cast square", async () => {
    await grantBuildMaterials();
    exactCastIdentity = true;
    const service = fishingService([456]);
    await service.build(owner(), "laguna-build");
    nowMs += FISHING_HUT_BUILD_DURATION_MS;
    const completed = await service.reconcileDueBuilds();
    const hutId = completed.completed[0]!.hut.fishingHutId;
    const started = await service.start(owner(), "laguna-start", hutId);
    const encounterId = started.state.encounter!.encounterId;

    const cast = await service.cast(owner(), "laguna-cast", encounterId, 0.5, { lat: 35.0005, lon: -106.0005 });
    expect(cast.state.encounter).toMatchObject({
      waterbody: { kind: "lake", sourceId: "lake-01", displayName: "Laguna Tampamachoco" }
    });
  });

  it("starts and casts on unresolved authoritative ocean without inventing an identity", async () => {
    worldMode = "unresolved-ocean";
    const service = fishingService([456]);
    const rodClient = await pool.connect();
    try {
      await rodClient.query("BEGIN");
      await service.grantDurableRodsInTransaction(rodClient, {
        operationKey: `unresolved-ocean-rod:${randomUUID()}`,
        playerId: "owner",
        quantity: 1,
        source: "fishing_unresolved_ocean_test"
      });
      await rodClient.query("COMMIT");
    } catch (error) {
      await rodClient.query("ROLLBACK");
      throw error;
    } finally {
      rodClient.release();
    }
    const rod = await pool.query<{ rod_id: string }>(
      "SELECT rod_id::text FROM fishing_rods WHERE player_id='owner' ORDER BY created_at DESC,rod_id DESC LIMIT 1"
    );
    const rodId = rod.rows[0]?.rod_id;
    expect(rodId).toBeDefined();

    const started = await service.start(owner(), "unresolved-ocean-start", rodId!);
    expect(started.state.encounter).toMatchObject({
      phase: "cast",
      waterbody: { kind: "ocean", sourceId: null, displayName: "Open Ocean" },
      waterbodyCandidates: [{ kind: "ocean", sourceId: null, displayName: "Open Ocean" }]
    });
    const encounterId = started.state.encounter!.encounterId;
    const castPoint = { lat: 35.0005, lon: -106.0005 };
    const cast = await service.cast(
      owner(),
      "unresolved-ocean-cast",
      encounterId,
      0.5,
      castPoint,
      { kind: "ocean", sourceId: null }
    );
    expect(cast.state.encounter).toMatchObject({
      phase: "cast",
      castPoint,
      waterbody: { kind: "ocean", sourceId: null, displayName: "Open Ocean" }
    });
    await expect(pool.query(
      `SELECT waterbody_source_id,canonical_waterbody_id,canonical_display_name,
              gameplay_water_type,waterbody_resolution_state,presentation_name,presentation_relation
       FROM fishing_encounters WHERE encounter_id=$1`,
      [encounterId]
    )).resolves.toMatchObject({ rows: [{
      waterbody_source_id: null,
      canonical_waterbody_id: null,
      canonical_display_name: null,
      gameplay_water_type: "ocean",
      waterbody_resolution_state: "unresolved",
      presentation_name: "Open Ocean",
      presentation_relation: "open_ocean"
    }] });
  });

  function fishingService(randomValues: number[] = []): FishingService {
    const worldLookup: Pick<WorldLookupClient, "lookupGameplayEnvironment" | "lookupCanonicalWaterbodyNear"> = {
      lookupGameplayEnvironment: async (lat, lon) => {
        const freshwater = worldMode === "freshwater" || worldMode === "canonical-river" || worldMode === "stale-package";
        const castDistanceM = Math.hypot((lat - 35) * 111_000, (lon + 106) * 91_000);
        const castWaterKind = castMode === "wrong-waterbody"
          ? "lake"
          : castMode === "saltwater" || worldMode === "unresolved-ocean"
            ? "ocean"
            : worldMode === "canonical-river" ? "river" : "lake";
        const castSurface = castDistanceM > 1 && castDistanceM <= 200 && castMode !== "land" && (castMode === "valid" || castMode === "wrong-waterbody" || worldMode === "unresolved-ocean");
        const isWater = worldMode === "unresolved-ocean" || castSurface;
        return {
          ok: true,
          contractVersion: "gameplay-environment-v1",
          runtime: null,
          latitude: lat,
          longitude: lon,
          packageId: castMode === "stale-package" ? "world_v1_lat35_lon-106" : worldMode === "stale-package" ? "world_v1_lat34_lon-107" : packageIdForPosition({ lat, lon }),
          regionCode: "US-NM",
          regionName: "Test Region",
          countryCode: "US",
          countryName: "Test Country",
          isLand: isWater ? false : worldMode !== "inland",
          isSaltwater: isWater ? castWaterKind === "ocean" : worldMode === "saltwater",
          surfaceKind: isWater ? "water" : freshwater ? "land" : "water",
          waterKind: isWater ? castWaterKind : freshwater ? null : worldMode === "saltwater" ? "ocean" : "inland_water",
          riverSurface: {
            surfaceKind: isWater && castWaterKind === "river" ? "water" : null,
            waterKind: isWater && castWaterKind === "river" ? "river" : null,
            isRiver: isWater && castWaterKind === "river",
            cellSizeM: 125,
            rowId: 100,
            columnId: 100,
            sourceReleaseId: "river-surface-v1",
            sourceManifestSha256: "river-manifest"
          },
          lakeSurface: {
            surfaceKind: isWater && castWaterKind === "lake" ? "water" : null,
            waterKind: isWater && castWaterKind === "lake" ? "lake" : null,
            isLake: isWater && castWaterKind === "lake",
            cellSizeM: 125,
            rowId: 100,
            columnId: 100,
            sourceReleaseId: "lake-surface-v1",
            sourceManifestSha256: "lake-manifest"
          },
          oceanCoastSurface: {
            surfaceKind: isWater && castWaterKind === "ocean" && castMode !== "saltwater" ? "water" : null,
            waterKind: isWater && castWaterKind === "ocean" && castMode !== "saltwater" ? "ocean" : null,
            isOceanCoast: false,
            cellSizeM: 125,
            rowId: 100,
            columnId: 100,
            sourceReleaseId: "ocean-coast-surface-v1",
            sourceManifestSha256: "ocean-manifest"
          },
          insideMajorLake: worldMode === "freshwater",
          majorLakeId: worldMode === "freshwater" ? "lake-01" : null,
          majorLakeName: worldMode === "freshwater" ? "Mirror Lake" : null,
          majorLakeDistanceM: worldMode === "freshwater" ? 50 : null,
          majorLakeSearchComplete: true,
          namedRiverId: worldMode === "canonical-river" ? "legacy-river" : worldMode === "freshwater" ? "river-01" : null,
          namedRiverName: worldMode === "canonical-river" ? "Legacy River" : worldMode === "freshwater" ? "Ash River" : null,
          riverDistanceM: worldMode === "canonical-river" ? 5_000 : worldMode === "freshwater" ? 120 : null,
          namedRiverSearchComplete: true,
          worldReleaseId: "world-r1",
          raw: {}
        } as unknown as WorldGameplayEnvironmentResult;
      },
      lookupCanonicalWaterbodyNear: async (_point, _origin, maxDistanceM) => {
        if (maxDistanceM === 0) {
          if (castMode === "land") return { kind: null, sourceId: null, sourceName: null, distanceM: null, searchComplete: true, sourceRevision: "world-r1" };
          if (worldMode === "unresolved-ocean") return { kind: "ocean", sourceId: null, sourceName: null, distanceM: 0, searchComplete: true, resolutionStatus: "unresolved", sourceRevision: "world-r1" };
          if (castMode === "wrong-waterbody") return { kind: "lake", sourceId: "lake-01", sourceName: "Mirror Lake", distanceM: 0, searchComplete: true, sourceRevision: "world-r1" };
          if (castMode === "saltwater") return { kind: "ocean", sourceId: "ocean-grid", sourceName: null, distanceM: 0, searchComplete: true, sourceRevision: "world-r1" };
          return worldMode === "canonical-river"
            ? { kind: "river", sourceId: "river-grid-rio-grande", sourceName: exactCastIdentity ? "Exact Rio Grande" : "Rio Grande", distanceM: 0, searchComplete: true, sourceRevision: "world-r1" }
            : { kind: "lake", sourceId: "lake-01", sourceName: exactCastIdentity ? "Laguna Tampamachoco" : "Mirror Lake", distanceM: 0, searchComplete: true, sourceRevision: "world-r1" };
        }
        return worldMode === "unresolved-ocean"
          ? { kind: "ocean", sourceId: null, sourceName: null, distanceM: 0, searchComplete: true, resolutionStatus: "unresolved", sourceRevision: "world-r1" }
          : worldMode === "freshwater" || worldMode === "stale-package"
          ? { kind: "lake", sourceId: "lake-01", sourceName: "Mirror Lake", distanceM: 50, searchComplete: true, sourceRevision: "world-r1" }
          : worldMode === "canonical-river"
            ? { kind: "river", sourceId: "river-grid-rio-grande", sourceName: "Rio Grande", distanceM: 90, searchComplete: true, sourceRevision: "world-r1" }
            : { kind: worldMode === "saltwater" ? "ocean" : "inland_water", sourceId: worldMode === "saltwater" ? "ocean-grid" : "inland-grid", sourceName: null, distanceM: 0, searchComplete: true, sourceRevision: "world-r1" };
      }
    };
    const randomInt = (min: number): number => randomValues.shift() ?? min;
    return new FishingService(pool, "test-world", inventory, worldLookup, () => nowMs, randomInt);
  }

  async function grantBuildMaterials(): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `fishing-build-test:${randomUUID()}`,
      playerId: "owner",
      source: "fishing_build_test_grant",
      grants: [
        { itemId: "wood", variant: null, quantity: FISHING_HUT_BUILD_COST.wood },
        { itemId: "stone", variant: null, quantity: FISHING_HUT_BUILD_COST.stone }
      ]
    });
  }

  async function createPlayer(playerId: string, username: string): Promise<void> {
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$3,35,-106,35,-106,2000,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, username, packageIdForPosition({ lat: 35, lon: -106 })]
    );
  }
});

function owner(
  lat = 35,
  lon = -106,
  regionCode = packageIdForPosition({ lat, lon })
): PlayerRecord {
  return {
    playerId: "owner",
    username: "Ash",
    displayColor: null,
    regionCode,
    position: { lat, lon },
    anchor: { lat: 35, lon: -106 },
    moveLeashRadiusM: 2_000,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date()
  };
}
