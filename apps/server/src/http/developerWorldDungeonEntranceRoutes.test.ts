import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../auth/authService.js";
import type { AuthenticatedSession } from "../auth/types.js";
import { registerDeveloperWorldDungeonEntranceRoutes } from "./developerWorldDungeonEntranceRoutes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("developer world dungeon entrance readout", () => {
  it("returns generic forbidden without the observe capability", async () => {
    const { app, entrances } = setup(false);
    const response = await app.inject({ method: "GET", url: "/api/dev/world-dungeon-entrances?playerId=player-1" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DEVELOPER_COMMAND_FORBIDDEN" } });
    expect(entrances.sitesNear).not.toHaveBeenCalled();
  });

  it("lists the rolled entrances near the player, hidden ones included, nearest first", async () => {
    const { app, auth, entrances } = setup(true);
    const response = await app.inject({ method: "GET", url: "/api/dev/world-dungeon-entrances?playerId=player-1&radiusM=30000" });
    expect(response.statusCode).toBe(200);
    expect(entrances.sitesNear).toHaveBeenCalledWith({ lat: 38, lon: -107 }, 30_000);
    expect(response.json().entrances.map((entry: { dungeonId: string; visible: boolean }) => [entry.dungeonId, entry.visible]))
      .toEqual([["fangrock_cavern", true], ["blightwood_grove", false]]);
    expect(auth.authorizeDeveloperCommand).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ capability: "developer:observe" }));
  });
});

function setup(allowed: boolean) {
  const app = Fastify(); apps.push(app);
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => { request.authSession = session(); });
  const auth = { authorizeDeveloperCommand: vi.fn(async () => { if (!allowed) throw new Error("forbidden"); }), recordDeveloperCommandResult: vi.fn(async () => {}) };
  const site = (dungeonId: string, lat: number, visible: boolean) => ({
    entranceId: `wde_1_1_1_${dungeonId}`, dungeonId, position: { lat, lon: -107 }, spawnAt: 0, expiresAt: 1, visible
  });
  const entrances = { sitesNear: vi.fn(async () => [site("blightwood_grove", 38.2, false), site("fangrock_cavern", 38.05, true)]) };
  const gameState = { getPlayer: vi.fn(() => ({ position: { lat: 38, lon: -107 } })) };
  registerDeveloperWorldDungeonEntranceRoutes(app, auth as unknown as AuthService, entrances, gameState as never);
  return { app, auth, entrances };
}

function session(): AuthenticatedSession {
  return { account: { id: "account", status: "active", trustTier: "trusted", riskScore: 0, testAccessStatus: "approved", testAccessRequestedAt: new Date(), testAccessDecidedAt: new Date(), createdAt: new Date(), lastLoginAt: new Date() }, player: { id: "owner", accountId: "account", displayName: "Owner", personalFlagColor: "blue", onboardingCompletedAt: new Date() }, sessionId: "session", verifiedGoogleSubject: "subject", verifiedEmail: "owner@example.com", deviceInstallationId: null, csrfToken: "csrf" };
}
