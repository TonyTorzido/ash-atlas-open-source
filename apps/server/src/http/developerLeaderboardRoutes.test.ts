import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../auth/authService.js";
import type { AuthenticatedSession } from "../auth/types.js";
import type { DeveloperLeaderboardService } from "../game/developerLeaderboards.js";
import { registerDeveloperLeaderboardRoutes } from "./developerLeaderboardRoutes.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("developer leaderboard routes", () => {
  it("returns the generic forbidden response when private capability is denied", async () => {
    const { app } = setup(false);
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/leaderboards/players?search=owner"
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "DEVELOPER_COMMAND_FORBIDDEN" }
    });
  });

  it("authorizes, audits, and returns bounded private leaderboard reads", async () => {
    const { app, auth, service } = setup(true);
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/leaderboards/players?search=owner"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      players: [{ playerId: "owner", displayName: "Owner", eligible: true }]
    });
    expect(service.searchPlayers).toHaveBeenCalledWith("owner");
    expect(auth.authorizeDeveloperCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        capability: "developer:leaderboards-private",
        command: "leaderboards.players.search"
      })
    );
    expect(auth.recordDeveloperCommandResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "succeeded" })
    );
  });
});

function setup(allowed: boolean): {
  app: FastifyInstance;
  auth: Pick<AuthService, "authorizeDeveloperCommand" | "recordDeveloperCommandResult">;
  service: Pick<DeveloperLeaderboardService, "searchPlayers" | "inspectPlayer" | "privateRanking">;
} {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => {
    request.authSession = session();
  });
  const auth = {
    authorizeDeveloperCommand: vi.fn(async () => {
      if (!allowed) throw new Error("forbidden");
    }),
    recordDeveloperCommandResult: vi.fn(async () => {})
  };
  const service = {
    searchPlayers: vi.fn(async () => ({
      players: [{ playerId: "owner", displayName: "Owner", eligible: true }]
    })),
    inspectPlayer: vi.fn(),
    privateRanking: vi.fn()
  };
  registerDeveloperLeaderboardRoutes(
    app,
    auth as unknown as AuthService,
    service as unknown as DeveloperLeaderboardService
  );
  return { app, auth, service };
}

function session(): AuthenticatedSession {
  return {
    account: {
      id: "account",
      status: "active",
      trustTier: "trusted",
      riskScore: 0,
      testAccessStatus: "approved",
      testAccessRequestedAt: new Date(),
      testAccessDecidedAt: new Date(),
      createdAt: new Date(),
      lastLoginAt: new Date()
    },
    player: {
      id: "owner",
      accountId: "account",
      displayName: "Owner",
      personalFlagColor: "blue",
      onboardingCompletedAt: new Date()
    },
    sessionId: "session",
    verifiedGoogleSubject: "subject",
    verifiedEmail: "owner@example.com",
    deviceInstallationId: null,
    csrfToken: "csrf"
  };
}
