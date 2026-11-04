import { describe, expect, it, vi } from "vitest";

import { InMemoryAuthStore } from "../__tests__/authTestStore.js";
import { loadConfig, type AppConfig } from "../config.js";
import { AuthService } from "./authService.js";
import {
  developmentAssetGrantCapability,
  developerCapabilitiesForSession,
  hasDeveloperCapability
} from "./developerAuthorization.js";
import { FakeGoogleIdentityVerifier } from "./googleIdentity.js";
import type {
  AuthenticatedSession,
  LoginRequestContext,
  VerifiedGoogleIdentity
} from "./types.js";

const OWNER_SUBJECT = "109876543210987654321";

describe("developer authorization", () => {
  it("matches only the exact verified provider subject", () => {
    const config = publicConfig();
    const owner = session(OWNER_SUBJECT);
    const ordinary = session("209876543210987654321");
    const missing = session(null);

    expect(developerCapabilitiesForSession(config, owner)).toEqual([
      "developer:wiki-manage",
      "developer:observe",
      "developer:appearance-studio",
      "developer:world-mutate",
      "developer:assets-grant",
      "developer:packages-send"
    ]);
    expect(developerCapabilitiesForSession(config, ordinary)).toEqual([]);
    expect(developerCapabilitiesForSession(config, missing)).toEqual([]);
    expect(hasDeveloperCapability(config, owner, "developer:observe")).toBe(true);
    expect(hasDeveloperCapability(config, ordinary, "developer:observe")).toBe(false);
  });

  it("does not trust character names, account ids, emails, or client-forged fields", () => {
    const config = publicConfig();
    const forged = {
      ...session("ordinary-subject"),
      account: {
        ...session("ordinary-subject").account,
        id: OWNER_SUBJECT
      },
      player: {
        id: "owner@example.com",
        accountId: OWNER_SUBJECT,
        displayName: "Owner",
        personalFlagColor: "blue",
        onboardingCompletedAt: new Date("2026-07-17T00:00:00.000Z")
      },
      email: "owner@example.com",
      username: "Owner",
      isDev: true,
      developerCapabilities: ["developer:world-mutate"]
    } as AuthenticatedSession & Record<string, unknown>;

    expect(developerCapabilitiesForSession(config, forged)).toEqual([]);
  });

  it("grants private leaderboard access only through both exact allowlists", () => {
    const allowed = loadConfig({
      NODE_ENV: "test",
      DEV_TOOLS_ENABLED: "true",
      DEV_AUTHORIZED_GOOGLE_SUBJECTS: OWNER_SUBJECT,
      DEV_PRIVATE_LEADERBOARD_GOOGLE_SUBJECTS: OWNER_SUBJECT
    });
    const privateOnly = loadConfig({
      NODE_ENV: "test",
      DEV_TOOLS_ENABLED: "true",
      DEV_PRIVATE_LEADERBOARD_GOOGLE_SUBJECTS: OWNER_SUBJECT
    });

    expect(developerCapabilitiesForSession(allowed, session(OWNER_SUBJECT)))
      .toContain("developer:leaderboards-private");
    expect(developerCapabilitiesForSession(allowed, session("ordinary-subject")))
      .not.toContain("developer:leaderboards-private");
    expect(developerCapabilitiesForSession(privateOnly, session(OWNER_SUBJECT)))
      .not.toContain("developer:leaderboards-private");
  });

  it("grants announcement management to the configured test-access owners", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: OWNER_SUBJECT
    });
    const capabilities = developerCapabilitiesForSession(config, session(OWNER_SUBJECT));
    expect(capabilities).toContain("developer:test-access-manage");
    expect(capabilities).toContain("developer:announcements-manage");
    expect(developerCapabilitiesForSession(config, session("ordinary-subject")))
      .not.toContain("developer:announcements-manage");
  });

  it("keeps production economy mutation off by default and preserves private development access", () => {
    const publicOwner = developerCapabilitiesForSession(publicConfig(), session(OWNER_SUBJECT));
    const privateOwner = developerCapabilitiesForSession(privateConfig(), session(OWNER_SUBJECT));

    expect(publicOwner).toContain("developer:assets-grant");
    expect(publicOwner).not.toContain("developer:economy-mutate");
    expect(privateOwner).toEqual([
      "developer:wiki-manage",
      "developer:observe",
      "developer:appearance-studio",
      "developer:world-mutate",
      "developer:assets-grant",
      "developer:packages-send",
      "developer:economy-mutate"
    ]);
  });

  it("grants production economy mutation only to the exact allowlisted provider subject", () => {
    const config = publicConfig(true);

    expect(developerCapabilitiesForSession(config, session(OWNER_SUBJECT))).toEqual([
      "developer:wiki-manage",
      "developer:observe",
      "developer:appearance-studio",
      "developer:world-mutate",
      "developer:assets-grant",
      "developer:packages-send",
      "developer:economy-mutate"
    ]);
    expect(developerCapabilitiesForSession(
      config,
      session("209876543210987654321")
    )).toEqual([]);
    expect(developerCapabilitiesForSession(config, session(null))).toEqual([]);
  });

  it("requires economy mutation for gold or mixed grants and asset grant for materials only", () => {
    expect(developmentAssetGrantCapability({
      materials: [{ itemId: "wood", quantity: "500" }]
    })).toBe("developer:assets-grant");
    expect(developmentAssetGrantCapability({ gold: "1000" })).toBe(
      "developer:economy-mutate"
    );
    expect(developmentAssetGrantCapability({ cityCoins: "1000" })).toBe(
      "developer:economy-mutate"
    );
    expect(developmentAssetGrantCapability({
      gold: "10000",
      materials: [{ itemId: "wood", quantity: "500" }]
    })).toBe("developer:economy-mutate");
  });

  it("allows premium currency grants only with economy mutation authority", () => {
    for (const grant of [{ glimmer: "1000" }, { lumen: "1000" }]) {
      const capability = developmentAssetGrantCapability(grant);
      expect(capability).toBe("developer:economy-mutate");
      // Allowed: private developer runtime with an authorized developer.
      expect(developerCapabilitiesForSession(privateConfig(), session(OWNER_SUBJECT)))
        .toContain(capability);
      // Denied: public runtime without the production economy flag, and any
      // non-allowlisted player even when the flag is on.
      expect(developerCapabilitiesForSession(publicConfig(), session(OWNER_SUBJECT)))
        .not.toContain(capability);
      expect(developerCapabilitiesForSession(publicConfig(true), session("ordinary-subject")))
        .not.toContain(capability);
    }
  });

  it("defaults empty configuration to no grants and validates exact allowlist values", () => {
    const empty = loadConfig({
      NODE_ENV: "test",
      DEV_TOOLS_ENABLED: "true",
      DEV_ADMIN_TOOLS_ENABLED: "true"
    });
    expect(developerCapabilitiesForSession(empty, session(OWNER_SUBJECT))).toEqual([]);

    for (const value of [
      `${OWNER_SUBJECT},${OWNER_SUBJECT}`,
      `${OWNER_SUBJECT},`,
      ` ${OWNER_SUBJECT}, `,
      "subject with spaces",
      "subject\nwith-newline"
    ]) {
      expect(() => loadConfig({
        NODE_ENV: "test",
        DEV_AUTHORIZED_GOOGLE_SUBJECTS: value
      })).toThrow();
    }
  });

  it("records authorization and result audits without credentials or tokens", async () => {
    const config = publicConfig(true);
    const store = new InMemoryAuthStore();
    const credential = "sensitive-google-credential";
    const verifier = new FakeGoogleIdentityVerifier(new Map([
      [credential, identity(OWNER_SUBJECT, "owner@example.com")]
    ]));
    const service = new AuthService(
      config,
      store,
      verifier,
      { warn: vi.fn() } as never
    );
    const login = await service.loginWithGoogle(credential, context());

    await service.authorizeDeveloperCommand(login.session, {
      capability: "developer:economy-mutate",
      command: "assets.grant",
      transport: "websocket",
      target: "player-123",
      operationKey: "operation-123"
    });
    await service.recordDeveloperCommandResult(login.session, {
      capability: "developer:economy-mutate",
      command: "assets.grant",
      transport: "websocket",
      target: "player-123",
      operationKey: "operation-123",
      outcome: "succeeded"
    });

    const developerEvents = store.authEvents.filter(
      (event) => event.eventType.startsWith("developer_command_")
    );
    expect(developerEvents).toHaveLength(2);
    expect(developerEvents).toEqual([
      expect.objectContaining({
        accountId: login.session.account.id,
        eventType: "developer_command_authorization",
        metadata: expect.objectContaining({
          capability: "developer:economy-mutate",
          command: "assets.grant",
          transport: "websocket",
          outcome: "authorized",
          target: "player-123",
          operationKey: "operation-123",
          releaseSha: "f".repeat(40)
        })
      }),
      expect.objectContaining({
        accountId: login.session.account.id,
        eventType: "developer_command_result",
        metadata: expect.objectContaining({ outcome: "succeeded" })
      })
    ]);
    const serialized = JSON.stringify(developerEvents);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain(login.session.rawToken);
    expect(serialized).not.toContain(login.session.csrfToken);
  });
});

function publicConfig(productionEconomyMutationEnabled = false): AppConfig {
  return loadConfig({
    NODE_ENV: "production",
    AUTH_RUNTIME_MODE: "public",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "test-client-id",
    APP_PUBLIC_ORIGIN: "https://game.example",
    AUTH_ALLOWED_ORIGINS: "https://game.example",
    AUTH_TRUST_PROXY: "127.0.0.1,::1",
    AUTH_SESSION_TOKEN_HMAC_KEY: "session-key-aaaaaaaaaaaaaaaaaaaaaaaa",
    AUTH_DEVICE_TOKEN_HMAC_KEY: "device-key-bbbbbbbbbbbbbbbbbbbbbbbbb",
    AUTH_NETWORK_HMAC_KEY: "network-key-ccccccccccccccccccccccccc",
    INITIAL_SPAWN_HMAC_KEY: "spawn-key-dddddddddddddddddddddddddd",
    DOG_GENETICS_HMAC_KEY: "dog-genetics-key-eeeeeeeeeeeeeeeeeeee",
    TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: "test-access-admin-subject",
    ALLOW_UNRESOLVED_FLAGS_IN_DEV: "false",
    DEV_TOOLS_ENABLED: "true",
    DEV_ADMIN_TOOLS_ENABLED: "true",
    DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED: String(
      productionEconomyMutationEnabled
    ),
    DEV_AUTHORIZED_GOOGLE_SUBJECTS: OWNER_SUBJECT,
    RUNTIME_SHA: "f".repeat(40)
  });
}

function privateConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: "development",
    AUTH_RUNTIME_MODE: "local",
    AUTH_MODE: "dev",
    AUTH_DEV_LOGIN_ENABLED: "true",
    DEV_TOOLS_ENABLED: "true",
    DEV_ADMIN_TOOLS_ENABLED: "true",
    DEV_AUTHORIZED_GOOGLE_SUBJECTS: OWNER_SUBJECT
  });
}

function session(verifiedGoogleSubject: string | null): AuthenticatedSession {
  return {
    sessionId: "session-id",
    verifiedGoogleSubject,
    verifiedEmail: "owner@example.com",
    account: {
      id: "account-id",
      status: "active",
      trustTier: "new",
      riskScore: 0,
      testAccessStatus: "approved",
      testAccessRequestedAt: new Date("2026-07-17T00:00:00.000Z"),
      testAccessDecidedAt: new Date("2026-07-17T00:00:00.000Z"),
      createdAt: new Date("2026-07-17T00:00:00.000Z"),
      lastLoginAt: null
    },
    player: {
      id: "player-id",
      accountId: "account-id",
      displayName: "Owner",
      personalFlagColor: "blue",
      onboardingCompletedAt: new Date("2026-07-17T00:00:00.000Z")
    },
    deviceInstallationId: "device-id",
    csrfToken: "csrf-token"
  };
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
