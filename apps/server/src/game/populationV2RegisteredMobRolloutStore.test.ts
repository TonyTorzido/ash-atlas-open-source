import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL,
  PopulationV2PostgresMobRolloutExecutor,
  PopulationV2RegisteredMobRolloutAuthorityError,
  PostgresPopulationV2RegisteredMobRolloutStore
} from "./populationV2RegisteredMobRolloutStore.js";
import type {
  PopulationV2RegisteredMobOccupiedSlot,
  PopulationV2RegisteredMobOverlayResult,
  PopulationV2RegisteredMobOverlaySlot
} from "./populationV2RegisteredMobOverlay.js";
import {
  deterministicUuidV8,
  hashPartsHex
} from "./populationZonesV2Identity.js";
import {
  populationZoneV2Geometry,
  populationZoneV2Halo,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import type {
  PopulationZoneV2HabitatCandidateSite
} from "./populationZonesV2Plan.js";
import {
  POPULATION_V2_MOB_DEFINITIONS,
  createPopulationV2MobRegistry,
  type PopulationV2MobDefinition
} from "./populationV2MobRegistry.js";

const GENERATION_ID = "10000000-0000-8000-8000-000000000001";
const PLAN_ID = "20000000-0000-8000-8000-000000000002";
const REVISION = "sap-crawler-flat-anchor-v1";
const NOW = new Date("2026-07-28T12:00:00.000Z");
const LEGACY_ROLLOUT_TEST_REGISTRY = createPopulationV2MobRegistry(
  POPULATION_V2_MOB_DEFINITIONS.map((definition) =>
    definition.mobKind === "sap_crawler"
      ? {
          ...definition,
          placementRevision: REVISION,
          compatiblePlacementRevisions:
            definition.compatiblePlacementRevisions?.filter(
              (revision) => revision !== REVISION
            ),
          generationPlacement: "registered_overlay",
          existingGenerationRolloutEligible: true
        }
      : definition
  ) as PopulationV2MobDefinition[]
);

describe("Postgres Population V2 registered-mob rollout store", () => {
  it("locks one target and atomically inserts only complete mob projections", async () => {
    const client = new FakeRolloutClient();
    const planned = completedOverlay();
    const planner = vi.fn(() => planned);
    const store = new PostgresPopulationV2RegisteredMobRolloutStore(
      new FakeRolloutPool(client) as unknown as pg.Pool,
      { planner, registry: LEGACY_ROLLOUT_TEST_REGISTRY }
    );

    const outcome = await store.execute(request());

    expect(outcome.disposition).toBe("applied");
    expect(outcome.receipt).toMatchObject({
      status: "completed",
      targetGroupCount: 1,
      targetBodyCount: 4,
      insertedGroupCount: 1,
      insertedBodyCount: 4,
      attemptCount: 1,
      completedAt: NOW
    });
    expect(outcome.insertedEntityIds).toEqual(
      planned.slots.map((slot) => slot.entityId)
    );
    expect(planner).toHaveBeenCalledOnce();
    expect(planner).toHaveBeenCalledWith(expect.objectContaining({
      generationId: GENERATION_ID,
      mode: "existing_generation_top_up",
      mobKinds: ["sap_crawler"],
      occupiedSlots: []
    }));

    const sql = client.calls.map((call) => compact(call.sql));
    expect(sql.filter((text) => text === "BEGIN")).toHaveLength(1);
    expect(sql.filter((text) =>
      text.includes("pg_advisory_xact_lock")
    )).toHaveLength(1);
    expect(client.calls.find((call) =>
      compact(call.sql).includes("pg_advisory_xact_lock")
    )?.values).toEqual([
      `population-v2-registered-mob-rollout-v1/${GENERATION_ID}`
      + `/sap_crawler/${REVISION}`
    ]);
    expectOrderedSql(sql, [
      "BEGIN",
      "pg_advisory_xact_lock",
      "FROM population_zone_generations_v2 AS generation_row",
      "FROM population_generation_mob_rollouts_v2",
      "FROM population_spawn_slots_v2 AS slot",
      "SAVEPOINT population_registered_mob_rollout",
      "UPDATE population_zone_generations_v2 AS generation_row",
      "INSERT INTO population_spawn_slots_v2",
      "INSERT INTO population_entity_state_v2",
      "INSERT INTO spawn_cells",
      "INSERT INTO generated_world_mobs",
      "INSERT INTO population_generation_mob_rollouts_v2",
      "RELEASE SAVEPOINT population_registered_mob_rollout",
      "COMMIT"
    ]);
    const mutationSql = sql.join("\n");
    expect(mutationSql).not.toContain("collectible_nodes");
    expect(mutationSql).not.toContain("repeatable_resource_nodes");
  });

  it("makes deterministic shortfall terminal and replay a no-op", async () => {
    const client = new FakeRolloutClient();
    const planner = vi.fn(() => shortfallOverlay());
    const store = new PostgresPopulationV2RegisteredMobRolloutStore(
      new FakeRolloutPool(client) as unknown as pg.Pool,
      { planner, registry: LEGACY_ROLLOUT_TEST_REGISTRY }
    );

    const first = await store.execute(request());
    expect(first).toMatchObject({
      disposition: "applied",
      receipt: {
        status: "completed_with_shortfall",
        shortfallGroupCount: 1,
        insertedBodyCount: 0
      },
      insertedEntityIds: []
    });
    const firstSql = client.calls.map((call) => compact(call.sql)).join("\n");
    expect(firstSql).not.toContain("INSERT INTO population_spawn_slots_v2");
    expect(firstSql).not.toContain("INSERT INTO generated_world_mobs");

    client.calls.length = 0;
    const replay = await store.execute(request());
    expect(replay.disposition).toBe("already_terminal");
    expect(planner).toHaveBeenCalledOnce();
    expect(client.calls.map((call) => compact(call.sql)).join("\n"))
      .not.toContain("SAVEPOINT population_registered_mob_rollout");
  });

  it("records partial persisted target packs as zero-insert terminal diagnostics", async () => {
    const client = new FakeRolloutClient();
    client.occupiedRows = overlaySlots().slice(0, 3).map((slot) =>
      occupiedRow(slot)
    );
    const planner = vi.fn((input: Readonly<{
      occupiedSlots: readonly PopulationV2RegisteredMobOccupiedSlot[];
    }>) => {
      expect(input.occupiedSlots).toHaveLength(3);
      return partialOverlay();
    });
    const store = new PostgresPopulationV2RegisteredMobRolloutStore(
      new FakeRolloutPool(client) as unknown as pg.Pool,
      { planner: planner as never, registry: LEGACY_ROLLOUT_TEST_REGISTRY }
    );

    const outcome = await store.execute(request());

    expect(outcome).toMatchObject({
      disposition: "terminal_diagnostic",
      receipt: {
        status: "terminal_diagnostic",
        insertedGroupCount: 0,
        insertedBodyCount: 0,
        attemptCount: 1
      },
      insertedEntityIds: []
    });
    expect(outcome.receipt.lastError).toMatch(/partial persisted/i);
    const sql = client.calls.map((call) => compact(call.sql)).join("\n");
    expect(sql).not.toContain("UPDATE population_zone_generations_v2 AS");
    expect(sql).not.toContain("INSERT INTO population_spawn_slots_v2");
    expect(sql).not.toContain("INSERT INTO generated_world_mobs");
  });

  it("maps persisted projection placement revision into occupied-slot authority", async () => {
    const client = new FakeRolloutClient();
    client.occupiedRows = [
      occupiedRow(overlaySlots()[0]!, "sap-crawler-flat-anchor-v0")
    ];
    const planner = vi.fn((input: Readonly<{
      occupiedSlots: readonly PopulationV2RegisteredMobOccupiedSlot[];
    }>) => {
      expect(input.occupiedSlots[0]?.placementRevision)
        .toBe("sap-crawler-flat-anchor-v0");
      return shortfallOverlay();
    });
    const store = new PostgresPopulationV2RegisteredMobRolloutStore(
      new FakeRolloutPool(client) as unknown as pg.Pool,
      { planner: planner as never, registry: LEGACY_ROLLOUT_TEST_REGISTRY }
    );

    await expect(store.execute(request())).resolves.toMatchObject({
      disposition: "applied",
      receipt: { status: "completed_with_shortfall" }
    });
    expect(planner).toHaveBeenCalledOnce();
  });

  it("passes authoritative adjacent-generation slots as spacing-only occupants", async () => {
    const client = new FakeRolloutClient();
    const target = overlaySlots()[0]!;
    const neighbor = {
      ...overlaySlots()[1]!,
      slotId: "81000000-0000-8000-8000-000000000001",
      entityId: "82000000-0000-8000-8000-000000000002"
    };
    const adjacentStone: PopulationV2RegisteredMobOccupiedSlot = {
      slotId: "84000000-0000-8000-8000-000000000004",
      entityId: "85000000-0000-8000-8000-000000000005",
      candidateId: "adjacent-selected-plan-stone",
      entityKind: "stone",
      archetype: "stone_mine",
      encounterId: null,
      packId: null,
      packMemberIndex: null,
      position: { lat: 35.08, lon: -106.65 },
      anchor: { lat: 35.08, lon: -106.65 },
      environmentSnapshot: {},
      suppressionClass: "none"
    };
    const neighborPlanId = "86000000-0000-8000-8000-000000000006";
    client.occupiedRows = [
      occupiedRow(target),
      occupiedRow(
        neighbor,
        neighbor.placementRevision,
        "83000000-0000-8000-8000-000000000003",
        4,
        neighborPlanId
      ),
      occupiedRow(adjacentStone, null, null, null, neighborPlanId)
    ];
    const planner = vi.fn((input: Readonly<{
      occupiedSlots: readonly PopulationV2RegisteredMobOccupiedSlot[];
      spacingOccupants?: readonly PopulationV2RegisteredMobOccupiedSlot[];
    }>) => {
      expect(input.occupiedSlots).toHaveLength(1);
      expect(input.occupiedSlots[0]?.entityId).toBe(target.entityId);
      expect(input.spacingOccupants).toHaveLength(2);
      expect(input.spacingOccupants?.[0]?.entityId).toBe(neighbor.entityId);
      expect(input.spacingOccupants?.[1]?.entityId)
        .toBe(adjacentStone.entityId);
      return shortfallOverlay();
    });
    const store = new PostgresPopulationV2RegisteredMobRolloutStore(
      new FakeRolloutPool(client) as unknown as pg.Pool,
      { planner: planner as never, registry: LEGACY_ROLLOUT_TEST_REGISTRY }
    );

    await expect(store.execute(request())).resolves.toMatchObject({
      disposition: "applied",
      receipt: { status: "completed_with_shortfall" }
    });
    const occupancyCall = client.calls.find((call) =>
      compact(call.sql).includes("ST_DWithin")
    );
    expect(occupancyCall?.values[2]).toBe(2_500);
    expect(compact(POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.occupiedSlots))
      .toContain(
        "slot.generation_id IS NULL AND slot.entity_kind='stone'"
      );
  });

  it("never plans a top-up from an adjacent zone's candidate anchor", async () => {
    const client = new FakeRolloutClient();
    const authority = authorityRow();
    const targetZoneId = authority.zone_id as PopulationZoneV2Id;
    const adjacentZoneId = populationZoneV2Halo(targetZoneId, 1)
      .find((zoneId) => zoneId !== targetZoneId)!;
    authority.habitat_snapshot.candidateSites = [
      rolloutCandidate(
        "owned-target-anchor",
        populationZoneV2Geometry(targetZoneId).center
      ) as never,
      rolloutCandidate(
        "foreign-adjacent-anchor",
        populationZoneV2Geometry(adjacentZoneId).center
      ) as never
    ];
    client.authorityRow = authority;
    const store = new PostgresPopulationV2RegisteredMobRolloutStore(
      new FakeRolloutPool(client) as unknown as pg.Pool,
      { registry: LEGACY_ROLLOUT_TEST_REGISTRY }
    );

    const outcome = await store.execute(request());

    expect(outcome).toMatchObject({
      disposition: "applied",
      receipt: {
        status: "completed",
        insertedGroupCount: 1
      }
    });
    const insertion = client.calls.find((call) =>
      compact(call.sql).startsWith("INSERT INTO population_spawn_slots_v2")
    );
    const insertedSlots = JSON.parse(String(insertion?.values[2])) as Array<{
      environment_snapshot: { sourceAnchorSiteId?: string };
    }>;
    expect(new Set(insertedSlots.map((slot) =>
      slot.environment_snapshot.sourceAnchorSiteId
    ))).toEqual(new Set(["owned-target-anchor"]));
  });

  it("recognizes only exact retained bad-deploy Resin Crawler identities as the current revision", async () => {
    const client = new FakeRolloutClient();
    client.occupiedRows = [badDeploySapOccupiedRow()];
    const planner = vi.fn((input: Readonly<{
      occupiedSlots: readonly PopulationV2RegisteredMobOccupiedSlot[];
    }>) => {
      expect(input.occupiedSlots).toHaveLength(1);
      expect(input.occupiedSlots[0]?.placementRevision).toBe(REVISION);
      return shortfallOverlay();
    });
    const store = new PostgresPopulationV2RegisteredMobRolloutStore(
      new FakeRolloutPool(client) as unknown as pg.Pool,
      { planner: planner as never, registry: LEGACY_ROLLOUT_TEST_REGISTRY }
    );

    await expect(store.execute(request())).resolves.toMatchObject({
      disposition: "applied",
      receipt: { status: "completed_with_shortfall" }
    });
    expect(planner).toHaveBeenCalledOnce();
  });

  it("persists bounded transient retry metadata and marks exhaustion", async () => {
    const client = new FakeRolloutClient();
    const planner = vi.fn(() => {
      throw Object.assign(new Error("serialization retry"), {
        code: "40001"
      });
    });
    const store = new PostgresPopulationV2RegisteredMobRolloutStore(
      new FakeRolloutPool(client) as unknown as pg.Pool,
      {
        planner: planner as never,
        registry: LEGACY_ROLLOUT_TEST_REGISTRY,
        maximumAttempts: 2,
        initialRetryDelayMs: 1_000,
        maximumRetryDelayMs: 1_000
      }
    );

    const first = await store.execute(request());
    expect(first).toMatchObject({
      disposition: "retry_scheduled",
      receipt: {
        status: "retryable_failure",
        attemptCount: 1,
        completedAt: null
      }
    });
    expect(first.receipt.nextRetryAt).toEqual(
      new Date(NOW.getTime() + 1_000)
    );

    client.authorityRow!.database_now = new Date(NOW.getTime() + 2_000);
    const second = await store.execute(request());
    expect(second).toMatchObject({
      disposition: "retry_exhausted",
      receipt: {
        status: "terminal_diagnostic",
        attemptCount: 2,
        nextRetryAt: null,
        completedAt: new Date(NOW.getTime() + 2_000)
      }
    });
    expect(planner).toHaveBeenCalledTimes(2);
    expect(client.calls.map((call) => compact(call.sql)).filter((sql) =>
      sql === "ROLLBACK TO SAVEPOINT population_registered_mob_rollout"
    )).toHaveLength(2);
  });

  it("rejects stale authority but treats a missing legacy receipt as absence", async () => {
    const client = new FakeRolloutClient();
    client.authorityRow = null;
    const pool = new FakeRolloutPool(client);
    const store = new PostgresPopulationV2RegisteredMobRolloutStore(
      pool as unknown as pg.Pool,
      { registry: LEGACY_ROLLOUT_TEST_REGISTRY }
    );

    await expect(store.loadReceipt(request())).resolves.toBeNull();
    await expect(store.execute(request())).rejects.toBeInstanceOf(
      PopulationV2RegisteredMobRolloutAuthorityError
    );
    expect(client.calls.map((call) => compact(call.sql))).toContain("ROLLBACK");
    expect(client.receiptRow).toBeNull();
  });

  it("uses selected-plan/current/unexpired authority and mob-only SQL shapes", () => {
    const authority = compact(
      POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.authority
    );
    expect(authority).toContain("cutover.selected_plan_id=generation_row.plan_id");
    expect(authority).toContain("plan.status='ready'");
    expect(authority).toContain("generation_row.is_current");
    expect(authority).toContain("generation_row.status='active'");
    expect(authority).toContain(
      "generation_row.expires_at > statement_timestamp()"
    );
    expect(authority).toContain(
      "FOR UPDATE OF generation_row, cutover"
    );
    const occupied = compact(
      POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.occupiedSlots
    );
    expect(occupied).toContain(
      "LEFT JOIN generated_world_mobs AS projection"
    );
    expect(occupied).toContain(
      "LEFT JOIN population_entity_state_v2 AS canonical"
    );
    expect(occupied).toContain(
      "projection.population_v2_entity_id=slot.entity_id"
    );
    expect(occupied).toContain(
      "projection.environment_snapshot->>'placementRevision'"
    );
    expect(occupied).toContain(
      "projection.placement_version"
    );
    expect(occupied).toContain(
      "projection.population_v2_state_revision AS projection_state_revision"
    );
    expect(occupied).toContain(
      "projection.population_cutover_suppressed AS projection_cutover_suppressed"
    );
    expect(occupied).toContain("owner_generation.is_current");
    expect(occupied).toContain("owner_generation.status='active'");
    expect(occupied).toContain(
      "owner_generation.expires_at > statement_timestamp()"
    );
    expect(occupied).toContain(
      "owner_cutover.selected_plan_id=owner_plan.plan_id"
    );
    expect(occupied).toContain(
      "owner_generation.plan_id=owner_plan.plan_id"
    );
    expect(occupied).toContain(
      "owner_generation.zone_id=owner_plan.zone_id"
    );
    expect(occupied).toContain("owner_cutover.serving_version='v2'");
    expect(occupied).toContain("owner_cutover.status='stable'");
    expect(occupied).toContain("ST_DWithin");

    const insertions = [
      POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.insertSlots,
      POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.insertStates,
      POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.insertSpawnCells,
      POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.insertMobProjections,
      POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.upsertReceipt
    ].map(compact).join("\n");
    expect(insertions).toContain("INSERT INTO generated_world_mobs");
    expect(insertions).not.toContain("collectible_nodes");
    expect(insertions).not.toContain("repeatable_resource_nodes");
    expect(insertions).not.toMatch(/\bDELETE\b/iu);
  });

  it("maps a replayed receipt to a no-change worker result", async () => {
    const execute = vi.fn(async () => ({
      disposition: "already_terminal" as const,
      receipt: {
        generationId: GENERATION_ID,
        mobKind: "sap_crawler",
        rolloutRevision: REVISION,
        source: "top_up" as const,
        status: "completed" as const,
        targetGroupCount: 1,
        targetBodyCount: 5,
        insertedGroupCount: 1,
        insertedBodyCount: 5,
        shortfallGroupCount: 0,
        attemptCount: 1,
        nextRetryAt: null,
        lastError: null,
        attemptedAt: NOW,
        completedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW
      },
      insertedEntityIds: []
    }));
    const executor = new PopulationV2PostgresMobRolloutExecutor({ execute });

    await expect(executor.execute({
      generationId: GENERATION_ID,
      zoneId: "ppz2-eag1/aq5/55e",
      mobKind: "sap_crawler",
      rolloutRevision: REVISION,
      referenced: true
    })).resolves.toEqual({
      status: "completed",
      insertedGroupCount: 0,
      insertedBodyCount: 0,
      shortfallGroupCount: 0,
      attemptCount: 1,
      changed: false
    });
  });
});

type QueryCall = {
  sql: string;
  values: readonly unknown[];
};

class FakeRolloutPool {
  constructor(private readonly client: FakeRolloutClient) {}

  async connect(): Promise<FakeRolloutClient> {
    return this.client;
  }

  async query<Row>(
    sql: string,
    values: readonly unknown[]
  ): Promise<FakeQueryResult<Row>> {
    this.client.calls.push({ sql, values });
    if (compact(sql).startsWith("SELECT generation_id, mob_kind")) {
      return fakeResult<Row>(
        this.client.receiptRow === null ? [] : [this.client.receiptRow]
      );
    }
    return fakeResult<Row>([]);
  }
}

class FakeRolloutClient {
  readonly calls: QueryCall[] = [];
  authorityRow: ReturnType<typeof authorityRow> | null = authorityRow();
  receiptRow: ReturnType<typeof receiptRow> | null = null;
  occupiedRows: ReturnType<typeof occupiedRow>[] = [];
  released = false;

  async query<Row>(
    sql: string,
    values: readonly unknown[] = []
  ): Promise<FakeQueryResult<Row>> {
    this.calls.push({ sql, values });
    const normalized = compact(sql);
    if (
      normalized.includes(
        "FROM population_zone_generations_v2 AS generation_row"
      )
    ) {
      return fakeResult<Row>(
        this.authorityRow === null ? [] : [this.authorityRow]
      );
    }
    if (
      normalized.startsWith("SELECT generation_id, mob_kind")
      && normalized.includes(
        "FROM population_generation_mob_rollouts_v2"
      )
    ) {
      return fakeResult<Row>(
        this.receiptRow === null ? [] : [this.receiptRow]
      );
    }
    if (
      normalized.startsWith(
        "SELECT slot.plan_id AS owner_plan_id"
      )
      && normalized.includes("FROM population_spawn_slots_v2 AS slot")
      && normalized.includes("slot.generation_id=$1::uuid")
    ) {
      return fakeResult<Row>(this.occupiedRows);
    }
    if (
      normalized.startsWith(
        "UPDATE population_zone_generations_v2 AS generation_row"
      )
    ) {
      return fakeResult<Row>([{ planned_nonstone_count: values[1] }], 1);
    }
    if (
      normalized.startsWith(
        "INSERT INTO population_generation_mob_rollouts_v2"
      )
    ) {
      this.receiptRow = receiptRow(values);
      return fakeResult<Row>([this.receiptRow], 1);
    }
    if (normalized.startsWith("INSERT INTO population_spawn_slots_v2")) {
      return fakeResult<Row>([], jsonRowCount(values[2]));
    }
    if (normalized.startsWith("INSERT INTO population_entity_state_v2")) {
      return fakeResult<Row>(
        [],
        Array.isArray(values[1]) ? values[1].length : 0
      );
    }
    if (normalized.startsWith("INSERT INTO generated_world_mobs")) {
      return fakeResult<Row>([], jsonRowCount(values[5]));
    }
    return fakeResult<Row>([], 1);
  }

  release(): void {
    this.released = true;
  }
}

type FakeQueryResult<Row> = {
  rows: Row[];
  rowCount: number;
};

function fakeResult<Row>(
  rows: readonly unknown[],
  rowCount = rows.length
): FakeQueryResult<Row> {
  return {
    rows: rows as Row[],
    rowCount
  };
}

function request() {
  return {
    generationId: GENERATION_ID,
    mobKind: "sap_crawler",
    placementRevision: REVISION,
    mode: "existing_generation_top_up" as const
  };
}

function authorityRow() {
  return {
    generation_id: GENERATION_ID,
    zone_id: "ppz2-eag1/aq5/55e",
    plan_id: PLAN_ID,
    generation_number: 1,
    expires_at: new Date(NOW.getTime() + 60_000),
    planned_nonstone_count: 12,
    habitat_snapshot: {
      regionCode: "us-nm-albuquerque",
      eligibleLandKm2: 8,
      treeKm2: 8,
      deerKm2: 8,
      wolfKm2: 8,
      stoneKm2: 8,
      ogreKm2: 8,
      habitatSummary: {},
      environmentSnapshot: {},
      candidateSites: []
    },
    region_code: "us-nm-albuquerque",
    cutover_revision: 4,
    database_now: NOW
  };
}

function receiptRow(values: readonly unknown[] = []) {
  return {
    generation_id: String(values[0] ?? GENERATION_ID),
    mob_kind: String(values[1] ?? "sap_crawler"),
    rollout_revision: String(values[2] ?? REVISION),
    source: String(values[3] ?? "top_up"),
    status: String(values[4] ?? "completed"),
    target_group_count: Number(values[5] ?? 0),
    target_body_count: Number(values[6] ?? 0),
    inserted_group_count: Number(values[7] ?? 0),
    inserted_body_count: Number(values[8] ?? 0),
    shortfall_group_count: Number(values[9] ?? 0),
    attempt_count: Number(values[10] ?? 0),
    next_retry_at: values[11] as Date | null ?? null,
    last_error: values[12] as string | null ?? null,
    attempted_at: values[13] as Date ?? NOW,
    completed_at: values[14] as Date | null ?? null,
    created_at: NOW,
    updated_at: values[13] as Date ?? NOW
  };
}

function completedOverlay(): PopulationV2RegisteredMobOverlayResult {
  const slots = overlaySlots();
  return overlayResult({
    status: "completed",
    slots,
    target: { groups: 1, bodies: slots.length },
    current: { groups: 0, bodies: 0 },
    inserted: { groups: 1, bodies: slots.length },
    shortfall: { groups: 0, bodies: 0 },
    terminalPartialGroups: []
  });
}

function shortfallOverlay(): PopulationV2RegisteredMobOverlayResult {
  return overlayResult({
    status: "completed_with_shortfall",
    slots: [],
    target: { groups: 1, bodies: 5 },
    current: { groups: 0, bodies: 0 },
    inserted: { groups: 0, bodies: 0 },
    shortfall: { groups: 1, bodies: 5 },
    terminalPartialGroups: []
  });
}

function partialOverlay(): PopulationV2RegisteredMobOverlayResult {
  const diagnostic = {
    mobKind: "sap_crawler",
    placementRevision: REVISION,
    candidateId: "registered-sap-candidate",
    bodyCount: 3,
    presentMemberIndexes: [0, 1, 2],
    expectedMemberCounts: [5, 6, 7],
    reason: "partial_or_corrupt_persisted_group" as const
  };
  return overlayResult({
    status: "terminal_partial_group",
    slots: [],
    target: { groups: 1, bodies: 5 },
    current: { groups: 0, bodies: 3 },
    inserted: { groups: 0, bodies: 0 },
    shortfall: { groups: 1, bodies: 2 },
    terminalPartialGroups: [diagnostic]
  });
}

function overlayResult(input: Readonly<{
  status: PopulationV2RegisteredMobOverlayResult["status"];
  slots: readonly PopulationV2RegisteredMobOverlaySlot[];
  target: Readonly<{ groups: number; bodies: number }>;
  current: Readonly<{ groups: number; bodies: number }>;
  inserted: Readonly<{ groups: number; bodies: number }>;
  shortfall: Readonly<{ groups: number; bodies: number }>;
  terminalPartialGroups:
    PopulationV2RegisteredMobOverlayResult["terminalPartialGroups"];
}>): PopulationV2RegisteredMobOverlayResult {
  return {
    mode: "existing_generation_top_up",
    ...input,
    mobs: [{
      mobKind: "sap_crawler",
      placementRevision: REVISION,
      rolloutPolicy: "next_generation_only",
      status: input.status,
      target: input.target,
      current: input.current,
      inserted: input.inserted,
      shortfall: input.shortfall,
      eligibleAnchorCount: 1,
      consideredAnchorCount: 1,
      terminalPartialGroups: input.terminalPartialGroups
    }]
  };
}

function overlaySlots(): PopulationV2RegisteredMobOverlaySlot[] {
  const candidateId = "30000000-0000-8000-8000-000000000003";
  const encounterId = "40000000-0000-8000-8000-000000000004";
  const packId = "50000000-0000-8000-8000-000000000005";
  return Array.from({ length: 4 }, (_, memberIndex) => ({
    slotId: `60000000-0000-8000-8000-00000000000${memberIndex}`,
    entityId: `70000000-0000-8000-8000-00000000000${memberIndex}`,
    candidateId,
    entityKind: "sap_crawler",
    mobKind: "sap_crawler",
    archetype: "sap_crawler",
    encounterId,
    packId,
    packMemberIndex: memberIndex,
    position: {
      lat: 35.08 + memberIndex / 10_000,
      lon: -106.65
    },
    anchor: { lat: 35.08, lon: -106.65 },
    environmentSnapshot: {
      sourceAnchorSiteId: "candidate-site-1"
    },
    suppressionClass: "hostile-pack",
    placementRevision: REVISION,
    spacingClass: "small_hostile_pack",
    sourceAnchorSiteId: "candidate-site-1"
  }));
}

function occupiedRow(
  slot: PopulationV2RegisteredMobOccupiedSlot,
  placementRevision: string | null = slot.placementRevision ?? null,
  ownerGenerationId: string | null = GENERATION_ID,
  ownerGenerationNumber: number | null = 1,
  ownerPlanId = PLAN_ID
) {
  return {
    owner_plan_id: ownerPlanId,
    owner_generation_id: ownerGenerationId,
    owner_generation_number: ownerGenerationNumber,
    slot_id: slot.slotId,
    entity_id: slot.entityId,
    candidate_id: slot.candidateId,
    entity_kind: slot.entityKind,
    archetype: slot.archetype,
    encounter_id: slot.encounterId,
    pack_id: slot.packId,
    pack_member_index: slot.packMemberIndex,
    latitude: slot.position.lat,
    longitude: slot.position.lon,
    anchor_latitude: slot.anchor.lat,
    anchor_longitude: slot.anchor.lon,
    environment_snapshot: slot.environmentSnapshot,
    suppression_class: slot.suppressionClass,
    placement_revision: placementRevision
  };
}

function rolloutCandidate(
  siteId: string,
  position: Readonly<{ lat: number; lon: number }>
): PopulationZoneV2HabitatCandidateSite {
  return {
    siteId,
    position,
    source: "world-profile-candidate-slot",
    sourceSampleId: `${siteId}-sample`,
    sourceCellId: `${siteId}-cell`,
    sourceSlotId: `${siteId}-slot`,
    candidateSlotVersion: "rollout-zone-ownership-test-v1",
    placementTags: ["flat-anchor"],
    isSaltwater: false,
    insideMajorLake: false,
    elevationBand: "low",
    terrainClass: "flat",
    landCoverClass: "grassland",
    biomeId: "test-biome",
    ecoregionId: "test-ecoregion",
    spawnProfileKey: "rollout-zone-ownership-test",
    weights: {
      eligibleLand: 1,
      tree: 1,
      deer: 1,
      wolf: 1,
      stone: 1,
      ogre: 1
    }
  };
}

function badDeploySapOccupiedRow() {
  const templateCandidateId = "retained-sap-template-candidate";
  const generationNumber = 1;
  const generationCandidateId = `${templateCandidateId}/${hashPartsHex(
    "population-generation-sap-crawler-template-candidate-v1",
    REVISION,
    GENERATION_ID,
    generationNumber,
    templateCandidateId
  ).slice(0, 16)}`;
  const authority = {
    generationCandidateId,
    generationId: GENERATION_ID,
    generationNumber,
    templateCandidateId
  };
  const memberIndex = 0;
  const slotId = deterministicUuidV8(
    "population-generation-sap-crawler-template-slot-v1",
    { ...authority, memberIndex, placementRevision: REVISION }
  );
  return {
    owner_plan_id: PLAN_ID,
    owner_generation_id: GENERATION_ID,
    owner_generation_number: generationNumber,
    slot_id: slotId,
    entity_id: deterministicUuidV8(
      "population-generation-sap-crawler-template-entity-v1",
      {
        ...authority,
        memberIndex,
        placementRevision: REVISION,
        slotId
      }
    ),
    candidate_id: generationCandidateId,
    entity_kind: "sap_crawler",
    archetype: "sap_crawler",
    encounter_id: deterministicUuidV8(
      "population-generation-sap-crawler-template-encounter-v1",
      { ...authority, placementRevision: REVISION }
    ),
    pack_id: deterministicUuidV8(
      "population-generation-sap-crawler-template-pack-v1",
      { ...authority, placementRevision: REVISION }
    ),
    pack_member_index: memberIndex,
    latitude: 35.08,
    longitude: -106.65,
    anchor_latitude: 35.08,
    anchor_longitude: -106.65,
    environment_snapshot: {
      sourceAnchorSiteId: "retained-sap-template-anchor"
    },
    suppression_class: "hostile-pack" as const,
    placement_revision: "population-v2-layout-v3"
  };
}

function compact(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

function jsonRowCount(value: unknown): number {
  return typeof value === "string"
    ? (JSON.parse(value) as unknown[]).length
    : 0;
}

function expectOrderedSql(sql: readonly string[], fragments: readonly string[]) {
  let previous = -1;
  for (const fragment of fragments) {
    const index = sql.findIndex((text, candidateIndex) =>
      candidateIndex > previous && text.includes(fragment)
    );
    expect(index, `missing ordered SQL fragment: ${fragment}`)
      .toBeGreaterThan(previous);
    previous = index;
  }
}
