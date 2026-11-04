import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type pg from "pg";

import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { createLogger } from "../logger.js";
import { WORLD_RUNTIME_CONTRACT } from "../runtime/authorityIdentity.js";
import { WorldLookupClient } from "../world/worldLookupClient.js";
import type {
  SettlementAuthorityIdentity,
  SettlementLookupResult,
  WorldSettlement
} from "../world/worldTypes.js";

const MAX_ACTIVE_CITIES = 1_000;
const PAGE_SIZE = 100;
const RECONCILIATION_LOCK = "city-settlement-reconciliation-v1";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type ActiveCityRow = {
  id: string;
  world_id: string;
  canonical_municipality_id: string;
  world_settlement_id: string;
  world_settlement_source: string;
  world_source_settlement_id: string;
  settlement_class: string | null;
  settlement_release_id: string | null;
  settlement_release_fingerprint: string | null;
  settlement_founding_policy_id: string | null;
  settlement_founding_policy_fingerprint: string | null;
  settlement_resolution_policy_id: string | null;
  settlement_resolution_policy_fingerprint: string | null;
  name: string;
  country_code: string;
  region_code: string | null;
  spatial_revision: string | number;
  seat_flag_id: string;
  seat_lat: number;
  seat_lon: number;
  seat_control_type: string;
  seat_city_id: string | null;
};

export type CitySettlementAuthorityState = {
  canonicalMunicipalityId: string;
  worldSettlementId: string;
  worldSettlementSource: string;
  worldSourceSettlementId: string;
  settlementClass: string | null;
  settlementReleaseId: string | null;
  settlementReleaseFingerprint: string | null;
  settlementFoundingPolicyId: string | null;
  settlementFoundingPolicyFingerprint: string | null;
  settlementResolutionPolicyId: string | null;
  settlementResolutionPolicyFingerprint: string | null;
  name: string;
  countryCode: string;
  regionCode: string | null;
  spatialRevision: string;
};

export type CitySettlementReconciliationChange = {
  cityId: string;
  seatFlagId: string;
  seatLat: number;
  seatLon: number;
  before: CitySettlementAuthorityState;
  after: CitySettlementAuthorityState;
  resolution: WorldSettlement["resolution"];
};

export type CitySettlementReconciliationPlan = {
  contractVersion: "city-settlement-reconciliation-plan-v1";
  ok: boolean;
  worldId: string;
  authority: SettlementAuthorityIdentity;
  inspectedCount: number;
  unchangedCount: number;
  changedCount: number;
  conflicts: Array<{ canonicalMunicipalityId: string; cityIds: string[] }>;
  errors: Array<{ cityId: string; reason: string }>;
  changes: CitySettlementReconciliationChange[];
  reportSha256: string;
};

type ReconciliationOptions = {
  pool: pg.Pool;
  lookupSettlement: (lat: number, lon: number) => Promise<SettlementLookupResult>;
  worldId: string;
  authority: SettlementAuthorityIdentity;
  maxCities?: number;
};

export async function planCitySettlementReconciliation(
  options: ReconciliationOptions
): Promise<CitySettlementReconciliationPlan> {
  const rows = await loadActiveCities(
    options.pool,
    options.worldId,
    options.maxCities ?? MAX_ACTIVE_CITIES
  );
  const changes: CitySettlementReconciliationChange[] = [];
  const errors: Array<{ cityId: string; reason: string }> = [];
  const targets = new Map<string, string[]>();
  let unchangedCount = 0;
  for (const row of rows) {
    if (row.seat_control_type !== "city_seat" || row.seat_city_id !== row.id) {
      errors.push({ cityId: row.id, reason: "City Center ownership/control is inconsistent" });
      continue;
    }
    let lookup: SettlementLookupResult;
    try {
      lookup = await options.lookupSettlement(Number(row.seat_lat), Number(row.seat_lon));
    } catch (error) {
      errors.push({ cityId: row.id, reason: errorMessage(error) });
      continue;
    }
    if (!lookup.found) {
      errors.push({ cityId: row.id, reason: "City Center is outside settlement authority" });
      continue;
    }
    if (!lookup.settlement.foundingEligible) {
      errors.push({ cityId: row.id, reason: "Resolved settlement is not founding eligible" });
      continue;
    }
    if (!authorityMatches(lookup.authority, options.authority)) {
      errors.push({ cityId: row.id, reason: "World authority does not match the pinned target" });
      continue;
    }
    const before = authorityState(row);
    const after = settlementState(lookup.settlement, before.spatialRevision);
    const owners = targets.get(after.canonicalMunicipalityId) ?? [];
    owners.push(row.id);
    targets.set(after.canonicalMunicipalityId, owners);
    if (sameAuthority(before, after)) {
      unchangedCount += 1;
      continue;
    }
    changes.push({
      cityId: row.id,
      seatFlagId: row.seat_flag_id,
      seatLat: Number(row.seat_lat),
      seatLon: Number(row.seat_lon),
      before,
      after,
      resolution: lookup.settlement.resolution
    });
  }
  const conflicts = [...targets]
    .filter(([, cityIds]) => cityIds.length > 1)
    .map(([canonicalMunicipalityId, cityIds]) => ({
      canonicalMunicipalityId,
      cityIds: [...cityIds].sort()
    }))
    .sort((left, right) => left.canonicalMunicipalityId.localeCompare(right.canonicalMunicipalityId));
  const unsigned = {
    contractVersion: "city-settlement-reconciliation-plan-v1" as const,
    ok: errors.length === 0 && conflicts.length === 0,
    worldId: options.worldId,
    authority: options.authority,
    inspectedCount: rows.length,
    unchangedCount,
    changedCount: changes.length,
    conflicts,
    errors,
    changes
  };
  return { ...unsigned, reportSha256: sha256Json(unsigned) };
}

export async function applyCitySettlementReconciliation(
  pool: pg.Pool,
  plan: CitySettlementReconciliationPlan,
  actor: string
): Promise<{ applied: boolean; runId: string | null; changedCount: number }> {
  if (!plan.ok) throw new Error("cannot apply a reconciliation plan with conflicts or errors");
  if (!actor.trim()) throw new Error("reconciliation actor is required");
  if (plan.changes.length === 0) return { applied: false, runId: null, changedCount: 0 };
  const client = await pool.connect();
  const runId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      RECONCILIATION_LOCK
    ]);
    for (const change of plan.changes) {
      const current = await loadLockedCity(client, change.cityId);
      if (!current || current.seat_flag_id !== change.seatFlagId) {
        throw new Error(`city ${change.cityId} or its City Center changed after dry run`);
      }
      if (!sameAuthority(authorityState(current), change.before)) {
        throw new Error(`city ${change.cityId} authority changed after dry run`);
      }
      const conflict = await client.query<{ id: string }>(
        `SELECT id FROM cities
         WHERE active AND world_id=$1 AND canonical_municipality_id=$2 AND id<>$3
         LIMIT 1`,
        [plan.worldId, change.after.canonicalMunicipalityId, change.cityId]
      );
      if (conflict.rowCount) {
        throw new Error(
          `city ${change.cityId} target is already owned by ${conflict.rows[0]?.id}`
        );
      }
    }
    await client.query(
      `INSERT INTO city_settlement_reconciliation_runs (
         id, world_id, operation, actor,
         target_release_id, target_release_fingerprint,
         target_founding_policy_id, target_founding_policy_fingerprint,
         target_resolution_policy_id, target_resolution_policy_fingerprint,
         report_sha256, planned_count, changed_count
       ) VALUES ($1,$2,'reconcile',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        runId,
        plan.worldId,
        actor.trim(),
        plan.authority.releaseId,
        plan.authority.releaseFingerprint,
        plan.authority.foundingPolicyId,
        plan.authority.foundingPolicyFingerprint,
        plan.authority.resolutionPolicyId,
        plan.authority.resolutionPolicyFingerprint,
        plan.reportSha256,
        plan.inspectedCount,
        plan.changedCount
      ]
    );
    for (const change of plan.changes) {
      const updated = await updateCityAuthority(client, change.cityId, change.after);
      await client.query(
        `INSERT INTO city_settlement_reconciliation_events (
           id, run_id, city_id, before_state, after_state
         ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
        [randomUUID(), runId, change.cityId, JSON.stringify(change.before), JSON.stringify(updated)]
      );
    }
    await client.query("COMMIT");
    return { applied: true, runId, changedCount: plan.changedCount };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reverseCitySettlementReconciliation(
  pool: pg.Pool,
  sourceRunId: string,
  actor: string
): Promise<{ applied: true; runId: string; changedCount: number }> {
  if (!actor.trim()) throw new Error("reconciliation reversal actor is required");
  const client = await pool.connect();
  const runId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      RECONCILIATION_LOCK
    ]);
    const sourceRun = await client.query<{
      world_id: string;
      target_release_id: string;
      target_release_fingerprint: string;
      target_founding_policy_id: string;
      target_founding_policy_fingerprint: string;
      target_resolution_policy_id: string;
      target_resolution_policy_fingerprint: string;
    }>(
      `SELECT world_id, target_release_id, target_release_fingerprint,
              target_founding_policy_id, target_founding_policy_fingerprint,
              target_resolution_policy_id, target_resolution_policy_fingerprint
       FROM city_settlement_reconciliation_runs
       WHERE id=$1 AND operation='reconcile'
       FOR UPDATE`,
      [sourceRunId]
    );
    const run = sourceRun.rows[0];
    if (!run) throw new Error(`reconciliation run ${sourceRunId} is not reversible`);
    const events = await client.query<{
      city_id: string;
      before_state: CitySettlementAuthorityState;
      after_state: CitySettlementAuthorityState;
    }>(
      `SELECT city_id, before_state, after_state
       FROM city_settlement_reconciliation_events
       WHERE run_id=$1 ORDER BY city_id`,
      [sourceRunId]
    );
    if (!events.rowCount) throw new Error(`reconciliation run ${sourceRunId} has no events`);
    for (const event of events.rows) {
      const current = await loadLockedCity(client, event.city_id);
      if (!current || !sameAuthority(authorityState(current), event.after_state)) {
        throw new Error(`city ${event.city_id} no longer matches the reconciled authority state`);
      }
      const conflict = await client.query<{ id: string }>(
        `SELECT id FROM cities
         WHERE active AND world_id=$1 AND canonical_municipality_id=$2 AND id<>$3
         LIMIT 1`,
        [run.world_id, event.before_state.canonicalMunicipalityId, event.city_id]
      );
      if (conflict.rowCount) {
        throw new Error(
          `city ${event.city_id} rollback identity is already owned by ${conflict.rows[0]?.id}`
        );
      }
    }
    const reportSha256 = sha256Json({
      contractVersion: "city-settlement-reconciliation-reversal-v1",
      sourceRunId,
      cityIds: events.rows.map(({ city_id }) => city_id)
    });
    await client.query(
      `INSERT INTO city_settlement_reconciliation_runs (
         id, world_id, operation, actor, source_run_id,
         target_release_id, target_release_fingerprint,
         target_founding_policy_id, target_founding_policy_fingerprint,
         target_resolution_policy_id, target_resolution_policy_fingerprint,
         report_sha256, planned_count, changed_count
       ) VALUES ($1,$2,'reverse',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [
        runId,
        run.world_id,
        actor.trim(),
        sourceRunId,
        run.target_release_id,
        run.target_release_fingerprint,
        run.target_founding_policy_id,
        run.target_founding_policy_fingerprint,
        run.target_resolution_policy_id,
        run.target_resolution_policy_fingerprint,
        reportSha256,
        events.rows.length
      ]
    );
    for (const event of events.rows) {
      const current = await loadLockedCity(client, event.city_id);
      if (!current) throw new Error(`city ${event.city_id} disappeared during reversal`);
      const before = authorityState(current);
      const after = await updateCityAuthority(client, event.city_id, event.before_state);
      await client.query(
        `INSERT INTO city_settlement_reconciliation_events (
           id, run_id, city_id, before_state, after_state
         ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
        [randomUUID(), runId, event.city_id, JSON.stringify(before), JSON.stringify(after)]
      );
    }
    await client.query("COMMIT");
    return { applied: true, runId, changedCount: events.rows.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadActiveCities(
  queryable: Queryable,
  worldId: string,
  maxCities: number
): Promise<ActiveCityRow[]> {
  const rows: ActiveCityRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: { rows: ActiveCityRow[] } = await queryable.query(
      `SELECT c.id, c.world_id, c.canonical_municipality_id,
              c.world_settlement_id, c.world_settlement_source,
              c.world_source_settlement_id, c.settlement_class,
              c.settlement_release_id, c.settlement_release_fingerprint,
              c.settlement_founding_policy_id,
              c.settlement_founding_policy_fingerprint,
              c.settlement_resolution_policy_id,
              c.settlement_resolution_policy_fingerprint,
              c.name, c.country_code, c.region_code, c.spatial_revision,
              seat.id AS seat_flag_id, seat.lat AS seat_lat, seat.lon AS seat_lon,
              seat.control_type AS seat_control_type, seat.city_id AS seat_city_id
       FROM cities c
       JOIN flags seat ON seat.id=c.seat_flag_id
       WHERE c.active AND c.world_id=$1
         AND ($2::uuid IS NULL OR c.id > $2::uuid)
       ORDER BY c.id LIMIT $3`,
      [worldId, cursor, Math.min(PAGE_SIZE, maxCities + 1 - rows.length)]
    );
    rows.push(...page.rows);
    if (rows.length > maxCities) {
      throw new Error(`active city count exceeds bounded reconciliation limit ${maxCities}`);
    }
    if (page.rows.length < PAGE_SIZE) break;
    cursor = page.rows.at(-1)?.id ?? null;
  }
  return rows;
}

async function loadLockedCity(
  queryable: Queryable,
  cityId: string
): Promise<ActiveCityRow | null> {
  const result: { rows: ActiveCityRow[] } = await queryable.query(
    `SELECT c.id, c.world_id, c.canonical_municipality_id,
            c.world_settlement_id, c.world_settlement_source,
            c.world_source_settlement_id, c.settlement_class,
            c.settlement_release_id, c.settlement_release_fingerprint,
            c.settlement_founding_policy_id,
            c.settlement_founding_policy_fingerprint,
            c.settlement_resolution_policy_id,
            c.settlement_resolution_policy_fingerprint,
            c.name, c.country_code, c.region_code, c.spatial_revision,
            seat.id AS seat_flag_id, seat.lat AS seat_lat, seat.lon AS seat_lon,
            seat.control_type AS seat_control_type, seat.city_id AS seat_city_id
     FROM cities c JOIN flags seat ON seat.id=c.seat_flag_id
     WHERE c.id=$1 AND c.active
     FOR UPDATE OF c, seat`,
    [cityId]
  );
  return result.rows[0] ?? null;
}

async function updateCityAuthority(
  queryable: Queryable,
  cityId: string,
  state: CitySettlementAuthorityState
): Promise<CitySettlementAuthorityState> {
  const result = await queryable.query<ActiveCityRow>(
    `UPDATE cities SET
       canonical_municipality_id=$2, world_settlement_id=$3,
       world_settlement_source=$4, world_source_settlement_id=$5,
       settlement_class=$6, settlement_release_id=$7,
       settlement_release_fingerprint=$8, settlement_founding_policy_id=$9,
       settlement_founding_policy_fingerprint=$10,
       settlement_resolution_policy_id=$11,
       settlement_resolution_policy_fingerprint=$12,
       name=$13, country_code=$14, region_code=$15,
       spatial_revision=spatial_revision+1
     WHERE id=$1
     RETURNING id, world_id, canonical_municipality_id, world_settlement_id,
       world_settlement_source, world_source_settlement_id, settlement_class,
       settlement_release_id, settlement_release_fingerprint,
       settlement_founding_policy_id, settlement_founding_policy_fingerprint,
       settlement_resolution_policy_id, settlement_resolution_policy_fingerprint,
       name, country_code, region_code, spatial_revision,
       seat_flag_id, hall_lat AS seat_lat, hall_lon AS seat_lon,
       'city_seat'::text AS seat_control_type, id::text AS seat_city_id`,
    [
      cityId,
      state.canonicalMunicipalityId,
      state.worldSettlementId,
      state.worldSettlementSource,
      state.worldSourceSettlementId,
      state.settlementClass,
      state.settlementReleaseId,
      state.settlementReleaseFingerprint,
      state.settlementFoundingPolicyId,
      state.settlementFoundingPolicyFingerprint,
      state.settlementResolutionPolicyId,
      state.settlementResolutionPolicyFingerprint,
      state.name,
      state.countryCode,
      state.regionCode
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`city ${cityId} disappeared during reconciliation`);
  return authorityState(row);
}

function authorityState(row: ActiveCityRow): CitySettlementAuthorityState {
  return {
    canonicalMunicipalityId: row.canonical_municipality_id,
    worldSettlementId: row.world_settlement_id,
    worldSettlementSource: row.world_settlement_source,
    worldSourceSettlementId: row.world_source_settlement_id,
    settlementClass: row.settlement_class,
    settlementReleaseId: row.settlement_release_id,
    settlementReleaseFingerprint: row.settlement_release_fingerprint,
    settlementFoundingPolicyId: row.settlement_founding_policy_id,
    settlementFoundingPolicyFingerprint: row.settlement_founding_policy_fingerprint,
    settlementResolutionPolicyId: row.settlement_resolution_policy_id,
    settlementResolutionPolicyFingerprint: row.settlement_resolution_policy_fingerprint,
    name: row.name,
    countryCode: row.country_code,
    regionCode: row.region_code,
    spatialRevision: String(row.spatial_revision)
  };
}

function settlementState(
  settlement: WorldSettlement,
  spatialRevision: string
): CitySettlementAuthorityState {
  return {
    canonicalMunicipalityId: settlement.settlementId,
    worldSettlementId: settlement.settlementId,
    worldSettlementSource: settlement.source,
    worldSourceSettlementId: settlement.sourceSettlementId,
    settlementClass: settlement.settlementClass,
    settlementReleaseId: settlement.settlementReleaseId,
    settlementReleaseFingerprint: settlement.settlementReleaseFingerprint,
    settlementFoundingPolicyId: settlement.foundingPolicyId,
    settlementFoundingPolicyFingerprint: settlement.foundingPolicyFingerprint,
    settlementResolutionPolicyId: settlement.resolutionPolicyId,
    settlementResolutionPolicyFingerprint: settlement.resolutionPolicyFingerprint,
    name: settlement.name,
    countryCode: settlement.countryCode,
    regionCode: settlement.regionCode,
    spatialRevision
  };
}

function authorityMatches(
  observed: SettlementAuthorityIdentity,
  expected: SettlementAuthorityIdentity
): boolean {
  return Object.keys(expected).every(
    (key) => observed[key as keyof SettlementAuthorityIdentity] ===
      expected[key as keyof SettlementAuthorityIdentity]
  );
}

function sameAuthority(
  left: CitySettlementAuthorityState,
  right: CitySettlementAuthorityState
): boolean {
  return Object.entries(left).every(
    ([key, value]) => key === "spatialRevision" ||
      right[key as keyof CitySettlementAuthorityState] === value
  );
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown settlement lookup failure";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.NODE_ENV);
  const pool = createPool({ databaseUrl: config.DATABASE_URL });
  const world = new WorldLookupClient(config.WORLD_API_BASE, logger, config.WORLD_LOOKUP_TIMEOUT_MS);
  const authority: SettlementAuthorityIdentity =
    WORLD_RUNTIME_CONTRACT.settlementAuthority;
  try {
    if (args.reverseRunId) {
      const reversal = await reverseCitySettlementReconciliation(
        pool,
        args.reverseRunId,
        args.actor
      );
      console.log(JSON.stringify({ ok: true, mode: "reverse", reversal }, null, 2));
      return;
    }
    const plan = await planCitySettlementReconciliation({
      pool,
      lookupSettlement: (lat, lon) => world.lookupSettlement(lat, lon),
      worldId: config.WORLD_ID,
      authority
    });
    if (args.reportPath) {
      await writeFile(args.reportPath, JSON.stringify(plan, null, 2) + "\n", "utf8");
    }
    const application = args.apply
      ? await applyCitySettlementReconciliation(pool, plan, args.actor)
      : { applied: false, runId: null, changedCount: 0 };
    console.log(JSON.stringify({ ok: plan.ok, mode: args.apply ? "apply" : "dry-run", plan, application }, null, 2));
    if (!plan.ok) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

function parseArgs(argv: string[]): {
  apply: boolean;
  actor: string;
  reportPath: string | null;
  reverseRunId: string | null;
} {
  let apply = false;
  let actor = "";
  let reportPath: string | null = null;
  let reverseRunId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") apply = true;
    else if (value === "--actor") actor = argv[++index] ?? "";
    else if (value === "--report") reportPath = path.resolve(argv[++index] ?? "");
    else if (value === "--reverse-run") reverseRunId = argv[++index] ?? "";
    else throw new Error(`unknown reconciliation argument ${value}`);
  }
  if (apply && reverseRunId) throw new Error("--apply and --reverse-run are mutually exclusive");
  if ((apply || reverseRunId) && !actor.trim()) {
    throw new Error("mutation requires --actor");
  }
  return { apply, actor, reportPath, reverseRunId };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
