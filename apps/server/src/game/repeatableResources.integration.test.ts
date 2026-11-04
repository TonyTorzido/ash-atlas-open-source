import { randomUUID } from "node:crypto";

import { STONE_MINE_YIELD_QUANTITY } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { HarvestAccessService } from "./harvestAccess.js";
import { InventoryService } from "./inventory.js";
import { MasteryService } from "./masteries.js";
import {
  POPULATION_ZONE_V2_GEOMETRY_VERSION,
  populationZoneV2Geometry,
  populationZoneV2IdForPoint
} from "./populationZonesV2Geometry.js";
import { permanentMineKindForSlot } from "./populationZonesV2Identity.js";
import {
  RepeatableResourceService,
  STONE_MINE_REGENERATION_MS
} from "./repeatableResources.js";
import type { RepeatableResourceError } from "./repeatableResources.js";
import { WalletService } from "./wallet.js";

const databaseUrl = process.env.REPEATABLE_RESOURCE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("repeatable resources PostgreSQL integration", () => {
  const firstPool = new pg.Pool({ connectionString: validatedDatabaseUrl(databaseUrl), max: 3 });
  const secondPool = new pg.Pool({ connectionString: validatedDatabaseUrl(databaseUrl), max: 3 });
  const first = new RepeatableResourceService(firstPool);
  const second = new RepeatableResourceService(secondPool);
  const firstMasteries = new MasteryService(firstPool);
  const secondMasteries = new MasteryService(secondPool);
  const playerId = `repeatable-${randomUUID()}`;
  const playerAccountId = randomUUID();
  const nodeId = randomUUID();
  const planId = randomUUID();
  const slotId = stoneMineSlotId();
  const position = { lat: -30 + Math.random() * 0.1, lon: 60 + Math.random() * 0.1 };
  const zoneId = populationZoneV2IdForPoint(position);
  const zoneGeometry = populationZoneV2Geometry(zoneId);
  const regionCode = `repeatable-test-${randomUUID()}`;
  const player = { playerId, regionCode, position };
  const vision = {
    flagId: randomUUID(),
    flagName: "Repeatable test",
    center: position,
    movementLeashRadiusM: 1_250,
    paddingM: 250,
    radiusM: 1_500
  };
  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await firstPool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [playerAccountId]
    );
    await firstPool.query(
      `INSERT INTO players (
         id, account_id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$1,$3,$4,$5,$4,$5,1250,true,
                  ST_SetSRID(ST_MakePoint($5,$4),4326))`,
      [playerId, playerAccountId, regionCode, position.lat, position.lon]
    );
    await firstPool.query(
      `INSERT INTO population_zones_v2 (
         plan_id, zone_id, geometry_version,
         world_environment_identity_key, world_runtime_sha,
         plan_version, spawn_rules_version, environment_profile_version,
         candidate_layout_version, respawn_policy_version, region_code,
         band_index, column_index, zone_geog, center_geog, total_area_km2,
         status, next_retry_at
       ) VALUES (
         $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
         ST_Multi(ST_MakeEnvelope($14,$15,$16,$17,4326))::geography,
         ST_SetSRID(ST_MakePoint($18,$19),4326)::geography,
         $20,'pending',clock_timestamp()
       )`,
      [
        planId,
        zoneId,
        POPULATION_ZONE_V2_GEOMETRY_VERSION,
        "a".repeat(64),
        "b".repeat(40),
        `repeatable-plan-${nodeId}`,
        `repeatable-spawn-${nodeId}`,
        `repeatable-profile-${nodeId}`,
        `repeatable-layout-${nodeId}`,
        `repeatable-respawn-${nodeId}`,
        regionCode,
        zoneGeometry.address.band,
        zoneGeometry.address.column,
        zoneGeometry.bounds.westLon,
        zoneGeometry.bounds.southLat,
        zoneGeometry.bounds.eastLon,
        zoneGeometry.bounds.northLat,
        zoneGeometry.center.lon,
        zoneGeometry.center.lat,
        zoneGeometry.areaKm2
      ]
    );
    await firstPool.query(
      `INSERT INTO population_spawn_slots_v2 (
         plan_id, slot_id, entity_id, candidate_id, entity_kind,
         archetype, latitude, longitude, geom,
         anchor_latitude, anchor_longitude, anchor_geom,
         environment_snapshot, suppression_class
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4,'stone','stone_mine',$5,$6,
         ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,$5,$6,
         ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,
         '{}'::jsonb,'none'
       )`,
      [planId, slotId, nodeId, `repeatable-candidate-${nodeId}`, position.lat, position.lon]
    );
    await firstPool.query(
      `INSERT INTO population_entity_state_v2 (entity_id, state)
       VALUES ($1::uuid,'ready')`,
      [nodeId]
    );
    await firstPool.query(
      `INSERT INTO population_permanent_stone_authority_v2 (
         entity_id, slot_id, candidate_id, owner_zone_id,
         entity_kind, archetype, stone_placement_version,
         world_environment_identity_key, latitude, longitude,
         anchor_latitude, anchor_longitude, environment_snapshot,
         suppression_class
       ) VALUES (
         $1::uuid,$2::uuid,$3,$4,'stone','stone_mine',$5,$6,
         $7,$8,$7,$8,'{}'::jsonb,'none'
       )`,
      [
        nodeId,
        slotId,
        `repeatable-candidate-${nodeId}`,
        zoneId,
        "population-permanent-stone-placement-v1",
        "a".repeat(64),
        position.lat,
        position.lon
      ]
    );
    await firstPool.query(
      `INSERT INTO population_plan_permanent_stones_v2 (plan_id, entity_id)
       VALUES ($1::uuid,$2::uuid)`,
      [planId, nodeId]
    );
    await firstPool.query(
      `INSERT INTO repeatable_resource_nodes (
         id, node_type, region_code, lat, lon, geom, yield_item_id, yield_quantity,
         regeneration_interval, authored_source, placement_bucket_key, placement_version,
         population_v2_entity_id, physical_population_zone_v2_id,
         population_v2_plan_id, population_v2_state_revision,
         population_cutover_revision
       ) VALUES ($1,'stone_mine',$2,$3,$4,
                 ST_SetSRID(ST_MakePoint($4,$3),4326),
                 'stone',1,$6::double precision * interval '1 millisecond',
                 'population-v2',$5,$7,$1::uuid,$8,$9::uuid,0,1)`,
      [
        nodeId,
        regionCode,
        position.lat,
        position.lon,
        `integration:${nodeId}`,
        STONE_MINE_REGENERATION_MS,
        `repeatable-layout-${nodeId}`,
        zoneId,
        planId
      ]
    );
    await firstPool.query(
      `INSERT INTO population_zone_cutovers_v2 (
         zone_id, geometry_version, serving_version, selected_plan_id,
         cutover_revision, status
       ) VALUES ($1,$2,'v2',$3::uuid,1,'stable')`,
      [zoneId, POPULATION_ZONE_V2_GEOMETRY_VERSION, planId]
    );
  });

  afterAll(async () => {
    await Promise.all([firstPool.end(), secondPool.end()]);
  });

  it("keeps coordinates stable, persists depletion, uses 5h50, and awards once concurrently", async () => {
    await firstMasteries.getOrCreate(playerId);
    await setMinerRank(firstPool, playerId, 2, 7_218);
    const initial = await first.listInVision(regionCode, vision);
    const fromSecondRuntime = await second.listInVision(regionCode, vision);
    expect(initial.find((node) => node.id === nodeId)).toEqual(
      fromSecondRuntime.find((node) => node.id === nodeId)
    );
    expect(initial.find((node) => node.id === nodeId)).toMatchObject({
      lat: position.lat,
      lon: position.lon,
      state: "ready",
      yieldQuantity: STONE_MINE_YIELD_QUANTITY
    });

    const firstSession = await first.startMining(player, nodeId, vision);
    const duration = await firstPool.query<{ duration_ms: string; effective_duration_ms: string }>(
      `SELECT EXTRACT(EPOCH FROM (completes_at - started_at)) * 1000 AS duration_ms,
              effective_duration_ms
       FROM repeatable_resource_sessions WHERE id = $1`,
      [firstSession.session.sessionId]
    );
    expect(Number(duration.rows[0]?.duration_ms)).toBe(30_000);
    expect(Number(duration.rows[0]?.effective_duration_ms)).toBe(30_000);
    await makeSessionCompletable(firstPool, firstSession.session.sessionId);
    const firstHarvest = await first.completeMining(player, firstSession.session.sessionId, vision);
    expect(firstHarvest.inventory.totals.stone).toBe(STONE_MINE_YIELD_QUANTITY);
    expect(firstHarvest.node).toMatchObject({
      id: nodeId,
      state: "depleted",
      authorityRevision: 2
    });
    expect(firstHarvest.node.readyAt).not.toBeNull();
    const harvestedAuthority = await firstPool.query<{
      harvested_at: Date;
      respawn_at: Date;
    }>(
      `SELECT killed_or_harvested_at AS harvested_at, respawn_at
       FROM population_entity_state_v2
       WHERE entity_id=$1::uuid`,
      [nodeId]
    );
    expect(
      harvestedAuthority.rows[0]!.respawn_at.getTime()
      - harvestedAuthority.rows[0]!.harvested_at.getTime()
    ).toBe(STONE_MINE_REGENERATION_MS);
    expect(firstHarvest.node.readyAt)
      .toBe(harvestedAuthority.rows[0]!.respawn_at.toISOString());
    await expect(second.startMining(player, nodeId, vision)).rejects.toMatchObject({
      code: "HARVEST_NODE_DEPLETED"
    } satisfies Partial<RepeatableResourceError>);

    const persisted = await secondPool.query<{ interval_seconds: string; state: string }>(
      `SELECT EXTRACT(EPOCH FROM regeneration_interval)::text AS interval_seconds,
              CASE WHEN ready_at <= clock_timestamp() THEN 'ready' ELSE 'depleted' END AS state
       FROM repeatable_resource_nodes WHERE id = $1`,
      [nodeId]
    );
    expect(Number(persisted.rows[0]?.interval_seconds) * 1_000)
      .toBe(STONE_MINE_REGENERATION_MS);
    expect(persisted.rows[0]?.state).toBe("depleted");

    for (let visit = 0; visit < 50; visit += 1) {
      expect((await first.listInVision(regionCode, vision)).find(
        (node) => node.id === nodeId
      )).toMatchObject({
        id: nodeId,
        state: "depleted",
        authorityRevision: 2
      });
    }
    for (let reconnect = 0; reconnect < 20; reconnect += 1) {
      const reconnected = new RepeatableResourceService(firstPool);
      expect((await reconnected.listInVision(regionCode, vision)).find(
        (node) => node.id === nodeId
      )).toMatchObject({
        id: nodeId,
        state: "depleted",
        authorityRevision: 2
      });
    }
    expect((await second.listInVision(regionCode, vision, playerId)).find(
      (node) => node.id === nodeId
    )).toMatchObject({
      id: nodeId,
      state: "depleted",
      readyAt: firstHarvest.node.readyAt,
      timerVisibility: "visible"
    });
    expect((await second.listInVision(regionCode, vision)).find(
      (node) => node.id === nodeId
    )).toMatchObject({
      state: "depleted",
      readyAt: null,
      timerVisibility: "redacted"
    });

    await firstPool.query(
      `WITH boundary AS MATERIALIZED (
         SELECT clock_timestamp() AS occurred_at
       )
       UPDATE population_entity_state_v2 AS state
       SET killed_or_harvested_at=
             boundary.occurred_at - projection.regeneration_interval,
           respawn_at=boundary.occurred_at,
           updated_at=boundary.occurred_at
       FROM repeatable_resource_nodes AS projection, boundary
       WHERE state.entity_id=$1::uuid
         AND projection.population_v2_entity_id=state.entity_id
         AND state.state='harvested'`,
      [nodeId]
    );
    expect((await first.listInVision(regionCode, vision)).find(
      (node) => node.id === nodeId
    )).toMatchObject({
      id: nodeId,
      state: "ready",
      authorityRevision: 5
    });

    const restarted = new RepeatableResourceService(secondPool);
    expect((await restarted.listInVision(regionCode, vision)).find((node) => node.id === nodeId))
      .toMatchObject({ lat: position.lat, lon: position.lon, state: "ready" });

    await resetNode(firstPool, nodeId);
    expect((await restarted.listInVision(regionCode, vision)).find((node) => node.id === nodeId)?.state)
      .toBe("ready");

    const raceSession = await first.startMining(player, nodeId, vision);
    await makeSessionCompletable(firstPool, raceSession.session.sessionId);
    const attempts = await Promise.all([
      first.completeMining(player, raceSession.session.sessionId, vision),
      second.completeMining(player, raceSession.session.sessionId, vision)
    ]);
    expect(attempts.filter((attempt) => !attempt.replayed)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.replayed)).toHaveLength(1);
    expect(attempts.every((attempt) =>
      attempt.inventory.totals.stone === STONE_MINE_YIELD_QUANTITY * 2
    )).toBe(true);
    const replay = await restarted.completeMining(player, raceSession.session.sessionId, vision);
    expect(replay.replayed).toBe(true);
    expect(replay.inventory.totals.stone).toBe(STONE_MINE_YIELD_QUANTITY * 2);

    let finalInventory = replay.inventory;
    for (let cycle = 3; cycle <= 5; cycle += 1) {
      await resetNode(firstPool, nodeId);
      const session = await first.startMining(player, nodeId, vision);
      await makeSessionCompletable(firstPool, session.session.sessionId);
      finalInventory = (await first.completeMining(player, session.session.sessionId, vision)).inventory;
      expect(finalInventory.totals.stone).toBe(STONE_MINE_YIELD_QUANTITY * cycle);
    }
    expect(finalInventory.totals.stone).toBe(STONE_MINE_YIELD_QUANTITY * 5);
  });

  it("promotes a due mine under lock before starting without a prior snapshot", async () => {
    await resetNode(firstPool, nodeId);
    const harvestedRevision = await depleteNodeAtDatabaseBoundary(
      firstPool,
      nodeId,
      0
    );

    const started = await first.startMining(player, nodeId, vision);
    expect(started.session.nodeId).toBe(nodeId);
    const authority = await permanentResourceAuthority(firstPool, nodeId);
    expect(authority).toEqual({
      canonical_state: "ready",
      canonical_revision: String(harvestedRevision + 1),
      projection_revision: String(harvestedRevision + 1),
      harvest_revision: String(harvestedRevision + 1),
      ready_at: null
    });
    await first.cancelMining(playerId, started.session.sessionId);
  });

  it("uses a depleted [harvest, respawn) interval with an inclusive database deadline", async () => {
    await resetNode(firstPool, nodeId);
    const beforeDeadlineRevision = await depleteNodeAtDatabaseBoundary(
      firstPool,
      nodeId,
      5_000
    );
    expect((await first.listInVision(regionCode, vision)).find(
      (node) => node.id === nodeId
    )).toMatchObject({
      state: "depleted",
      authorityRevision: beforeDeadlineRevision * 2
    });

    await firstPool.query(
      `WITH boundary AS MATERIALIZED (
         SELECT clock_timestamp() AS occurred_at
       )
       UPDATE population_entity_state_v2
       SET killed_or_harvested_at=
             boundary.occurred_at - interval '5 hours 50 minutes',
           respawn_at=boundary.occurred_at,
           updated_at=boundary.occurred_at
       FROM boundary
       WHERE entity_id=$1::uuid`,
      [nodeId]
    );
    expect((await first.listInVision(regionCode, vision)).find(
      (node) => node.id === nodeId
    )).toMatchObject({
      state: "ready",
      authorityRevision: (beforeDeadlineRevision + 1) * 2 + 1
    });

    await resetNode(firstPool, nodeId);
    const afterDeadlineRevision = await depleteNodeAtDatabaseBoundary(
      firstPool,
      nodeId,
      -1
    );
    expect((await first.listInVision(regionCode, vision)).find(
      (node) => node.id === nodeId
    )).toMatchObject({
      state: "ready",
      authorityRevision: (afterDeadlineRevision + 1) * 2 + 1
    });
  });

  it("converges concurrent snapshots and mining to one ready revision", async () => {
    await resetNode(firstPool, nodeId);
    const harvestedRevision = await depleteNodeAtDatabaseBoundary(
      firstPool,
      nodeId,
      0
    );

    const results = await Promise.allSettled([
      first.listInVision(regionCode, vision, playerId),
      second.listInVision(regionCode, vision, playerId),
      first.startMining(player, nodeId, vision),
      second.startMining(player, nodeId, vision)
    ]);
    expect(results.slice(0, 2).every(
      (result) => result.status === "fulfilled"
    )).toBe(true);
    expect(results.slice(2).filter(
      (result) => result.status === "fulfilled"
    ).length).toBeGreaterThanOrEqual(1);
    expect(await permanentResourceAuthority(firstPool, nodeId)).toEqual({
      canonical_state: "ready",
      canonical_revision: String(harvestedRevision + 1),
      projection_revision: String(harvestedRevision + 1),
      harvest_revision: String(harvestedRevision + 1),
      ready_at: null
    });
    const active = await firstPool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM repeatable_resource_sessions
       WHERE node_id=$1::uuid AND status='active'`,
      [nodeId]
    );
    expect(active.rows[0]?.count).toBe(1);
    await first.cancelActiveForPlayer(playerId);
  });

  it("persists shortened and instant durations while preserving completion idempotency", async () => {
    await firstMasteries.getOrCreate(playerId);
    await resetNode(firstPool, nodeId);
    await setMinerRank(firstPool, playerId, 0, 0);
    const rankZero = new RepeatableResourceService(
      firstPool, undefined, firstMasteries, () => 0.99
    );
    const normal = await rankZero.startMining(player, nodeId, vision);
    await expect(sessionTiming(firstPool, normal.session.sessionId)).resolves.toEqual({
      storedMs: 10_000,
      timestampMs: 10_000
    });
    await rankZero.cancelMining(playerId, normal.session.sessionId);

    await resetNode(firstPool, nodeId);
    const ringShortened = await rankZero.startMining(
      player,
      nodeId,
      vision,
      undefined,
      1,
      0.8
    );
    await expect(sessionTiming(firstPool, ringShortened.session.sessionId)).resolves.toEqual({
      storedMs: 8_000,
      timestampMs: 8_000
    });
    await rankZero.cancelMining(playerId, ringShortened.session.sessionId);

    await resetNode(firstPool, nodeId);
    await setMinerRank(firstPool, playerId, 2, 7_218);
    const shortenedFirst = new RepeatableResourceService(
      firstPool, undefined, firstMasteries, () => 0.99
    );
    const shortenedSecond = new RepeatableResourceService(
      secondPool, undefined, secondMasteries, () => 0.99
    );
    const shortened = await shortenedFirst.startMining(player, nodeId, vision);
    await expect(sessionTiming(firstPool, shortened.session.sessionId)).resolves.toEqual({
      storedMs: 9_700,
      timestampMs: 9_700
    });
    await expect(shortenedSecond.completeMining(player, shortened.session.sessionId, vision))
      .rejects.toMatchObject({ code: "HARVEST_TOO_EARLY" });
    const restarted = new RepeatableResourceService(
      secondPool, undefined, secondMasteries, () => 0.99
    );
    await expect(restarted.activeSessionForPlayer(playerId)).resolves.toEqual(shortened.session);
    const stoneBefore = await stoneQuantity(firstPool, playerId);
    await makeSessionCompletable(firstPool, shortened.session.sessionId);
    const attempts = await Promise.all([
      shortenedFirst.completeMining(player, shortened.session.sessionId, vision),
      shortenedSecond.completeMining(player, shortened.session.sessionId, vision)
    ]);
    expect(attempts.filter((attempt) => !attempt.replayed)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.replayed)).toHaveLength(1);
    expect(attempts.every((attempt) => attempt.inventory.totals.stone === stoneBefore + 1)).toBe(true);
    await expect(restarted.completeMining(player, shortened.session.sessionId, vision))
      .resolves.toMatchObject({ replayed: true });
    const masteryOperations = await firstPool.query<{ count: string; requested_xp: number }>(
      `SELECT count(*)::text AS count, max(requested_xp)::int AS requested_xp
       FROM mastery_progression_operations
       WHERE operation_key=$1`,
      [`profession-xp:${shortened.session.operationKey}:miner`]
    );
    expect(Number(masteryOperations.rows[0]?.count)).toBe(1);
    expect(masteryOperations.rows[0]?.requested_xp).toBe(25);

    await resetNode(firstPool, nodeId);
    await setMinerRank(firstPool, playerId, 6, 48_056);
    const higherRank = new RepeatableResourceService(
      firstPool, undefined, firstMasteries, () => 0.99
    );
    const faster = await higherRank.startMining(player, nodeId, vision);
    await expect(sessionTiming(firstPool, faster.session.sessionId)).resolves.toEqual({
      storedMs: 9_400,
      timestampMs: 9_400
    });
    await higherRank.cancelMining(playerId, faster.session.sessionId);

    await resetNode(firstPool, nodeId);
    await setMinerRank(firstPool, playerId, 8, 100_000);
    const instantService = new RepeatableResourceService(
      firstPool, undefined, firstMasteries, () => 0
    );
    const instant = await instantService.startMining(player, nodeId, vision);
    await expect(sessionTiming(firstPool, instant.session.sessionId)).resolves.toEqual({
      storedMs: 0,
      timestampMs: 0
    });
    const instantResult = await instantService.completeMining(player, instant.session.sessionId, vision);
    await expect(instantService.completeMining(player, instant.session.sessionId, vision))
      .resolves.toMatchObject({
        replayed: true,
        inventory: { totals: { stone: instantResult.inventory.totals.stone } }
      });
  });

  it("rejects a projection stale before start, repairs it, and allows an authoritative retry", async () => {
    await resetNode(firstPool, nodeId);
    const before = await firstPool.query<{
      projection_revision: string;
      canonical_revision: string;
    }>(
      `SELECT projection.population_v2_state_revision::text AS projection_revision,
              canonical.state_revision::text AS canonical_revision
       FROM repeatable_resource_nodes AS projection
       JOIN population_entity_state_v2 AS canonical
         ON canonical.entity_id=projection.population_v2_entity_id
       WHERE projection.id=$1::uuid`,
      [nodeId]
    );
    const staleRevision = Number(before.rows[0]!.projection_revision);
    await firstPool.query(
      `ALTER TABLE population_entity_state_v2
       DISABLE TRIGGER
         population_entity_state_v2_synchronize_permanent_resources`
    );
    try {
      await firstPool.query(
        `UPDATE population_entity_state_v2
         SET state_revision=state_revision + 1,
             state='ready',
             state_actor_player_id=NULL,
             killed_or_harvested_at=NULL,
             respawn_at=NULL
         WHERE entity_id=$1::uuid`,
        [nodeId]
      );
    } finally {
      await firstPool.query(
        `ALTER TABLE population_entity_state_v2
         ENABLE TRIGGER
           population_entity_state_v2_synchronize_permanent_resources`
      );
    }

    const legacySessionId = await insertLegacyActiveMiningSession(
      firstPool,
      playerId,
      nodeId,
      staleRevision
    );
    await expect(first.completeMining(player, legacySessionId, vision))
      .rejects.toMatchObject({
        code: "HARVEST_NODE_CHANGED",
        details: {
          authorityFailureReason: "projection-harvest-revision-changed",
          projectionStateRevision: staleRevision + 1,
          canonicalStateRevision: staleRevision + 1
        }
      } satisfies Partial<RepeatableResourceError>);
    await first.terminateActiveSessionAfterTerminalFailure(
      playerId,
      legacySessionId,
      "HARVEST_NODE_CHANGED"
    );

    await expect(first.startMining(
      player,
      nodeId,
      vision,
      staleRevision * 2 + 1
    )).rejects.toMatchObject({
      code: "HARVEST_NODE_CHANGED",
      details: {
        authorityFailureReason: "canonical-state-revision-mismatch",
        stateRevision: (staleRevision + 1) * 2 + 1
      }
    } satisfies Partial<RepeatableResourceError>);
    await expect(first.activeSessionForPlayer(playerId)).resolves.toBeNull();
    const repaired = await firstPool.query<{
      projection_revision: string;
      canonical_revision: string;
    }>(
      `SELECT projection.population_v2_state_revision::text AS projection_revision,
              canonical.state_revision::text AS canonical_revision
       FROM repeatable_resource_nodes AS projection
       JOIN population_entity_state_v2 AS canonical
         ON canonical.entity_id=projection.population_v2_entity_id
       WHERE projection.id=$1::uuid`,
      [nodeId]
    );
    expect(repaired.rows[0]).toEqual({
      projection_revision: String(staleRevision + 1),
      canonical_revision: String(staleRevision + 1)
    });

    const stoneBefore = await stoneQuantity(firstPool, playerId);
    const retried = await first.startMining(
      player,
      nodeId,
      vision,
      (staleRevision + 1) * 2 + 1
    );
    await makeSessionCompletable(firstPool, retried.session.sessionId);
    const completed = await first.completeMining(
      player,
      retried.session.sessionId,
      vision
    );
    expect(completed.inventory.totals.stone).toBe(stoneBefore + 1);
  });

  it("repairs safe stale presentations and rejects suppressed, plan-stale, and orphaned projections", async () => {
    await resetNode(firstPool, nodeId);
    await firstPool.query(
      `ALTER TABLE population_entity_state_v2
       DISABLE TRIGGER
         population_entity_state_v2_synchronize_permanent_resources`
    );
    try {
      await firstPool.query(
        `WITH boundary AS MATERIALIZED (
           SELECT clock_timestamp() AS occurred_at
         )
         UPDATE population_entity_state_v2 AS canonical
         SET state='harvested',
             state_revision=canonical.state_revision + 1,
             killed_or_harvested_at=boundary.occurred_at,
             respawn_at=boundary.occurred_at
               + interval '5 hours 50 minutes',
             updated_at=boundary.occurred_at
         FROM boundary
         WHERE canonical.entity_id=$1::uuid`,
        [nodeId]
      );
    } finally {
      await firstPool.query(
        `ALTER TABLE population_entity_state_v2
         ENABLE TRIGGER
           population_entity_state_v2_synchronize_permanent_resources`
      );
    }

    const projectionReadyCanonicalHarvested =
      await first.listInVision(regionCode, vision);
    expect(projectionReadyCanonicalHarvested.find(
      (node) => node.id === nodeId
    )).toMatchObject({ state: "depleted" });
    const repairedHarvested = await permanentResourceAuthority(
      firstPool,
      nodeId
    );
    expect(repairedHarvested.projection_revision)
      .toBe(repairedHarvested.canonical_revision);
    expect(repairedHarvested.harvest_revision)
      .toBe(repairedHarvested.canonical_revision);

    await firstPool.query(
      `ALTER TABLE population_entity_state_v2
       DISABLE TRIGGER
         population_entity_state_v2_synchronize_permanent_resources`
    );
    try {
      await firstPool.query(
        `UPDATE population_entity_state_v2
         SET state='ready', state_revision=state_revision + 1,
             state_actor_player_id=NULL,
             killed_or_harvested_at=NULL, respawn_at=NULL
         WHERE entity_id=$1::uuid`,
        [nodeId]
      );
    } finally {
      await firstPool.query(
        `ALTER TABLE population_entity_state_v2
         ENABLE TRIGGER
           population_entity_state_v2_synchronize_permanent_resources`
      );
    }
    expect((await first.listInVision(regionCode, vision)).find(
      (node) => node.id === nodeId
    )).toMatchObject({ state: "ready" });
    const repairedReady = await permanentResourceAuthority(firstPool, nodeId);
    expect(repairedReady).toMatchObject({
      canonical_state: "ready",
      projection_revision: repairedReady.canonical_revision,
      harvest_revision: repairedReady.canonical_revision,
      ready_at: null
    });

    await firstPool.query(
      `UPDATE repeatable_resource_nodes
       SET population_flag_suppressed=true
       WHERE id=$1::uuid`,
      [nodeId]
    );
    expect((await first.listInVision(regionCode, vision)).some(
      (node) => node.id === nodeId
    )).toBe(false);
    await expect(first.startMining(player, nodeId, vision))
      .rejects.toMatchObject({
        code: "HARVEST_NODE_NOT_FOUND",
        details: { authorityFailureReason: "projection-suppressed" }
      } satisfies Partial<RepeatableResourceError>);
    await firstPool.query(
      `UPDATE repeatable_resource_nodes
       SET population_flag_suppressed=false,
           population_cutover_revision=population_cutover_revision + 1
       WHERE id=$1::uuid`,
      [nodeId]
    );
    expect((await first.listInVision(regionCode, vision)).some(
      (node) => node.id === nodeId
    )).toBe(false);
    await expect(first.startMining(player, nodeId, vision))
      .rejects.toMatchObject({
        code: "HARVEST_NODE_CHANGED",
        details: {
          authorityFailureReason: "projection-plan-cutover-mismatch"
        }
      } satisfies Partial<RepeatableResourceError>);
    await firstPool.query(
      `UPDATE repeatable_resource_nodes
       SET population_cutover_revision=1
       WHERE id=$1::uuid`,
      [nodeId]
    );

    const orphanId = randomUUID();
    await firstPool.query(
      `INSERT INTO population_spawn_slots_v2 (
         plan_id, slot_id, entity_id, candidate_id, entity_kind,
         archetype, latitude, longitude, geom,
         anchor_latitude, anchor_longitude, anchor_geom,
         environment_snapshot, suppression_class
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4,'stone','stone_mine',$5,$6,
         ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,$5,$6,
         ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,
         '{}'::jsonb,'none'
       )`,
      [
        planId,
        randomUUID(),
        orphanId,
        `orphaned-test-${orphanId}`,
        position.lat,
        position.lon
      ]
    );
    await firstPool.query(
      `INSERT INTO repeatable_resource_nodes (
         id, node_type, region_code, lat, lon, geom,
         yield_item_id, yield_quantity, regeneration_interval,
         authored_source, placement_bucket_key, placement_version,
         population_v2_entity_id, physical_population_zone_v2_id,
         population_v2_plan_id, population_v2_state_revision,
         population_cutover_revision
       ) VALUES (
         $1::uuid,'stone_mine',$2,$3,$4,
         ST_SetSRID(ST_MakePoint($4,$3),4326),
         'stone',1,interval '5 hours 50 minutes',
         'population-v2','orphaned-test:' || $1::text,
         'repeatable-orphan-test',$1::uuid,$5,$6::uuid,0,1
       )`,
      [orphanId, regionCode, position.lat, position.lon, zoneId, planId]
    );
    expect((await first.listInVision(regionCode, vision)).some(
      (node) => node.id === orphanId
    )).toBe(false);
  });

  it("completes a full-inventory mine and drops its reward on the ground exactly once", async () => {
    const fullPlayerId = `repeatable-full-${randomUUID()}`;
    const fullPlayer = { ...player, playerId: fullPlayerId };
    await firstPool.query(
      `INSERT INTO players (
         id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES ($1,$1,$2,$3,$4,$3,$4,1250,true,
                 ST_SetSRID(ST_MakePoint($4,$3),4326))`,
      [fullPlayerId, regionCode, position.lat, position.lon]
    );
    try {
      await firstPool.query(
        `INSERT INTO player_inventory_capacities (player_id)
         VALUES ($1)`,
        [fullPlayerId]
      );
      await firstPool.query(
        `INSERT INTO player_inventory_slots (
           stack_id, player_id, slot_index, resource_type,
           variant, quantity, manual_split
         )
         SELECT gen_random_uuid(), $1, slot_index, 'wood',
                'default', 1, true
         FROM generate_series(0,39) AS slot_index`,
        [fullPlayerId]
      );
      await resetNode(firstPool, nodeId);
      const started = await first.startMining(
        fullPlayer,
        nodeId,
        vision,
        (await nodeAuthorityRevision(firstPool, nodeId))
      );
      await makeSessionCompletable(firstPool, started.session.sessionId);

      const completed = await first.completeMining(
        fullPlayer,
        started.session.sessionId,
        vision
      );
      expect(completed.inventory.totals.stone).toBe(0);
      expect(completed.droppedItems).toEqual([
        expect.objectContaining({
          droppedBy: fullPlayerId,
          itemId: "stone",
          quantity: STONE_MINE_YIELD_QUANTITY,
          lat: position.lat,
          lon: position.lon
        })
      ]);
      await expect(firstPool.query(
        `SELECT state, state_revision::text
         FROM population_entity_state_v2
         WHERE entity_id=$1::uuid`,
        [nodeId]
      )).resolves.toMatchObject({
        rows: [expect.objectContaining({ state: "harvested" })]
      });
      await expect(firstPool.query(
        `SELECT count(*)::integer AS count
         FROM inventory_operations
         WHERE operation_key=$1`,
        [started.session.operationKey]
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      expect(await stoneQuantity(firstPool, fullPlayerId)).toBe(0);
      const replayed = await first.completeMining(
        fullPlayer,
        started.session.sessionId,
        vision
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.droppedItems.map(({ dropId }) => dropId))
        .toEqual(completed.droppedItems.map(({ dropId }) => dropId));
    } finally {
      await firstPool.query(
        "DELETE FROM repeatable_resource_sessions WHERE player_id=$1",
        [fullPlayerId]
      );
      await firstPool.query(
        "DELETE FROM repeatable_resource_harvests WHERE player_id=$1",
        [fullPlayerId]
      );
      await firstPool.query(
        "DELETE FROM player_discovered_mines WHERE player_id=$1",
        [fullPlayerId]
      );
      await firstPool.query(
        "DELETE FROM player_inventory_slots WHERE player_id=$1",
        [fullPlayerId]
      );
      // Inventory operations and system ground drops are immutable audit records.
      // This player belongs to the disposable integration database and is retained
      // so cleanup does not violate those intentional references.
    }
  });

  it("releases every terminal completion rejection without granting stone", async () => {
    const startingStone = await stoneQuantity(firstPool, playerId);
    const terminalCases = [
      {
        name: "node revision changed",
        expectedCode: "HARVEST_NODE_CHANGED",
        mutate: async () => resetNode(firstPool, nodeId),
        completionPlayer: player,
        completionVision: vision
      },
      {
        name: "mine depleted",
        expectedCode: "HARVEST_NODE_DEPLETED",
        mutate: async () => {
          await firstPool.query(
            `UPDATE population_entity_state_v2 AS state
             SET state='harvested',
                 state_revision=state_revision + 1,
                 state_actor_player_id=NULL,
                 killed_or_harvested_at=clock_timestamp(),
                 respawn_at=clock_timestamp() + projection.regeneration_interval,
                 updated_at=clock_timestamp()
             FROM repeatable_resource_nodes AS projection
             WHERE state.entity_id=$1::uuid
               AND projection.population_v2_entity_id=state.entity_id`,
            [nodeId]
          );
        },
        completionPlayer: player,
        completionVision: vision
      },
      {
        name: "mine suppressed",
        expectedCode: "HARVEST_NODE_NOT_FOUND",
        mutate: async () => {
          await firstPool.query(
            `UPDATE repeatable_resource_nodes
             SET population_cutover_suppressed=true
             WHERE id=$1::uuid`,
            [nodeId]
          );
        },
        completionPlayer: player,
        completionVision: vision
      },
      {
        name: "player moved out of range",
        expectedCode: "HARVEST_NODE_OUT_OF_RANGE",
        mutate: async () => undefined,
        completionPlayer: {
          ...player,
          position: { lat: position.lat + 0.01, lon: position.lon }
        },
        completionVision: vision
      },
      {
        name: "Resource Vision changed",
        expectedCode: "HARVEST_RESOURCE_VISION_REQUIRED",
        mutate: async () => undefined,
        completionPlayer: player,
        completionVision: null
      }
    ] as const;

    for (const terminalCase of terminalCases) {
      await firstPool.query(
        `UPDATE repeatable_resource_nodes
         SET population_cutover_suppressed=false
         WHERE id=$1::uuid`,
        [nodeId]
      );
      await resetNode(firstPool, nodeId);
      const started = await first.startMining(player, nodeId, vision);
      await makeSessionCompletable(firstPool, started.session.sessionId);
      await terminalCase.mutate();
      let rejectedCode = "";
      try {
        await first.completeMining(
          terminalCase.completionPlayer,
          started.session.sessionId,
          terminalCase.completionVision
        );
      } catch (error) {
        rejectedCode = (error as RepeatableResourceError).code;
      }
      expect(rejectedCode).toBe(terminalCase.expectedCode);
      const cleanup =
        await first.terminateActiveSessionAfterTerminalFailure(
          playerId,
          started.session.sessionId,
          rejectedCode
        );
      expect(cleanup).toMatchObject({
        statusBefore: "active",
        statusAfter: "cancelled",
        outcome: "cancelled"
      });
      await expect(first.terminateActiveSessionAfterTerminalFailure(
        playerId,
        started.session.sessionId,
        rejectedCode
      )).resolves.toMatchObject({
        statusBefore: "cancelled",
        statusAfter: "cancelled",
        outcome: "already-terminal"
      });
      await expect(first.activeSessionForPlayer(playerId)).resolves.toBeNull();
      expect(await stoneQuantity(firstPool, playerId)).toBe(startingStone);

      await firstPool.query(
        `UPDATE repeatable_resource_nodes
         SET population_cutover_suppressed=false
         WHERE id=$1::uuid`,
        [nodeId]
      );
      await resetNode(firstPool, nodeId);
      const next = await first.startMining(player, nodeId, vision);
      await expect(first.cancelMining(playerId, next.session.sessionId))
        .resolves.toMatchObject({ replayed: false });
    }
  });

  it("rolls an inventory failure back and preserves intentional retry recovery", async () => {
    await resetNode(firstPool, nodeId);
    const beforeStone = await stoneQuantity(firstPool, playerId);
    const started = await first.startMining(player, nodeId, vision);
    await makeSessionCompletable(firstPool, started.session.sessionId);
    const actualInventory = new InventoryService(firstPool);
    const failing = new RepeatableResourceService(firstPool, {
      snapshotInTransaction: (
        queryable: Pick<pg.PoolClient, "query">,
        inventoryPlayerId: string
      ) => actualInventory.snapshotInTransaction(
        queryable,
        inventoryPlayerId
      ),
      grantItemsForOperationInTransaction: async () => {
        throw new Error("injected inventory failure");
      }
    } as never);

    await expect(failing.completeMining(
      player,
      started.session.sessionId,
      vision
    )).rejects.toThrow("injected inventory failure");
    await expect(first.activeSessionForPlayer(playerId))
      .resolves.toMatchObject({
        sessionId: started.session.sessionId,
        status: "active"
      });
    expect(await stoneQuantity(firstPool, playerId)).toBe(beforeStone);
    expect((await first.listInVision(regionCode, vision)).find(
      (node) => node.id === nodeId
    )).toMatchObject({ state: "ready" });

    const recovered = await first.completeMining(
      player,
      started.session.sessionId,
      vision
    );
    expect(recovered.replayed).toBe(false);
    expect(recovered.inventory.totals.stone).toBe(beforeStone + 1);
    await expect(first.terminateActiveSessionAfterTerminalFailure(
      playerId,
      started.session.sessionId,
      "HARVEST_NODE_CHANGED"
    )).resolves.toMatchObject({
      statusBefore: "completed",
      statusAfter: "completed",
      outcome: "completed"
    });
  });

  it("rejects invalid authoritative duration rows", async () => {
    await expect(insertSessionWithTiming(firstPool, {
      playerId,
      nodeId,
      effectiveDurationMs: -1,
      timestampDurationMs: -1
    })).rejects.toMatchObject({
      constraint: "repeatable_resource_sessions_effective_duration_valid"
    });
    await expect(insertSessionWithTiming(firstPool, {
      playerId,
      nodeId,
      effectiveDurationMs: 10_001,
      timestampDurationMs: 10_001
    })).rejects.toMatchObject({
      constraint: "repeatable_resource_sessions_effective_duration_valid"
    });
    await expect(insertSessionWithTiming(firstPool, {
      playerId,
      nodeId,
      effectiveDurationMs: 9_700,
      timestampDurationMs: 10_000
    })).rejects.toMatchObject({
      constraint: "repeatable_resource_sessions_completion_time_valid"
    });
  });

  it("uses one statement-local timestamp through 10,000 permanent-mine transitions", async () => {
    await resetNode(firstPool, nodeId);
    const client = await firstPool.connect();
    try {
      const before = await client.query<{ state_revision: string }>(
        `SELECT state_revision::text
         FROM population_entity_state_v2
         WHERE entity_id=$1::uuid`,
        [nodeId]
      );
      const startingRevision = Number(before.rows[0]?.state_revision);
      // This tests statement-local timestamps, not one atomic 20,000-update
      // transaction; bounded commits let PostgreSQL reclaim obsolete versions.
      for (let batch = 0; batch < 100; batch += 1) {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '90s'");
        await client.query(
          "SELECT set_config('ash_atlas.test_repeatable_node_id',$1,true)",
          [nodeId]
        );
        await client.query(
          `DO $stress$
         DECLARE
           target_entity_id uuid :=
             current_setting('ash_atlas.test_repeatable_node_id')::uuid;
           expected_revision bigint;
         BEGIN
           SELECT state_revision INTO STRICT expected_revision
           FROM population_entity_state_v2
           WHERE entity_id=target_entity_id;
           FOR transition_index IN 1..100 LOOP
             WITH event AS MATERIALIZED (
               SELECT clock_timestamp() AS occurred_at
             )
             UPDATE population_entity_state_v2 AS state
             SET state='harvested',
                 state_revision=state.state_revision + 1,
                 state_actor_player_id=NULL,
                 killed_or_harvested_at=event.occurred_at,
                 respawn_at=event.occurred_at + projection.regeneration_interval,
                 durable_runtime_state='{}'::jsonb,
                 updated_at=event.occurred_at
             FROM repeatable_resource_nodes AS projection, event
             WHERE state.entity_id=target_entity_id
               AND state.state='ready'
               AND state.state_revision=expected_revision
               AND projection.population_v2_entity_id=state.entity_id
               AND projection.population_v2_state_revision=expected_revision;
             IF NOT FOUND THEN
               RAISE EXCEPTION 'stress harvest transition did not advance';
             END IF;
             expected_revision := expected_revision + 1;

             UPDATE population_entity_state_v2 AS state
             SET state='ready',
                 state_revision=state.state_revision + 1,
                 state_actor_player_id=NULL,
                 killed_or_harvested_at=NULL,
                 respawn_at=NULL,
                 durable_runtime_state='{}'::jsonb,
                 updated_at=clock_timestamp()
             WHERE state.entity_id=target_entity_id
               AND state.state='harvested'
               AND state.state_revision=expected_revision;
             IF NOT FOUND THEN
               RAISE EXCEPTION 'stress ready transition did not advance';
             END IF;
             expected_revision := expected_revision + 1;
           END LOOP;
         END
         $stress$`
        );
        await client.query("COMMIT");
      }
      const after = await client.query<{
        state: string;
        state_revision: string;
        projection_revision: string;
        ready: boolean;
      }>(
        `SELECT state.state,
                state.state_revision::text,
                projection.population_v2_state_revision::text
                  AS projection_revision,
                projection.ready_at <= clock_timestamp() AS ready
         FROM population_entity_state_v2 AS state
         JOIN repeatable_resource_nodes AS projection
           ON projection.population_v2_entity_id=state.entity_id
         WHERE state.entity_id=$1::uuid`,
        [nodeId]
      );
      expect(after.rows[0]).toEqual({
        state: "ready",
        state_revision: String(startingRevision + 20_000),
        projection_revision: String(startingRevision + 20_000),
        ready: true
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }, 120_000);

  it("claims once, rejects replay intent changes, and settles one public mine toll", async () => {
    await resetNode(firstPool, nodeId);
    const inventory = new InventoryService(firstPool);
    const beforeClaim = await inventory.getInventorySnapshot(playerId);
    await inventory.grantItemsForOperation({
      operationKey: `mine-claim-cost:${nodeId}`,
      playerId,
      source: "repeatable_resource_test_seed",
      grants: [
        { itemId: "stone", variant: null, quantity: 3 },
        { itemId: "wood", variant: null, quantity: 10 }
      ]
    });
    const authorityRevision = (await first.listInVision(regionCode, vision, playerId))
      .find((node) => node.id === nodeId)!.authorityRevision;
    const claimRequestId = randomUUID();
    const claimed = await first.claimMine(player, nodeId, claimRequestId, authorityRevision);
    expect(claimed).toMatchObject({
      replayed: false,
      node: { id: nodeId, ownerPlayerId: playerId, accessMode: "private", canManage: true }
    });
    expect(claimed.inventory.totals.stone).toBe(beforeClaim.totals.stone);
    expect(claimed.inventory.totals.wood).toBe(beforeClaim.totals.wood);
    await expect(first.claimMine(player, nodeId, claimRequestId, authorityRevision))
      .resolves.toMatchObject({ replayed: true, node: { id: nodeId } });
    await expect(first.claimMine(player, randomUUID(), claimRequestId, authorityRevision))
      .rejects.toMatchObject({ code: "MINE_CLAIM_IDEMPOTENCY_CONFLICT" });
    await expect(firstPool.query(
      `SELECT count(*)::int AS count FROM inventory_operations
       WHERE operation_key=$1`,
      [`mine-claim:${claimRequestId}`]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const visitorId = `repeatable-visitor-${randomUUID()}`;
    const visitorAccountId = randomUUID();
    await createPlayerWithAccount(
      firstPool,
      visitorId,
      visitorAccountId,
      regionCode,
      position
    );
    const visitor = { playerId: visitorId, regionCode, position };
    const access = new HarvestAccessService(firstPool);
    await expect(access.updateAsset({
      ownerPlayerId: visitorId,
      assetId: nodeId,
      harvestType: "stone_mine",
      accessMode: "public",
      expectedRevision: "1",
      position
    })).rejects.toMatchObject({ code: "HARVEST_ACCESS_FORBIDDEN" });
    await expect(access.updateAsset({
      ownerPlayerId: playerId,
      assetId: nodeId,
      harvestType: "stone_mine",
      accessMode: "public",
      expectedRevision: "1",
      position: { lat: position.lat, lon: position.lon + 0.01 }
    })).rejects.toMatchObject({ code: "HARVEST_ACCESS_PROXIMITY_REQUIRED" });
    await access.updateAsset({
      ownerPlayerId: playerId,
      assetId: nodeId,
      harvestType: "stone_mine",
      accessMode: "public",
      expectedRevision: "1",
      position
    });
    await access.updateToll({
      ownerPlayerId: playerId,
      harvestType: "stone_mine",
      tollGold: "5",
      expectedRevision: "0"
    });
    const wallet = new WalletService();
    await fundWallet(
      firstPool,
      wallet,
      visitorId,
      visitorAccountId,
      20n,
      `public-mine-fund:${nodeId}`
    );
    const publicNode = (await first.listInVision(regionCode, vision, visitorId))
      .find((node) => node.id === nodeId)!;
    expect(publicNode).toMatchObject({
      ownerPlayerId: playerId,
      accessMode: "public",
      tollGold: "5",
      canManage: false
    });
    const session = await first.startMining(
      visitor,
      nodeId,
      vision,
      publicNode.authorityRevision
    );
    await makeSessionCompletable(firstPool, session.session.sessionId);
    const harvested = await first.completeMining(visitor, session.session.sessionId, vision);
    expect(harvested).toMatchObject({ replayed: false, tollGold: "5", walletGold: "15" });
    await expect(first.completeMining(visitor, session.session.sessionId, vision))
      .resolves.toMatchObject({ replayed: true, tollGold: "5", walletGold: "15" });
    await expect(wallet.snapshotInTransaction(firstPool, visitorId, visitorAccountId))
      .resolves.toMatchObject({ gold: "15", revision: "2" });
    await expect(wallet.snapshotInTransaction(firstPool, playerId, playerAccountId))
      .resolves.toMatchObject({ gold: "5", revision: "1" });
    await expect(firstPool.query(
      `SELECT count(*)::int AS count FROM harvest_toll_operations
       WHERE operation_key=$1`,
      [session.session.operationKey]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

});

async function makeSessionCompletable(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(
    `WITH stamp AS (SELECT clock_timestamp() AS now_at)
     UPDATE repeatable_resource_sessions
     SET started_at = stamp.now_at - (effective_duration_ms * interval '1 millisecond'),
         completes_at = stamp.now_at,
         expires_at = stamp.now_at + interval '5 minutes'
     FROM stamp
     WHERE id = $1`,
    [sessionId]
  );
}

async function sessionTiming(
  pool: pg.Pool,
  sessionId: string
): Promise<{ storedMs: number; timestampMs: number }> {
  const result = await pool.query<{ effective_duration_ms: string; timestamp_duration_ms: string }>(
    `SELECT effective_duration_ms,
            EXTRACT(EPOCH FROM (completes_at - started_at)) * 1000 AS timestamp_duration_ms
     FROM repeatable_resource_sessions
     WHERE id=$1`,
    [sessionId]
  );
  return {
    storedMs: Number(result.rows[0]?.effective_duration_ms),
    timestampMs: Number(result.rows[0]?.timestamp_duration_ms)
  };
}

async function setMinerRank(
  pool: pg.Pool,
  playerId: string,
  rank: number,
  xp: number
): Promise<void> {
  await pool.query(
    `UPDATE player_profession_progress
     SET rank=$2::smallint,
         xp=$3,
         completed_at=CASE WHEN $2::smallint=8 THEN now() ELSE NULL END
     WHERE player_id=$1 AND profession_id='miner'`,
    [playerId, rank, xp]
  );
}

async function depleteNodeAtDatabaseBoundary(
  pool: pg.Pool,
  nodeId: string,
  deadlineOffsetMs: number
): Promise<number> {
  const result = await pool.query<{ state_revision: string }>(
    `WITH boundary AS MATERIALIZED (
       SELECT clock_timestamp() AS occurred_at
     )
     UPDATE population_entity_state_v2 AS canonical
     SET state='harvested',
         state_revision=canonical.state_revision + 1,
         state_actor_player_id=NULL,
         killed_or_harvested_at=
           boundary.occurred_at
           + ($2::bigint * interval '1 millisecond')
           - projection.regeneration_interval,
         respawn_at=
           boundary.occurred_at
           + ($2::bigint * interval '1 millisecond'),
         durable_runtime_state='{}'::jsonb,
         updated_at=boundary.occurred_at
     FROM repeatable_resource_nodes AS projection, boundary
     WHERE canonical.entity_id=$1::uuid
       AND projection.population_v2_entity_id=canonical.entity_id
       AND canonical.state='ready'
     RETURNING canonical.state_revision::text`,
    [nodeId, deadlineOffsetMs]
  );
  return Number(result.rows[0]!.state_revision);
}

async function permanentResourceAuthority(
  pool: pg.Pool,
  nodeId: string
): Promise<{
  canonical_state: string;
  canonical_revision: string;
  projection_revision: string;
  harvest_revision: string;
  ready_at: Date | null;
}> {
  const result = await pool.query<{
    canonical_state: string;
    canonical_revision: string;
    projection_revision: string;
    harvest_revision: string;
    ready_at: Date | null;
  }>(
    `SELECT canonical.state AS canonical_state,
            canonical.state_revision::text AS canonical_revision,
            projection.population_v2_state_revision::text
              AS projection_revision,
            projection.harvest_revision::text AS harvest_revision,
            canonical.respawn_at AS ready_at
     FROM population_entity_state_v2 AS canonical
     JOIN repeatable_resource_nodes AS projection
       ON projection.population_v2_entity_id=canonical.entity_id
     WHERE canonical.entity_id=$1::uuid`,
    [nodeId]
  );
  return result.rows[0]!;
}

async function resetNode(pool: pg.Pool, nodeId: string): Promise<void> {
  const reset = await pool.query(
    `UPDATE population_entity_state_v2
     SET state='ready',
         state_revision=state_revision + 1,
         state_actor_player_id=NULL,
         killed_or_harvested_at=NULL,
         respawn_at=NULL,
         durable_runtime_state='{}'::jsonb,
         updated_at=clock_timestamp()
     WHERE entity_id=$1::uuid`,
    [nodeId]
  );
  if (reset.rowCount !== 1) {
    throw new Error("Population v2 repeatable test node disappeared");
  }
  await pool.query(
    `UPDATE repeatable_resource_nodes
     SET bonus_extraction_available=false,
         bonus_extraction_revision=NULL
     WHERE id=$1::uuid
       AND population_v2_entity_id=$1::uuid`,
    [nodeId]
  );
}

async function stoneQuantity(pool: pg.Pool, playerId: string): Promise<number> {
  const result = await pool.query<{ quantity: string }>(
    `SELECT quantity::text
     FROM player_inventory
     WHERE player_id=$1 AND resource_type='stone' AND variant='default'`,
    [playerId]
  );
  return Number(result.rows[0]?.quantity ?? 0);
}

async function nodeAuthorityRevision(
  pool: pg.Pool,
  nodeId: string
): Promise<number> {
  const result = await pool.query<{
    population_v2_state_revision: string;
    ready: boolean;
  }>(
    `SELECT population_v2_state_revision::text,
            ready_at <= clock_timestamp() AS ready
     FROM repeatable_resource_nodes
     WHERE id=$1::uuid`,
    [nodeId]
  );
  const row = result.rows[0]!;
  return Number(row.population_v2_state_revision) * 2 +
    (row.ready ? 1 : 0);
}

async function insertSessionWithTiming(
  pool: pg.Pool,
  input: {
    playerId: string;
    nodeId: string;
    effectiveDurationMs: number;
    timestampDurationMs: number;
  }
): Promise<void> {
  const sessionId = randomUUID();
  await pool.query(
    `WITH stamp AS (SELECT clock_timestamp() AS started_at)
     INSERT INTO repeatable_resource_sessions (
       id,player_id,node_id,resource_type,operation_key,starting_revision,
       status,effective_duration_ms,started_at,completes_at,expires_at,mastery_results
     )
     SELECT $1::uuid,$2,$3::uuid,'stone',$4,0,
            'expired',$5::bigint,started_at,
            started_at + ($6::bigint * interval '1 millisecond'),
            started_at + ($6::bigint * interval '1 millisecond') + interval '5 minutes',
            '{}'::jsonb
     FROM stamp`,
    [
      sessionId,
      input.playerId,
      input.nodeId,
      `invalid-duration:${sessionId}`,
      input.effectiveDurationMs,
      input.timestampDurationMs
    ]
  );
}

async function insertLegacyActiveMiningSession(
  pool: pg.Pool,
  playerId: string,
  nodeId: string,
  startingRevision: number
): Promise<string> {
  const sessionId = randomUUID();
  await pool.query(
    `WITH stamp AS (SELECT clock_timestamp() AS now)
     INSERT INTO repeatable_resource_sessions (
       id,player_id,node_id,resource_type,operation_key,starting_revision,
       status,effective_duration_ms,started_at,completes_at,expires_at,mastery_results
     )
     SELECT
       $1::uuid,$2,$3::uuid,'stone',$4,$5::bigint,
       'active',10000,now - interval '11 seconds',
       now - interval '1 second',
       now + interval '5 minutes','{}'::jsonb
     FROM stamp`,
    [
      sessionId,
      playerId,
      nodeId,
      `legacy-stale-start:${sessionId}`,
      startingRevision
    ]
  );
  return sessionId;
}

function validatedDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!database.startsWith("ash_atlas_stability")) {
    throw new Error("REPEATABLE_RESOURCE_TEST_DATABASE_URL must target an ash_atlas_stability database");
  }
  return value;
}

async function createPlayerWithAccount(
  pool: pg.Pool,
  playerId: string,
  accountId: string,
  regionCode: string,
  position: { lat: number; lon: number }
): Promise<void> {
  await pool.query(
    "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
    [accountId]
  );
  await pool.query(
    `INSERT INTO players (
       id,account_id,username,region_code,lat,lon,anchor_lat,anchor_lon,
       move_leash_radius_m,online,geom
     ) VALUES ($1,$2,$1,$3,$4,$5,$4,$5,1250,true,
               ST_SetSRID(ST_MakePoint($5,$4),4326))`,
    [playerId, accountId, regionCode, position.lat, position.lon]
  );
}

async function fundWallet(
  pool: pg.Pool,
  wallet: WalletService,
  playerId: string,
  accountId: string,
  amount: bigint,
  operationKey: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await wallet.creditForOperationInTransaction(client, {
      playerId,
      accountId,
      amount,
      operationKey,
      reason: "harvest_access_test_seed"
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function stoneMineSlotId(): string {
  let slotId = randomUUID();
  while (permanentMineKindForSlot(slotId) !== "stone") slotId = randomUUID();
  return slotId;
}
