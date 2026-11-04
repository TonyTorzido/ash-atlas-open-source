import { randomUUID } from "node:crypto";

import pg from "pg";
import {
  ELDER_FROND_SAP_REFILL_MS,
  isGivingTreeResinCapable,
  treeVarietyForStableId
} from "@ash-atlas/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import {
  CollectibleService,
  type CollectiblePlayer
} from "./collectibles.js";
import { HarvestSessionService } from "./harvestSessions.js";
import {
  populationZoneV2Halo,
  populationZoneV2IdForPoint,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import {
  generatePopulationZoneV2Plan,
  populationZoneV3ConservativeHabitat,
  type GeneratedPopulationZoneV2Plan
} from "./populationZonesV2Plan.js";
import {
  populationZoneV2PlanRequest,
  PostgresPopulationZonesV2Store
} from "./populationZonesV2Store.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Giving Berry tree harvest PostgreSQL authority", () => {
  const databaseName =
    `ash_atlas_stability_giving_berry_stale_tree_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  let admin: pg.Pool;
  let firstPool: pg.Pool;
  let secondPool: pg.Pool;

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(parsed.toString());
    firstPool = new DisposableTestPool({ connectionString: parsed.toString(), max: 4 });
    secondPool = new DisposableTestPool({ connectionString: parsed.toString(), max: 4 });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([firstPool?.end(), secondPool?.end()]);
    await admin?.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin?.end();
  });

  it("harvests berries once, replays without duplication, retains depletion, and taps Elder Ferns once per refill", async () => {
    const store = new PostgresPopulationZonesV2Store(firstPool);
    // Ready tree ids come from the generation, so prepare zones until the fixture holds a
    // berry tree, a plain tree and a Elder Fern.
    const zoneIds: PopulationZoneV2Id[] = [];
    let plan: GeneratedPopulationZoneV2Plan | null = null;
    for (const candidate of treePlans()) {
      plan = candidate.plan;
      const request = populationZoneV2PlanRequest({
        zoneId: candidate.zoneId,
        worldEnvironmentIdentityKey: plan.identity.worldEnvironmentIdentityKey,
        worldPipelineSha: plan.worldPipelineSha,
        environmentProfileVersion: plan.identity.environmentProfileVersion,
        regionCode: plan.habitat.regionCode
      });
      await store.ensurePlanForZone(request);
      const claim = await store.claimPlan(
        request.identity,
        randomUUID(),
        30_000
      );
      if (!claim) throw new Error("tree fixture could not claim its plan");
      await store.completePlan(claim, plan);
      await store.createCurrentGeneration({
        zoneId: candidate.zoneId,
        planId: plan.planId,
        now: new Date()
      });
      zoneIds.push(candidate.zoneId);
      const trees = (await store.loadReadyEntitiesForZones(zoneIds))
        .filter((entity) => entity.entityKind === "tree")
        .map((entity) => entity.entityId);
      if (
        trees.some(isGivingTreeResinCapable)
        && trees.some((id) => treeVarietyForStableId(id) === "elder_fern")
        && trees.some((id) => treeVarietyForStableId(id) !== "elder_fern" && !isGivingTreeResinCapable(id))
      ) break;
    }
    if (!plan) throw new Error("tree fixture found no tree plan");
    const tree = (await store.loadReadyEntitiesForZones(zoneIds))
      .find((entity) => entity.entityKind === "tree"
        && treeVarietyForStableId(entity.entityId) === "giving_tree"
        && isGivingTreeResinCapable(entity.entityId));
    if (!tree) throw new Error("tree fixture created no ready tree");
    const treePosition = { lat: tree.lat, lon: tree.lon };
    const readyProjection = await firstPool.query<{
      state: string;
      population_v2_state_revision: string;
    }>(
      `SELECT state, population_v2_state_revision
       FROM collectible_nodes
       WHERE population_v2_entity_id=$1::uuid`,
      [tree.entityId]
    );
    expect(readyProjection.rows[0]).toEqual({
      state: "available",
      population_v2_state_revision: String(tree.stateRevision)
    });
    await expect(firstPool.query(
      `SELECT COUNT(*)::int AS count
       FROM generated_world_mobs
       WHERE population_v2_entity_id=$1::uuid`,
      [tree.entityId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const players: CollectiblePlayer[] = [
      {
        playerId: randomUUID(),
        regionCode: plan.habitat.regionCode,
        position: treePosition
      },
      {
        playerId: randomUUID(),
        regionCode: plan.habitat.regionCode,
        position: treePosition
      }
    ];
    for (const [index, player] of players.entries()) {
      await firstPool.query(
        `INSERT INTO players (
           id, username, lat, lon, anchor_lat, anchor_lon, geom
         ) VALUES (
           $1,$2,$3,$4,$3,$4,
           ST_SetSRID(ST_MakePoint($4,$3),4326)
         )`,
        [
          player.playerId,
          `stale-tree-player-${index}-${player.playerId}`,
          player.position.lat,
          player.position.lon
        ]
      );
    }

    const firstCollectibles = collectibleService(firstPool);
    const secondCollectibles = collectibleService(secondPool);
    const first = new HarvestSessionService(firstPool, firstCollectibles);
    const second = new HarvestSessionService(secondPool, secondCollectibles);
    const vision = {
      flagId: randomUUID(),
      flagName: "Stale Tree",
      center: treePosition,
      movementLeashRadiusM: 900,
      paddingM: 50,
      radiusM: 950
    };

    expect(tree.berryAvailable).toBe(true);
    expect(tree.resinAvailable).toBe(false);
    const berryStart = await first.startHarvest(players[0]!, tree.entityId, vision, "resin", tree.stateRevision);
    expect(berryStart.session.resourceType).toBe("giving_berry");
    await firstPool.query(`UPDATE harvest_sessions
      SET started_at=clock_timestamp() - interval '4 seconds',
          completes_at=clock_timestamp() - interval '1 second',
          expires_at=clock_timestamp() + interval '9 seconds' WHERE id=$1::uuid`,
      [berryStart.session.sessionId]);
    const berries = await first.completeHarvest(players[0]!, berryStart.session.sessionId, vision);
    expect(berries.inventory.totals.giving_berry).toBe(1);
    expect(berries.inventory.totals.balsam_resin).toBe(0);
    expect(berries.node).toMatchObject({ berryAvailable: false, resinAvailable: false });
    expect(berries.nodeRemoved).toBe(false);
    const berryReplay = await first.completeHarvest(players[0]!, berryStart.session.sessionId, vision);
    expect(berryReplay.replayed).toBe(true);
    expect(berryReplay.inventory.totals.giving_berry).toBe(1);
    await expect(first.startHarvest(players[0]!, tree.entityId, vision, "resin", tree.stateRevision))
      .rejects.toMatchObject({ code: "HARVEST_RESIN_ALREADY_HARVESTED" });
    const readyTrees = await store.loadReadyEntitiesForZones(zoneIds);
    const plainTree = readyTrees.find((entity) => entity.entityKind === "tree"
      && treeVarietyForStableId(entity.entityId) !== "elder_fern"
      && !isGivingTreeResinCapable(entity.entityId));
    if (!plainTree) throw new Error("tree fixture created no plain tree");
    expect(plainTree).toMatchObject({ berryAvailable: false, resinAvailable: false });
    const plainPlayer = { ...players[0]!, position: { lat: plainTree.lat, lon: plainTree.lon } };
    await expect(first.startHarvest(plainPlayer, plainTree.entityId, { ...vision, center: plainPlayer.position }, "resin", plainTree.stateRevision))
      .rejects.toMatchObject({ code: "HARVEST_RESIN_UNAVAILABLE" });
    const afterGather = readyTrees.find((entity) => entity.entityId === tree.entityId);
    expect(afterGather).toMatchObject({ berryAvailable: false, resinAvailable: false });
    expect(afterGather?.sapReadyAt).toBeUndefined();

    // Elder Ferns: 1 Frond Sap per tap, refused until 5 hours after the tap, never berries.
    const fern = readyTrees.find((entity) => entity.entityKind === "tree"
      && treeVarietyForStableId(entity.entityId) === "elder_fern");
    if (!fern) throw new Error("tree fixture created no Elder Fern");
    expect(fern).toMatchObject({ berryAvailable: false, resinAvailable: false, sapReadyAt: null });
    const fernPlayer = { ...players[1]!, position: { lat: fern.lat, lon: fern.lon } };
    const fernVision = { ...vision, center: fernPlayer.position };
    const tapFern = async () => {
      const start = await first.startHarvest(fernPlayer, fern.entityId, fernVision, "resin", fern.stateRevision);
      expect(start.session.resourceType).toBe("balsam_resin");
      await firstPool.query(`UPDATE harvest_sessions
        SET started_at=clock_timestamp() - interval '4 seconds',
            completes_at=clock_timestamp() - interval '1 second',
            expires_at=clock_timestamp() + interval '9 seconds' WHERE id=$1::uuid`,
        [start.session.sessionId]);
      return { start, completed: await first.completeHarvest(fernPlayer, start.session.sessionId, fernVision) };
    };
    const tappedFrom = Date.now();
    const firstTap = await tapFern();
    expect(firstTap.completed.inventory.totals.balsam_resin).toBe(1);
    expect(firstTap.completed.inventory.totals.giving_berry).toBe(0);
    expect(firstTap.completed.inventory.totals.wood).toBe(0);
    expect(firstTap.completed.nodeRemoved).toBe(false);
    expect(firstTap.completed.node).toMatchObject({ berryAvailable: false, state: "available" });
    const readyAtMs = Date.parse(firstTap.completed.node!.sapReadyAt!);
    expect(readyAtMs).toBeGreaterThanOrEqual(tappedFrom + ELDER_FROND_SAP_REFILL_MS);
    expect(readyAtMs).toBeLessThanOrEqual(Date.now() + ELDER_FROND_SAP_REFILL_MS);
    const tapReplay = await first.completeHarvest(fernPlayer, firstTap.start.session.sessionId, fernVision);
    expect(tapReplay.replayed).toBe(true);
    expect(tapReplay.inventory.totals.balsam_resin).toBe(1);
    await expect(first.startHarvest(fernPlayer, fern.entityId, fernVision, "resin", fern.stateRevision))
      .rejects.toMatchObject({ code: "HARVEST_RESIN_ALREADY_HARVESTED" });
    const tappedFern = (await store.loadReadyEntitiesForZones(zoneIds))
      .find((entity) => entity.entityId === fern.entityId);
    expect(tappedFern?.sapReadyAt).toBe(firstTap.completed.node!.sapReadyAt);

    // The fern's collectible row loses its timer (re-created for the same fern): the Frond Sap
    // ledger still refuses an early tap cleanly instead of reusing the spent key.
    await firstPool.query(
      `UPDATE collectible_nodes SET sap_harvested_at=NULL WHERE population_v2_entity_id=$1::uuid`,
      [fern.entityId]
    );
    await expect(first.startHarvest(fernPlayer, fern.entityId, fernVision, "resin", fern.stateRevision))
      .rejects.toMatchObject({ code: "HARVEST_RESIN_ALREADY_HARVESTED" });
    // Time passes on both the ledger and the row timer.
    const age = async (ms: number) => {
      // The ledger is immutable to the game; the disposable test database skips that trigger.
      const client = await firstPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `UPDATE inventory_operations SET created_at=created_at - $2::interval
           WHERE source='elder-frond-sap-harvest' AND source_entity_id=$1`,
          [fern.entityId, `${ms} milliseconds`]
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      await firstPool.query(
        `UPDATE collectible_nodes SET sap_harvested_at=sap_harvested_at - $2::interval
         WHERE population_v2_entity_id=$1::uuid`,
        [fern.entityId, `${ms} milliseconds`]
      );
    };
    // A minute short of 5 hours: still refused. At 5 hours: refilled.
    await age(ELDER_FROND_SAP_REFILL_MS - 60_000);
    await expect(first.startHarvest(fernPlayer, fern.entityId, fernVision, "resin", fern.stateRevision))
      .rejects.toMatchObject({ code: "HARVEST_RESIN_ALREADY_HARVESTED" });
    await age(60_000);
    const secondTap = await tapFern();
    expect(secondTap.start.session.operationKey).not.toBe(firstTap.start.session.operationKey);
    expect(secondTap.completed.inventory.totals.balsam_resin).toBe(2);
    expect(secondTap.completed.inventory.totals.giving_berry).toBe(0);
    const secondReplay = await first.completeHarvest(fernPlayer, secondTap.start.session.sessionId, fernVision);
    expect(secondReplay.replayed).toBe(true);
    expect(secondReplay.inventory.totals.balsam_resin).toBe(2);

    // A row reset after a refill no longer collides with the first tap's key.
    await age(ELDER_FROND_SAP_REFILL_MS);
    await firstPool.query(
      `UPDATE collectible_nodes SET sap_harvested_at=NULL WHERE population_v2_entity_id=$1::uuid`,
      [fern.entityId]
    );
    const thirdTap = await tapFern();
    expect(thirdTap.start.session.operationKey).not.toBe(firstTap.start.session.operationKey);
    expect(thirdTap.completed.inventory.totals.balsam_resin).toBe(3);
  });
});

function collectibleService(pool: pg.Pool): CollectibleService {
  return new CollectibleService(
    pool,
    {} as WorldLookupClient,
    loadConfig({ NODE_ENV: "test" }),
    {
      info() {},
      warn() {}
    } as Pick<AppLogger, "info" | "warn">
  );
}

function* treePlans(): Generator<Readonly<{
  zoneId: PopulationZoneV2Id;
  plan: GeneratedPopulationZoneV2Plan;
}>> {
  const worldEnvironmentIdentityKey = "7".repeat(64);
  const worldPipelineSha = "e".repeat(40);
  const origin = populationZoneV2IdForPoint({
    lat: 35.0844,
    lon: -106.6504
  });
  for (const zoneId of populationZoneV2Halo(origin, 12)) {
    const plan = generatePopulationZoneV2Plan({
      zoneId,
      worldEnvironmentIdentityKey,
      worldPipelineSha,
      habitatForZone: (candidateZoneId) =>
        populationZoneV3ConservativeHabitat({
          zoneId: candidateZoneId,
          worldEnvironmentIdentityKey
        })
    });
    if (plan.slots.some((slot) => slot.entityKind === "tree")) {
      yield { zoneId, plan };
    }
  }
}

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = parsed.pathname.replace(/^\/+/u, "");
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !database.startsWith("ash_atlas_stability")
    || parsed.port === "35432"
  ) {
    throw new Error(
      "stale tree tests require the local disposable stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("unsafe disposable database name");
  }
  return `"${value}"`;
}
