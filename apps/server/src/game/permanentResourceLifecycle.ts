import {
  PERMANENT_MINE_BASE_YIELD_QUANTITY,
  STONE_MINE_YIELD_QUANTITY,
  type RepeatableResourceNode,
  type RepeatableResourceNodeType,
  type ResourceType,
  type ResourceVision
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppLogger } from "../logger.js";

export const PERMANENT_MINE_REGENERATION_MS =
  5 * 60 * 60_000 + 50 * 60_000;
export const STONE_MINE_REGENERATION_MS = PERMANENT_MINE_REGENERATION_MS;

export type PermanentResourceDefinition<NodeType extends string = string> =
  Readonly<{
    nodeType: NodeType;
    populationEntityKind: string;
    populationArchetype: string;
    yieldedItem: string;
    yieldQuantity: number;
    /** Persisted projection quantities retained from older definitions. */
    legacyYieldQuantities?: readonly number[];
    regenerationMs: number;
    timerProfessionId: string;
    timerVisibilityRank: number;
  }>;

export class PermanentResourceRegistry<
  Definition extends PermanentResourceDefinition =
    PermanentResourceDefinition
> {
  readonly definitions: readonly Definition[];
  private readonly byNodeType: ReadonlyMap<string, Definition>;

  constructor(definitions: readonly Definition[]) {
    validateDefinitions(definitions);
    this.definitions = Object.freeze([...definitions]);
    this.byNodeType = new Map(
      this.definitions.map((definition) => [
        definition.nodeType,
        definition
      ])
    );
  }

  definitionForNodeType(nodeType: string): Definition | undefined {
    return this.byNodeType.get(nodeType);
  }

  requireDefinition(nodeType: string): Definition {
    const definition = this.definitionForNodeType(nodeType);
    if (!definition) {
      throw new Error(`unsupported permanent resource ${nodeType}`);
    }
    return definition;
  }
}

export const STONE_MINE_DEFINITION = Object.freeze({
  nodeType: "stone_mine",
  populationEntityKind: "stone",
  populationArchetype: "stone_mine",
  yieldedItem: "stone",
  yieldQuantity: STONE_MINE_YIELD_QUANTITY,
  // Migrations 0628/0735/0819 retain stone projections at one. The current
  // application reward is three, but retained projection authority is immutable.
  legacyYieldQuantities: Object.freeze([PERMANENT_MINE_BASE_YIELD_QUANTITY]),
  regenerationMs: PERMANENT_MINE_REGENERATION_MS,
  timerProfessionId: "miner",
  timerVisibilityRank: 2
} as const satisfies PermanentResourceDefinition);

export const COAL_MINE_DEFINITION = Object.freeze({
  nodeType: "coal_mine",
  populationEntityKind: "coal",
  populationArchetype: "coal_mine",
  yieldedItem: "coal",
  yieldQuantity: PERMANENT_MINE_BASE_YIELD_QUANTITY,
  regenerationMs: PERMANENT_MINE_REGENERATION_MS,
  timerProfessionId: "miner",
  timerVisibilityRank: 2
} as const satisfies PermanentResourceDefinition);

export const IRON_MINE_DEFINITION = Object.freeze({
  nodeType: "iron_mine",
  populationEntityKind: "iron",
  populationArchetype: "iron_mine",
  yieldedItem: "iron",
  yieldQuantity: PERMANENT_MINE_BASE_YIELD_QUANTITY,
  regenerationMs: PERMANENT_MINE_REGENERATION_MS,
  timerProfessionId: "miner",
  timerVisibilityRank: 2
} as const satisfies PermanentResourceDefinition);

export const SULFUR_MINE_DEFINITION = Object.freeze({
  nodeType: "sulfur_mine",
  populationEntityKind: "sulfur",
  populationArchetype: "sulfur_mine",
  yieldedItem: "sulfur",
  yieldQuantity: PERMANENT_MINE_BASE_YIELD_QUANTITY,
  regenerationMs: PERMANENT_MINE_REGENERATION_MS,
  timerProfessionId: "miner",
  timerVisibilityRank: 2
} as const satisfies PermanentResourceDefinition);

export const PERMANENT_RESOURCE_REGISTRY =
  new PermanentResourceRegistry([
    STONE_MINE_DEFINITION,
    COAL_MINE_DEFINITION,
    IRON_MINE_DEFINITION,
    SULFUR_MINE_DEFINITION
  ]);

export function permanentResourceYield(
  nodeType: string,
  yieldedItem: string,
  yieldQuantity: number,
  registry: PermanentResourceRegistry = PERMANENT_RESOURCE_REGISTRY
): number {
  const definition = registry.requireDefinition(nodeType);
  if (
    yieldedItem !== definition.yieldedItem
    || !definitionYieldQuantities(definition).includes(yieldQuantity)
  ) {
    throw new Error(
      `${nodeType} projection does not match its permanent-resource definition`
    );
  }
  return definition.yieldQuantity;
}

export type PermanentResourceNodeRow = {
  id: string;
  node_type: RepeatableResourceNodeType;
  region_code: string;
  lat: number | string;
  lon: number | string;
  yield_item_id: ResourceType;
  yield_quantity: number | string;
  harvest_revision: number | string;
  ready_at: Date | string | null;
  public_state: "ready" | "depleted";
  bonus_extraction_available?: boolean;
  bonus_extraction_revision?: number | string | null;
  timer_visible?: boolean;
  canonical_state: "ready" | "harvested" | "dead" | null;
  canonical_actor_player_id: string | null;
  canonical_harvested_at: Date | string | null;
  population_v2_entity_id: string;
  physical_population_zone_v2_id: string;
  population_v2_state_revision: number | string;
  population_cutover_revision: number | string;
  population_v2_suppressed?: boolean;
  owner_player_id?: string | null;
  owner_username?: string | null;
  harvest_access_mode?: "private" | "public" | null;
  harvest_access_revision?: number | string;
  toll_gold?: number | string;
  can_manage?: boolean;
};

export type PermanentResourceCanonicalRow = {
  entity_id: string;
  state: "ready" | "harvested" | "dead";
  state_revision: number | string;
  state_actor_player_id: string | null;
  killed_or_harvested_at: Date | string | null;
  respawn_at: Date | string | null;
  database_now: Date | string;
  selected_plan_fenced: boolean;
  definition_fenced: boolean;
};

export type PermanentResourceAuthorityFailureReason =
  | "projection-suppressed"
  | "projection-canonical-entity-mismatch"
  | "projection-plan-cutover-mismatch"
  | "projection-definition-mismatch"
  | "canonical-lifecycle-invalid";

export type LockedPermanentResource = Readonly<{
  row: PermanentResourceNodeRow;
  canonical: PermanentResourceCanonicalRow | null;
  authorityFailureReason?: PermanentResourceAuthorityFailureReason;
  promoted: boolean;
  projectionRepaired: boolean;
}>;

type VisionAuditRow = {
  node_id: string;
  canonical_entity_id: string | null;
  physical_zone_id: string;
  selected_plan_id: string | null;
  population_cutover_revision: number | string;
  canonical_revision: number | string | null;
  projection_revision: number | string;
  harvest_revision: number | string;
  canonical_state: "ready" | "harvested" | "dead" | null;
  canonical_actor_player_id: string | null;
  canonical_harvested_at: Date | string | null;
  canonical_respawn_at: Date | string | null;
  regeneration_ms: number | string | null;
  projection_ready_at: Date | string | null;
  projection_last_harvested_by: string | null;
  projection_suppressed: boolean;
  selected_plan_fenced: boolean;
  definition_fenced: boolean;
  database_now: Date | string;
};

export type PermanentResourceConvergenceDiagnostics = Readonly<{
  examined: number;
  due: number;
  promoted: number;
  casRacesLost: number;
  projectionsRepaired: number;
  unsafeRejected: number;
}>;

const MAX_DUE_NODES_PER_CONVERGENCE = 128;

export class PermanentResourceLifecycleService {
  private readonly loggedUnsafeSignatures = new Set<string>();

  constructor(
    private readonly pool: pg.Pool,
    readonly registry: PermanentResourceRegistry =
      PERMANENT_RESOURCE_REGISTRY,
    private readonly logger?: AppLogger
  ) {}

  async listInVision(
    vision: ResourceVision | null,
    playerId?: string
  ): Promise<RepeatableResourceNode[]> {
    if (!vision) return [];
    await this.convergeInVision(vision);
    const result = await this.pool.query<PermanentResourceNodeRow>(
      publicNodesSql(`
        ST_DWithin(
          projection.geom::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3
        )
      `, 4),
      [
        vision.center.lon,
        vision.center.lat,
        vision.radiusM,
        playerId ?? null
      ]
    );
    return result.rows.map((row) => this.publicNode(row));
  }

  async nodeForPlayer(
    nodeId: string,
    playerId?: string,
    queryable: Pick<pg.Pool | pg.PoolClient, "query"> = this.pool
  ): Promise<RepeatableResourceNode | null> {
    const result = await queryable.query<PermanentResourceNodeRow>(
      publicNodesSql("projection.id::text = $1", 2),
      [nodeId, playerId ?? null]
    );
    const row = result.rows[0];
    return row ? this.publicNode(row) : null;
  }

  async convergeForDiagnostics(
    limit = MAX_DUE_NODES_PER_CONVERGENCE
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const candidates = await client.query<{ node_id: string }>(
        `SELECT projection.id::text AS node_id
         FROM repeatable_resource_nodes AS projection
         JOIN population_permanent_resource_authority_v2 AS authority
           ON authority.entity_id=projection.population_v2_entity_id
          AND authority.owner_zone_id=
              projection.physical_population_zone_v2_id
          AND authority.node_type=projection.node_type
          AND authority.yield_item_id=projection.yield_item_id
          AND authority.yield_quantity=projection.yield_quantity
          AND authority.regeneration_interval=
              projection.regeneration_interval
         JOIN population_zone_cutovers_v2 AS cutover
           ON cutover.zone_id=authority.owner_zone_id
          AND cutover.status='stable'
          AND cutover.serving_version='v2'
          AND cutover.cutover_revision=
              projection.population_cutover_revision
         JOIN population_plan_permanent_resources_v2 AS membership
           ON membership.plan_id=cutover.selected_plan_id
          AND membership.entity_id=authority.entity_id
         WHERE projection.population_v2_entity_id IS NOT NULL
           AND NOT projection.population_v2_suppressed
         ORDER BY projection.updated_at, projection.id
         LIMIT $1`,
        [Math.max(1, Math.min(MAX_DUE_NODES_PER_CONVERGENCE, limit))]
      );
      const nodeIds = candidates.rows.map((row) => row.node_id);
      await lockCanonicalRowsForNodes(client, nodeIds);
      const repaired = await repairProjection(client, nodeIds);
      const promoted = await promoteDueRows(client, nodeIds);
      await client.query("COMMIT");
      if (promoted > 0 || repaired > 0) {
        this.logger?.info({
          examined: nodeIds.length,
          promoted,
          projectionsRepaired: repaired,
          outcome: "developer-diagnostics-converged"
        }, "permanent resource lifecycle convergence");
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async lockAndConvergeNode(
    queryable: Pick<pg.PoolClient, "query">,
    nodeId: string
  ): Promise<LockedPermanentResource | null> {
    const identity = await queryable.query<PermanentResourceNodeRow>(
      `${projectionSelect("CASE WHEN canonical.state='ready' THEN 'ready' ELSE 'depleted' END")}
       FROM repeatable_resource_nodes AS projection
       LEFT JOIN population_entity_state_v2 AS canonical
         ON canonical.entity_id=projection.population_v2_entity_id
       WHERE projection.id::text=$1
         AND projection.population_v2_entity_id IS NOT NULL`,
      [nodeId]
    );
    const initial = identity.rows[0];
    if (!initial) return null;
    const definition = this.registry.requireDefinition(initial.node_type);

    const canonicalResult =
      await queryable.query<PermanentResourceCanonicalRow>(
        `SELECT canonical.entity_id::text, canonical.state,
                canonical.state_revision, canonical.state_actor_player_id,
                canonical.killed_or_harvested_at, canonical.respawn_at,
                clock_timestamp() AS database_now,
                EXISTS (
                  SELECT 1
                  FROM population_permanent_resource_authority_v2 AS authority
                  JOIN population_zone_cutovers_v2 AS cutover
                    ON cutover.zone_id=authority.owner_zone_id
                   AND cutover.status='stable'
                   AND cutover.serving_version='v2'
                   AND cutover.cutover_revision=$3::bigint
                  JOIN population_plan_permanent_resources_v2 AS membership
                    ON membership.plan_id=cutover.selected_plan_id
                   AND membership.entity_id=authority.entity_id
                  WHERE authority.entity_id=$1::uuid
                    AND authority.owner_zone_id=$2
                ) AS selected_plan_fenced,
                EXISTS (
                  SELECT 1
                  FROM population_permanent_resource_authority_v2 AS authority
                  WHERE authority.entity_id=$1::uuid
                    AND authority.owner_zone_id=$2
                    AND authority.entity_kind=$4
                    AND authority.node_type=$5
                    AND authority.yield_item_id=$6
                    AND authority.yield_quantity=ANY($7::integer[])
                    AND authority.regeneration_interval=$8
                ) AS definition_fenced
         FROM population_entity_state_v2 AS canonical
         WHERE canonical.entity_id=$1::uuid
         FOR UPDATE`,
        [
          initial.population_v2_entity_id,
          initial.physical_population_zone_v2_id,
          Number(initial.population_cutover_revision),
          definition.populationEntityKind,
          definition.populationArchetype,
          definition.yieldedItem,
          definitionYieldQuantities(definition),
          `${definition.regenerationMs} milliseconds`
        ]
      );
    let canonical = canonicalResult.rows[0] ?? null;

    const lockedProjection = await queryable.query<PermanentResourceNodeRow>(
      `${projectionSelect("CASE WHEN canonical.state='ready' THEN 'ready' ELSE 'depleted' END")}
       FROM repeatable_resource_nodes AS projection
       LEFT JOIN population_entity_state_v2 AS canonical
         ON canonical.entity_id=projection.population_v2_entity_id
       WHERE projection.id::text=$1
         AND projection.population_v2_entity_id=$2::uuid
       FOR UPDATE OF projection`,
      [nodeId, initial.population_v2_entity_id]
    );
    let row = lockedProjection.rows[0];
    if (!row) return null;

    const authorityFailureReason = authorityFailure(
      row,
      canonical,
      definition
    );
    if (authorityFailureReason || !canonical) {
      this.logUnsafe(row, canonical, authorityFailureReason ??
        "projection-canonical-entity-mismatch");
      return {
        row,
        canonical,
        ...(authorityFailureReason ? { authorityFailureReason } : {}),
        promoted: false,
        projectionRepaired: false
      };
    }

    let promoted = false;
    // A harvested life is depleted on [harvestedAt, respawnAt); the
    // database deadline itself is eligible for the next ready life.
    if (
      canonical.state === "harvested"
      && canonical.respawn_at !== null
      && dateMs(canonical.respawn_at) <= dateMs(canonical.database_now)
    ) {
      const promotion = await queryable.query<{ state_revision: number | string }>(
        duePromotionSql("canonical.entity_id=$1::uuid", "$2::bigint"),
        [
          canonical.entity_id,
          Number(canonical.state_revision)
        ]
      );
      promoted = promotion.rowCount === 1;
      const winner = await queryable.query<PermanentResourceCanonicalRow>(
        `SELECT canonical.entity_id::text, canonical.state,
                canonical.state_revision, canonical.state_actor_player_id,
                canonical.killed_or_harvested_at, canonical.respawn_at,
                clock_timestamp() AS database_now,
                true AS selected_plan_fenced,
                true AS definition_fenced
         FROM population_entity_state_v2 AS canonical
         WHERE canonical.entity_id=$1::uuid`,
        [canonical.entity_id]
      );
      canonical = winner.rows[0] ?? canonical;
    }

    const repaired = await repairProjection(
      queryable,
      [row.id]
    );
    const refreshed = await queryable.query<PermanentResourceNodeRow>(
      `${projectionSelect("CASE WHEN canonical.state='ready' THEN 'ready' ELSE 'depleted' END")}
       FROM repeatable_resource_nodes AS projection
       JOIN population_entity_state_v2 AS canonical
         ON canonical.entity_id=projection.population_v2_entity_id
       WHERE projection.id::text=$1`,
      [nodeId]
    );
    row = refreshed.rows[0] ?? row;
    this.logConvergence({
      examined: 1,
      due: promoted ? 1 : 0,
      promoted: promoted ? 1 : 0,
      casRacesLost: 0,
      projectionsRepaired: repaired,
      unsafeRejected: 0
    }, row, canonical, promoted ? "promoted-under-lock" :
      repaired > 0 ? "projection-repaired-under-lock" : "canonical");
    return {
      row,
      canonical,
      promoted,
      projectionRepaired: repaired > 0
    };
  }

  publicNode(row: PermanentResourceNodeRow): RepeatableResourceNode {
    const definition = this.registry.requireDefinition(row.node_type);
    permanentResourceYield(
      row.node_type,
      row.yield_item_id,
      Number(row.yield_quantity),
      this.registry
    );
    const lifecycleIssue = canonicalLifecycleIssue({
      state: row.canonical_state,
      actorPlayerId: row.canonical_actor_player_id,
      harvestedAt: row.canonical_harvested_at,
      respawnAt: row.ready_at,
      regenerationMs: definition.regenerationMs
    });
    if (lifecycleIssue) {
      this.logUnsafeOnce([
        row.id,
        Number(row.population_v2_state_revision),
        lifecycleIssue
      ].join(":"), {
        nodeId: row.id,
        canonicalEntityId: row.population_v2_entity_id,
        physicalZone: row.physical_population_zone_v2_id,
        cutoverRevision: Number(row.population_cutover_revision),
        canonicalState: row.canonical_state,
        canonicalActorPlayerId: row.canonical_actor_player_id,
        harvestedAt: row.canonical_harvested_at,
        deadline: row.ready_at,
        canonicalRevision: Number(row.population_v2_state_revision),
        outcome: "canonical-lifecycle-invalid",
        lifecycleIssue
      }, "impossible canonical permanent resource state");
    } else if (
      row.public_state === "depleted"
      && row.timer_visible === true
      && row.ready_at === null
    ) {
      this.logger?.warn({
        nodeId: row.id,
        canonicalEntityId: row.population_v2_entity_id,
        physicalZone: row.physical_population_zone_v2_id,
        canonicalRevision: Number(row.population_v2_state_revision),
        outcome: "missing-visible-timer"
      }, "permanent resource timer presentation invariant failed");
    }
    const publicState =
      row.public_state === "ready" && !lifecycleIssue
        ? "ready"
        : "depleted";
    return {
      id: row.id,
      nodeType: row.node_type,
      lat: Number(row.lat),
      lon: Number(row.lon),
      yieldItemId: row.yield_item_id,
      yieldQuantity: definition.yieldQuantity,
      state: publicState,
      authorityRevision:
        Number(row.population_v2_state_revision) * 2
        + (publicState === "ready" ? 1 : 0),
      readyAt:
        publicState === "depleted"
        && row.timer_visible === true
        && row.ready_at !== null
          ? dateIso(row.ready_at)
          : null,
      timerVisibility:
        row.timer_visible === true ? "visible" : "redacted",
      ownerPlayerId: row.owner_player_id ?? null,
      ownerUsername: row.owner_username ?? null,
      accessMode: row.harvest_access_mode ?? null,
      accessRevision: Number(row.harvest_access_revision ?? 0),
      tollGold: String(row.toll_gold ?? 0),
      canManage: row.can_manage ?? false,
      bonusExtractionAvailable: Boolean(row.bonus_extraction_available)
    };
  }

  private async convergeInVision(
    vision: ResourceVision
  ): Promise<PermanentResourceConvergenceDiagnostics> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const audit = await client.query<VisionAuditRow>(
        `SELECT projection.id::text AS node_id,
                canonical.entity_id::text AS canonical_entity_id,
                projection.physical_population_zone_v2_id AS physical_zone_id,
                cutover.selected_plan_id::text,
                projection.population_cutover_revision,
                canonical.state_revision AS canonical_revision,
                projection.population_v2_state_revision AS projection_revision,
                projection.harvest_revision,
                canonical.state AS canonical_state,
                canonical.state_actor_player_id AS canonical_actor_player_id,
                canonical.killed_or_harvested_at AS canonical_harvested_at,
                canonical.respawn_at AS canonical_respawn_at,
                (
                  EXTRACT(EPOCH FROM authority.regeneration_interval) * 1000
                )::bigint AS regeneration_ms,
                projection.ready_at AS projection_ready_at,
                projection.last_harvested_by AS projection_last_harvested_by,
                projection.population_v2_suppressed AS projection_suppressed,
                (
                  authority.entity_id IS NOT NULL
                  AND cutover.status='stable'
                  AND cutover.serving_version='v2'
                  AND cutover.cutover_revision=
                      projection.population_cutover_revision
                  AND membership.entity_id IS NOT NULL
                ) AS selected_plan_fenced,
                (
                  authority.entity_id IS NOT NULL
                  AND authority.owner_zone_id=
                      projection.physical_population_zone_v2_id
                  AND authority.node_type=projection.node_type
                  AND authority.yield_item_id=projection.yield_item_id
                  AND authority.yield_quantity=projection.yield_quantity
                  AND authority.regeneration_interval=
                      projection.regeneration_interval
                ) AS definition_fenced,
                clock_timestamp() AS database_now
         FROM repeatable_resource_nodes AS projection
         LEFT JOIN population_entity_state_v2 AS canonical
           ON canonical.entity_id=projection.population_v2_entity_id
         LEFT JOIN population_permanent_resource_authority_v2 AS authority
           ON authority.entity_id=projection.population_v2_entity_id
         LEFT JOIN population_zone_cutovers_v2 AS cutover
           ON cutover.zone_id=authority.owner_zone_id
         LEFT JOIN population_plan_permanent_resources_v2 AS membership
           ON membership.plan_id=cutover.selected_plan_id
          AND membership.entity_id=authority.entity_id
         WHERE projection.population_v2_entity_id IS NOT NULL
           AND ST_DWithin(
             projection.geom::geography,
             ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
             $3
           )
         ORDER BY (
           canonical.entity_id IS NOT NULL
           AND NOT projection.population_v2_suppressed
           AND authority.entity_id IS NOT NULL
           AND authority.owner_zone_id=
               projection.physical_population_zone_v2_id
           AND authority.node_type=projection.node_type
           AND authority.yield_item_id=projection.yield_item_id
           AND authority.yield_quantity=projection.yield_quantity
           AND authority.regeneration_interval=
               projection.regeneration_interval
           AND cutover.status='stable'
           AND cutover.serving_version='v2'
           AND cutover.cutover_revision=
               projection.population_cutover_revision
           AND membership.entity_id IS NOT NULL
         ) DESC NULLS LAST,
         (
           (
             canonical.state='harvested'
             AND canonical.respawn_at IS NOT NULL
             AND canonical.respawn_at<=clock_timestamp()
           )
           OR canonical.state_revision<>
              projection.population_v2_state_revision
           OR canonical.state_revision<>projection.harvest_revision
           OR projection.ready_at IS DISTINCT FROM CASE
             WHEN canonical.state='ready' THEN '-infinity'::timestamptz
             ELSE canonical.respawn_at
           END
           OR projection.last_harvested_by IS DISTINCT FROM CASE
             WHEN canonical.state='ready' THEN NULL
             ELSE canonical.state_actor_player_id
           END
         ) DESC NULLS LAST,
         projection.id
         LIMIT $4`,
        [
          vision.center.lon,
          vision.center.lat,
          vision.radiusM,
          MAX_DUE_NODES_PER_CONVERGENCE
        ]
      );
      const safeRows = audit.rows.filter(isSafeAuditRow);
      const dueRows = safeRows.filter((row) =>
        row.canonical_state === "harvested"
        && row.canonical_respawn_at !== null
        && dateMs(row.canonical_respawn_at) <= dateMs(row.database_now)
      );
      await lockCanonicalRowsForNodes(
        client,
        safeRows.map((row) => row.node_id)
      );
      const repaired = safeRows.length === 0
        ? 0
        : await repairProjection(
            client,
            safeRows.map((row) => row.node_id)
          );
      const promoted = dueRows.length === 0
        ? 0
        : await promoteDueRows(client, dueRows.map((row) => row.node_id));
      await client.query("COMMIT");
      const unsafe = audit.rows.filter((row) => !isSafeAuditRow(row));
      for (const row of unsafe.slice(0, 8)) this.logUnsafeAudit(row);
      const diagnostics = {
        examined: audit.rows.length,
        due: dueRows.length,
        promoted,
        casRacesLost: Math.max(0, dueRows.length - promoted),
        projectionsRepaired: repaired,
        unsafeRejected: unsafe.length
      };
      if (
        diagnostics.promoted > 0
        || diagnostics.casRacesLost > 0
        || diagnostics.projectionsRepaired > 0
      ) {
        this.logger?.info({
          ...diagnostics,
          center: vision.center,
          radiusM: vision.radiusM,
          outcome: "vision-converged"
        }, "permanent resource lifecycle convergence");
      }
      return diagnostics;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private logUnsafe(
    row: PermanentResourceNodeRow,
    canonical: PermanentResourceCanonicalRow | null,
    outcome: PermanentResourceAuthorityFailureReason
  ): void {
    this.logUnsafeOnce([
      row.id,
      Number(row.population_v2_state_revision),
      canonical?.state_revision ?? "missing",
      outcome
    ].join(":"), {
      nodeId: row.id,
      canonicalEntityId: row.population_v2_entity_id,
      physicalZone: row.physical_population_zone_v2_id,
      cutoverRevision: Number(row.population_cutover_revision),
      canonicalRevision:
        canonical ? Number(canonical.state_revision) : null,
      projectionRevision: Number(row.population_v2_state_revision),
      deadline: canonical?.respawn_at ?? null,
      outcome
    });
  }

  private logUnsafeAudit(row: VisionAuditRow): void {
    const lifecycleIssue = canonicalLifecycleIssue({
      state: row.canonical_state,
      actorPlayerId: row.canonical_actor_player_id,
      harvestedAt: row.canonical_harvested_at,
      respawnAt: row.canonical_respawn_at,
      regenerationMs: Number(row.regeneration_ms)
    });
    const outcome = row.projection_suppressed
      ? "projection-suppressed"
      : !row.canonical_entity_id
        ? "projection-canonical-entity-mismatch"
        : !row.definition_fenced
          ? "projection-definition-mismatch"
          : !row.selected_plan_fenced
            ? "projection-plan-cutover-mismatch"
            : "canonical-lifecycle-invalid";
    this.logUnsafeOnce([
      row.node_id,
      row.projection_revision,
      row.canonical_revision ?? "missing",
      outcome
    ].join(":"), {
      nodeId: row.node_id,
      canonicalEntityId: row.canonical_entity_id,
      physicalZone: row.physical_zone_id,
      selectedPlan: row.selected_plan_id,
      cutoverRevision: Number(row.population_cutover_revision),
      canonicalRevision:
        row.canonical_revision === null
          ? null
          : Number(row.canonical_revision),
      projectionRevision: Number(row.projection_revision),
      canonicalState: row.canonical_state,
      harvestedAt: row.canonical_harvested_at,
      deadline: row.canonical_respawn_at,
      outcome,
      ...(lifecycleIssue ? { lifecycleIssue } : {})
    });
  }

  private logUnsafeOnce(
    signature: string,
    diagnostic: Record<string, unknown>,
    message = "unsafe permanent resource projection rejected"
  ): void {
    if (this.loggedUnsafeSignatures.has(signature)) return;
    this.loggedUnsafeSignatures.add(signature);
    while (this.loggedUnsafeSignatures.size > 512) {
      const oldest = this.loggedUnsafeSignatures.values().next().value;
      if (oldest === undefined) break;
      this.loggedUnsafeSignatures.delete(oldest);
    }
    this.logger?.warn(diagnostic, message);
  }

  private logConvergence(
    diagnostics: PermanentResourceConvergenceDiagnostics,
    row: PermanentResourceNodeRow,
    canonical: PermanentResourceCanonicalRow,
    outcome: string
  ): void {
    if (
      diagnostics.promoted === 0
      && diagnostics.projectionsRepaired === 0
    ) return;
    this.logger?.info({
      ...diagnostics,
      nodeId: row.id,
      canonicalEntityId: canonical.entity_id,
      physicalZone: row.physical_population_zone_v2_id,
      cutoverRevision: Number(row.population_cutover_revision),
      canonicalRevision: Number(canonical.state_revision),
      projectionRevision: Number(row.population_v2_state_revision),
      deadline: canonical.respawn_at,
      outcome
    }, "permanent resource lifecycle convergence");
  }
}

function publicNodesSql(
  predicate: string,
  playerParameter: number
): string {
  return `${projectionSelect(
    "CASE WHEN canonical.state='ready' THEN 'ready' ELSE 'depleted' END",
    `CASE WHEN $${playerParameter}::text IS NULL
       THEN false
       ELSE EXISTS (
         SELECT 1
         FROM player_profession_progress AS progress
         WHERE progress.player_id=$${playerParameter}
           AND progress.profession_id=authority.timer_profession_id
           AND progress.rank >= authority.timer_visibility_rank
       )
       AND EXISTS (
         SELECT 1
         FROM player_discovered_mines AS discovery
         WHERE discovery.player_id=$${playerParameter}
           AND discovery.node_id=projection.id
       )
     END`,
    `projection.owner_player_id,
     owner.username AS owner_username,
     projection.harvest_access_mode,
     projection.harvest_access_revision,
     COALESCE(toll.toll_gold, 0) AS toll_gold,
     ($${playerParameter}::text IS NOT NULL
       AND projection.owner_player_id=$${playerParameter}) AS can_manage`
  )}
  FROM repeatable_resource_nodes AS projection
  JOIN population_entity_state_v2 AS canonical
    ON canonical.entity_id=projection.population_v2_entity_id
  JOIN population_permanent_resource_authority_v2 AS authority
    ON authority.entity_id=canonical.entity_id
   AND authority.owner_zone_id=projection.physical_population_zone_v2_id
   AND authority.node_type=projection.node_type
   AND authority.yield_item_id=projection.yield_item_id
   AND authority.yield_quantity=projection.yield_quantity
   AND authority.regeneration_interval=projection.regeneration_interval
  JOIN population_zone_cutovers_v2 AS cutover
    ON cutover.zone_id=authority.owner_zone_id
   AND cutover.status='stable'
   AND cutover.serving_version='v2'
   AND cutover.cutover_revision=projection.population_cutover_revision
  JOIN population_plan_permanent_resources_v2 AS membership
    ON membership.plan_id=cutover.selected_plan_id
   AND membership.entity_id=authority.entity_id
  LEFT JOIN players AS owner ON owner.id=projection.owner_player_id
  LEFT JOIN player_harvest_toll_settings AS toll
    ON toll.owner_player_id=projection.owner_player_id
   AND toll.harvest_type=projection.node_type
  WHERE projection.population_v2_entity_id IS NOT NULL
    AND NOT projection.population_v2_suppressed
    AND ${predicate}
  ORDER BY projection.id`;
}

function projectionSelect(
  publicState: string,
  timerVisible = "false",
  accessProjection = `projection.owner_player_id,
    NULL::text AS owner_username,
    projection.harvest_access_mode,
    projection.harvest_access_revision,
    0::bigint AS toll_gold,
    false AS can_manage`
): string {
  return `SELECT projection.id::text, projection.node_type,
                 projection.region_code, projection.lat, projection.lon,
                 projection.yield_item_id, projection.yield_quantity,
                 projection.harvest_revision,
                 canonical.respawn_at AS ready_at,
                 ${publicState} AS public_state,
                 projection.bonus_extraction_available,
                 projection.bonus_extraction_revision,
                 ${timerVisible} AS timer_visible,
                 canonical.state AS canonical_state,
                 canonical.state_actor_player_id AS canonical_actor_player_id,
                 canonical.killed_or_harvested_at AS canonical_harvested_at,
                 projection.population_v2_entity_id::text,
                 projection.physical_population_zone_v2_id,
                 canonical.state_revision AS population_v2_state_revision,
                 projection.population_cutover_revision,
                 projection.population_v2_suppressed,
                 ${accessProjection}`;
}

function duePromotionSql(
  canonicalPredicate: string,
  expectedRevision: string
): string {
  return `WITH boundary AS MATERIALIZED (
            SELECT clock_timestamp() AS occurred_at
          )
          UPDATE population_entity_state_v2 AS canonical
          SET state='ready',
              state_revision=canonical.state_revision + 1,
              state_actor_player_id=NULL,
              killed_or_harvested_at=NULL,
              respawn_at=NULL,
              durable_runtime_state='{}'::jsonb,
              updated_at=boundary.occurred_at
          FROM repeatable_resource_nodes AS projection
          JOIN population_permanent_resource_authority_v2 AS authority
            ON authority.entity_id=projection.population_v2_entity_id
           AND authority.owner_zone_id=
               projection.physical_population_zone_v2_id
           AND authority.node_type=projection.node_type
           AND authority.yield_item_id=projection.yield_item_id
           AND authority.yield_quantity=projection.yield_quantity
           AND authority.regeneration_interval=
               projection.regeneration_interval
          JOIN population_zone_cutovers_v2 AS cutover
            ON cutover.zone_id=authority.owner_zone_id
           AND cutover.status='stable'
           AND cutover.serving_version='v2'
           AND cutover.cutover_revision=
               projection.population_cutover_revision
          JOIN population_plan_permanent_resources_v2 AS membership
            ON membership.plan_id=cutover.selected_plan_id
           AND membership.entity_id=authority.entity_id,
          boundary
          WHERE canonical.entity_id=projection.population_v2_entity_id
            AND ${canonicalPredicate}
            AND canonical.state_revision=${expectedRevision}
            AND canonical.state='harvested'
            AND canonical.killed_or_harvested_at IS NOT NULL
            AND canonical.respawn_at IS NOT NULL
            AND canonical.respawn_at =
                canonical.killed_or_harvested_at
                + authority.regeneration_interval
            AND canonical.respawn_at <= boundary.occurred_at
            AND NOT projection.population_v2_suppressed
          RETURNING canonical.state_revision`;
}

async function promoteDueRows(
  queryable: Pick<pg.PoolClient, "query">,
  nodeIds: readonly string[]
): Promise<number> {
  const result = await queryable.query(
    duePromotionSql(
      "projection.id=ANY($1::uuid[])",
      "projection.population_v2_state_revision"
    ),
    [nodeIds]
  );
  return result.rowCount ?? 0;
}

async function lockCanonicalRowsForNodes(
  queryable: Pick<pg.PoolClient, "query">,
  nodeIds: readonly string[]
): Promise<void> {
  if (nodeIds.length === 0) return;
  await queryable.query(
    `SELECT canonical.entity_id
     FROM population_entity_state_v2 AS canonical
     JOIN repeatable_resource_nodes AS projection
       ON projection.population_v2_entity_id=canonical.entity_id
     WHERE projection.id=ANY($1::uuid[])
     ORDER BY canonical.entity_id
     FOR UPDATE OF canonical`,
    [nodeIds]
  );
}

async function repairProjection(
  queryable: Pick<pg.PoolClient, "query">,
  nodeIds: readonly string[]
): Promise<number> {
  if (nodeIds.length === 0) return 0;
  const result = await queryable.query(
    `UPDATE repeatable_resource_nodes AS projection
     SET ready_at=CASE
           WHEN canonical.state='ready' THEN '-infinity'::timestamptz
           ELSE canonical.respawn_at
         END,
         harvest_revision=canonical.state_revision,
         last_harvested_by=CASE
           WHEN canonical.state='ready' THEN NULL
           ELSE canonical.state_actor_player_id
         END,
         population_v2_state_revision=canonical.state_revision
     FROM population_entity_state_v2 AS canonical,
          population_permanent_resource_authority_v2 AS authority,
          population_zone_cutovers_v2 AS cutover,
          population_plan_permanent_resources_v2 AS membership
     WHERE projection.id=ANY($1::uuid[])
       AND projection.population_v2_entity_id=canonical.entity_id
       AND authority.entity_id=canonical.entity_id
       AND authority.owner_zone_id=projection.physical_population_zone_v2_id
       AND authority.node_type=projection.node_type
       AND authority.yield_item_id=projection.yield_item_id
       AND authority.yield_quantity=projection.yield_quantity
       AND authority.regeneration_interval=projection.regeneration_interval
       AND cutover.zone_id=authority.owner_zone_id
       AND cutover.status='stable'
       AND cutover.serving_version='v2'
       AND cutover.cutover_revision=projection.population_cutover_revision
       AND membership.plan_id=cutover.selected_plan_id
       AND membership.entity_id=authority.entity_id
       AND NOT projection.population_v2_suppressed
       AND (
         (
           canonical.state='ready'
           AND canonical.state_actor_player_id IS NULL
           AND canonical.killed_or_harvested_at IS NULL
           AND canonical.respawn_at IS NULL
         )
         OR
         (
           canonical.state='harvested'
           AND canonical.killed_or_harvested_at IS NOT NULL
           AND canonical.respawn_at IS NOT NULL
           AND canonical.respawn_at =
               canonical.killed_or_harvested_at
               + authority.regeneration_interval
         )
       )
       AND (
         projection.population_v2_state_revision<>canonical.state_revision
         OR projection.harvest_revision<>canonical.state_revision
         OR projection.ready_at IS DISTINCT FROM CASE
           WHEN canonical.state='ready' THEN '-infinity'::timestamptz
           ELSE canonical.respawn_at
         END
         OR projection.last_harvested_by IS DISTINCT FROM CASE
           WHEN canonical.state='ready' THEN NULL
           ELSE canonical.state_actor_player_id
         END
       )`,
    [nodeIds]
  );
  return result.rowCount ?? 0;
}

function authorityFailure(
  row: PermanentResourceNodeRow,
  canonical: PermanentResourceCanonicalRow | null,
  definition: PermanentResourceDefinition
): PermanentResourceAuthorityFailureReason | undefined {
  if (row.population_v2_suppressed) return "projection-suppressed";
  if (
    !canonical
    || canonical.entity_id !== row.population_v2_entity_id
  ) return "projection-canonical-entity-mismatch";
  if (!canonical.definition_fenced) {
    return "projection-definition-mismatch";
  }
  if (!canonical.selected_plan_fenced) {
    return "projection-plan-cutover-mismatch";
  }
  if (canonicalLifecycleIssue({
    state: canonical.state,
    actorPlayerId: canonical.state_actor_player_id,
    harvestedAt: canonical.killed_or_harvested_at,
    respawnAt: canonical.respawn_at,
    regenerationMs: definition.regenerationMs
  })) {
    return "canonical-lifecycle-invalid";
  }
  return undefined;
}

function isSafeAuditRow(row: VisionAuditRow): boolean {
  return Boolean(
    row.canonical_entity_id
    && !row.projection_suppressed
    && row.selected_plan_fenced
    && row.definition_fenced
    && !canonicalLifecycleIssue({
      state: row.canonical_state,
      actorPlayerId: row.canonical_actor_player_id,
      harvestedAt: row.canonical_harvested_at,
      respawnAt: row.canonical_respawn_at,
      regenerationMs: Number(row.regeneration_ms)
    })
  );
}

function canonicalLifecycleIssue(input: {
  state: "ready" | "harvested" | "dead" | null;
  actorPlayerId: string | null;
  harvestedAt: Date | string | null;
  respawnAt: Date | string | null;
  regenerationMs: number;
}): string | null {
  if (input.state === "ready") {
    return input.actorPlayerId === null
      && input.harvestedAt === null
      && input.respawnAt === null
      ? null
      : "ready-state-retains-harvest-fields";
  }
  if (input.state !== "harvested") {
    return input.state === null
      ? "missing-canonical-state"
      : `unsupported-canonical-state:${input.state}`;
  }
  if (input.harvestedAt === null) return "harvested-without-harvest-timestamp";
  if (input.respawnAt === null) return "harvested-without-respawn-deadline";
  return dateMs(input.respawnAt)
      === dateMs(input.harvestedAt) + input.regenerationMs
    ? null
    : "harvested-with-incorrect-respawn-deadline";
}

function validateDefinitions(
  definitions: readonly PermanentResourceDefinition[]
): void {
  if (definitions.length === 0) {
    throw new Error("permanent-resource registry cannot be empty");
  }
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (
      !/^[a-z][a-z0-9_]*$/u.test(definition.nodeType)
      || seen.has(definition.nodeType)
    ) {
      throw new Error(
        `invalid or duplicate permanent resource ${definition.nodeType}`
      );
    }
    seen.add(definition.nodeType);
    if (
      !/^[a-z][a-z0-9_]*$/u.test(definition.populationEntityKind)
      || definition.populationArchetype.length === 0
      || definition.yieldedItem.length === 0
      || !Number.isSafeInteger(definition.yieldQuantity)
      || definition.yieldQuantity <= 0
      || !Number.isSafeInteger(definition.regenerationMs)
      || definition.regenerationMs <= 0
      || definition.timerProfessionId.length === 0
      || !Number.isSafeInteger(definition.timerVisibilityRank)
      || definition.timerVisibilityRank < 0
    ) {
      throw new Error(
        `invalid permanent-resource definition ${definition.nodeType}`
      );
    }
    const legacyYieldQuantities = definition.legacyYieldQuantities ?? [];
    if (
      legacyYieldQuantities.some((quantity) =>
        !Number.isSafeInteger(quantity) || quantity <= 0
      )
      || legacyYieldQuantities.includes(definition.yieldQuantity)
      || new Set(legacyYieldQuantities).size !== legacyYieldQuantities.length
    ) {
      throw new Error(
        `invalid legacy yield quantities for permanent resource ${definition.nodeType}`
      );
    }
  }
}

function definitionYieldQuantities(
  definition: PermanentResourceDefinition
): readonly number[] {
  return [
    definition.yieldQuantity,
    ...(definition.legacyYieldQuantities ?? [])
  ];
}

function dateIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function dateMs(value: Date | string): number {
  return new Date(value).getTime();
}
