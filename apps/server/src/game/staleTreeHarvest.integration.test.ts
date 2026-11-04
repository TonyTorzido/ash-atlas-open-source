import { randomUUID } from "node:crypto";

import pg from "pg";
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

describeDatabase("stale tree harvest PostgreSQL authority", () => {
  const databaseName =
    `ash_atlas_stability_stale_tree_${randomUUID()
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

  it("lets one of two players claim a tree and gives the loser current stale authority", async () => {
    const { zoneId, plan } = treePlan();
    const store = new PostgresPopulationZonesV2Store(firstPool);
    const request = populationZoneV2PlanRequest({
      zoneId,
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
      zoneId,
      planId: plan.planId,
      now: new Date()
    });
    const tree = (await store.loadReadyEntitiesForZones([zoneId]))
      .find((entity) => entity.entityKind === "tree");
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

    const starts = await Promise.allSettled([
      first.startHarvest(
        players[0]!,
        tree.entityId,
        vision,
        "primary",
        tree.stateRevision
      ),
      second.startHarvest(
        players[1]!,
        tree.entityId,
        vision,
        "primary",
        tree.stateRevision
      )
    ]);
    const winnerIndex = starts.findIndex(
      (result) => result.status === "fulfilled"
    );
    expect(starts.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(starts.filter((result) => result.status === "rejected"))
      .toHaveLength(1);
    const winner = starts[winnerIndex];
    if (winner?.status !== "fulfilled") {
      throw new Error("tree fixture has no winning harvest session");
    }
    await firstPool.query(
      `UPDATE harvest_sessions
       SET started_at=clock_timestamp() - interval '4 seconds',
           completes_at=clock_timestamp() - interval '1 second',
           expires_at=clock_timestamp() + interval '9 seconds'
       WHERE id=$1::uuid`,
      [winner.value.session.sessionId]
    );
    const winningPlayer = players[winnerIndex]!;
    const losingPlayer = players[winnerIndex === 0 ? 1 : 0]!;
    const winningService = winnerIndex === 0 ? first : second;
    const losingService = winnerIndex === 0 ? second : first;
    await firstPool.query(
      `INSERT INTO player_inventory_slots (
         stack_id, player_id, slot_index, resource_type,
         variant, quantity, manual_split
       )
       SELECT gen_random_uuid(), $1, slot_index, 'food',
              'default', 1, true
       FROM generate_series(0,38) AS slot_index`,
      [winningPlayer.playerId]
    );
    await firstPool.query(
      `INSERT INTO player_inventory_slots (
         stack_id, player_id, slot_index, resource_type,
         variant, quantity, manual_split
       ) VALUES (gen_random_uuid(),$1,39,'wood','default',498,false)`,
      [winningPlayer.playerId]
    );
    const completed = await winningService.completeHarvest(
      winningPlayer,
      winner.value.session.sessionId,
      vision
    );
    expect(completed.inventory.totals.wood).toBe(500);
    expect(completed.droppedItems).toEqual([
      expect.objectContaining({
        droppedBy: winningPlayer.playerId,
        itemId: "wood",
        quantity: 2,
        lat: treePosition.lat,
        lon: treePosition.lon
      })
    ]);
    expect(completed.populationTreeTransition).toMatchObject({
      entityId: tree.entityId,
      entityKind: "tree",
      stateRevision: tree.stateRevision + 1,
      position: treePosition,
      zoneId,
      generationId: tree.generationId
    });
    expect(
      (await firstCollectibles.inventoryForPlayer(losingPlayer.playerId))
        .totals.wood
    ).toBe(0);
    const authority = await firstPool.query<{
      state: string;
      state_revision: string;
      respawn_at: Date | null;
      projection_state: string;
      projection_revision: string;
    }>(
      `SELECT state.state, state.state_revision, state.respawn_at,
              tree.state AS projection_state,
              tree.population_v2_state_revision AS projection_revision
       FROM population_entity_state_v2 AS state
       JOIN collectible_nodes AS tree
         ON tree.population_v2_entity_id=state.entity_id
       WHERE state.entity_id=$1::uuid`,
      [tree.entityId]
    );
    expect(authority.rows[0]).toEqual({
      state: "harvested",
      state_revision: String(tree.stateRevision + 1),
      respawn_at: null,
      projection_state: "harvested",
      projection_revision: String(tree.stateRevision + 1)
    });
    expect((await store.loadReadyEntitiesForZones([zoneId]))
      .map((entity) => entity.entityId)).not.toContain(tree.entityId);

    const replayed = await winningService.completeHarvest(
      winningPlayer,
      winner.value.session.sessionId,
      vision
    );
    expect(replayed).toMatchObject({
      replayed: true,
      nodeId: tree.entityId,
      nodePosition: treePosition,
      populationTreeTransition: {
        entityId: tree.entityId,
        entityKind: "tree",
        stateRevision: tree.stateRevision + 1,
        position: treePosition,
        zoneId,
        generationId: tree.generationId
      }
    });
    expect(replayed.inventory.totals.wood).toBe(500);
    expect(replayed.droppedItems).toEqual([]);

    await expect(losingService.startHarvest(
      losingPlayer,
      tree.entityId,
      vision,
      "primary",
      tree.stateRevision
    )).rejects.toMatchObject({
      code: "HARVEST_NODE_ALREADY_HARVESTED",
      details: {
        nodeId: tree.entityId,
        stateRevision: tree.stateRevision + 1,
        reconciliation: "remove-node",
        populationTreeTransition: {
          entityId: tree.entityId,
          entityKind: "tree",
          stateRevision: tree.stateRevision + 1,
          position: treePosition,
          zoneId,
          generationId: tree.generationId
        }
      }
    });
    const grants = await firstPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM inventory_operations
       WHERE source_entity_id=$1`,
      [tree.entityId]
    );
    expect(grants.rows[0]?.count).toBe("1");
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

function treePlan(): Readonly<{
  zoneId: PopulationZoneV2Id;
  plan: GeneratedPopulationZoneV2Plan;
}> {
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
      return { zoneId, plan };
    }
  }
  throw new Error("tree fixture could not find a nearby tree plan");
}

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = parsed.pathname.replace(/^\/+/u, "");
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || database !== "ash_atlas_stability"
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
