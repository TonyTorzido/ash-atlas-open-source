import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../../db/migrations/0688_private_bug_reports.sql", import.meta.url),
  "utf8"
);
const exporter = readFileSync(
  new URL("../../../../tools/release/vps/export-closed-test-telemetry.sh", import.meta.url),
  "utf8"
);
const retention = readFileSync(
  new URL("../../../../tools/release/vps/retain-telemetry-segments.sh", import.meta.url),
  "utf8"
);

describe("private bug report storage architecture", () => {
  it("enforces bounded one-to-one durable context and lifecycle constraints", () => {
    expect(migration).toContain("CREATE TABLE telemetry.bug_reports");
    expect(migration).toContain("CREATE TABLE telemetry.bug_report_context");
    expect(migration).toContain("PRIMARY KEY REFERENCES telemetry.bug_reports");
    expect(migration).toContain("jsonb_array_length(nearby_entities) <= 200");
    expect(migration).toContain("compressed_bytes BETWEEN 2 AND 500000");
    expect(migration).toContain("UNIQUE (player_id, request_id)");
    expect(migration).toContain("export_status = 'acknowledged'");
  });

  it("exports both tables and never deletes the durable report context in retention", () => {
    expect(exporter).toContain("CREATE TABLE bug_reports");
    expect(exporter).toContain("CREATE TABLE bug_report_context");
    expect(exporter).toContain("CAST(report.player_id AS VARCHAR)");
    expect(exporter).toContain("list_transform(");
    expect(exporter).toContain("operation_id -> pseudonym(operation_id)");
    expect(exporter).toContain("row-count verification failed for $table");
    expect(retention).toContain("UPDATE telemetry.bug_reports");
    expect(retention).not.toMatch(/DELETE FROM telemetry\.bug_reports/);
    expect(retention).not.toMatch(/DELETE FROM telemetry\.bug_report_context/);
  });
});
