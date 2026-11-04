import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { replaceHistoricalGenerationFixture } from "./populationHistoricalGenerationTestFixture.js";
import { runMigrations } from "../db/migrate.js";
import {
  POPULATION_V2_MOB_DEFINITIONS,
  createPackPopulationV2MobCandidateBuilder,
  createPopulationV2MobRegistry,
  type PopulationV2MobDefinition
} from "./populationV2MobRegistry.js";
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
import {
  PostgresPopulationV2RegisteredMobRolloutStore
} from "./populationV2RegisteredMobRolloutStore.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MOB_KIND = "rollout_test_hound";
const PLACEMENT_REVISION = "rollout-test-hound-v1";
const PACK_FORMATION = {
  allowedMemberCounts: [5],
  memberCountForCandidate: () => 5
} as const;

describeDatabase("PostgreSQL registered-mob rollout persistence", () => {
  const databaseName = `ash_atlas_stability_mob_rollout_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 10)}`;
  const worldEnvironmentIdentityKey = "d".repeat(64);
  const worldPipelineSha = "e".repeat(40);
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;
  let generationStore: PostgresPopulationZonesV2Store;
  let rolloutStore: PostgresPopulationV2RegisteredMobRolloutStore;

  beforeAll(async () => {
    const parsed = assertStabilityLabAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(parsed.toString());
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 12 });

    const generationRegistry = createPopulationV2MobRegistry(POPULATION_V2_MOB_DEFINITIONS);
    generationStore = new PostgresPopulationZonesV2Store(
      pool,
      (input) => ({
        generationId: input.generationId,
        generationNumber: input.generationNumber,
        slots: [],
        plannedNonStoneCount: 0,
        shortfallByKind: {
          tree: 0,
          flax: 0,
          deer: 0,
          wolf_pack: 0,
          sap_crawler_group: 0
        }
      }),
      generationRegistry
    );
    const rolloutDefinition = houndDefinition();
    rolloutStore = new PostgresPopulationV2RegisteredMobRolloutStore(pool, {
      registry: createPopulationV2MobRegistry([rolloutDefinition], {
        supportedArchetypes: new Set([rolloutDefinition.combatArchetype])
      })
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`
    );
    await admin?.end();
  });

  it("persists a complete top-up atomically, replays it exactly, and terminally fences corrupt packs", async () => {
    const fixture = emptyGenerationFixture({
      worldEnvironmentIdentityKey,
      worldPipelineSha
    });
    await completePlan(generationStore, fixture.zoneId, fixture.plan);
    const generation = await generationStore.createCurrentGeneration({
      zoneId: fixture.zoneId,
      planId: fixture.plan.planId,
      now: new Date("2099-06-01T00:00:00.000Z")
    });
    await replaceHistoricalGenerationFixture(pool!, fixture.plan, generation.generation.generationId, []);
    const request = {
      generationId: generation.generation.generationId,
      mobKind: MOB_KIND,
      placementRevision: PLACEMENT_REVISION,
      mode: "existing_generation_top_up" as const
    };

    const applied = await rolloutStore.execute(request);
    expect(applied).toMatchObject({
      disposition: "applied",
      receipt: {
        source: "top_up",
        status: "completed",
        targetGroupCount: 1,
        targetBodyCount: 5,
        insertedGroupCount: 1,
        insertedBodyCount: 5,
        shortfallGroupCount: 0,
        attemptCount: 1
      }
    });
    expect(applied.insertedEntityIds).toHaveLength(5);
    await expect(pool!.query(
      `SELECT kind_key, placement_revision, lifecycle_revision,
              source, group_atomic
       FROM population_generation_kind_manifest_v2
       WHERE generation_id=$1::uuid AND kind_key=$2`,
      [generation.generation.generationId, MOB_KIND]
    )).resolves.toMatchObject({
      rows: [{
        kind_key: MOB_KIND,
        placement_revision: PLACEMENT_REVISION,
        lifecycle_revision: "combat-generation-scoped-v1",
        source: "top_up",
        group_atomic: true
      }]
    });

    const complete = await persistedTargetCounts(
      pool!,
      generation.generation.generationId
    );
    expect(complete).toEqual({ slots: "5", states: "5", projections: "5" });
    const groupShape = await pool!.query<{
      bodies: string;
      member_indexes: number[];
      encounter_ids: string;
      pack_ids: string;
    }>(
      `SELECT count(*)::text AS bodies,
              array_agg(pack_member_index ORDER BY pack_member_index)
                AS member_indexes,
              count(DISTINCT encounter_id)::text AS encounter_ids,
              count(DISTINCT pack_id)::text AS pack_ids
       FROM population_spawn_slots_v2
       WHERE generation_id=$1::uuid AND entity_kind=$2`,
      [generation.generation.generationId, MOB_KIND]
    );
    expect(groupShape.rows).toEqual([{
      bodies: "5",
      member_indexes: [0, 1, 2, 3, 4],
      encounter_ids: "1",
      pack_ids: "1"
    }]);

    const replay = await rolloutStore.execute(request);
    expect(replay).toMatchObject({
      disposition: "already_terminal",
      receipt: {
        status: "completed",
        attemptCount: 1,
        insertedBodyCount: 5
      },
      insertedEntityIds: []
    });
    await expect(persistedTargetCounts(
      pool!,
      generation.generation.generationId
    )).resolves.toEqual(complete);

    const projectionToRemove = applied.insertedEntityIds[0]!;
    await pool!.query(
      `DELETE FROM population_generation_mob_rollouts_v2
       WHERE generation_id=$1::uuid AND mob_kind=$2 AND rollout_revision=$3`,
      [generation.generation.generationId, MOB_KIND, PLACEMENT_REVISION]
    );
    await pool!.query(
      `DELETE FROM generated_world_mobs WHERE population_v2_entity_id=$1::uuid`,
      [projectionToRemove]
    );
    const missingProjection = await rolloutStore.execute(request);
    expect(missingProjection).toMatchObject({
      disposition: "terminal_diagnostic",
      receipt: {
        status: "terminal_diagnostic",
        insertedGroupCount: 0,
        insertedBodyCount: 0,
        attemptCount: 1
      },
      insertedEntityIds: []
    });
    expect(missingProjection.receipt.lastError).toMatch(/partial persisted/i);
    await expect(persistedTargetCounts(
      pool!,
      generation.generation.generationId
    )).resolves.toEqual({ slots: "5", states: "5", projections: "4" });

    const partialFixture = emptyGenerationFixture({
      worldEnvironmentIdentityKey,
      worldPipelineSha,
      origin: { lat: 47.6062, lon: -122.3321 }
    });
    await completePlan(
      generationStore,
      partialFixture.zoneId,
      partialFixture.plan
    );
    const partialGeneration = await generationStore.createCurrentGeneration({
      zoneId: partialFixture.zoneId,
      planId: partialFixture.plan.planId,
      now: new Date("2099-06-01T00:00:00.000Z")
    });
    await replaceHistoricalGenerationFixture(pool!, partialFixture.plan, partialGeneration.generation.generationId, []);
    const partialRequest = {
      ...request,
      generationId: partialGeneration.generation.generationId
    };
    const seededPartialPack = await rolloutStore.execute(partialRequest);
    expect(seededPartialPack.insertedEntityIds).toHaveLength(5);
    await pool!.query(
      `DELETE FROM population_generation_mob_rollouts_v2
       WHERE generation_id=$1::uuid AND mob_kind=$2 AND rollout_revision=$3`,
      [
        partialGeneration.generation.generationId,
        MOB_KIND,
        PLACEMENT_REVISION
      ]
    );
    await removeLegacyPartialSlots(
      pool!,
      seededPartialPack.insertedEntityIds.slice(0, 2)
    );
    await expect(persistedTargetCounts(
      pool!,
      partialGeneration.generation.generationId
    )).resolves.toEqual({ slots: "3", states: "3", projections: "3" });
    const partial = await rolloutStore.execute(partialRequest);
    expect(partial).toMatchObject({
      disposition: "terminal_diagnostic",
      receipt: {
        status: "terminal_diagnostic",
        insertedGroupCount: 0,
        insertedBodyCount: 0,
        attemptCount: 1
      },
      insertedEntityIds: []
    });
    await expect(persistedTargetCounts(
      pool!,
      partialGeneration.generation.generationId
    )).resolves.toEqual({ slots: "3", states: "3", projections: "3" });
  });
});

function houndDefinition(): PopulationV2MobDefinition {
  return {
    mobKind: MOB_KIND,
    combatArchetype: MOB_KIND,
    placementRevision: PLACEMENT_REVISION,
    generationPlacement: "registered_overlay",
    spawnModel: "pack",
    behaviorCategory: "hostile",
    mechanicalPhaseEligibility: "ANY",
    plannerPriority: 1,
    density: {
      model: "common",
      densityPerEligibleKm2: 1,
      candidateOversamplingFactor: 3
    },
    eligibleAreaKm2: () => 1,
    isEligibleAnchor: (site) => site.weights.eligibleLand > 0,
    candidateBuilder: createPackPopulationV2MobCandidateBuilder(
      MOB_KIND,
      PACK_FORMATION
    ),
    packFormation: PACK_FORMATION,
    spacingClass: "small_hostile_pack",
    suppressionClass: "hostile-pack",
    clientPresentational: true,
    defaultRolloutPolicy: "top_up_existing_generations",
    existingGenerationRolloutEligible: true,
    diagnosticsLabel: "Rollout test hound"
  };
}


function emptyGenerationFixture(input: Readonly<{
  worldEnvironmentIdentityKey: string;
  worldPipelineSha: string;
  origin?: Readonly<{ lat: number; lon: number }>;
}>): Readonly<{
  zoneId: PopulationZoneV2Id;
  plan: GeneratedPopulationZoneV2Plan;
}> {
  const origin = populationZoneV2IdForPoint(
    input.origin ?? { lat: 39.7392, lon: -104.9903 }
  );
  for (const zoneId of populationZoneV2Halo(origin, 20)) {
    const plan = generatePopulationZoneV2Plan({
      zoneId,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
      worldPipelineSha: input.worldPipelineSha,
      habitatForZone: (candidateZoneId) => populationZoneV3ConservativeHabitat({
        zoneId: candidateZoneId,
        worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
      })
    });
    if (
      plan.slots.every((slot) => slot.entityKind !== "stone")
      && (plan.habitat.candidateSites?.length ?? 0) >= 3
    ) {
      return { zoneId, plan };
    }
  }
  throw new Error("fixture could not find a stone-free Population V2 plan");
}

async function completePlan(
  store: PostgresPopulationZonesV2Store,
  zoneId: PopulationZoneV2Id,
  plan: GeneratedPopulationZoneV2Plan
): Promise<void> {
  const request = populationZoneV2PlanRequest({
    zoneId,
    worldEnvironmentIdentityKey: plan.identity.worldEnvironmentIdentityKey,
    worldPipelineSha: plan.worldPipelineSha,
    environmentProfileVersion: plan.identity.environmentProfileVersion,
    regionCode: plan.habitat.regionCode
  });
  await store.ensurePlanForZone(request);
  const claim = await store.claimPlan(request.identity, randomUUID(), 30_000);
  if (claim === null) throw new Error("fixture plan could not be claimed");
  await expect(store.completePlan(claim, plan)).resolves.toBe(true);
}

async function persistedTargetCounts(
  pool: pg.Pool,
  generationId: string
): Promise<Readonly<{ slots: string; states: string; projections: string }>> {
  const result = await pool.query<{
    slots: string;
    states: string;
    projections: string;
  }>(
    `SELECT count(*)::text AS slots,
            count(state.entity_id)::text AS states,
            count(projection.population_v2_entity_id)::text AS projections
     FROM population_spawn_slots_v2 AS slot
     LEFT JOIN population_entity_state_v2 AS state
       ON state.entity_id=slot.entity_id
     LEFT JOIN generated_world_mobs AS projection
       ON projection.population_v2_entity_id=slot.entity_id
     WHERE slot.generation_id=$1::uuid AND slot.entity_kind=$2`,
    [generationId, MOB_KIND]
  );
  return result.rows[0]!;
}

async function removeLegacyPartialSlots(
  pool: pg.Pool,
  entityIds: readonly string[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await client.query(
      `DELETE FROM generated_world_mobs
       WHERE population_v2_entity_id=ANY($1::uuid[])`,
      [entityIds]
    );
    await client.query(
      `DELETE FROM population_entity_state_v2 WHERE entity_id=ANY($1::uuid[])`,
      [entityIds]
    );
    await client.query(
      `DELETE FROM population_spawn_slots_v2 WHERE entity_id=ANY($1::uuid[])`,
      [entityIds]
    );
  } finally {
    await client.query("SET session_replication_role = origin");
    client.release();
  }
}

function assertStabilityLabAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "postgres:"
    && parsed.protocol !== "postgresql:"
  ) {
    throw new Error("stability admin URL must use PostgreSQL");
  }
  const database = parsed.pathname.replaceAll("/", "");
  if (!database.startsWith("ash_atlas_stability")) {
    throw new Error("stability admin URL must target a disposable database");
  }
  return parsed;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
