import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  POPULATION_GENERATION_MATERIALIZATION_REVISION,
  POPULATION_V2_REGISTERED_MOB_NEIGHBOR_OCCUPANTS_SQL,
  PostgresPopulationZonesV2Store
} from "./populationZonesV2Store.js";
import {
  populationZoneV2IdForPoint,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";

const ZONE_ID = populationZoneV2IdForPoint({
  lat: 35.0844,
  lon: -106.6504
});
const PLAN_ID = "00000000-0000-4000-8000-000000000010";
const GENERATION_ID = "00000000-0000-4000-8000-000000000011";
const ENTITY_ID = "00000000-0000-4000-8000-000000000012";

describe("PostgresPopulationZonesV2Store generation creation boundary", () => {
  it("returns a valid current generation without planning or editing it", async () => {
    const harness = storeHarness();

    const result = await harness.store.createCurrentGeneration({
      zoneId: ZONE_ID,
      planId: PLAN_ID
    });

    expect(result).toMatchObject({
      created: false,
      entityIds: [ENTITY_ID],
      generation: {
        generationId: GENERATION_ID,
        densityRevision: "legacy-unverified",
        materializationRevision: "legacy-unverified"
      }
    });
    const statements = harness.query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) =>
      sql.includes("FROM population_zones_v2")
    )).toBe(false);
    expect(statements.some((sql) =>
      /^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(sql)
    )).toBe(false);
  });

  it("locks overlapping generation spacing zones in global order", async () => {
    const first = storeHarness();
    await first.store.createCurrentGeneration({
      zoneId: ZONE_ID,
      planId: PLAN_ID
    });
    const firstLocks = generationLockZoneIds(first.query.mock.calls);
    expect(firstLocks.length).toBeGreaterThan(1);
    expect(firstLocks).toEqual([...firstLocks].sort());

    const adjacentZoneId = firstLocks.find((zoneId) => zoneId !== ZONE_ID)!;
    const second = storeHarness(adjacentZoneId);
    await second.store.createCurrentGeneration({
      zoneId: adjacentZoneId,
      planId: PLAN_ID
    });
    const secondLocks = generationLockZoneIds(second.query.mock.calls);
    const sharedLocks = firstLocks.filter((zoneId) =>
      secondLocks.includes(zoneId)
    );
    expect(sharedLocks.length).toBeGreaterThan(1);
    expect(secondLocks.filter((zoneId) => sharedLocks.includes(zoneId)))
      .toEqual(sharedLocks);
  });

  it("keeps density repair behind its explicit maintenance method", async () => {
    const harness = storeHarness(
      ZONE_ID,
      POPULATION_GENERATION_MATERIALIZATION_REVISION
    );

    await expect(harness.store.reconcileCurrentGenerationDensity({
      zoneId: ZONE_ID,
      planId: PLAN_ID
    })).rejects.toThrow(
      "population generation requires its matching ready template"
    );

    expect(harness.query.mock.calls.some(([sql]) =>
      sql.includes("FROM population_zones_v2")
    )).toBe(true);
  });

  it("requires current projection authority before serving a tree life", async () => {
    const harness = storeHarness();

    await harness.store.loadReadyEntitiesForZones([ZONE_ID]);

    const visibility = harness.query.mock.calls.find(([sql]) =>
      sql.includes("JOIN population_zone_cutovers_v2 AS cutover")
      && sql.includes("collectible.resin_harvested_life_revision")
    )?.[0];
    expect(visibility).toContain("slot.generation_status='active'");
    expect(visibility).toContain(
      "slot.generation_expires_at > statement_timestamp()"
    );
    expect(visibility).toContain(
      "collectible.population_v2_plan_id=slot.plan_id"
    );
    expect(visibility).toContain(
      "collectible.population_cutover_revision="
    );
    expect(visibility).toContain(
      "collectible.population_v2_state_revision="
    );
    expect(visibility).toContain("collectible.state='available'");
    expect(visibility).toContain(
      "NOT collectible.population_v2_suppressed"
    );
  });

  it("loads serving generations only from the selected ready v2 plan", async () => {
    const harness = storeHarness();

    await harness.store.loadCurrentServingPlanGenerations([ZONE_ID]);

    const authority = harness.query.mock.calls.find(([sql]) =>
      sql.includes(
        "FROM population_zone_generations_v2 AS generation"
      )
      && sql.includes("cutover.selected_plan_id=plan.plan_id")
    )?.[0];
    expect(authority).toContain("plan.status='ready'");
    expect(authority).toContain("cutover.serving_version='v2'");
    expect(authority).toContain("cutover.status='stable'");
    expect(authority).toContain("generation.is_current");
  });

  it("loads only nearby current authoritative neighbor lives for spacing", () => {
    const sql = POPULATION_V2_REGISTERED_MOB_NEIGHBOR_OCCUPANTS_SQL
      .replace(/\s+/gu, " ")
      .trim();

    expect(sql).toContain("owner_generation.zone_id<>target_plan.zone_id");
    expect(sql).toContain("owner_generation.is_current");
    expect(sql).toContain("owner_generation.status='active'");
    expect(sql).toContain(
      "owner_generation.expires_at > statement_timestamp()"
    );
    expect(sql).toContain(
      "owner_cutover.selected_plan_id=owner_generation.plan_id"
    );
    expect(sql).toContain("owner_cutover.serving_version='v2'");
    expect(sql).toContain("owner_cutover.status='stable'");
    expect(sql).not.toContain("owner_plan.zone_id<>target_plan.zone_id");
    expect(sql).toContain("slot.generation_id IS NULL");
    expect(sql).toContain("JOIN population_plan_spawn_slots_v2 AS slot ON slot.plan_id=owner_plan.plan_id");
    expect(sql).not.toContain("slot.entity_kind='stone'");
    expect(sql).toContain(
      "ST_DWithin( slot.anchor_geom, target_plan.zone_geog,"
    );
  });
});

function storeHarness(
  zoneId = ZONE_ID,
  materializationRevision = "legacy-unverified"
) {
  const query = vi.fn(async (sql: string) => {
    if (
      sql.includes("FROM population_zone_generations_v2")
      && sql.includes("FOR UPDATE")
    ) {
      return {
        rows: [{
          generation_id: GENERATION_ID,
          zone_id: zoneId,
          plan_id: PLAN_ID,
          generation_number: 1,
          generated_at: new Date("2099-03-01T00:00:00.000Z"),
          expires_at: new Date("2099-03-03T00:00:00.000Z"),
          status: "active",
          planned_nonstone_count: 1,
          current_reference_count: 0,
          unreferenced_at: null,
          is_current: true,
          cleaned_at: null,
          density_revision: "legacy-unverified",
          plan_content_hash: "legacy-unverified",
          candidate_layout_version: "legacy-unverified",
          materialization_revision: materializationRevision
        }]
      };
    }
    if (
      sql.includes("FROM population_spawn_slots_v2")
      && sql.includes("ORDER BY entity_id")
    ) {
      return { rows: [{ entity_id: ENTITY_ID }] };
    }
    return { rows: [] };
  });
  const client = {
    query,
    release: vi.fn()
  };
  const pool = {
    connect: vi.fn(async () => client),
    query
  } as unknown as pg.Pool;
  return {
    query,
    store: new PostgresPopulationZonesV2Store(pool)
  };
}

function generationLockZoneIds(
  calls: readonly (readonly [string, ...unknown[]])[]
): PopulationZoneV2Id[] {
  return calls
    .filter(([sql]) => sql.includes("population-zone-generation-v2:"))
    .map(([, parameters]) =>
      (parameters as readonly PopulationZoneV2Id[])[0]!
    );
}
