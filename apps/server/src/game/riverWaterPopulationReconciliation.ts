import { createHash } from "node:crypto";

import type pg from "pg";

import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { createLogger } from "../logger.js";
import { WORLD_RUNTIME_CONTRACT } from "../runtime/authorityIdentity.js";
import {
  WorldBatchBackpressureError,
  WorldLookupClient
} from "../world/worldLookupClient.js";

type Candidate = {
  ownership: "generated" | "player";
  kind: string;
  object_id: string;
  generation_id: string;
  already_suppressed: boolean;
  lat: number;
  lon: number;
};

type Conflict = Candidate & {
  riverRowId: number;
  riverColumnId: number;
};

const mode = process.argv.includes("--apply") ? "apply" : "dry-run";
const WORLD_LOOKUP_BATCH_SIZE = 128;
const MAX_WORLD_LOOKUP_ATTEMPTS = 5;
const config = loadConfig();
const logger = createLogger(config.NODE_ENV);
const pool = createPool({
  databaseUrl: config.DATABASE_URL,
  max: 2,
  connectionTimeoutMs: config.DB_POOL_CONNECTION_TIMEOUT_MS,
  idleTimeoutMs: config.DB_POOL_IDLE_TIMEOUT_MS,
  applicationName: `ash-atlas-river-water-reconciliation:${mode}`,
  logger
});
const world = new WorldLookupClient(
  config.WORLD_API_BASE,
  logger,
  config.WORLD_LOOKUP_TIMEOUT_MS,
  {
    releaseId: config.WORLD_REQUIRED_RELEASE_ID,
    profileSetFingerprint: config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT,
    buildContractFingerprint: config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT,
    boundaryReleaseId: config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID
  },
  config.RESOURCE_ENVIRONMENT_BATCH_TIMEOUT_MS,
  {
    maxEntries: config.WORLD_WATER_CACHE_MAX_ENTRIES,
    maxBytes: config.WORLD_WATER_CACHE_MAX_BYTES,
    ttlMs: config.WORLD_WATER_CACHE_TTL_MS
  },
  {
    runtimeSha: WORLD_RUNTIME_CONTRACT.worldPipelineSha,
    ...WORLD_RUNTIME_CONTRACT.riverSurface
  }
);

try {
  await world.verifyRequiredRelease();
  const candidates = await loadCandidates(pool);
  const conflicts = await findConflicts(candidates);
  const report = reportFor(conflicts, candidates);
  if (mode === "dry-run") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const applied = await applyReconciliation(pool, conflicts);
    process.stdout.write(`${JSON.stringify({ ...report, mode, applied }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}

async function loadCandidates(queryable: Pick<pg.Pool, "query">): Promise<Candidate[]> {
  const result = await queryable.query<Candidate>(`
    SELECT 'generated'::text AS ownership, slot.entity_kind AS kind,
           slot.entity_id::text AS object_id,
           COALESCE(slot.generation_id::text, 'permanent') AS generation_id,
           suppression.entity_id IS NOT NULL AS already_suppressed,
           slot.anchor_latitude AS lat, slot.anchor_longitude AS lon
    FROM population_plan_spawn_slots_v2 AS slot
    JOIN population_zone_cutovers_v2 AS cutover
     ON cutover.selected_plan_id=slot.plan_id
     AND cutover.serving_version='v2' AND cutover.status='stable'
    LEFT JOIN population_river_water_suppressions_v1 AS suppression
      ON suppression.entity_id=slot.entity_id
    WHERE slot.entity_kind NOT IN ('alligator', 'caiman', 'crocodile')
    UNION ALL
    SELECT 'player', 'flag', id::text,
           COALESCE(city_id::text, kingdom_id::text, 'personal'), false, lat, lon
    FROM flags
    UNION ALL
    SELECT 'player', structure_type, structure_id::text, city_id::text, false, lat, lon
    FROM city_structures WHERE state IN ('constructing','active')
    UNION ALL
    SELECT 'player', 'kingdom_seat', id::text, kingdom_id::text, false, lat, lon
    FROM kingdom_seats WHERE status='active'
    UNION ALL
    SELECT 'player', 'kingdom_cot', id::text, kingdom_id::text, false, lat, lon
    FROM kingdom_cots WHERE status='active'
    UNION ALL
    SELECT 'player', 'kingdom_decoration', id::text, kingdom_id::text, false, lat, lon
    FROM kingdom_decorations WHERE status='active'
    ORDER BY ownership, object_id`);
  return result.rows.map((row) => ({
    ...row,
    lat: Number(row.lat),
    lon: Number(row.lon)
  }));
}

async function findConflicts(candidates: readonly Candidate[]): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  for (let offset = 0; offset < candidates.length; offset += WORLD_LOOKUP_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + WORLD_LOOKUP_BATCH_SIZE);
    const environments = await lookupWorldBatch(
      batch.map(({ lat, lon }) => ({ lat, lon }))
    );
    for (const [index, environment] of environments.entries()) {
      const candidate = batch[index];
      if (!candidate || environment.waterKind !== "river") continue;
      const surface = environment.riverSurface;
      if (!surface ||
          surface.sourceReleaseId !== WORLD_RUNTIME_CONTRACT.riverSurface.releaseId ||
          surface.sourceManifestSha256 !== WORLD_RUNTIME_CONTRACT.riverSurface.manifestSha256) {
        throw new Error("river conflict omitted the exact locked source identity");
      }
      conflicts.push({
        ...candidate,
        riverRowId: surface.rowId,
        riverColumnId: surface.columnId
      });
    }
  }
  return conflicts;
}

async function lookupWorldBatch(points: readonly { lat: number; lon: number }[]) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await world.lookupGameplayEnvironments(points, { caller: "population-plan" });
    } catch (error) {
      if (!(error instanceof WorldBatchBackpressureError) ||
          attempt >= MAX_WORLD_LOOKUP_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs));
    }
  }
}

function reportFor(conflicts: readonly Conflict[], candidates: readonly Candidate[]) {
  const grouped = new Map<string, number>();
  for (const conflict of conflicts) {
    const key = [conflict.ownership, conflict.kind, conflict.generation_id].join("|");
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  return {
    contractVersion: "river-water-authority-reconciliation-v1",
    mode,
    riverSource: WORLD_RUNTIME_CONTRACT.riverSurface,
    scanned: candidates.length,
    generatedScanned: candidates.filter(({ ownership }) => ownership === "generated").length,
    playerOwnedScanned: candidates.filter(({ ownership }) => ownership === "player").length,
    generatedConflictCount: conflicts.filter(({ ownership }) => ownership === "generated").length,
    pendingGeneratedConflictCount: conflicts.filter(
      ({ ownership, already_suppressed }) => ownership === "generated" && !already_suppressed
    ).length,
    playerOwnedConflictCount: conflicts.filter(({ ownership }) => ownership === "player").length,
    grouped: [...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => {
      const [ownership, kind, generationId] = key.split("|");
      return { ownership, kind, generationId, count };
    }),
    conflicts: conflicts.map((conflict) => ({
      ownership: conflict.ownership,
      kind: conflict.kind,
      generationId: conflict.generation_id,
      alreadySuppressed: conflict.already_suppressed,
      stableObjectId: stableId(conflict.object_id),
      owningContext: stableId(conflict.generation_id),
      riverCellId: `${WORLD_RUNTIME_CONTRACT.riverSurface.releaseId}:${conflict.riverRowId}:${conflict.riverColumnId}`
    }))
  };
}

async function applyReconciliation(pool: pg.Pool, conflicts: readonly Conflict[]) {
  const generated = conflicts.filter(({ ownership }) => ownership === "generated");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('river-water-population-reconciliation-v1',0))"
    );
    const entityIds = generated.map(({ object_id }) => object_id);
    const unrelatedBefore = await unrelatedProjectionDigest(client, entityIds);
    await client.query(
      `INSERT INTO population_river_water_suppressions_v1 (
         entity_id, entity_kind, generation_id, river_release_id,
         river_manifest_sha256, river_row_id, river_column_id
       )
       SELECT row.entity_id, row.entity_kind, row.generation_id,
              $2, $3, row.river_row_id, row.river_column_id
       FROM jsonb_to_recordset($1::jsonb) AS row(
         entity_id uuid, entity_kind text, generation_id uuid,
         river_row_id bigint, river_column_id bigint
       )
       ON CONFLICT (entity_id) DO NOTHING`,
      [JSON.stringify(generated.map((conflict) => ({
        entity_id: conflict.object_id,
        entity_kind: conflict.kind,
        generation_id: conflict.generation_id === "permanent" ? null : conflict.generation_id,
        river_row_id: conflict.riverRowId,
        river_column_id: conflict.riverColumnId
      }))), WORLD_RUNTIME_CONTRACT.riverSurface.releaseId,
      WORLD_RUNTIME_CONTRACT.riverSurface.manifestSha256]
    );
    const updates: Record<string, number> = {};
    for (const table of ["collectible_nodes", "generated_world_mobs", "repeatable_resource_nodes"]) {
      const result = await client.query(
        `UPDATE ${table} SET population_cutover_suppressed=true
         WHERE population_v2_entity_id=ANY($1::uuid[])
           AND NOT population_cutover_suppressed`,
        [entityIds]
      );
      updates[table] = result.rowCount ?? 0;
    }
    const receiptCount = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM population_river_water_suppressions_v1
       WHERE entity_id=ANY($1::uuid[])`,
      [entityIds]
    );
    if (Number(receiptCount.rows[0]?.count) !== generated.length) {
      throw new Error("river suppression receipt count differs from the exact dry-run conflicts");
    }
    const unrelatedAfter = await unrelatedProjectionDigest(client, entityIds);
    if (unrelatedBefore !== unrelatedAfter) {
      throw new Error("unrelated population projection state changed during reconciliation");
    }
    await client.query("COMMIT");
    return {
      exactConflictCount: generated.length,
      receiptCount: Number(receiptCount.rows[0]?.count),
      projectionUpdates: updates,
      unrelatedProjectionDigest: unrelatedAfter,
      playerOwnedObjectsChanged: 0
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function unrelatedProjectionDigest(
  queryable: Pick<pg.PoolClient, "query">,
  excludedIds: readonly string[]
): Promise<string> {
  const result = await queryable.query<{ digest: string }>(`
    SELECT md5(string_agg(payload, '' ORDER BY payload)) AS digest
    FROM (
      SELECT 'collectible:' || to_jsonb(row)::text AS payload
      FROM collectible_nodes AS row
      WHERE row.population_v2_entity_id IS NOT NULL
        AND NOT (row.population_v2_entity_id=ANY($1::uuid[]))
      UNION ALL
      SELECT 'mob:' || to_jsonb(row)::text
      FROM generated_world_mobs AS row
      WHERE row.population_v2_entity_id IS NOT NULL
        AND NOT (row.population_v2_entity_id=ANY($1::uuid[]))
      UNION ALL
      SELECT 'resource:' || to_jsonb(row)::text
      FROM repeatable_resource_nodes AS row
      WHERE row.population_v2_entity_id IS NOT NULL
        AND NOT (row.population_v2_entity_id=ANY($1::uuid[]))
    ) AS unrelated`, [excludedIds]);
  return result.rows[0]?.digest ?? createHash("md5").update("").digest("hex");
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
