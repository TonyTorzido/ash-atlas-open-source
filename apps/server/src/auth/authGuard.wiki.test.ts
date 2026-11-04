import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { InMemoryAuthStore } from "../__tests__/authTestStore.js";
import { installAuthGuard } from "./authGuard.js";
import { AuthService } from "./authService.js";
import { FakeGoogleIdentityVerifier } from "./googleIdentity.js";
import type { TestAccessMode } from "@ash-atlas/shared";
import type { LoginRequestContext, VerifiedGoogleIdentity } from "./types.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const GATED_CONTENT_URLS = [
  "/api/wiki",
  "/api/wiki/getting-started",
  "/api/runtime-png/v2/manifest/chat-crest-lion",
  `/api/runtime-png/v2/blobs/${"a".repeat(64)}/${"b".repeat(64)}`
] as const;

describe("signed-in content GET auth guard policy", () => {
  it("rejects anonymous wiki and runtime art reads, and still protects wiki mutation", async () => {
    const { app } = await createHarness("open");
    for (const url of GATED_CONTENT_URLS) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error.code, url).toBe("AUTHENTICATION_REQUIRED");
    }
    const mutation = await app.inject({ method: "POST", url: "/api/wiki", payload: {} });
    expect(mutation.statusCode).toBe(401);
  });

  it("admits an approved account before onboarding and blocks a pending one in closed mode", async () => {
    const harness = await createHarness("closed");
    const approved = await harness.signIn("credential-approved", "approved");
    const pending = await harness.signIn("credential-pending", "pending");
    for (const url of GATED_CONTENT_URLS) {
      expect((await harness.get(url, approved)).statusCode, url).toBe(200);
      const blocked = await harness.get(url, pending);
      expect(blocked.statusCode, url).toBe(403);
      expect(blocked.json().error.code, url).toBe("TEST_ACCESS_PENDING");
    }
    // The non-onboarded approved account is still kept out of gameplay routes.
    expect((await harness.get("/api/gameplay-probe", approved)).statusCode).toBe(409);
  });

  it("admits a pending account in open mode", async () => {
    const harness = await createHarness("open");
    const pending = await harness.signIn("credential-pending", "pending");
    for (const url of GATED_CONTENT_URLS) {
      expect((await harness.get(url, pending)).statusCode, url).toBe(200);
    }
  });

  it("admits only developers and dev-list accounts in dev mode", async () => {
    const harness = await createHarness("dev");
    const developer = await harness.signIn("credential-developer", "pending");
    const approved = await harness.signIn("credential-approved", "approved");
    for (const url of GATED_CONTENT_URLS) {
      expect((await harness.get(url, developer)).statusCode, url).toBe(200);
      const blocked = await harness.get(url, approved);
      expect(blocked.statusCode, url).toBe(403);
      expect(blocked.json().error.code, url).toBe("TEST_ACCESS_DEV_ONLY");
    }
    harness.devList.add(harness.store.accountForSubject("subject-approved").id);
    for (const url of GATED_CONTENT_URLS) {
      expect((await harness.get(url, approved)).statusCode, url).toBe(200);
    }
  });
});

async function createHarness(mode: TestAccessMode) {
  const config = loadConfig({
    NODE_ENV: "development",
    AUTH_MODE: "google",
    AUTH_REQUIRED: "true",
    GOOGLE_CLIENT_ID: "test-client-id",
    DEV_AUTHORIZED_GOOGLE_SUBJECTS: "subject-developer"
  });
  const store = new InMemoryAuthStore();
  const devList = new Set<string>();
  const auth = new AuthService(
    config,
    store,
    new FakeGoogleIdentityVerifier(new Map([
      ["credential-developer", identity("subject-developer")],
      ["credential-approved", identity("subject-approved")],
      ["credential-pending", identity("subject-pending")]
    ])),
    { warn: vi.fn() } as never,
    undefined,
    {
      getAccessMode: async () => mode,
      hasDevAccess: async (accountId) => devList.has(accountId),
      recordDevAccessRequest: async () => undefined
    }
  );
  const app = Fastify(); apps.push(app);
  app.decorateRequest("cookies", {
    getter(this: { headers: Record<string, unknown> }) {
      const token = this.headers["x-test-session"];
      return typeof token === "string" ? { [auth.sessionCookieName]: token } : {};
    }
  });
  installAuthGuard(app, config, auth);
  app.get("/api/wiki", async () => ({ ok: true }));
  app.get("/api/wiki/:slug", async () => ({ ok: true }));
  app.post("/api/wiki", async () => ({ ok: true }));
  app.get("/api/runtime-png/v2/manifest/:registrationId", async () => ({ ok: true }));
  app.get("/api/runtime-png/v2/blobs/:packId/:sha256", async () => ({ ok: true }));
  app.get("/api/gameplay-probe", async () => ({ ok: true }));
  await app.ready();

  return {
    app,
    store,
    devList,
    async signIn(credential: string, status: "approved" | "pending"): Promise<string> {
      store.newAccountTestAccessStatus = status;
      return (await auth.loginWithGoogle(credential, context())).session.rawToken;
    },
    get(url: string, token: string) {
      return app.inject({ method: "GET", url, headers: { "x-test-session": token } });
    }
  };
}

function identity(subject: string): VerifiedGoogleIdentity {
  return {
    subject,
    email: `${subject}@example.com`,
    emailVerified: true,
    authTime: null,
    authMethods: null,
    expiresAt: new Date("2027-01-01T00:00:00.000Z")
  };
}

function context(): LoginRequestContext {
  return {
    ip: "203.0.113.42",
    userAgent: "Mozilla/5.0 Chrome/135.0 Windows NT 10.0",
    deviceToken: null,
    existingSessionToken: null
  } as LoginRequestContext;
}
