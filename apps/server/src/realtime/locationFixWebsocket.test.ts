import { parseServerMessage, type ClientMessage, type ServerMessage } from "@ash-atlas/shared";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import type { LocationReportService } from "../auth/trust/trustService.js";
import { loadConfig } from "../config.js";
import { CombatEngine } from "../game/combat/combatEngine.js";
import type { CombatProfileService } from "../game/combat/combatProfiles.js";
import type { DroppedItemService } from "../game/droppedItems.js";
import type { FlagService } from "../game/flags.js";
import type { PlayerService } from "../game/players.js";
import { GameState, type PlayerRecord } from "../game/state.js";
import type { TravelInviteService } from "../game/travelInvites.js";
import { createLogger } from "../logger.js";
import { ConnectionRegistry } from "./connectionRegistry.js";
import { registerRealtime } from "./websocket.js";
import { worldBootstrapLocationFixtures } from "./worldBootstrapTestFixtures.js";

describe("LOCATION_FIX over websocket connect/disconnect/reconnect", () => {
  it("records silent passive fixes per connection and reason window and keeps the socket open", async () => {
    const locationReports = {
      evaluate: vi.fn(async () => ({ verdict: "accepted", reason: null, holdUntil: null, holdReason: null })),
      record: vi.fn(async () => ({ reportId: "report-1", seq: 1 }))
    };
    const harness = await createHarness(locationReports as unknown as LocationReportService);
    const fix = {
      type: "LOCATION_FIX",
      lat: 35.0844,
      lon: -106.6504,
      accuracy: 40,
      deviceTimeZone: "America/Denver"
    } satisfies ClientMessage;
    try {
      const first = await harness.connect();
      await vi.waitFor(() => expect(first.inbox()).toBeDefined());
      const bootstrapFrames = first.messages.length;
      first.socket.send(JSON.stringify({ type: "LOCATION_FIX", lat: "bad", lon: null }));
      first.socket.send(JSON.stringify(fix));
      first.socket.send(JSON.stringify(fix));
      first.socket.send(JSON.stringify({ type: "PING", clientTime: Date.now() } satisfies ClientMessage));
      await vi.waitFor(() => expect(first.messages.some((message) => message.type === "PONG")).toBe(true));
      // The malformed fix consumed the window; nothing was recorded and nothing replied.
      expect(locationReports.record).not.toHaveBeenCalled();
      expect(first.messages.slice(bootstrapFrames).filter((message) =>
        message.type === "TRAVEL_RESULT" || message.type.endsWith("_ERROR")
      )).toEqual([]);
      expect(first.socket.readyState).toBe(first.socket.OPEN);
      first.socket.terminate();
      await vi.waitFor(() => expect(harness.registry.activeConnectionCount()).toBe(0));

      const second = await harness.connect();
      await vi.waitFor(() => expect(second.inbox()).toBeDefined());
      second.socket.send(JSON.stringify({ ...fix, reason: "periodic" }));
      second.socket.send(JSON.stringify(fix));
      second.socket.send(JSON.stringify({ ...fix, reason: "bogus" }));
      // Legacy pre_action shares the periodic window: dropped here.
      second.socket.send(JSON.stringify({ ...fix, reason: "pre_action" }));
      await vi.waitFor(() => expect(locationReports.record).toHaveBeenCalledTimes(1));
      expect(locationReports.evaluate).toHaveBeenCalledWith(expect.objectContaining({
        accountId: "account-1",
        playerId: "player-1",
        source: "passive",
        deviceTimeZone: "America/Denver",
        networkHash: "v1:n",
        fixReason: "periodic"
      }));
      second.socket.send(JSON.stringify({ type: "PING", clientTime: Date.now() } satisfies ClientMessage));
      await vi.waitFor(() => expect(second.messages.some((message) => message.type === "PONG")).toBe(true));
      expect(locationReports.record).toHaveBeenCalledTimes(1);
      expect(second.socket.readyState).toBe(second.socket.OPEN);
      second.socket.terminate();
      await vi.waitFor(() => expect(harness.registry.activeConnectionCount()).toBe(0));

      // Reconnect: a fresh connection has a fresh window, and a legacy pre_action fix is still accepted.
      const third = await harness.connect();
      await vi.waitFor(() => expect(third.inbox()).toBeDefined());
      third.socket.send(JSON.stringify({ ...fix, reason: "pre_action" }));
      third.socket.send(JSON.stringify({ ...fix, reason: "periodic" }));
      await vi.waitFor(() => expect(locationReports.record).toHaveBeenCalledTimes(2));
      expect(locationReports.evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ fixReason: "pre_action" }));
      expect(third.socket.readyState).toBe(third.socket.OPEN);
      third.socket.terminate();
    } finally {
      await harness.app.close();
    }
  });
});

async function createHarness(locationReports: LocationReportService) {
  const app = Fastify();
  const config = loadConfig({
    NODE_ENV: "test",
    RUNTIME_SHA: "a".repeat(40),
    TRUST_PASSIVE_FIX_ENABLED: "true"
  });
  const logger = createLogger("test");
  const registry = new ConnectionRegistry();
  const gameState = new GameState(config, logger);
  const playerService = {
    loadPlayer: vi.fn(async () => playerRecord()),
    markOnline: vi.fn(async () => undefined),
    persistPlayerSnapshot: vi.fn(async () => undefined),
    markOffline: vi.fn(async () => undefined),
    relocationStatus: vi.fn(async () => ({
      lastRelocatedAt: null,
      relocationAvailableAt: null,
      travelInviteAvailableAt: null,
      serverTime: Date.now()
    }))
  };
  const authService = {
    sessionCookieName: "aa_session_dev",
    assertOrigin: vi.fn(),
    authenticateSession: vi.fn(async () => ({
      sessionId: "session-1",
      account: {
        id: "account-1",
        status: "active",
        trustTier: "new",
        riskScore: 0,
        createdAt: new Date(),
        lastLoginAt: null
      },
      player: { id: "player-1", accountId: "account-1", displayName: "Ash" },
      deviceInstallationId: "device-1",
      csrfToken: "csrf"
    })),
    networkTelemetryForRequest: vi.fn(() => ({ networkHash: "v1:n", networkPrefixHash: "v1:p", keyVersion: "v1" })),
    recordConnectionEvent: vi.fn(async () => undefined),
    requireGameplayReady: vi.fn(),
    developerCapabilities: vi.fn(() => []),
    hasDeveloperCapability: vi.fn(() => false),
    authorizeDeveloperCommand: vi.fn(async () => {
      throw new Error("developer command forbidden");
    }),
    recordDeveloperCommandResult: vi.fn(async () => undefined)
  } as unknown as AuthService;
  const flagService = { listFlags: vi.fn(async () => []) } as unknown as FlagService;
  const droppedItems = {
    listActive: vi.fn(async () => []),
    listActiveInGameplayCircle: vi.fn(async () => [])
  } as unknown as DroppedItemService;
  const combat = new CombatEngine({ tickRateHz: 20 });
  const combatProfiles = {
    getOrCreate: vi.fn(async () => ({
      playerId: "player-1",
      maxHealth: 100,
      currentHealth: 100,
      baseAttackDamage: 10
    })),
    persistProfiles: vi.fn(async () => undefined)
  } as unknown as CombatProfileService;
  const travelInvites = {
    inboxForPlayer: vi.fn(async () => []),
    invalidateForInviter: vi.fn(async () => [])
  } as unknown as TravelInviteService;

  await app.register(cookie);
  installAuthGuard(app, config, authService);
  await registerRealtime({
    infrastructure: { app, registry, logger, config },
    authority: {
      gameState,
      flagService,
      playerService: playerService as unknown as PlayerService,
      auth: authService
    },
    capabilities: {
      ...worldBootstrapLocationFixtures(),
      droppedItems,
      combat,
      combatProfiles,
      travelInvites,
      locationReports
    },
    operations: {}
  });
  await app.ready();

  const connect = async () => {
    const socket = await app.injectWS("/ws", {
      headers: { origin: config.CLIENT_ORIGIN, cookie: "aa_session_dev=test-session" }
    });
    const messages: ServerMessage[] = [];
    // Every frame must parse with the shared client parser.
    socket.on("message", (data) => messages.push(parseServerMessage(data.toString())));
    socket.send(JSON.stringify({ type: "HELLO" } satisfies ClientMessage));
    return {
      socket,
      messages,
      inbox: () => messages.find(
        (message): message is Extract<ServerMessage, { type: "TRAVEL_INBOX_SNAPSHOT" }> =>
          message.type === "TRAVEL_INBOX_SNAPSHOT"
      )
    };
  };
  return { app, connect, registry };
}

function playerRecord(): PlayerRecord {
  return {
    playerId: "player-1",
    username: "Ash",
    displayColor: "#38bdf8",
    regionCode: "NM",
    position: { lat: 35.0844, lon: -106.6504 },
    anchor: { lat: 35.0844, lon: -106.6504 },
    moveLeashRadiusM: 900,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date("2026-07-21T00:00:00.000Z")
  };
}
