import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrustAdminAccountSummary } from "@ash-atlas/shared";

import type { AuthService } from "../auth/authService.js";
import type { AuthenticatedSession } from "../auth/types.js";
import { registerDeveloperTrustRoutes } from "./developerTrustRoutes.js";

const apps: FastifyInstance[] = [];
const NOW = new Date("2026-10-01T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("developer trust routes", () => {
  it("denies accounts without the test-access-manage capability", async () => {
    const { app, store } = setup(false);
    const response = await app.inject({ method: "GET", url: "/api/dev/trust/accounts" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DEVELOPER_COMMAND_FORBIDDEN" } });
    expect(store.listTopAccounts).not.toHaveBeenCalled();
  });

  it("lists the top accounts for an allowed administrator", async () => {
    const { app, auth, store } = setup(true);
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/trust/accounts?limit=10&minLogodds=2"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accounts: [summary()], generatedAt: NOW.toISOString() });
    expect(store.listTopAccounts).toHaveBeenCalledWith({ limit: 10, minLogodds: 2, now: NOW, tauDays: 7 });
    expect(auth.authorizeDeveloperCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ capability: "developer:test-access-manage", command: "trust.accounts.list" })
    );
    expect(auth.recordDeveloperCommandResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "succeeded" })
    );
  });

  it("runs the Trust Lab dry run only for an allowed developer", async () => {
    const body = { lat: 39.74, lon: -104.99, platform: "android" };
    const denied = setup(false);
    const refused = await denied.app.inject({ method: "POST", url: "/api/dev/trust/lab/dry-run", payload: body });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: "DEVELOPER_COMMAND_FORBIDDEN" } });
    expect(denied.lab.dryRun).not.toHaveBeenCalled();

    const allowed = setup(true);
    const response = await allowed.app.inject({ method: "POST", url: "/api/dev/trust/lab/dry-run", payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ zone: "urban", runs: [] });
    expect(allowed.lab.dryRun).toHaveBeenCalledWith(expect.objectContaining({
      ...body,
      attestation: "pass",
      settled: "unsettled"
    }));
    expect(allowed.auth.authorizeDeveloperCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ capability: "developer:test-access-manage", command: "trust.lab.dry-run" })
    );

    const invalid = await allowed.app.inject({
      method: "POST",
      url: "/api/dev/trust/lab/dry-run",
      payload: { ...body, lat: 120 }
    });
    expect(invalid.statusCode).toBe(400);
    expect(allowed.lab.dryRun).toHaveBeenCalledTimes(1);
  });
});

function setup(allowed: boolean) {
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
  const store = {
    listTopAccounts: vi.fn(async () => [summary()]),
    accountDetail: vi.fn(async () => null)
  };
  const lab = {
    dryRun: vi.fn(async () => ({
      zone: "urban" as const,
      zoneGridLoaded: true,
      yellowOwners: 0,
      kingdomOwners: 0,
      runs: [],
      generatedAt: NOW.toISOString()
    }))
  };
  registerDeveloperTrustRoutes(
    app, auth as unknown as AuthService, store, { TRUST_DECAY_TAU_DAYS: 7 }, () => NOW, undefined, lab
  );
  return { app, auth, store, lab };
}

function summary(): TrustAdminAccountSummary {
  return {
    accountId: "00000000-0000-4000-8000-000000000201",
    playerName: "Scout",
    trustTier: "new",
    shadowTier: 3,
    effectiveLogodds: 9.5,
    decayedLogodds: 8,
    priorLogodds: 1.5,
    peakLogodds: 10,
    providers: ["google"],
    createdAt: "2026-09-01T00:00:00.000Z",
    lastSignalAt: "2026-09-30T00:00:00.000Z"
  };
}

function session(): AuthenticatedSession {
  return {
    player: { id: "player-1" }
  } as unknown as AuthenticatedSession;
}
