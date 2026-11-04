import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { DevelopmentEconomyService } from "../game/developmentEconomy.js";
import { PostgresAuthStore } from "./authStore.js";
import { AuthService } from "./authService.js";
import { FakeGoogleIdentityVerifier } from "./googleIdentity.js";
import type { LoginRequestContext, VerifiedGoogleIdentity } from "./types.js";

const databaseUrl = developerAuthorizationDatabaseUrl(
  process.env.DEVELOPER_AUTH_TEST_DATABASE_URL
);
const describeDatabase = databaseUrl ? describe : describe.skip;
const ownerSubject = "109876543210987654321";

describeDatabase("developer authorization PostgreSQL authority", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("audits the verified owner and replays a durable economy mutation exactly once", async () => {
    const credential = `owner-credential-${randomUUID()}`;
    const config = loadConfig({
      NODE_ENV: "test",
      AUTH_RUNTIME_MODE: "public",
      AUTH_MODE: "google",
      GOOGLE_CLIENT_ID: "test-client-id",
      DEV_TOOLS_ENABLED: "true",
      DEV_ADMIN_TOOLS_ENABLED: "true",
      DEV_AUTHORIZED_GOOGLE_SUBJECTS: ownerSubject,
      TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: ownerSubject,
      INITIAL_SPAWN_HMAC_KEY: "spawn-key-dddddddddddddddddddddddddd",
      RUNTIME_SHA: "f".repeat(40)
    });
    const auth = new AuthService(
      config,
      new PostgresAuthStore(pool, config),
      new FakeGoogleIdentityVerifier(new Map([
        [credential, identity(ownerSubject, "owner@example.com")]
      ])),
      { warn: vi.fn() } as never
    );
    const login = await auth.loginWithGoogle(credential, context());
    const playerId = randomUUID();
    const displayName = `Owner${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color,
         region_code, lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, geom
       )
       VALUES (
         $1, $2, $3, lower($3), '#3366cc',
         'NM', 35.0844, -106.6504, 35.0844, -106.6504, 600,
         ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326)
       )`,
      [playerId, login.session.account.id, displayName]
    );
    const player = {
      id: playerId,
      accountId: login.session.account.id,
      displayName,
      personalFlagColor: "blue" as const,
      onboardingCompletedAt: new Date()
    };
    const session = { ...login.session, player };
    const operationKey = `owner-dev-grant-${randomUUID()}`;

    await auth.authorizeDeveloperCommand(session, {
      capability: "developer:assets-grant",
      command: "owner-test.durable-grant",
      transport: "websocket",
      target: player.id,
      operationKey
    });

    const economy = new DevelopmentEconomyService(pool);
    const first = await economy.grant(
      player.id,
      login.session.account.id,
      operationKey,
      {
        gold: 1_000n,
        materials: [{ itemId: "wood", quantity: 25n }]
      }
    );
    const replay = await economy.grant(
      player.id,
      login.session.account.id,
      operationKey,
      {
        gold: 1_000n,
        materials: [{ itemId: "wood", quantity: 25n }]
      }
    );
    await auth.recordDeveloperCommandResult(session, {
      capability: "developer:assets-grant",
      command: "owner-test.durable-grant",
      transport: "websocket",
      target: player.id,
      operationKey,
      outcome: "succeeded"
    });

    expect(first).toMatchObject({
      replayed: false,
      walletGold: 1_000n,
      inventory: {
        playerId: player.id,
        totals: { wood: 25 }
      }
    });
    expect(replay).toEqual({ ...first, replayed: true });

    const walletEvents = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM wallet_events
       WHERE player_id = $1 AND operation_key = $2`,
      [player.id, `dev-grant:${operationKey}:gold`]
    );
    const inventoryEvents = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM inventory_events
       WHERE player_id = $1 AND operation_key = $2`,
      [player.id, `dev-grant:${operationKey}:materials`]
    );
    expect(walletEvents.rows[0]?.count).toBe(1);
    expect(inventoryEvents.rows[0]?.count).toBe(1);

    const audits = await pool.query<{
      event_type: string;
      created_at: Date;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, created_at, metadata
       FROM auth_events
       WHERE account_id = $1 AND event_type LIKE 'developer_command_%'
       ORDER BY created_at, id`,
      [login.session.account.id]
    );
    expect(audits.rows).toEqual([
      expect.objectContaining({
        event_type: "developer_command_authorization",
        created_at: expect.any(Date),
        metadata: expect.objectContaining({
          outcome: "authorized",
          operationKey,
          releaseSha: "f".repeat(40)
        })
      }),
      expect.objectContaining({
        event_type: "developer_command_result",
        created_at: expect.any(Date),
        metadata: expect.objectContaining({
          outcome: "succeeded",
          operationKey
        })
      })
    ]);
    expect(JSON.stringify(audits.rows)).not.toContain(credential);
    expect(JSON.stringify(audits.rows)).not.toContain(login.session.rawToken);
  });
});

function developerAuthorizationDatabaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  const databaseName = decodeURIComponent(new URL(value).pathname.slice(1));
  if (!databaseName.startsWith("ash_atlas_stability")) {
    throw new Error(
      "DEVELOPER_AUTH_TEST_DATABASE_URL must target an ash_atlas_stability* database"
    );
  }
  return value;
}

function identity(subject: string, email: string): VerifiedGoogleIdentity {
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
