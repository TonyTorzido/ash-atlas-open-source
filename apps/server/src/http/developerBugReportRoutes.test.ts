import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../auth/authService.js";
import type { AuthenticatedSession } from "../auth/types.js";
import type { DeveloperBugReportListItem } from "../telemetry/service.js";
import { registerDeveloperBugReportRoutes } from "./developerBugReportRoutes.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("developer bug report routes", () => {
  it("denies accounts without developer observe capability", async () => {
    const { app } = setup(false);
    const response = await app.inject({ method: "GET", url: "/api/dev/bug-reports" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "DEVELOPER_COMMAND_FORBIDDEN" }
    });
  });

  it("returns durable report summaries only after capability authorization", async () => {
    const { app, auth, telemetry } = setup(true);
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/bug-reports?limit=10"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reports: [report()] });
    expect(telemetry.listBugReports).toHaveBeenCalledWith(10);
    expect(auth.authorizeDeveloperCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        capability: "developer:observe",
        command: "bug-reports.list"
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
  telemetry: { listBugReports: ReturnType<typeof vi.fn> };
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
  const telemetry = {
    listBugReports: vi.fn(async () => [report()])
  };
  registerDeveloperBugReportRoutes(
    app,
    auth as unknown as AuthService,
    telemetry
  );
  return { app, auth, telemetry };
}

function report(): DeveloperBugReportListItem {
  return {
    reportCode: "AA-ABC123",
    submittedAt: "2026-09-08T15:00:00.000Z",
    title: "Tree disappeared",
    category: "gameplay",
    description: "The tree vanished after harvesting.",
    expectedBehavior: "The tree should remain visible.",
    reproducibility: "sometimes",
    status: "new",
    releaseGeneration: "test/t1013",
    exportStatus: "pending"
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
