import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(
  fileURLToPath(new URL(`../../../../../db/migrations/${name}`, import.meta.url)),
  "utf8"
);

const ASSURANCES = "('attested', 'device_checked', 'unverified', 'native_legacy', 'web', 'flagged')";

describe("0915_device_attestation migration", () => {
  const migration = read("0915_device_attestation.sql");

  it("is one idempotent transaction", () => {
    expect(migration).toMatch(/^BEGIN;/mu);
    expect(migration).toMatch(/COMMIT;\s*$/u);
    expect(migration).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/u);
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/u);
    expect(migration).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/u);
  });

  it("creates the attestation tables with replay guards and bounded verdicts", () => {
    for (const table of ["attestation_challenges", "app_attest_keys", "device_attestations"]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    expect(migration).toMatch(/challenge bytea NOT NULL CHECK \(octet_length\(challenge\) = 32\)/u);
    expect(migration).toMatch(/token_hash text NULL UNIQUE/u);
    expect(migration).toMatch(/ref_hash text NOT NULL UNIQUE/u);
    expect(migration).toMatch(/pg_column_size\(verdict\) <= 8192/u);
    expect(migration).toMatch(/outcome text NOT NULL CHECK \(outcome IN \('pass', 'fail', 'unavailable'\)\)/u);
  });

  it("adds per-fix assurance to reports and location state with one shared value set", () => {
    expect(migration).toMatch(/ALTER TABLE location_reports\s+ADD COLUMN IF NOT EXISTS attestation_id uuid NULL/u);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS assurance text NULL/u);
    expect(migration).toMatch(/ALTER TABLE account_location_state\s+ADD COLUMN IF NOT EXISTS last_fix_assurance text NULL/u);
    expect(migration.split(ASSURANCES).length - 1).toBe(3);
  });
});

describe("0916_settled_and_alert_zones migration", () => {
  const migration = read("0916_settled_and_alert_zones.sql");

  it("is one idempotent transaction", () => {
    expect(migration).toMatch(/^BEGIN;/mu);
    expect(migration).toMatch(/COMMIT;\s*$/u);
    expect(migration).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/u);
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/u);
    expect(migration).toMatch(/ON CONFLICT \(account_id\) DO NOTHING;/u);
  });

  it("stores day counts as an integer, never an array that could overflow", () => {
    expect(migration).toMatch(/counted_days integer NOT NULL DEFAULT 0/u);
    expect(migration).toMatch(/last_counted_day date NULL/u);
    expect(migration).not.toMatch(/date\[\]/u);
    expect(migration).toMatch(/distinct_positions integer NOT NULL DEFAULT 0 CHECK \(distinct_positions BETWEEN 0 AND 10\)/u);
  });

  it("allows one pending red alert per account", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS trust_alerts_one_pending_red_idx\s+ON trust_alerts \(account_id\) WHERE kind = 'zone_red' AND status = 'pending'/u
    );
  });

  it("grandfathers only earned or blanket-confirmed accounts without spoof signals", () => {
    expect(migration).toMatch(/e\.rule IN \('speed_impossible', 'location_mock', 'relocation_mock'\)/u);
    expect(migration).toMatch(/a\.status <> 'deleted'/u);
    expect(migration).toMatch(/now\(\) \+ interval '30 days'/u);
    expect(migration).toMatch(/22 \+ floor\(random\(\) \* 9\)::int/u);
    expect(migration).toMatch(/4 \+ floor\(random\(\) \* 3\)::int/u);
  });
});
