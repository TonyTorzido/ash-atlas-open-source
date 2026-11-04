import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../auth/authService.js";
import { AuthError, type AuthenticatedSession } from "../auth/types.js";
import { registerUpdateSubscriberRoutes, subscribersCsv } from "./updateSubscriberRoutes.js";
import type { UpdateSubscriberService } from "./updateSubscriberService.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const ALLOWED_ORIGIN = "https://playashatlas.com";

async function setup(options: { session?: AuthenticatedSession | null; adminAllowed?: boolean } = {}) {
  const app = Fastify();
  apps.push(app);
  await app.register(rateLimit, { global: false });
  const auth = {
    // Mirrors AuthService.assertOrigin: a native app request may arrive without an Origin header.
    assertOrigin: vi.fn((origin: string | undefined, trustedNativeClient = false) => {
      if (origin !== ALLOWED_ORIGIN && !(origin === undefined && trustedNativeClient)) throw new AuthError("ORIGIN_FORBIDDEN", "Request origin is not allowed", 403);
    }),
    networkHashForRequest: vi.fn((ip: string) => `v1:hash-of-${ip.length}`),
    authorizeDeveloperCommand: vi.fn(async () => {
      if (!options.adminAllowed) throw new Error("forbidden");
    }),
    recordDeveloperCommandResult: vi.fn(async () => undefined)
  };
  const subscribers = {
    subscribe: vi.fn(async () => undefined),
    list: vi.fn(async () => [
      {
        email: "a@example.com",
        source: "landing",
        userAgent: "Mozilla/5.0",
        createdAt: "2026-10-18T00:00:00.000Z",
        unsubscribedAt: null
      },
      {
        email: "b@example.com",
        source: null,
        userAgent: null,
        createdAt: "2026-10-18T01:00:00.000Z",
        unsubscribedAt: "2026-10-18T02:00:00.000Z"
      }
    ])
  };
  app.decorateRequest("authSession", null);
  app.addHook("preHandler", async (request) => {
    request.authSession = options.session ?? null;
  });
  registerUpdateSubscriberRoutes(
    app,
    auth as unknown as AuthService,
    subscribers as unknown as UpdateSubscriberService
  );
  return { app, auth, subscribers };
}

function subscribe(app: FastifyInstance, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/updates/subscribe",
    headers: { origin: ALLOWED_ORIGIN, "user-agent": "x".repeat(400), ...headers },
    payload: payload as Record<string, unknown>
  });
}

describe("update subscriber routes", () => {
  it("normalizes the email and passes source, user agent, and an IP hash (never the raw IP)", async () => {
    const { app, subscribers, auth } = await setup();
    const response = await subscribe(app, { email: "  Player@Example.COM ", source: "landing", website: "" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, message: "You're on the list." });
    expect(auth.networkHashForRequest).toHaveBeenCalledWith("127.0.0.1");
    expect(subscribers.subscribe).toHaveBeenCalledWith({
      email: "player@example.com",
      source: "landing",
      userAgent: "x".repeat(400),
      ipHash: "v1:hash-of-9"
    });
  });

  it("defaults the source to landing", async () => {
    const { app, subscribers } = await setup();
    await subscribe(app, { email: "a@example.com" });
    expect(subscribers.subscribe).toHaveBeenCalledWith(expect.objectContaining({ source: "landing" }));
  });

  it("rejects invalid, oversized, or unexpected input without storing it", async () => {
    const { app, subscribers } = await setup();
    for (const payload of [
      { email: "not-an-email" },
      { email: "" },
      { email: `${"a".repeat(250)}@example.com` },
      { email: "a@example.com", source: "bad source!" },
      { email: "a@example.com", extra: true }
    ]) {
      const response = await subscribe(app, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("UPDATES_EMAIL_INVALID");
    }
    expect(subscribers.subscribe).not.toHaveBeenCalled();
  });

  it("answers a filled honeypot with the normal reply and stores nothing", async () => {
    const { app, subscribers } = await setup();
    for (const payload of [
      { email: "bot@example.com", website: "https://spam.example" },
      { email: "not-an-email", website: "x" }
    ]) {
      const response = await subscribe(app, payload);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, message: "You're on the list." });
    }
    expect(subscribers.subscribe).not.toHaveBeenCalled();
  });

  it("returns the same reply for a repeat email", async () => {
    const { app, subscribers } = await setup();
    const first = await subscribe(app, { email: "repeat@example.com" });
    const second = await subscribe(app, { email: "REPEAT@example.com" });
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toBe(first.body);
    expect(subscribers.subscribe).toHaveBeenCalledTimes(2);
    expect(subscribers.subscribe).toHaveBeenLastCalledWith(expect.objectContaining({ email: "repeat@example.com" }));
  });

  it("rejects a foreign origin", async () => {
    const { app, subscribers } = await setup();
    const response = await subscribe(app, { email: "a@example.com" }, { origin: "https://evil.example" });
    expect(response.statusCode).toBe(403);
    expect(subscribers.subscribe).not.toHaveBeenCalled();
  });

  it("passes the native app header through to the origin check and accepts app sources", async () => {
    const { app, auth, subscribers } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/updates/subscribe",
      headers: { "x-ash-atlas-native-client": "capacitor-android" },
      payload: { email: "app@example.com", source: "app-android" }
    });
    expect(response.statusCode).toBe(200);
    expect(auth.assertOrigin).toHaveBeenCalledWith(undefined, true);
    expect(subscribers.subscribe).toHaveBeenCalledWith(expect.objectContaining({ source: "app-android" }));
    const spoofed = await app.inject({
      method: "POST",
      url: "/api/updates/subscribe",
      headers: { "x-ash-atlas-native-client": "something-else" },
      payload: { email: "app@example.com" }
    });
    expect(spoofed.statusCode).toBe(403);
  });

  it("reports storage failure without detail", async () => {
    const { app, subscribers } = await setup();
    subscribers.subscribe.mockRejectedValueOnce(new Error("db down"));
    const response = await subscribe(app, { email: "a@example.com" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("UPDATES_UNAVAILABLE");
  });

  it("rate limits each IP to five sign-ups a minute, honeypot hits included", async () => {
    const { app, subscribers } = await setup();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await subscribe(app, { email: `p${attempt}@example.com` })).statusCode).toBe(200);
    }
    expect((await subscribe(app, { email: "bot@example.com", website: "x" })).statusCode).toBe(200);
    const limited = await subscribe(app, { email: "p9@example.com" });
    expect(limited.statusCode).toBe(429);
    expect(subscribers.subscribe).toHaveBeenCalledTimes(4);
    const otherIp = await app.inject({
      method: "POST",
      url: "/api/updates/subscribe",
      remoteAddress: "10.0.0.2",
      headers: { origin: ALLOWED_ORIGIN },
      payload: { email: "other@example.com" }
    });
    expect(otherIp.statusCode).toBe(200);
  });

  it("denies the subscriber list without the admin capability", async () => {
    const signedOut = await setup();
    const denied = await signedOut.app.inject({ method: "GET", url: "/api/admin/updates/subscribers" });
    expect(denied.statusCode).toBe(403);
    expect(signedOut.subscribers.list).not.toHaveBeenCalled();

    const player = { player: { id: "p1" } } as unknown as AuthenticatedSession;
    const nonAdmin = await setup({ session: player, adminAllowed: false });
    const forbidden = await nonAdmin.app.inject({ method: "GET", url: "/api/admin/updates/subscribers" });
    expect(forbidden.statusCode).toBe(403);
    expect(nonAdmin.subscribers.list).not.toHaveBeenCalled();
  });

  it("returns count and list, or CSV, to an administrator and audits the read", async () => {
    const admin = { player: { id: "p1" } } as unknown as AuthenticatedSession;
    const { app, auth } = await setup({ session: admin, adminAllowed: true });
    const json = await app.inject({ method: "GET", url: "/api/admin/updates/subscribers" });
    expect(json.statusCode).toBe(200);
    expect(json.headers["cache-control"]).toBe("no-store");
    expect(json.json()).toMatchObject({ count: 2, active: 1 });
    expect(json.json().subscribers[0]).not.toHaveProperty("ipHash");
    expect(auth.authorizeDeveloperCommand).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ capability: "developer:test-access-manage", command: "updates.subscribers.read" })
    );
    expect(auth.recordDeveloperCommandResult).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ outcome: "succeeded" })
    );

    const csv = await app.inject({ method: "GET", url: "/api/admin/updates/subscribers?format=csv" });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toBe("email,source,created_at,unsubscribed_at,user_agent");
    expect(csv.body).toContain("a@example.com,landing,2026-10-18T00:00:00.000Z,,Mozilla/5.0");
  });

  it("neutralizes spreadsheet formulas and quotes CSV cells", () => {
    const csv = subscribersCsv([
      { email: "=cmd@example.com", source: "a,b", userAgent: 'say "hi"', createdAt: "t", unsubscribedAt: null }
    ]);
    expect(csv).toContain(`'=cmd@example.com,"a,b",t,,"say ""hi"""`);
  });
});
