import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrustAdminAlertView } from "@ash-atlas/shared";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import type { TrustAdminOps } from "../auth/trust/trustAdminOps.js";
import type { TrustAdminStore } from "../auth/trust/trustStore.js";
import { AuthError, type AuthenticatedSession } from "../auth/types.js";
import type { AppConfig } from "../config.js";
import { registerDeveloperTrustRoutes } from "./developerTrustRoutes.js";

const apps: FastifyInstance[] = [];
const NOW = new Date("2026-10-02T00:00:00.000Z");
const ALERT_ID = "00000000-0000-4000-8000-000000000301";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000201";
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const ORIGIN = "http://127.0.0.1:5173";

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("developer trust admin routes", () => {
  it("denies every route without the test-access-manage capability", async () => {
    const { app, ops } = await setup({ allowed: false });
    const calls: Array<[string, string, object?]> = [
      ["GET", "/api/dev/trust/alerts"],
      ["POST", `/api/dev/trust/alerts/${ALERT_ID}/approve`],
      ["POST", `/api/dev/trust/accounts/${ACCOUNT_ID}/settle`],
      ["POST", `/api/dev/trust/accounts/${ACCOUNT_ID}/unsettle`],
      ["POST", `/api/dev/trust/accounts/${ACCOUNT_ID}/quarantine-arrivals`, { since: NOW.toISOString() }],
      ["GET", "/api/dev/trust/unanchored-routes"]
    ];
    for (const [method, url, payload] of calls) {
      const response = await app.inject({
        method: method as "GET" | "POST", url, headers: mutationHeaders(), ...(payload ? { payload } : {})
      });
      expect(response.statusCode, url).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "DEVELOPER_COMMAND_FORBIDDEN" } });
    }
    for (const fn of Object.values(ops)) expect(fn).not.toHaveBeenCalled();
  });

  it("refuses state-changing requests without a valid origin or CSRF token", async () => {
    const { app, ops } = await setup({ allowed: true });
    const url = `/api/dev/trust/alerts/${ALERT_ID}/lock`;
    const noCsrf = await app.inject({ method: "POST", url, headers: { origin: ORIGIN, cookie: "sid=ok" } });
    const badCsrf = await app.inject({
      method: "POST", url, headers: { origin: ORIGIN, cookie: "sid=ok", "x-csrf-token": "wrong" }
    });
    const badOrigin = await app.inject({
      method: "POST", url, headers: { origin: "https://evil.example", cookie: "sid=ok", "x-csrf-token": "csrf" }
    });
    expect([noCsrf.statusCode, badCsrf.statusCode, badOrigin.statusCode]).toEqual([403, 403, 403]);
    expect(ops.decideAlert).not.toHaveBeenCalled();

    const allowed = await app.inject({ method: "POST", url, headers: mutationHeaders() });
    expect(allowed.statusCode).toBe(200);
    expect(ops.decideAlert).toHaveBeenCalledWith(ALERT_ID, "lock", ADMIN_ID);
  });

  it("lists alerts with filters and pagination", async () => {
    const { app, ops, auth } = await setup({ allowed: true });
    const response = await app.inject({
      method: "GET",
      url: "/api/dev/trust/alerts?status=pending&kind=zone_red&limit=10&offset=20",
      headers: mutationHeaders()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      alerts: [alertView()], total: 41, limit: 10, offset: 20, generatedAt: NOW.toISOString()
    });
    expect(ops.listAlerts).toHaveBeenCalledWith({ status: "pending", kind: "zone_red", limit: 10, offset: 20 });
    expect(auth.recordDeveloperCommandResult).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ command: "trust.alerts.list", outcome: "succeeded" })
    );
    const invalid = await app.inject({
      method: "GET", url: "/api/dev/trust/alerts?status=bogus", headers: mutationHeaders()
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("maps alert decisions to responses and audits them", async () => {
    const { app, ops, auth } = await setup({ allowed: true });
    for (const action of ["approve", "lock", "dismiss"] as const) {
      const response = await app.inject({
        method: "POST", url: `/api/dev/trust/alerts/${ALERT_ID}/${action}`, headers: mutationHeaders()
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ alert: alertView(), generatedAt: NOW.toISOString() });
      expect(ops.decideAlert).toHaveBeenLastCalledWith(ALERT_ID, action, ADMIN_ID);
      expect(auth.authorizeDeveloperCommand).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ capability: "developer:test-access-manage", command: `trust.alerts.${action}`, target: ALERT_ID })
      );
    }
    ops.decideAlert.mockResolvedValueOnce({ outcome: "invalid_state", status: "locked" });
    const conflict = await app.inject({
      method: "POST", url: `/api/dev/trust/alerts/${ALERT_ID}/approve`, headers: mutationHeaders()
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "TRUST_ALERT_STATE_CONFLICT" } });
    ops.decideAlert.mockResolvedValueOnce({ outcome: "not_found" });
    const missing = await app.inject({
      method: "POST", url: `/api/dev/trust/alerts/${ALERT_ID}/dismiss`, headers: mutationHeaders()
    });
    expect(missing.statusCode).toBe(404);
    const unknownAction = await app.inject({
      method: "POST", url: `/api/dev/trust/alerts/${ALERT_ID}/reverse`, headers: mutationHeaders()
    });
    expect(unknownAction.statusCode).toBe(400);
    const notUuid = await app.inject({
      method: "POST", url: "/api/dev/trust/alerts/nope/approve", headers: mutationHeaders()
    });
    expect(notUuid.statusCode).toBe(400);
  });

  it("settles and unsettles through the settlement service result", async () => {
    const { app, ops } = await setup({ allowed: true });
    const unsettle = await app.inject({
      method: "POST", url: `/api/dev/trust/accounts/${ACCOUNT_ID}/unsettle`, headers: mutationHeaders()
    });
    expect(unsettle.statusCode).toBe(200);
    expect(unsettle.json()).toEqual({ accountId: ACCOUNT_ID, settlement: null, generatedAt: NOW.toISOString() });
    expect(ops.unsettle).toHaveBeenCalledWith(ACCOUNT_ID, ADMIN_ID);

    ops.settle.mockResolvedValueOnce("no_home");
    const noHome = await app.inject({
      method: "POST", url: `/api/dev/trust/accounts/${ACCOUNT_ID}/settle`, headers: mutationHeaders()
    });
    expect(noHome.statusCode).toBe(409);
    expect(noHome.json()).toMatchObject({ error: { code: "TRUST_NO_HOME" } });
    ops.settle.mockResolvedValueOnce("not_found");
    const missing = await app.inject({
      method: "POST", url: `/api/dev/trust/accounts/${ACCOUNT_ID}/settle`, headers: mutationHeaders()
    });
    expect(missing.statusCode).toBe(404);
  });

  it("runs quarantine as a dry run first and refuses a changed set on confirm", async () => {
    const { app, ops } = await setup({ allowed: true });
    const url = `/api/dev/trust/accounts/${ACCOUNT_ID}/quarantine-arrivals`;
    const since = "2026-10-01T00:00:00.000Z";
    const dry = await app.inject({ method: "POST", url, headers: mutationHeaders(), payload: { since } });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toEqual({ hostAccountId: ACCOUNT_ID, since, dryRun: true, guestCount: 3, suspendedCount: 0 });
    expect(ops.quarantineArrivals).toHaveBeenLastCalledWith(expect.objectContaining({
      hostAccountId: ACCOUNT_ID, confirm: false, adminAccountId: ADMIN_ID, since: new Date(since)
    }));

    const confirmed = await app.inject({
      method: "POST", url, headers: mutationHeaders(), payload: { since, confirm: true, expectedCount: 3 }
    });
    expect(confirmed.json()).toMatchObject({ dryRun: false, guestCount: 3, suspendedCount: 3 });
    expect(ops.quarantineArrivals).toHaveBeenLastCalledWith(expect.objectContaining({ confirm: true, expectedCount: 3 }));

    ops.quarantineArrivals.mockResolvedValueOnce({ outcome: "count_mismatch", actual: 5 });
    const changed = await app.inject({
      method: "POST", url, headers: mutationHeaders(), payload: { since, confirm: true, expectedCount: 3 }
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error: { code: "TRUST_QUARANTINE_CHANGED" } });

    const invalid = await app.inject({
      method: "POST", url, headers: mutationHeaders(), payload: { since: "yesterday" }
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("serves the unanchored-routes report", async () => {
    const { app, ops } = await setup({ allowed: true });
    const response = await app.inject({
      method: "GET", url: "/api/dev/trust/unanchored-routes?days=3&limit=5", headers: mutationHeaders()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      routes: [{
        destinationKind: "flag", destinationId: "f1", ownerAccountId: null, attempts: 4, travellers: 2,
        lastAttemptAt: NOW.toISOString()
      }],
      since: "2026-09-29T00:00:00.000Z",
      generatedAt: NOW.toISOString()
    });
    expect(ops.unanchoredRoutes).toHaveBeenCalledWith(3, 5);
  });
});

function alertView(): TrustAdminAlertView {
  return {
    id: ALERT_ID, accountId: ACCOUNT_ID, playerName: "Scout", kind: "zone_red", severity: 3, status: "pending",
    lat: -80.53, lon: 20.27, count: 2, details: { count: 2 }, allowanceExpiresAt: null, decidedAt: null,
    createdAt: NOW.toISOString()
  };
}

function mutationHeaders() {
  return { origin: ORIGIN, cookie: "sid=ok", "x-csrf-token": "csrf" };
}

async function setup(options: { allowed: boolean }) {
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const session = {
    sessionId: "s1",
    account: { id: ADMIN_ID, status: "active" },
    player: { id: "player-1" },
    csrfToken: "csrf"
  } as unknown as AuthenticatedSession;
  const auth = {
    sessionCookieName: "sid",
    authenticateSession: vi.fn(async (cookieValue: string | null) => (cookieValue === "ok" ? session : null)),
    assertOrigin: vi.fn((origin: string | undefined) => {
      if (origin !== ORIGIN) throw new AuthError("ORIGIN_FORBIDDEN", "Origin not allowed", 403);
    }),
    assertCsrf: vi.fn((_: unknown, token: string | undefined) => {
      if (token !== "csrf") throw new AuthError("CSRF_INVALID", "CSRF token invalid", 403);
    }),
    requireGameplayReady: vi.fn(async () => undefined),
    authorizeDeveloperCommand: vi.fn(async () => {
      if (!options.allowed) throw new Error("forbidden");
    }),
    recordDeveloperCommandResult: vi.fn(async () => undefined)
  };
  installAuthGuard(app, { AUTH_REQUIRED: true } as AppConfig, auth as unknown as AuthService);
  const ops = {
    listAlerts: vi.fn(async () => ({ alerts: [alertView()], total: 41 })),
    decideAlert: vi.fn(async (): Promise<Awaited<ReturnType<TrustAdminOps["decideAlert"]>>> =>
      ({ outcome: "ok", alert: alertView(), suspendedAccountIds: [] })),
    settle: vi.fn(async (): Promise<"ok" | "not_found" | "no_home"> => "ok"),
    unsettle: vi.fn(async (): Promise<"ok" | "not_found"> => "ok"),
    settlementView: vi.fn(async () => null),
    quarantineArrivals: vi.fn(async (input: { confirm: boolean }) => (
      input.confirm
        ? { outcome: "ok" as const, dryRun: false, guestCount: 3, suspendedCount: 3 }
        : { outcome: "ok" as const, dryRun: true, guestCount: 3, suspendedCount: 0 }
    ) as Awaited<ReturnType<TrustAdminOps["quarantineArrivals"]>>),
    unanchoredRoutes: vi.fn(async () => ({
      since: new Date("2026-09-29T00:00:00.000Z"),
      routes: [{
        destinationKind: "flag", destinationId: "f1", ownerAccountId: null, attempts: 4, travellers: 2,
        lastAttemptAt: NOW.toISOString()
      }]
    }))
  };
  const store: TrustAdminStore = {
    listTopAccounts: vi.fn(async () => []),
    accountDetail: vi.fn(async () => null)
  };
  registerDeveloperTrustRoutes(
    app, auth as unknown as AuthService, store, { TRUST_DECAY_TAU_DAYS: 7 }, () => NOW,
    ops as unknown as TrustAdminOps
  );
  await app.ready();
  return { app, auth, ops };
}
