import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import { AuthError, type AuthenticatedSession } from "../auth/types.js";
import { loadConfig } from "../config.js";
import {
  PlayerAnnouncementNotFoundError,
  type PlayerAnnouncementService
} from "../game/playerAnnouncements.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import { registerAnnouncementRoutes } from "./announcementRoutes.js";

const apps: FastifyInstance[] = [];
const announcementId = "22222222-2222-4222-8222-222222222222";
const announcement = { id: announcementId, title: "Welcome", message: "Hello", publishedAt: "2026-08-31T12:00:00.000Z" };
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("announcement routes", () => {
  it("rejects unauthenticated history before calling the service", async () => {
    const { app, service } = await createApp();
    const response = await app.inject({ method: "GET", url: "/api/announcements" });
    expect(response.statusCode).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("returns history to an ordinary authenticated gameplay-ready player", async () => {
    const { app, auth, service } = await createApp();
    const response = await app.inject({ method: "GET", url: "/api/announcements", headers: { cookie: "session=ordinary" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ announcements: [], latestAnnouncementId: null, latestAnnouncementDismissed: false });
    expect(auth.requireGameplayReady).toHaveBeenCalledOnce();
    expect(service.list).toHaveBeenCalledOnce();
    expect(service.list).toHaveBeenCalledWith("ordinary-player");
  });

  it("rejects missing origin or CSRF before owner publication", async () => {
    const { app, service } = await createApp();
    const missingOrigin = await app.inject({
      method: "POST", url: "/api/admin/announcements",
      headers: { cookie: "session=owner", "x-csrf-token": "owner-csrf" }, payload: validPublication()
    });
    const missingCsrf = await app.inject({
      method: "POST", url: "/api/admin/announcements",
      headers: { cookie: "session=owner", origin: "https://playashatlas.com" }, payload: validPublication()
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingCsrf.statusCode).toBe(403);
    expect(service.publish).not.toHaveBeenCalled();
  });

  it("denies an ordinary authenticated player without publication capability", async () => {
    const { app, service } = await createApp();
    const response = await app.inject({
      method: "POST", url: "/api/admin/announcements",
      headers: mutationHeaders("ordinary", "ordinary-csrf"), payload: validPublication()
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DEVELOPER_COMMAND_FORBIDDEN" } });
    expect(service.publish).not.toHaveBeenCalled();
  });

  it("authorizes, publishes as the account actor, and audits an owner request", async () => {
    const { app, auth, service, registry } = await createApp();
    const input = validPublication();
    const response = await app.inject({
      method: "POST", url: "/api/admin/announcements",
      headers: mutationHeaders("owner", "owner-csrf"), payload: input
    });
    expect(response.statusCode).toBe(200);
    expect(service.publish).toHaveBeenCalledWith("owner-player-account", input);
    expect(auth.authorizeDeveloperCommand).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ capability: "developer:announcements-manage", operationKey: input.operationKey }));
    expect(auth.recordDeveloperCommandResult).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ command: "announcements.publish", outcome: "succeeded" }));
    expect(registry.broadcast).toHaveBeenCalledWith({ type: "PLAYER_ANNOUNCEMENT_PUBLISHED", announcement });
  });

  it("broadcasts only a newly committed publication", async () => {
    const { app, service, registry } = await createApp();
    service.publish.mockResolvedValueOnce({ announcement, replayed: true });
    const response = await app.inject({ method: "POST", url: "/api/admin/announcements", headers: mutationHeaders("owner", "owner-csrf"), payload: validPublication() });
    expect(response.statusCode).toBe(200);
    expect(registry.broadcast).not.toHaveBeenCalled();
  });

  it("requires auth and CSRF, then idempotently dismisses for the session player", async () => {
    const { app, service } = await createApp();
    const url = `/api/announcements/${announcementId}/dismiss`;
    expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers: { cookie: "session=ordinary" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: mutationHeaders("ordinary", "ordinary-csrf") })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url, headers: mutationHeaders("ordinary", "ordinary-csrf") })).statusCode).toBe(200);
    expect(service.dismiss).toHaveBeenNthCalledWith(1, "ordinary-player", announcementId);
  });

  it("returns not found for an unknown announcement", async () => {
    const { app, service } = await createApp();
    service.dismiss.mockRejectedValueOnce(new PlayerAnnouncementNotFoundError());
    const response = await app.inject({
      method: "POST",
      url: `/api/announcements/${announcementId}/dismiss`,
      headers: mutationHeaders("ordinary", "ordinary-csrf")
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "ANNOUNCEMENT_NOT_FOUND" } });
  });
});

async function createApp() {
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const auth = authService();
  installAuthGuard(app, loadConfig({ NODE_ENV: "development", AUTH_MODE: "google", AUTH_RUNTIME_MODE: "public", GOOGLE_CLIENT_ID: "client-id" }), auth as unknown as AuthService);
  const service = {
    list: vi.fn(async () => ({ announcements: [], latestAnnouncementId: null, latestAnnouncementDismissed: false })),
    publish: vi.fn(async () => ({ announcement, replayed: false })),
    dismiss: vi.fn(async () => ({ announcementId, dismissed: true as const, dismissedAt: "2026-08-31T12:01:00.000Z" }))
  };
  const registry = { broadcast: vi.fn() };
  registerAnnouncementRoutes(app, auth as unknown as AuthService, service as unknown as PlayerAnnouncementService, registry as unknown as ConnectionRegistry);
  await app.ready();
  return { app, auth, service, registry };
}

function authService() {
  return {
    sessionCookieName: "session",
    authenticateSession: vi.fn(async (token: string | null) => token === "owner"
      ? session("owner-subject", "owner-player", "owner-csrf")
      : token === "ordinary" ? session("ordinary-subject", "ordinary-player", "ordinary-csrf") : null),
    assertOrigin: vi.fn((origin: string | undefined) => {
      if (origin !== "https://playashatlas.com") throw new AuthError("ORIGIN_FORBIDDEN", "Request origin is not allowed", 403);
    }),
    assertCsrf: vi.fn((authenticated: AuthenticatedSession, supplied: string | undefined) => {
      if (authenticated.csrfToken !== supplied) throw new AuthError("CSRF_INVALID", "Invalid CSRF token", 403);
    }),
    requireApprovedTestAccess: vi.fn(),
    requireGameplayReady: vi.fn(),
    authorizeDeveloperCommand: vi.fn(async (authenticated: AuthenticatedSession) => {
      if (authenticated.verifiedGoogleSubject !== "owner-subject") throw new Error("forbidden");
    }),
    recordDeveloperCommandResult: vi.fn(async () => {})
  };
}

function mutationHeaders(cookieValue: string, csrfToken: string) {
  return { cookie: `session=${cookieValue}`, origin: "https://playashatlas.com", "x-csrf-token": csrfToken };
}
function validPublication() {
  return { operationKey: "11111111-1111-4111-8111-111111111111", title: "Welcome", message: "Hello" };
}
function session(subject: string, playerId: string, csrfToken: string): AuthenticatedSession {
  return {
    account: { id: `${playerId}-account`, status: "active", trustTier: "trusted", riskScore: 0, testAccessStatus: "approved", testAccessRequestedAt: new Date(), testAccessDecidedAt: new Date(), createdAt: new Date(), lastLoginAt: new Date() },
    player: { id: playerId, accountId: `${playerId}-account`, displayName: playerId, personalFlagColor: "blue", onboardingCompletedAt: new Date() },
    sessionId: `${playerId}-session`, verifiedGoogleSubject: subject, verifiedEmail: `${playerId}@example.com`, deviceInstallationId: null, csrfToken
  };
}
