import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROFILE_API_CONTRACT_HEADER,
  PROFILE_API_CONTRACT_VERSION,
  publicProfileSchema,
  type PublicProfile
} from "@ash-atlas/shared";
import { installAuthGuard } from "../auth/authGuard.js";
import { AuthError, type AuthenticatedSession } from "../auth/types.js";
import { loadConfig } from "../config.js";
import { ProfileSocialError, type ProfileSocialService } from "../game/profiles.js";
import type { RecentPlayersService } from "../game/recentPlayers.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import {
  publishExpiredNeutralityRequests,
  registerProfileRoutes,
  SocialActionRateGate
} from "./profileRoutes.js";

const apps: FastifyInstance[] = [];
const PLAYER_A = "00000000-0000-4000-8000-00000000000a";
const PLAYER_B = "00000000-0000-4000-8000-00000000000b";

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("social action rate gate", () => {
  it("limits by authenticated player and action group", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const gate = new SocialActionRateGate();
    expect(gate.consume("p1", "friend_send", 2, 60_000)).toBe(true);
    expect(gate.consume("p1", "friend_send", 2, 60_000)).toBe(true);
    expect(gate.consume("p1", "friend_send", 2, 60_000)).toBe(false);
    expect(gate.consume("p2", "friend_send", 2, 60_000)).toBe(true);
    expect(gate.consume("p1", "block", 2, 60_000)).toBe(true);
  });

  it("expires idle buckets and never exceeds its configured key bound", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const gate = new SocialActionRateGate(2, 1_000);
    gate.consume("p1", "friend_send", 5, 60_000);
    gate.consume("p2", "friend_send", 5, 60_000);
    gate.consume("p3", "friend_send", 5, 60_000);
    expect(gate.size()).toBe(2);
    vi.advanceTimersByTime(61_001);
    gate.consume("p4", "friend_send", 5, 60_000);
    expect(gate.size()).toBe(1);
  });
});

describe("authenticated profile route lifecycle", () => {
  it("keeps legacy strict clients compatible while exposing appearance to version 2", async () => {
    const { app } = await buildProfileApp();
    const legacyResponse = await getOwnProfile(app, "token-a", "198.51.100.9");
    expect(legacyResponse.statusCode).toBe(200);
    const legacyProfile = legacyResponse.json().profile;
    expect(legacyProfile).not.toHaveProperty("appearance");
    expect(() => publicProfileSchema.omit({ appearance: true }).strict().parse(legacyProfile))
      .not.toThrow();

    const currentResponse = await app.inject({
      method: "GET",
      url: "/api/profile/me",
      headers: authHeaders("token-a", "198.51.100.9", {
        [PROFILE_API_CONTRACT_HEADER]: PROFILE_API_CONTRACT_VERSION
      })
    });
    expect(currentResponse.statusCode).toBe(200);
    expect(currentResponse.json().profile).toMatchObject({
      appearance: { revision: 1, bodyVariantId: "default" }
    });
  });

  it("publishes expiration updates to both online enemy endpoints", () => {
    const connections = { send: vi.fn() } as unknown as ConnectionRegistry;
    publishExpiredNeutralityRequests(connections, [{
      playerLowId: PLAYER_A,
      playerHighId: PLAYER_B,
      requesterId: PLAYER_A
    }]);
    expect(connections.send).toHaveBeenCalledWith(PLAYER_A, {
      type: "SOCIAL_STATE_CHANGED",
      playerId: PLAYER_B,
      message: "Neutrality request expired. You remain enemies."
    });
    expect(connections.send).toHaveBeenCalledWith(PLAYER_B, {
      type: "SOCIAL_STATE_CHANGED",
      playerId: PLAYER_A,
      message: "Neutrality request expired. You remain enemies."
    });
  });

  it("enforces one authenticated player's configured quota", async () => {
    const { app } = await buildProfileApp({ lookupMax: 2 });
    expect((await getOwnProfile(app, "token-a", "198.51.100.10")).statusCode).toBe(200);
    expect((await getOwnProfile(app, "token-a", "198.51.100.10")).statusCode).toBe(200);
    expect((await getOwnProfile(app, "token-a", "198.51.100.10")).statusCode).toBe(429);
  });

  it("gives two players sharing one IP independent quotas", async () => {
    const { app } = await buildProfileApp({ lookupMax: 1 });
    expect((await getOwnProfile(app, "token-a", "198.51.100.20")).statusCode).toBe(200);
    expect((await getOwnProfile(app, "token-a", "198.51.100.20")).statusCode).toBe(429);
    expect((await getOwnProfile(app, "token-b", "198.51.100.20")).statusCode).toBe(200);
  });

  it("does not let one player reset quota by changing IP", async () => {
    const { app } = await buildProfileApp({ lookupMax: 2 });
    expect((await getOwnProfile(app, "token-a", "198.51.100.30")).statusCode).toBe(200);
    expect((await getOwnProfile(app, "token-a", "198.51.100.31")).statusCode).toBe(200);
    expect((await getOwnProfile(app, "token-a", "198.51.100.32")).statusCode).toBe(429);
  });

  it("ignores forged body, query, and header identities for limiter keying", async () => {
    const { app } = await buildProfileApp({ lookupMax: 1, relationshipMax: 1 });
    const forged = await app.inject({
      method: "GET",
      url: `/api/profile/me?playerId=${PLAYER_B}`,
      headers: authHeaders("token-a", "198.51.100.40", {
        "x-player-id": PLAYER_B,
        "x-acting-player-id": PLAYER_B
      })
    });
    expect(forged.statusCode).toBe(200);
    expect((await getOwnProfile(app, "token-a", "198.51.100.41")).statusCode).toBe(429);

    const forgedBody = await app.inject({
      method: "POST",
      url: "/api/social/relationship",
      headers: mutationHeaders("token-a", "198.51.100.42"),
      payload: {
        targetPlayerId: PLAYER_B,
        action: "send_friend_request",
        actingPlayerId: PLAYER_B
      }
    });
    expect(forgedBody.statusCode).toBe(400);
    const afterForgedBody = await app.inject({
      method: "POST",
      url: "/api/social/relationship",
      headers: mutationHeaders("token-a", "198.51.100.43"),
      payload: { targetPlayerId: PLAYER_B, action: "send_friend_request" }
    });
    expect(afterForgedBody.statusCode).toBe(429);
  });

  it("enforces authenticated quotas on edit, relationship, and list routes", async () => {
    const { app } = await buildProfileApp({ editMax: 1, relationshipMax: 1, listMax: 1 });
    const edit = () => app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      headers: mutationHeaders("token-a", "198.51.100.45"),
      payload: { title: "Alpha Tester" }
    });
    expect((await edit()).statusCode).toBe(200);
    expect((await edit()).statusCode).toBe(429);

    const relationship = () => app.inject({
      method: "POST",
      url: "/api/social/relationship",
      headers: mutationHeaders("token-a", "198.51.100.45"),
      payload: { targetPlayerId: PLAYER_B, action: "send_friend_request" }
    });
    expect((await relationship()).statusCode).toBe(200);
    expect((await relationship()).statusCode).toBe(429);

    const list = () => app.inject({
      method: "GET",
      url: "/api/social/lists/friends",
      headers: authHeaders("token-a", "198.51.100.45")
    });
    expect((await list()).statusCode).toBe(200);
    expect((await list()).statusCode).toBe(429);
  });

  it("enforces session ownership and CSRF for mutations", async () => {
    const { app, service } = await buildProfileApp();
    const missingCsrf = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      headers: authHeaders("token-a", "198.51.100.50"),
      payload: { title: "Alpha Tester" }
    });
    expect(missingCsrf.statusCode).toBe(403);

    const forgedTarget = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      headers: mutationHeaders("token-a", "198.51.100.50"),
      payload: { title: "Alpha Tester", playerId: PLAYER_B }
    });
    expect(forgedTarget.statusCode).toBe(400);
    expect(service.updateProfile).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      headers: mutationHeaders("token-a", "198.51.100.50"),
      payload: { title: "Alpha Tester" }
    });
    expect(accepted.statusCode).toBe(200);
    expect(service.updateProfile).toHaveBeenCalledWith(PLAYER_A, { title: "Alpha Tester" });
  });

  it("rejects legacy body selection updates", async () => {
    const { app, service } = await buildProfileApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/profile/me",
      headers: mutationHeaders("token-a", "198.51.100.51"),
      payload: { bodyVariantId: "female" }
    });
    expect(response.statusCode).toBe(400);
    expect(service.updateProfile).not.toHaveBeenCalled();
  });

  it("cannot request another player's private lists", async () => {
    const { app, service } = await buildProfileApp();
    const forged = await app.inject({
      method: "GET",
      url: `/api/social/lists/friends?playerId=${PLAYER_B}`,
      headers: authHeaders("token-a", "198.51.100.60")
    });
    expect(forged.statusCode).toBe(400);
    expect(service.list).not.toHaveBeenCalled();

    const own = await app.inject({
      method: "GET",
      url: "/api/social/lists/friends",
      headers: authHeaders("token-a", "198.51.100.60")
    });
    expect(own.statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledWith(PLAYER_A, "friends", 0, 25);
  });

  it("loads only the authenticated player's durable social inbox", async () => {
    const { app, service } = await buildProfileApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/social/inbox",
      headers: authHeaders("token-b", "198.51.100.62")
    });
    expect(response.statusCode).toBe(200);
    expect(service.inbox).toHaveBeenCalledWith(PLAYER_B);
    expect(response.json()).toEqual({
      entries: [],
      pendingIncomingFriendRequestCount: 0
    });
  });

  it("derives Recent Players ownership only from the authenticated session", async () => {
    const { app, recentPlayers } = await buildProfileApp();
    const forged = await app.inject({
      method: "GET",
      url: `/api/social/recent?playerId=${PLAYER_B}`,
      headers: authHeaders("token-a", "198.51.100.61")
    });
    expect(forged.statusCode).toBe(400);
    expect(recentPlayers.list).not.toHaveBeenCalled();

    const own = await app.inject({
      method: "GET",
      url: "/api/social/recent?limit=30",
      headers: authHeaders("token-a", "198.51.100.61")
    });
    expect(own.statusCode).toBe(200);
    expect(recentPlayers.list).toHaveBeenCalledWith(PLAYER_A, 30);
    const summary = await app.inject({
      method: "GET",
      url: `/api/social/player/${PLAYER_B}`,
      headers: authHeaders("token-a", "198.51.100.61")
    });
    expect(summary.statusCode).toBe(200);
    expect(recentPlayers.summary).toHaveBeenCalledWith(PLAYER_A, PLAYER_B);
    expect((await app.inject({
      method: "POST",
      url: "/api/social/recent",
      headers: mutationHeaders("token-a", "198.51.100.61"),
      payload: { recentPlayerId: PLAYER_B }
    })).statusCode).toBe(404);
  });

  it("rejects malformed actions, targets, and pagination", async () => {
    const { app } = await buildProfileApp();
    const badAction = await app.inject({
      method: "POST",
      url: "/api/social/relationship",
      headers: mutationHeaders("token-a", "198.51.100.70"),
      payload: { targetPlayerId: PLAYER_B, action: "follow" }
    });
    expect(badAction.statusCode).toBe(400);
    const directEnemyRemoval = await app.inject({
      method: "POST",
      url: "/api/social/relationship",
      headers: mutationHeaders("token-a", "198.51.100.71"),
      payload: { targetPlayerId: PLAYER_B, action: "unmark_enemy" }
    });
    expect(directEnemyRemoval.statusCode).toBe(400);
    const badTarget = await app.inject({
      method: "POST",
      url: "/api/social/relationship",
      headers: mutationHeaders("token-a", "198.51.100.70"),
      payload: { targetPlayerId: "not-a-uuid", action: "block" }
    });
    expect(badTarget.statusCode).toBe(400);
    const badPage = await app.inject({
      method: "GET",
      url: "/api/social/lists/friends?limit=51",
      headers: authHeaders("token-a", "198.51.100.70")
    });
    expect(badPage.statusCode).toBe(400);
  });

  it("publishes bilateral enemy and neutrality state changes with recipient notifications", async () => {
    const { app, connections } = await buildProfileApp();
    for (const [action, message] of [
      ["mark_enemy", `${PLAYER_A} declared you an enemy.`],
      ["request_neutrality", `${PLAYER_A} has requested neutrality.`],
      ["accept_neutrality", `${PLAYER_A} accepted your neutrality request. You are now neutral.`],
      ["reject_neutrality", `${PLAYER_A} rejected your neutrality request. You remain enemies.`],
      ["cancel_neutrality", `${PLAYER_A} canceled the neutrality request. You remain enemies.`]
    ] as const) {
      connections.send.mockClear();
      const response = await app.inject({
        method: "POST",
        url: "/api/social/relationship",
        headers: mutationHeaders("token-a", `198.51.100.${80 + connections.send.mock.calls.length}`),
        payload: { targetPlayerId: PLAYER_B, action }
      });
      expect(response.statusCode).toBe(200);
      expect(connections.send).toHaveBeenCalledWith(PLAYER_B, {
        type: "SOCIAL_STATE_CHANGED",
        playerId: PLAYER_A,
        message
      });
      expect(connections.send).toHaveBeenCalledWith(PLAYER_A, {
        type: "SOCIAL_STATE_CHANGED",
        playerId: PLAYER_B
      });
    }
  });

  it("does not publish a false crossing-request notification for an idempotent neutrality request", async () => {
    const { app, service, connections } = await buildProfileApp();
    service.mutate.mockImplementationOnce(async (
      viewerId: string,
      targetId: string,
      _action: string,
      onCommitted?: (changed: boolean) => void
    ) => {
      onCommitted?.(false);
      return profile(targetId, viewerId);
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/social/relationship",
      headers: mutationHeaders("token-a", "198.51.100.90"),
      payload: { targetPlayerId: PLAYER_B, action: "request_neutrality" }
    });
    expect(response.statusCode).toBe(200);
    expect(connections.send).not.toHaveBeenCalled();
  });

  it("returns the same privacy-safe error regardless of block direction", async () => {
    const { app, service } = await buildProfileApp();
    service.mutate.mockRejectedValue(
      new ProfileSocialError("RELATIONSHIP_UNAVAILABLE", "This relationship action is unavailable", 409)
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/social/relationship",
      headers: mutationHeaders("token-a", "198.51.100.80"),
      payload: { targetPlayerId: PLAYER_B, action: "send_friend_request" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toMatch(/blocked by|blocker|blocked_id/i);
    expect(response.json()).toMatchObject({
      error: { code: "RELATIONSHIP_UNAVAILABLE", message: "This relationship action is unavailable" }
    });
  });
});

async function buildProfileApp(options: {
  lookupMax?: number;
  editMax?: number;
  relationshipMax?: number;
  listMax?: number;
} = {}) {
  const config = loadConfig({
    NODE_ENV: "development",
    AUTH_MODE: "dev",
    PROFILE_LOOKUP_RATE_MAX: String(options.lookupMax ?? 20),
    PROFILE_EDIT_RATE_MAX: String(options.editMax ?? 20),
    SOCIAL_RELATIONSHIP_RATE_MAX: String(options.relationshipMax ?? 20),
    SOCIAL_LIST_RATE_MAX: String(options.listMax ?? 20)
  });
  const sessions = new Map([
    ["token-a", session(PLAYER_A)],
    ["token-b", session(PLAYER_B)]
  ]);
  const auth = {
    sessionCookieName: "aa_session_dev",
    authenticateSession: vi.fn(async (token: string | null) => sessions.get(token ?? "") ?? null),
    assertOrigin: vi.fn((origin: string | undefined) => {
      if (origin !== "http://127.0.0.1:5173") {
        throw new AuthError("ORIGIN_FORBIDDEN", "Request origin is not allowed", 403);
      }
    }),
    assertCsrf: vi.fn((authenticated: AuthenticatedSession, token: string | undefined) => {
      if (token !== authenticated.csrfToken) {
        throw new AuthError("CSRF_INVALID", "Invalid CSRF token", 403);
      }
    }),
    requireApprovedTestAccess: vi.fn(),
    requireGameplayReady: vi.fn()
  };
  const service = {
    getProfile: vi.fn(async (viewerId: string, targetId: string) => profile(targetId, viewerId)),
    updateProfile: vi.fn(async (viewerId: string) => profile(viewerId, viewerId)),
    mutate: vi.fn(async (
      viewerId: string,
      targetId: string,
      _action: string,
      onCommitted?: (changed: boolean) => void
    ) => {
      onCommitted?.(true);
      return profile(targetId, viewerId);
    }),
    list: vi.fn(async (_viewerId: string, kind: string, offset: number, limit: number) => ({
      kind,
      entries: [],
      offset,
      limit,
      hasMore: false
    })),
    inbox: vi.fn(async () => ({
      entries: [],
      pendingIncomingFriendRequestCount: 0
    }))
  };
  const connections = { send: vi.fn() };
  const gameState = { setPlayerBodyVariant: vi.fn() };
  const recentPlayers = {
    list: vi.fn(async () => ({ entries: [] })),
    summary: vi.fn(async (_viewerId: string, targetPlayerId: string) => ({
      playerId: targetPlayerId,
      displayName: targetPlayerId,
      portrait: { kind: "player_sprite", displayColor: null },
      online: true,
      relationship: { friendship: "none", enemyMarkedByViewer: false }
    }))
  };
  const app = Fastify({ trustProxy: true });
  apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  installAuthGuard(app, config, auth as never);
  registerProfileRoutes(
    app,
    service as unknown as ProfileSocialService,
    config,
    connections as unknown as ConnectionRegistry,
    undefined,
    recentPlayers as unknown as RecentPlayersService,
    gameState as never
  );
  await app.ready();
  return { app, service, connections, recentPlayers, gameState };
}

function session(playerId: string): AuthenticatedSession {
  return {
    sessionId: `session-${playerId}`,
    verifiedEmail: `${playerId}@example.com`,
    account: {
      id: `account-${playerId}`,
      status: "active",
      trustTier: "standard",
      riskScore: 0,
      testAccessStatus: "approved",
      testAccessRequestedAt: new Date(0),
      testAccessDecidedAt: new Date(0),
      createdAt: new Date(0),
      lastLoginAt: null
    },
    player: {
      id: playerId,
      accountId: `account-${playerId}`,
      displayName: playerId,
      personalFlagColor: "blue",
      onboardingCompletedAt: new Date(0)
    },
    deviceInstallationId: null,
    csrfToken: `csrf-${playerId}`
  };
}

function profile(targetId: string, viewerId = PLAYER_A): PublicProfile {
  return {
    playerId: targetId,
    displayName: targetId,
    level: 0,
    portrait: { kind: "player_sprite", displayColor: null },
    appearance: {
      schemaVersion: 1,
      catalogRevision: 1,
      revision: 1,
      bodyVariantId: "default",
      poseId: "melee_idle",
      slots: {},
      activeHand: "melee"
    },
    title: null,
    biography: null,
    presence: "hidden",
    class: null,
    kingdom: null,
    settlement: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    isSelf: targetId === viewerId,
    relationship: { friendship: "none", enemyMarkedByViewer: false }
  };
}

function authHeaders(token: string, ip: string, extra: Record<string, string> = {}) {
  return {
    cookie: `aa_session_dev=${token}`,
    "x-forwarded-for": ip,
    ...extra
  };
}

function mutationHeaders(token: string, ip: string) {
  const playerId = token === "token-a" ? PLAYER_A : PLAYER_B;
  return authHeaders(token, ip, {
    origin: "http://127.0.0.1:5173",
    "x-csrf-token": `csrf-${playerId}`
  });
}

function getOwnProfile(app: FastifyInstance, token: string, ip: string) {
  return app.inject({ method: "GET", url: "/api/profile/me", headers: authHeaders(token, ip) });
}
