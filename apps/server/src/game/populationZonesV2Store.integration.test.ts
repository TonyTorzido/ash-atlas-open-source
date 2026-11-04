import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import {
  destinationPoint,
} from "@ash-atlas/shared";

import { materializePopulationV2EncounterTables } from "./populationV2EncounterTables.js";
import { runMigrations } from "../db/migrate.js";
import {
  type GeneratedPopulationZoneV2Plan,
  type PopulationZoneV2PlanSlot,
  generatePopulationZoneV2Plan,
  generatePopulationZoneV2GenerationSlots,
  populationZoneV2GenerationId,
  isPermanentMineEntityKind,
  permanentMineArchetype,
  populationZoneV2PlanContentHash,
  populationZoneV3ConservativeHabitat,
} from "./populationZonesV2Plan.js";
import {
  type PopulationZoneV2Id,
  populationZoneV2Halo,
  populationZoneV2IdForPoint
} from "./populationZonesV2Geometry.js";
import {
  populationZoneV2PlanId,
  deterministicUuidV8,
  permanentMineKindForSlot,
  permanentPopulationStoneIdentity,
  type CanonicalJsonValue,
  type PopulationZoneV2PlanIdentity
} from "./populationZonesV2Identity.js";
import {
  POPULATION_ZONE_V2_GENERATION_CLEANUP_GRACE_MS,
  POPULATION_ZONE_V2_GENERATION_DURATION_MS,
  POPULATION_V2_REGISTERED_MOB_NEIGHBOR_OCCUPANTS_SQL,
  PopulationPlanCompletionError,
  populationZoneV2PlanRequest,
  PostgresPopulationZonesV2Store
} from "./populationZonesV2Store.js";
import { replaceHistoricalGenerationFixture } from "./populationHistoricalGenerationTestFixture.js";
import { STONE_MINE_REGENERATION_MS } from "./repeatableResources.js";
import {
  POPULATION_V2_MOB_DEFINITIONS,
  createPopulationV2MobRegistry,
  type PopulationV2MobDefinition
} from "./populationV2MobRegistry.js";
import {
  POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL
} from "./populationV2RegisteredMobRolloutStore.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Population v2 generation lifecycle PostgreSQL authority", () => {
  const databaseName =
    `ash_atlas_stability_population_generation_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  const worldEnvironmentIdentityKey = "c".repeat(64);
  const worldPipelineSha = "c".repeat(40);
  const generatedAt = new Date("2099-01-02T03:04:05.000Z");
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;
  let first: PostgresPopulationZonesV2Store;
  let second: PostgresPopulationZonesV2Store;
  let plan: GeneratedPopulationZoneV2Plan;
  let zoneId: PopulationZoneV2Id;

  beforeAll(async () => {
    const parsed = assertStabilityLabAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(parsed.toString());
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 24 });
    first = new PostgresPopulationZonesV2Store(pool);
    second = new PostgresPopulationZonesV2Store(pool);

    ({ zoneId, plan } = fixturePlanWithPermanentStone({
      worldEnvironmentIdentityKey,
      worldPipelineSha
    }));
    const request = populationZoneV2PlanRequest({
      zoneId,
      worldEnvironmentIdentityKey,
      worldPipelineSha,
      environmentProfileVersion:
        plan.identity.environmentProfileVersion,
      regionCode: plan.habitat.regionCode
    });
    await first.ensurePlanForZone(request);
    const claim = await first.claimPlan(
      request.identity,
      randomUUID(),
      30_000
    );
    if (claim === null) throw new Error("fixture could not claim its plan");
    await first.completePlan(claim, plan);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`
    );
    await admin?.end();
  });

  it("keeps compilation as habitat/template data plus permanent stones", async () => {
    const counts = await pool!.query<{
      stone_slots: string;
      nonstone_slots: string;
      template_slots: number;
      candidate_sites: number;
      habitat_type: string;
    }>(
      `SELECT
         (
           SELECT count(*)::text
           FROM population_spawn_slots_v2
           WHERE plan_id=$1::uuid AND entity_kind IN ('stone','coal','iron')
         ) AS stone_slots,
         (
           SELECT count(*)::text
           FROM population_spawn_slots_v2
           WHERE plan_id=$1::uuid AND entity_kind NOT IN ('stone','coal','iron')
         ) AS nonstone_slots,
         jsonb_array_length(nonstone_template_slots) AS template_slots,
         jsonb_array_length(candidate_pool) AS candidate_sites,
         jsonb_typeof(habitat_snapshot) AS habitat_type
       FROM population_zones_v2
       WHERE plan_id=$1::uuid`,
      [plan.planId]
    );
    expect(Number(counts.rows[0]!.stone_slots)).toBeGreaterThan(0);
    expect(counts.rows[0]!.nonstone_slots).toBe("0");
    expect(counts.rows[0]!.template_slots).toBe(
      plan.slots.filter((slot) =>
        !isPermanentMineEntityKind(slot.entityKind)
      ).length
    );
    expect(counts.rows[0]!.candidate_sites).toBeGreaterThan(0);
    expect(counts.rows[0]!.habitat_type).toBe("object");
  });

  it("adopts permanent mine authority across compiler and placement revisions", async () => {
    const fixture = fixturePlanWithPermanentStone({
      worldEnvironmentIdentityKey: "4".repeat(64),
      worldPipelineSha: "4".repeat(40)
    });
    const currentPlan = planWithStoneEligibleLandFraction(
      fixture.plan,
      0.9642857142857141
    );
    const legacySnapshotPlan = planWithLegacyCandidateSurface(
      planWithStoneEligibleLandFraction(
        currentPlan,
        0.9999999999999998
      )
    );
    const legacyPlan = planForAuthorityVersions(
      currentPlan,
      {
        populationPlanVersion: "population-zone-plan-compiler-v3",
        spawnRulesVersion: "population-spawn-rules-v2-launch-7",
        candidateLayoutVersion: "compact-owner-samples-global-rank-v4"
      },
      legacySnapshotPlan.slots
    );
    await completeFixturePlan(first, legacyPlan);
    const plannedStone = currentPlan.slots.find((slot) =>
      slot.entityKind === "stone"
    );
    const legacyStone = legacyPlan.slots.find((slot) =>
      slot.entityKind === "stone"
    );
    if (!plannedStone) throw new Error("fixture stone disappeared");
    if (!legacyStone) throw new Error("legacy fixture stone disappeared");
    expect(legacyStone.environmentSnapshot.eligibleLandFraction)
      .toBe(0.9999999999999998);
    expect(plannedStone.environmentSnapshot.eligibleLandFraction)
      .toBe(0.9642857142857141);
    const readyStone = (await first.loadReadyEntitiesForZones([
      fixture.zoneId
    ])).find((entity) => entity.entityId === plannedStone.entityId);
    if (!readyStone) throw new Error("legacy stone was not ready");
    const harvested = await first.transitionEntityState({
      entityId: readyStone.entityId,
      expectedStateRevision: readyStone.stateRevision,
      state: "harvested",
      eventAt: new Date("2099-01-10T00:00:00.000Z"),
      durableRuntimeState: { compatibilityFixture: "preserved" }
    });
    expect(harvested).not.toBeNull();

    const terminalV5Plan = planForAuthorityVersions(
      currentPlan,
      {
        populationPlanVersion:
          "population-zone-plan-compiler-v5-stone-authority-compat",
        spawnRulesVersion: currentPlan.identity.spawnRulesVersion,
        candidateLayoutVersion: currentPlan.identity.candidateLayoutVersion
      },
      currentPlan.slots
    );
    const terminalV5Request = requestForPlan(terminalV5Plan);
    await first.ensurePlanForZone(terminalV5Request);
    const terminalV5Claim = await first.claimPlan(
      terminalV5Request.identity,
      randomUUID(),
      30_000
    );
    if (terminalV5Claim === null) {
      throw new Error("historical v5 fixture plan could not be claimed");
    }
    const historicalV5Failure = new PopulationPlanCompletionError(
      "historical v5 permanent-stone compatibility failure",
      {
        code: "population-plan-immutable-stone-mismatch",
        retryable: false,
        postgresCode: null,
        constraint: null,
        table: null,
        zoneId: terminalV5Claim.identity.zoneId,
        planId: terminalV5Claim.planId,
        spawnRulesVersion:
          terminalV5Claim.identity.spawnRulesVersion,
        slotId: plannedStone.slotId,
        entityId: plannedStone.entityId,
        entityKind: plannedStone.entityKind,
        generationId: null,
        claimGeneration: terminalV5Claim.claimGeneration,
        attemptCount: terminalV5Claim.attemptCount
      }
    );
    await expect(first.failPlan(terminalV5Claim, historicalV5Failure))
      .resolves.toEqual({
        accepted: true,
        status: "terminal-failure",
        errorCode: "population-plan-immutable-stone-mismatch"
      });

    await completeFixturePlan(first, currentPlan);
    const placementDriftPlan = planForSpawnRules(
      currentPlan,
      "population-spawn-rules-v3-stone-placement-drift",
      currentPlan.slots.map((slot) => slot.entityKind === "stone"
        ? {
            ...slot,
            position: {
              ...slot.position,
              lat: slot.position.lat + 0.000_001
            }
          }
        : slot)
    );
    await completeFixturePlan(first, placementDriftPlan);

    const authority = await pool!.query<{
      physical_slots: string;
      memberships: string;
      old_status: string;
      terminal_v5_status: string;
      current_status: string;
      selected_plan_id: string;
      authority_plan_id: string;
      projection_plan_id: string;
      projection_placement_version: string;
      state: string;
      state_revision: string | number;
      durable_runtime_state: Record<string, unknown>;
      ready_at: Date;
      environment_snapshot: Record<string, unknown>;
    }>(
      `SELECT
         (
           SELECT count(*)::text
           FROM population_spawn_slots_v2
           WHERE entity_id=stone.entity_id
         ) AS physical_slots,
         (
           SELECT count(*)::text
           FROM population_plan_permanent_stones_v2
           WHERE entity_id=stone.entity_id
         ) AS memberships,
         old_plan.status AS old_status,
         terminal_v5_plan.status AS terminal_v5_status,
         current_plan.status AS current_status,
         cutover.selected_plan_id,
         slot.plan_id AS authority_plan_id,
         projection.population_v2_plan_id AS projection_plan_id,
         projection.placement_version AS projection_placement_version,
         state.state, state.state_revision, state.durable_runtime_state,
         projection.ready_at, stone.environment_snapshot
       FROM population_permanent_stone_authority_v2 AS stone
       JOIN population_spawn_slots_v2 AS slot
         ON slot.entity_id=stone.entity_id
       JOIN population_entity_state_v2 AS state
         ON state.entity_id=stone.entity_id
       JOIN repeatable_resource_nodes AS projection
         ON projection.population_v2_entity_id=stone.entity_id
       JOIN population_zone_cutovers_v2 AS cutover
         ON cutover.zone_id=stone.owner_zone_id
       JOIN population_zones_v2 AS old_plan
         ON old_plan.plan_id=$2::uuid
       JOIN population_zones_v2 AS current_plan
         ON current_plan.plan_id=$3::uuid
       JOIN population_zones_v2 AS terminal_v5_plan
         ON terminal_v5_plan.plan_id=$4::uuid
       WHERE stone.entity_id=$1::uuid`,
      [
        plannedStone.entityId,
        legacyPlan.planId,
        currentPlan.planId,
        terminalV5Plan.planId
      ]
    );
    expect(authority.rows[0]).toMatchObject({
      physical_slots: "1",
      memberships: "3",
      old_status: "ready",
      terminal_v5_status: "terminal-failure",
      current_status: "ready",
      selected_plan_id: placementDriftPlan.planId,
      authority_plan_id: legacyPlan.planId,
      projection_plan_id: legacyPlan.planId,
      projection_placement_version:
        "compact-owner-samples-global-rank-v4",
      state: "harvested",
      durable_runtime_state: { compatibilityFixture: "preserved" }
    });
    expect(Number(authority.rows[0]!.state_revision)).toBe(1);
    expect(authority.rows[0]!.ready_at).toEqual(harvested!.respawnAt);
    expect(authority.rows[0]!.environment_snapshot)
      .toEqual(legacyStone.environmentSnapshot);
    expect(authority.rows[0]!.environment_snapshot.candidateSite)
      .toHaveProperty("surfaceType");
    expect(authority.rows[0]!.environment_snapshot.candidateSite)
      .toHaveProperty("surfaceAuthority");

    const incompatibleAuthorityPlan = planForSpawnRules(
      currentPlan,
      "population-spawn-rules-v3-stone-authority-negative",
      currentPlan.slots.map((slot) => slot.entityKind === "stone"
        ? {
            ...slot,
            suppressionClass: "hostile-pack" as const
          }
        : slot)
    );
    const incompatibleRequest = requestForPlan(incompatibleAuthorityPlan);
    await first.ensurePlanForZone(incompatibleRequest);
    const incompatibleClaim = await first.claimPlan(
      incompatibleRequest.identity,
      randomUUID(),
      30_000
    );
    if (incompatibleClaim === null) {
      throw new Error("incompatible snapshot fixture could not be claimed");
    }
    await expect(first.completePlan(
      incompatibleClaim,
      incompatibleAuthorityPlan
    )).rejects.toMatchObject({
      details: {
        code: "population-plan-immutable-stone-mismatch",
        retryable: false,
        entityId: plannedStone.entityId
      }
    });
  });

  it("keeps a harvested permanent mine when the selected plan omits it", async () => {
    const fixture = fixturePlanWithPermanentMine({
      worldEnvironmentIdentityKey: "3".repeat(64),
      worldPipelineSha: "3".repeat(40),
      mineKind: "iron",
      origin: { lat: 39.7392, lon: -104.9903 }
    });
    const priorPlan = planForSpawnRules(
      fixture.plan,
      "population-spawn-rules-v2-cutover-continuity-a",
      fixture.plan.slots
    );
    await completeFixturePlan(first, priorPlan);
    const mine = (await first.loadReadyEntitiesForZones([fixture.zoneId]))
      .find((entity) => entity.entityKind === "iron");
    expect(mine).toBeDefined();
    const harvested = await first.transitionEntityState({
      entityId: mine!.entityId,
      expectedStateRevision: mine!.stateRevision,
      state: "harvested",
      eventAt: new Date("2099-01-12T00:00:00.000Z"),
      durableRuntimeState: { cutoverContinuity: "preserved" }
    });
    expect(harvested).not.toBeNull();
    await pool!.query(
      `UPDATE repeatable_resource_nodes
       SET population_flag_suppressed=true
       WHERE population_v2_entity_id=$1::uuid`,
      [mine!.entityId]
    );
    const projectionBefore = (await pool!.query(
      `SELECT population_v2_plan_id::text,
              lat AS latitude, lon AS longitude,
              harvest_revision::text, ready_at, last_harvested_by,
              population_v2_state_revision::text,
              population_cutover_revision::text,
              population_flag_suppressed, population_v2_suppressed
       FROM repeatable_resource_nodes
       WHERE population_v2_entity_id=$1::uuid`,
      [mine!.entityId]
    )).rows[0];

    const omittedPlan = planForSpawnRules(
      fixture.plan,
      "population-spawn-rules-v2-cutover-continuity-b",
      fixture.plan.slots.filter((slot) =>
        !isPermanentMineEntityKind(slot.entityKind)
      )
    );
    await completeFixturePlan(first, omittedPlan);

    const continuity = await pool!.query<{
      memberships: string;
      selected_plan_id: string;
      cutover_revision: string;
      state: string;
      state_revision: string;
      durable_runtime_state: Record<string, unknown>;
      projection_cutover_revision: string;
      population_v2_suppressed: boolean;
    }>(
      `SELECT
         (
           SELECT count(*)::text
           FROM population_plan_permanent_resources_v2
           WHERE entity_id=authority.entity_id
         ) AS memberships,
         cutover.selected_plan_id::text,
         cutover.cutover_revision::text,
         canonical.state,
         canonical.state_revision::text,
         canonical.durable_runtime_state,
         projection.population_cutover_revision::text
           AS projection_cutover_revision,
         projection.population_v2_suppressed
       FROM population_permanent_resource_authority_v2 AS authority
       JOIN population_zone_cutovers_v2 AS cutover
         ON cutover.zone_id=authority.owner_zone_id
       JOIN population_entity_state_v2 AS canonical
         ON canonical.entity_id=authority.entity_id
       JOIN repeatable_resource_nodes AS projection
         ON projection.population_v2_entity_id=authority.entity_id
       JOIN population_plan_permanent_resources_v2 AS selected_membership
         ON selected_membership.plan_id=cutover.selected_plan_id
        AND selected_membership.entity_id=authority.entity_id
       WHERE authority.entity_id=$1::uuid`,
      [mine!.entityId]
    );
    expect(continuity.rows[0]).toMatchObject({
      memberships: "2",
      selected_plan_id: omittedPlan.planId,
      state: "harvested",
      state_revision: "1",
      durable_runtime_state: { cutoverContinuity: "preserved" },
      population_v2_suppressed: true
    });
    expect(continuity.rows[0]!.projection_cutover_revision)
      .toBe(continuity.rows[0]!.cutover_revision);
    const projectionAfter = (await pool!.query(
      `SELECT population_v2_plan_id::text,
              lat AS latitude, lon AS longitude,
              harvest_revision::text, ready_at, last_harvested_by,
              population_v2_state_revision::text,
              population_flag_suppressed, population_v2_suppressed
       FROM repeatable_resource_nodes
       WHERE population_v2_entity_id=$1::uuid`,
      [mine!.entityId]
    )).rows[0];
    const {
      population_cutover_revision: _previousCutoverRevision,
      ...preservedProjectionBefore
    } = projectionBefore;
    void _previousCutoverRevision;
    expect(projectionAfter).toEqual(preservedProjectionBefore);
  });

  it("adopts one immutable stone across spawn-rule plans and fences obsolete wildlife", async () => {
    const fixture = fixturePlanWithPermanentStone({
      worldEnvironmentIdentityKey: "6".repeat(64),
      worldPipelineSha: "d".repeat(40)
    });
    const currentPlan = fixture.plan;
    const oldNonstones = currentPlan.slots
      .filter((slot) => slot.entityKind !== "stone")
      .filter((_, index) => index % 2 === 0);
    const oldPlan = planForSpawnRules(
      currentPlan,
      "population-spawn-rules-v2-launch-3",
      [
        ...currentPlan.slots.filter((slot) => slot.entityKind === "stone"),
        ...oldNonstones
      ]
    );
    await completeFixturePlan(first, oldPlan);
    const oldGeneration = await first.createCurrentGeneration({
      zoneId: fixture.zoneId,
      planId: oldPlan.planId,
      now: new Date("2099-02-01T00:00:00.000Z"),
      currentReferences: 2
    });
    const stone = (await first.loadReadyEntitiesForZones([fixture.zoneId]))
      .find((entity) => entity.entityKind === "stone");
    expect(stone).toBeDefined();
    const harvestedAt = new Date("2099-02-01T01:00:00.000Z");
    const harvested = await first.transitionEntityState({
      entityId: stone!.entityId,
      expectedStateRevision: stone!.stateRevision,
      state: "harvested",
      eventAt: harvestedAt,
      durableRuntimeState: {
        productionHistory: "preserved",
        cooldownOwner: "permanent-stone"
      }
    });
    expect(harvested?.stateRevision).toBe(1);

    const currentRequest = requestForPlan(currentPlan);
    await first.ensurePlanForZone(currentRequest);
    const claim = await first.claimPlan(
      currentRequest.identity,
      randomUUID(),
      30_000
    );
    if (claim === null) throw new Error("current plan could not be claimed");
    const completions = await Promise.all([
      first.completePlan(claim, currentPlan),
      second.completePlan(claim, currentPlan)
    ]);
    expect(completions.sort()).toEqual([false, true]);

    const authority = await pool!.query<{
      physical_slots: string;
      authority_rows: string;
      memberships: string;
      state_revision: string | number;
      state: string;
      durable_runtime_state: Record<string, unknown>;
      projection_plan_id: string;
      projection_ready_at: Date;
      projection_harvest_revision: string | number;
      selected_plan_id: string;
      slot_id: string;
      candidate_id: string;
      owner_zone_id: string;
      stone_placement_version: string;
      world_environment_identity_key: string;
      latitude: number | string;
      longitude: number | string;
    }>(
      `SELECT
         (
           SELECT count(*)::text FROM population_spawn_slots_v2
           WHERE entity_id=$1::uuid
         ) AS physical_slots,
         (
           SELECT count(*)::text
           FROM population_permanent_stone_authority_v2
           WHERE entity_id=$1::uuid
         ) AS authority_rows,
         (
           SELECT count(*)::text
           FROM population_plan_permanent_stones_v2
           WHERE entity_id=$1::uuid
         ) AS memberships,
         state.state_revision, state.state, state.durable_runtime_state,
         projection.population_v2_plan_id AS projection_plan_id,
         projection.ready_at AS projection_ready_at,
         projection.harvest_revision AS projection_harvest_revision,
         cutover.selected_plan_id,
         stone.slot_id, stone.candidate_id, stone.owner_zone_id,
         stone.stone_placement_version,
         stone.world_environment_identity_key,
         stone.latitude, stone.longitude
       FROM population_entity_state_v2 AS state
       JOIN population_permanent_stone_authority_v2 AS stone
         ON stone.entity_id=state.entity_id
       JOIN repeatable_resource_nodes AS projection
         ON projection.population_v2_entity_id=state.entity_id
       JOIN population_zone_cutovers_v2 AS cutover
         ON cutover.zone_id=$2
       WHERE state.entity_id=$1::uuid`,
      [stone!.entityId, fixture.zoneId]
    );
    expect(authority.rows[0]).toMatchObject({
      physical_slots: "1",
      authority_rows: "1",
      memberships: "2",
      state: "harvested",
      durable_runtime_state: {
        productionHistory: "preserved",
        cooldownOwner: "permanent-stone"
      },
      projection_plan_id: oldPlan.planId,
      projection_harvest_revision: "1",
      selected_plan_id: oldPlan.planId
    });
    expect(Number(authority.rows[0]!.state_revision)).toBe(1);
    const plannedStone = currentPlan.slots.find((slot) =>
      slot.entityId === stone!.entityId
    )!;
    expect(authority.rows[0]).toMatchObject({
      slot_id: plannedStone.slotId,
      candidate_id: plannedStone.candidateId,
      owner_zone_id: fixture.zoneId,
      stone_placement_version: "population-permanent-stone-placement-v1",
      world_environment_identity_key:
        currentPlan.identity.worldEnvironmentIdentityKey
    });
    expect(Number(authority.rows[0]!.latitude))
      .toBe(plannedStone.position.lat);
    expect(Number(authority.rows[0]!.longitude))
      .toBe(plannedStone.position.lon);
    expect(authority.rows[0]!.projection_ready_at)
      .toEqual(harvested!.respawnAt);

    const currentGeneration = await first.createCurrentGeneration({
      zoneId: fixture.zoneId,
      planId: currentPlan.planId,
      now: new Date("2099-02-03T00:00:00.000Z"),
      replaceExpiredReferencedGeneration: true
    });
    expect(currentGeneration.created).toBe(true);
    expect(currentGeneration.generation.planId).toBe(currentPlan.planId);
    expect(currentGeneration.generation.plannedNonStoneCount)
      .toBeGreaterThan(0);
    expect(currentGeneration.generation.generationId)
      .not.toBe(oldGeneration.generation.generationId);
    const oldRows = await pool!.query<{
      slot_count: string;
      status: string;
      is_current: boolean;
      current_reference_count: number;
      cleaned: boolean;
    }>(
      `SELECT
         (
           SELECT count(*)::text
           FROM population_spawn_slots_v2
           WHERE generation_id=generation.generation_id
         ) AS slot_count,
         generation.status, generation.is_current,
         generation.current_reference_count,
         generation.cleaned_at IS NOT NULL AS cleaned
       FROM population_zone_generations_v2 AS generation
       WHERE generation.generation_id=$1::uuid`,
      [oldGeneration.generation.generationId]
    );
    expect(oldRows.rows[0]).toEqual({
      slot_count: "0",
      status: "expired",
      is_current: false,
      current_reference_count: 0,
      cleaned: true
    });
    const active = await first.loadReadyEntitiesForZones([fixture.zoneId]);
    expect(active.some((entity) =>
      entity.generationId === oldGeneration.generation.generationId
    )).toBe(false);
    expect(active.filter((entity) =>
      entity.generationId === currentGeneration.generation.generationId
    )).toHaveLength(currentGeneration.generation.plannedNonStoneCount);
    expect(await first.completePlan(claim, currentPlan)).toBe(false);
    const replay = await first.createCurrentGeneration({
      zoneId: fixture.zoneId,
      planId: currentPlan.planId,
      now: new Date("2099-02-02T01:00:00.000Z")
    });
    expect(replay.created).toBe(false);
    expect(replay.generation.generationId)
      .toBe(currentGeneration.generation.generationId);

    const foreignZoneId = populationZoneV2Halo(fixture.zoneId, 1)
      .find((candidate) => candidate !== fixture.zoneId)!;
    const foreignPlan = generatePopulationZoneV2Plan({
      zoneId: foreignZoneId,
      worldEnvironmentIdentityKey:
        currentPlan.identity.worldEnvironmentIdentityKey,
      worldPipelineSha: currentPlan.worldPipelineSha,
      habitatForZone: (candidate) =>
        populationZoneV3ConservativeHabitat({
          zoneId: candidate,
          worldEnvironmentIdentityKey:
            currentPlan.identity.worldEnvironmentIdentityKey
        })
    });
    await first.ensurePlanForZone(requestForPlan(foreignPlan));
    await expect(pool!.query(
      `INSERT INTO population_plan_permanent_stones_v2 (
         plan_id, entity_id
       ) VALUES ($1::uuid,$2::uuid)`,
      [foreignPlan.planId, stone!.entityId]
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "population_plan_permanent_stones_v2_owner_mismatch"
    });

    const incompatible = planForSpawnRules(
      currentPlan,
      "population-spawn-rules-v2-incompatible-test",
      currentPlan.slots.map((slot) =>
        slot.entityKind === "stone"
          ? {
              ...slot,
              suppressionClass: "hostile-pack" as const
            }
          : slot
      )
    );
    await first.ensurePlanForZone(requestForPlan(incompatible));
    const incompatibleClaim = await first.claimPlan(
      incompatible.identity,
      randomUUID(),
      30_000
    );
    if (incompatibleClaim === null) {
      throw new Error("incompatible plan could not be claimed");
    }
    await expect(first.completePlan(incompatibleClaim, incompatible))
      .rejects.toMatchObject({
        name: PopulationPlanCompletionError.name,
        details: {
          code: "population-plan-immutable-stone-mismatch",
          retryable: false,
          entityId: stone!.entityId
        }
      });
    const rollback = await pool!.query<{
      selected_plan_id: string;
      incompatible_memberships: string;
      status: string;
    }>(
      `SELECT cutover.selected_plan_id,
              (
                SELECT count(*)::text
                FROM population_plan_permanent_stones_v2
                WHERE plan_id=$2::uuid
              ) AS incompatible_memberships,
              plan.status
       FROM population_zone_cutovers_v2 AS cutover
       JOIN population_zones_v2 AS plan ON plan.plan_id=$2::uuid
       WHERE cutover.zone_id=$1`,
      [fixture.zoneId, incompatible.planId]
    );
    expect(rollback.rows[0]).toEqual({
      selected_plan_id: currentPlan.planId,
      incompatible_memberships: "0",
      status: "generating"
    });
  });

  it("repairs only verified current-rule stone conflicts with an idempotent receipt", async () => {
    const fixture = fixturePlanWithPermanentStone({
      worldEnvironmentIdentityKey: "8".repeat(64),
      worldPipelineSha: "f".repeat(40)
    });
    const oldPlan = planForSpawnRules(
      fixture.plan,
      "population-spawn-rules-v2-launch-3",
      fixture.plan.slots
    );
    await completeFixturePlan(first, oldPlan);
    const request = requestForPlan(fixture.plan);
    await first.ensurePlanForZone(request);
    const claim = await first.claimPlan(
      request.identity,
      randomUUID(),
      30_000
    );
    if (claim === null) throw new Error("repair fixture was not claimed");
    const conflict = Object.assign(new Error(
      "duplicate key value violates unique constraint "
        + "\"population_spawn_slots_v2_entity_id_key\""
    ), {
      code: "23505",
      constraint: "population_spawn_slots_v2_entity_id_key",
      table: "population_spawn_slots_v2"
    });
    await expect(first.failPlan(claim, conflict)).resolves.toEqual({
      accepted: true,
      status: "terminal-failure",
      errorCode: "population-plan-entity-identity-collision"
    });

    const dryRun = await first.repairCompatiblePermanentStonePlanFailures({
      apply: false
    });
    expect(dryRun.affectedPlans).toEqual([
      expect.objectContaining({
        zoneId: fixture.zoneId,
        planId: fixture.plan.planId,
        previousStatus: "terminal-failure",
        previousAttemptCount: 1
      })
    ]);
    const beforeApply = await pool!.query<{
      status: string;
      receipt_count: string;
    }>(
      `SELECT plan.status,
              (
                SELECT count(*)::text
                FROM population_stone_conflict_repair_receipts_v2
                WHERE plan_id=plan.plan_id
              ) AS receipt_count
       FROM population_zones_v2 AS plan
       WHERE plan.plan_id=$1::uuid`,
      [fixture.plan.planId]
    );
    expect(beforeApply.rows[0]).toEqual({
      status: "terminal-failure",
      receipt_count: "0"
    });

    const applied = await first.repairCompatiblePermanentStonePlanFailures({
      apply: true
    });
    expect(applied.affectedPlans).toEqual(dryRun.affectedPlans);
    const afterApply = await pool!.query<{
      status: string;
      attempt_count: number;
      receipt_count: string;
      old_status: string;
    }>(
      `SELECT plan.status, plan.attempt_count,
              (
                SELECT count(*)::text
                FROM population_stone_conflict_repair_receipts_v2
                WHERE plan_id=plan.plan_id
              ) AS receipt_count,
              old.status AS old_status
       FROM population_zones_v2 AS plan
       JOIN population_zones_v2 AS old ON old.plan_id=$2::uuid
       WHERE plan.plan_id=$1::uuid`,
      [fixture.plan.planId, oldPlan.planId]
    );
    expect(afterApply.rows[0]).toEqual({
      status: "retryable-failure",
      attempt_count: 0,
      receipt_count: "1",
      old_status: "ready"
    });
    await expect(first.repairCompatiblePermanentStonePlanFailures({
      apply: true
    })).resolves.toMatchObject({ affectedPlans: [] });

    await pool!.query(
      `UPDATE population_zones_v2
       SET status='terminal-failure', attempt_count=8,
           next_retry_at=NULL,
           last_error=
             '[population-plan-generation-failure] generated population plan does not match its admission'
       WHERE plan_id=$1::uuid`,
      [fixture.plan.planId]
    );
    await expect(first.repairCompatiblePermanentStonePlanFailures({
      apply: false
    })).resolves.toMatchObject({ affectedPlans: [] });
    await expect(first.repairCompatiblePermanentStonePlanFailures({
      apply: false,
      resumeRepairId: randomUUID()
    })).resolves.toMatchObject({ affectedPlans: [] });
    const resumedDryRun = await first.repairCompatiblePermanentStonePlanFailures({
      apply: false,
      resumeRepairId: applied.repairId
    });
    expect(resumedDryRun).toMatchObject({
      repairId: applied.repairId,
      affectedPlans: [
        {
          planId: fixture.plan.planId,
          previousStatus: "terminal-failure",
          previousAttemptCount: 8
        }
      ]
    });
    await expect(first.repairCompatiblePermanentStonePlanFailures({
      apply: true,
      resumeRepairId: applied.repairId
    })).resolves.toEqual(resumedDryRun);
    const afterResume = await pool!.query<{
      status: string;
      attempt_count: number;
      receipt_count: string;
    }>(
      `SELECT plan.status, plan.attempt_count,
              (
                SELECT count(*)::text
                FROM population_stone_conflict_repair_receipts_v2
                WHERE plan_id=plan.plan_id
              ) AS receipt_count
       FROM population_zones_v2 AS plan
       WHERE plan.plan_id=$1::uuid`,
      [fixture.plan.planId]
    );
    expect(afterResume.rows[0]).toEqual({
      status: "retryable-failure",
      attempt_count: 0,
      receipt_count: "1"
    });
    await expect(first.repairCompatiblePermanentStonePlanFailures({
      apply: true,
      resumeRepairId: applied.repairId
    })).resolves.toMatchObject({ affectedPlans: [] });
  });

  it("repairs a seven-zone legacy mine batch across compiler provenance", async () => {
    const mineKinds = [
      "iron",
      "stone",
      "stone",
      "iron",
      "iron",
      "coal"
    ] as const;
    const fixtures: Array<Readonly<{
      zoneId: PopulationZoneV2Id;
      currentPlan: GeneratedPopulationZoneV2Plan;
      legacyPlan: GeneratedPopulationZoneV2Plan;
    }>> = [];
    for (const [index, mineKind] of mineKinds.entries()) {
      const fixture = fixturePlanWithPermanentMine({
        worldEnvironmentIdentityKey: `${index + 1}`.repeat(64),
        worldPipelineSha: `${index + 1}`.repeat(40),
        mineKind,
        origin: { lat: 15 + index * 8, lon: -125 + index * 10 }
      });
      const legacyShape = planWithLegacyCandidateSurface(fixture.plan);
      const legacyPlan = planForAuthorityVersions(
        legacyShape,
        {
          populationPlanVersion:
            "population-zone-plan-compiler-v4-encounter-tables",
          spawnRulesVersion: legacyShape.identity.spawnRulesVersion,
          candidateLayoutVersion: legacyShape.identity.candidateLayoutVersion
        },
        legacyShape.slots
      );
      await completeFixturePlan(first, legacyPlan);
      const oldGeneration = await first.createCurrentGeneration({
        zoneId: fixture.zoneId,
        planId: legacyPlan.planId,
        now: new Date("2099-01-01T00:00:00.000Z")
      });
      expect(oldGeneration.generation.generationNumber).toBe(1);

      const request = requestForPlan(fixture.plan);
      await first.ensurePlanForZone(request);
      const claim = await first.claimPlan(
        request.identity,
        randomUUID(),
        30_000
      );
      if (!claim) throw new Error("legacy mismatch fixture was not claimed");
      const mine = fixture.plan.slots.find((slot) =>
        slot.entityKind === mineKind
      );
      if (!mine) throw new Error(`fixture ${fixture.zoneId} lost ${mineKind}`);
      await expect(first.failPlan(
        claim,
        new PopulationPlanCompletionError(
          "immutable permanent mine authority does not match the incoming plan",
          {
            code: "population-plan-immutable-stone-mismatch",
            retryable: false,
            postgresCode: null,
            constraint: null,
            table: null,
            zoneId: fixture.zoneId,
            planId: fixture.plan.planId,
            spawnRulesVersion: fixture.plan.identity.spawnRulesVersion,
            slotId: mine.slotId,
            entityId: mine.entityId,
            entityKind: mine.entityKind,
            generationId: null,
            claimGeneration: claim.claimGeneration,
            attemptCount: claim.attemptCount
          }
        )
      )).resolves.toMatchObject({
        accepted: true,
        status: "terminal-failure",
        errorCode: "population-plan-immutable-stone-mismatch"
      });
      fixtures.push({
        zoneId: fixture.zoneId,
        currentPlan: fixture.plan,
        legacyPlan
      });
    }

    const snapshotDriftFixture = fixturePlanWithPermanentMine({
      worldEnvironmentIdentityKey: "7".repeat(64),
      worldPipelineSha: "7".repeat(40),
      mineKind: "stone",
      origin: { lat: -50, lon: 60 }
    });
    const snapshotDriftLegacyShape = planWithLegacyCandidateSurface(
      snapshotDriftFixture.plan
    );
    const snapshotDriftLegacyPlan = planForAuthorityVersions(
      snapshotDriftLegacyShape,
      {
        populationPlanVersion:
          "population-zone-plan-compiler-v4-encounter-tables",
          spawnRulesVersion: snapshotDriftLegacyShape.identity.spawnRulesVersion,
          candidateLayoutVersion:
            snapshotDriftLegacyShape.identity.candidateLayoutVersion
        },
      snapshotDriftLegacyShape.slots.map((slot) =>
        isPermanentMineEntityKind(slot.entityKind)
          ? {
              ...slot,
              environmentSnapshot: {
                ...slot.environmentSnapshot,
                habitatSampleVersion: "meaningfully-different-habitat"
              }
            }
          : slot
      )
    );
    await completeFixturePlan(first, snapshotDriftLegacyPlan);
    const snapshotDriftRequest = requestForPlan(snapshotDriftFixture.plan);
    await first.ensurePlanForZone(snapshotDriftRequest);
    const snapshotDriftClaim = await first.claimPlan(
      snapshotDriftRequest.identity,
      randomUUID(),
      30_000
    );
    if (!snapshotDriftClaim) {
      throw new Error("snapshot-drift repair fixture was not claimable");
    }
    const snapshotDriftMine = snapshotDriftFixture.plan.slots.find((slot) =>
      slot.entityKind === "stone"
    );
    if (!snapshotDriftMine) throw new Error("snapshot-drift fixture lost stone");
    await first.failPlan(
      snapshotDriftClaim,
      new PopulationPlanCompletionError(
        "immutable permanent mine authority does not match the incoming plan",
        {
          code: "population-plan-immutable-stone-mismatch",
          retryable: false,
          postgresCode: null,
          constraint: null,
          table: null,
            zoneId: snapshotDriftFixture.zoneId,
            planId: snapshotDriftFixture.plan.planId,
            spawnRulesVersion:
              snapshotDriftFixture.plan.identity.spawnRulesVersion,
            slotId: snapshotDriftMine.slotId,
            entityId: snapshotDriftMine.entityId,
            entityKind: snapshotDriftMine.entityKind,
            generationId: null,
            claimGeneration: snapshotDriftClaim.claimGeneration,
            attemptCount: snapshotDriftClaim.attemptCount
        }
      )
    );

    const repaired = await first.repairCompatiblePermanentStonePlanFailures({
      apply: true
    });
    expect(repaired.affectedPlans.map((plan) => plan.zoneId).sort()).toEqual(
      [
        ...fixtures.map((fixture) => fixture.zoneId),
        snapshotDriftFixture.zoneId
      ].sort()
    );
    const snapshotDriftState = await pool!.query<{
      status: string;
      receipt_count: string;
    }>(
      `SELECT plan.status,
              (
                SELECT count(*)::text
                FROM population_stone_conflict_repair_receipts_v2
                WHERE plan_id=plan.plan_id
              ) AS receipt_count
       FROM population_zones_v2 AS plan
       WHERE plan.plan_id=$1::uuid`,
      [snapshotDriftFixture.plan.planId]
    );
    expect(snapshotDriftState.rows[0]).toEqual({
      status: "retryable-failure",
      receipt_count: "1"
    });
    await expect(first.repairCompatiblePermanentStonePlanFailures({
      apply: true
    })).resolves.toMatchObject({ affectedPlans: [] });

    for (const fixture of fixtures) {
      const request = requestForPlan(fixture.currentPlan);
      const claim = await first.claimPlan(
        request.identity,
        randomUUID(),
        30_000
      );
      if (!claim) throw new Error("repaired v6 fixture was not claimable");
      const regeneratedDraft = {
        ...fixture.currentPlan,
        worldPipelineSha: "f".repeat(40),
        contentHash: ""
      };
      const regeneratedPlan = {
        ...regeneratedDraft,
        contentHash: populationZoneV2PlanContentHash(regeneratedDraft)
      };
      await first.completePlan(claim, regeneratedPlan);
      const nextGeneration = await first.createCurrentGeneration({
        zoneId: fixture.zoneId,
        planId: fixture.currentPlan.planId,
        now: new Date("2099-01-04T00:00:00.000Z")
      });
      expect(nextGeneration.generation.generationNumber).toBe(2);
      expect(nextGeneration.generation.planId).toBe(fixture.currentPlan.planId);
      const authority = await pool!.query<{
        selected_plan_id: string;
        current_status: string;
        legacy_status: string;
        receipt_count: string;
      }>(
        `SELECT cutover.selected_plan_id,
                current_plan.status AS current_status,
                legacy_plan.status AS legacy_status,
                (
                  SELECT count(*)::text
                  FROM population_stone_conflict_repair_receipts_v2
                  WHERE plan_id=current_plan.plan_id
                ) AS receipt_count
         FROM population_zone_cutovers_v2 AS cutover
         JOIN population_zones_v2 AS current_plan
           ON current_plan.plan_id=$2::uuid
         JOIN population_zones_v2 AS legacy_plan
           ON legacy_plan.plan_id=$3::uuid
         WHERE cutover.zone_id=$1`,
        [fixture.zoneId, fixture.currentPlan.planId, fixture.legacyPlan.planId]
      );
      expect(authority.rows[0]).toEqual({
        selected_plan_id: fixture.currentPlan.planId,
        current_status: "ready",
        legacy_status: "ready",
        receipt_count: "1"
      });
    }
  }, 120_000);

  it("serializes twenty arrivals into one replayable fixed 48-hour generation", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).createCurrentGeneration({
          zoneId,
          planId: plan.planId,
          now: generatedAt
        })
      )
    );
    expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
    expect(new Set(attempts.map((attempt) =>
      attempt.generation.generationId
    )).size).toBe(1);
    expect(new Set(attempts.map((attempt) =>
      JSON.stringify(attempt.entityIds)
    )).size).toBe(1);
    const generation = attempts[0]!.generation;
    expect(generation.generationNumber).toBe(1);
    expect(generation.generatedAt).toEqual(generatedAt);
    expect(generation.expiresAt.getTime() - generation.generatedAt.getTime())
      .toBe(POPULATION_ZONE_V2_GENERATION_DURATION_MS);
    expect(generation.commonSchemaRevision).toBe(
      "population-common-schema-v2-encounter-identity"
    );
    const kindManifests = await pool!.query<{
      entity_kind: string;
      placement_revision: string;
      lifecycle_revision: string;
      source: string;
      group_atomic: boolean;
    }>(
      `SELECT DISTINCT slot.entity_kind,
              manifest.placement_revision,
              manifest.lifecycle_revision,
              manifest.source,
              manifest.group_atomic
       FROM population_spawn_slots_v2 AS slot
       JOIN population_generation_kind_manifest_v2 AS manifest
         ON manifest.generation_id=slot.generation_id
        AND manifest.kind_key=slot.entity_kind
       WHERE slot.generation_id=$1::uuid
       ORDER BY slot.entity_kind`,
      [generation.generationId]
    );
    expect(kindManifests.rows.length).toBeGreaterThan(0);
    expect(kindManifests.rows.every((manifest) =>
      manifest.placement_revision.length > 0
      && manifest.lifecycle_revision.length > 0
      && manifest.source === "generation"
    )).toBe(true);
    expect(kindManifests.rows.filter((manifest) =>
      ["sap_crawler", "wolf"].includes(manifest.entity_kind)
    ).every((manifest) => manifest.group_atomic)).toBe(true);
    const manifests = await pool!.query<{
      mob_kind: string;
      rollout_revision: string;
      source: string;
      status: string;
      target_group_count: number;
      inserted_group_count: number;
      inserted_body_count: number;
      shortfall_group_count: number;
      attempt_count: number;
    }>(
      `SELECT mob_kind, rollout_revision, source, status,
              target_group_count, inserted_group_count,
              inserted_body_count, shortfall_group_count, attempt_count
       FROM population_generation_mob_rollouts_v2
       WHERE generation_id=$1::uuid
       ORDER BY mob_kind, rollout_revision`,
      [generation.generationId]
    );
    expect(manifests.rows.length).toBeGreaterThan(0);
    const persistedKinds = await pool!.query<{ entity_kind: string; groups: string; bodies: string }>(
      `SELECT entity_kind, count(DISTINCT encounter_id)::text AS groups,
              count(*)::text AS bodies
       FROM population_spawn_slots_v2
       WHERE generation_id=$1::uuid AND entity_kind<>'tree'
       GROUP BY entity_kind ORDER BY entity_kind`, [generation.generationId]
    );
    expect(manifests.rows.map((entry) => entry.mob_kind))
      .toEqual(persistedKinds.rows.map((entry) => entry.entity_kind));
    for (const manifest of manifests.rows) {
      const definition = POPULATION_V2_MOB_DEFINITIONS.find((entry) => entry.mobKind === manifest.mob_kind)!;
      const persisted = persistedKinds.rows.find((entry) => entry.entity_kind === manifest.mob_kind)!;
      expect(manifest).toMatchObject({
        rollout_revision: definition.placementRevision,
        source: "generation", status: "completed", attempt_count: 1,
        inserted_group_count: Number(persisted.groups),
        inserted_body_count: Number(persisted.bodies)
      });
      expect(manifest.inserted_group_count + manifest.shortfall_group_count)
        .toBe(manifest.target_group_count);
      await expect(pool!.query(
        `SELECT DISTINCT mob_archetype, placement_version FROM generated_world_mobs
         WHERE population_v2_entity_id IN (SELECT entity_id FROM population_spawn_slots_v2
           WHERE generation_id=$1::uuid AND entity_kind=$2)`,
        [generation.generationId, manifest.mob_kind]
      )).resolves.toMatchObject({ rows: [{
        mob_archetype: definition.combatArchetype,
        placement_version: definition.placementRevision
      }] });
    }

    const replay = await first.createCurrentGeneration({
      zoneId,
      planId: plan.planId,
      now: new Date(generatedAt.getTime() + 12 * 60 * 60_000)
    });
    expect(replay.created).toBe(false);
    expect(replay.generation).toEqual(generation);
    expect(replay.entityIds).toEqual(attempts[0]!.entityIds);
    const restartedStore = new PostgresPopulationZonesV2Store(pool!);
    const afterRuntimeRestart = await restartedStore.createCurrentGeneration({
      zoneId,
      planId: plan.planId,
      now: new Date(generatedAt.getTime() + 24 * 60 * 60_000)
    });
    expect(afterRuntimeRestart.created).toBe(false);
    expect(afterRuntimeRestart.generation).toEqual(generation);
    expect(afterRuntimeRestart.entityIds).toEqual(attempts[0]!.entityIds);
    expect(generation.plannedNonStoneCount)
      .toBe(attempts[0]!.entityIds.length);
    const diagnostics = await first.loadZonePopulationDiagnostics([{
      zoneId,
      planId: plan.planId
    }]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      sapCrawlerAllocatedCandidates:
        plan.sapCrawlerDiagnostics!.allocatedCandidates,
      sapCrawlerNoEligibleClusterCandidates:
        plan.sapCrawlerDiagnostics!.noEligibleClusterCandidates,
      sapCrawlerInsufficientValidSiteCandidates:
        plan.sapCrawlerDiagnostics!.insufficientValidSiteCandidates,
      sapCrawlerConflictRejectedCandidates:
        plan.sapCrawlerDiagnostics!.conflictRejectedCandidates,
      sapCrawlerPlannedGroupCount:
        plan.sapCrawlerDiagnostics!.finalPlannedGroups,
      sapCrawlerPlannedMemberCount:
        plan.sapCrawlerDiagnostics!.finalPlannedMembers,
      sapCrawlerPlacementShortfallGroups:
        plan.sapCrawlerDiagnostics!.placementShortfallGroups
    });
    expect(diagnostics[0]!.sapCrawlerInsertedGroupCount)
      .toBeLessThanOrEqual(diagnostics[0]!.sapCrawlerPlannedGroupCount);
    expect(diagnostics[0]!.sapCrawlerReadyMemberCount)
      .toBeLessThanOrEqual(diagnostics[0]!.sapCrawlerPlannedMemberCount);
    expect(diagnostics[0]!.sapCrawlerLeasedActorCount).toBe(0);
    expect(diagnostics[0]!.registeredMobs).toEqual(manifests.rows.map((manifest) => {
      const definition = POPULATION_V2_MOB_DEFINITIONS.find((entry) => entry.mobKind === manifest.mob_kind)!;
      return expect.objectContaining({
        mobKind: manifest.mob_kind, diagnosticsLabel: definition.diagnosticsLabel,
        placementRevision: definition.placementRevision,
        source: "generation", status: manifest.status
      });
    }));
  });

  it("claims one durable V2 combat profile per living mob life and preserves pack identity", async () => {
    const fastFirst = new PostgresPopulationZonesV2Store(
      pool!,
      undefined,
      undefined,
      { profileClaimNoopFastPathEnabled: true }
    );
    const fastSecond = new PostgresPopulationZonesV2Store(
      pool!,
      undefined,
      undefined,
      { profileClaimNoopFastPathEnabled: true }
    );
    await first.createCurrentGeneration({
      zoneId,
      planId: plan.planId,
      now: generatedAt
    });
    const before = await pool!.query<{
      living_count: string;
      unclaimed_count: string;
    }>(
      `SELECT count(*)::text AS living_count,
              count(*) FILTER (WHERE combat_level IS NULL)::text AS unclaimed_count
       FROM generated_world_mobs
       WHERE physical_population_zone_v2_id=$1
         AND killed_at IS NULL
         AND NOT population_v2_suppressed`,
      [zoneId]
    );
    expect(Number(before.rows[0]!.living_count)).toBeGreaterThan(0);
    expect(before.rows[0]!.unclaimed_count).toBe(before.rows[0]!.living_count);

    await expect(fastFirst.claimMobCombatProfilesForZones([{
      zoneId,
      level: 16,
      source: "zone_player_profile"
    }])).resolves.toBe(Number(before.rows[0]!.living_count));
    const claimed = await pool!.query<{
      level: number;
      tier: string;
      version: number;
      source: string;
    }>(
      `SELECT DISTINCT combat_level AS level,
                       combat_tier AS tier,
                       combat_balance_version AS version,
                       combat_profile_source AS source
       FROM generated_world_mobs
       WHERE physical_population_zone_v2_id=$1
         AND killed_at IS NULL
         AND NOT population_v2_suppressed`,
      [zoneId]
    );
    expect(claimed.rows).toEqual([{
      level: 16,
      tier: "epic",
      version: 2,
      source: "zone_player_profile"
    }]);
    await expect(fastFirst.claimMobCombatProfilesForZones([{
      zoneId,
      level: 25,
      source: "zone_player_profile"
    }])).resolves.toBe(0);
    const mixedFixture = fixturePlanWithoutPermanentStone({
      worldEnvironmentIdentityKey: "d".repeat(64),
      worldPipelineSha,
      origin: { lat: 37.7749, lon: -122.4194 }
    });
    await completeFixturePlan(first, mixedFixture.plan);
    await first.createCurrentGeneration({
      zoneId: mixedFixture.zoneId,
      planId: mixedFixture.plan.planId,
      now: generatedAt
    });
    const mixedLiving = await pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM generated_world_mobs
       WHERE physical_population_zone_v2_id=$1
         AND killed_at IS NULL
         AND NOT population_v2_suppressed`,
      [mixedFixture.zoneId]
    );
    await expect(fastFirst.claimMobCombatProfilesForZones([
      {
        zoneId,
        level: 25,
        source: "zone_player_profile"
      },
      {
        zoneId: mixedFixture.zoneId,
        level: 9,
        source: "zone_player_profile"
      }
    ])).resolves.toBe(Number(mixedLiving.rows[0]!.count));

    const pack = await pool!.query<{
      pack_id: string;
      entity_id: string;
    }>(
      `SELECT pack_id::text, entity_id
       FROM generated_world_mobs
       WHERE physical_population_zone_v2_id=$1
         AND killed_at IS NULL
         AND NOT population_v2_suppressed
         AND pack_id IS NOT NULL
       ORDER BY pack_id, entity_id
       LIMIT 1`,
      [zoneId]
    );
    expect(pack.rowCount).toBe(1);
    await pool!.query(
      `UPDATE generated_world_mobs
       SET combat_level=NULL,
           combat_tier=NULL,
           combat_balance_version=NULL,
           combat_profile_claimed_at=NULL,
           combat_profile_source=NULL
       WHERE entity_id=$1`,
      [pack.rows[0]!.entity_id]
    );
    const concurrentRepair = await Promise.all([
      fastFirst.claimMobCombatProfilesForZones([{
        zoneId,
        level: 25,
        source: "zone_player_profile"
      }]),
      fastSecond.claimMobCombatProfilesForZones([{
        zoneId,
        level: 22,
        source: "zone_player_profile"
      }])
    ]);
    expect(concurrentRepair.sort()).toEqual([0, 1]);
    const repairedPack = await pool!.query<{
      distinct_levels: string;
      minimum_level: number;
      maximum_level: number;
    }>(
      `SELECT count(DISTINCT combat_level)::text AS distinct_levels,
              min(combat_level)::integer AS minimum_level,
              max(combat_level)::integer AS maximum_level
       FROM generated_world_mobs
       WHERE pack_id=$1`,
      [pack.rows[0]!.pack_id]
    );
    expect(repairedPack.rows[0]).toEqual({
      distinct_levels: "1",
      minimum_level: 16,
      maximum_level: 16
    });
  });

  it("keeps a changed mob definition out of current life and adopts it next generation", async () => {
    const fixture = fixturePlanWithoutPermanentStone({
      worldEnvironmentIdentityKey: "b".repeat(64),
      worldPipelineSha,
      origin: { lat: 39.7392, lon: -104.9903 },
      requiredNextGenerationKind: "hog"
    });
    await completeFixturePlan(first, fixture.plan);
    const initial = await first.createCurrentGeneration({
      zoneId: fixture.zoneId,
      planId: fixture.plan.planId,
      now: new Date("2099-01-28T00:00:00.000Z")
    });
    const hogDefinition = {
      ...POPULATION_V2_MOB_DEFINITIONS.find((definition) => definition.mobKind === "hog")!,
      placementRevision: "encounter-v2-test-hog-single-v1"
    } satisfies PopulationV2MobDefinition;
    const registry = createPopulationV2MobRegistry(
      POPULATION_V2_MOB_DEFINITIONS.map((definition) =>
        definition.mobKind === "hog" ? hogDefinition : definition
      )
    );
    const store = new PostgresPopulationZonesV2Store(
      pool!,
      generatePopulationZoneV2GenerationSlots,
      registry
    );

    const unchanged = await store.createCurrentGeneration({
      zoneId: fixture.zoneId,
      planId: fixture.plan.planId,
      now: new Date("2099-01-28T00:01:00.000Z")
    });
    expect(unchanged).toMatchObject({
      created: false,
      generation: { generationId: initial.generation.generationId }
    });
    expect(unchanged.entityIds).toEqual(initial.entityIds);
    await expect(pool!.query(
      `SELECT 1
       FROM population_generation_mob_rollouts_v2
       WHERE generation_id=$1::uuid
         AND mob_kind='hog' AND rollout_revision='encounter-v2-test-hog-single-v1'`,
      [initial.generation.generationId]
    )).resolves.toMatchObject({ rowCount: 0 });

    const rolloverAt = initial.generation.expiresAt;
    await first.markGenerationExpired({
      zoneId: fixture.zoneId,
      generationId: initial.generation.generationId,
      currentReferences: 0,
      now: rolloverAt,
      unreferencedAt: rolloverAt
    });
    await expect(first.cleanupExpiredGeneration({
      zoneId: fixture.zoneId,
      generationId: initial.generation.generationId,
      unreferenced: true,
      now: new Date(
        rolloverAt.getTime()
          + POPULATION_ZONE_V2_GENERATION_CLEANUP_GRACE_MS
      )
    })).resolves.toBe(true);

    const materialization = await store.createCurrentGeneration({
      zoneId: fixture.zoneId,
      planId: fixture.plan.planId,
      now: new Date(
        rolloverAt.getTime()
          + POPULATION_ZONE_V2_GENERATION_CLEANUP_GRACE_MS
          + 1
      )
    });
    expect(materialization.created).toBe(true);
    expect(materialization.generation.generationId)
      .not.toBe(initial.generation.generationId);
    const persisted = await pool!.query<{
      entity_kind: string;
      archetype: string;
      mob_archetype: string;
      placement_version: string;
      rollout_revision: string;
    }>(
      `SELECT slot.entity_kind, slot.archetype,
              projection.mob_archetype, projection.placement_version,
              manifest.rollout_revision
       FROM population_spawn_slots_v2 AS slot
       JOIN generated_world_mobs AS projection
         ON projection.population_v2_entity_id=slot.entity_id
       JOIN population_generation_mob_rollouts_v2 AS manifest
         ON manifest.generation_id=slot.generation_id
        AND manifest.mob_kind=slot.entity_kind
       WHERE slot.generation_id=$1::uuid
         AND slot.entity_kind='hog'
       ORDER BY slot.entity_id`,
      [materialization.generation.generationId]
    );
    expect(persisted.rows.length).toBeGreaterThan(0);
    expect(new Set(persisted.rows.map((row) => JSON.stringify(row))))
      .toEqual(new Set([JSON.stringify({
        entity_kind: "hog",
        archetype: "hog",
        mob_archetype: "hog",
        placement_version: "encounter-v2-test-hog-single-v1",
        rollout_revision: "encounter-v2-test-hog-single-v1"
      })]));
  });

  it.each(["legacy-unverified", "legacy-sap-reroll"])(
    "preserves retained %s lives across concurrent maintenance and restart", async (revision) => {
      const fixture = fixturePlanWithoutPermanentStone({
        worldEnvironmentIdentityKey: (revision === "legacy-unverified" ? "e" : "1").repeat(64),
        worldPipelineSha: "9".repeat(40)
      });
      const retainedPlan = revision === "legacy-sap-reroll"
        ? planWithSapCrawlerGroups(fixture.plan, 3) : fixture.plan;
      await completeFixturePlan(first, retainedPlan);
      const initial = await first.createCurrentGeneration({
        zoneId: fixture.zoneId, planId: retainedPlan.planId,
        now: new Date("2099-03-01T00:00:00.000Z")
      });
      const generated = generatePopulationZoneV2GenerationSlots({
        template: retainedPlan, generationId: initial.generation.generationId,
        generationNumber: initial.generation.generationNumber, includeLegacySapCrawler: true
      });
      const retained = revision === "legacy-sap-reroll"
        ? generated.slots : underfilledPopulation(generated.slots);
      expect(retained.length).toBeGreaterThan(0);
      if (revision === "legacy-sap-reroll") {
        expect(retained.filter((slot) => slot.entityKind === "sap_crawler")).toHaveLength(15);
      } else {
        expect(retained.length).toBeLessThan(generated.slots.length);
      }
      await replaceHistoricalGenerationFixture(pool!, retainedPlan, initial.generation.generationId, retained);
      await pool!.query("UPDATE population_zone_generations_v2 SET materialization_revision=$2 WHERE generation_id=$1::uuid", [initial.generation.generationId, revision]);
      const victim = retained.find((slot) => slot.entityKind !== "tree")!;
      expect(victim).toBeDefined();
      await first.transitionEntityState({ entityId: victim.entityId, expectedStateRevision: 0,
        state: "dead", eventAt: new Date("2099-03-01T01:00:00.000Z") });
      const before = await historicalGenerationSnapshot(pool!, initial.generation.generationId);
      const request = { zoneId: fixture.zoneId, planId: retainedPlan.planId };
      const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).reconcileCurrentGenerationDensity(request)
      ));
      for (const attempt of attempts) {
        expect(attempt.created).toBe(false);
        expect(attempt.generation.generationId).toBe(initial.generation.generationId);
        expect(attempt.generation.materializationRevision).toBe(revision);
        expect(attempt.entityIds).toEqual(retained.map((slot) => slot.entityId).sort());
      }
      expect(await historicalGenerationSnapshot(pool!, initial.generation.generationId)).toEqual(before);
      const restarted = new PostgresPopulationZonesV2Store(pool!);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const replay = await restarted.createCurrentGeneration(request);
        expect(replay.created).toBe(false);
        expect(replay.entityIds).toEqual(retained.map((slot) => slot.entityId).sort());
      }
      expect(await historicalGenerationSnapshot(pool!, initial.generation.generationId)).toEqual(before);
    }
  );

  it("completes a stone-free zone with an active neighboring plan", async () => {
    const environmentKey = "7".repeat(64);
    const pipelineSha = "e".repeat(40);
    const stoneFree = fixturePlanWithoutPermanentStone({
      worldEnvironmentIdentityKey: environmentKey,
      worldPipelineSha: pipelineSha,
      origin: { lat: 43.6532, lon: -79.3832 }
    });
    const neighborZoneId = populationZoneV2Halo(stoneFree.zoneId, 1)
      .find((candidate) => candidate !== stoneFree.zoneId);
    if (!neighborZoneId) throw new Error("neighbor fixture is missing");
    const neighborPlan = generatePopulationZoneV2Plan({
      zoneId: neighborZoneId,
      worldEnvironmentIdentityKey: environmentKey,
      worldPipelineSha: pipelineSha,
      habitatForZone: (candidate) =>
        populationZoneV3ConservativeHabitat({
          zoneId: candidate,
          worldEnvironmentIdentityKey: environmentKey
        })
    });
    await completeFixturePlan(first, neighborPlan);
    await first.createCurrentGeneration({
      zoneId: neighborZoneId,
      planId: neighborPlan.planId,
      now: new Date("2099-01-10T00:00:00.000Z")
    });
    await completeFixturePlan(second, stoneFree.plan);
    const generation = await second.createCurrentGeneration({
      zoneId: stoneFree.zoneId,
      planId: stoneFree.plan.planId,
      now: new Date("2099-01-10T00:00:00.000Z")
    });
    const result = await pool!.query<{
      status: string;
      stone_memberships: string;
      relevant_ready_plans: string;
    }>(
      `SELECT plan.status,
              (
                SELECT count(*)::text
                FROM population_plan_permanent_stones_v2 AS membership
                JOIN population_permanent_stone_authority_v2 AS resource
                  ON resource.entity_id=membership.entity_id
                WHERE membership.plan_id=plan.plan_id
                  AND resource.entity_kind='stone'
              ) AS stone_memberships,
              (
                SELECT count(*)::text
                FROM population_zones_v2 AS relevant
                WHERE relevant.plan_id=ANY($2::uuid[])
                  AND relevant.status='ready'
              ) AS relevant_ready_plans
       FROM population_zones_v2 AS plan
       WHERE plan.plan_id=$1::uuid`,
      [
        stoneFree.plan.planId,
        [stoneFree.plan.planId, neighborPlan.planId]
      ]
    );
    expect(result.rows[0]).toEqual({
      status: "ready",
      stone_memberships: "0",
      relevant_ready_plans: "2"
    });
    expect(generation.generation.plannedNonStoneCount).toBeGreaterThan(0);
  });

  it("never individually respawns non-stone entities", async () => {
    const entities = await first.loadReadyEntitiesForZones([zoneId]);
    const tree = entities.find((entity) => entity.entityKind === "tree");
    const mob = entities.find((entity) =>
      entity.entityKind === "deer"
      || entity.entityKind === "wolf"
      || entity.entityKind === "ogre"
    );
    expect(tree).toBeDefined();
    expect(mob).toBeDefined();
    const eventAt = new Date("2099-01-02T04:00:00.000Z");

    for (const [target, state] of [
      [tree!, "harvested"],
      [mob!, "dead"]
    ] as const) {
      await expect(first.transitionEntityState({
        entityId: target.entityId,
        expectedStateRevision: target.stateRevision,
        state,
        eventAt,
        respawnAt: new Date(eventAt.getTime() + 1)
      })).rejects.toThrow("never receive a respawn timestamp");

      const transitioned = await first.transitionEntityState({
        entityId: target.entityId,
        expectedStateRevision: target.stateRevision,
        state,
        eventAt
      });
      expect(transitioned).toMatchObject({
        entityId: target.entityId,
        respawnAt: null
      });
    }
    await expect(first.respawnDueEntitiesForZones([zoneId]))
      .resolves.toEqual([]);
    const remaining = await first.loadReadyEntitiesForZones([zoneId]);
    expect(remaining.some((entity) =>
      entity.entityId === tree!.entityId
      || entity.entityId === mob!.entityId
    )).toBe(false);
  });

  it("defers replacement while referenced, cleans after grace, then rotates within cap", async () => {
    const current = (await first.loadCurrentGenerations([zoneId]))[0]!;
    const suppressedSlot = await pool!.query<{
      entity_id: string;
      entity_kind: string;
    }>(
      `SELECT entity_id, entity_kind
       FROM population_spawn_slots_v2
       WHERE generation_id=$1::uuid
       ORDER BY entity_id
       LIMIT 1`,
      [current.generationId]
    );
    const suppressionEntity = suppressedSlot.rows[0];
    if (suppressionEntity === undefined) {
      throw new Error("fixture generation has no suppressible entity");
    }
    await pool!.query(
      `INSERT INTO population_river_water_suppressions_v1 (
         entity_id, entity_kind, generation_id, river_release_id,
         river_manifest_sha256, river_row_id, river_column_id
       ) VALUES ($1::uuid, $2, $3::uuid, 'river-surface-v1', $4, 1, 2)`,
      [
        suppressionEntity.entity_id,
        suppressionEntity.entity_kind,
        current.generationId,
        "a".repeat(64)
      ]
    );
    const suppressionBefore = await pool!.query(
      `SELECT * FROM population_river_water_suppressions_v1
       WHERE entity_id=$1::uuid`,
      [suppressionEntity.entity_id]
    );
    const firstPositions = await generationPositions(
      pool!,
      current.generationId
    );
    const stonePositions = await permanentStonePositions(pool!, plan.planId);
    const expiredAt = new Date(current.expiresAt.getTime() + 1);
    await expect(first.loadDueCurrentGenerations({
      now: new Date(current.expiresAt.getTime() - 1),
      limit: 1
    })).resolves.toEqual([]);
    await expect(first.loadDueCurrentGenerations({
      now: expiredAt,
      limit: 1
    })).resolves.toEqual([current]);
    await expect(first.updateCurrentGenerationReferences({
      references: [{
        zoneId,
        currentReferences: 2
      }],
      now: expiredAt
    })).resolves.toBe(1);
    await expect(first.loadCurrentGenerations([zoneId]))
      .resolves.toContainEqual(expect.objectContaining({
        currentReferenceCount: 2,
        unreferencedAt: null
      }));
    const pending = await first.markGenerationExpired({
      zoneId,
      generationId: current.generationId,
      currentReferences: 2,
      now: expiredAt
    });
    expect(pending).toMatchObject({
      status: "refresh-pending",
      currentReferenceCount: 2,
      isCurrent: true
    });
    const blockedReplacement = await second.createCurrentGeneration({
      zoneId,
      planId: plan.planId,
      now: expiredAt
    });
    expect(blockedReplacement.created).toBe(false);
    expect(blockedReplacement.generation.generationId)
      .toBe(current.generationId);

    await expect(first.cleanupExpiredGeneration({
      zoneId,
      generationId: current.generationId,
      unreferenced: false,
      now: expiredAt
    })).rejects.toThrow("requires an unreferenced zone");
    await expect(first.cleanupExpiredGeneration({
      zoneId,
      generationId: current.generationId,
      unreferenced: true,
      now: new Date(
        current.expiresAt.getTime()
          + POPULATION_ZONE_V2_GENERATION_CLEANUP_GRACE_MS
          + 1
      )
    })).resolves.toBe(false);
    const unreferencedAt = new Date(expiredAt.getTime() + 1_000);
    const expired = await first.markGenerationExpired({
      zoneId,
      generationId: current.generationId,
      currentReferences: 0,
      now: unreferencedAt
    });
    expect(expired).toMatchObject({
      status: "expired",
      currentReferenceCount: 0,
      unreferencedAt
    });
    await expect(first.cleanupExpiredGeneration({
      zoneId,
      generationId: current.generationId,
      unreferenced: true,
      now: new Date(
        unreferencedAt.getTime()
          + POPULATION_ZONE_V2_GENERATION_CLEANUP_GRACE_MS
          - 1
      )
    })).resolves.toBe(false);
    const cleanupAt = new Date(
      unreferencedAt.getTime()
        + POPULATION_ZONE_V2_GENERATION_CLEANUP_GRACE_MS
    );
    await expect(first.cleanupExpiredGeneration({
      zoneId,
      generationId: current.generationId,
      unreferenced: true,
      now: cleanupAt
    })).resolves.toBe(true);
    await expect(generationPositions(pool!, current.generationId))
      .resolves.toEqual([]);
    await expect(pool!.query(
      `SELECT * FROM population_river_water_suppressions_v1
       WHERE entity_id=$1::uuid`,
      [suppressionEntity.entity_id]
    )).resolves.toMatchObject({ rows: suppressionBefore.rows });

    const next = await first.createCurrentGeneration({
      zoneId,
      planId: plan.planId,
      now: new Date(cleanupAt.getTime() + 1)
    });
    expect(next.created).toBe(true);
    expect(next.generation.generationNumber).toBe(2);
    expect(next.generation.generationId).not.toBe(current.generationId);
    expect(next.generation.plannedNonStoneCount).toBeLessThanOrEqual(
      plan.slots.filter((slot) => slot.entityKind !== "stone").length
    );
    const secondPositions = await generationPositions(
      pool!,
      next.generation.generationId
    );
    expect(secondPositions).not.toEqual(firstPositions);
    await expect(permanentStonePositions(pool!, plan.planId))
      .resolves.toEqual(stonePositions);
  });

  it("atomically rolls an occupied expired generation onto a new plan revision", async () => {
    const fixture = fixturePlanWithPermanentStone({
      worldEnvironmentIdentityKey: "9".repeat(64),
      worldPipelineSha: "9".repeat(40),
      origin: { lat: 34.0522, lon: -118.2437 }
    });
    const nextPlan = planForSpawnRules(
      fixture.plan,
      "population-spawn-rules-v2-rollover-plan-b",
      fixture.plan.slots.filter((slot) =>
        !isPermanentMineEntityKind(slot.entityKind)
      )
    );
    const priorPlan = planForSpawnRules(
      fixture.plan,
      "population-spawn-rules-v2-rollover-plan-a",
      fixture.plan.slots
    );
    await completeFixturePlan(first, priorPlan);
    const current = (await first.createCurrentGeneration({
      zoneId: fixture.zoneId,
      planId: priorPlan.planId,
      now: new Date("2099-04-01T00:00:00.000Z"),
      currentReferences: 3
    })).generation;
    const stone = (await first.loadReadyEntitiesForZones([fixture.zoneId]))
      .find((entity) => entity.entityKind === "stone");
    expect(stone).toBeDefined();
    const harvested = await first.transitionEntityState({
      entityId: stone!.entityId,
      expectedStateRevision: stone!.stateRevision,
      state: "harvested",
      eventAt: new Date("2099-04-01T01:00:00.000Z"),
      durableRuntimeState: {
        rolloverFixture: "preserved",
        cooldownOwner: "permanent-stone"
      }
    });
    expect(harvested).not.toBeNull();
    await completeFixturePlan(first, nextPlan);
    const cutoverBefore = (await pool!.query<{
      cutover_revision: string | number;
      selected_plan_id: string;
    }>(
      `SELECT cutover_revision, selected_plan_id
       FROM population_zone_cutovers_v2
       WHERE zone_id=$1 AND serving_version='v2'`,
      [fixture.zoneId]
    )).rows[0]!;
    expect(cutoverBefore.selected_plan_id).toBe(priorPlan.planId);
    const stoneBefore = (await pool!.query<{
      latitude: number | string;
      longitude: number | string;
      state: string;
      state_revision: string | number;
      durable_runtime_state: Record<string, unknown>;
      respawn_at: Date;
      ready_at: Date;
    }>(
      `SELECT slot.latitude, slot.longitude, state.state,
              state.state_revision, state.durable_runtime_state,
              state.respawn_at, projection.ready_at
       FROM population_spawn_slots_v2 AS slot
       JOIN population_entity_state_v2 AS state
         ON state.entity_id=slot.entity_id
       JOIN repeatable_resource_nodes AS projection
         ON projection.population_v2_entity_id=slot.entity_id
       WHERE slot.entity_id=$1::uuid`,
      [stone!.entityId]
    )).rows[0]!;
    const retiredEntityIds = (await pool!.query<{ entity_id: string }>(
      `SELECT entity_id
       FROM population_spawn_slots_v2
       WHERE generation_id=$1::uuid
       ORDER BY entity_id`,
      [current.generationId]
    )).rows.map((row) => row.entity_id);
    const rolloverAt = new Date(current.expiresAt.getTime() + 1);
    await first.updateCurrentGenerationReferences({
      references: [{ zoneId: fixture.zoneId, currentReferences: 3 }],
      now: rolloverAt
    });
    await first.markGenerationExpired({
      zoneId: fixture.zoneId,
      generationId: current.generationId,
      currentReferences: 3,
      now: rolloverAt
    });

    const results = await Promise.all([
      first.createCurrentGeneration({
        zoneId: fixture.zoneId,
        planId: nextPlan.planId,
        now: rolloverAt,
        currentReferences: 3,
        replaceExpiredReferencedGeneration: true
      }),
      second.createCurrentGeneration({
        zoneId: fixture.zoneId,
        planId: nextPlan.planId,
        now: rolloverAt,
        currentReferences: 3,
        replaceExpiredReferencedGeneration: true
      })
    ]);
    const replacement = results.find((result) => result.created);
    expect(replacement).toBeDefined();
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.map((result) => result.generation.generationId))
      .toEqual([
        replacement!.generation.generationId,
        replacement!.generation.generationId
      ]);
    expect(replacement!.retiredEntityIds).toEqual(retiredEntityIds);
    expect(replacement!.generation).toMatchObject({
      generationNumber: current.generationNumber + 1,
      planId: nextPlan.planId,
      status: "active",
      currentReferenceCount: 3,
      isCurrent: true
    });
    expect(
      replacement!.generation.expiresAt.getTime()
        - replacement!.generation.generatedAt.getTime()
    ).toBe(POPULATION_ZONE_V2_GENERATION_DURATION_MS);

    await expect(pool!.query(
      `SELECT status, is_current, current_reference_count, cleaned_at
       FROM population_zone_generations_v2
       WHERE generation_id=$1::uuid`,
      [current.generationId]
    )).resolves.toMatchObject({
      rows: [{
        status: "expired",
        is_current: false,
        current_reference_count: 0,
        cleaned_at: expect.any(Date)
      }]
    });
    await expect(generationPositions(pool!, current.generationId))
      .resolves.toEqual([]);
    await expect(first.loadCurrentGenerations([fixture.zoneId]))
      .resolves.toEqual([replacement!.generation]);

    const cutoverAfter = (await pool!.query<{
      cutover_revision: string | number;
      selected_plan_id: string;
    }>(
      `SELECT cutover_revision, selected_plan_id
       FROM population_zone_cutovers_v2
       WHERE zone_id=$1 AND serving_version='v2'`,
      [fixture.zoneId]
    )).rows[0]!;
    expect(cutoverAfter.selected_plan_id).toBe(nextPlan.planId);
    expect(Number(cutoverAfter.cutover_revision))
      .toBe(Number(cutoverBefore.cutover_revision) + 1);
    const projectionAuthority = await pool!.query<{
      projection_kind: string;
      projection_count: string;
      wrong_plan_count: string;
      wrong_revision_count: string;
    }>(
      `SELECT 'tree' AS projection_kind,
              count(*)::text AS projection_count,
              count(*) FILTER (
                WHERE population_v2_plan_id<>$2::uuid
              )::text AS wrong_plan_count,
              count(*) FILTER (
                WHERE population_cutover_revision<>$3
              )::text AS wrong_revision_count
       FROM collectible_nodes
       WHERE population_v2_entity_id=ANY($1::uuid[])
       UNION ALL
       SELECT 'mob' AS projection_kind,
              count(*)::text AS projection_count,
              count(*) FILTER (
                WHERE population_v2_plan_id<>$2::uuid
              )::text AS wrong_plan_count,
              count(*) FILTER (
                WHERE population_cutover_revision<>$3
              )::text AS wrong_revision_count
       FROM generated_world_mobs
       WHERE population_v2_entity_id=ANY($1::uuid[])
       ORDER BY projection_kind`,
      [
        replacement!.entityIds,
        nextPlan.planId,
        Number(cutoverAfter.cutover_revision)
      ]
    );
    expect(projectionAuthority.rows).toEqual([
      {
        projection_kind: "mob",
        projection_count: expect.not.stringMatching(/^0$/u),
        wrong_plan_count: "0",
        wrong_revision_count: "0"
      },
      {
        projection_kind: "tree",
        projection_count: expect.not.stringMatching(/^0$/u),
        wrong_plan_count: "0",
        wrong_revision_count: "0"
      }
    ]);
    expect(projectionAuthority.rows.reduce(
      (count, row) => count + Number(row.projection_count),
      0
    )).toBe(replacement!.entityIds.length);

    const stoneAfter = (await pool!.query<
      typeof stoneBefore & { population_cutover_revision: string | number }
    >(
      `SELECT slot.latitude, slot.longitude, state.state,
              state.state_revision, state.durable_runtime_state,
              state.respawn_at, projection.ready_at,
              projection.population_cutover_revision
       FROM population_spawn_slots_v2 AS slot
       JOIN population_entity_state_v2 AS state
         ON state.entity_id=slot.entity_id
       JOIN repeatable_resource_nodes AS projection
         ON projection.population_v2_entity_id=slot.entity_id
       WHERE slot.entity_id=$1::uuid`,
      [stone!.entityId]
    )).rows[0]!;
    expect({
      latitude: stoneAfter.latitude,
      longitude: stoneAfter.longitude,
      state: stoneAfter.state,
      state_revision: stoneAfter.state_revision,
      durable_runtime_state: stoneAfter.durable_runtime_state,
      respawn_at: stoneAfter.respawn_at,
      ready_at: stoneAfter.ready_at
    }).toEqual(stoneBefore);
    expect(Number(stoneAfter.population_cutover_revision))
      .toBe(Number(cutoverAfter.cutover_revision));

    const replay = await first.createCurrentGeneration({
      zoneId: fixture.zoneId,
      planId: nextPlan.planId,
      now: rolloverAt,
      currentReferences: 3,
      replaceExpiredReferencedGeneration: true
    });
    expect(replay.created).toBe(false);
    expect(replay.generation.generationId)
      .toBe(replacement!.generation.generationId);
    const cutoverAfterReplay = (await pool!.query<{
      cutover_revision: string | number;
    }>(
      `SELECT cutover_revision
       FROM population_zone_cutovers_v2
       WHERE zone_id=$1 AND serving_version='v2'`,
      [fixture.zoneId]
    )).rows[0]!;
    expect(Number(cutoverAfterReplay.cutover_revision))
      .toBe(Number(cutoverAfter.cutover_revision));
  });

  it("regenerates only permanent stone after exactly 5h50m", async () => {
    const stone = (await first.loadReadyEntitiesForZones([zoneId]))
      .find((entity) => entity.entityKind === "stone");
    expect(stone).toBeDefined();
    const harvestedAt = new Date(Date.now());
    const harvested = await first.transitionEntityState({
      entityId: stone!.entityId,
      expectedStateRevision: stone!.stateRevision,
      state: "harvested",
      eventAt: harvestedAt
    });
    expect(harvested!.respawnAt!.getTime() - harvestedAt.getTime())
      .toBe(STONE_MINE_REGENERATION_MS);
    await expect(first.respawnDueEntitiesForZones([zoneId]))
      .resolves.toEqual([]);
    await pool!.query(
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
      [stone!.entityId]
    );
    await expect(first.respawnDueEntitiesForZones([zoneId]))
      .resolves.toContainEqual(expect.objectContaining({
      entityId: stone!.entityId,
      state: "ready"
    }));
  });

  it("keeps all mob leases renewable without flag suppression", async () => {
    await first.createCurrentGeneration({
      zoneId,
      planId: plan.planId,
      now: generatedAt
    });
    const mobs = (await first.loadReadyEntitiesForZones([zoneId]))
      .filter((entity) =>
        entity.entityKind === "deer"
        || entity.entityKind === "wolf"
        || entity.entityKind === "ogre"
      )
      .slice(0, 3);
    expect(mobs).toHaveLength(3);
    const cutoverBefore = await pool!.query<{ cutover_revision: string }>(
      `SELECT cutover_revision::text
       FROM population_zone_cutovers_v2
       WHERE zone_id=$1 AND serving_version='v2'`,
      [zoneId]
    );
    const cutoverRevision = Number(cutoverBefore.rows[0]?.cutover_revision);
    await pool!.query(
      `UPDATE population_entity_state_v2
       SET first_runtime_admitted_at=clock_timestamp()
       WHERE entity_id=ANY($1::uuid[])`,
      [mobs.map((mob) => mob.entityId)]
    );
    const leases = await first.acquireRuntimeEntityLeases(
      mobs.map((mob) => ({
        entityId: mob.entityId,
        runtimeId: "suppression-continuity-test",
        ownerToken: randomUUID(),
        cutoverRevision,
        stateRevision: mob.stateRevision
      })),
      300_000
    );
    expect(leases).toHaveLength(3);

    const cutoverAfter = await pool!.query<{ cutover_revision: string }>(
      `SELECT cutover_revision::text
       FROM population_zone_cutovers_v2
       WHERE zone_id=$1 AND serving_version='v2'`,
      [zoneId]
    );
    expect(Number(cutoverAfter.rows[0]?.cutover_revision)).toBe(cutoverRevision);

    const firstHeartbeat = await first.renewRuntimeEntityLeases(leases, 300_000);
    expect(firstHeartbeat).toEqual(expect.arrayContaining([
      { entityId: mobs[0]!.entityId, status: "renewed" },
      { entityId: mobs[1]!.entityId, status: "renewed" },
      { entityId: mobs[2]!.entityId, status: "renewed" }
    ]));
    for (let heartbeat = 1; heartbeat < 100; heartbeat += 1) {
      expect(await first.renewRuntimeEntityLeases(
        leases,
        300_000
      )).toEqual(expect.arrayContaining(
        leases.map((lease) => ({
          entityId: lease.entityId,
          status: "renewed"
        }))
      ));
    }
    await first.releaseRuntimeEntityLeases(leases);
  });

  it("omits flag-suppressed ordinary mobs from ready entities until unsuppressed", async () => {
    await first.createCurrentGeneration({
      zoneId,
      planId: plan.planId,
      now: generatedAt
    });
    const mob = (await first.loadReadyEntitiesForZones([zoneId])).find((entity) =>
      entity.entityKind === "deer"
      || entity.entityKind === "wolf"
      || entity.entityKind === "ogre"
    );
    expect(mob).toBeDefined();

    await pool!.query(
      `ALTER TABLE generated_world_mobs
       DISABLE TRIGGER generated_world_mobs_goblin_village_suppression`
    );
    try {
      await pool!.query(
        `UPDATE generated_world_mobs
         SET population_flag_suppressed=true
         WHERE population_v2_entity_id=$1::uuid`,
        [mob!.entityId]
      );
      const storedSuppression = await pool!.query<{
        population_flag_suppressed: boolean;
        population_v2_suppressed: boolean;
      }>(
        `SELECT population_flag_suppressed, population_v2_suppressed
         FROM generated_world_mobs
         WHERE population_v2_entity_id=$1::uuid`,
        [mob!.entityId]
      );
      expect(storedSuppression.rows[0]).toEqual({
        population_flag_suppressed: true,
        population_v2_suppressed: true
      });
      const suppressed = await first.loadReadyEntitiesForZones([zoneId]);
      expect(suppressed.some((entity) => entity.entityId === mob!.entityId))
        .toBe(false);
    } finally {
      await pool!.query(
        `UPDATE generated_world_mobs
         SET population_flag_suppressed=false
         WHERE population_v2_entity_id=$1::uuid`,
        [mob!.entityId]
      );
      await pool!.query(
        `ALTER TABLE generated_world_mobs
         ENABLE TRIGGER generated_world_mobs_goblin_village_suppression`
      );
    }
    const restored = await first.loadReadyEntitiesForZones([zoneId]);
    expect(restored.some((entity) => entity.entityId === mob!.entityId))
      .toBe(true);
  });

  it("gates only a mob's first lease by mechanical phase", async () => {
    await first.createCurrentGeneration({
      zoneId,
      planId: plan.planId,
      now: generatedAt
    });
    const readyEntities = await first.loadReadyEntitiesForZones([zoneId]);
    const runtimeKinds: ReadonlySet<string> = new Set(POPULATION_V2_MOB_DEFINITIONS.map(
      (definition) => definition.mobKind
    ));
    const nocturnalMob = readyEntities.find((entity) =>
      runtimeKinds.has(entity.entityKind)
    );
    expect(nocturnalMob).toBeDefined();
    const admissionGroup = nocturnalMob!.packId === null
      ? [nocturnalMob!]
      : readyEntities.filter((entity) => entity.packId === nocturnalMob!.packId);
    const nocturnalRegistry = createPopulationV2MobRegistry(
      POPULATION_V2_MOB_DEFINITIONS.map((definition) =>
        definition.mobKind === nocturnalMob!.entityKind
          ? { ...definition, mechanicalPhaseEligibility: "NIGHT" as const }
          : definition
      )
    );
    const phaseStore = new PostgresPopulationZonesV2Store(
      pool!,
      undefined,
      nocturnalRegistry
    );
    await pool!.query(
      `DELETE FROM population_runtime_entity_leases_v2
       WHERE entity_id=ANY($1::uuid[])`,
      [admissionGroup.map((entity) => entity.entityId)]
    );
    await pool!.query(
      `UPDATE population_entity_state_v2
       SET first_runtime_admitted_at=NULL
       WHERE entity_id=ANY($1::uuid[])`,
      [admissionGroup.map((entity) => entity.entityId)]
    );
    const requestFor = (entity: typeof admissionGroup[number]) => ({
      entityId: entity.entityId,
      runtimeId: "phase-admission-test",
      ownerToken: randomUUID(),
      cutoverRevision: entity.cutoverRevision,
      stateRevision: entity.stateRevision
    });

    await expect(phaseStore.acquireRuntimeEntityLeases(
      admissionGroup.map(requestFor),
      300_000,
      new Date("2026-01-01T07:00:00.000Z")
    )).resolves.toEqual([]);
    const nightLeases = await phaseStore.acquireRuntimeEntityLeases(
      admissionGroup.map(requestFor),
      300_000,
      new Date("2026-01-01T12:00:00.000Z")
    );
    expect(nightLeases).toHaveLength(admissionGroup.length);
    await phaseStore.releaseRuntimeEntityLeases(nightLeases);

    const grandfatheredLeases = await phaseStore.acquireRuntimeEntityLeases(
      admissionGroup.map(requestFor),
      300_000,
      new Date("2026-01-01T07:00:00.000Z")
    );
    expect(grandfatheredLeases).toHaveLength(admissionGroup.length);
    const marker = await pool!.query<{ admitted_count: string }>(
      `SELECT count(*)::text AS admitted_count
       FROM population_entity_state_v2
       WHERE entity_id=ANY($1::uuid[])
         AND first_runtime_admitted_at IS NOT NULL`,
      [admissionGroup.map((entity) => entity.entityId)]
    );
    expect(Number(marker.rows[0]?.admitted_count)).toBe(admissionGroup.length);
    await phaseStore.releaseRuntimeEntityLeases(grandfatheredLeases);
  });

  it("admits a never-admitted pack all at once or not at all", async () => {
    await first.createCurrentGeneration({
      zoneId,
      planId: plan.planId,
      now: generatedAt
    });
    const readyEntities = await first.loadReadyEntitiesForZones([zoneId]);
    const packId = readyEntities.find((entity) => entity.packId !== null)?.packId;
    const pack = readyEntities.filter((entity) => entity.packId === packId);
    expect(pack.length).toBeGreaterThanOrEqual(2);
    await pool!.query(
      `DELETE FROM population_runtime_entity_leases_v2
       WHERE entity_id=ANY($1::uuid[])`,
      [pack.map((entity) => entity.entityId)]
    );
    await pool!.query(
      `UPDATE population_entity_state_v2
       SET first_runtime_admitted_at=NULL
       WHERE entity_id=ANY($1::uuid[])`,
      [pack.map((entity) => entity.entityId)]
    );
    const requestFor = (entity: typeof pack[number]) => ({
      entityId: entity.entityId,
      runtimeId: "pack-admission-test",
      ownerToken: randomUUID(),
      cutoverRevision: entity.cutoverRevision,
      stateRevision: entity.stateRevision
    });

    await expect(first.acquireRuntimeEntityLeases(
      [requestFor(pack[0]!)],
      300_000,
      new Date("2026-01-01T07:00:00.000Z")
    )).resolves.toEqual([]);
    await pool!.query(
      `INSERT INTO population_runtime_entity_leases_v2 (
         entity_id,runtime_id,owner_token,fencing_generation,
         cutover_revision,state_revision,lease_expires_at,heartbeat_at,acquired_at
       ) VALUES ($1::uuid,'pack-blocker',$2::uuid,1,$3,$4,now()+interval '5 minutes',now(),now())`,
      [
        pack[0]!.entityId,
        randomUUID(),
        pack[0]!.cutoverRevision,
        pack[0]!.stateRevision
      ]
    );
    await expect(first.acquireRuntimeEntityLeases(
      pack.map(requestFor),
      300_000,
      new Date("2026-01-01T07:00:00.000Z")
    )).resolves.toEqual([]);
    await pool!.query(
      `DELETE FROM population_runtime_entity_leases_v2
       WHERE entity_id=$1::uuid AND runtime_id='pack-blocker'`,
      [pack[0]!.entityId]
    );
    const leases = await first.acquireRuntimeEntityLeases(
      pack.map(requestFor),
      300_000,
      new Date("2026-01-01T07:00:00.000Z")
    );
    expect(leases).toHaveLength(pack.length);
    const markers = await pool!.query<{ admitted_count: string }>(
      `SELECT count(*)::text AS admitted_count
       FROM population_entity_state_v2
       WHERE entity_id=ANY($1::uuid[])
         AND first_runtime_admitted_at IS NOT NULL`,
      [pack.map((entity) => entity.entityId)]
    );
    expect(Number(markers.rows[0]?.admitted_count)).toBe(pack.length);
    await first.releaseRuntimeEntityLeases(leases);
  });

  it("renews and releases production-sized overlapping lease batches without deadlock", async () => {
    const fixture = fixturePlanWithPermanentStone({
      worldEnvironmentIdentityKey: "9".repeat(64),
      worldPipelineSha: "9".repeat(40),
      origin: { lat: 36.1699, lon: -115.1398 }
    });
    const stressPlan = planWithLeaseStressMines(fixture.plan, 300);
    await completeFixturePlan(first, stressPlan);
    const entities = (await first.loadReadyEntitiesForZones([fixture.zoneId]))
      .filter((entity) => isPermanentMineEntityKind(entity.entityKind));
    expect(entities).toHaveLength(300);
    const cutover = await pool!.query<{ cutover_revision: string }>(
      `SELECT cutover_revision::text
       FROM population_zone_cutovers_v2
       WHERE zone_id=$1 AND serving_version='v2'`,
      [fixture.zoneId]
    );
    const cutoverRevision = Number(cutover.rows[0]?.cutover_revision);
    let leases = await first.acquireRuntimeEntityLeases(
      entities.map((entity) => ({
        entityId: entity.entityId,
        runtimeId: "overlapping-lease-batch-test",
        ownerToken: randomUUID(),
        cutoverRevision,
        stateRevision: entity.stateRevision
      })),
      300_000
    );
    expect(leases).toHaveLength(300);
    const deadlocksBefore = await pool!.query<{ deadlocks: string }>(
      `SELECT deadlocks::text
       FROM pg_stat_database
       WHERE datname=current_database()`
    );

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const ordered = [...leases].sort((left, right) =>
        left.entityId.localeCompare(right.entityId)
      );
      const released = ordered.filter((_, index) => index % 2 === cycle % 2);
      const retainedIds = new Set(
        ordered
          .filter((_, index) => index % 2 !== cycle % 2)
          .map((lease) => lease.entityId)
      );
      const renewInput = cycle % 2 === 0 ? ordered : [...ordered].reverse();
      const releaseInput = cycle % 2 === 0
        ? [...released].reverse()
        : released;
      const [renewed, releasedCount] = await Promise.all([
        first.renewRuntimeEntityLeases(renewInput, 300_000),
        second.releaseRuntimeEntityLeases(releaseInput)
      ]);
      expect(releasedCount).toBe(150);
      expect(renewed.filter((outcome) => retainedIds.has(outcome.entityId)))
        .toEqual(expect.arrayContaining(
          [...retainedIds].map((entityId) => ({
            entityId,
            status: "renewed"
          }))
        ));
      const remaining = await pool!.query<{ entity_id: string }>(
        `SELECT entity_id::text
         FROM population_runtime_entity_leases_v2
         WHERE runtime_id='overlapping-lease-batch-test'
         ORDER BY entity_id`
      );
      expect(remaining.rows.map((row) => row.entity_id))
        .toEqual([...retainedIds].sort());
      const reacquired = await first.acquireRuntimeEntityLeases(
        released.map((lease) => ({
          entityId: lease.entityId,
          runtimeId: lease.runtimeId,
          ownerToken: randomUUID(),
          cutoverRevision: lease.cutoverRevision,
          stateRevision: lease.stateRevision
        })),
        300_000
      );
      expect(reacquired).toHaveLength(150);
      const retainedById = new Map(
        leases
          .filter((lease) => retainedIds.has(lease.entityId))
          .map((lease) => [lease.entityId, lease])
      );
      const reacquiredById = new Map(
        reacquired.map((lease) => [lease.entityId, lease])
      );
      leases = ordered.map((lease) =>
        retainedById.get(lease.entityId)
          ?? reacquiredById.get(lease.entityId)!
      );
    }
    const deadlocksAfter = await pool!.query<{ deadlocks: string }>(
      `SELECT deadlocks::text
       FROM pg_stat_database
       WHERE datname=current_database()`
    );
    expect(deadlocksAfter.rows[0]?.deadlocks)
      .toBe(deadlocksBefore.rows[0]?.deadlocks);
    await first.releaseRuntimeEntityLeases(leases);
  }, 30_000);

  it("persists ready entity runtime state only through the current fenced lease", async () => {
    const readyEntity = (await first.loadReadyEntitiesForZones([zoneId]))
      .find((entity) => entity.entityKind === "stone");
    expect(readyEntity).toBeDefined();
    const cutover = await pool!.query<{ cutover_revision: string }>(
      `SELECT cutover_revision::text
       FROM population_zone_cutovers_v2
       WHERE zone_id=$1 AND serving_version='v2'`,
      [zoneId]
    );
    const [lease] = await first.acquireRuntimeEntityLeases([{
      entityId: readyEntity!.entityId,
      runtimeId: "durable-runtime-state-test",
      ownerToken: randomUUID(),
      cutoverRevision: Number(cutover.rows[0]?.cutover_revision),
      stateRevision: readyEntity!.stateRevision
    }], 300_000);
    expect(lease).toBeDefined();

    const durableRuntimeState = {
      jellyfish: {
        currentHealth: 600,
        stage: 2,
        retreatTriggered: true
      }
    };
    await expect(first.updateReadyRuntimeEntityState(
      lease!,
      durableRuntimeState
    )).resolves.toBe(true);

    const persisted = await pool!.query<{
      state_revision: string;
      durable_runtime_state: Record<string, unknown>;
    }>(
      `SELECT state_revision::text, durable_runtime_state
       FROM population_entity_state_v2
       WHERE entity_id=$1::uuid`,
      [readyEntity!.entityId]
    );
    expect(Number(persisted.rows[0]?.state_revision))
      .toBe(readyEntity!.stateRevision);
    expect(persisted.rows[0]?.durable_runtime_state).toEqual(durableRuntimeState);

    await expect(first.updateReadyRuntimeEntityState({
      ...lease!,
      ownerToken: randomUUID()
    }, { jellyfish: { currentHealth: 1 } })).resolves.toBe(false);
    await expect(first.loadReadyEntitiesForZones([zoneId]))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          entityId: readyEntity!.entityId,
          durableRuntimeState
        })
      ]));
    await first.releaseRuntimeEntityLeases([lease!]);
  });

  it("loads same-zone and adjacent selected-plan stones for spacing", async () => {
    const environmentKey = "d".repeat(64);
    const stoneFixture = fixturePlanWithPermanentStone({
      worldEnvironmentIdentityKey: environmentKey,
      worldPipelineSha: "d".repeat(40)
    });
    await completeFixturePlan(first, stoneFixture.plan);
    await first.createCurrentGeneration({
      zoneId: stoneFixture.zoneId,
      planId: stoneFixture.plan.planId,
      now: new Date("2099-04-01T00:00:00.000Z")
    });
    const adjacentStone = stoneFixture.plan.slots.find((slot) =>
      slot.entityKind === "stone"
    )!;
    const sameZoneOccupied = await pool!.query<{
      entity_id: string;
      entity_kind: string;
    }>(
      POPULATION_V2_REGISTERED_MOB_NEIGHBOR_OCCUPANTS_SQL,
      [stoneFixture.plan.planId, stoneFixture.zoneId, 700]
    );
    expect(sameZoneOccupied.rows).toContainEqual(expect.objectContaining({
      entity_id: adjacentStone.entityId,
      entity_kind: "stone"
    }));
    const targetZoneId = [0, 90, 180, 270]
      .map((bearing) => populationZoneV2IdForPoint(destinationPoint(
        adjacentStone.position,
        600,
        bearing
      )))
      .find((candidate) => candidate !== stoneFixture.zoneId);
    expect(targetZoneId).toBeDefined();
    const generatedTargetPlan = generatePopulationZoneV2Plan({
      zoneId: targetZoneId!,
      worldEnvironmentIdentityKey: environmentKey,
      worldPipelineSha: "d".repeat(40),
      habitatForZone: (candidate) =>
        populationZoneV3ConservativeHabitat({
          zoneId: candidate,
          worldEnvironmentIdentityKey: environmentKey
        })
    });
    const targetDraft = {
      ...generatedTargetPlan,
      slots: generatedTargetPlan.slots.filter((slot) =>
        slot.entityKind !== "stone"
      ),
      contentHash: ""
    };
    const targetPlan = {
      ...targetDraft,
      contentHash: populationZoneV2PlanContentHash(targetDraft)
    };
    await completeFixturePlan(first, targetPlan);
    const targetGeneration = await first.createCurrentGeneration({
      zoneId: targetZoneId!,
      planId: targetPlan.planId,
      now: new Date("2099-04-01T00:00:00.000Z")
    });

    const occupied = await pool!.query<{
      owner_plan_id: string;
      owner_generation_id: string | null;
      entity_id: string;
      entity_kind: string;
    }>(
      POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.occupiedSlots,
      [targetGeneration.generation.generationId, targetPlan.planId, 700]
    );
    expect(occupied.rows).toContainEqual(expect.objectContaining({
      owner_plan_id: stoneFixture.plan.planId,
      owner_generation_id: null,
      entity_id: adjacentStone.entityId,
      entity_kind: "stone"
    }));
  });

  it("serves immutable V1 authority and fences stale state and partial groups", async () => {
    const fixture = fixturePlanWithPermanentStone({
      worldEnvironmentIdentityKey: "f".repeat(64),
      worldPipelineSha: "f".repeat(40),
      origin: { lat: 47.6062, lon: -122.3321 }
    });
    const sapPlan = planWithSapCrawlerGroups(fixture.plan, 1);
    const draft = {
      ...fixture.plan,
      slots: [
        ...fixture.plan.slots.filter((slot) =>
          slot.entityKind !== "sap_crawler"
        ),
        ...sapPlan.slots
      ].sort((left, right) => left.entityId.localeCompare(right.entityId)),
      contentHash: ""
    };
    const v1Plan = {
      ...draft,
      contentHash: populationZoneV2PlanContentHash(draft)
    };
    await completeFixturePlan(first, v1Plan);
    const v1Registry = createPopulationV2MobRegistry(
      POPULATION_V2_MOB_DEFINITIONS.map((definition) =>
        definition.mobKind === "sap_crawler"
          ? { ...definition, generationPlacement: "legacy_frozen" as const }
          : definition
      )
    );
    const v1Writer = new PostgresPopulationZonesV2Store(
      pool!,
      (input) => generatePopulationZoneV2GenerationSlots({
        ...input,
        includeLegacySapCrawler: true
      }),
      v1Registry
    );
    const materialization = await v1Writer.createCurrentGeneration({
      zoneId: fixture.zoneId,
      planId: v1Plan.planId,
      now: new Date("2099-05-01T00:00:00.000Z")
    });
    const retainedSlots = generatePopulationZoneV2GenerationSlots({
      template: v1Plan,
      generationId: materialization.generation.generationId,
      generationNumber: materialization.generation.generationNumber,
      includeLegacySapCrawler: true
    }).slots;
    await replaceHistoricalGenerationFixture(pool!, v1Plan, materialization.generation.generationId, retainedSlots);
    await pool!.query(
      `UPDATE population_zone_generations_v2
       SET materialization_revision='population-generation-materialization-v1'
       WHERE generation_id=$1::uuid`,
      [materialization.generation.generationId]
    );
    const generationBefore = await pool!.query(
      `SELECT generation_id, zone_id, plan_id, generation_number,
              generated_at, expires_at, status, planned_nonstone_count,
              current_reference_count, is_current, density_revision,
              plan_content_hash, candidate_layout_version,
              materialization_revision
       FROM population_zone_generations_v2
       WHERE generation_id=$1::uuid`,
      [materialization.generation.generationId]
    );
    const serving = await first.loadCurrentServingPlanGenerations([
      fixture.zoneId
    ]);
    expect(serving).toEqual([
      expect.objectContaining({
        generationId: materialization.generation.generationId,
        materializationRevision:
          "population-generation-materialization-v1",
        status: "active",
        isCurrent: true
      })
    ]);

    const storedSapGroups = await pool!.query<{
      pack_id: string;
      member_count: string;
      indexes: number[];
      encounter_count: string;
      kind_count: string;
      archetype_count: string;
    }>(
      `SELECT pack_id::text,
              count(*)::text AS member_count,
              array_agg(pack_member_index ORDER BY pack_member_index)
                AS indexes,
              count(DISTINCT encounter_id)::text AS encounter_count,
              count(DISTINCT entity_kind)::text AS kind_count,
              count(DISTINCT archetype)::text AS archetype_count
       FROM population_spawn_slots_v2
       WHERE generation_id=$1::uuid
         AND entity_kind='sap_crawler'
       GROUP BY pack_id
       ORDER BY pack_id`,
      [materialization.generation.generationId]
    );
    expect(storedSapGroups.rows).toEqual([
      expect.objectContaining({
        member_count: "5",
        indexes: [0, 1, 2, 3, 4],
        encounter_count: "1",
        kind_count: "1",
        archetype_count: "1"
      })
    ]);
    const initial = await first.loadReadyEntitiesForZones([fixture.zoneId]);
    const tree = initial.find((entity) => entity.entityKind === "tree");
    const stone = initial.find((entity) => entity.entityKind === "stone");
    const sapGroup = initial.filter((entity) =>
      entity.entityKind === "sap_crawler"
    );
    expect(tree).toBeDefined();
    expect(stone).toMatchObject({ generationId: null });
    expect(sapGroup).toHaveLength(5);
    expect(sapGroup
      .map((entity) => entity.packMemberIndex)
      .sort((left, right) => left! - right!)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(sapGroup.map((entity) => entity.packId)).size).toBe(1);

    await first.transitionEntityState({
      entityId: tree!.entityId,
      expectedStateRevision: tree!.stateRevision,
      state: "harvested",
      eventAt: new Date("2099-05-01T01:00:00.000Z")
    });
    await pool!.query(
      `UPDATE generated_world_mobs
       SET population_cutover_suppressed=true
       WHERE population_v2_entity_id=$1::uuid`,
      [sapGroup[0]!.entityId]
    );
    const fenced = await first.loadReadyEntitiesForZones([fixture.zoneId]);
    expect(fenced.some((entity) => entity.entityId === tree!.entityId))
      .toBe(false);
    expect(fenced.some((entity) => entity.entityId === sapGroup[0]!.entityId))
      .toBe(false);
    expect(fenced.some((entity) => entity.entityId === stone!.entityId))
      .toBe(true);

    const removedMember = sapGroup.at(-1)!;
    await pool!.query(
      `DELETE FROM generated_world_mobs
       WHERE population_v2_entity_id=$1::uuid`,
      [removedMember.entityId]
    );
    await pool!.query(
      `DELETE FROM population_entity_state_v2 WHERE entity_id=$1::uuid`,
      [removedMember.entityId]
    );
    const partialFenced = await first.loadReadyEntitiesForZones([
      fixture.zoneId
    ]);
    expect(partialFenced.some((entity) =>
      entity.packId === sapGroup[0]!.packId
    )).toBe(false);
    expect(partialFenced.some((entity) => entity.entityId === stone!.entityId))
      .toBe(true);

    const generationAfter = await pool!.query(
      `SELECT generation_id, zone_id, plan_id, generation_number,
              generated_at, expires_at, status, planned_nonstone_count,
              current_reference_count, is_current, density_revision,
              plan_content_hash, candidate_layout_version,
              materialization_revision
       FROM population_zone_generations_v2
       WHERE generation_id=$1::uuid`,
      [materialization.generation.generationId]
    );
    expect(generationAfter.rows).toEqual(generationBefore.rows);
    const diagnostics = await first.loadMaterializationDiagnostics([
      "legacy-unverified",
      "population-generation-materialization-v1",
      "population-generation-materialization-v2",
      "population-generation-materialization-v3"
    ]);
    expect(
      diagnostics.activeCurrentCountsByRevision[
        "population-generation-materialization-v1"
      ]
    ).toBeGreaterThanOrEqual(1);
    expect(
      diagnostics.activeCurrentCountsByCommonSchemaRevision[
        "population-common-schema-v1"
      ]
    ).toBeGreaterThanOrEqual(1);
    expect(
      Object.keys(
        diagnostics.activeCurrentCountsByKindManifestRevision
      ).length
    ).toBeGreaterThan(0);
    expect(diagnostics.guardedActiveGenerations.some((generation) =>
      generation.generationId === materialization.generation.generationId
    )).toBe(false);
  });
});

function fixturePlanWithPermanentStone(input: Readonly<{
  worldEnvironmentIdentityKey: string;
  worldPipelineSha: string;
  origin?: Readonly<{ lat: number; lon: number }>;
}>): Readonly<{
  zoneId: PopulationZoneV2Id;
  plan: GeneratedPopulationZoneV2Plan;
}> {
  return fixturePlanWithPermanentMine({ ...input, mineKind: "stone" });
}

function fixturePlanWithPermanentMine(input: Readonly<{
  worldEnvironmentIdentityKey: string;
  worldPipelineSha: string;
  mineKind: "stone" | "coal" | "iron";
  origin?: Readonly<{ lat: number; lon: number }>;
}>): Readonly<{
  zoneId: PopulationZoneV2Id;
  plan: GeneratedPopulationZoneV2Plan;
}> {
  const origin = populationZoneV2IdForPoint(
    input.origin ?? { lat: 35.0844, lon: -106.6504 }
  );
  for (const candidateZoneId of populationZoneV2Halo(origin, 12)) {
    const candidate = generatePopulationZoneV2Plan({
      zoneId: candidateZoneId,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
      worldPipelineSha: input.worldPipelineSha,
      habitatForZone: (zoneId) => populationZoneV3ConservativeHabitat({
        zoneId,
        worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
      })
    });
    if (
      candidate.slots.some((slot) => slot.entityKind === input.mineKind)
      && candidate.slots.some((slot) => slot.entityKind === "tree")
      && candidate.slots.some((slot) =>
        slot.entityKind === "deer"
        || slot.entityKind === "wolf"
        || slot.entityKind === "ogre"
      )
    ) {
      return { zoneId: candidateZoneId, plan: candidate };
    }
  }
  throw new Error(`fixture could not find a nearby permanent ${input.mineKind} plan`);
}

function fixturePlanWithoutPermanentStone(input: Readonly<{
  worldEnvironmentIdentityKey: string;
  worldPipelineSha: string;
  origin?: Readonly<{ lat: number; lon: number }>;
  requiredNextGenerationKind?: string;
}>): Readonly<{
  zoneId: PopulationZoneV2Id;
  plan: GeneratedPopulationZoneV2Plan;
}> {
  const origin = populationZoneV2IdForPoint(
    input.origin ?? { lat: 35.0844, lon: -106.6504 }
  );
  for (const candidateZoneId of populationZoneV2Halo(origin, 20)) {
    const candidate = generatePopulationZoneV2Plan({
      zoneId: candidateZoneId,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
      worldPipelineSha: input.worldPipelineSha,
      habitatForZone: (zoneId) => populationZoneV3ConservativeHabitat({
        zoneId,
        worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
      })
    });
    const firstEncounterSlots = materializePopulationV2EncounterTables({
      generationId: populationZoneV2GenerationId({ identity: candidate.identity, generationNumber: 1 }),
      habitat: { ...candidate.habitat, candidateSites: candidate.habitat.candidateSites?.filter((site) => populationZoneV2IdForPoint(site.position) === candidateZoneId) ?? [] }
    }).slots;
    const encounterSlots = materializePopulationV2EncounterTables({
      generationId: populationZoneV2GenerationId({ identity: candidate.identity, generationNumber: 2 }),
      habitat: { ...candidate.habitat, candidateSites: candidate.habitat.candidateSites?.filter((site) =>
        populationZoneV2IdForPoint(site.position) === candidateZoneId
      ) ?? [] }
    }).slots;
    if (
      candidate.slots.every((slot) => slot.entityKind !== "stone")
      && firstEncounterSlots.length > 0
      && encounterSlots.length > 0
      && (input.requiredNextGenerationKind === undefined || encounterSlots.some((slot) => slot.mobKind === input.requiredNextGenerationKind))
      && candidate.slots.some((slot) => !isPermanentMineEntityKind(slot.entityKind))
      && (candidate.habitat.candidateSites?.some((site) => site.weights.eligibleLand > 0) ?? false)
    ) {
      return { zoneId: candidateZoneId, plan: candidate };
    }
  }
  throw new Error("fixture could not find a nearby stone-free plan");
}

function underfilledPopulation(
  slots: readonly PopulationZoneV2PlanSlot[]
): PopulationZoneV2PlanSlot[] {
  const retainHalf = (
    values: readonly PopulationZoneV2PlanSlot[]
  ): PopulationZoneV2PlanSlot[] => values.slice(
    0,
    Math.max(1, Math.floor(values.length / 2))
  );
  const retained = [
    ...retainHalf(slots.filter((slot) => slot.entityKind === "tree")),
    ...retainHalf(slots.filter((slot) => slot.entityKind === "deer")),
    ...slots.filter((slot) =>
      slot.entityKind === "ogre"
      || slot.entityKind === "sap_crawler"
    )
  ];
  const packs = new Map<string, PopulationZoneV2PlanSlot[]>();
  for (const slot of slots) {
    if (slot.entityKind !== "wolf" || slot.packId === null) continue;
    const members = packs.get(slot.packId) ?? [];
    members.push(slot);
    packs.set(slot.packId, members);
  }
  const orderedPacks = [...packs.values()].sort((left, right) =>
    left[0]!.entityId.localeCompare(right[0]!.entityId)
  );
  retained.push(...orderedPacks.slice(
    0,
    Math.max(1, Math.floor(orderedPacks.length / 2))
  ).flat());
  return retained.sort((left, right) =>
    left.entityId.localeCompare(right.entityId)
  );
}

function planWithSapCrawlerGroups(
  source: GeneratedPopulationZoneV2Plan,
  groupCount: number
): GeneratedPopulationZoneV2Plan {
  const sapSlots = Array.from({ length: groupCount }, (_, groupIndex) => {
    const candidateId = `integration-sap-group-${groupIndex}`;
    const anchor = destinationPoint(
      source.geometry.center,
      300,
      groupIndex * (360 / groupCount)
    );
    const encounterId = deterministicUuidV8(
      "integration-sap-encounter",
      { candidateId, planId: source.planId }
    );
    const packId = deterministicUuidV8(
      "integration-sap-pack",
      { candidateId, planId: source.planId }
    );
    return Array.from({ length: 5 }, (_, packMemberIndex) => ({
      slotId: deterministicUuidV8("integration-sap-slot", {
        candidateId,
        packMemberIndex,
        planId: source.planId
      }),
      entityId: deterministicUuidV8("integration-sap-entity", {
        candidateId,
        packMemberIndex,
        planId: source.planId
      }),
      candidateId,
      entityKind: "sap_crawler" as const,
      archetype: "sap_crawler",
      encounterId,
      packId,
      packMemberIndex,
      position: destinationPoint(
        anchor,
        packMemberIndex * 8,
        groupIndex * 120 + 45
      ),
      anchor,
      environmentSnapshot: {
        fixture: "Resin Crawler generation reconciliation",
        candidateSite: { packMemberIndex }
      },
      suppressionClass: "hostile-pack" as const
    }));
  }).flat();
  const draft = {
    ...source,
    slots: sapSlots.sort((left, right) =>
      left.entityId.localeCompare(right.entityId)
    ),
    contentHash: ""
  };
  return {
    ...draft,
    contentHash: populationZoneV2PlanContentHash(draft)
  };
}

function planWithLeaseStressMines(
  source: GeneratedPopulationZoneV2Plan,
  mineCount: number
): GeneratedPopulationZoneV2Plan {
  const sourceMine = source.slots.find((slot) =>
    isPermanentMineEntityKind(slot.entityKind)
  );
  if (!sourceMine) throw new Error("lease stress fixture requires a permanent mine");
  const slots = Array.from({ length: mineCount }, (_, index) => {
    const candidateId = `lease-stress-mine-${index}`;
    const identity = permanentPopulationStoneIdentity({
      identity: source.identity,
      candidateId,
      ownerZoneId: source.identity.zoneId
    });
    const entityKind = permanentMineKindForSlot(identity.slotId);
    return {
      ...sourceMine,
      ...identity,
      candidateId,
      entityKind,
      archetype: permanentMineArchetype(entityKind),
      environmentSnapshot: {
        ...sourceMine.environmentSnapshot,
        leaseStressIndex: index
      }
    };
  });
  const draft = {
    ...source,
    slots,
    contentHash: ""
  };
  return {
    ...draft,
    contentHash: populationZoneV2PlanContentHash(draft)
  };
}

function planWithStoneEligibleLandFraction(
  source: GeneratedPopulationZoneV2Plan,
  eligibleLandFraction: number
): GeneratedPopulationZoneV2Plan {
  const draft = {
    ...source,
    slots: source.slots.map((slot) => slot.entityKind === "stone"
      ? {
          ...slot,
          environmentSnapshot: {
            ...slot.environmentSnapshot,
            eligibleLandFraction
          }
        }
      : slot),
    contentHash: ""
  };
  return {
    ...draft,
    contentHash: populationZoneV2PlanContentHash(draft)
  };
}

function planWithLegacyCandidateSurface(
  source: GeneratedPopulationZoneV2Plan
): GeneratedPopulationZoneV2Plan {
  const draft = {
    ...source,
    slots: source.slots.map((slot) => isPermanentMineEntityKind(slot.entityKind)
      ? {
          ...slot,
          environmentSnapshot: {
            ...slot.environmentSnapshot,
            candidateSite: {
              ...(slot.environmentSnapshot.candidateSite as Readonly<
                Record<string, CanonicalJsonValue>
              >),
              surfaceType: "land",
              surfaceAuthority: {
                source: "legacy-world-sample",
                version: 5
              }
            }
          }
        }
      : slot),
    contentHash: ""
  };
  return {
    ...draft,
    contentHash: populationZoneV2PlanContentHash(draft)
  };
}

function planForSpawnRules(
  source: GeneratedPopulationZoneV2Plan,
  spawnRulesVersion: string,
  slots: GeneratedPopulationZoneV2Plan["slots"]
): GeneratedPopulationZoneV2Plan {
  const identity = {
    ...source.identity,
    spawnRulesVersion
  } as unknown as PopulationZoneV2PlanIdentity;
  const draft = {
    ...source,
    identity,
    planId: populationZoneV2PlanId(identity),
    slots,
    contentHash: ""
  };
  return {
    ...draft,
    contentHash: populationZoneV2PlanContentHash(draft)
  };
}

function planForAuthorityVersions(
  source: GeneratedPopulationZoneV2Plan,
  versions: Readonly<{
    populationPlanVersion: string;
    spawnRulesVersion: string;
    candidateLayoutVersion: string;
  }>,
  slots: GeneratedPopulationZoneV2Plan["slots"]
): GeneratedPopulationZoneV2Plan {
  const identity = {
    ...source.identity,
    ...versions
  } as unknown as PopulationZoneV2PlanIdentity;
  const draft = {
    ...source,
    identity,
    planId: populationZoneV2PlanId(identity),
    slots,
    contentHash: ""
  };
  return {
    ...draft,
    contentHash: populationZoneV2PlanContentHash(draft)
  };
}

function requestForPlan(
  plan: GeneratedPopulationZoneV2Plan
): ReturnType<typeof populationZoneV2PlanRequest> {
  return {
    identity: plan.identity,
    planId: plan.planId,
    worldPipelineSha: plan.worldPipelineSha,
    regionCode: plan.habitat.regionCode
  };
}

async function completeFixturePlan(
  store: PostgresPopulationZonesV2Store,
  plan: GeneratedPopulationZoneV2Plan
): Promise<void> {
  const request = requestForPlan(plan);
  await store.ensurePlanForZone(request);
  const claim = await store.claimPlan(request.identity, randomUUID(), 30_000);
  if (claim === null) throw new Error("fixture plan could not be claimed");
  await expect(store.completePlan(claim, plan)).resolves.toBe(true);
}

async function generationPositions(
  pool: pg.Pool,
  generationId: string
): Promise<ReadonlyArray<Readonly<{ lat: number; lon: number }>>> {
  const result = await pool.query<{
    latitude: number | string;
    longitude: number | string;
  }>(
    `SELECT latitude, longitude
     FROM population_spawn_slots_v2
     WHERE generation_id=$1::uuid
     ORDER BY entity_id`,
    [generationId]
  );
  return result.rows.map((row) => ({
    lat: Number(row.latitude),
    lon: Number(row.longitude)
  }));
}

async function permanentStonePositions(
  pool: pg.Pool,
  planId: string
): Promise<ReadonlyArray<Readonly<{
  entityId: string;
  lat: number;
  lon: number;
}>>> {
  const result = await pool.query<{
    entity_id: string;
    latitude: number | string;
    longitude: number | string;
  }>(
    `SELECT entity_id, latitude, longitude
     FROM population_spawn_slots_v2
     WHERE plan_id=$1::uuid AND entity_kind='stone'
     ORDER BY entity_id`,
    [planId]
  );
  return result.rows.map((row) => ({
    entityId: row.entity_id,
    lat: Number(row.latitude),
    lon: Number(row.longitude)
  }));
}

function assertStabilityLabAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "postgres:"
    && parsed.protocol !== "postgresql:"
  ) {
    throw new Error("stability admin URL must use PostgreSQL");
  }
  const database = parsed.pathname.replace(/^\/+/u, "");
  if (!database.startsWith("ash_atlas_stability")) {
    throw new Error(
      "stability admin URL must target an ash_atlas_stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(identifier: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(identifier)) {
    throw new Error("unsafe test database identifier");
  }
  return `"${identifier}"`;
}

async function historicalGenerationSnapshot(pool: pg.Pool, generationId: string): Promise<unknown> {
  const result = await pool.query(
    `SELECT to_jsonb(generation) AS generation,
      (SELECT jsonb_agg(to_jsonb(slot) ORDER BY slot.entity_id)
       FROM population_spawn_slots_v2 AS slot WHERE slot.generation_id=generation.generation_id) AS slots,
      (SELECT jsonb_agg(to_jsonb(state) ORDER BY state.entity_id)
       FROM population_entity_state_v2 AS state JOIN population_spawn_slots_v2 AS slot USING(entity_id)
       WHERE slot.generation_id=generation.generation_id) AS states,
      (SELECT jsonb_agg(to_jsonb(mob) ORDER BY mob.entity_id)
       FROM generated_world_mobs AS mob JOIN population_spawn_slots_v2 AS slot
         ON slot.entity_id=mob.population_v2_entity_id
       WHERE slot.generation_id=generation.generation_id) AS mobs,
      (SELECT jsonb_agg(to_jsonb(tree) ORDER BY tree.id)
       FROM collectible_nodes AS tree JOIN population_spawn_slots_v2 AS slot
         ON slot.entity_id=tree.population_v2_entity_id
       WHERE slot.generation_id=generation.generation_id) AS trees
     FROM population_zone_generations_v2 AS generation WHERE generation_id=$1::uuid`, [generationId]
  );
  return result.rows;
}
