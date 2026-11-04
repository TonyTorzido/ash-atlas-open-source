import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../auth/authService.js";
import type { AuthenticatedSession } from "../auth/types.js";
import type { UgcReport } from "../communitySafety.js";
import { registerDeveloperCommunitySafetyRoutes } from "./developerCommunitySafetyRoutes.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("developer community safety routes", () => {
  it("denies accounts without developer observe capability", async () => {
    const { app } = setup(false);
    const response = await app.inject({ method: "GET", url: "/api/dev/community-reports" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "DEVELOPER_COMMAND_FORBIDDEN" }
    });
  });

  it("returns the durable open report queue after authorization", async () => {
    const { app, auth, safety } = setup(true);
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/community-reports?limit=12"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reports: [report()] });
    expect(safety.listOpenReports).toHaveBeenCalledWith(12);
    expect(auth.authorizeDeveloperCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        capability: "developer:observe",
        command: "community-reports.list"
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
  safety: { listOpenReports: ReturnType<typeof vi.fn> };
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
  const safety = {
    listOpenReports: vi.fn(async () => [report()])
  };
  registerDeveloperCommunitySafetyRoutes(
    app,
    auth as unknown as AuthService,
    safety
  );
  return { app, auth, safety };
}

function report(): UgcReport {
  return {
    id: "00000000-0000-4000-8000-000000000100",
    reporterPlayerId: "00000000-0000-4000-8000-000000000001",
    target: {
      kind: "player",
      playerId: "00000000-0000-4000-8000-000000000002"
    },
    channelId: null,
    category: "harassment",
    explanation: "Repeated threats",
    status: "pending",
    createdAt: "2026-09-15T00:00:00.000Z"
  };
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
