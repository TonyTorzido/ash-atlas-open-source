import pg from "pg";

const { Pool } = pg;
const REPORT_CODE = /^AA-[A-Z0-9]{6}$/u;
const STATUSES = new Set([
  "new", "triaged", "investigating", "resolved", "duplicate", "cannot_reproduce"
]);

async function main(): Promise<void> {
  const [command = "", reportCode = "", value = ""] = process.argv.slice(2);
  const databaseUrl = process.env.TELEMETRY_OPERATOR_DATABASE_URL;
  if (!databaseUrl) throw new Error("TELEMETRY_OPERATOR_DATABASE_URL is required");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 10_000,
    application_name: "ash-atlas-bug-reports-cli"
  });
  try {
    if (command === "list") await listReports(pool);
    else if (command === "show") await showReport(pool, validCode(reportCode));
    else if (command === "export") await exportReport(pool, validCode(reportCode));
    else if (command === "status") {
      if (!STATUSES.has(value) || value === "duplicate") {
        throw new Error("status must be new, triaged, investigating, resolved, or cannot_reproduce");
      }
      await setStatus(pool, validCode(reportCode), value);
    } else if (command === "duplicate") {
      await markDuplicate(pool, validCode(reportCode), validCode(value));
    } else if (command === "resolve") {
      await setStatus(pool, validCode(reportCode), "resolved");
    } else {
      throw new Error(usage());
    }
  } finally {
    await pool.end();
  }
}

async function listReports(pool: pg.Pool): Promise<void> {
  const result = await pool.query(
    `SELECT public_report_code, submitted_at, title, category, reproducibility,
            status, release_generation, export_status
       FROM telemetry.bug_reports
      ORDER BY submitted_at DESC
      LIMIT 100`
  );
  print(result.rows);
}

async function showReport(pool: pg.Pool, code: string): Promise<void> {
  const report = await loadReport(pool, code);
  const context = report.context as Record<string, unknown>;
  const timeline = [
    ...timelineEntries(context.recent_client_actions, "action"),
    ...timelineEntries(context.recent_client_errors, "error"),
    ...timelineEntries(context.network_timeline, "network"),
    ...timelineEntries(context.performance_history, "performance")
  ].sort((left, right) => left.timestamp - right.timestamp);
  print({
    report: reportSummary(report),
    authoritativePlayerState: context.authoritative_player_state,
    nearbyEntities: context.nearby_entities,
    relatedOperationIds: context.related_operation_ids,
    relatedEventIds: context.related_event_ids,
    timeline
  });
}

async function exportReport(pool: pg.Pool, code: string): Promise<void> {
  const report = await loadReport(pool, code);
  print({
    report: reportSummary(report),
    context: report.context
  });
}

async function setStatus(pool: pg.Pool, code: string, status: string): Promise<void> {
  const result = await pool.query(
    `UPDATE telemetry.bug_reports
        SET status=$2, duplicate_of_report_id=NULL, updated_at=clock_timestamp()
      WHERE public_report_code=$1
      RETURNING public_report_code, status, updated_at`,
    [code, status]
  );
  if (result.rowCount !== 1) throw new Error(`report not found: ${code}`);
  print(result.rows[0]);
}

async function markDuplicate(
  pool: pg.Pool,
  code: string,
  canonicalCode: string
): Promise<void> {
  if (code === canonicalCode) throw new Error("a report cannot duplicate itself");
  const result = await pool.query(
    `UPDATE telemetry.bug_reports AS report
        SET status='duplicate',
            duplicate_of_report_id=canonical.report_id,
            updated_at=clock_timestamp()
       FROM telemetry.bug_reports AS canonical
      WHERE report.public_report_code=$1
        AND canonical.public_report_code=$2
      RETURNING report.public_report_code, report.status,
                canonical.public_report_code AS duplicate_of`,
    [code, canonicalCode]
  );
  if (result.rowCount !== 1) throw new Error("report or canonical report was not found");
  print(result.rows[0]);
}

async function loadReport(
  pool: pg.Pool,
  code: string
): Promise<Record<string, unknown> & { context: Record<string, unknown> }> {
  const result = await pool.query(
    `SELECT report.*,
            jsonb_build_object(
              'client_state',context.client_state,
              'authoritative_player_state',context.authoritative_player_state,
              'nearby_entities',context.nearby_entities,
              'recent_client_actions',context.recent_client_actions,
              'recent_client_errors',context.recent_client_errors,
              'network_timeline',context.network_timeline,
              'performance_history',context.performance_history,
              'related_operation_ids',to_jsonb(context.related_operation_ids),
              'related_event_ids',to_jsonb(context.related_event_ids),
              'content_checksum',context.content_checksum
            ) AS context
       FROM telemetry.bug_reports AS report
       JOIN telemetry.bug_report_context AS context USING (report_id)
      WHERE report.public_report_code=$1`,
    [code]
  );
  if (result.rowCount !== 1) throw new Error(`report not found: ${code}`);
  return result.rows[0] as Record<string, unknown> & {
    context: Record<string, unknown>;
  };
}

function reportSummary(report: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "public_report_code", "submitted_at", "report_marker_at",
    "available_window_start_at", "window_start_at", "window_end_at",
    "title", "category", "description", "expected_behavior",
    "reproducibility", "status", "release_sha", "release_generation",
    "world_release_id", "population_plan_version",
    "population_spawn_rules_version", "balance_version", "related_segment_ids",
    "export_status", "exported_at", "acknowledged_at"
  ];
  return Object.fromEntries(keys.map((key) => [key, report[key]]));
}

function timelineEntries(
  value: unknown,
  kind: string
): Array<{ timestamp: number; kind: string; detail: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((detail) => {
    if (!detail || typeof detail !== "object") return [];
    const timestamp = (detail as Record<string, unknown>).timestamp;
    return typeof timestamp === "number" ? [{ timestamp, kind, detail }] : [];
  });
}

function validCode(value: string): string {
  if (!REPORT_CODE.test(value)) throw new Error("report code must match AA-XXXXXX");
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return [
    "usage:",
    "  bug-reports list",
    "  bug-reports show AA-XXXXXX",
    "  bug-reports export AA-XXXXXX",
    "  bug-reports status AA-XXXXXX investigating",
    "  bug-reports duplicate AA-XXXXXX AA-CANON1",
    "  bug-reports resolve AA-XXXXXX"
  ].join("\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
