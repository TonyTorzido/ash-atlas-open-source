import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "../auth/authService.js";
import type { AuthenticatedSession } from "../auth/types.js";
import type { LegendaryBirdEventService } from "../game/legendaryBirdEvents.js";
import { registerDeveloperLegendaryBirdRoutes } from "./developerLegendaryBirdRoutes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("developer legendary bird routes", () => {
  it("returns generic forbidden when world mutation is denied", async () => {
    const { app } = setup(false);
    const response = await app.inject({ method: "GET", url: "/api/dev/legendary-birds/players?search=Robin" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DEVELOPER_COMMAND_FORBIDDEN" } });
  });

  it("rejects and audits invalid trigger input", async () => {
    const { app, auth, service } = setup(true);
    const response = await app.inject({ method: "POST", url: "/api/dev/legendary-birds/trigger", payload: { playerId: "player-1", birdSpecies: "wind", operationKey: "bad" } });
    expect(response.statusCode).toBe(400);
    expect(service.triggerDeveloperEvent).not.toHaveBeenCalled();
    expect(auth.recordDeveloperCommandResult).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ command: "legendary-birds.trigger", outcome: "failed" }));
  });

  it("authorizes, audits, and returns a successful trigger", async () => {
    const { app, auth, service } = setup(true);
    const operationKey = "11111111-1111-4111-8111-111111111111";
    const response = await app.inject({ method: "POST", url: "/api/dev/legendary-birds/trigger", payload: { playerId: "player-1", birdSpecies: "fire", operationKey } });
    expect(response.statusCode).toBe(200);
    expect(service.triggerDeveloperEvent).toHaveBeenCalledWith({ playerId: "player-1", birdSpecies: "fire", operationKey });
    expect(auth.authorizeDeveloperCommand).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ capability: "developer:world-mutate", target: "player-1", operationKey }));
    expect(auth.recordDeveloperCommandResult).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ target: "player-1", operationKey, outcome: "succeeded" }));
  });
});

function setup(allowed: boolean) {
  const app = Fastify(); apps.push(app);
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => { request.authSession = session(); });
  const auth = { authorizeDeveloperCommand: vi.fn(async () => { if (!allowed) throw new Error("forbidden"); }), recordDeveloperCommandResult: vi.fn(async () => {}) };
  const service = {
    searchDeveloperPlayers: vi.fn(async () => ({ players: [] })),
    triggerDeveloperEvent: vi.fn(async () => ({ eventId: "event-1", playerId: "player-1", playerName: "Robin", flagId: "flag-1", birdSpecies: "fire", expiresAt: "2099-01-01T00:00:00.000Z", replayed: false }))
  };
  registerDeveloperLegendaryBirdRoutes(app, auth as unknown as AuthService, service as unknown as LegendaryBirdEventService);
  return { app, auth, service };
}

function session(): AuthenticatedSession {
  return { account: { id: "account", status: "active", trustTier: "trusted", riskScore: 0, testAccessStatus: "approved", testAccessRequestedAt: new Date(), testAccessDecidedAt: new Date(), createdAt: new Date(), lastLoginAt: new Date() }, player: { id: "owner", accountId: "account", displayName: "Owner", personalFlagColor: "blue", onboardingCompletedAt: new Date() }, sessionId: "session", verifiedGoogleSubject: "subject", verifiedEmail: "owner@example.com", deviceInstallationId: null, csrfToken: "csrf" };
}
