import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  POPULATION_CANDIDATE_LAYOUT_VERSION,
  POPULATION_PLAN_VERSION,
  POPULATION_SPAWN_RULES_VERSION,
  POPULATION_STONE_PLACEMENT_VERSION
} from "../game/populationZonesV2Identity.js";

const { Pool } = pg;
const TELEMETRY_SCHEMA_VERSION = 1;

type Arguments = Readonly<{
  command: string;
  values: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
}>;

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "export") {
    await runExport(args);
    return;
  }
  const databaseUrl = requiredEnvironment("TELEMETRY_OPERATOR_DATABASE_URL");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 10_000,
    application_name: "ash-atlas-telemetry-cli"
  });
  try {
    if (args.command === "start") await startRun(pool, args);
    else if (args.command === "freeze") await freezeRun(pool, args);
    else if (args.command === "status") await printStatus(pool);
    else if (args.command === "retention") await applyRetention(pool, args);
    else throw new Error(usage());
  } finally {
    await pool.end();
  }
}

async function startRun(pool: pg.Pool, args: Arguments): Promise<void> {
  const releaseSha = valueOrEnvironment(args, "release-sha", "RUNTIME_SHA");
  if (!/^[a-f0-9]{40}$/u.test(releaseSha)) {
    throw new Error("--release-sha or RUNTIME_SHA must be an exact 40-character lowercase SHA");
  }
  const releaseGeneration =
    optionalValueOrEnvironment(args, "release-generation", "TELEMETRY_RELEASE_GENERATION");
  if (releaseGeneration && !/^test\/t[0-9]+$/u.test(releaseGeneration)) {
    throw new Error("release generation must match test/tNNN[N]");
  }
  const runId = randomUUID();
  const segmented = !args.flags.has("unsegmented");
  const segmentId = segmented ? randomUUID() : null;
  const campaignId = segmented
    ? args.values.get("campaign-id") ?? randomUUID()
    : null;
  if (campaignId && !isUuid(campaignId)) {
    throw new Error("--campaign-id must be a UUID");
  }
  const segmentDurationMs = segmented
    ? integerEnvironment(
        "TELEMETRY_SEGMENT_DURATION_MS",
        3_600_000,
        60_000,
        86_400_000
      )
    : null;
  if (segmentDurationMs !== null && segmentDurationMs % 1_000 !== 0) {
    throw new Error("TELEMETRY_SEGMENT_DURATION_MS must be a whole number of seconds");
  }
  const segmentDurationSeconds =
    segmentDurationMs === null ? null : segmentDurationMs / 1_000;
  const runName = requiredValue(args, "name");
  const worldReleaseId = valueOrEnvironment(
    args,
    "world-release-id",
    "WORLD_REQUIRED_RELEASE_ID"
  );
  const balanceVersion =
    optionalValueOrEnvironment(args, "balance-version", "TELEMETRY_BALANCE_VERSION")
    ?? "balance-v1";
  const serverInstanceId =
    optionalValueOrEnvironment(args, "server-instance-id", "RUNTIME_LABEL")
    ?? "ash-atlas";
  const capacityConfiguration = optionalJsonValue(args, "capacity", {});
  const notes = args.values.get("notes") ?? "";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const active = await client.query<{ run_id: string }>(
      "SELECT run_id FROM telemetry.test_runs WHERE status='active' FOR UPDATE"
    );
    if (active.rowCount) {
      throw new Error(`active telemetry run already exists: ${active.rows[0]!.run_id}`);
    }
    const inserted = await client.query<{
      segment_id: string | null;
      campaign_id: string | null;
      segment_sequence: string | number | null;
      segment_start_at: Date | null;
      segment_end_at: Date | null;
    }>(
      `INSERT INTO telemetry.test_runs (
         run_id, telemetry_schema_version, run_name, started_at, status,
         release_sha, release_generation, world_release_id,
         population_plan_version, population_spawn_rules_version,
         population_candidate_layout_version, permanent_stone_placement_version,
         balance_version, server_instance_id, capacity_configuration,
         reset_wipe_marker, notes, segment_id, campaign_id, segment_sequence,
         segment_start_at, segment_end_at, segment_duration_seconds
       ) VALUES (
         $1,$2,$3,clock_timestamp(),'active',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16,$17,CASE WHEN $16::uuid IS NULL THEN NULL ELSE 0 END,
         CASE WHEN $16::uuid IS NULL THEN NULL
              ELSE clock_timestamp()
         END,
         CASE WHEN $16::uuid IS NULL THEN NULL
              ELSE to_timestamp((floor(extract(epoch FROM clock_timestamp()) / $18::integer) + 1) * $18::integer)
         END,
         $18
       )
       RETURNING segment_id, campaign_id, segment_sequence,
                 segment_start_at, segment_end_at`,
      [
        runId,
        TELEMETRY_SCHEMA_VERSION,
        runName,
        releaseSha,
        releaseGeneration,
        worldReleaseId,
        POPULATION_PLAN_VERSION,
        POPULATION_SPAWN_RULES_VERSION,
        POPULATION_CANDIDATE_LAYOUT_VERSION,
        POPULATION_STONE_PLACEMENT_VERSION,
        balanceVersion,
        serverInstanceId,
        capacityConfiguration,
        args.flags.has("reset-wipe"),
        notes,
        segmentId,
        campaignId,
        segmentDurationSeconds
      ]
    );
    await client.query("COMMIT");
    printJson({
      command: "start",
      runId,
      status: "active",
      releaseSha,
      releaseGeneration,
      worldReleaseId,
      resetWipeMarker: args.flags.has("reset-wipe"),
      segment: inserted.rows[0] ?? null
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function freezeRun(pool: pg.Pool, args: Arguments): Promise<void> {
  const runId = args.values.get("run-id") ?? null;
  const result = await pool.query<{
    run_id: string;
    release_sha: string;
    release_generation: string | null;
  }>(
    `UPDATE telemetry.test_runs
     SET status='frozen', ended_at=clock_timestamp(), updated_at=clock_timestamp()
     WHERE status='active' AND ($1::uuid IS NULL OR run_id=$1)
     RETURNING run_id, release_sha, release_generation`,
    [runId]
  );
  if (result.rowCount !== 1) {
    throw new Error("no matching active telemetry run was frozen");
  }
  printJson({ command: "freeze", status: "frozen", ...result.rows[0] });
}

async function printStatus(pool: pg.Pool): Promise<void> {
  const [runs, health, sizes, rate, latestExport, acknowledgments, retention] =
    await Promise.all([
    pool.query(
      `SELECT run_id, run_name, status, started_at, ended_at, release_sha,
              release_generation, world_release_id, export_status,
              protected_from_retention, ingestion_closed_at, segment_id,
              campaign_id, segment_sequence, segment_start_at, segment_end_at,
              retention_status, retention_deleted_at
       FROM telemetry.test_runs
       ORDER BY started_at DESC LIMIT 20`
    ),
    pool.query(
      `SELECT server_instance_id, run_id, recorded_at, enabled, degraded,
              queue_depth_critical, queue_depth_important, queue_depth_routine,
              last_successful_flush_at, rows_flushed, rows_dropped,
              rows_dropped_by_event_type,
              last_database_error_at, last_database_error,
              telemetry_pool_total, telemetry_pool_idle, telemetry_pool_waiting,
              consecutive_write_failures, host_sampler_last_seen_at, disk_free_bytes
       FROM telemetry.telemetry_health ORDER BY server_instance_id`
    ),
    pool.query<{ relation: string; bytes: string }>(
      `SELECT relname AS relation,
              pg_total_relation_size(relid)::text AS bytes
       FROM pg_stat_user_tables
       WHERE schemaname='telemetry'
       ORDER BY pg_total_relation_size(relid) DESC`
    ),
    pool.query(
      `SELECT
         count(*) FILTER (WHERE recorded_at >= now()-interval '5 minutes') AS rows_5m,
         max(recorded_at) AS newest_sample_at
       FROM telemetry.server_samples`
    ),
    pool.query(
      `SELECT receipt_id, run_id, recorded_at, export_path, artifact_format,
              pseudonymized, sha256, artifact_bytes, verification_status,
              verified_at
       FROM telemetry.export_receipts
       ORDER BY recorded_at DESC LIMIT 1`
    ),
    pool.query(
      `SELECT segment_id, run_id, artifact_sha256, acknowledged_at, received_at
       FROM telemetry.segment_acknowledgments
       ORDER BY received_at DESC LIMIT 20`
    ),
    pool.query(
      `SELECT segment_id, run_id, acknowledged, deleted_row_counts,
              deleted_artifact_bytes, deletion_reason, archival_data_lost,
              cleaned_at
       FROM telemetry.segment_retention_receipts
       ORDER BY cleaned_at DESC LIMIT 20`
    )
  ]);
  printJson({
    generatedAt: new Date().toISOString(),
    runs: runs.rows,
    health: health.rows,
    relationSizes: sizes.rows,
    recentServerSamples: rate.rows[0] ?? null,
    latestExport: latestExport.rows[0] ?? null,
    acknowledgments: acknowledgments.rows,
    segmentRetention: retention.rows
  });
}

async function applyRetention(pool: pg.Pool, args: Arguments): Promise<void> {
  const apply = args.flags.has("apply");
  const batchSize = Math.min(
    10_000,
    Math.max(1, Number(args.values.get("batch-size") ?? "1000"))
  );
  if (!Number.isSafeInteger(batchSize)) throw new Error("batch size must be an integer");
  const policies = retentionPolicies();
  const counts: Record<string, number> = {};
  for (const policy of policies) {
    if (!apply) {
      const preview = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM telemetry.${policy.table} AS sample
         JOIN telemetry.test_runs AS run ON run.run_id=sample.run_id
         WHERE sample.${policy.timestamp} < now()-($1::text||' days')::interval
           AND run.status IN ('frozen','exported','failed')
           AND run.export_status='verified'
           AND NOT run.protected_from_retention`,
        [policy.days]
      );
      counts[policy.table] = Number(preview.rows[0]?.count ?? 0);
      continue;
    }
    let deleted = 0;
    for (;;) {
      const client = await pool.connect();
      let batchDeleted = 0;
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `DELETE FROM telemetry.${policy.table}
           WHERE ctid IN (
             SELECT sample.ctid
             FROM telemetry.${policy.table} AS sample
             JOIN telemetry.test_runs AS run ON run.run_id=sample.run_id
             WHERE sample.${policy.timestamp} < now()-($1::text||' days')::interval
               AND run.status IN ('frozen','exported','failed')
               AND run.export_status='verified'
               AND NOT run.protected_from_retention
             LIMIT $2
           )`,
          [policy.days, batchSize]
        );
        batchDeleted = result.rowCount ?? 0;
        if (batchDeleted > 0) {
          await writeCleanupReceipt(client, policy, batchSize, batchDeleted);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      deleted += batchDeleted;
      if (batchDeleted < batchSize) break;
    }
    counts[policy.table] = deleted;
  }
  printJson({
    command: "retention",
    mode: apply ? "applied" : "preview",
    batchSize,
    affectedRows: counts
  });
}

type RetentionPolicy = Readonly<{
  table:
    | "server_samples"
    | "world_samples"
    | "client_samples"
    | "gameplay_events"
    | "player_snapshots"
    | "player_inventory_snapshots";
  timestamp: "recorded_at" | "event_time";
  days: number;
}>;

function retentionPolicies(): readonly RetentionPolicy[] {
  return [
    {
      table: "server_samples",
      timestamp: "recorded_at",
      days: retentionDays("TELEMETRY_RETENTION_SERVER_DAYS", 60)
    },
    {
      table: "world_samples",
      timestamp: "recorded_at",
      days: retentionDays("TELEMETRY_RETENTION_WORLD_DAYS", 60)
    },
    {
      table: "client_samples",
      timestamp: "recorded_at",
      days: retentionDays("TELEMETRY_RETENTION_CLIENT_DAYS", 30)
    },
    {
      table: "gameplay_events",
      timestamp: "event_time",
      days: retentionDays("TELEMETRY_RETENTION_GAMEPLAY_DAYS", 90)
    },
    {
      table: "player_snapshots",
      timestamp: "recorded_at",
      days: retentionDays("TELEMETRY_RETENTION_PLAYER_DAYS", 90)
    },
    {
      table: "player_inventory_snapshots",
      timestamp: "recorded_at",
      days: retentionDays("TELEMETRY_RETENTION_INVENTORY_DAYS", 90)
    }
  ];
}

function retentionDays(environmentName: string, fallback: number): number {
  const days = Number(process.env[environmentName] ?? fallback);
  if (!Number.isSafeInteger(days) || days <= 0 || days > 3_650) {
    throw new Error(`${environmentName} must be an integer between 1 and 3650`);
  }
  return days;
}

async function writeCleanupReceipt(
  client: pg.PoolClient,
  policy: RetentionPolicy,
  batchSize: number,
  deletedRows: number
): Promise<void> {
  await client.query(
    `INSERT INTO telemetry.cleanup_receipts (
       receipt_id, telemetry_schema_version, run_id, release_sha,
       release_generation, world_release_id, population_plan_version,
       population_spawn_rules_version, balance_version, server_instance_id,
       recorded_at, retention_policy, deleted_row_counts, protected_runs_skipped
     ) VALUES (
       $1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,clock_timestamp(),$10,$11,
       ARRAY(SELECT run_id FROM telemetry.test_runs WHERE protected_from_retention)
     )`,
    [
      randomUUID(),
      TELEMETRY_SCHEMA_VERSION,
      requiredEnvironment("RUNTIME_SHA"),
      process.env.TELEMETRY_RELEASE_GENERATION ?? null,
      requiredEnvironment("WORLD_REQUIRED_RELEASE_ID"),
      POPULATION_PLAN_VERSION,
      POPULATION_SPAWN_RULES_VERSION,
      process.env.TELEMETRY_BALANCE_VERSION ?? "balance-v1",
      process.env.RUNTIME_LABEL ?? "ash-atlas-telemetry-retention",
      JSON.stringify({ ...policy, batchSize }),
      JSON.stringify({ [policy.table]: deletedRows })
    ]
  );
}

async function runExport(args: Arguments): Promise<void> {
  if (process.env.TELEMETRY_EXPORT_ENABLED !== "true") {
    throw new Error("TELEMETRY_EXPORT_ENABLED=true is required to export");
  }
  const runId = requiredValue(args, "run-id");
  const format = args.flags.has("parquet") ? "parquet" : "duckdb";
  const script = process.env.TELEMETRY_EXPORT_SCRIPT
    ?? resolveBundledExportScript();
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("bash", [script, "--run-id", runId, "--format", format], {
      stdio: "inherit",
      env: process.env
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`telemetry export failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function resolveBundledExportScript(): string {
  const relativePath = "tools/release/vps/export-closed-test-telemetry.sh";
  const candidates = [
    resolve(process.cwd(), relativePath),
    resolve(process.cwd(), "../..", relativePath),
    fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url)),
    fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url))
  ];
  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) {
    throw new Error(
      "telemetry export script was not found; set TELEMETRY_EXPORT_SCRIPT"
    );
  }
  return script;
}

function parseArguments(argv: readonly string[]): Arguments {
  const [command = "", ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) flags.add(key);
    else {
      values.set(key, next);
      index += 1;
    }
  }
  return { command, values, flags };
}

function requiredValue(args: Arguments, key: string): string {
  const value = args.values.get(key)?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function valueOrEnvironment(args: Arguments, key: string, environment: string): string {
  return args.values.get(key)?.trim() || requiredEnvironment(environment);
}

function optionalValueOrEnvironment(
  args: Arguments,
  key: string,
  environment: string
): string | null {
  return args.values.get(key)?.trim() || process.env[environment]?.trim() || null;
}

function optionalJsonValue(
  args: Arguments,
  key: string,
  fallback: Record<string, unknown>
): Record<string, unknown> {
  const value = args.values.get(key);
  if (!value) return fallback;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`--${key} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    .test(value);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return [
    "Usage:",
    "  telemetry-cli start --name NAME [--campaign-id UUID] [--unsegmented] [--release-sha SHA] [--release-generation test/tNNN[N]] [--reset-wipe]",
    "  telemetry-cli freeze [--run-id UUID]",
    "  telemetry-cli status",
    "  telemetry-cli export --run-id UUID [--parquet]",
    "  telemetry-cli retention [--apply] [--batch-size 1000]"
  ].join("\n");
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
