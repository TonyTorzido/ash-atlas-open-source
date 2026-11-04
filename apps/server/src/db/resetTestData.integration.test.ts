import { randomUUID } from "node:crypto";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig, type AppConfig } from "../config.js";
import { AuthService } from "../auth/authService.js";
import { PostgresAuthStore } from "../auth/authStore.js";
import { FakeGoogleIdentityVerifier } from "../auth/googleIdentity.js";
import { InitialSpawnSampler } from "../auth/initialSpawn.js";
import { OnboardingService } from "../auth/onboardingService.js";
import type {
  LoginRequestContext,
  VerifiedGoogleIdentity
} from "../auth/types.js";
import { PetService } from "../game/petService.js";
import { PremiumWalletService } from "../game/premiumWallet.js";
import {
  generatePopulationZoneV2Plan,
  populationZoneV3ConservativeHabitat
} from "../game/populationZonesV2Plan.js";
import {
  populationZoneV2Halo,
  populationZoneV2IdForPoint
} from "../game/populationZonesV2Geometry.js";
import {
  populationZoneV2PlanRequest,
  PostgresPopulationZonesV2Store
} from "../game/populationZonesV2Store.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import { runMigrations } from "./migrate.js";
import {
  RESET_ADVISORY_LOCK,
  executeReset,
  resetManifest
} from "./resetTestData.js";

const databaseUrl = testDatabaseUrl(process.env.RESET_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;
const APPROVED_ACCOUNT = "10000000-0000-4000-8000-000000000001";
const SECOND_APPROVED_ACCOUNT = "10000000-0000-4000-8000-000000000002";
const ADMIN_ACCOUNT = "10000000-0000-4000-8000-000000000003";
const PENDING_ACCOUNT = "10000000-0000-4000-8000-000000000004";
const DENIED_ACCOUNT = "10000000-0000-4000-8000-000000000005";
const REVOKED_ACCOUNT = "10000000-0000-4000-8000-000000000006";
const RESET_RELEASE_SHA = "a".repeat(40);
const PLAYER_A = "reset-player-a";
const PLAYER_B = "reset-player-b";
const BUG_REPORT_RUN = "00000000-0000-4000-8000-000000000701";
const BUG_REPORT_ID = "00000000-0000-4000-8000-000000000702";

describeDatabase("test-server gameplay reset PostgreSQL safety", () => {
  let pool: pg.Pool;
  let migrationsDirectory: string;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 5 });
    migrationsDirectory = path.resolve(process.cwd(), "../../db/migrations");
    await seedBugReportState(pool);
    await seedProtectedAndGameplayState(pool);
    await seedRetainedContent(pool);
    await seedPopulationPermanentStoneState(pool, true);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("aborts for an unknown table before changing gameplay", async () => {
    await pool.query("CREATE TABLE future_reset_state (id integer PRIMARY KEY)");
    const createBackup = vi.fn(async () => "must-not-be-created.dump");
    try {
      await expect(run(false, createBackup)).rejects.toThrow(
        /unclassified public tables/
      );
      expect(createBackup).not.toHaveBeenCalled();
      expect(await count("players")).toBe(2);
    } finally {
      await pool.query("DROP TABLE future_reset_state");
    }
  });

  it("aborts when the migration ledger differs from deployed code", async () => {
    const row = await pool.query<{ version: string; content_sha256: string }>(
      "SELECT version, content_sha256 FROM schema_migrations ORDER BY version LIMIT 1"
    );
    const original = row.rows[0]!;
    await pool.query(
      "UPDATE schema_migrations SET content_sha256 = $2 WHERE version = $1",
      [original.version, "f".repeat(64)]
    );
    try {
      await expect(run(true)).rejects.toThrow(/migration ledger differs/);
      expect(await count("players")).toBe(2);
    } finally {
      await pool.query(
        "UPDATE schema_migrations SET content_sha256 = $2 WHERE version = $1",
        [original.version, original.content_sha256]
      );
    }
  });

  it("aborts when a protected table would be reached through reset closure", async () => {
    await pool.query(
      "ALTER TABLE test_access_events ADD COLUMN reset_test_player_id text REFERENCES players(id)"
    );
    try {
      await expect(run(true)).rejects.toThrow(/protected or unclassified tables/);
      expect(await count("players")).toBe(2);
    } finally {
      await pool.query(
        "ALTER TABLE test_access_events DROP COLUMN reset_test_player_id"
      );
    }
  });

  it("rejects a concurrent reset advisory lock", async () => {
    const lockClient = await pool.connect();
    try {
      await lockClient.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        [RESET_ADVISORY_LOCK]
      );
      await expect(run(true)).rejects.toThrow(/operation lock is already held/);
      expect(await count("players")).toBe(2);
    } finally {
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [RESET_ADVISORY_LOCK]
      );
      lockClient.release();
    }
  });

  it("aborts before mutation when backup creation fails", async () => {
    await expect(run(false, async () => {
      throw new Error("simulated backup failure");
    })).rejects.toThrow(/simulated backup failure/);
    expect(await count("players")).toBe(2);
    expect(await count("flags")).toBe(2);
  });

  it("preserves access authority and bug reports, wipes gameplay, supports fresh onboarding, and repeats", async () => {
    const protectedBefore = await protectedAuthoritySnapshot(pool);
    const retainedContentBefore = await retainedContentSnapshot(pool);
    for (const rows of Object.values(retainedContentBefore)) expect(rows.length).toBeGreaterThan(0);
    expect(await count("player_announcement_dismissals")).toBe(1);
    expect(await count("market_venues")).toBe(2);
    expect(await count("market_venue_controls")).toBe(2);
    const bugReportsBefore = await bugReportSnapshot(pool);
    const migrationBefore = await migrationSnapshot(pool);
    expect(await count("population_permanent_stone_authority_v2"))
      .toBeGreaterThan(0);
    expect(await count("population_plan_permanent_stones_v2"))
      .toBeGreaterThan(0);
    expect(await count("population_stone_conflict_repair_receipts_v2"))
      .toBeGreaterThan(0);
    expect(await count("population_plan_spawn_slots_v2")).toBeGreaterThan(0);
    const receipt = await run(false, async () => "verified-test-backup.dump");

    expect(receipt.backupPath).toBe("verified-test-backup.dump");
    for (const table of resetManifest.wipe) {
      expect(await count(table), table).toBe(0);
    }
    expect(await count("chat_channels")).toBe(4);
    expect(await count("chat_channel_sequences")).toBe(4);
    expect(await count("population_plan_spawn_slots_v2")).toBe(0);
    expect(await protectedAuthoritySnapshot(pool)).toEqual(protectedBefore);
    expect(await bugReportSnapshot(pool)).toEqual(bugReportsBefore);
    expect(await retainedContentSnapshot(pool)).toEqual(retainedContentBefore);
    await assertRestoredGlobalMarket();
    expect(await migrationSnapshot(pool)).toEqual(migrationBefore);

    const harness = authHarness(pool);
    const login = await harness.auth.loginWithGoogle("approved-login", context());
    expect(login.session.account.id).toBe(APPROVED_ACCOUNT);
    expect(login.session.account.testAccessStatus).toBe("approved");
    expect(login.session.player).toBeNull();
    expect((await harness.auth.sessionResponse(login.session)).onboardingRequired).toBe(true);

    const onboarding = onboardingHarness(pool, harness.config);
    const player = await onboarding.complete(login.session, {
      displayName: "Newbeginning",
      personalFlagColor: "green"
    });
    expect(player.displayName).toBe("Newbeginning");
    const fresh = await pool.query<{
      count: number;
      initial_spawn_algorithm_version: string;
      initial_spawn_state_code: string;
      dogs: number;
    }>(
      `SELECT
         count(*)::int AS count,
         max(initial_spawn_algorithm_version) AS initial_spawn_algorithm_version,
         max(initial_spawn_state_code) AS initial_spawn_state_code,
         (SELECT count(*)::int FROM account_dogs
           WHERE account_id = $1) AS dogs
       FROM players WHERE account_id = $1`,
      [APPROVED_ACCOUNT]
    );
    expect(fresh.rows[0]).toEqual({
      count: 1,
      initial_spawn_algorithm_version: "initial-spawn:v1",
      initial_spawn_state_code: "US-NM",
      dogs: 0
    });

    await seedPopulationPermanentStoneState(pool, false);
    expect(await count("population_permanent_stone_authority_v2"))
      .toBeGreaterThan(0);
    expect(await count("population_plan_permanent_stones_v2"))
      .toBeGreaterThan(0);
    expect(await count("population_plan_spawn_slots_v2")).toBeGreaterThan(0);

    const repeated = await run(false, async () => "verified-repeat-backup.dump");
    expect(repeated.backupPath).toBe("verified-repeat-backup.dump");
    expect(await count("players")).toBe(0);
    expect(await count("account_dogs")).toBe(0);
    expect(await count("population_permanent_stone_authority_v2")).toBe(0);
    expect(await count("population_plan_permanent_stones_v2")).toBe(0);
    expect(await count("population_stone_conflict_repair_receipts_v2")).toBe(0);
    expect(await count("population_plan_spawn_slots_v2")).toBe(0);
    expect(await protectedAuthoritySnapshot(pool)).toMatchObject({
      accounts: protectedBefore.accounts,
      identities: protectedBefore.identities,
      grants: protectedBefore.grants,
      events: protectedBefore.events
    });
    expect(await bugReportSnapshot(pool)).toEqual(bugReportsBefore);
    expect(await retainedContentSnapshot(pool)).toEqual(retainedContentBefore);
    await assertRestoredGlobalMarket();
    expect(await migrationSnapshot(pool)).toEqual(migrationBefore);
  }, 120_000);

  async function run(
    dryRun: boolean,
    createBackup?: () => Promise<string>
  ) {
    const client = new pg.Client({ connectionString: databaseUrl! });
    await client.connect();
    try {
      return await executeReset({
        client,
        identity: databaseIdentity(databaseUrl!),
        migrationsDirectory,
        dryRun,
        releaseSha: RESET_RELEASE_SHA,
        ...(createBackup ? { createBackup } : {})
      });
    } finally {
      await client.end();
    }
  }

  async function assertRestoredGlobalMarket(): Promise<void> {
    expect(await count("market_venues")).toBe(1);
    expect(await count("market_venue_controls")).toBe(1);
    const audit = await pool.query("SELECT event_type,severity,venue_id,book_id,player_id,evidence FROM market_audit_events");
    expect(audit.rows).toEqual([{
      event_type: "market_control_changed", severity: "warning",
      venue_id: "00000000-0000-4000-8000-000000000600", book_id: null, player_id: null,
      evidence: {
        operatorIdentity: `reset-test-data:${RESET_RELEASE_SHA}`,
        reason: "restore preserved global market configuration after gameplay reset",
        incidentId: null,
        targetScope: { type: "venue", id: "00000000-0000-4000-8000-000000000600" },
        priorState: null,
        resultingState: { frozen: true, sensitiveReason: "Retained global freeze" }
      }
    }]);
  }

  async function count(table: string): Promise<number> {
    if (!/^[a-z][a-z0-9_]*$/u.test(table)) throw new Error("unsafe test table");
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "${table}"`
    );
    return result.rows[0]?.count ?? 0;
  }
});

async function seedRetainedContent(pool: pg.Pool): Promise<void> {
  await pool.query(`
    INSERT INTO account_chat_preferences (account_id, pinned_categories)
    VALUES ('${APPROVED_ACCOUNT}', ARRAY['city','trading']::text[]);
    UPDATE test_access_settings SET access_mode='closed', updated_at='2026-09-01T00:00:00Z'
    WHERE singleton;
    INSERT INTO player_announcements (id,operation_key,title,message,created_by_account_id)
    VALUES ('99000000-0000-4000-8000-000000000001',
      '99000000-0000-4000-8000-000000000002','Retained announcement',
      'Account-authored content survives a gameplay reset.','${ADMIN_ACCOUNT}');
    INSERT INTO player_announcement_dismissals (player_id,announcement_id)
    VALUES ('${PLAYER_A}','99000000-0000-4000-8000-000000000001');
    INSERT INTO wiki_pages (id,slug,title,summary,body,created_by_account_id,updated_by_account_id)
    VALUES ('99000000-0000-4000-8000-000000000003','reset-retention-reference',
      'Retained reference','Retained summary','Retained authored body',
      '${ADMIN_ACCOUNT}','${APPROVED_ACCOUNT}');
    INSERT INTO wiki_page_revisions (page_id,revision,slug,title,summary,body,editor_account_id,operation_key)
    VALUES ('99000000-0000-4000-8000-000000000003',1,'reset-retention-reference',
      'Retained reference','Retained summary','Retained authored body','${APPROVED_ACCOUNT}',
      '99000000-0000-4000-8000-000000000004');
    INSERT INTO wiki_collaborators (account_id,role,granted_by_account_id)
    VALUES ('${ADMIN_ACCOUNT}','owner','${ADMIN_ACCOUNT}'),
      ('${APPROVED_ACCOUNT}','editor','${ADMIN_ACCOUNT}');
    INSERT INTO city_structures (
      structure_id,city_id,structure_type,tier,owner_player_id,world_id,lat,lon,
      geom,footprint_geom,footprint_radius_m,state,build_operation_key,built_at
    ) SELECT '41000000-0000-4000-8000-000000000002',city_id,'market',tier,NULL,
      world_id,lat,lon,geom,footprint_geom,footprint_radius_m,state,'reset-market',built_at
    FROM city_structures WHERE structure_id='41000000-0000-4000-8000-000000000001';
    INSERT INTO market_venues (
      venue_id,venue_key,display_name,scope_type,access_policy_id,fee_policy_id,city_id,market_structure_id
    ) VALUES ('99000000-0000-4000-8000-000000000005','city:reset-test','Gameplay market',
      'regional','physical-city-market-v1',2,'40000000-0000-4000-8000-000000000001',
      '41000000-0000-4000-8000-000000000002');
    INSERT INTO market_venue_controls (venue_id) VALUES ('99000000-0000-4000-8000-000000000005');
    UPDATE market_venues SET display_name='Retained global configuration',fee_policy_id=2 WHERE venue_key='global';
    BEGIN;
    SELECT set_config('ash_atlas.market_control_operator','test:reset-seed',true),
      set_config('ash_atlas.market_control_reason','seed retained global freeze',true);
    UPDATE market_venue_controls SET frozen=true,sensitive_reason='Retained global freeze'
    WHERE venue_id='00000000-0000-4000-8000-000000000600';
    COMMIT;
  `);
}

async function retainedContentSnapshot(pool: pg.Pool) {
  return {
    preferences: (await pool.query("SELECT * FROM account_chat_preferences ORDER BY account_id")).rows,
    settings: (await pool.query("SELECT * FROM test_access_settings ORDER BY singleton")).rows,
    announcements: (await pool.query("SELECT * FROM player_announcements ORDER BY id")).rows,
    wikiPages: (await pool.query("SELECT * FROM wiki_pages ORDER BY id")).rows,
    wikiRevisions: (await pool.query("SELECT * FROM wiki_page_revisions ORDER BY id")).rows,
    wikiCollaborators: (await pool.query("SELECT * FROM wiki_collaborators ORDER BY account_id")).rows,
    globalVenues: (await pool.query("SELECT row_to_json(venue)::text AS exact_row FROM market_venues venue WHERE venue_key='global'")).rows,
    globalVenueControls: (await pool.query("SELECT row_to_json(controls)::text AS exact_row FROM market_venue_controls controls JOIN market_venues venue USING (venue_id) WHERE venue_key='global'")).rows
  };
}

async function seedBugReportState(pool: pg.Pool): Promise<void> {
  await pool.query(`
    INSERT INTO telemetry.test_runs (
      run_id, telemetry_schema_version, run_name, started_at, ended_at, status,
      release_sha, release_generation, world_release_id, population_plan_version,
      population_spawn_rules_version, population_candidate_layout_version,
      permanent_stone_placement_version, balance_version, server_instance_id,
      ingestion_closed_at, segment_id, campaign_id, segment_sequence,
      segment_start_at, segment_end_at, segment_duration_seconds
    ) VALUES (
      '${BUG_REPORT_RUN}', 1, 'reset preservation run',
      '2026-07-25T00:00:00Z', '2026-07-25T01:00:00Z', 'exported',
      repeat('a', 40), 'test/t214', 'world-reset-test', 'population-reset-test',
      'spawn-reset-test', 'layout-reset-test', 'stone-reset-test',
      'balance-reset-test', 'reset-integration',
      '2026-07-25T01:00:00Z', '00000000-0000-4000-8000-000000000703',
      '00000000-0000-4000-8000-000000000704', 0,
      '2026-07-25T00:00:00Z', '2026-07-25T01:00:00Z', 3600
    );

    INSERT INTO telemetry.bug_reports (
      report_id, public_report_code, request_id, telemetry_schema_version,
      bug_report_schema_version, run_id, campaign_id, segment_id,
      related_segment_ids, release_sha, release_generation, world_release_id,
      population_plan_version, population_spawn_rules_version, balance_version,
      server_instance_id, player_id, session_id, connection_generation,
      report_marker_at, available_window_start_at, window_start_at,
      window_end_at, submitted_at, title, category, description,
      expected_behavior, reproducibility, status, export_status, exported_at,
      acknowledged_at
    ) VALUES (
      '${BUG_REPORT_ID}', 'AA-RESET1',
      '00000000-0000-4000-8000-000000000705', 1, 1,
      '${BUG_REPORT_RUN}', '00000000-0000-4000-8000-000000000704',
      '00000000-0000-4000-8000-000000000703',
      ARRAY['00000000-0000-4000-8000-000000000703']::uuid[],
      repeat('a', 40), 'test/t214', 'world-reset-test',
      'population-reset-test', 'spawn-reset-test', 'balance-reset-test',
      'reset-integration', '${PLAYER_A}',
      '00000000-0000-4000-8000-000000000706', 1,
      '2026-07-25T00:55:00Z', '2026-07-25T00:51:00Z',
      '2026-07-25T00:50:00Z', '2026-07-25T00:55:00Z',
      '2026-07-25T00:56:00Z', 'Private reset preservation report', 'gameplay',
      'Sensitive diagnostic description that must survive without entering reset logs.',
      'The report and context remain unchanged.', 'every_time', 'resolved',
      'acknowledged', '2026-07-25T01:01:00Z', '2026-07-25T01:02:00Z'
    );

    INSERT INTO telemetry.bug_report_context (
      report_id, context_schema_version, client_state,
      authoritative_player_state, nearby_entities, recent_client_actions,
      recent_client_errors, network_timeline, performance_history,
      related_operation_ids, related_event_ids, uncompressed_bytes,
      compressed_bytes, content_checksum
    ) VALUES (
      '${BUG_REPORT_ID}', 1,
      '{"private":"client diagnostic state"}',
      '{"playerId":"${PLAYER_A}","private":"authoritative diagnostic state"}',
      '[{"entity":"private nearby diagnostic"}]',
      '[{"action":"private recent action"}]',
      '[{"error":"private recent error"}]',
      '[{"latencyMs":42}]', '[{"fps":60}]',
      ARRAY['private-operation-id'], ARRAY[]::uuid[],
      1024, 512, repeat('b', 64)
    );
  `);
}

async function seedProtectedAndGameplayState(pool: pg.Pool): Promise<void> {
  await pool.query(`
    INSERT INTO accounts (id, test_access_status, test_access_requested_at)
    VALUES
      ('${APPROVED_ACCOUNT}', 'approved', now()),
      ('${SECOND_APPROVED_ACCOUNT}', 'approved', now()),
      ('${ADMIN_ACCOUNT}', 'approved', now()),
      ('${PENDING_ACCOUNT}', 'pending', now()),
      ('${DENIED_ACCOUNT}', 'denied', now()),
      ('${REVOKED_ACCOUNT}', 'revoked', now());

    INSERT INTO account_identities (
      id, account_id, provider, provider_subject, email, email_normalized, email_verified
    ) VALUES
      (gen_random_uuid(), '${APPROVED_ACCOUNT}', 'google', 'approved-subject', 'approved@example.com', 'approved@example.com', true),
      (gen_random_uuid(), '${SECOND_APPROVED_ACCOUNT}', 'google', 'second-subject', 'second@example.test', 'second@example.test', true),
      (gen_random_uuid(), '${ADMIN_ACCOUNT}', 'google', 'admin-subject', 'admin@example.test', 'admin@example.test', true),
      (gen_random_uuid(), '${PENDING_ACCOUNT}', 'google', 'pending-subject', 'pending@example.test', 'pending@example.test', true),
      (gen_random_uuid(), '${DENIED_ACCOUNT}', 'google', 'denied-subject', 'denied@example.test', 'denied@example.test', true),
      (gen_random_uuid(), '${REVOKED_ACCOUNT}', 'google', 'revoked-subject', 'revoked@example.test', 'revoked@example.test', true);

    INSERT INTO test_access_email_grants (
      id, email_display, email_normalized, status, created_by_account_id
    ) VALUES (
      '20000000-0000-4000-8000-000000000001',
      'future@example.test', 'future@example.test', 'active', '${ADMIN_ACCOUNT}'
    );
    INSERT INTO test_access_email_grants (
      id, email_display, email_normalized, status, created_by_account_id,
      claimed_account_id, claimed_google_subject, claimed_provider, claimed_subject, claimed_at
    ) VALUES (
      '20000000-0000-4000-8000-000000000002',
      'approved@example.com', 'approved@example.com', 'claimed', '${ADMIN_ACCOUNT}',
      '${APPROVED_ACCOUNT}', 'approved-subject', 'google', 'approved-subject', now()
    );
    INSERT INTO test_access_events (
      id, event_type, acting_account_id, target_account_id, grant_id,
      previous_status, new_status, reason
    ) VALUES
      (gen_random_uuid(), 'account_approved', '${ADMIN_ACCOUNT}', '${APPROVED_ACCOUNT}', NULL, 'pending', 'approved', 'reset integration seed'),
      (gen_random_uuid(), 'account_denied', '${ADMIN_ACCOUNT}', '${DENIED_ACCOUNT}', NULL, 'pending', 'denied', 'reset integration seed'),
      (gen_random_uuid(), 'preapproval_claimed', NULL, '${APPROVED_ACCOUNT}', '20000000-0000-4000-8000-000000000002', NULL, 'approved', 'reset integration seed');

    INSERT INTO players (
      id, account_id, username, username_normalized, display_color,
      personal_flag_color, onboarding_completed_at, region_code,
      lat, lon, anchor_lat, anchor_lon, geom,
      initial_spawn_latitude, initial_spawn_longitude,
      initial_spawn_algorithm_version, initial_spawn_land_mask_version,
      initial_spawn_world_identity, initial_spawn_rejected_candidates,
      initial_spawn_assigned_at, initial_spawn_state_code
    ) VALUES
      ('${PLAYER_A}', '${APPROVED_ACCOUNT}', 'Oldplayer', 'oldplayer', '#3366cc',
       'blue', now(), 'world_v1_lat35_lon-107', 35.1, -106.6, 35.1, -106.6,
       ST_SetSRID(ST_MakePoint(-106.6, 35.1), 4326),
       35.1, -106.6, 'legacy-test', 'test-mask', 'test-world', 0, now(), 'US-NM'),
      ('${PLAYER_B}', '${SECOND_APPROVED_ACCOUNT}', 'Oldfriend', 'oldfriend', '#7c3aed',
       'purple', now(), 'world_v1_lat35_lon-107', 35.2, -106.7, 35.2, -106.7,
       ST_SetSRID(ST_MakePoint(-106.7, 35.2), 4326),
       35.2, -106.7, 'legacy-test', 'test-mask', 'test-world', 0, now(), 'US-NM');

    INSERT INTO player_profiles (player_id) VALUES ('${PLAYER_A}'), ('${PLAYER_B}');
    INSERT INTO flags (id, owner_id, name, lat, lon, geom, original_personal_color)
    VALUES
      ('30000000-0000-4000-8000-000000000001', '${PLAYER_A}', 'Old Flag A', 35.1, -106.6,
       ST_SetSRID(ST_MakePoint(-106.6, 35.1), 4326), '#3366cc'),
      ('30000000-0000-4000-8000-000000000002', '${PLAYER_B}', 'Old Flag B', 35.2, -106.7,
       ST_SetSRID(ST_MakePoint(-106.7, 35.2), 4326), '#7c3aed');

    INSERT INTO cities (
      id, world_settlement_id, world_settlement_source, world_source_settlement_id,
      name, country_code, founder_player_id, founding_request_id,
      hall_lat, hall_lon, hall_geom, founding_annex_radius_m,
      canonical_municipality_id, seat_flag_id
    ) VALUES (
      '40000000-0000-4000-8000-000000000001',
      'test-settlement', 'test', 'test-settlement', 'Reset City', 'US',
      '${PLAYER_A}', 'reset-city-request', 35.1, -106.6,
      ST_SetSRID(ST_MakePoint(-106.6, 35.1), 4326), 1000,
      'test-municipality', '30000000-0000-4000-8000-000000000001'
    );
    UPDATE flags SET
      control_type = 'city_seat',
      city_id = '40000000-0000-4000-8000-000000000001',
      city_affiliated_at = now(),
      city_affiliated_by_player_id = NULL,
      original_owner_player_id = NULL,
      contributed_by_player_id = NULL,
      original_personal_color = NULL,
      access_mode = 'public'
    WHERE id = '30000000-0000-4000-8000-000000000001';
    INSERT INTO city_structures (
      structure_id, city_id, structure_type, tier, owner_player_id, world_id,
      lat, lon, geom, footprint_geom, footprint_radius_m, state,
      build_operation_key, built_at
    ) VALUES (
      '41000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      'city_house', 1, '${PLAYER_A}', 'main', 35.101, -106.6,
      ST_SetSRID(ST_MakePoint(-106.6, 35.101), 4326),
      ST_Buffer(ST_SetSRID(ST_MakePoint(-106.6, 35.101), 4326)::geography, 10)::geometry,
      10, 'active', 'reset-city-house', now()
    );
    INSERT INTO city_memberships (
      city_id, player_id, role, world_id, house_structure_id
    ) VALUES (
      '40000000-0000-4000-8000-000000000001', '${PLAYER_A}', 'founder', 'main',
      '41000000-0000-4000-8000-000000000001'
    );

    INSERT INTO kingdoms (
      id, normalized_name, display_name, founder_player_id, leader_player_id,
      founding_request_id
    ) VALUES (
      '50000000-0000-4000-8000-000000000001',
      'reset kingdom', 'Reset Kingdom', '${PLAYER_B}', '${PLAYER_B}', 'reset-kingdom-request'
    );
    INSERT INTO kingdom_memberships (
      id, kingdom_id, player_id, role, perk_qualified_at
    ) VALUES (
      gen_random_uuid(), '50000000-0000-4000-8000-000000000001',
      '${PLAYER_B}', 'leader', now()
    );

    INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
    VALUES ('${PLAYER_A}', 'wood', 'default', 50, 1);
    INSERT INTO inventory_operations (operation_key, player_id, source)
    VALUES ('reset-inventory-operation', '${PLAYER_A}', 'reset-test');
    INSERT INTO inventory_events (
      operation_key, player_id, item_id, variant, delta_quantity,
      quantity_after, source, version_after
    ) VALUES (
      'reset-inventory-operation', '${PLAYER_A}', 'wood', 'default',
      50, 50, 'reset-test', 1
    );
    INSERT INTO equipment_operations (operation_key, player_id, action)
    VALUES ('reset-equipment-operation', '${PLAYER_A}', 'starter_loadout');
    INSERT INTO equipment_instances (
      instance_id, definition_id, owner_player_id, location, inventory_slot_index, created_by_operation_key
    ) VALUES (
      '60000000-0000-4000-8000-000000000001',
      'starter_sword', '${PLAYER_A}', 'inventory', 1, 'reset-equipment-operation'
    );

    INSERT INTO player_manors (id, owner_player_id)
    VALUES ('70000000-0000-4000-8000-000000000001', '${PLAYER_A}');
    INSERT INTO manor_storage_stacks (manor_id, slot_index, item_id, quantity)
    VALUES ('70000000-0000-4000-8000-000000000001', 0, 'wood', 25);

    INSERT INTO friendships (player_low_id, player_high_id)
    VALUES ('${PLAYER_A}', '${PLAYER_B}');
    INSERT INTO parties (party_id, leader_player_id)
    VALUES ('80000000-0000-4000-8000-000000000001', '${PLAYER_A}');
    INSERT INTO party_members (party_id, player_id, slot_index)
    VALUES
      ('80000000-0000-4000-8000-000000000001', '${PLAYER_A}', 1),
      ('80000000-0000-4000-8000-000000000001', '${PLAYER_B}', 2);
    INSERT INTO chat_messages (
      id, channel_id, sequence_number, sender_player_id,
      sender_display_name, body, client_request_id
    ) VALUES (
      gen_random_uuid(), '05000000-0000-4000-8000-000000000001', 1,
      '${PLAYER_A}', 'Oldplayer', 'old message', gen_random_uuid()
    );
    UPDATE chat_channel_sequences
    SET last_sequence = 1
    WHERE channel_id = '05000000-0000-4000-8000-000000000001';
    INSERT INTO travel_invites (
      id, inviter_player_id, invitee_player_id, inviter_session_id,
      destination_anchor_lat, destination_anchor_lon, create_request_id,
      created_at, expires_at, layer_scope_id, layer_id,
      layer_relocation_revision, layer_generation, source_type
    ) VALUES (
      gen_random_uuid(), '${PLAYER_A}', '${PLAYER_B}', '90000000-0000-4000-8000-000000000001',
      35.1, -106.6, 'reset-travel-request', now(), now() + interval '10 minutes',
      'world', 'main', 0, 0, 'player'
    );

    INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
    VALUES ('${PLAYER_A}', '${APPROVED_ACCOUNT}', 999, 1);
    INSERT INTO wallet_events (
      operation_key, player_id, account_id, delta_gold,
      balance_after, reason, version_after
    ) VALUES (
      'reset-wallet-operation', '${PLAYER_A}', '${APPROVED_ACCOUNT}',
      999, 999, 'reset-test', 1
    );
    INSERT INTO spawn_cells (id, region_code, cell_x, cell_y, center_lat, center_lon)
    VALUES ('reset-cell', 'US-NM', 1, 1, 35.1, -106.6);
    INSERT INTO harvest_sessions (
      id, player_id, node_id, resource_type, operation_key, status,
      started_at, completes_at, expires_at
    )
    VALUES (
      gen_random_uuid(), '${PLAYER_A}', 'reset-resource-node', 'wood',
      'reset-harvest-operation', 'active', now(), now() + interval '1 second',
      now() + interval '1 minute'
    );
    INSERT INTO account_dogs (
      account_id, personality, name, gender, breed, country_code, country_name,
      adopted_at, care_reconciled_through, explore_available_at,
      owner_player_id,status,birth_at,current_hp,current_stamina_seconds,
      stamina_updated_at,last_unsummoned_at,active_skill_available_at,
      gene_vitality,gene_speed,gene_power,gene_focus,gene_stamina,gene_instinct,
      favorite_food,fun_fact
    ) VALUES (
      '${APPROVED_ACCOUNT}', 'Loyal', 'Milo', 'male', 'Labrador Retriever',
      'US', 'United States', now(), current_date, now(),
      '${PLAYER_A}','READY',now()-interval '21 days',90,2700,
      now(),now(),now(),0,0,0,0,0,0,'Chicken','Enjoys a quiet nap.'
    );
  `);
}

async function seedPopulationPermanentStoneState(
  pool: pg.Pool,
  includeRepairReceipt: boolean
): Promise<void> {
  const worldEnvironmentIdentityKey = "9".repeat(64);
  const worldPipelineSha = "a".repeat(40);
  const origin = populationZoneV2IdForPoint({
    lat: 35.0844,
    lon: -106.6504
  });
  const fixture = populationZoneV2Halo(origin, 12)
    .map((zoneId) => ({
      zoneId,
      plan: generatePopulationZoneV2Plan({
        zoneId,
        worldEnvironmentIdentityKey,
        worldPipelineSha,
        habitatForZone: (candidateZoneId) =>
          populationZoneV3ConservativeHabitat({
            zoneId: candidateZoneId,
            worldEnvironmentIdentityKey
          })
      })
    }))
    .find((candidate) =>
      candidate.plan.slots.some((slot) => slot.entityKind === "stone")
    );
  if (!fixture) {
    throw new Error("reset fixture could not find a permanent stone plan");
  }
  const { plan, zoneId } = fixture;

  const store = new PostgresPopulationZonesV2Store(pool);
  const request = populationZoneV2PlanRequest({
    zoneId,
    worldEnvironmentIdentityKey,
    worldPipelineSha,
    environmentProfileVersion: plan.identity.environmentProfileVersion,
    regionCode: plan.habitat.regionCode
  });
  await store.ensurePlanForZone(request);
  const claim = await store.claimPlan(
    request.identity,
    randomUUID(),
    30_000
  );
  if (claim === null) throw new Error("reset fixture could not claim its plan");
  if (!await store.completePlan(claim, plan)) {
    throw new Error("reset fixture could not complete its plan");
  }

  if (includeRepairReceipt) {
    const authority = await pool.query<{ entity_id: string }>(
      `SELECT entity_id
       FROM population_permanent_stone_authority_v2
       WHERE owner_zone_id=$1
       ORDER BY entity_id`,
      [zoneId]
    );
    if (authority.rows.length === 0) {
      throw new Error("reset fixture did not create permanent stone authority");
    }
    await pool.query(
      `INSERT INTO population_stone_conflict_repair_receipts_v2 (
         repair_id, plan_id, zone_id, spawn_rules_version,
         previous_status, previous_attempt_count, compatible_entity_ids
       ) VALUES ($1::uuid,$2::uuid,$3,$4,'terminal-failure',1,$5::uuid[])`,
      [
        randomUUID(),
        plan.planId,
        zoneId,
        plan.identity.spawnRulesVersion,
        authority.rows.map((row) => row.entity_id)
      ]
    );
  }
}

async function protectedAuthoritySnapshot(pool: pg.Pool): Promise<{
  accounts: unknown[];
  identities: unknown[];
  grants: unknown[];
  events: unknown[];
}> {
  const [accounts, identities, grants, events] = await Promise.all([
    pool.query(
      `SELECT id, status, test_access_status, test_access_requested_at,
              test_access_decided_at, test_access_decided_by_account_id,
              test_access_decision_note
       FROM accounts ORDER BY id`
    ),
    pool.query(
      `SELECT account_id, provider, provider_subject, email_normalized, email_verified
       FROM account_identities ORDER BY account_id, provider`
    ),
    pool.query(
      `SELECT id, email_normalized, status, created_by_account_id,
              claimed_account_id, claimed_google_subject, claimed_at,
              revoked_at, revoked_by_account_id
       FROM test_access_email_grants ORDER BY id`
    ),
    pool.query(
      `SELECT id, event_type, acting_account_id, target_account_id, grant_id,
              previous_status, new_status, reason, operation_key, created_at
       FROM test_access_events ORDER BY id`
    )
  ]);
  return {
    accounts: accounts.rows,
    identities: identities.rows,
    grants: grants.rows,
    events: events.rows
  };
}

async function migrationSnapshot(pool: pg.Pool): Promise<unknown[]> {
  return (
    await pool.query(
      "SELECT version, content_sha256, applied_at FROM schema_migrations ORDER BY version"
    )
  ).rows;
}

async function bugReportSnapshot(pool: pg.Pool): Promise<{
  reports: unknown[];
  contexts: unknown[];
}> {
  const [reports, contexts] = await Promise.all([
    pool.query(
      `SELECT report_id, public_report_code, request_id, run_id, player_id,
              title, category, description, expected_behavior, status,
              export_status, exported_at, acknowledged_at, updated_at
       FROM telemetry.bug_reports
       WHERE report_id = $1
       ORDER BY report_id`,
      [BUG_REPORT_ID]
    ),
    pool.query(
      `SELECT report_id, context_schema_version, client_state,
              authoritative_player_state, nearby_entities,
              recent_client_actions, recent_client_errors, network_timeline,
              performance_history, related_operation_ids, related_event_ids,
              uncompressed_bytes, compressed_bytes, content_checksum
       FROM telemetry.bug_report_context
       WHERE report_id = $1
       ORDER BY report_id`,
      [BUG_REPORT_ID]
    )
  ]);
  return { reports: reports.rows, contexts: contexts.rows };
}

function authHarness(pool: pg.Pool): { config: AppConfig; auth: AuthService } {
  const config = loadConfig({
    NODE_ENV: "test",
    AUTH_RUNTIME_MODE: "public",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "reset-test-client-id",
    TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: "admin-subject",
    INITIAL_SPAWN_HMAC_KEY: "reset-spawn-key-aaaaaaaaaaaaaaaaaaaa",
    INITIAL_SPAWN_MAX_ATTEMPTS: "4"
  });
  const identities = new Map<string, VerifiedGoogleIdentity>([
    ["approved-login", verifiedIdentity("approved-subject", "approved@example.com")]
  ]);
  return {
    config,
    auth: new AuthService(
      config,
      new PostgresAuthStore(pool, config),
      new FakeGoogleIdentityVerifier(identities),
      { warn: vi.fn() } as never
    )
  };
}

function onboardingHarness(pool: pg.Pool, config: AppConfig): OnboardingService {
  const spawns = new InitialSpawnSampler(config, {
    async lookupGameplayEnvironment(lat, lon) {
      return environment(lat, lon);
    }
  });
  const dogs = new PetService(pool, new PremiumWalletService(pool), null);
  return new OnboardingService(
    pool,
    config,
    spawns,
    dogs,
    { info: vi.fn(), warn: vi.fn() } as never
  );
}

function verifiedIdentity(subject: string, email: string): VerifiedGoogleIdentity {
  return {
    subject,
    email,
    emailVerified: true,
    authTime: null,
    authMethods: null,
    expiresAt: new Date("2027-01-01T00:00:00.000Z")
  };
}

function context(): LoginRequestContext {
  return {
    ip: "203.0.113.42",
    userAgent: "Mozilla/5.0 reset test",
    deviceToken: null,
    existingSessionToken: null
  };
}

function environment(lat: number, lon: number): WorldGameplayEnvironmentResult {
  return {
    ok: true,
    contractVersion: "gameplay-environment-v1",
    runtime: { sha: "a".repeat(40), branch: "integration/test" },
    packageId: "world_v1_lat35_lon-107",
    latitude: lat,
    longitude: lon,
    countryId: "country-us",
    countryName: "United States",
    countryCode: "US",
    regionId: "US-NM",
    regionName: "New Mexico",
    regionCode: "US-NM",
    elevationM: 10,
    elevationBand: "low",
    terrainClass: "land",
    landCoverClass: "forest",
    biome: "temperate",
    biomeName: "Temperate",
    ecoregion: "test",
    ecoregionName: "Test",
    isLand: true,
    isSaltwater: false,
    isCoastalLand: false,
    isRiverbank: false,
    isLakeshore: false,
    insideMajorLake: false,
    majorLakeId: null,
    majorLakeName: null,
    majorLakeDistanceM: null,
    settlementId: null,
    settlementName: null,
    namedRiverId: null,
    namedRiverName: null,
    riverClass: null,
    riverDistanceM: null,
    supportingRiverId: null,
    supportingRiverFlowOrder: null,
    supportingRiverDischargeCms: null,
    supportingRiverDrainageAreaSqKm: null,
    supportingRiverDistanceM: null,
    flagPlacementWater: {
      blocked: false,
      kind: "land",
      sourceId: null,
      sourceName: null,
      distanceM: null,
      corridorRadiusM: null,
      reason: "authoritative land",
      resolution: "test-mask-v1",
      releaseId: "world-release-v1"
    },
    release: {
      releaseId: "world-release-v1",
      profileSetFingerprint: "profiles",
      buildContractFingerprint: "contract",
      boundaryReleaseId: "boundary-release-v1",
      packageCount: 1
    },
    environmentSchemaVersion: "environment-v1",
    raw: {}
  };
}

function databaseIdentity(value: string): {
  host: string;
  port: number;
  database: string;
} {
  const parsed = new URL(value);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "5432"),
    database: parsed.pathname.slice(1)
  };
}

function testDatabaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("RESET_TEST_DATABASE_URL must use local PostgreSQL");
  }
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("RESET_TEST_DATABASE_URL must target ash_atlas_stability*");
  }
  return value;
}
