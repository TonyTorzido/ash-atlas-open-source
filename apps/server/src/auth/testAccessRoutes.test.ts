import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryAuthStore } from "../__tests__/authTestStore.js";
import { loadConfig } from "../config.js";
import { installAuthGuard } from "./authGuard.js";
import { registerAuthRoutes } from "./authRoutes.js";
import { AuthService } from "./authService.js";
import { FakeGoogleIdentityVerifier } from "./googleIdentity.js";
import type { OnboardingService } from "./onboardingService.js";
import { registerTestAccessRoutes } from "./testAccessRoutes.js";
import type { TestAccessService } from "./testAccessService.js";
import type { VerifiedGoogleIdentity } from "./types.js";

const TARGET_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("test-access admin HTTP routes", () => {
  it("does not expose the queue or allow self-approval to an ordinary user", async () => {
    const harness = await buildApp();
    const ordinary = await login(harness.app, "ordinary-token");
    const headers = mutationHeaders(ordinary);

    const list = await harness.app.inject({
      method: "GET",
      url: "/api/admin/test-access",
      headers: { cookie: headers.cookie }
    });
    const mutate = await harness.app.inject({
      method: "POST",
      url: `/api/admin/test-access/accounts/${ordinary.json().account.id}/approve`,
      headers,
      payload: {}
    });

    expect(list.statusCode).toBe(403);
    expect(mutate.statusCode).toBe(403);
    expect(list.body).not.toContain("pending-person@example.com");
    expect(harness.access.list).not.toHaveBeenCalled();
    expect(harness.access.decideAccount).not.toHaveBeenCalled();
    expect(harness.access.recordUnauthorizedAttempt).toHaveBeenCalledTimes(2);
  });

  it("requires origin and CSRF before a configured-subject administrator may mutate", async () => {
    const harness = await buildApp();
    const admin = await login(harness.app, "admin-token");
    const headers = mutationHeaders(admin);

    const missingOrigin = await harness.app.inject({
      method: "POST",
      url: "/api/admin/test-access/preapprove",
      headers: {
        cookie: headers.cookie,
        "x-csrf-token": headers["x-csrf-token"]
      },
      payload: { email: "future@example.com" }
    });
    const wrongCsrf = await harness.app.inject({
      method: "POST",
      url: "/api/admin/test-access/preapprove",
      headers: { ...headers, "x-csrf-token": "A".repeat(43) },
      payload: { email: "future@example.com" }
    });
    const accepted = await harness.app.inject({
      method: "POST",
      url: "/api/admin/test-access/preapprove",
      headers,
      payload: { email: "future@example.com" }
    });

    expect(missingOrigin.statusCode).toBe(403);
    expect(wrongCsrf.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    expect(harness.access.preapprove).toHaveBeenCalledOnce();
  });

  it("lists bounded private data for the exact admin subject and disconnects revocations", async () => {
    const harness = await buildApp();
    const admin = await login(harness.app, "admin-token");
    const headers = mutationHeaders(admin);

    const list = await harness.app.inject({
      method: "GET",
      url: "/api/admin/test-access?status=pending&page=1&pageSize=25&search=pending",
      headers: { cookie: headers.cookie }
    });
    const revoke = await harness.app.inject({
      method: "POST",
      url: `/api/admin/test-access/accounts/${TARGET_ACCOUNT_ID}/revoke`,
      headers,
      payload: {}
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      items: [{ verifiedEmail: "pending-person@example.com" }],
      page: 1,
      pageSize: 25,
      total: 1
    });
    expect(harness.access.list).toHaveBeenCalledWith({
      filter: "pending",
      search: "pending",
      page: 1,
      pageSize: 25
    });
    expect(revoke.statusCode).toBe(200);
    expect(harness.connections.finalizeAccountConnections).toHaveBeenCalledWith(
      TARGET_ACCOUNT_ID,
      4003,
      "TEST_ACCESS_REVOKED"
    );
  });

  it("reads and changes mode only for the authorized administrator", async () => {
    const harness = await buildApp();
    const admin = await login(harness.app, "admin-token");
    const ordinary = await login(harness.app, "ordinary-token");
    const adminHeaders = mutationHeaders(admin);
    const ordinaryHeaders = mutationHeaders(ordinary);

    const read = await harness.app.inject({
      method: "GET",
      url: "/api/admin/test-access/mode",
      headers: { cookie: adminHeaders.cookie }
    });
    const rejected = await harness.app.inject({
      method: "POST",
      url: "/api/admin/test-access/mode",
      headers: ordinaryHeaders,
      payload: { mode: "open" }
    });
    const changed = await harness.app.inject({
      method: "POST",
      url: "/api/admin/test-access/mode",
      headers: adminHeaders,
      payload: { mode: "open" }
    });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ mode: "closed" });
    expect(rejected.statusCode).toBe(403);
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ mode: "open" });
    expect(harness.access.setAccessMode).toHaveBeenCalledWith(
      expect.objectContaining({ account: expect.objectContaining({ testAccessStatus: "approved" }) }),
      "open"
    );
    // Opening up never needs to kick anyone.
    expect(harness.liveSessions.revalidateLiveSessions).not.toHaveBeenCalled();

    const dev = await harness.app.inject({
      method: "POST",
      url: "/api/admin/test-access/mode",
      headers: adminHeaders,
      payload: { mode: "dev" }
    });
    const unknown = await harness.app.inject({
      method: "POST",
      url: "/api/admin/test-access/mode",
      headers: adminHeaders,
      payload: { mode: "staff" }
    });
    expect(dev.statusCode).toBe(200);
    expect(dev.json()).toMatchObject({ mode: "dev" });
    expect(unknown.statusCode).toBe(400);
    expect(harness.liveSessions.revalidateLiveSessions).toHaveBeenCalledOnce();
    expect(harness.liveSessions.revalidateLiveSessions).toHaveBeenCalledWith();
  });

  it("lets only the administrator decide dev-list membership and kicks on removal", async () => {
    const harness = await buildApp();
    const admin = await login(harness.app, "admin-token");
    const ordinary = await login(harness.app, "ordinary-token");
    const adminHeaders = mutationHeaders(admin);

    const selfGrant = await harness.app.inject({
      method: "POST",
      url: `/api/admin/test-access/dev/accounts/${ordinary.json().account.id}/approve`,
      headers: mutationHeaders(ordinary),
      payload: {}
    });
    const approved = await harness.app.inject({
      method: "POST",
      url: `/api/admin/test-access/dev/accounts/${TARGET_ACCOUNT_ID}/approve`,
      headers: adminHeaders,
      payload: {}
    });
    const byEmail = await harness.app.inject({
      method: "POST",
      url: "/api/admin/test-access/dev/grant",
      headers: adminHeaders,
      payload: { email: "tester@example.com" }
    });
    expect(harness.liveSessions.revalidateLiveSessions).not.toHaveBeenCalled();
    const removed = await harness.app.inject({
      method: "POST",
      url: `/api/admin/test-access/dev/accounts/${TARGET_ACCOUNT_ID}/revoke`,
      headers: adminHeaders,
      payload: {}
    });

    expect(selfGrant.statusCode).toBe(403);
    expect(approved.statusCode).toBe(200);
    expect(byEmail.statusCode).toBe(200);
    expect(removed.statusCode).toBe(200);
    expect(harness.access.decideDevAccess).toHaveBeenCalledTimes(2);
    expect(harness.access.decideDevAccess).not.toHaveBeenCalledWith(
      expect.objectContaining({ account: expect.objectContaining({ id: ordinary.json().account.id }) }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(harness.access.grantDevAccessByEmail).toHaveBeenCalledWith(
      expect.anything(),
      "tester@example.com",
      null,
      null
    );
    expect(harness.liveSessions.revalidateLiveSessions).toHaveBeenCalledWith(TARGET_ACCOUNT_ID);
  });
});

async function buildApp() {
  const config = loadConfig({
    NODE_ENV: "development",
    AUTH_MODE: "google",
    AUTH_RUNTIME_MODE: "public",
    GOOGLE_CLIENT_ID: "client-id",
    TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: "admin-subject"
  });
  const store = new InMemoryAuthStore();
  const auth = new AuthService(
    config,
    store,
    new FakeGoogleIdentityVerifier(new Map([
      ["admin-token", identity("admin-subject", "admin@example.com")],
      ["ordinary-token", identity("ordinary-subject", "ordinary@example.com")]
    ])),
    { warn: vi.fn() } as never
  );
  const access = {
    getAccessMode: vi.fn(async () => "closed" as const),
    readAccessMode: vi.fn(async () => ({
      mode: "closed" as const,
      updatedAt: new Date(0).toISOString()
    })),
    setAccessMode: vi.fn(async (_actor, mode: "open" | "closed" | "dev") => ({
      mode,
      updatedAt: new Date(1).toISOString()
    })),
    list: vi.fn(async () => ({
      items: [{
        kind: "account" as const,
        accountId: TARGET_ACCOUNT_ID,
        verifiedEmail: "pending-person@example.com",
        status: "pending" as const,
        createdAt: new Date(0).toISOString(),
        lastLoginAt: null,
        requestedAt: new Date(0).toISOString(),
        decidedAt: null,
        playerName: null
      }],
      page: 1,
      pageSize: 25,
      total: 1,
      queryDurationMs: 1
    })),
    preapprove: vi.fn(async () => ({
      outcome: "grant_active" as const,
      grantId: "33333333-3333-4333-8333-333333333333",
      grantStatus: "active" as const
    })),
    decideAccount: vi.fn(async (
      _actor,
      accountId: string,
      action: "approve" | "deny" | "revoke" | "restore"
    ) => ({
      accountId,
      previousStatus: action === "revoke" ? "approved" as const : "pending" as const,
      status: action === "deny"
        ? "denied" as const
        : action === "revoke"
          ? "revoked" as const
          : "approved" as const
    })),
    revokeGrant: vi.fn(async (actor, grantId: string) => ({
      actor,
      grantId,
      status: "revoked" as const
    })),
    decideDevAccess: vi.fn(async (_actor, accountId: string, action: string) => ({
      accountId,
      previousStatus: null,
      status: action === "approve" ? "approved" as const : "revoked" as const
    })),
    grantDevAccessByEmail: vi.fn(async () => ({
      accountId: TARGET_ACCOUNT_ID,
      previousStatus: null,
      status: "approved" as const
    })),
    recordUnauthorizedAttempt: vi.fn(async () => undefined)
  } as unknown as TestAccessService & Record<string, ReturnType<typeof vi.fn>>;
  const connections = {
    finalizeAccountConnections: vi.fn(async () => undefined)
  };
  const onboarding = {
    complete: vi.fn()
  } as unknown as OnboardingService;
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  installAuthGuard(app, config, auth);
  registerAuthRoutes(app, auth, onboarding, config, connections);
  const liveSessions = {
    revalidateLiveSessions: vi.fn(async () => undefined)
  };
  registerTestAccessRoutes(app, auth, access, connections, liveSessions);
  await app.ready();
  return { app, access, connections, liveSessions };
}

async function login(app: FastifyInstance, credential: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/google",
    headers: { origin: "http://127.0.0.1:5173" },
    payload: { credential }
  });
  expect(response.statusCode).toBe(200);
  return response;
}

function mutationHeaders(response: Awaited<ReturnType<FastifyInstance["inject"]>>) {
  return {
    cookie: setCookieLines(response.headers["set-cookie"])
      .map((line) => line.split(";", 1)[0])
      .join("; "),
    origin: "http://127.0.0.1:5173",
    "x-csrf-token": response.json().csrfToken as string
  };
}

function setCookieLines(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : value ? [value] : [];
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
