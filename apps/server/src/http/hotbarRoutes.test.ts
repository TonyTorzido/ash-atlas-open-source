import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOTBAR_PLAYER_SLOT_IDS,
  defaultHotbarSettings,
  type HotbarSettings
} from "@ash-atlas/shared";
import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthenticatedSession } from "../auth/types.js";
import { loadConfig } from "../config.js";
import { HotbarError, type HotbarService } from "../game/hotbar.js";
import { registerHotbarRoutes } from "./hotbarRoutes.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("hotbar profile routes", () => {
  it("requires auth, returns durable settings, and validates writes", async () => {
    const settings = defaultHotbarSettings();
    const service = {
      get: vi.fn(async () => settings),
      update: vi.fn(async (_playerId: string, input: { revision: number; slots: HotbarSettings["slots"] }) => ({
        revision: input.revision + 1,
        slots: input.slots
      }))
    };
    const { app } = await buildApp(service as unknown as HotbarService);
    expect((await app.inject({ method: "GET", url: "/api/profile/me/hotbar" })).statusCode).toBe(401);

    const read = await app.inject({ method: "GET", url: "/api/profile/me/hotbar?bindings=actions", headers: authHeaders() });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ hotbar: settings });

    const update = {
      revision: 0,
      slots: HOTBAR_PLAYER_SLOT_IDS.map((slotId) => ({ slotId, binding: null }))
    };
    const write = await app.inject({
      method: "PATCH",
      url: "/api/profile/me/hotbar?bindings=actions",
      headers: { ...authHeaders(), origin: "http://127.0.0.1:5173", "x-csrf-token": "csrf-player-a" },
      payload: update
    });
    expect(write.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith("player-a", update);

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/profile/me/hotbar",
      headers: { ...authHeaders(), origin: "http://127.0.0.1:5173", "x-csrf-token": "csrf-player-a" },
      payload: { ...update, slots: [...update.slots.slice(0, 5), { slotId: "core", binding: null }] }
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.update).toHaveBeenCalledOnce();
  });

  it("hides action slots from older clients and keeps them when those clients save", async () => {
    const withBuild: HotbarSettings = {
      ...defaultHotbarSettings(),
      revision: 3,
      slots: HOTBAR_PLAYER_SLOT_IDS.map((slotId) => ({
        slotId,
        binding: slotId === "right-4" ? { kind: "action", actionId: "anchor_build" } as const : null
      }))
    };
    const service = {
      get: vi.fn(async () => withBuild),
      update: vi.fn(async (_playerId: string, input: { revision: number; slots: HotbarSettings["slots"] }) => ({
        ...withBuild,
        revision: input.revision + 1,
        slots: input.slots
      }))
    };
    const { app } = await buildApp(service as unknown as HotbarService);
    const buildSlot = (hotbar: HotbarSettings) => hotbar.slots.find((slot) => slot.slotId === "right-4")?.binding;

    const legacyRead = await app.inject({ method: "GET", url: "/api/profile/me/hotbar", headers: authHeaders() });
    expect(buildSlot(legacyRead.json().hotbar)).toBeNull();
    const currentRead = await app.inject({ method: "GET", url: "/api/profile/me/hotbar?bindings=actions", headers: authHeaders() });
    expect(buildSlot(currentRead.json().hotbar)).toEqual({ kind: "action", actionId: "anchor_build" });

    // An older client saves the empty slot it was shown; the saved action survives.
    const legacyWrite = await app.inject({
      method: "PATCH",
      url: "/api/profile/me/hotbar",
      headers: { ...authHeaders(), origin: "http://127.0.0.1:5173", "x-csrf-token": "csrf-player-a" },
      payload: { revision: 3, slots: HOTBAR_PLAYER_SLOT_IDS.map((slotId) => ({ slotId, binding: null })) }
    });
    expect(legacyWrite.statusCode).toBe(200);
    expect(buildSlot({ ...withBuild, slots: service.update.mock.lastCall![1].slots })).toEqual({ kind: "action", actionId: "anchor_build" });
    expect(buildSlot(legacyWrite.json().hotbar)).toBeNull();

    // A current client can clear it deliberately.
    const currentWrite = await app.inject({
      method: "PATCH",
      url: "/api/profile/me/hotbar?bindings=actions",
      headers: { ...authHeaders(), origin: "http://127.0.0.1:5173", "x-csrf-token": "csrf-player-a" },
      payload: { revision: 4, slots: HOTBAR_PLAYER_SLOT_IDS.map((slotId) => ({ slotId, binding: null })) }
    });
    expect(currentWrite.statusCode).toBe(200);
    expect(buildSlot({ ...withBuild, slots: service.update.mock.lastCall![1].slots })).toBeNull();
  });

  it("surfaces a stale revision without allowing a caller to overwrite it", async () => {
    const service = {
      get: vi.fn(async () => defaultHotbarSettings()),
      update: vi.fn(async () => {
        throw new HotbarError("HOTBAR_CHANGED", "Your hotbar changed elsewhere.", 409);
      })
    };
    const { app } = await buildApp(service as unknown as HotbarService);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/profile/me/hotbar",
      headers: { ...authHeaders(), origin: "http://127.0.0.1:5173", "x-csrf-token": "csrf-player-a" },
      payload: {
        revision: 0,
        slots: HOTBAR_PLAYER_SLOT_IDS.map((slotId) => ({ slotId, binding: null }))
      }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "HOTBAR_CHANGED" } });
  });
});

async function buildApp(service: HotbarService): Promise<{ app: FastifyInstance }> {
  const config = loadConfig({ NODE_ENV: "development", AUTH_MODE: "dev" });
  const auth = {
    sessionCookieName: "aa_session_dev",
    authenticateSession: vi.fn(async (token: string | null) => token === "player-token" ? session() : null),
    assertOrigin: vi.fn(),
    assertCsrf: vi.fn(),
    requireApprovedTestAccess: vi.fn(),
    requireGameplayReady: vi.fn()
  };
  const app = Fastify({ trustProxy: true });
  apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  installAuthGuard(app, config, auth as never);
  registerHotbarRoutes(app, service, { warn: vi.fn() } as never);
  await app.ready();
  return { app };
}

function session(): AuthenticatedSession {
  return {
    sessionId: "session-player-a",
    verifiedEmail: "player-a@example.com",
    account: {} as AuthenticatedSession["account"],
    player: { id: "player-a" } as AuthenticatedSession["player"],
    deviceInstallationId: null,
    csrfToken: "csrf-player-a"
  };
}

function authHeaders(): Record<string, string> {
  return { cookie: "aa_session_dev=player-token", "x-forwarded-for": "198.51.100.2" };
}
