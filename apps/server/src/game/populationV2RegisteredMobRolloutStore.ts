import type pg from "pg";

import { spawnCellForPoint } from "./collectibles.js";
import type {
  PopulationV2MobRolloutExecution,
  PopulationV2MobRolloutExecutor,
  PopulationV2MobRolloutRequest as PopulationV2QueuedMobRolloutRequest
} from "./populationV2MobRolloutService.js";
import {
  populationV2MobRegistry,
  type PopulationV2MobDefinition,
  type PopulationV2MobRegistry
} from "./populationV2MobRegistry.js";
import {
  POPULATION_V2_MAXIMUM_SPACING_DISTANCE_M
} from "./populationV2MobSpacing.js";
import {
  planPopulationV2RegisteredMobOverlay,
  type PopulationV2RegisteredMobOccupiedSlot,
  type PopulationV2RegisteredMobOverlayMode,
  type PopulationV2RegisteredMobOverlayResult,
  type PopulationV2RegisteredMobOverlaySlot
} from "./populationV2RegisteredMobOverlay.js";
import {
  deterministicUuidV8,
  hashPartsHex
} from "./populationZonesV2Identity.js";
import type { PopulationV2KindDefinition } from "./populationV2KindRegistry.js";
import { populationZoneV2IdForPoint } from "./populationZonesV2Geometry.js";
import type {
  PopulationZoneV2Habitat,
  PopulationZoneV2PlanSlot
} from "./populationZonesV2Plan.js";

export type PopulationV2RegisteredMobRolloutReceiptStatus =
  | "completed"
  | "completed_with_shortfall"
  | "retryable_failure"
  | "terminal_diagnostic";

export type PopulationV2RegisteredMobRolloutSource =
  | "generation"
  | "top_up";

export type PopulationV2RegisteredMobRolloutReceipt = Readonly<{
  generationId: string;
  mobKind: string;
  rolloutRevision: string;
  source: PopulationV2RegisteredMobRolloutSource;
  status: PopulationV2RegisteredMobRolloutReceiptStatus;
  targetGroupCount: number;
  targetBodyCount: number;
  insertedGroupCount: number;
  insertedBodyCount: number;
  shortfallGroupCount: number;
  attemptCount: number;
  nextRetryAt: Date | null;
  lastError: string | null;
  attemptedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type PopulationV2RegisteredMobRolloutDisposition =
  | "applied"
  | "already_terminal"
  | "retry_not_due"
  | "retry_scheduled"
  | "retry_exhausted"
  | "terminal_diagnostic";

export type PopulationV2RegisteredMobRolloutOutcome = Readonly<{
  disposition: PopulationV2RegisteredMobRolloutDisposition;
  receipt: PopulationV2RegisteredMobRolloutReceipt;
  insertedEntityIds: readonly string[];
}>;

export type PopulationV2RegisteredMobRolloutRequest = Readonly<{
  generationId: string;
  mobKind: string;
  placementRevision: string;
  mode?: PopulationV2RegisteredMobOverlayMode;
}>;

export type PopulationV2RegisteredMobRolloutStoreOptions = Readonly<{
  registry?: PopulationV2MobRegistry;
  planner?: typeof planPopulationV2RegisteredMobOverlay;
  maximumAttempts?: number;
  initialRetryDelayMs?: number;
  maximumRetryDelayMs?: number;
}>;

type AuthorityRow = {
  generation_id: string;
  zone_id: string;
  plan_id: string;
  generation_number: string | number;
  expires_at: Date | string;
  planned_nonstone_count: number | string;
  habitat_snapshot: PopulationZoneV2Habitat;
  region_code: string;
  cutover_revision: string | number;
  database_now: Date | string;
};

type OccupiedSlotRow = {
  owner_plan_id: string;
  owner_zone_id?: string | null;
  owner_generation_id: string | null;
  owner_generation_number: string | number | null;
  owner_cutover_revision?: string | number | null;
  slot_id: string;
  entity_id: string;
  candidate_id: string;
  entity_kind: string;
  archetype: string;
  encounter_id: string | null;
  pack_id: string | null;
  pack_member_index: number | null;
  latitude: number | string;
  longitude: number | string;
  anchor_latitude: number | string;
  anchor_longitude: number | string;
  environment_snapshot: PopulationZoneV2PlanSlot["environmentSnapshot"];
  suppression_class: PopulationZoneV2PlanSlot["suppressionClass"];
  placement_revision: string | null;
  canonical_state?: string | null;
  canonical_state_revision?: string | number | null;
  canonical_state_actor_player_id?: string | null;
  canonical_killed_or_harvested_at?: Date | string | null;
  projection_entity_id?: string | null;
  projection_encounter_id?: string | null;
  projection_mob_archetype?: string | null;
  projection_pack_id?: string | null;
  projection_killed_at?: Date | string | null;
  projection_killed_by_player_id?: string | null;
  projection_zone_id?: string | null;
  projection_plan_id?: string | null;
  projection_state_revision?: string | number | null;
  projection_cutover_revision?: string | number | null;
  projection_cutover_suppressed?: boolean | null;
};

type ReceiptRow = {
  generation_id: string;
  mob_kind: string;
  rollout_revision: string;
  source: PopulationV2RegisteredMobRolloutSource;
  status: PopulationV2RegisteredMobRolloutReceiptStatus;
  target_group_count: number | string;
  target_body_count: number | string;
  inserted_group_count: number | string;
  inserted_body_count: number | string;
  shortfall_group_count: number | string;
  attempt_count: number | string;
  next_retry_at: Date | string | null;
  last_error: string | null;
  attempted_at: Date | string;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type ReceiptWrite = Readonly<{
  source: PopulationV2RegisteredMobRolloutSource;
  status: PopulationV2RegisteredMobRolloutReceiptStatus;
  targetGroupCount: number;
  targetBodyCount: number;
  insertedGroupCount: number;
  insertedBodyCount: number;
  shortfallGroupCount: number;
  attemptCount: number;
  nextRetryAt: Date | null;
  lastError: string | null;
  attemptedAt: Date;
  completedAt: Date | null;
}>;

type OverlayCountsSnapshot = Readonly<{
  targetGroupCount: number;
  targetBodyCount: number;
  shortfallGroupCount: number;
}>;

const TERMINAL_RECEIPT_STATUSES = new Set<
  PopulationV2RegisteredMobRolloutReceiptStatus
>([
  "completed",
  "completed_with_shortfall",
  "terminal_diagnostic"
]);

const RETRYABLE_POSTGRES_CODES = new Set([
  "40001",
  "40P01",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03"
]);
const BAD_DEPLOY_SAP_PLACEMENT_REVISION =
  "sap-crawler-flat-anchor-v1";
const BAD_DEPLOY_SAP_CANDIDATE_VERSION =
  "population-generation-sap-crawler-template-candidate-v1";
const BAD_DEPLOY_SAP_SLOT_VERSION =
  "population-generation-sap-crawler-template-slot-v1";
const BAD_DEPLOY_SAP_ENTITY_VERSION =
  "population-generation-sap-crawler-template-entity-v1";
const BAD_DEPLOY_SAP_ENCOUNTER_VERSION =
  "population-generation-sap-crawler-template-encounter-v1";
const BAD_DEPLOY_SAP_PACK_VERSION =
  "population-generation-sap-crawler-template-pack-v1";

export const POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL = Object.freeze({
  advisoryLock:
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
  authority: `
    SELECT generation_row.generation_id, generation_row.zone_id,
           generation_row.plan_id, generation_row.generation_number,
           generation_row.expires_at,
           generation_row.planned_nonstone_count,
           plan.habitat_snapshot, plan.region_code,
           cutover.cutover_revision,
           statement_timestamp() AS database_now
    FROM population_zone_generations_v2 AS generation_row
    JOIN population_zones_v2 AS plan
      ON plan.plan_id=generation_row.plan_id
     AND plan.zone_id=generation_row.zone_id
     AND plan.status='ready'
     AND plan.habitat_snapshot IS NOT NULL
    JOIN population_zone_cutovers_v2 AS cutover
      ON cutover.zone_id=generation_row.zone_id
     AND cutover.geometry_version=plan.geometry_version
     AND cutover.selected_plan_id=generation_row.plan_id
     AND cutover.serving_version='v2'
     AND cutover.status='stable'
    WHERE generation_row.generation_id=$1::uuid
      AND generation_row.is_current
      AND generation_row.status='active'
      AND generation_row.expires_at > statement_timestamp()
    FOR UPDATE OF generation_row, cutover`,
  receiptForUpdate: `
    SELECT generation_id, mob_kind, rollout_revision, source, status,
           target_group_count, target_body_count,
           inserted_group_count, inserted_body_count,
           shortfall_group_count, attempt_count, next_retry_at,
           last_error, attempted_at, completed_at, created_at, updated_at
    FROM population_generation_mob_rollouts_v2
    WHERE generation_id=$1::uuid
      AND mob_kind=$2
      AND rollout_revision=$3
    FOR UPDATE`,
  occupiedSlots: `
    SELECT slot.plan_id AS owner_plan_id,
           owner_plan.zone_id AS owner_zone_id,
           owner_generation.generation_id AS owner_generation_id,
           owner_generation.generation_number AS owner_generation_number,
           owner_cutover.cutover_revision AS owner_cutover_revision,
           slot.slot_id, slot.entity_id, slot.candidate_id,
           slot.entity_kind, slot.archetype, slot.encounter_id,
           slot.pack_id, slot.pack_member_index,
           slot.latitude, slot.longitude,
           slot.anchor_latitude, slot.anchor_longitude,
           slot.environment_snapshot, slot.suppression_class,
           COALESCE(
             NULLIF(
               projection.environment_snapshot->>'placementRevision',
               ''
             ),
             projection.placement_version
           ) AS placement_revision,
           canonical.state AS canonical_state,
           canonical.state_revision AS canonical_state_revision,
           canonical.state_actor_player_id AS canonical_state_actor_player_id,
           canonical.killed_or_harvested_at
             AS canonical_killed_or_harvested_at,
           projection.entity_id AS projection_entity_id,
           projection.encounter_id AS projection_encounter_id,
           projection.mob_archetype AS projection_mob_archetype,
           projection.pack_id AS projection_pack_id,
           projection.killed_at AS projection_killed_at,
           projection.killed_by_player_id AS projection_killed_by_player_id,
           projection.physical_population_zone_v2_id
             AS projection_zone_id,
           projection.population_v2_plan_id AS projection_plan_id,
           projection.population_v2_state_revision
             AS projection_state_revision,
           projection.population_cutover_revision
             AS projection_cutover_revision,
           projection.population_cutover_suppressed
             AS projection_cutover_suppressed
    FROM population_spawn_slots_v2 AS slot
    JOIN population_zones_v2 AS target_plan
      ON target_plan.plan_id=$2::uuid
     AND target_plan.status='ready'
    LEFT JOIN population_zone_generations_v2 AS owner_generation
      ON owner_generation.generation_id=slot.generation_id
    LEFT JOIN population_zones_v2 AS owner_plan
      ON owner_plan.plan_id=slot.plan_id
    LEFT JOIN population_zone_cutovers_v2 AS owner_cutover
      ON owner_cutover.zone_id=owner_plan.zone_id
     AND owner_cutover.geometry_version=owner_plan.geometry_version
     AND owner_cutover.selected_plan_id=owner_plan.plan_id
    LEFT JOIN generated_world_mobs AS projection
      ON projection.population_v2_entity_id=slot.entity_id
    LEFT JOIN population_entity_state_v2 AS canonical
      ON canonical.entity_id=slot.entity_id
    WHERE (
        (slot.plan_id=$2::uuid AND slot.generation_id=$1::uuid)
        OR (
          slot.plan_id=$2::uuid
          AND slot.generation_id IS NULL
          AND slot.entity_kind='stone'
        )
        OR (
          owner_plan.zone_id<>target_plan.zone_id
          AND owner_plan.status='ready'
          AND owner_cutover.serving_version='v2'
          AND owner_cutover.status='stable'
          AND ST_DWithin(
            slot.anchor_geom,
            target_plan.zone_geog,
            $3::double precision
          )
          AND (
            (
              owner_generation.generation_id<>$1::uuid
              AND owner_generation.plan_id=owner_plan.plan_id
              AND owner_generation.zone_id=owner_plan.zone_id
              AND owner_generation.is_current
              AND owner_generation.status='active'
              AND owner_generation.expires_at > statement_timestamp()
            )
            OR (
              slot.generation_id IS NULL
              AND slot.entity_kind='stone'
            )
          )
        )
      )
    ORDER BY owner_generation.generation_id NULLS FIRST,
             slot.entity_kind, slot.candidate_id,
             slot.pack_member_index NULLS FIRST, slot.entity_id`,
  raiseGenerationCap: `
    UPDATE population_zone_generations_v2 AS generation_row
    SET planned_nonstone_count=GREATEST(
          generation_row.planned_nonstone_count,
          (
            SELECT count(*)::integer
            FROM population_spawn_slots_v2
            WHERE generation_id=$1::uuid
          ) + $2::integer
        ),
        updated_at=clock_timestamp()
    WHERE generation_row.generation_id=$1::uuid
      AND generation_row.is_current
      AND generation_row.status='active'
      AND generation_row.expires_at > statement_timestamp()
    RETURNING generation_row.planned_nonstone_count`,
  insertSlots: `
    INSERT INTO population_spawn_slots_v2 (
      plan_id, generation_id, slot_id, entity_id, candidate_id, entity_kind,
      archetype, encounter_id, pack_id, pack_member_index,
      latitude, longitude, geom, anchor_latitude, anchor_longitude,
      anchor_geom, environment_snapshot, suppression_class
    )
    SELECT $1::uuid, $2::uuid, slot.slot_id, slot.entity_id,
           slot.candidate_id, slot.entity_kind, slot.archetype,
           slot.encounter_id, slot.pack_id, slot.pack_member_index,
           slot.latitude, slot.longitude,
           ST_SetSRID(
             ST_MakePoint(slot.longitude, slot.latitude),
             4326
           )::geography,
           slot.anchor_latitude, slot.anchor_longitude,
           ST_SetSRID(
             ST_MakePoint(slot.anchor_longitude, slot.anchor_latitude),
             4326
           )::geography,
           slot.environment_snapshot, slot.suppression_class
    FROM jsonb_to_recordset($3::jsonb) AS slot(
      slot_id uuid, entity_id uuid, candidate_id text,
      entity_kind text, archetype text, encounter_id uuid,
      pack_id uuid, pack_member_index smallint,
      latitude double precision, longitude double precision,
      anchor_latitude double precision, anchor_longitude double precision,
      environment_snapshot jsonb, suppression_class text
    )`,
  insertStates: `
    INSERT INTO population_entity_state_v2 (entity_id, state)
    SELECT slot.entity_id, 'ready'
    FROM population_spawn_slots_v2 AS slot
    WHERE slot.generation_id=$1::uuid
      AND slot.entity_id=ANY($2::uuid[])`,
  insertSpawnCells: `
    INSERT INTO spawn_cells (
      id, region_code, cell_x, cell_y, center_lat, center_lon
    )
    SELECT cell.spawn_cell_id, cell.spawn_cell_region_code,
           cell.spawn_cell_x, cell.spawn_cell_y,
           cell.spawn_cell_center_lat, cell.spawn_cell_center_lon
    FROM jsonb_to_recordset($1::jsonb) AS cell(
      spawn_cell_id text, spawn_cell_region_code text,
      spawn_cell_x integer, spawn_cell_y integer,
      spawn_cell_center_lat double precision,
      spawn_cell_center_lon double precision
    )
    ON CONFLICT (id) DO NOTHING`,
  insertMobProjections: `
    INSERT INTO generated_world_mobs (
      entity_id, encounter_id, mob_archetype, pack_id,
      spawn_cell_id, region_code, lat, lon, geom,
      anchor_lat, anchor_lon, placement_version,
      environment_world_identity_key, environment_profile_version,
      environment_candidate_slot_version, environment_cell_id,
      environment_slot_id, environment_snapshot,
      population_v2_entity_id, physical_population_zone_v2_id,
      population_v2_plan_id, population_v2_state_revision,
      population_cutover_revision, population_cutover_suppressed
    )
    SELECT mob.entity_id::text, mob.encounter_id::text, mob.archetype,
           mob.pack_id::text, mob.spawn_cell_id, $2,
           mob.latitude, mob.longitude,
           ST_SetSRID(
             ST_MakePoint(mob.longitude, mob.latitude),
             4326
           ),
           mob.anchor_latitude, mob.anchor_longitude, $3,
           NULL, NULL, NULL, NULL, NULL, mob.environment_snapshot,
           mob.entity_id, $4, $1::uuid, canonical.state_revision,
           $5::bigint, false
    FROM jsonb_to_recordset($6::jsonb) AS mob(
      entity_id uuid, archetype text, encounter_id uuid, pack_id uuid,
      spawn_cell_id text, latitude double precision,
      longitude double precision, anchor_latitude double precision,
      anchor_longitude double precision, environment_snapshot jsonb
    )
    JOIN population_entity_state_v2 AS canonical
      ON canonical.entity_id=mob.entity_id
     AND canonical.state='ready'`,
  upsertReceipt: `
    INSERT INTO population_generation_mob_rollouts_v2 (
      generation_id, mob_kind, rollout_revision, source, status,
      target_group_count, target_body_count,
      inserted_group_count, inserted_body_count,
      shortfall_group_count, attempt_count, next_retry_at,
      last_error, attempted_at, completed_at
    ) VALUES (
      $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
    )
    ON CONFLICT (generation_id, mob_kind, rollout_revision)
    DO UPDATE SET
      source=EXCLUDED.source,
      status=EXCLUDED.status,
      target_group_count=EXCLUDED.target_group_count,
      target_body_count=EXCLUDED.target_body_count,
      inserted_group_count=EXCLUDED.inserted_group_count,
      inserted_body_count=EXCLUDED.inserted_body_count,
      shortfall_group_count=EXCLUDED.shortfall_group_count,
      attempt_count=EXCLUDED.attempt_count,
      next_retry_at=EXCLUDED.next_retry_at,
      last_error=EXCLUDED.last_error,
      attempted_at=EXCLUDED.attempted_at,
      completed_at=EXCLUDED.completed_at,
      updated_at=clock_timestamp()
    RETURNING generation_id, mob_kind, rollout_revision, source, status,
              target_group_count, target_body_count,
              inserted_group_count, inserted_body_count,
              shortfall_group_count, attempt_count, next_retry_at,
              last_error, attempted_at, completed_at, created_at, updated_at`,
  loadReceipt: `
    SELECT generation_id, mob_kind, rollout_revision, source, status,
           target_group_count, target_body_count,
           inserted_group_count, inserted_body_count,
           shortfall_group_count, attempt_count, next_retry_at,
           last_error, attempted_at, completed_at, created_at, updated_at
    FROM population_generation_mob_rollouts_v2
    WHERE generation_id=$1::uuid
      AND mob_kind=$2
      AND rollout_revision=$3`
});

export class PopulationV2RegisteredMobRolloutAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PopulationV2RegisteredMobRolloutAuthorityError";
  }
}

export class PostgresPopulationV2RegisteredMobRolloutStore {
  private readonly registry: PopulationV2MobRegistry;
  private readonly planner: typeof planPopulationV2RegisteredMobOverlay;
  private readonly maximumAttempts: number;
  private readonly initialRetryDelayMs: number;
  private readonly maximumRetryDelayMs: number;

  constructor(
    private readonly pool: pg.Pool,
    options: PopulationV2RegisteredMobRolloutStoreOptions = {}
  ) {
    this.registry = options.registry ?? populationV2MobRegistry;
    this.planner = options.planner ?? planPopulationV2RegisteredMobOverlay;
    this.maximumAttempts = options.maximumAttempts ?? 4;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 5_000;
    this.maximumRetryDelayMs = options.maximumRetryDelayMs ?? 5 * 60_000;
    assertPositiveInteger(this.maximumAttempts, "maximum rollout attempts");
    assertPositiveInteger(
      this.initialRetryDelayMs,
      "initial rollout retry delay"
    );
    assertPositiveInteger(
      this.maximumRetryDelayMs,
      "maximum rollout retry delay"
    );
    if (this.maximumRetryDelayMs < this.initialRetryDelayMs) {
      throw new Error(
        "maximum rollout retry delay cannot be shorter than the initial delay"
      );
    }
  }

  async loadReceipt(input: Readonly<{
    generationId: string;
    mobKind: string;
    placementRevision: string;
  }>): Promise<PopulationV2RegisteredMobRolloutReceipt | null> {
    assertReceiptIdentity(input);
    const result = await this.pool.query<ReceiptRow>(
      POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.loadReceipt,
      [input.generationId, input.mobKind, input.placementRevision]
    );
    return result.rows[0] === undefined
      ? null
      : receiptFromRow(result.rows[0]);
  }

  async execute(
    input: PopulationV2RegisteredMobRolloutRequest
  ): Promise<PopulationV2RegisteredMobRolloutOutcome> {
    assertReceiptIdentity(input);
    const definition = this.registry.requireDefinition(input.mobKind);
    const kindDefinition = this.registry.populationKinds.requireDefinition(
      input.mobKind
    );
    assertRolloutRequestMatchesDefinition(input, definition);
    const mode = input.mode ?? "existing_generation_top_up";
    assertDefinitionSupportsMode(definition, mode);
    const source = sourceForMode(mode);
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(
        POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.advisoryLock,
        [rolloutLockKey(input)]
      );
      const authorityResult = await client.query<AuthorityRow>(
        POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.authority,
        [input.generationId]
      );
      const authority = authorityResult.rows[0];
      if (authority === undefined) {
        throw new PopulationV2RegisteredMobRolloutAuthorityError(
          "registered-mob rollout requires the current selected-plan "
          + "active unexpired generation"
        );
      }
      const databaseNow = asDate(
        authority.database_now,
        "registered-mob rollout database timestamp"
      );
      const receiptResult = await client.query<ReceiptRow>(
        POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.receiptForUpdate,
        [input.generationId, input.mobKind, input.placementRevision]
      );
      const existing = receiptResult.rows[0] === undefined
        ? null
        : receiptFromRow(receiptResult.rows[0]);
      if (
        existing !== null
        && TERMINAL_RECEIPT_STATUSES.has(existing.status)
      ) {
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          disposition: "already_terminal",
          receipt: existing,
          insertedEntityIds: []
        };
      }
      if (
        existing?.status === "retryable_failure"
        && existing.nextRetryAt !== null
        && existing.nextRetryAt.getTime() > databaseNow.getTime()
      ) {
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          disposition: "retry_not_due",
          receipt: existing,
          insertedEntityIds: []
        };
      }
      if (
        existing?.status === "retryable_failure"
        && existing.attemptCount >= this.maximumAttempts
      ) {
        const exhausted = await upsertReceipt(client, input, {
          source,
          status: "terminal_diagnostic",
          targetGroupCount: existing.targetGroupCount,
          targetBodyCount: existing.targetBodyCount,
          insertedGroupCount: existing.insertedGroupCount,
          insertedBodyCount: existing.insertedBodyCount,
          shortfallGroupCount: existing.shortfallGroupCount,
          attemptCount: existing.attemptCount,
          nextRetryAt: null,
          lastError: "registered-mob rollout retry attempts exhausted",
          attemptedAt: databaseNow,
          completedAt: databaseNow
        }, kindDefinition);
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          disposition: "retry_exhausted",
          receipt: exhausted,
          insertedEntityIds: []
        };
      }
      const attemptCount = (existing?.attemptCount ?? 0) + 1;
      const { occupiedSlots, spacingOccupants } =
        await loadPopulationV2OccupiedSlots(client, {
          generationId: input.generationId,
          planId: authority.plan_id,
          generationNumber: Number(authority.generation_number)
        });
      const ownedCandidateSites =
        authority.habitat_snapshot.candidateSites?.filter((site) =>
          populationZoneV2IdForPoint(site.position) === authority.zone_id
        );
      const rolloutHabitat = ownedCandidateSites === undefined
        ? authority.habitat_snapshot
        : {
            ...authority.habitat_snapshot,
            candidateSites: ownedCandidateSites
          };
      await client.query("SAVEPOINT population_registered_mob_rollout");
      let planned: PopulationV2RegisteredMobOverlayResult | null = null;
      try {
        planned = await this.planner({
          generationId: input.generationId,
          habitat: rolloutHabitat,
          occupiedSlots,
          spacingOccupants,
          mode,
          mobKinds: [input.mobKind],
          registry: this.registry
        });
        validateTargetOverlayResult({
          result: planned,
          definition,
          mode,
          placementRevision: input.placementRevision
        });
        if (planned.status === "terminal_partial_group") {
          const terminal = await upsertReceipt(client, input, {
            source,
            status: "terminal_diagnostic",
            ...countsFromOverlay(planned),
            insertedGroupCount: 0,
            insertedBodyCount: 0,
            attemptCount,
            nextRetryAt: null,
            lastError: truncateReceiptError(
              "partial persisted registered-mob group: "
              + JSON.stringify(planned.terminalPartialGroups)
            ),
            attemptedAt: databaseNow,
            completedAt: databaseNow
          }, kindDefinition);
          await client.query(
            "RELEASE SAVEPOINT population_registered_mob_rollout"
          );
          await client.query("COMMIT");
          transactionOpen = false;
          return {
            disposition: "terminal_diagnostic",
            receipt: terminal,
            insertedEntityIds: []
          };
        }
        if (planned.slots.length > 0) {
          await insertOverlay(client, {
            authority,
            generationId: input.generationId,
            placementRevision: input.placementRevision,
            slots: planned.slots
          });
        }
        const receipt = await upsertReceipt(client, input, {
          source,
          status: planned.status,
          ...countsFromOverlay(planned),
          insertedGroupCount: planned.inserted.groups,
          insertedBodyCount: planned.inserted.bodies,
          attemptCount,
          nextRetryAt: null,
          lastError: null,
          attemptedAt: databaseNow,
          completedAt: databaseNow
        }, kindDefinition);
        await client.query(
          "RELEASE SAVEPOINT population_registered_mob_rollout"
        );
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          disposition: "applied",
          receipt,
          insertedEntityIds: planned.slots.map((slot) => slot.entityId)
        };
      } catch (error) {
        await client.query(
          "ROLLBACK TO SAVEPOINT population_registered_mob_rollout"
        );
        const counts = planned === null
          ? countsFromExisting(existing)
          : countsFromOverlay(planned);
        const transient = isTransientRolloutError(error);
        const exhausted = transient && attemptCount >= this.maximumAttempts;
        const status: PopulationV2RegisteredMobRolloutReceiptStatus =
          transient && !exhausted
            ? "retryable_failure"
            : "terminal_diagnostic";
        const failure = await upsertReceipt(client, input, {
          source,
          status,
          ...counts,
          insertedGroupCount: 0,
          insertedBodyCount: 0,
          attemptCount,
          nextRetryAt: status === "retryable_failure"
            ? new Date(
                databaseNow.getTime() + this.retryDelayMs(attemptCount)
              )
            : null,
          lastError: truncateReceiptError(errorMessage(error)),
          attemptedAt: databaseNow,
          completedAt: status === "terminal_diagnostic"
            ? databaseNow
            : null
        }, kindDefinition);
        await client.query(
          "RELEASE SAVEPOINT population_registered_mob_rollout"
        );
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          disposition: status === "retryable_failure"
            ? "retry_scheduled"
            : exhausted
              ? "retry_exhausted"
              : "terminal_diagnostic",
          receipt: failure,
          insertedEntityIds: []
        };
      }
    } catch (error) {
      if (transactionOpen) await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private retryDelayMs(attemptCount: number): number {
    return Math.min(
      this.maximumRetryDelayMs,
      this.initialRetryDelayMs * 2 ** Math.max(0, attemptCount - 1)
    );
  }
}

export class PopulationV2PostgresMobRolloutExecutor
implements PopulationV2MobRolloutExecutor {
  constructor(
    private readonly store: Pick<
      PostgresPopulationV2RegisteredMobRolloutStore,
      "execute"
    >
  ) {}

  async execute(
    request: PopulationV2QueuedMobRolloutRequest
  ): Promise<PopulationV2MobRolloutExecution> {
    const outcome = await this.store.execute({
      generationId: request.generationId,
      mobKind: request.mobKind,
      placementRevision: request.rolloutRevision,
      mode: "existing_generation_top_up"
    });
    const changed = outcome.insertedEntityIds.length > 0;
    const receipt = outcome.receipt;
    return {
      status: receipt.status,
      insertedGroupCount: changed ? receipt.insertedGroupCount : 0,
      insertedBodyCount: changed ? receipt.insertedBodyCount : 0,
      shortfallGroupCount: receipt.shortfallGroupCount,
      attemptCount: receipt.attemptCount,
      ...(receipt.nextRetryAt === null
        ? {}
        : {
            retryAfterMs: Math.max(
              0,
              receipt.nextRetryAt.getTime() - Date.now()
            )
          }),
      changed
    };
  }
}

async function insertOverlay(
  client: pg.PoolClient,
  input: Readonly<{
    authority: AuthorityRow;
    generationId: string;
    placementRevision: string;
    slots: readonly PopulationV2RegisteredMobOverlaySlot[];
  }>
): Promise<void> {
  const cap = await client.query(
    POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.raiseGenerationCap,
    [input.generationId, input.slots.length]
  );
  if (cap.rowCount !== 1) {
    throw new PopulationV2RegisteredMobRolloutAuthorityError(
      "registered-mob generation authority changed before insertion"
    );
  }
  const rows = input.slots.map(slotForDatabase);
  const insertedSlots = await client.query(
    POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.insertSlots,
    [input.authority.plan_id, input.generationId, JSON.stringify(rows)]
  );
  if (insertedSlots.rowCount !== input.slots.length) {
    throw new Error("registered-mob rollout did not insert every target slot");
  }
  const insertedStates = await client.query(
    POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.insertStates,
    [input.generationId, input.slots.map((slot) => slot.entityId)]
  );
  if (insertedStates.rowCount !== input.slots.length) {
    throw new Error("registered-mob rollout did not initialize every state");
  }
  const projectionRows = input.slots.map((slot) => {
    const cell = spawnCellForPoint(
      slot.position,
      input.authority.region_code
    );
    return {
      ...slotForDatabase(slot),
      spawn_cell_id: cell.id,
      spawn_cell_region_code: cell.regionCode,
      spawn_cell_x: cell.cellX,
      spawn_cell_y: cell.cellY,
      spawn_cell_center_lat: cell.center.lat,
      spawn_cell_center_lon: cell.center.lon
    };
  });
  const cells = new Map<string, (typeof projectionRows)[number]>();
  for (const row of projectionRows) cells.set(row.spawn_cell_id, row);
  await client.query(
    POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.insertSpawnCells,
    [JSON.stringify([...cells.values()])]
  );
  const insertedProjections = await client.query(
    POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.insertMobProjections,
    [
      input.authority.plan_id,
      input.authority.region_code,
      input.placementRevision,
      input.authority.zone_id,
      Number(input.authority.cutover_revision),
      JSON.stringify(projectionRows)
    ]
  );
  if (insertedProjections.rowCount !== input.slots.length) {
    throw new Error(
      "registered-mob rollout did not insert every mob projection"
    );
  }
}

async function upsertReceipt(
  client: pg.PoolClient,
  identity: Readonly<{
    generationId: string;
    mobKind: string;
    placementRevision: string;
  }>,
  write: ReceiptWrite,
  kindDefinition: PopulationV2KindDefinition
): Promise<PopulationV2RegisteredMobRolloutReceipt> {
  const result = await client.query<ReceiptRow>(
    POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.upsertReceipt,
    [
      identity.generationId,
      identity.mobKind,
      identity.placementRevision,
      write.source,
      write.status,
      write.targetGroupCount,
      write.targetBodyCount,
      write.insertedGroupCount,
      write.insertedBodyCount,
      write.shortfallGroupCount,
      write.attemptCount,
      write.nextRetryAt,
      write.lastError,
      write.attemptedAt,
      write.completedAt
    ]
  );
  if (result.rows[0] === undefined) {
    throw new Error("registered-mob rollout receipt was not persisted");
  }
  if (write.status === "completed" || write.status === "completed_with_shortfall") {
    await client.query(
      `INSERT INTO population_generation_kind_manifest_v2 (
         generation_id, kind_key, placement_revision, lifecycle_revision,
         source, group_atomic, recorded_at
       ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (
         generation_id, kind_key, placement_revision, lifecycle_revision
       ) DO NOTHING`,
      [
        identity.generationId,
        kindDefinition.kindKey,
        kindDefinition.placementRevision,
        kindDefinition.lifecycleRevision,
        write.source,
        kindDefinition.groupPolicy.atomic,
        write.completedAt
      ]
    );
  }
  return receiptFromRow(result.rows[0]);
}

function validateTargetOverlayResult(input: Readonly<{
  result: PopulationV2RegisteredMobOverlayResult;
  definition: PopulationV2MobDefinition;
  mode: PopulationV2RegisteredMobOverlayMode;
  placementRevision: string;
}>): void {
  const { result, definition } = input;
  if (
    result.mode !== input.mode
    || result.mobs.length !== 1
    || result.mobs[0]?.mobKind !== definition.mobKind
    || result.mobs[0]?.placementRevision !== input.placementRevision
  ) {
    throw new Error(
      "registered-mob overlay returned a non-target mob or revision"
    );
  }
  for (const counts of [
    result.target,
    result.current,
    result.inserted,
    result.shortfall
  ]) {
    if (
      !Number.isSafeInteger(counts.groups)
      || counts.groups < 0
      || !Number.isSafeInteger(counts.bodies)
      || counts.bodies < 0
    ) {
      throw new Error("registered-mob overlay returned invalid counts");
    }
  }
  if (
    result.inserted.bodies !== result.slots.length
    || result.inserted.groups
      !== new Set(result.slots.map((slot) => slot.candidateId)).size
    || (
      result.status === "terminal_partial_group"
      && (
        result.slots.length > 0
        || result.inserted.groups > 0
        || result.inserted.bodies > 0
      )
    )
    || (
      result.status !== "terminal_partial_group"
      && result.terminalPartialGroups.length > 0
    )
  ) {
    throw new Error(
      "registered-mob overlay returned inconsistent insertions"
    );
  }
  if (
    (result.status === "completed" && result.shortfall.groups !== 0)
    || (
      result.status === "completed_with_shortfall"
      && result.shortfall.groups === 0
    )
    || (
      result.status === "terminal_partial_group"
      && result.terminalPartialGroups.length === 0
    )
  ) {
    throw new Error(
      "registered-mob overlay returned inconsistent terminal status"
    );
  }
  const mobResult = result.mobs[0]!;
  if (
    mobResult.status !== result.status
    || mobResult.rolloutPolicy !== definition.defaultRolloutPolicy
    || JSON.stringify(mobResult.target) !== JSON.stringify(result.target)
    || JSON.stringify(mobResult.current) !== JSON.stringify(result.current)
    || JSON.stringify(mobResult.inserted) !== JSON.stringify(result.inserted)
    || JSON.stringify(mobResult.shortfall) !== JSON.stringify(result.shortfall)
  ) {
    throw new Error(
      "registered-mob overlay aggregate does not match its target mob"
    );
  }
  assertCompleteTargetGroups(
    result.slots,
    definition,
    input.placementRevision
  );
}

function assertCompleteTargetGroups(
  slots: readonly PopulationV2RegisteredMobOverlaySlot[],
  definition: PopulationV2MobDefinition,
  placementRevision: string
): void {
  const slotIds = new Set<string>();
  const entityIds = new Set<string>();
  const groups = new Map<string, PopulationV2RegisteredMobOverlaySlot[]>();
  for (const slot of slots) {
    if (
      slot.mobKind !== definition.mobKind
      || slot.entityKind !== definition.mobKind
      || slot.archetype !== definition.combatArchetype
      || slot.placementRevision !== placementRevision
      || slot.spacingClass !== definition.spacingClass
      || slot.suppressionClass !== definition.suppressionClass
      || slot.sourceAnchorSiteId.length === 0
      || slot.environmentSnapshot.sourceAnchorSiteId
        !== slot.sourceAnchorSiteId
      || slot.encounterId === null
      || slotIds.has(slot.slotId)
      || entityIds.has(slot.entityId)
    ) {
      throw new Error(
        "registered-mob overlay returned invalid target slot authority"
      );
    }
    slotIds.add(slot.slotId);
    entityIds.add(slot.entityId);
    const group = groups.get(slot.candidateId) ?? [];
    group.push(slot);
    groups.set(slot.candidateId, group);
  }
  for (const group of groups.values()) {
    if (definition.spawnModel === "single") {
      if (
        group.length !== 1
        || group[0]!.packId !== null
        || group[0]!.packMemberIndex !== null
      ) {
        throw new Error(
          "registered single-mob overlay group is incomplete"
        );
      }
      continue;
    }
    const indexes = group.map((slot) => slot.packMemberIndex)
      .sort((left, right) => (left ?? -1) - (right ?? -1));
    const packIds = new Set(group.map((slot) => slot.packId));
    const encounterIds = new Set(group.map((slot) => slot.encounterId));
    const sourceAnchorSiteIds = new Set(group.map((slot) =>
      slot.sourceAnchorSiteId
    ));
    const anchorKeys = new Set(group.map((slot) =>
      `${slot.anchor.lat}/${slot.anchor.lon}`
    ));
    if (
      definition.packFormation === undefined
      || !definition.packFormation.allowedMemberCounts.includes(group.length)
      || indexes.some((index, position) => index !== position)
      || packIds.size !== 1
      || group[0]!.packId === null
      || encounterIds.size !== 1
      || sourceAnchorSiteIds.size !== 1
      || anchorKeys.size !== 1
    ) {
      throw new Error("registered pack-mob overlay group is incomplete");
    }
  }
}

/**
 * The slots a registered overlay must space itself against: this generation's own slots and the
 * plan's permanent stones (occupied), plus the stones and current-generation slots of neighbouring
 * zones within the maximum spacing distance (spacing-only). Shared by existing-generation top-up and
 * natural generation, so both place against exactly the same classes.
 */
export async function loadPopulationV2OccupiedSlots(
  client: Pick<pg.PoolClient, "query">,
  input: Readonly<{ generationId: string; planId: string; generationNumber: number }>
): Promise<Readonly<{
  occupiedSlots: PopulationV2RegisteredMobOccupiedSlot[];
  spacingOccupants: PopulationV2RegisteredMobOccupiedSlot[];
}>> {
  const occupiedResult = await client.query<OccupiedSlotRow>(
    POPULATION_V2_REGISTERED_MOB_ROLLOUT_SQL.occupiedSlots,
    [input.generationId, input.planId, POPULATION_V2_MAXIMUM_SPACING_DISTANCE_M]
  );
  const occupiedSlots: PopulationV2RegisteredMobOccupiedSlot[] = [];
  const spacingOccupants: PopulationV2RegisteredMobOccupiedSlot[] = [];
  for (const row of occupiedResult.rows) {
    const ownerGenerationId = row.owner_generation_id ?? input.generationId;
    const occupiedSlot = occupiedSlotFromRow(row, {
      generationId: ownerGenerationId,
      generationNumber: Number(row.owner_generation_number ?? input.generationNumber)
    });
    (
      row.owner_plan_id === input.planId && ownerGenerationId === input.generationId
        ? occupiedSlots
        : spacingOccupants
    ).push(occupiedSlot);
  }
  return { occupiedSlots, spacingOccupants };
}

function occupiedSlotFromRow(
  row: OccupiedSlotRow,
  generation: Readonly<{
    generationId: string;
    generationNumber: number;
  }>
): PopulationV2RegisteredMobOccupiedSlot {
  const compatibleIdentity =
    knownBadDeploySapIdentity(row, generation);
  const placementRevision =
    compatibleIdentity?.placementRevision ?? row.placement_revision;
  const persistenceCorruption =
    mobProjectionPersistenceCorruption(row);
  return {
    slotId: row.slot_id,
    entityId: row.entity_id,
    candidateId: row.candidate_id,
    entityKind: row.entity_kind,
    archetype: row.archetype,
    encounterId: row.encounter_id,
    packId: row.pack_id,
    packMemberIndex: row.pack_member_index,
    position: {
      lat: Number(row.latitude),
      lon: Number(row.longitude)
    },
    anchor: {
      lat: Number(row.anchor_latitude),
      lon: Number(row.anchor_longitude)
    },
    environmentSnapshot: row.environment_snapshot,
    suppressionClass: row.suppression_class,
    ...(placementRevision === null
      ? {}
      : { placementRevision }),
    ...(persistenceCorruption === null
      ? {}
      : { persistenceCorruption }),
    ...(compatibleIdentity === null
      ? {}
      : {
          identityCompatibility: "exact_bad_deploy_sap" as const,
          identityAuthorityCandidateId:
            compatibleIdentity.authorityCandidateId
        })
  };
}

function knownBadDeploySapIdentity(
  row: OccupiedSlotRow,
  generation: Readonly<{
    generationId: string;
    generationNumber: number;
  }>
): Readonly<{
  placementRevision: string;
  authorityCandidateId: string;
}> | null {
  if (
    row.entity_kind !== "sap_crawler"
    || row.pack_member_index === null
    || row.pack_id === null
    || row.encounter_id === null
    || !Number.isSafeInteger(generation.generationNumber)
    || generation.generationNumber <= 0
  ) return null;
  const separator = row.candidate_id.lastIndexOf("/");
  if (separator <= 0 || separator === row.candidate_id.length - 1) {
    return null;
  }
  const templateCandidateId = row.candidate_id.slice(0, separator);
  const expectedCandidateId = `${templateCandidateId}/${hashPartsHex(
    BAD_DEPLOY_SAP_CANDIDATE_VERSION,
    BAD_DEPLOY_SAP_PLACEMENT_REVISION,
    generation.generationId,
    generation.generationNumber,
    templateCandidateId
  ).slice(0, 16)}`;
  if (row.candidate_id !== expectedCandidateId) return null;
  const authority = {
    generationCandidateId: expectedCandidateId,
    generationId: generation.generationId,
    generationNumber: generation.generationNumber,
    templateCandidateId
  };
  const expectedEncounterId = deterministicUuidV8(
    BAD_DEPLOY_SAP_ENCOUNTER_VERSION,
    {
      ...authority,
      placementRevision: BAD_DEPLOY_SAP_PLACEMENT_REVISION
    }
  );
  const expectedPackId = deterministicUuidV8(
    BAD_DEPLOY_SAP_PACK_VERSION,
    {
      ...authority,
      placementRevision: BAD_DEPLOY_SAP_PLACEMENT_REVISION
    }
  );
  const expectedSlotId = deterministicUuidV8(
    BAD_DEPLOY_SAP_SLOT_VERSION,
    {
      ...authority,
      memberIndex: row.pack_member_index,
      placementRevision: BAD_DEPLOY_SAP_PLACEMENT_REVISION
    }
  );
  const expectedEntityId = deterministicUuidV8(
    BAD_DEPLOY_SAP_ENTITY_VERSION,
    {
      ...authority,
      memberIndex: row.pack_member_index,
      placementRevision: BAD_DEPLOY_SAP_PLACEMENT_REVISION,
      slotId: expectedSlotId
    }
  );
  return row.encounter_id === expectedEncounterId
      && row.pack_id === expectedPackId
      && row.slot_id === expectedSlotId
      && row.entity_id === expectedEntityId
    ? {
        placementRevision: BAD_DEPLOY_SAP_PLACEMENT_REVISION,
        authorityCandidateId: templateCandidateId
      }
    : null;
}

function mobProjectionPersistenceCorruption(
  row: OccupiedSlotRow
): string | null {
  if (
    row.canonical_state !== "ready"
    && row.canonical_state !== "dead"
  ) {
    return row.canonical_state == null
      ? "missing canonical mob state"
      : `invalid canonical mob state ${row.canonical_state}`;
  }
  if (row.canonical_state_revision == null) {
    return "missing canonical mob state revision";
  }
  if (row.projection_entity_id == null) {
    return "missing generated mob projection";
  }
  if (
    row.owner_zone_id == null
    || row.owner_cutover_revision == null
  ) {
    return "missing selected-plan projection authority";
  }
  if (
    row.projection_entity_id !== row.entity_id
    || row.projection_mob_archetype !== row.archetype
    || row.projection_encounter_id !== row.encounter_id
    || row.projection_pack_id !== row.pack_id
    || row.projection_zone_id !== row.owner_zone_id
    || row.projection_plan_id !== row.owner_plan_id
    || Number(row.projection_state_revision)
      !== Number(row.canonical_state_revision)
    || Number(row.projection_cutover_revision)
      !== Number(row.owner_cutover_revision)
    || row.projection_cutover_suppressed !== false
  ) {
    return "generated mob projection authority mismatch";
  }
  if (row.canonical_state === "ready") {
    return row.canonical_killed_or_harvested_at == null
      && row.canonical_state_actor_player_id == null
      && row.projection_killed_at == null
      && row.projection_killed_by_player_id == null
      ? null
      : "ready mob projection carries death state";
  }
  return timestampsMatch(
    row.canonical_killed_or_harvested_at,
    row.projection_killed_at
  ) && row.canonical_state_actor_player_id
    === (row.projection_killed_by_player_id ?? null)
    ? null
    : "dead mob projection disagrees with canonical state";
}

function timestampsMatch(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined
): boolean {
  if (left == null || right == null) return false;
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime)
    && leftTime === rightTime;
}

function slotForDatabase(slot: PopulationV2RegisteredMobOverlaySlot) {
  return {
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
    suppression_class: slot.suppressionClass
  };
}

function countsFromOverlay(
  result: PopulationV2RegisteredMobOverlayResult
): OverlayCountsSnapshot {
  return {
    targetGroupCount: result.target.groups,
    targetBodyCount: result.target.bodies,
    shortfallGroupCount: result.shortfall.groups
  };
}

function countsFromExisting(
  receipt: PopulationV2RegisteredMobRolloutReceipt | null
): OverlayCountsSnapshot {
  return {
    targetGroupCount: receipt?.targetGroupCount ?? 0,
    targetBodyCount: receipt?.targetBodyCount ?? 0,
    shortfallGroupCount: receipt?.shortfallGroupCount ?? 0
  };
}

function receiptFromRow(
  row: ReceiptRow
): PopulationV2RegisteredMobRolloutReceipt {
  return {
    generationId: row.generation_id,
    mobKind: row.mob_kind,
    rolloutRevision: row.rollout_revision,
    source: row.source,
    status: row.status,
    targetGroupCount: Number(row.target_group_count),
    targetBodyCount: Number(row.target_body_count),
    insertedGroupCount: Number(row.inserted_group_count),
    insertedBodyCount: Number(row.inserted_body_count),
    shortfallGroupCount: Number(row.shortfall_group_count),
    attemptCount: Number(row.attempt_count),
    nextRetryAt: row.next_retry_at === null
      ? null
      : asDate(row.next_retry_at, "registered-mob next retry"),
    lastError: row.last_error,
    attemptedAt: asDate(
      row.attempted_at,
      "registered-mob attempted timestamp"
    ),
    completedAt: row.completed_at === null
      ? null
      : asDate(row.completed_at, "registered-mob completed timestamp"),
    createdAt: asDate(row.created_at, "registered-mob created timestamp"),
    updatedAt: asDate(row.updated_at, "registered-mob updated timestamp")
  };
}

function assertRolloutRequestMatchesDefinition(
  input: PopulationV2RegisteredMobRolloutRequest,
  definition: PopulationV2MobDefinition
): void {
  if (definition.placementRevision !== input.placementRevision) {
    throw new Error(
      `registered-mob rollout revision mismatch for ${input.mobKind}`
    );
  }
}

function assertDefinitionSupportsMode(
  definition: PopulationV2MobDefinition,
  mode: PopulationV2RegisteredMobOverlayMode
): void {
  if (
    definition.generationPlacement !== "registered_overlay"
    || (
      mode === "existing_generation_top_up"
      && !definition.existingGenerationRolloutEligible
    )
  ) {
    throw new Error(
      `Population V2 mob ${definition.mobKind} does not support ${mode}`
    );
  }
}

function sourceForMode(
  mode: PopulationV2RegisteredMobOverlayMode
): PopulationV2RegisteredMobRolloutSource {
  return mode === "next_generation" ? "generation" : "top_up";
}

function rolloutLockKey(input: Readonly<{
  generationId: string;
  mobKind: string;
  placementRevision: string;
}>): string {
  return [
    "population-v2-registered-mob-rollout-v1",
    input.generationId,
    input.mobKind,
    input.placementRevision
  ].join("/");
}

function assertReceiptIdentity(input: Readonly<{
  generationId: string;
  mobKind: string;
  placementRevision: string;
}>): void {
  if (
    input.generationId.length === 0
    || !/^[a-z][a-z0-9_]*$/u.test(input.mobKind)
    || input.placementRevision.trim().length === 0
  ) {
    throw new Error("registered-mob rollout identity is invalid");
  }
}

function isTransientRolloutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error && typeof error.code === "string"
    ? error.code
    : null;
  return code !== null
    && (
      code.startsWith("08")
      || RETRYABLE_POSTGRES_CODES.has(code)
    );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : `registered-mob rollout failed: ${String(error)}`;
}

function truncateReceiptError(message: string): string {
  return message.slice(0, 1_000);
}

function asDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} is invalid`);
  }
  return date;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

async function rollbackQuietly(client: pg.PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}
