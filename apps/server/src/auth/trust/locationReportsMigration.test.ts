import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../../../../db/migrations/0881_location_reports.sql", import.meta.url)),
  "utf8"
);

describe("0881_location_reports migration", () => {
  it("creates both tables idempotently inside one transaction", () => {
    expect(migration).toMatch(/^BEGIN;/mu);
    expect(migration).toMatch(/COMMIT;\s*$/u);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS location_reports \(/u);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS account_location_state \(/u);
    expect(migration).not.toMatch(/CREATE INDEX (?!IF NOT EXISTS)/u);
  });

  it("enforces a unique server-assigned seq per account", () => {
    expect(migration).toMatch(/seq bigint NOT NULL CHECK \(seq > 0\)/u);
    expect(migration).toMatch(/UNIQUE \(account_id, seq\)/u);
    expect(migration).toMatch(/last_seq bigint NOT NULL DEFAULT 0/u);
  });

  it("references existing tables and keeps retention deletes cheap", () => {
    expect(migration).toMatch(/REFERENCES device_installations\(id\) ON DELETE SET NULL/u);
    expect(migration).toMatch(/prev_report_id uuid NULL REFERENCES location_reports\(id\) ON DELETE SET NULL/u);
    expect(migration).toMatch(/ON location_reports \(prev_report_id\)/u);
    expect(migration).toMatch(/ON account_location_state \(last_accepted_report_id\)/u);
  });
});

describe("0882/0883 trust migrations", () => {
  const read = (name: string) => readFileSync(
    fileURLToPath(new URL(`../../../../../db/migrations/${name}`, import.meta.url)),
    "utf8"
  );

  it("creates account_regions and the trust state tables idempotently", () => {
    expect(read("0882_account_regions.sql")).toMatch(/CREATE TABLE IF NOT EXISTS account_regions \(/u);
    const trust = read("0883_account_trust_state.sql");
    expect(trust).toMatch(/CREATE TABLE IF NOT EXISTS account_trust_state \(/u);
    expect(trust).toMatch(/CREATE TABLE IF NOT EXISTS account_trust_events \(/u);
    expect(trust).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/u);
    expect(trust).toMatch(/UNIQUE INDEX IF NOT EXISTS account_trust_events_dedupe_idx\s+ON account_trust_events \(dedupe_key\) WHERE dedupe_key IS NOT NULL/u);
    expect(trust).toMatch(/enforcement_tier smallint NOT NULL DEFAULT 0/u);
  });
});
