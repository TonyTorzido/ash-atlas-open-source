import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type AppConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { PetService } from "../game/petService.js";
import { PremiumWalletService } from "../game/premiumWallet.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import { AuthService } from "./authService.js";
import { PostgresAuthStore } from "./authStore.js";
import { FakeGoogleIdentityVerifier } from "./googleIdentity.js";
import { InitialSpawnSampler } from "./initialSpawn.js";
import { OnboardingService } from "./onboardingService.js";
import { TestAccessService } from "./testAccessService.js";
import type {
  AuthenticatedSession,
  LoginRequestContext,
  VerifiedGoogleIdentity
} from "./types.js";

const databaseUrl = testDatabaseUrl(process.env.DEVELOPER_AUTH_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;
const ADMIN_SUBJECT = "test-access-admin-subject";

describeDatabase("closed-test access and onboarding PostgreSQL authority", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 6 });
    activePool = pool;
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE accounts, device_installations CASCADE");
    await pool.query(
      `INSERT INTO test_access_settings (singleton, access_mode)
       VALUES (true, 'closed')
       ON CONFLICT (singleton) DO UPDATE
       SET access_mode = 'closed', updated_at = now()`
    );
  });

  afterAll(async () => {
    await pool?.end();
    activePool = null;
  });

  it("creates one restricted pending account with no gameplay side effects", async () => {
    const firstCredential = `unknown-first-${randomUUID()}`;
    const secondCredential = `unknown-second-${randomUUID()}`;
    const identity = verifiedIdentity("unknown-subject", "Unknown+literal@example.com");
    const harness = authHarness(new Map([
      [firstCredential, identity],
      [secondCredential, identity]
    ]));

    const first = await harness.auth.loginWithGoogle(firstCredential, context());
    const repeated = await harness.auth.loginWithGoogle(secondCredential, context());

    expect(first.session.account.testAccessStatus).toBe("pending");
    expect(first.session.verifiedEmail).toBe("Unknown+literal@example.com");
    expect(repeated.session.account.id).toBe(first.session.account.id);
    await expect(harness.auth.requireGameplayReady(first.session)).rejects.toMatchObject({
      code: "TEST_ACCESS_PENDING"
    });
    const persisted = await pool.query<{
      accounts: number;
      identities: number;
      pending_events: number;
      players: number;
      dogs: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM accounts) AS accounts,
         (SELECT count(*)::int FROM account_identities) AS identities,
         (SELECT count(*)::int FROM test_access_events
           WHERE event_type = 'pending_requested') AS pending_events,
         (SELECT count(*)::int FROM players) AS players,
         (SELECT count(*)::int FROM account_dogs) AS dogs`
    );
    expect(persisted.rows[0]).toEqual({
      accounts: 1,
      identities: 1,
      pending_events: 1,
      players: 0,
      dogs: 0
    });
  });

  it("persists open mode without approving pending accounts and restores closed enforcement", async () => {
    const adminCredential = `mode-admin-${randomUUID()}`;
    const playerCredential = `mode-player-${randomUUID()}`;
    const harness = authHarness(new Map([
      [adminCredential, verifiedIdentity(ADMIN_SUBJECT, "admin@example.com")],
      [playerCredential, verifiedIdentity("open-player-subject", "open.player@example.com")]
    ]));
    const admin = await harness.auth.loginWithGoogle(adminCredential, context());
    const player = await harness.auth.loginWithGoogle(playerCredential, context());

    expect(player.session.account.testAccessStatus).toBe("pending");
    await expect(harness.auth.requireApprovedTestAccess(player.session)).rejects.toMatchObject({
      code: "TEST_ACCESS_PENDING"
    });

    await harness.access.setAccessMode(admin.session, "open");
    await expect(harness.auth.requireApprovedTestAccess(player.session)).resolves.toBeUndefined();
    expect((await harness.auth.sessionResponse(player.session)).testAccessAllowed).toBe(true);
    expect(player.session.account.testAccessStatus).toBe("pending");
    const createdPlayer = await onboardingHarness(harness.config).complete(player.session, {
      displayName: "Openplayer",
      personalFlagColor: "gold"
    });
    expect(createdPlayer.accountId).toBe(player.session.account.id);
    await expect(
      new TestAccessService(pool, harness.config).getAccessMode()
    ).resolves.toBe("open");

    await harness.access.setAccessMode(admin.session, "closed");
    const returning = await authenticateLatest(harness.auth, player.session.rawToken);
    await expect(harness.auth.requireGameplayReady(returning)).rejects.toMatchObject({
      code: "TEST_ACCESS_PENDING"
    });
    expect(await eventCount("access_mode_changed")).toBe(2);
    const modeEvents = await pool.query<{
      acting_account_id: string;
      previous_status: string;
      new_status: string;
      created_at: Date;
    }>(
      `SELECT acting_account_id, previous_status, new_status, created_at
       FROM test_access_events
       WHERE event_type = 'access_mode_changed'
       ORDER BY created_at, id`
    );
    expect(modeEvents.rows.map((event) => ({
      actor: event.acting_account_id,
      previous: event.previous_status,
      next: event.new_status,
      timestamp: event.created_at instanceof Date
    }))).toEqual([
      { actor: admin.session.account.id, previous: "closed", next: "open", timestamp: true },
      { actor: admin.session.account.id, previous: "open", next: "closed", timestamp: true }
    ]);
  });

  it("dev mode admits the admin and admin-approved dev-list accounts only", async () => {
    const harness = authHarness(new Map([
      ["admin", verifiedIdentity(ADMIN_SUBJECT, "admin@example.com")],
      ["tester", verifiedIdentity("dev-tester-subject", "dev.tester@example.com")],
      ["stranger", verifiedIdentity("dev-stranger-subject", "dev.stranger@example.com")]
    ]));
    const admin = await harness.auth.loginWithGoogle("admin", context());
    const tester = await harness.auth.loginWithGoogle("tester", context());
    const stranger = await harness.auth.loginWithGoogle("stranger", context());
    await harness.access.decideAccount(admin.session, tester.session.account.id, "approve", null, null);
    await harness.access.setAccessMode(admin.session, "dev");

    await expect(
      harness.auth.requireApprovedTestAccess(await authenticateLatest(harness.auth, admin.session.rawToken))
    ).resolves.toBeUndefined();
    const approvedTester = await authenticateLatest(harness.auth, tester.session.rawToken);
    // Blocked approved sign-ins only queue a pending request; replays add nothing.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(harness.auth.requireApprovedTestAccess(approvedTester)).rejects.toMatchObject({
        code: "TEST_ACCESS_DEV_ONLY"
      });
    }
    await expect(harness.auth.requireApprovedTestAccess(stranger.session)).rejects.toMatchObject({
      code: "TEST_ACCESS_DEV_ONLY"
    });
    const pending = await harness.access.list({ filter: "dev", search: "", page: 1, pageSize: 25 });
    expect(pending.items).toEqual([expect.objectContaining({
      accountId: tester.session.account.id,
      devAccessStatus: "pending"
    })]);
    expect(await eventCount("dev_access_requested")).toBe(1);
    await expect(harness.access.decideDevAccess(
      admin.session, stranger.session.account.id, "approve", null, null
    )).rejects.toMatchObject({ code: "TEST_ACCESS_INVALID_TRANSITION" });

    await harness.access.grantDevAccessByEmail(admin.session, "Dev.Tester@example.com", null, null);
    await expect(harness.auth.requireApprovedTestAccess(approvedTester)).resolves.toBeUndefined();

    await harness.access.decideDevAccess(admin.session, tester.session.account.id, "revoke", null, null);
    await expect(harness.auth.requireApprovedTestAccess(approvedTester)).rejects.toMatchObject({
      code: "TEST_ACCESS_DEV_ONLY"
    });
    expect(await eventCount("dev_access_approved")).toBe(1);
    expect(await eventCount("dev_access_revoked")).toBe(1);

    await harness.access.setAccessMode(admin.session, "closed");
    await expect(harness.auth.requireApprovedTestAccess(approvedTester)).resolves.toBeUndefined();
  });

  it("claims a case-insensitive exact preapproval once without Gmail alias rewriting", async () => {
    const harness = authHarness(new Map([
      ["admin", verifiedIdentity(ADMIN_SUBJECT, "admin@example.com")],
      ["tester", verifiedIdentity("tester-subject", "Future.Test+alpha@Gmail.com")],
      ["other", verifiedIdentity("other-subject", "FutureTest@example.com")]
    ]));
    const admin = await harness.auth.loginWithGoogle("admin", context());
    const access = new TestAccessService(pool, harness.config);

    const created = await access.preapprove(
      admin.session,
      "  future.test+alpha@example.com  ",
      null,
      "preapprove-future-test"
    );
    const tester = await harness.auth.loginWithGoogle("tester", context());
    const other = await harness.auth.loginWithGoogle("other", context());

    expect(created).toMatchObject({ outcome: "grant_active" });
    expect(tester.session.account.testAccessStatus).toBe("approved");
    expect(other.session.account.testAccessStatus).toBe("pending");
    const grant = await pool.query<{
      email_normalized: string;
      status: string;
      claimed_account_id: string;
      claimed_google_subject: string;
    }>(
      `SELECT email_normalized, status, claimed_account_id, claimed_google_subject
       FROM test_access_email_grants`
    );
    expect(grant.rows).toEqual([{
      email_normalized: "future.test+alpha@example.com",
      status: "claimed",
      claimed_account_id: tester.session.account.id,
      claimed_google_subject: "tester-subject"
    }]);
    expect(await eventCount("preapproval_claimed")).toBe(1);
  });

  it("preapproves an existing pending identity by approving that account without a grant", async () => {
    const harness = authHarness(new Map([
      ["admin", verifiedIdentity(ADMIN_SUBJECT, "admin@example.com")],
      ["pending", verifiedIdentity("pending-subject", "pending@example.com")]
    ]));
    const admin = await harness.auth.loginWithGoogle("admin", context());
    const pending = await harness.auth.loginWithGoogle("pending", context());
    const access = new TestAccessService(pool, harness.config);

    const result = await access.preapprove(
      admin.session,
      " Pending@Gmail.com ",
      "invited tester",
      "approve-existing-pending"
    );

    expect(result).toEqual({
      outcome: "account_approved",
      accountId: pending.session.account.id,
      accountStatus: "approved"
    });
    expect(Number((await pool.query(
      "SELECT count(*)::int AS count FROM test_access_email_grants"
    )).rows[0]?.count)).toBe(0);
  });

  it("atomically creates one player and deterministic initial spawn without granting kennel stock", async () => {
    const harness = authHarness(new Map([
      ["admin", verifiedIdentity(ADMIN_SUBJECT, "admin@example.com")],
      ["tester", verifiedIdentity("onboarding-subject", "onboarding@example.com")]
    ]));
    const admin = await harness.auth.loginWithGoogle("admin", context());
    const tester = await harness.auth.loginWithGoogle("tester", context());
    const access = new TestAccessService(pool, harness.config);
    await access.decideAccount(
      admin.session,
      tester.session.account.id,
      "approve",
      null,
      "approve-onboarding"
    );
    const approved = await authenticateLatest(harness.auth, tester.session.rawToken);
    const onboarding = onboardingHarness(harness.config);

    const created = await onboarding.complete(approved, {
      displayName: "Wolfhunter",
      personalFlagColor: "purple"
    });
    const replay = await onboarding.complete(approved, {
      displayName: "Different",
      personalFlagColor: "red"
    });

    expect(replay.id).toBe(created.id);
    expect(replay.displayName).toBe("Wolfhunter");
    const rows = await pool.query<{
      username: string;
      username_normalized: string;
      personal_flag_color: string;
      lat: number;
      lon: number;
      initial_spawn_latitude: number;
      initial_spawn_longitude: number;
      initial_spawn_algorithm_version: string;
      initial_spawn_world_identity: string;
      dogs: number;
    }>(
      `SELECT p.username, p.username_normalized, p.personal_flag_color,
              p.lat, p.lon, p.initial_spawn_latitude, p.initial_spawn_longitude,
              p.initial_spawn_algorithm_version, p.initial_spawn_world_identity,
              (SELECT count(*)::int FROM account_dogs
                WHERE account_id = p.account_id) AS dogs
       FROM players p WHERE p.account_id = $1`,
      [tester.session.account.id]
    );
    expect(rows.rows[0]).toMatchObject({
      username: "Wolfhunter",
      username_normalized: "wolfhunter",
      personal_flag_color: "purple",
      initial_spawn_algorithm_version: "initial-spawn:v1",
      dogs: 0
    });
    expect(rows.rows[0]?.lat).toBe(rows.rows[0]?.initial_spawn_latitude);
    expect(rows.rows[0]?.lon).toBe(rows.rows[0]?.initial_spawn_longitude);
    expect(rows.rows[0]?.initial_spawn_world_identity).toContain(harness.config.WORLD_ID);
  });

  it("rolls back name, player, onboarding, and dog when spawn assignment fails", async () => {
    const harness = authHarness(new Map([
      ["admin", verifiedIdentity(ADMIN_SUBJECT, "admin@example.com")],
      ["tester", verifiedIdentity("failed-onboarding-subject", "failed@example.com")]
    ]));
    const admin = await harness.auth.loginWithGoogle("admin", context());
    const tester = await harness.auth.loginWithGoogle("tester", context());
    const access = new TestAccessService(pool, harness.config);
    await access.decideAccount(
      admin.session,
      tester.session.account.id,
      "approve",
      null,
      "approve-failed-onboarding"
    );
    const approved = await authenticateLatest(harness.auth, tester.session.rawToken);
    const failed = onboardingHarness(harness.config, true);

    await expect(failed.complete(approved, {
      displayName: "Redmere",
      personalFlagColor: "gold"
    })).rejects.toEqual(expect.objectContaining({ code: "ONBOARDING_FAILED" }));
    const counts = await pool.query<{ players: number; dogs: number }>(
      `SELECT
         (SELECT count(*)::int FROM players WHERE account_id = $1) AS players,
         (SELECT count(*)::int FROM account_dogs WHERE account_id = $1) AS dogs`,
      [tester.session.account.id]
    );
    expect(counts.rows[0]).toEqual({ players: 0, dogs: 0 });
  });

  it("revokes and restores access without deleting or rerolling the existing player", async () => {
    const harness = authHarness(new Map([
      ["admin", verifiedIdentity(ADMIN_SUBJECT, "admin@example.com")],
      ["tester", verifiedIdentity("revocation-subject", "revocation@example.com")]
    ]));
    const admin = await harness.auth.loginWithGoogle("admin", context());
    const tester = await harness.auth.loginWithGoogle("tester", context());
    const access = new TestAccessService(pool, harness.config);
    await access.decideAccount(
      admin.session,
      tester.session.account.id,
      "approve",
      null,
      "approve-revocation-test"
    );
    const approved = await authenticateLatest(harness.auth, tester.session.rawToken);
    const onboarding = onboardingHarness(harness.config);
    const player = await onboarding.complete(approved, {
      displayName: "Rowan",
      personalFlagColor: "green"
    });
    const original = await persistedSpawn(player.id);

    await access.decideAccount(
      admin.session,
      tester.session.account.id,
      "revoke",
      "closed-test access removed",
      "revoke-tester"
    );
    const revoked = await authenticateLatest(harness.auth, tester.session.rawToken);
    await expect(harness.auth.requireGameplayReady(revoked)).rejects.toMatchObject({
      code: "TEST_ACCESS_REVOKED"
    });
    await expect(onboarding.complete(revoked, {
      displayName: "Rowan",
      personalFlagColor: "green"
    })).rejects.toMatchObject({ code: "TEST_ACCESS_REVOKED" });

    await access.decideAccount(
      admin.session,
      tester.session.account.id,
      "restore",
      null,
      "restore-tester"
    );
    const restored = await authenticateLatest(harness.auth, tester.session.rawToken);
    await expect(harness.auth.requireGameplayReady(restored)).resolves.toBeUndefined();
    expect(await persistedSpawn(player.id)).toEqual(original);
  });

  async function eventCount(eventType: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM test_access_events WHERE event_type = $1",
      [eventType]
    );
    return result.rows[0]?.count ?? 0;
  }

  async function persistedSpawn(playerId: string): Promise<{
    lat: number;
    lon: number;
    assignedAt: string;
  }> {
    const result = await pool.query<{
      initial_spawn_latitude: number;
      initial_spawn_longitude: number;
      initial_spawn_assigned_at: Date;
    }>(
      `SELECT initial_spawn_latitude, initial_spawn_longitude, initial_spawn_assigned_at
       FROM players WHERE id = $1`,
      [playerId]
    );
    const row = result.rows[0]!;
    return {
      lat: Number(row.initial_spawn_latitude),
      lon: Number(row.initial_spawn_longitude),
      assignedAt: new Date(row.initial_spawn_assigned_at).toISOString()
    };
  }

  function onboardingHarness(config: AppConfig, waterOnly = false): OnboardingService {
    const spawns = new InitialSpawnSampler(config, {
      async lookupGameplayEnvironment(lat, lon) {
        return environment(lat, lon, waterOnly);
      }
    });
    const dogs = new PetService(pool, new PremiumWalletService(pool), null);
    return new OnboardingService(
      pool,
      config,
      spawns,
      dogs,
      { info: vi.fn(), warn: vi.fn() } as never,
      undefined,
      new TestAccessService(pool, config)
    );
  }
});

function authHarness(identities: Map<string, VerifiedGoogleIdentity>): {
  config: AppConfig;
  auth: AuthService;
  access: TestAccessService;
} {
  const config = loadConfig({
    NODE_ENV: "test",
    AUTH_RUNTIME_MODE: "public",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "test-client-id",
    TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: ADMIN_SUBJECT,
    INITIAL_SPAWN_HMAC_KEY: "spawn-integration-key-aaaaaaaaaaaaaaaa",
    INITIAL_SPAWN_MAX_ATTEMPTS: "4"
  });
  const access = new TestAccessService(poolReference(), config);
  return {
    config,
    access,
    auth: new AuthService(
      config,
      new PostgresAuthStore(poolReference(), config),
      new FakeGoogleIdentityVerifier(identities),
      { warn: vi.fn() } as never,
      undefined,
      access
    )
  };
}

let activePool: pg.Pool | null = null;

function poolReference(): pg.Pool {
  if (!activePool) {
    throw new Error("closed-test access integration pool is unavailable");
  }
  return activePool;
}

async function authenticateLatest(
  auth: AuthService,
  rawToken: string
): Promise<AuthenticatedSession> {
  const session = await auth.authenticateSession(rawToken);
  if (!session) throw new Error("expected authenticated session");
  return session;
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
    userAgent: "Mozilla/5.0",
    deviceToken: null,
    existingSessionToken: null
  };
}

function environment(
  lat: number,
  lon: number,
  water: boolean
): WorldGameplayEnvironmentResult {
  return {
    ok: true,
    contractVersion: "gameplay-environment-v1",
    runtime: { sha: "a".repeat(40), branch: "integration/test" },
    packageId: "package",
    latitude: lat,
    longitude: lon,
    countryId: "country-us",
    countryName: "United States",
    countryCode: "US",
    regionId: "US-NM",
    regionName: "New Mexico",
    regionCode: "US-NM",
    elevationM: water ? -1 : 10,
    elevationBand: water ? "water" : "low",
    terrainClass: water ? "water" : "land",
    landCoverClass: water ? "inland_water" : "forest",
    biome: water ? null : "temperate",
    biomeName: water ? null : "temperate",
    ecoregion: water ? null : "test",
    ecoregionName: water ? null : "test",
    isLand: !water,
    isSaltwater: false,
    isCoastalLand: false,
    isRiverbank: false,
    isLakeshore: false,
    insideMajorLake: water,
    majorLakeId: water ? "lake" : null,
    majorLakeName: water ? "Lake" : null,
    majorLakeDistanceM: water ? 0 : null,
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
      blocked: water,
      kind: water ? "lake" : "land",
      sourceId: water ? "lake" : null,
      sourceName: water ? "Lake" : null,
      distanceM: water ? 0 : null,
      corridorRadiusM: null,
      reason: water ? "water" : "authoritative land",
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

function testDatabaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("DEVELOPER_AUTH_TEST_DATABASE_URL must use local PostgreSQL");
  }
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error(
      "DEVELOPER_AUTH_TEST_DATABASE_URL must target an ash_atlas_stability* database"
    );
  }
  return value;
}
