import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthenticatedSession } from "../auth/types.js";
import {
  ChatCrestError,
  type ChatCrestService
} from "../chat/chatCrestService.js";
import { registerChatCrestRoutes } from "./chatCrestRoutes.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Chat Crest HTTP authority", () => {
  it("requires an authenticated playable session before reading selection", async () => {
    const service = fakeService();
    const { app } = await buildApp(service);
    const response = await app.inject({ method: "GET", url: "/api/chat/crests" });
    expect(response.statusCode).toBe(401);
    expect(service.selectionFor).not.toHaveBeenCalled();
  });

  it("returns the server-owned starter selection", async () => {
    const service = fakeService();
    const { app } = await buildApp(service);
    const response = await app.inject({
      method: "GET",
      url: "/api/chat/crests",
      headers: authHeaders()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().equippedCrestId).toBe("leaf");
    expect(service.selectionFor).toHaveBeenCalledWith("player-a");
  });

  it("rejects unknown crest IDs without calling the mutation service", async () => {
    const service = fakeService();
    const { app } = await buildApp(service);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/chat/crests",
      headers: authHeaders(),
      payload: { crestId: "not-registered", extra: true }
    });
    expect(response.statusCode).toBe(400);
    expect(service.equip).not.toHaveBeenCalled();
  });

  it("passes only the authenticated player and registered crest to equip", async () => {
    const service = fakeService();
    const { app } = await buildApp(service);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/chat/crests",
      headers: authHeaders(),
      payload: { crestId: "stag" }
    });
    expect(response.statusCode).toBe(200);
    expect(service.equip).toHaveBeenCalledWith("player-a", "stag");
  });

  it("preserves an unavailable entitlement response without leaking internals", async () => {
    const service = fakeService();
    service.equip.mockRejectedValueOnce(
      new ChatCrestError("CHAT_CREST_NOT_AVAILABLE", "That chat crest is not available.", 409)
    );
    const { app } = await buildApp(service);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/chat/crests",
      headers: authHeaders(),
      payload: { crestId: "stag" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toEqual({
      code: "CHAT_CREST_NOT_AVAILABLE",
      message: "That chat crest is not available."
    });
  });
});

async function buildApp(service: ChatCrestService): Promise<{ app: FastifyInstance }> {
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const auth = {
    sessionCookieName: "session",
    authenticateSession: vi.fn(async (value: string | null) => value === "valid" ? session() : null),
    assertOrigin: vi.fn(),
    assertCsrf: vi.fn(),
    requireApprovedTestAccess: vi.fn(),
    requireGameplayReady: vi.fn()
  };
  installAuthGuard(app, { AUTH_REQUIRED: true } as never, auth as never);
  registerChatCrestRoutes(app, service);
  await app.ready();
  return { app };
}

function fakeService(): ChatCrestService & {
  selectionFor: ReturnType<typeof vi.fn>;
  equip: ReturnType<typeof vi.fn>;
} {
  return {
    selectionFor: vi.fn(async () => ({
      crests: [{ id: "leaf", label: "Leaf", assetKey: "chat-crests/leaf.png" }],
      equippedCrestId: "leaf"
    })),
    equip: vi.fn(async () => ({
      crests: [{ id: "leaf", label: "Leaf", assetKey: "chat-crests/leaf.png" }],
      equippedCrestId: "leaf"
    }))
  } as unknown as ChatCrestService & {
    selectionFor: ReturnType<typeof vi.fn>;
    equip: ReturnType<typeof vi.fn>;
  };
}

function session(): AuthenticatedSession {
  return {
    sessionId: "session-player-a",
    verifiedEmail: "player-a@example.com",
    account: {} as AuthenticatedSession["account"],
    player: { id: "player-a" } as AuthenticatedSession["player"],
    deviceInstallationId: null,
    csrfToken: "csrf"
  };
}

function authHeaders(): Record<string, string> {
  return {
    cookie: "session=valid",
    origin: "http://127.0.0.1:5173",
    "x-csrf-token": "csrf"
  };
}
