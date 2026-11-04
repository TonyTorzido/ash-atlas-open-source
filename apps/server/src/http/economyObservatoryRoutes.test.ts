import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../auth/authService.js";
import type { AuthenticatedSession } from "../auth/types.js";
import type { EconomyObservatoryService } from "../game/economyObservatory.js";
import { registerEconomyObservatoryRoutes } from "./economyObservatoryRoutes.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("economy observatory routes", () => {
  it("denies private reads without the observe capability", async () => {
    const { app } = setup(false);
    const response = await app.inject({ method: "GET", url: "/api/dev/economy/overview" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DEVELOPER_COMMAND_FORBIDDEN" } });
  });

  it("authorizes and audits a bounded read-only overview", async () => {
    const { app, auth, service } = setup(true);
    const response = await app.inject({ method: "GET", url: "/api/dev/economy/overview?window=7d" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ metadata: { snapshotAsOf: "now" }, scopes: [], flow: [], coverage: [], sessions: { connected: 0, active: 0, afk: 0, activePlayers: 0 } });
    expect(service.overview).toHaveBeenCalledWith("7d");
    expect(auth.authorizeDeveloperCommand).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ capability: "developer:observe", command: "economy.observatory.overview" }));
    expect(auth.recordDeveloperCommandResult).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "succeeded" }));
  });

  it("forwards server-side player pagination/search filters and keeps report private", async () => {
    const { app, service } = setup(true);
    const response = await app.inject({ method: "GET", url: "/api/dev/economy/players?page=2&pageSize=25&search=owner&activeOnly=false&activeGameplayHoursMin=2&activeGameplayHoursMax=8&sort=level&direction=asc" });
    expect(response.statusCode).toBe(200);
    expect(service.listPlayers).toHaveBeenCalledWith(expect.objectContaining({
      page: 2, pageSize: 25, search: "owner", activeOnly: false, activeGameplayHoursMin: 2, activeGameplayHoursMax: 8, sort: "level", direction: "asc"
    }));
    const reportResponse = await app.inject({ method: "GET", url: "/api/dev/economy/report?window=24h" });
    expect(reportResponse.statusCode).toBe(200);
    expect(service.report).toHaveBeenCalledWith("24h");
  });

  it("denies the item-holder explorer without the observe capability", async () => {
    const { app } = setup(false);
    const response = await app.inject({ method: "GET", url: "/api/dev/economy/item-holders?assetId=wood" });
    expect(response.statusCode).toBe(403);
  });

  it("forwards holder search, filters, sorting, and pagination after capability authorization", async () => {
    const { app, service } = setup(true);
    const response = await app.inject({ method: "GET", url: "/api/dev/economy/item-holders?assetId=wood&search=owner&page=2&pageSize=25&sort=percentile&direction=asc&activeOnly=false&levelMin=3&levelMax=20&activityCohort=1-3h&accountAgeCohort=7-30d" });
    expect(response.statusCode).toBe(200);
    expect(service.inspectItem).toHaveBeenCalledWith("wood", "existing_world_supply", "24h", expect.objectContaining({
      search: "owner", page: 2, pageSize: 25, sort: "percentile", direction: "asc", activeOnly: false,
      levelMin: 3, levelMax: 20, activityCohort: "1-3h", accountAgeCohort: "7-30d"
    }));
  });
});

function setup(allowed: boolean): {
  app: FastifyInstance;
  auth: Pick<AuthService, "authorizeDeveloperCommand" | "recordDeveloperCommandResult">;
  service: Pick<EconomyObservatoryService, "overview" | "listItems" | "inspectItem" | "listPlayers" | "inspectPlayer" | "cohorts" | "flow" | "report" | "exportWorkbook">;
} {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => { request.authSession = session(); });
  const auth = {
    authorizeDeveloperCommand: vi.fn(async () => { if (!allowed) throw new Error("forbidden"); }),
    recordDeveloperCommandResult: vi.fn(async () => {})
  };
  const overview = { metadata: { snapshotAsOf: "now" }, scopes: [], flow: [], coverage: [], sessions: { connected: 0, active: 0, afk: 0, activePlayers: 0 } };
  const service = {
    overview: vi.fn(async () => overview),
    listItems: vi.fn(),
    inspectItem: vi.fn(),
    listPlayers: vi.fn(),
    inspectPlayer: vi.fn(),
    cohorts: vi.fn(),
    flow: vi.fn(),
    report: vi.fn(async () => ({ metadata: {}, items: [], sourceBreakdown: [], playerItemRows: [], cohorts: [], coverage: [], dataQuality: [] })),
    exportWorkbook: vi.fn()
  };
  registerEconomyObservatoryRoutes(app, auth as unknown as AuthService, service as unknown as EconomyObservatoryService);
  return {
    app,
    auth,
    service: service as unknown as Pick<EconomyObservatoryService, "overview" | "listItems" | "inspectItem" | "listPlayers" | "inspectPlayer" | "cohorts" | "flow" | "report" | "exportWorkbook">
  };
}

function session(): AuthenticatedSession {
  return {
    account: {
      id: "account", status: "active", trustTier: "trusted", riskScore: 0,
      testAccessStatus: "approved", testAccessRequestedAt: new Date(), testAccessDecidedAt: new Date(),
      createdAt: new Date(), lastLoginAt: new Date()
    },
    player: { id: "owner", accountId: "account", displayName: "Owner", personalFlagColor: "blue", onboardingCompletedAt: new Date() },
    sessionId: "session", verifiedGoogleSubject: "subject", verifiedEmail: "owner@example.com", deviceInstallationId: null, csrfToken: "csrf"
  };
}
