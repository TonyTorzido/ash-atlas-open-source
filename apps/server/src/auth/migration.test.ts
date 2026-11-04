import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../../../db/migrations/0010_google_accounts.sql", import.meta.url)
);
const migration = readFileSync(migrationPath, "utf8");
const hardeningMigration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0011_auth_security_hardening.sql", import.meta.url)
  ),
  "utf8"
);
const closedTestMigration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0680_closed_test_access_onboarding.sql", import.meta.url)
  ),
  "utf8"
);
const accessModeMigration = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/0740_persistent_test_access_mode.sql", import.meta.url)
  ),
  "utf8"
);

describe("0010_google_accounts migration", () => {
  it.each([
    "accounts",
    "account_identities",
    "auth_sessions",
    "device_installations",
    "account_device_links",
    "auth_events",
    "account_risk_events"
  ])("creates the %s table", (table) => {
    expect(migration).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  });

  it("enforces identity, player, status, trust, and risk invariants", () => {
    expect(migration).toContain("UNIQUE (provider, provider_subject)");
    expect(migration).toContain("CHECK (provider = 'google')");
    expect(migration).toContain("CHECK (status IN ('active', 'suspended', 'deleted'))");
    expect(migration).toContain("CHECK (trust_tier IN ('new', 'standard', 'trusted', 'restricted'))");
    expect(migration).toContain("CHECK (risk_score BETWEEN 0 AND 100)");
    expect(migration).toContain("players_account_id_unique_idx");
    expect(migration).toContain("players_username_normalized_unique_idx");
  });

  it("stores token and network hashes without raw credential columns", () => {
    expect(migration).toContain("token_hash text NOT NULL UNIQUE");
    expect(migration).toContain("network_prefix_hash text NULL");
    expect(migration).not.toMatch(/access_token|refresh_token|google_id_token|raw_ip/i);
    expect(migration).not.toMatch(
      /mac_address|disk_serial|cpu_serial|gpu_identifier|canvas_fingerprint|audio_fingerprint|font_list|battery_information|webgl_fingerprint/i
    );
  });
});

describe("0011_auth_security_hardening migration", () => {
  it("linearizes session creation, logout-all, and account disabling", () => {
    expect(hardeningMigration).toContain("session_version bigint NOT NULL DEFAULT 0");
    expect(hardeningMigration).toContain("account_session_version bigint NOT NULL DEFAULT 0");
    expect(hardeningMigration).toContain("revoke_sessions_when_account_disabled");
    expect(hardeningMigration).toContain("UPDATE auth_sessions");
  });

  it("stores only bounded credential hashes and bounded telemetry metadata", () => {
    expect(hardeningMigration).toContain("auth_google_credential_uses");
    expect(hardeningMigration).toContain("credential_hash text PRIMARY KEY");
    expect(hardeningMigration).toContain("pg_column_size(metadata) <= 16384");
    expect(hardeningMigration).not.toMatch(/credential\s+text|google_id_token|access_token|refresh_token/i);
  });
});

describe("0680_closed_test_access_onboarding migration", () => {
  it("backfills existing accounts without changing original creation time", () => {
    expect(closedTestMigration).toContain("test_access_status = 'approved'");
    expect(closedTestMigration).toContain("test_access_requested_at = created_at");
    expect(closedTestMigration).toContain(
      "0680 closed-test existing accounts backfilled approved"
    );
    expect(closedTestMigration).not.toMatch(/SET\s+created_at\s*=/u);
  });

  it("keeps new accounts pending and indexes access and verified-email lookups", () => {
    expect(closedTestMigration).toContain(
      "ALTER COLUMN test_access_status SET DEFAULT 'pending'"
    );
    expect(closedTestMigration).toContain("accounts_test_access_pending_idx");
    expect(closedTestMigration).toContain("account_identities_verified_email_idx");
    expect(closedTestMigration).toContain("test_access_email_grants_email_unique");
  });

  it("preserves legacy spawns and reports incompatible legacy names", () => {
    expect(closedTestMigration).toContain(
      "initial_spawn_latitude = COALESCE(initial_spawn_latitude, lat)"
    );
    expect(closedTestMigration).toContain(
      "initial_spawn_longitude = COALESCE(initial_spawn_longitude, lon)"
    );
    expect(closedTestMigration).toContain("legacy names retained outside new-name rules");
  });

  it("reserves black from personal flags while leaving city control rows untouched", () => {
    expect(closedTestMigration).toContain("flags_personal_color_not_black");
    expect(closedTestMigration).toContain("flag.control_type = 'personal'");
    expect(closedTestMigration).not.toMatch(
      /WHERE\s+flag\.control_type\s+IN\s*\([^)]*city/iu
    );
  });
});

describe("0740_persistent_test_access_mode migration", () => {
  it("creates one constrained durable mode that defaults closed", () => {
    expect(accessModeMigration).toContain("singleton boolean PRIMARY KEY");
    expect(accessModeMigration).toContain("access_mode text NOT NULL DEFAULT 'closed'");
    expect(accessModeMigration).toContain("CHECK (access_mode IN ('open', 'closed'))");
    expect(accessModeMigration).toContain("VALUES (true, 'closed')");
  });

  it("adds mode changes to the existing durable test-access audit log", () => {
    expect(accessModeMigration).toContain("access_mode_changed");
    expect(accessModeMigration).toContain("test_access_events_event_type_check");
  });
});
