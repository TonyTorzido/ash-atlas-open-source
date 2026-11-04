import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/types.js";
import type { AuthService } from "../auth/authService.js";
import { hasDeveloperCapability } from "../auth/developerAuthorization.js";
import { loadConfig, type AppConfig } from "../config.js";
import { registerCombatTelemetryRoutes } from "./combatTelemetryRoutes.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("development combat telemetry export", () => {
  it("exports only the authenticated player's recent summaries as JSON", async () => {
    const exportRecentForPlayer = vi.fn(async (playerId: string, limit: number) => JSON.stringify({
      schemaVersion: 1,
      playerId,
      summaries: [{ combatSessionId: "combat-1" }],
      limit
    }));
    const app = createApp(
      publicOwnerConfig(),
      authenticatedSession("player-session", "owner-subject"),
      exportRecentForPlayer
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/dev/combat-telemetry/recent?limit=12"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      playerId: "player-session",
      summaries: [{ combatSessionId: "combat-1" }],
      limit: 12
    });
    expect(exportRecentForPlayer).toHaveBeenCalledWith("player-session", 12);
  });

  it("requires an authenticated player and rejects client-supplied player IDs", async () => {
    const exportRecentForPlayer = vi.fn(async () => "{}");
    const unauthenticatedApp = createApp(
      publicOwnerConfig(),
      null,
      exportRecentForPlayer
    );

    const unauthenticated = await unauthenticatedApp.inject({
      method: "GET",
      url: "/api/dev/combat-telemetry/recent"
    });
    expect(unauthenticated.statusCode).toBe(403);
    expect(unauthenticated.json()).toMatchObject({
      error: { code: "DEVELOPER_COMMAND_FORBIDDEN" }
    });

    const authenticatedApp = createApp(
      publicOwnerConfig(),
      authenticatedSession("canonical-player", "owner-subject"),
      exportRecentForPlayer
    );
    const spoofed = await authenticatedApp.inject({
      method: "GET",
      url: "/api/dev/combat-telemetry/recent?playerId=spoofed-player"
    });
    expect(spoofed.statusCode).toBe(400);
    expect(spoofed.json()).toMatchObject({
      error: { code: "BAD_COMBAT_TELEMETRY_QUERY" }
    });
    expect(exportRecentForPlayer).not.toHaveBeenCalled();
  });

  it("rejects an ordinary public player while allowing the exact owner to observe", async () => {
    const exportRecentForPlayer = vi.fn(async () => "{}");
    const config = publicOwnerConfig();
    const ordinaryApp = createApp(
      config,
      authenticatedSession("ordinary-player", "ordinary-subject"),
      exportRecentForPlayer
    );

    const rejected = await ordinaryApp.inject({
      method: "GET",
      url: "/api/dev/combat-telemetry/recent"
    });

    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({
      error: { code: "DEVELOPER_COMMAND_FORBIDDEN" }
    });
    expect(exportRecentForPlayer).not.toHaveBeenCalled();

    const ownerApp = createApp(
      config,
      authenticatedSession("owner-player", "owner-subject"),
      exportRecentForPlayer
    );
    expect((await ownerApp.inject({
      method: "GET",
      url: "/api/dev/combat-telemetry/recent"
    })).statusCode).toBe(200);
  });
});

function createApp(
  config: AppConfig,
  session: AuthenticatedSession | null,
  exportRecentForPlayer: (playerId: string, limit: number) => Promise<string>
): ReturnType<typeof Fastify> {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => {
    request.authSession = session;
  });
  registerCombatTelemetryRoutes(
    app,
    config,
    { exportRecentForPlayer },
    { warn: vi.fn() },
    {
      authorizeDeveloperCommand: vi.fn(async (authenticated, input) => {
        if (!hasDeveloperCapability(config, authenticated, input.capability)) {
          throw new Error("forbidden");
        }
      })
    } as unknown as AuthService
  );
  return app;
}

function authenticatedSession(
  playerId: string,
  verifiedGoogleSubject: string
): AuthenticatedSession {
  return {
    sessionId: "session-1",
    verifiedGoogleSubject,
    verifiedEmail: "owner@example.com",
    account: {
      id: "account-1",
      status: "active",
      trustTier: "standard",
      riskScore: 0,
      testAccessStatus: "approved",
      testAccessRequestedAt: new Date("2026-01-01T00:00:00.000Z"),
      testAccessDecidedAt: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastLoginAt: null
    },
    player: {
      id: playerId,
      accountId: "account-1",
      displayName: "Telemetry Tester",
      personalFlagColor: "blue",
      onboardingCompletedAt: new Date("2026-01-01T00:00:00.000Z")
    },
    deviceInstallationId: null,
    csrfToken: "csrf-token"
  };
}

function publicOwnerConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    AUTH_RUNTIME_MODE: "public",
    AUTH_MODE: "google",
    DEV_TOOLS_ENABLED: "true",
    DEV_ADMIN_TOOLS_ENABLED: "true",
    DEV_AUTHORIZED_GOOGLE_SUBJECTS: "owner-subject"
  });
}
