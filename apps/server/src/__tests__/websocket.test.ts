import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ASH_ATLAS_CLIENT_RELEASE_QUERY_KEYS,
  ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
  ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_REASON,
  ASH_ATLAS_PROTOCOL_QUERY_KEYS,
  EQUIPMENT_BALANCE_VERSION,
  MAX_EQUIPMENT_LEVEL,
  distanceMeters,
  emptyEquipmentSlots,
  equipmentUpgradeCost,
  moveToward,
  requireEquipmentDefinition,
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats,
  type ClassSnapshot,
  type CitySnapshot,
  type ClientMessage,
  type DeveloperCapability,
  type EquipmentInstanceV2,
  type EquipmentSnapshotV2,
  type FlagSnapshot,
  type PlayerLocationSnapshot,
  type PlayerSnapshot,
  type ResourceVision,
  type ServerMessage
} from "@ash-atlas/shared";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { worldBootstrapLocationFixtures } from "../realtime/worldBootstrapTestFixtures.js";
import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import { AuthError } from "../auth/types.js";
import type { FlagService } from "../game/flags.js";
import { FlagAccessError, type FlagAccessService } from "../game/flagAccess.js";
import type { CollectibleService } from "../game/collectibles.js";
import type { CityService } from "../game/cities.js";
import { CombatEngine } from "../game/combat/combatEngine.js";
import type { CombatProfileService } from "../game/combat/combatProfiles.js";
import type { ClassService } from "../game/classes/classService.js";
import type { DroppedItemService } from "../game/droppedItems.js";
import type { DeveloperSpawnedMobService } from "../game/developerSpawnedMobs.js";
import type { EquipmentService } from "../game/equipment.js";
import type { HarvestSessionService } from "../game/harvestSessions.js";
import {
  ManorRuntime,
  type ManorPresenceService,
  type ManorStorageService
} from "../game/manor.js";
import { InMemoryPartyAuthority } from "../game/party/PartyAuthority.js";
import type { PetService } from "../game/petService.js";
import type { PlayerService } from "../game/players.js";
import type { ProgressionService } from "../game/progression.js";
import type { ResourceVisionJobQueue } from "../game/resourceVisionJobs.js";
import { GameState, type PlayerRecord } from "../game/state.js";
import { zoneIdForPosition } from "../game/spatialZones.js";
import { WorldRuntime } from "../game/worldRuntime.js";
import type { PlayerLocationService } from "../game/locations/playerLocationService.js";
import { PortalRegistry } from "../game/locations/portalRegistry.js";
import { createLogger } from "../logger.js";
import { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import {
  assertDevelopmentEconomyAccess,
  assertDevProgressionAccess,
  enforceClassRate,
  isDeveloperClassRateExempt,
  type PopulationV2RealtimeHooks,
  registerRealtime,
  safeSendServerMessage
} from "../realtime/websocket.js";

describe("realtime websocket", () => {
  it("keeps the legacy bare HELLO and WELCOME shape compatible", async () => {
    const harness = await createFlagTransitionHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true);
      });
      const welcome = harness.messages.find((message) => message.type === "WELCOME");
      expect(welcome).not.toHaveProperty("protocol");
      expect(welcome).toMatchObject({
        hunger: { current: 2_000, baseCapacity: 2_000 }
      });
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("negotiates advertised metadata without changing HELLO", async () => {
    const query = new URLSearchParams({
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.id]: "ash-atlas",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.minimum]: "3",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.maximum]: "3",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.capabilities]: "welcome-protocol-metadata"
    });
    const harness = await createFlagTransitionHarness({}, undefined, {
      websocketPath: `/ws?${query.toString()}`
    });
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true);
      });
      expect(harness.messages.find((message) => message.type === "WELCOME")).toMatchObject({
        protocol: {
          protocolId: "ash-atlas",
          version: 3,
          capabilities: ["welcome-protocol-metadata"]
        }
      });
      expect(harness.messages.find((message) => message.type === "WELCOME"))
        .not.toHaveProperty("releaseSha");
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("advertises release identity only to clients with the WELCOME release capability", async () => {
    const query = new URLSearchParams({
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.id]: "ash-atlas",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.minimum]: "3",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.maximum]: "3",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.capabilities]: [
        "welcome-protocol-metadata",
        "welcome-release-sha"
      ].join(",")
    });
    const harness = await createFlagTransitionHarness({ RUNTIME_SHA: "f".repeat(40) }, undefined, {
      websocketPath: `/ws?${query.toString()}`
    });
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true);
      });
      expect(harness.messages.find((message) => message.type === "WELCOME")).toMatchObject({
        releaseSha: "f".repeat(40),
        protocol: { capabilities: ["welcome-protocol-metadata", "welcome-release-sha"] }
      });
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("withholds scoped snapshots from clients without viewport flag loading", async () => {
    const query = new URLSearchParams({
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.id]: "ash-atlas",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.minimum]: "3",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.maximum]: "3",
      [ASH_ATLAS_PROTOCOL_QUERY_KEYS.capabilities]: [
        "welcome-protocol-metadata",
        "scoped-flag-snapshots"
      ].join(",")
    });
    const harness = await createFlagTransitionHarness({}, undefined, {
      websocketPath: `/ws?${query.toString()}`
    });
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true);
      });
      expect(harness.messages.find((message) => message.type === "WELCOME")).toMatchObject({
        protocol: {
          protocolId: "ash-atlas",
          version: 3,
          capabilities: ["welcome-protocol-metadata"]
        }
      });
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("closes malformed or unsupported advertised protocols before session bootstrap", async () => {
    for (const query of [
      `${ASH_ATLAS_PROTOCOL_QUERY_KEYS.id}=ash-atlas`,
      `${ASH_ATLAS_PROTOCOL_QUERY_KEYS.id}=ash-atlas&${ASH_ATLAS_PROTOCOL_QUERY_KEYS.minimum}=1&${ASH_ATLAS_PROTOCOL_QUERY_KEYS.maximum}=1&${ASH_ATLAS_PROTOCOL_QUERY_KEYS.capabilities}=`
    ]) {
      const harness = await createFlagTransitionHarness({}, undefined, {
        websocketPath: `/ws?${query}`
      });
      try {
        const closed = new Promise<{ code: number; reason: string }>((resolve) => {
          harness.socket.once("close", (code, reason) => resolve({
            code,
            reason: reason.toString()
          }));
        });
        const result = await closed;
        expect(result).toEqual({
          code: ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
          reason: ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_REASON
        });
        expect(harness.playerService.loadPlayer).not.toHaveBeenCalled();
        expect(harness.messages).toEqual([]);
      } finally {
        harness.socket.terminate();
        await harness.app.close();
      }
    }
  });

  // An identified outdated build is admitted for the update grace
  // (clientReleaseGate.test.ts); a client without an identity never is.
  it("refuses gameplay to an unidentified build, while the published client can connect", async () => {
    const releasePath = join(mkdtempSync(join(tmpdir(), "ash-atlas-release-")), "release.json");
    const publishedSha = "c".repeat(64);
    writeFileSync(releasePath, JSON.stringify({
      client_sha: publishedSha,
      clients: { web: { client_sha: publishedSha, min_protocol: 1 } },
      server_version: "d".repeat(40)
    }));
    const outdated = await createFlagTransitionHarness({ PUBLIC_RELEASE_METADATA_PATH: releasePath }, undefined, {
      websocketPath: "/ws"
    });
    try {
      const result = await new Promise<{ code: number; reason: string }>((resolve) => {
        outdated.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      expect(result).toEqual({
        code: ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
        reason: ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_REASON
      });
      expect(outdated.playerService.loadPlayer).not.toHaveBeenCalled();
    } finally {
      outdated.socket.terminate();
      await outdated.app.close();
    }

    const current = await createFlagTransitionHarness({ PUBLIC_RELEASE_METADATA_PATH: releasePath }, undefined, {
      websocketPath: `/ws?${ASH_ATLAS_CLIENT_RELEASE_QUERY_KEYS.clientSha}=${publishedSha}`
    });
    try {
      current.socket.send(hello());
      await vi.waitFor(() => {
        expect(current.messages.some((message) => message.type === "WELCOME")).toBe(true);
      });
    } finally {
      current.socket.terminate();
      await current.app.close();
    }
  });

  it("restores persisted manor presence with a fresh session and no world presence", async () => {
    const manorId = "11111111-1111-4111-8111-111111111111";
    const presence = {
      playerId: "player-1",
      manorId,
      ownerPlayerId: "player-1",
      accessSource: "OWNER" as const,
      admissionTravelInviteId: null,
      localPositionX: 500,
      localPositionY: 790,
      returnRegionCode: "NM",
      returnLat: 35.0844,
      returnLon: -106.6504
    };
    const manor = {
      manorId,
      ownerPlayerId: "player-1",
      ownerUsername: "Ash",
      regionCode: "NM",
      lat: 35.0844,
      lon: -106.6504,
      builtAt: "2026-07-24T00:00:00.000Z",
      placementRevision: 1
    };
    const manorPresence = {
      load: vi.fn(async () => presence),
      reconnectAllowed: vi.fn(async () => true),
      status: vi.fn(async () => manor),
      managementSnapshot: vi.fn(async () => ({
        manorId,
        guests: [],
        bannedPlayers: []
      }))
    } as unknown as ManorPresenceService;
    const manorStorage = {
      snapshotForPlayer: vi.fn(async () => ({
        manorId,
        unlockedSlots: 60 as const,
        stacks: [],
        equipment: [],
        slots: [],
        overflowStacks: []
      }))
    } as unknown as ManorStorageService;
    const manorRuntime = new ManorRuntime();
    const harness = await createFlagTransitionHarness({}, undefined, {
      manorPresence,
      manorStorage,
      manorRuntime,
      canonicalLocation: {
        kind: "interior",
        locationType: "manor",
        locationId: manorId,
        instanceId: `manor:${manorId}`,
        spaceId: "manor_main_room",
        regionCode: `interior:manor:${manorId}`,
        zoneId: `interior:manor:${manorId}:manor_main_room`,
        position: { x: 500, y: 790 },
        revision: 1,
        lastPortalId: "manor:entry"
      }
    });
    let replacement: Awaited<ReturnType<typeof harness.app.injectWS>> | null = null;
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.messages.some((message) => message.type === "MANOR_ENTERED")).toBe(true);
      });
      const first = harness.messages.find(
        (message): message is Extract<ServerMessage, { type: "MANOR_ENTERED" }> =>
          message.type === "MANOR_ENTERED"
      )!;
      expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true);
      expect(harness.gameState.isWorldPresent("player-1")).toBe(false);

      replacement = await harness.app.injectWS("/ws", { headers: harness.headers });
      const replacementMessages: ServerMessage[] = [];
      replacement.on("message", (data) => {
        replacementMessages.push(JSON.parse(data.toString()) as ServerMessage);
      });
      replacement.send(hello());
      await vi.waitFor(() => {
        expect(replacementMessages.some(
          (message) => message.type === "MANOR_ENTERED"
        )).toBe(true);
      });
      const restored = replacementMessages.find(
        (message): message is Extract<ServerMessage, { type: "MANOR_ENTERED" }> =>
          message.type === "MANOR_ENTERED"
      )!;
      expect(restored.manorSessionId).not.toBe(first.manorSessionId);
      expect(restored).toMatchObject({
        manorId,
        accessSource: "OWNER",
        storage: { manorId, unlockedSlots: 60 }
      });
      expect(replacementMessages.some((message) => message.type === "WELCOME")).toBe(true);
      expect(harness.gameState.isWorldPresent("player-1")).toBe(false);
      expect(() => manorRuntime.requireSession(
        "player-1",
        first.manorSessionId
      )).toThrow(expect.objectContaining({ code: "STALE_SESSION" }));
    } finally {
      replacement?.terminate();
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("ejects invalid persisted manor presence and completes world bootstrap", async () => {
    const presence = {
      playerId: "player-1",
      manorId: "11111111-1111-4111-8111-111111111111",
      ownerPlayerId: "player-1",
      accessSource: "OWNER" as const,
      admissionTravelInviteId: null,
      returnRegionCode: "NM",
      returnLat: 35.0844,
      returnLon: -106.6504
    };
    const manorPresence = {
      load: vi.fn(async () => presence),
      reconnectAllowed: vi.fn(async () => false),
      exit: vi.fn(async () => presence),
      status: vi.fn(async () => null),
      listBuiltNear: vi.fn(async () => [])
    } as unknown as ManorPresenceService;
    const harness = await createFlagTransitionHarness({}, undefined, {
      manorPresence,
      manorStorage: {} as ManorStorageService,
      manorRuntime: new ManorRuntime(),
      canonicalLocation: {
        kind: "interior", locationType: "manor", locationId: presence.manorId,
        instanceId: `manor:${presence.manorId}`, spaceId: "manor_main_room",
        regionCode: `interior:manor:${presence.manorId}`,
        zoneId: `interior:manor:${presence.manorId}:manor_main_room`,
        position: { x: 500, y: 790 }, revision: 1, lastPortalId: "manor:entry"
      }
    });
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.messages.some(
          (message) =>
            message.type === "MANOR_ERROR" &&
            message.code === "MANOR_RESTORE_FALLBACK"
        )).toBe(true);
      });
      expect(manorPresence.exit).toHaveBeenCalledWith("player-1");
      expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true);
      expect(harness.messages.some((message) => message.type === "PLAYER_SNAPSHOT")).toBe(true);
      expect(harness.messages.some((message) => message.type === "MANOR_ENTERED")).toBe(false);
      expect(harness.gameState.isWorldPresent("player-1")).toBe(true);
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("keeps a manor jump inside Resource Vision for the next collectible request", async () => {
    const manorId = "11111111-1111-4111-8111-111111111111";
    const manor = {
      manorId,
      ownerPlayerId: "player-1",
      ownerUsername: "Ash",
      regionCode: "NM",
      lat: 35.09,
      lon: -106.66,
      builtAt: "2026-07-24T00:00:00.000Z",
      placementRevision: 7
    };
    const manorPresence = {
      load: vi.fn(async () => null),
      status: vi.fn(async () => manor),
      listBuiltNear: vi.fn(async () => [manor]),
      builtManor: vi.fn(async () => manor),
      completedJump: vi.fn(async () => false),
      completeJump: vi.fn(async () => undefined)
    } as unknown as ManorPresenceService;
    const harness = await createFlagTransitionHarness({}, undefined, {
      manorPresence,
      player: { ...playerRecord(), moveLeashRadiusM: 600 }
    });
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true);
      });

      harness.socket.send(JSON.stringify({
        type: "JUMP_TO_MANOR",
        requestId: "jump-to-manor",
        manorId
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(harness.messages.some(
          (message) =>
            message.type === "TRAVEL_RESULT" &&
            message.requestId === "jump-to-manor" &&
            message.success
        )).toBe(true);
      });

      const result = harness.messages.find(
        (message): message is Extract<ServerMessage, { type: "TRAVEL_RESULT" }> =>
          message.type === "TRAVEL_RESULT" && message.requestId === "jump-to-manor"
      )!;
      const resourceVision = harness.gameState.getResourceVision("player-1");
      expect(resourceVision).toMatchObject({
        destinationKind: "area",
        center: { lat: manor.lat, lon: manor.lon },
        movementLeashRadiusM: 600,
        radiusM: 650
      });
      expect(result.resourceVisionRevision).toBe(
        harness.gameState.getResourceVisionRevision("player-1")
      );
      expect(harness.messages.some(
        (message) => message.type === "MANOR_ERROR" && message.requestId === "jump-to-manor"
      )).toBe(false);

      harness.collectibles.listAvailableInVision.mockClear();
      const messageCountBeforeRefresh = harness.messages.length;
      harness.socket.send(JSON.stringify({
        type: "REQUEST_NEARBY_COLLECTIBLES",
        requestId: "refresh-after-manor-jump"
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(harness.collectibles.listAvailableInVision).toHaveBeenCalledOnce();
      });
      const refreshMessages = harness.messages.slice(messageCountBeforeRefresh);
      expect(refreshMessages).toContainEqual(expect.objectContaining({
        type: "COLLECTIBLES_SNAPSHOT",
        resourceVision: expect.objectContaining({
          destinationKind: "area",
          center: { lat: manor.lat, lon: manor.lon },
          radiusM: 650
        })
      }));
      expect(refreshMessages.some(
        (message) => message.type === "ERROR" &&
          message.requestId === "refresh-after-manor-jump"
      )).toBe(false);
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("does not throw or recursively send when a socket is closing", () => {
    const send = vi.fn(() => {
      throw new Error("closing socket");
    });
    const logger = { warn: vi.fn() };
    expect(safeSendServerMessage(
      { readyState: 1, send, close: vi.fn() },
      { type: "PONG", clientTime: 1, serverTime: 2 },
      logger
    )).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();

    send.mockClear();
    expect(safeSendServerMessage(
      { readyState: 2, send, close: vi.fn() },
      { type: "PONG", clientTime: 1, serverTime: 2 },
      logger
    )).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("allows progression only in private development or explicitly enabled safe production", () => {
    const development = loadConfig({
      NODE_ENV: "development",
      AUTH_RUNTIME_MODE: "local",
      AUTH_MODE: "dev",
      AUTH_DEV_LOGIN_ENABLED: "true",
      DEV_ADMIN_TOOLS_ENABLED: "true"
    });
    const production = productionEconomyConfig();
    expect(() => assertDevProgressionAccess(development, false)).toThrow(/disabled/i);
    expect(() => assertDevProgressionAccess(production, true)).not.toThrow();
    expect(() => assertDevProgressionAccess({
      ...production,
      DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED: false
    }, true)).toThrow(/disabled/i);
    expect(() => assertDevProgressionAccess({ ...development, DEV_TOOLS_ENABLED: false }, true)).toThrow(/disabled/i);
    expect(() => assertDevProgressionAccess(development, true)).not.toThrow();
  });
  it("fails development economy access closed unless every explicit gate is enabled", () => {
    const allowed = loadConfig({
      NODE_ENV: "development", AUTH_RUNTIME_MODE: "local", AUTH_MODE: "dev", AUTH_DEV_LOGIN_ENABLED: "true",
      DEV_ADMIN_TOOLS_ENABLED: "true"
    });
    const production = productionEconomyConfig();
    expect(() => assertDevelopmentEconomyAccess(allowed, true)).not.toThrow();
    expect(() => assertDevelopmentEconomyAccess(production, true)).not.toThrow();
    expect(() => assertDevelopmentEconomyAccess({
      ...production,
      DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED: false
    }, true)).toThrow(/disabled/i);
    expect(() => assertDevelopmentEconomyAccess({ ...allowed, DEV_ADMIN_TOOLS_ENABLED: false }, true)).toThrow(/disabled/i);
    expect(() => assertDevelopmentEconomyAccess({ ...allowed, AUTH_MODE: "google" }, true)).toThrow(/disabled/i);
    expect(() => assertDevelopmentEconomyAccess(allowed, false)).toThrow(/disabled/i);
  });
  it("exempts only authenticated developer-build players from class request throttles", () => {
    const developer = loadConfig({
      NODE_ENV: "development", AUTH_RUNTIME_MODE: "local", AUTH_MODE: "dev", AUTH_DEV_LOGIN_ENABLED: "true",
      DEV_ADMIN_TOOLS_ENABLED: "true"
    });
    const production = productionEconomyConfig();
    expect(isDeveloperClassRateExempt(developer, true)).toBe(true);
    expect(isDeveloperClassRateExempt(developer, false)).toBe(false);
    expect(isDeveloperClassRateExempt(production, true)).toBe(true);
    expect(isDeveloperClassRateExempt({
      ...production,
      DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED: false
    }, true)).toBe(false);
    expect(isDeveloperClassRateExempt({ ...developer, DEV_ADMIN_TOOLS_ENABLED: false }, true)).toBe(false);
    expect(isDeveloperClassRateExempt({ ...developer, AUTH_MODE: "google" }, true)).toBe(false);
    expect(isDeveloperClassRateExempt({ ...developer, AUTH_DEV_LOGIN_ENABLED: false }, true)).toBe(false);

    const exemptWindows = new Map<string, number[]>();
    for (let request = 0; request < 100; request++) {
      expect(() => enforceClassRate(exemptWindows, "dev-progression", 1, 60_000, true)).not.toThrow();
    }
    const playerWindows = new Map<string, number[]>();
    enforceClassRate(playerWindows, "dev-progression", 1, 60_000, false);
    expect(() => enforceClassRate(playerWindows, "dev-progression", 1, 60_000, false)).toThrow(/too many class requests/i);
  });
  it.each([
    ["missing session", null, "/ws", null],
    ["query-string session token", null, "/ws?sessionToken=raw-session", null],
    ["invalid session", null, "/ws", "aa_session_dev=invalid"],
    [
      "suspended account",
      new AuthError("ACCOUNT_SUSPENDED", "Account suspended", 403),
      "/ws",
      "aa_session_dev=suspended"
    ],
    [
      "deleted account",
      new AuthError("ACCOUNT_UNAVAILABLE", "Account unavailable", 403),
      "/ws",
      "aa_session_dev=deleted"
    ]
  ])("rejects %s during the WebSocket upgrade", async (_label, authFailure, url, sessionCookie) => {
    const app = Fastify();
    const config = loadConfig({ NODE_ENV: "test" });
    const authService = {
      sessionCookieName: "aa_session_dev",
      assertOrigin: vi.fn(),
      ...developerAuthMethods(),
      authenticateSession: vi.fn(async () => {
        if (authFailure instanceof Error) {
          throw authFailure;
        }
        return null;
      })
    } as unknown as AuthService;
    await app.register(cookie);
    installAuthGuard(app, config, authService);
    await registerRealtime({
        infrastructure: {
            app: app,
            registry: new ConnectionRegistry(),
            logger: createLogger("test")
        },
        authority: {
            gameState: new GameState(config, createLogger("test")),
            flagService: { listFlags: vi.fn(async () => []) } as unknown as FlagService,
            playerService: {} as PlayerService,
            auth: authService
        },
        capabilities: {
          ...worldBootstrapLocationFixtures(),
          combat: new CombatEngine({ tickRateHz: config.SERVER_TICK_HZ })
        }
    });
    await app.ready();

    try {
      await expect(
        app.injectWS(url, {
          headers: {
            origin: config.CLIENT_ORIGIN,
            ...(sessionCookie ? { cookie: sessionCookie } : {})
          }
        })
      ).rejects.toThrow();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["pending", "TEST_ACCESS_PENDING"],
    ["denied", "TEST_ACCESS_DENIED"],
    ["revoked", "TEST_ACCESS_REVOKED"]
  ] as const)("rejects an authenticated %s account before WebSocket bootstrap", async (
    _status,
    code
  ) => {
    const app = Fastify();
    const config = loadConfig({ NODE_ENV: "test" });
    const requireGameplayReady = vi.fn(() => {
      throw new AuthError(code, code, 403);
    });
    const authService = {
      sessionCookieName: "aa_session_dev",
      assertOrigin: vi.fn(),
      ...developerAuthMethods(),
      requireGameplayReady,
      authenticateSession: vi.fn(async () => ({
        sessionId: "restricted-session",
        verifiedEmail: "restricted@example.com",
        account: {
          id: "restricted-account",
          status: "active" as const,
          trustTier: "new" as const,
          riskScore: 0,
          testAccessStatus: _status,
          testAccessRequestedAt: new Date(),
          testAccessDecidedAt: null,
          createdAt: new Date(),
          lastLoginAt: null
        },
        player: null,
        deviceInstallationId: "device",
        csrfToken: "csrf"
      }))
    } as unknown as AuthService;
    await app.register(cookie);
    installAuthGuard(app, config, authService);
    await registerRealtime({
      infrastructure: {
        app,
        registry: new ConnectionRegistry(),
        logger: createLogger("test")
      },
      authority: {
        gameState: new GameState(config, createLogger("test")),
        flagService: { listFlags: vi.fn(async () => []) } as unknown as FlagService,
        playerService: {} as PlayerService,
        auth: authService
      },
      capabilities: {
          ...worldBootstrapLocationFixtures(),
          combat: new CombatEngine({ tickRateHz: config.SERVER_TICK_HZ })
        }
    });
    await app.ready();

    try {
      await expect(app.injectWS("/ws", {
        headers: {
          origin: config.CLIENT_ORIGIN,
          cookie: "aa_session_dev=restricted"
        }
      })).rejects.toThrow();
      expect(requireGameplayReady).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("kicks a live socket at once when a mode change revalidates it, and refuses reconnect", async () => {
    const app = Fastify();
    const config = loadConfig({ NODE_ENV: "test" });
    let devOnly = false;
    const requireGameplayReady = vi.fn(async () => {
      if (devOnly) {
        throw new AuthError("TEST_ACCESS_DEV_ONLY", "Only developer accounts can enter Ash Atlas", 403);
      }
    });
    const authService = {
      sessionCookieName: "aa_session_dev",
      assertOrigin: vi.fn(),
      ...developerAuthMethods(),
      requireGameplayReady,
      recordConnectionEvent: vi.fn(async () => undefined),
      authenticateSession: vi.fn(async () => ({
        sessionId: "live-session",
        verifiedEmail: "approved@example.com",
        account: {
          id: "approved-account",
          status: "active" as const,
          trustTier: "new" as const,
          riskScore: 0,
          testAccessStatus: "approved" as const,
          testAccessRequestedAt: new Date(),
          testAccessDecidedAt: null,
          createdAt: new Date(),
          lastLoginAt: null
        },
        player: null,
        deviceInstallationId: "device",
        csrfToken: "csrf"
      }))
    } as unknown as AuthService;
    await app.register(cookie);
    installAuthGuard(app, config, authService);
    const lifecycle = await registerRealtime({
      infrastructure: {
        app,
        registry: new ConnectionRegistry(),
        logger: createLogger("test")
      },
      authority: {
        gameState: new GameState(config, createLogger("test")),
        flagService: { listFlags: vi.fn(async () => []) } as unknown as FlagService,
        playerService: {} as PlayerService,
        auth: authService
      },
      capabilities: {
        ...worldBootstrapLocationFixtures(),
        combat: new CombatEngine({ tickRateHz: config.SERVER_TICK_HZ })
      }
    });
    await app.ready();
    const headers = { origin: config.CLIENT_ORIGIN, cookie: "aa_session_dev=live" };

    try {
      const socket = await app.injectWS("/ws", { headers });
      const messages: Array<{ type: string; code?: string }> = [];
      socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as { type: string; code?: string }));
      const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));

      // Nothing changed yet: an explicit revalidation keeps the socket open.
      await lifecycle.revalidateLiveSessions();
      expect(socket.readyState).toBe(socket.OPEN);

      devOnly = true;
      await lifecycle.revalidateLiveSessions("another-account");
      expect(socket.readyState).toBe(socket.OPEN);
      await lifecycle.revalidateLiveSessions();
      expect(await closed).toBe(4001);
      expect(messages).toContainEqual(expect.objectContaining({
        type: "AUTH_SESSION_INVALID",
        code: "SESSION_REVOKED"
      }));

      await expect(app.injectWS("/ws", { headers })).rejects.toThrow();
      devOnly = false;
      const reconnected = await app.injectWS("/ws", { headers });
      expect(reconnected.readyState).toBe(reconnected.OPEN);
      reconnected.terminate();
    } finally {
      await app.close();
    }
  });

  it("rejects concurrent and repeated HELLO messages on one socket", async () => {
    const app = Fastify();
    const config = loadConfig({ NODE_ENV: "test" });
    const logger = createLogger("test");
    const registry = new ConnectionRegistry();
    const gameState = new GameState(config, logger);
    const persistedPlayer = createDeferred<PlayerRecord>();
    const playerService = {
      loadPlayer: vi.fn(() => persistedPlayer.promise),
      markOnline: vi.fn(async () => undefined),
      persistPlayerSnapshot: vi.fn(async () => undefined),
      markOffline: vi.fn(async () => undefined)
    } as unknown as PlayerService;
    const flagService = {
      listFlags: vi.fn(async () => [])
    } as unknown as FlagService;
    const authService = {
      sessionCookieName: "aa_session_dev",
      assertOrigin: vi.fn(),
      ...developerAuthMethods(),
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
      recordConnectionEvent: vi.fn(async () => undefined)
    } as unknown as AuthService;

    await app.register(cookie);
    installAuthGuard(app, config, authService);
    await registerRealtime({
        infrastructure: {
            app: app,
            registry: registry,
            logger: logger
        },
        authority: {
            gameState: gameState,
            flagService: flagService,
            playerService: playerService,
            auth: authService
        },
        capabilities: {
          ...worldBootstrapLocationFixtures(),
          combat: new CombatEngine({ tickRateHz: config.SERVER_TICK_HZ })
        }
    });
    await app.ready();
    const socket = await app.injectWS("/ws", {
      headers: {
        origin: config.CLIENT_ORIGIN,
        cookie: "aa_session_dev=test-session"
      }
    });
    const messages: ServerMessage[] = [];
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as ServerMessage);
    });

    try {
      socket.send(hello());
      await vi.waitFor(() => {
        expect(playerService.loadPlayer).toHaveBeenCalledOnce();
      });
      expect(playerService.loadPlayer).toHaveBeenCalledWith("player-1");

      socket.send(hello());
      await vi.waitFor(() => {
        expect(helloErrors(messages)).toHaveLength(1);
      });
      expect(playerService.loadPlayer).toHaveBeenCalledOnce();

      persistedPlayer.resolve(playerRecord());
      await vi.waitFor(() => {
        expect(messages.some((message) => message.type === "WELCOME")).toBe(true);
      });
      expect(messages.find((message) => message.type === "WELCOME")).toMatchObject({
        playerSpeedMps: config.PLAYER_SPEED_MPS,
        serverTickHz: config.SERVER_TICK_HZ
      });
      expect(registry.connectionCountForPlayer("player-1")).toBe(1);
      expect(registry.connectionCountForPlayer("player-2")).toBe(0);

      socket.send(hello());
      await vi.waitFor(() => {
        expect(helloErrors(messages)).toHaveLength(2);
      });
      expect(playerService.loadPlayer).toHaveBeenCalledOnce();
      expect(helloErrors(messages)).toEqual([
        expect.objectContaining({ code: "HELLO_ALREADY_RECEIVED" }),
        expect.objectContaining({ code: "HELLO_ALREADY_RECEIVED" })
      ]);
    } finally {
      persistedPlayer.resolve(playerRecord());
      socket.terminate();
      await app.close();
    }
  });

  it("lets the second gameplay socket replace the first without losing the new lease", async () => {
    const harness = await createFlagTransitionHarness();
    let second: Awaited<ReturnType<typeof harness.app.injectWS>> | null = null;
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true);
      });
      const firstWelcome = harness.messages.find(
        (message): message is Extract<ServerMessage, { type: "WELCOME" }> =>
          message.type === "WELCOME"
      )!;
      second = await harness.app.injectWS("/ws", { headers: harness.headers });
      const secondMessages: ServerMessage[] = [];
      second.on("message", (data) => {
        secondMessages.push(JSON.parse(data.toString()) as ServerMessage);
      });
      second.send(hello());
      await vi.waitFor(() => {
        expect(secondMessages.some((message) => message.type === "WELCOME")).toBe(true);
        expect(harness.messages.some((message) => message.type === "SESSION_REPLACED")).toBe(true);
        expect(harness.registry.connectionCountForPlayer("player-1")).toBe(1);
      });
      expect(harness.registry.activeConnectionIdForAccount("account-1")).not.toBeNull();
      const secondWelcome = secondMessages.find(
        (message): message is Extract<ServerMessage, { type: "WELCOME" }> =>
          message.type === "WELCOME"
      )!;
      expect(firstWelcome.worldAuthorityEpoch).toMatch(/^[0-9a-f-]{36}$/u);
      expect(secondWelcome.worldAuthorityEpoch).toBe(firstWelcome.worldAuthorityEpoch);
      await vi.waitFor(() => expect(harness.gameState.getPlayer("player-1")?.online).toBe(true));
      expect(harness.playerService.markOffline).not.toHaveBeenCalled();
    } finally {
      harness.socket.terminate();
      second?.terminate();
      await harness.app.close();
    }
  });

  it.each([
    ["closed", true],
    ["open", false]
  ] as const)("does not let a stale %s bootstrap replace its winner", async (_label, closeFirst) => {
    const harness = await createFlagTransitionHarness();
    const blockedPlayer = createDeferred<PlayerRecord>();
    harness.playerService.loadPlayer
      .mockImplementationOnce(() => blockedPlayer.promise)
      .mockResolvedValueOnce(playerRecord());
    let second: Awaited<ReturnType<typeof harness.app.injectWS>> | null = null;
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.playerService.loadPlayer).toHaveBeenCalledOnce());

      second = await harness.app.injectWS("/ws", { headers: harness.headers });
      const secondMessages: ServerMessage[] = [];
      second.on("message", (data) => {
        secondMessages.push(JSON.parse(data.toString()) as ServerMessage);
      });
      second.send(hello());
      await vi.waitFor(() => {
        expect(secondMessages.some((message) => message.type === "WELCOME")).toBe(true);
      });
      const winnerConnectionId = harness.registry.activeConnectionIdForAccount("account-1");
      const winnerGeneration = secondMessages.find(
        (message): message is Extract<ServerMessage, { type: "WELCOME" }> =>
          message.type === "WELCOME"
      )!.connectionGeneration;

      if (closeFirst) harness.socket.terminate();
      const firstClosed = closeFirst
        ? Promise.resolve({ code: 1006 })
        : new Promise<{ code: number }>((resolve) => {
            harness.socket.once("close", (code) => resolve({ code }));
          });
      blockedPlayer.resolve(playerRecord());
      if (!closeFirst) await expect(firstClosed).resolves.toEqual({ code: 4002 });
      await vi.waitFor(() => {
        expect(harness.registry.activeConnectionIdForAccount("account-1")).toBe(winnerConnectionId);
        expect(harness.registry.connectionCountForPlayer("player-1")).toBe(1);
      });

      expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(false);
      expect(harness.playerService.markOnline).toHaveBeenCalledOnce();
      expect(harness.gameState.getPlayer("player-1")).toMatchObject({ online: true });
      const recordConnectionEvent = vi.mocked(harness.authService.recordConnectionEvent);
      expect(recordConnectionEvent.mock.calls.filter(
        ([, event]) => event === "game_connection_opened"
      )).toHaveLength(1);
      expect(recordConnectionEvent.mock.calls.some(
        ([, event]) => event === "game_connection_closed"
      )).toBe(false);

      second.send(JSON.stringify({ type: "PING", clientTime: winnerGeneration }));
      await vi.waitFor(() => {
        expect(secondMessages.some((message) => message.type === "PONG")).toBe(true);
      });
      expect(second.readyState).toBe(1);
    } finally {
      blockedPlayer.resolve(playerRecord());
      harness.socket.terminate();
      second?.terminate();
      await harness.app.close();
    }
  });

  it.each(["per-player", "global"] as const)(
    "suspends movement and outgoing combat outside the %s command queue",
    async (saturation) => {
      const harness = await createFlagTransitionHarness({
        WORLD_COMMAND_QUEUE_GLOBAL_MAX: "3",
        WORLD_COMMAND_QUEUE_PER_PLAYER_MAX: "2"
      });
      try {
        harness.socket.send(hello());
        await vi.waitFor(() => {
          expect(harness.registry.activeConnectionIdForPlayer("player-1")).not.toBeNull();
        });
        const connectionId = harness.registry.activeConnectionIdForPlayer("player-1")!;
        harness.gameState.setTarget("player-1", moveToward(playerRecord().position, {
          lat: playerRecord().position.lat,
          lon: playerRecord().position.lon + 0.02
        }, 500));
        const player = harness.gameState.getPlayer("player-1")!;
        const mobPosition = moveToward(
          player.position,
          { lat: player.position.lat, lon: player.position.lon + 0.02 },
          50
        );
        const mob = harness.combat.spawnMob({
          archetype: "wolf",
          position: mobPosition,
          regionCode: player.regionCode,
          zoneId: zoneIdForPosition(mobPosition)
        });
        harness.combat.startAttack({
          attackerId: "player-1",
          targetEntityId: mob.entityId,
          requestId: "disconnect-pursuit",
          accountId: "account-1",
          connectionId
        });
        const enqueueCancel = (playerId: string, requestId: string) => harness.runtime.enqueue({
          kind: "cancel-attack",
          playerId,
          accountId: playerId === "player-1" ? "account-1" : `account-${playerId}`,
          connectionId: playerId === "player-1" ? connectionId : `connection-${playerId}`,
          requestId
        });
        if (saturation === "per-player") {
          expect(enqueueCancel("player-1", "fill-1").accepted).toBe(true);
          expect(enqueueCancel("player-1", "fill-2").accepted).toBe(true);
          expect(enqueueCancel("player-1", "overflow")).toEqual({
            accepted: false,
            reason: "player-overflow"
          });
        } else {
          expect(enqueueCancel("player-1", "fill-1").accepted).toBe(true);
          expect(enqueueCancel("other-1", "fill-2").accepted).toBe(true);
          expect(enqueueCancel("other-2", "fill-3").accepted).toBe(true);
          expect(enqueueCancel("other-3", "overflow")).toEqual({
            accepted: false,
            reason: "global-overflow"
          });
        }
        const depthBeforeClose = harness.runtime.commands.depth;

        harness.socket.terminate();

        await vi.waitFor(() =>
          expect(harness.playerService.persistPlayerSnapshot).toHaveBeenCalledOnce()
        );
        expect(harness.runtime.commands.depth).toBe(depthBeforeClose);
        expect(harness.playerService.markOffline).not.toHaveBeenCalled();
        expect(harness.gameState.getPlayer("player-1")).toBeDefined();
        expect(harness.gameState.isWorldPresent("player-1")).toBe(true);
        expect(harness.combat.entity("player-1")?.targetEntityId).toBeNull();
        expect(harness.registry.connectionCountForPlayer("player-1")).toBe(0);
        expect(harness.registry.hasPlayerPresence("player-1")).toBe(true);
      } finally {
        harness.socket.terminate();
        await harness.app.close();
      }
    }
  );

  it("aborts an in-flight world transition while retaining the reconnect lease", async () => {
    const harness = await createFlagTransitionHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.registry.activeConnectionIdForPlayer("player-1")).not.toBeNull();
      });
      const token = harness.runtime.beginPlayerWorldTransition("player-1")!;
      harness.socket.terminate();
      await vi.waitFor(() => expect(
        harness.runtime.hasPlayerWorldTransition("player-1")
      ).toBe(false));
      expect(harness.runtime.endPlayerWorldTransition("player-1", token)).toBe(false);
      await vi.waitFor(() =>
        expect(harness.playerService.persistPlayerSnapshot).toHaveBeenCalledOnce()
      );
      expect(harness.playerService.markOffline).not.toHaveBeenCalled();
      expect(harness.gameState.getPlayer("player-1")).toBeDefined();
      expect(harness.gameState.isWorldPresent("player-1")).toBe(true);
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("does not await a terminal telemetry snapshot when a reconnect lease expires", async () => {
    const captureTelemetryPlayerSnapshot = vi.fn(
      () => new Promise<void>(() => undefined)
    );
    const harness = await createFlagTransitionHarness(
      {
        RECONNECT_GRACE_MS: "5",
        LINKDEAD_WORLD_PRESENCE_MS: "5"
      },
      undefined,
      { captureTelemetryPlayerSnapshot }
    );
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.registry.activeConnectionIdForPlayer("player-1")).not.toBeNull();
      });

      harness.socket.terminate();

      await vi.waitFor(() =>
        expect(harness.playerService.markOffline).toHaveBeenCalledOnce()
      );
      expect(captureTelemetryPlayerSnapshot).toHaveBeenCalledWith(
        "player-1",
        "session-1",
        "terminal_disconnect"
      );
      expect(harness.gameState.getPlayer("player-1")).toBeUndefined();
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("revokes connected players when the registry closes sockets for shutdown", async () => {
    const harness = await createFlagTransitionHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.registry.activeConnectionIdForPlayer("player-1")).not.toBeNull();
      });
      const socketClose = vi.spyOn(harness.registry.records()[0]!.socket, "close");

      await harness.realtime.shutdownConnections();

      expect(socketClose).toHaveBeenCalledWith(1012, "service restart");
      await vi.waitFor(() => expect(harness.playerService.markOffline).toHaveBeenCalledOnce());
      expect(harness.gameState.getPlayer("player-1")).toBeUndefined();
      expect(harness.combat.entity("player-1")).toBeNull();
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("rotates authority without restoring an obsolete resource or rolling live health, effects, or cooldowns back to persistence", async () => {
    const harness = await createCombatReplacementHarness();
    let replacement: Awaited<ReturnType<typeof harness.app.injectWS>> | null = null;
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      const firstConnectionId = harness.registry.activeConnectionIdForPlayer("player-1");
      expect(firstConnectionId).not.toBeNull();

      harness.combat.useNormalAbility({
        playerId: "player-1",
        abilityId: "druid_rejuvenation",
        targetMode: "self",
        accountId: "account-1",
        connectionId: firstConnectionId!
      });
      for (let tick = 0; tick < 40; tick += 1) harness.combat.tick();
      const before = harness.combat.entity("player-1");
      const runtimeBefore = harness.combat.peekDirtyClassRuntimes()
        .find((runtime) => runtime.playerId === "player-1");
      expect(before?.currentHealth).toBeGreaterThan(50);
      expect(before?.classCombat?.resource).toBeUndefined();
      expect(before?.classCombat?.cooldownEndsAt.druid_rejuvenation).toBeGreaterThan(Date.now());
      expect(runtimeBefore?.statusEffects).toEqual([
        expect.objectContaining({ kind: "healing_over_time", sourceTechniqueId: "druid_rejuvenation" })
      ]);

      const replacementMessages: ServerMessage[] = [];
      replacement = await harness.app.injectWS("/ws", { headers: harness.headers });
      replacement.on("message", (data) => {
        replacementMessages.push(JSON.parse(data.toString()) as ServerMessage);
      });
      replacement.send(hello());
      await vi.waitFor(() => {
        expect(replacementMessages.some((message) => message.type === "WELCOME")).toBe(true);
      });

      const after = harness.combat.entity("player-1");
      expect(after?.currentHealth).toBe(before?.currentHealth);
      expect(after?.classCombat?.resource).toEqual(before?.classCombat?.resource);
      expect(after?.classCombat?.cooldownEndsAt).toEqual(before?.classCombat?.cooldownEndsAt);
      expect(harness.combat.peekDirtyClassRuntimes()
        .find((runtime) => runtime.playerId === "player-1")?.statusEffects).toEqual(runtimeBefore?.statusEffects);
      expect(replacementMessages.find((message) => message.type === "CLASS_SNAPSHOT")).toMatchObject({
        snapshot: {
          cooldownEndsAt: before?.classCombat?.cooldownEndsAt
        }
      });
      expect(replacementMessages.find((message) => message.type === "CLASS_SNAPSHOT")?.snapshot.resource).toBeUndefined();
      expect(harness.classes.loadRuntime).toHaveBeenCalledOnce();
      expect(harness.combatProfiles.getOrCreate).toHaveBeenCalledOnce();
      expect(harness.registry.activeConnectionIdForPlayer("player-1")).not.toBe(firstConnectionId);
    } finally {
      replacement?.terminate();
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("delivers an in-flight committed class mutation to the replacement connection", async () => {
    const harness = await createCombatReplacementHarness();
    const activationStarted = createDeferred<void>();
    const releaseActivation = createDeferred<void>();
    const originalActivateClass = harness.classes.activateClass.getMockImplementation();
    let replacement: Awaited<ReturnType<typeof harness.app.injectWS>> | null = null;
    harness.classes.activateClass.mockImplementationOnce(async (playerId: string, classId: string) => {
      activationStarted.resolve();
      await releaseActivation.promise;
      return originalActivateClass!(playerId, classId);
    });

    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      harness.socket.send(JSON.stringify({
        type: "ACTIVATE_CLASS",
        requestId: "activate-during-replacement",
        classId: "knight"
      } satisfies ClientMessage));
      await activationStarted.promise;

      const replacementMessages: ServerMessage[] = [];
      replacement = await harness.app.injectWS("/ws", { headers: harness.headers });
      replacement.on("message", (data) => {
        replacementMessages.push(JSON.parse(data.toString()) as ServerMessage);
      });
      replacement.send(hello());
      await vi.waitFor(() => {
        expect(replacementMessages.some((message) => message.type === "WELCOME")).toBe(true);
        expect(replacementMessages.find((message) => message.type === "CLASS_SNAPSHOT")).toMatchObject({
          snapshot: { activeClassId: "druid" }
        });
      });

      releaseActivation.resolve();
      await vi.waitFor(() => expect(replacementMessages.find((message) =>
        message.type === "CLASS_MUTATION_CONFIRMED" &&
        message.requestId === "activate-during-replacement"
      )).toMatchObject({
        snapshot: { activeClassId: "knight" }
      }));
      expect(harness.combat.entity("player-1")?.classCombat?.activeClassId).toBe("knight");
    } finally {
      releaseActivation.resolve();
      replacement?.terminate();
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("restores pending party invitations on HELLO and socket replacement", async () => {
    const harness = await createCombatReplacementHarness();
    let replacement: Awaited<ReturnType<typeof harness.app.injectWS>> | null = null;
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.find(
        (message) => message.type === "PARTY_SNAPSHOT"
      )).toMatchObject({
        party: null,
        invites: [{
          partyId: "party:inviter",
          leaderPlayerId: "leader-1",
          inviterPlayerId: "leader-1"
        }]
      }));

      const replacementMessages: ServerMessage[] = [];
      replacement = await harness.app.injectWS("/ws", { headers: harness.headers });
      replacement.on("message", (data) => {
        replacementMessages.push(JSON.parse(data.toString()) as ServerMessage);
      });
      replacement.send(hello());
      await vi.waitFor(() => expect(replacementMessages.find(
        (message) => message.type === "PARTY_SNAPSHOT"
      )).toMatchObject({
        party: null,
        invites: [{ partyId: "party:inviter" }]
      }));
    } finally {
      replacement?.terminate();
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("recomputes live maximum health and publishes equipment context after an authoritative class activation", async () => {
    const harness = await createCombatReplacementHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      await vi.waitFor(() => expect(harness.messages.some(
        (message) => message.type === "EQUIPMENT_SNAPSHOT"
      )).toBe(true));
      harness.combat.updatePlayerPveStats("player-1", {
        level: 0,
        maxHealth: 100,
        attackPower: 10,
        defense: 10
      });
      expect(harness.combat.entity("player-1")?.maxHealth).toBe(100);
      const healthBeforeSwitch = harness.combat.entity("player-1")?.currentHealth;
      const activationMessageStart = harness.messages.length;

      harness.socket.send(JSON.stringify({
        type: "ACTIVATE_CLASS",
        requestId: "activate-knight-stats",
        classId: "knight"
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.messages.some((message) =>
        message.type === "CLASS_MUTATION_CONFIRMED" &&
        message.requestId === "activate-knight-stats"
      )).toBe(true));

      const activationMessages = harness.messages.slice(activationMessageStart);
      const equipmentSnapshotIndex = activationMessages.findIndex(
        (message) => message.type === "EQUIPMENT_SNAPSHOT"
      );
      const confirmationIndex = activationMessages.findIndex(
        (message) =>
          message.type === "CLASS_MUTATION_CONFIRMED" &&
          message.requestId === "activate-knight-stats"
      );
      expect(equipmentSnapshotIndex).toBeGreaterThanOrEqual(0);
      expect(equipmentSnapshotIndex).toBeLessThan(confirmationIndex);
      expect(activationMessages[equipmentSnapshotIndex]).toMatchObject({
        type: "EQUIPMENT_SNAPSHOT",
        equipment: { playerId: "player-1", snapshotVersion: 2 }
      });
      expect(harness.equipment.setRuntimeContext).toHaveBeenLastCalledWith(
        "player-1",
        {
          context: "pve",
          characterLevel: 0,
          classId: "knight",
          classRank: 25
        }
      );
      expect(harness.combat.entity("player-1")?.maxHealth).toBe(100);
      expect(harness.combat.entity("player-1")?.currentHealth).toBe(healthBeforeSwitch);
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("recomputes live defense after equipping a Knight passive", async () => {
    const harness = await createCombatReplacementHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      const statUpdates = vi.spyOn(harness.combat, "updatePlayerPveStats");
      harness.socket.send(JSON.stringify({
        type: "ACTIVATE_CLASS",
        requestId: "activate-knight-loadout",
        classId: "knight"
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.messages.some((message) =>
        message.type === "CLASS_MUTATION_CONFIRMED" &&
        message.requestId === "activate-knight-loadout"
      )).toBe(true));
      expect(statUpdates).toHaveBeenLastCalledWith(
        "player-1",
        expect.objectContaining({ defense: 10 }),
        { preserveCurrentHealth: true }
      );
      statUpdates.mockClear();

      harness.socket.send(JSON.stringify({
        type: "UPDATE_CLASS_LOADOUT",
        requestId: "equip-mercy",
        loadout: {
          resetActives: [null, null],
          normalActives: [null, null],
          passiveTiers: ["knight_heavy_blade", null, null], ultimateActive: null
        }
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.messages.some((message) =>
        message.type === "CLASS_MUTATION_CONFIRMED" && message.requestId === "equip-mercy"
      )).toBe(true));

      expect(harness.combat.entity("player-1")?.classCombat?.activeClassId).toBe("knight");
      expect(statUpdates).toHaveBeenLastCalledWith(
        "player-1",
        expect.objectContaining({ defense: 10 }),
        { preserveCurrentHealth: true }
      );
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("rejects remote flag travel that did not originate from a visible map selection", async () => {
    const harness = await createFlagTransitionHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      harness.socket.send(JSON.stringify({
        type: "VISIT_FLAG",
        requestId: "remote-flag",
        flagId: testFlag().id
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.messages.some(
        (message) => message.type === "ERROR" &&
          message.requestId === "remote-flag" &&
          message.code === "REMOTE_FLAG_TRAVEL_UNSUPPORTED"
      )).toBe(true));
      expect(harness.flagService.getFlag).not.toHaveBeenCalled();
      expect(harness.playerService.persistPlayerSnapshot).not.toHaveBeenCalled();
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("fails personal flag travel closed when centralized access denies it", async () => {
    const executeTravel = vi.fn(async () => {
      throw new FlagAccessError("PRIVATE_OWNER_ONLY", "This is a private flag.");
    });
    const flagAccess = {
      ...permissiveFlagAccess(),
      executeTravel
    } as unknown as FlagAccessService;
    const harness = await createFlagTransitionHarness({}, undefined, { flagAccess });
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      const before = harness.gameState.snapshotForPlayer("player-1");
      harness.socket.send(visitFlag("private-denied"));
      harness.flagLookup.resolve(testFlag());
      await vi.waitFor(() => expect(harness.messages.some(
        (message) => message.type === "ERROR" &&
          message.requestId === "private-denied" &&
          message.code === "PRIVATE_OWNER_ONLY"
      )).toBe(true));
      expect(executeTravel).toHaveBeenCalledOnce();
      expect(harness.gameState.snapshotForPlayer("player-1")).toMatchObject({
        lat: before.lat,
        lon: before.lon,
        anchorLat: before.anchorLat,
        anchorLon: before.anchorLon
      });
      expect(harness.playerService.persistPlayerSnapshot).not.toHaveBeenCalled();
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("detaches revoked reconnect access without relocating to the default spawn", async () => {
    const retainedPosition = { lat: 19.4326, lon: -99.1332 };
    const player = {
      ...playerRecord(),
      regionCode: "MX-CMX",
      position: retainedPosition,
      anchor: retainedPosition,
      resourceVision: {
        flagId: testFlag().id,
        flagName: "Former Access",
        center: retainedPosition,
        movementLeashRadiusM: 900,
        paddingM: 100,
        radiusM: 1_000
      }
    } satisfies PlayerRecord;
    const flagAccess = {
      authorize: vi.fn(async () => ({
        flagId: testFlag().id,
        controlType: "personal",
        ownerPlayerId: "another-player",
        mode: "private",
        jumpTollGold: 0n,
        accessRevision: 1n,
        travelerAccountId: "account-1",
        ownerAccountId: "account-2",
        decision: {
          allowed: false,
          requestable: false,
          reasonCode: "PRIVATE_OWNER_ONLY",
          tollGold: "0"
        }
      }))
    } as unknown as FlagAccessService;
    const harness = await createFlagTransitionHarness({}, undefined, {
      flagAccess,
      player
    });
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some(
        (message) => message.type === "WELCOME"
      )).toBe(true));

      expect(harness.messages).toContainEqual(expect.objectContaining({
        type: "WELCOME",
        spawn: retainedPosition,
        anchor: retainedPosition
      }));
      expect(harness.playerService.persistPlayerSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          lat: retainedPosition.lat,
          lon: retainedPosition.lon,
          anchorLat: retainedPosition.lat,
          anchorLon: retainedPosition.lon,
          currentFlagId: null
        })
      );
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("serializes VISIT_FLAG against pending and newly arriving world mutations", async () => {
    const harness = await createFlagTransitionHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));

      const pendingCommands: ClientMessage[] = [
        {
          type: "MOVE_TO",
          requestId: "move-before",
          lat: 35.0845,
          lon: -106.6504
        },
        {
          type: "START_ATTACK",
          requestId: "attack-before",
          targetEntityId: "mob:missing"
        },
        {
          type: "USE_UNIVERSAL_TAUNT",
          requestId: "taunt-before"
        }
      ];
      for (const [index, command] of pendingCommands.entries()) {
        harness.socket.send(JSON.stringify(command));
        await vi.waitFor(() => expect(harness.runtime.hasPendingCommand("player-1")).toBe(true));
        const requestId = `visit-blocked-${index}`;
        harness.socket.send(visitFlag(requestId));
        await vi.waitFor(() => expect(harness.messages.some(
          (message) => message.type === "ERROR" &&
            message.requestId === requestId &&
            message.code === "PLAYER_WORLD_COMMAND_PENDING"
        )).toBe(true));
        expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(false);
        harness.runtime.tick(0.05);
      }

      harness.socket.send(visitFlag("visit-pending"));
      await vi.waitFor(() => {
        expect(harness.flagService.getFlag).toHaveBeenCalled();
        expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(true);
      });
      harness.socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "move-during",
        boundTravelRequestId: "visit-pending",
        lat: 35.0845,
        lon: -106.6504
      } satisfies ClientMessage));
      harness.socket.send(JSON.stringify({
        type: "START_ATTACK",
        requestId: "attack-during",
        targetEntityId: "mob:missing"
      } satisfies ClientMessage));
      harness.socket.send(JSON.stringify({
        type: "USE_UNIVERSAL_TAUNT",
        requestId: "taunt-during"
      } satisfies ClientMessage));
      harness.socket.send(visitFlag("visit-during"));
      await vi.waitFor(() => {
        expect(errorCodes(harness.messages).filter(
          (code) => code === "PLAYER_WORLD_TRANSITION_PENDING"
        )).toHaveLength(1);
      });
      // Combat messages are serialized per player behind the in-flight visit, so they answer after it lands.
      expect(errorCodes(harness.messages)).not.toContain("WORLD_AUTHORITY_PREPARING");
      expect(harness.messages.some(
        (message) => message.type === "ERROR" && message.requestId === "move-during"
      )).toBe(false);
      expect(harness.runtime.hasPendingCommand("player-1")).toBe(false);

      harness.flagLookup.resolve(testFlag());
      await vi.waitFor(() => expect(harness.messages.some(
        (message) => message.type === "FLAG_VISITED" && message.requestId === "visit-pending"
      )).toBe(true));
      expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(false);
      await vi.waitFor(() => {
        harness.runtime.tick(0.05);
        expect(harness.messages.some(
          (message) => message.type === "ERROR" && message.requestId === "taunt-during"
        )).toBe(true);
      });
      await vi.waitFor(() => expect(harness.messages.some(
        (message) => message.type === "ERROR" &&
          message.requestId === "move-during" &&
          message.code === "MOVE_REJECTED"
      )).toBe(true));
      expect(harness.runtime.hasPendingCommand("player-1")).toBe(false);
      const flag = testFlag();
      const visitedPlayer = harness.gameState.snapshotForPlayer("player-1");
      expect(visitedPlayer).toMatchObject({
        anchorLat: flag.lat,
        anchorLon: flag.lon
      });
      expect(distanceMeters(
        { lat: visitedPlayer.lat, lon: visitedPlayer.lon },
        { lat: flag.lat, lon: flag.lon }
      )).toBeCloseTo(75, 1);
      expect(harness.gameState.getGameplayViewCircle("player-1")).toMatchObject({
        anchorType: "flag",
        anchorId: flag.id,
        center: { lat: flag.lat, lon: flag.lon }
      });

      harness.socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "move-after",
        lat: flag.lat,
        lon: flag.lon
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.runtime.hasPendingCommand("player-1")).toBe(true));
    } finally {
      harness.flagLookup.resolve(testFlag());
      harness.socket.terminate();
      await harness.app.close();
    }
  });;;;;;;;

  it("completes DEV_SPAWN_MOB directly while targetless Taunt still queues", async () => {
    const harness = await createFlagTransitionHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      const combatPlayer = (harness.combat as unknown as {
        entities: Map<string, { classRuntime: unknown }>;
      }).entities.get("player-1");
      if (!combatPlayer) throw new Error("expected combat player");
      combatPlayer.classRuntime = {
        skillV3: null,
        activeClassId: "knight",
        resourceId: "rage",
        weaponMode: "melee",
        masteryRank: 0,
        hunterProfessionRank: 0,
        subclassId: null,
        subclassMasteryRank: 0,
        learned: new Set<string>(),
        equippedActives: new Set<string>(),
        equippedPassives: new Set<string>(),
        legacyIds: new Set<string>(),
        weaponCategory: null,
        armorCategory: null,
        weaponDefinitionId: null,
        chestDefinitionId: null,
        hasShield: false,
        heavyArmorPieces: 0,
        rage: 0,
        reservedRage: 0,
        guard: 0,
        bloodlust: 0,
        queuedAbility: null,
        cooldownEndsAt: {},
        effects: [],
        counters: {},
        lastCombatAtMs: null,
        combatGeneration: 0,
        dirtyVersion: 0
      };
      const playerPosition = harness.gameState.getPlayer("player-1")!.position;
      const spawnPosition = moveToward(
        playerPosition,
        { lat: playerPosition.lat, lon: playerPosition.lon + 0.02 },
        300
      );
      harness.socket.send(JSON.stringify({
        type: "DEV_SPAWN_MOB",
        requestId: "spawn-distant-wolf",
        archetype: "wolf",
        lat: spawnPosition.lat,
        lon: spawnPosition.lon
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.messages.some((message) =>
        message.type === "DEV_MOB_SPAWNED" && message.requestId === "spawn-distant-wolf"
      )).toBe(true));
      expect(harness.runtime.hasPendingCommand("player-1")).toBe(false);
      const spawned = harness.messages.find((message) =>
        message.type === "DEV_MOB_SPAWNED" && message.requestId === "spawn-distant-wolf"
      );
      if (!spawned || spawned.type !== "DEV_MOB_SPAWNED") throw new Error("expected spawned wolf");
      const wolfId = spawned.mobEntityId;
      const initialWolf = harness.combat.entity(wolfId)!;
      const initialWolfPosition = { lat: initialWolf.lat, lon: initialWolf.lon };

      harness.socket.send(JSON.stringify({
        type: "USE_UNIVERSAL_TAUNT",
        requestId: "idle-wolf-taunt"
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.runtime.hasPendingCommand("player-1")).toBe(true));
      harness.runtime.tick(0.05);
      await vi.waitFor(() => expect(harness.messages.some((message) =>
        message.type === "ABILITY_QUEUE_UPDATED" && message.requestId === "idle-wolf-taunt"
      )).toBe(true));

      expect(harness.combat.entity("player-1")?.pveCombat).toMatchObject({
        focusTargetEntityId: null,
        enemyQueue: [],
        pursuingEnemyIds: [wolfId],
        phase: "waiting_player"
      });
      expect(harness.combat.entity(wolfId)).toMatchObject({
        targetEntityId: "player-1",
        activityState: "chasing"
      });
      expect(harness.combat.metricsSnapshot().activeChases).toBe(1);

      let queueJoinTick = 0;
      let firstAttackTick = 0;
      for (let tick = 1; tick <= 80; tick += 1) {
        harness.runtime.tick(0.05);
        if (queueJoinTick === 0 && harness.combat.entity("player-1")?.pveCombat?.enemyQueue.includes(wolfId)) {
          queueJoinTick = tick;
          expect(harness.combat.entity("player-1")?.currentHealth).toBe(100);
        }
        if (firstAttackTick === 0 && (harness.combat.entity("player-1")?.currentHealth ?? 100) < 100) {
          firstAttackTick = tick;
          break;
        }
      }
      const laterWolf = harness.combat.entity(wolfId)!;
      const laterWolfPosition = { lat: laterWolf.lat, lon: laterWolf.lon };
      expect(distanceMeters(laterWolfPosition, playerPosition)).toBeLessThan(
        distanceMeters(initialWolfPosition, playerPosition)
      );
      expect(queueJoinTick).toBe(42);
      // Range promotion does not add an extra idle cycle: the wolf attacks on
      // the first anchored enemy beat after joining the active queue.
      expect(firstAttackTick).toBe(56);
    } finally {
      harness.flagLookup.resolve(testFlag());
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("enforces Aggressive and queued-action travel locks while allowing a lingering target once both clear", async () => {
    const harness = await createFlagTransitionHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      const internal = harness.combat as unknown as {
        entities: Map<string, {
          aggressiveUntilMs: number;
          targetEntityId: string | null;
          classRuntime: { queuedAbility: object | null } | null;
        }>;
      };
      const player = internal.entities.get("player-1")!;
      player.aggressiveUntilMs = Date.now() + 7_000;
      harness.flagLookup.resolve(testFlag());

      harness.socket.send(visitFlag("aggressive-blocked"));
      await vi.waitFor(() => expect(harness.messages.some((message) =>
        message.type === "ERROR" &&
        message.requestId === "aggressive-blocked" &&
        message.code === "FLAG_VISIT_AGGRESSIVE" &&
        (message.details?.retryAfterMs ?? 0) > 0
      )).toBe(true));
      expect(harness.messages.some((message) =>
        message.type === "FLAG_VISITED" && message.requestId === "aggressive-blocked"
      )).toBe(false);

      player.aggressiveUntilMs = Date.now() - 1;
      player.targetEntityId = "mob:lingering";
      expect(harness.combat.isInCombat("player-1")).toBe(true);
      player.classRuntime = { queuedAbility: {} };
      harness.socket.send(visitFlag("queued-action-blocked"));
      await vi.waitFor(() => expect(harness.messages.some((message) =>
        message.type === "ERROR" &&
        message.requestId === "queued-action-blocked" &&
        message.code === "FLAG_VISIT_ACTION_PENDING"
      )).toBe(true));
      player.classRuntime = null;
      harness.socket.send(visitFlag("aggressive-expired"));
      await vi.waitFor(() => expect(harness.messages.some((message) =>
        message.type === "FLAG_VISITED" && message.requestId === "aggressive-expired"
      )).toBe(true));
    } finally {
      harness.flagLookup.resolve(testFlag());
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("rejects direct location handlers and fences item mutations while a flag transition is pending", async () => {
    const harness = await createFlagTransitionHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true);
        expect(harness.collectibles.inventoryForPlayer).toHaveBeenCalled();
      });
      vi.clearAllMocks();
      harness.socket.send(visitFlag("direct-gate"));
      await vi.waitFor(() => expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(true));

      const blocked: ClientMessage[] = [
        { type: "PLACE_FLAG", requestId: "blocked-place", name: "Nope" },
        { type: "REQUEST_NEARBY_COLLECTIBLES", requestId: "blocked-nearby" },
        { type: "SURVEY_AREA", requestId: "blocked-survey" },
        {
          type: "START_HARVEST",
          requestId: "blocked-start-harvest",
          nodeId: "node-1",
          expectedPresentationOwner: "population",
          expectedEntityRevision: 0,
          expectedRelocationRevision: 0,
          expectedResourceVisionRevision: 0,
          expectedGameplayViewGeneration: 0
        },
        { type: "COMPLETE_HARVEST", requestId: "blocked-complete-harvest", sessionId: "22222222-2222-4222-8222-222222222222" },
        { type: "DROP_ITEM", requestId: "blocked-drop", itemId: "wood", variant: null, quantity: 1 },
        { type: "PICKUP_DROPPED_ITEM", requestId: "blocked-pickup", dropId: "33333333-3333-4333-8333-333333333333", pickup: { mode: "all" } },
        { type: "COLLECT_WATER_AT_COORDINATE", requestId: "blocked-water", lat: 35.0844, lon: -106.6504 },
        { type: "DEV_SPAWN_MOB", requestId: "blocked-dev-spawn", archetype: "goblin", lat: 35.0844, lon: -106.6504 },
        { type: "DEV_CLEAR_MOBS", requestId: "blocked-dev-clear" },
        { type: "REQUEST_WORLD_RESYNC", requestId: "blocked-resync", combatSequence: 0, playerSequence: 0 }
      ];
      for (const message of blocked) harness.socket.send(JSON.stringify(message));

      // Drop, pickup, and developer clear wait behind the player authority fence.
      // Harvesting has its own explicit reconciliation errors.
      await vi.waitFor(() => {
        const blockedRequestIds = new Set(blocked.map((message) => "requestId" in message ? message.requestId : ""));
        expect(harness.messages.filter(
          (message) => message.type === "ERROR" &&
            message.code === "PLAYER_WORLD_TRANSITION_PENDING" &&
            blockedRequestIds.has(message.requestId ?? "")
        ), JSON.stringify(harness.messages.filter((message) => message.type === "ERROR"))).toHaveLength(blocked.length - 5);
        expect(harness.messages).toContainEqual(expect.objectContaining({
          type: "ERROR",
          requestId: "blocked-start-harvest",
          code: "HARVEST_AUTHORITY_PREPARING"
        }));
        expect(harness.messages).toContainEqual(expect.objectContaining({
          type: "ERROR",
          requestId: "blocked-complete-harvest",
          code: "HARVEST_PLAYER_WORLD_TRANSITION"
        }));
      });
      expect(harness.flagService.createForPlayer).not.toHaveBeenCalled();
      expect(harness.collectibles.listAvailableInVision).not.toHaveBeenCalled();
      expect(harness.collectibles.collectWaterAt).not.toHaveBeenCalled();
      expect(harness.harvestSessions.startHarvest).not.toHaveBeenCalled();
      expect(harness.harvestSessions.completeHarvest).not.toHaveBeenCalled();
      expect(harness.droppedItems.dropItem).not.toHaveBeenCalled();
      expect(harness.droppedItems.pickupDroppedItem).not.toHaveBeenCalled();
      expect(harness.droppedItems.isEquipmentDrop).not.toHaveBeenCalled();
      expect(harness.runtime.hasPendingCommand("player-1")).toBe(false);

      harness.flagLookup.resolve(testFlag());
      await vi.waitFor(() => expect(harness.messages.some(
        (message) => message.type === "FLAG_VISITED" && message.requestId === "direct-gate"
      )).toBe(true));
      harness.socket.send(JSON.stringify({
        type: "REQUEST_NEARBY_COLLECTIBLES",
        requestId: "nearby-after-transition"
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.collectibles.listAvailableInVision).toHaveBeenCalled());
      expect(harness.messages.some(
        (message) => message.type === "ERROR" &&
          message.requestId === "nearby-after-transition" &&
          message.code === "PLAYER_WORLD_TRANSITION_PENDING"
      )).toBe(false);
    } finally {
      harness.flagLookup.resolve(testFlag());
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("releases the flag transition after lookup and persistence failures", async () => {
    const harness = await createFlagTransitionHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      harness.flagService.getFlag.mockResolvedValueOnce(null);
      harness.socket.send(visitFlag("missing"));
      await vi.waitFor(() => expect(errorCodes(harness.messages)).toContain("FLAG_NOT_FOUND"));
      expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(false);

      const before = harness.gameState.capturePlayerViewTransition("player-1");
      harness.playerService.persistPlayerSnapshotInTransaction.mockRejectedValueOnce(new Error("database unavailable"));
      harness.flagService.getFlag.mockResolvedValue(testFlag());
      harness.socket.send(visitFlag("persist-failure"));
      await vi.waitFor(() => expect(errorCodes(harness.messages)).toContain("FLAG_VISIT_PERSISTENCE_FAILED"));
      expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(false);
      expect(harness.gameState.capturePlayerViewTransition("player-1")).toEqual(before);
      expect(harness.messages.some(
        (message) => message.type === "FLAG_VISITED" && message.requestId === "persist-failure"
      )).toBe(false);
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });;

  it("aborts a pending flag transition when its connection disconnects", async () => {
    const harness = await createFlagTransitionHarness();
    const before = playerRecord();
    harness.socket.send(hello());
    await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
    harness.socket.send(visitFlag("disconnect-during-lookup"));
    await vi.waitFor(() => expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(true));

    harness.socket.terminate();
    await vi.waitFor(() => expect(harness.registry.activeConnectionIdForPlayer("player-1")).toBeNull());
    harness.flagLookup.resolve(testFlag());
    await vi.waitFor(() => expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(false));

    expect(harness.messages.some(
      (message) => message.type === "FLAG_VISITED" && message.requestId === "disconnect-during-lookup"
    )).toBe(false);
    expect(harness.playerService.persistPlayerSnapshot.mock.calls.every(([snapshot]) =>
      snapshot.lat === before.position.lat && snapshot.lon === before.position.lon
    )).toBe(true);
    expect(harness.playerService.persistPlayerSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
      lat: before.position.lat,
      lon: before.position.lon,
      anchorLat: before.anchor.lat,
      anchorLon: before.anchor.lon
    });
    expect(harness.gameState.getPlayer("player-1")).toBeDefined();
    await harness.app.close();
  });

  it("prevents a replaced connection from completing a stale flag transition", async () => {
    const harness = await createFlagTransitionHarness();
    const replacementMessages: ServerMessage[] = [];
    let replacement: Awaited<ReturnType<typeof harness.app.injectWS>> | null = null;
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      harness.socket.send(visitFlag("replaced-during-lookup"));
      await vi.waitFor(() => expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(true));

      replacement = await harness.app.injectWS("/ws", { headers: harness.headers });
      replacement.on("message", (data) => {
        replacementMessages.push(JSON.parse(data.toString()) as ServerMessage);
      });
      replacement.send(hello());
      await vi.waitFor(() => {
        expect(replacementMessages.some((message) => message.type === "WELCOME")).toBe(true);
        expect(harness.messages.some((message) => message.type === "SESSION_REPLACED")).toBe(true);
      });

      harness.flagLookup.resolve(testFlag());
      await vi.waitFor(() => expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(false));
      expect(harness.messages.some(
        (message) => message.type === "FLAG_VISITED" && message.requestId === "replaced-during-lookup"
      )).toBe(false);
      expect(replacementMessages.some(
        (message) => message.type === "FLAG_VISITED" && message.requestId === "replaced-during-lookup"
      )).toBe(false);
      expect(harness.playerService.persistPlayerSnapshot).not.toHaveBeenCalled();
    } finally {
      harness.flagLookup.resolve(testFlag());
      replacement?.terminate();
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("rolls back an uncommitted flag transition after disconnect and hydrates reconnect", async () => {
    const ensureQueued = vi.fn(async () => undefined);
    const resourceVisionJobs = { ensureQueued } as unknown as ResourceVisionJobQueue;
    const harness = await createFlagTransitionHarness({}, undefined, {
      resourceVisionJobs
    });
    const persistence = createDeferred<void>();
    const reconnectMessages: ServerMessage[] = [];
    let reconnect: Awaited<ReturnType<typeof harness.app.injectWS>> | null = null;
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      harness.playerService.persistPlayerSnapshotInTransaction.mockImplementationOnce(() => persistence.promise);
      harness.flagService.getFlag.mockResolvedValue(testFlag());
      harness.socket.send(visitFlag("disconnect-during-persistence"));
      await vi.waitFor(() => {
        expect(harness.playerService.persistPlayerSnapshotInTransaction).toHaveBeenCalledOnce();
        expect(harness.gameState.getResourceVision("player-1")?.flagId).toBe(testFlag().id);
      });

      harness.socket.terminate();
      await vi.waitFor(() => expect(harness.registry.activeConnectionIdForPlayer("player-1")).toBeNull());
      persistence.resolve();
      await vi.waitFor(() => expect(
        harness.rollbackTravelTransaction
      ).toHaveBeenCalledOnce());
      expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(false);
      const rolledBack = harness.playerService.persistPlayerSnapshot.mock.calls.at(-1)![0];
      expect(rolledBack).toMatchObject({
        lat: playerRecord().position.lat,
        lon: playerRecord().position.lon,
        anchorLat: playerRecord().anchor.lat,
        anchorLon: playerRecord().anchor.lon
      });
      expect(harness.messages.some(
        (message) => message.type === "FLAG_VISITED" && message.requestId === "disconnect-during-persistence"
      )).toBe(false);

      ensureQueued.mockClear();
      harness.playerService.loadPlayer.mockResolvedValueOnce(playerRecord());
      reconnect = await harness.app.injectWS("/ws", { headers: harness.headers });
      reconnect.on("message", (data) => reconnectMessages.push(JSON.parse(data.toString()) as ServerMessage));
      reconnect.send(hello());
      await vi.waitFor(() => expect(reconnectMessages.find(
        (message) => message.type === "WELCOME"
      )).toMatchObject({ spawn: playerRecord().position }));
      expect(ensureQueued).not.toHaveBeenCalled();
    } finally {
      persistence.resolve();
      reconnect?.terminate();
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("rolls back an uncommitted transition replaced during persistence", async () => {
    const harness = await createFlagTransitionHarness();
    const persistence = createDeferred<void>();
    const replacementMessages: ServerMessage[] = [];
    let replacement: Awaited<ReturnType<typeof harness.app.injectWS>> | null = null;
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      harness.playerService.persistPlayerSnapshotInTransaction.mockImplementationOnce(() => persistence.promise);
      harness.flagService.getFlag.mockResolvedValue(testFlag());
      harness.socket.send(visitFlag("replacement-during-persistence"));
      await vi.waitFor(() => expect(harness.playerService.persistPlayerSnapshotInTransaction).toHaveBeenCalledOnce());

      replacement = await harness.app.injectWS("/ws", { headers: harness.headers });
      replacement.on("message", (data) => replacementMessages.push(JSON.parse(data.toString()) as ServerMessage));
      replacement.send(hello());
      await vi.waitFor(() => expect(replacementMessages.some((message) => message.type === "WELCOME")).toBe(true));
      persistence.resolve();
      await vi.waitFor(() => expect(
        harness.runtime.hasPlayerWorldTransition("player-1")
      ).toBe(false));

      expect(harness.messages.some(
        (message) => message.type === "FLAG_VISITED" && message.requestId === "replacement-during-persistence"
      )).toBe(false);
      expect(replacementMessages.some(
        (message) => message.type === "FLAG_VISITED" &&
          message.requestId === "replacement-during-persistence"
      )).toBe(false);
      expect(harness.gameState.getResourceVision("player-1")).toBeNull();
      expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(false);
    } finally {
      persistence.resolve();
      replacement?.terminate();
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("rolls back a failed persistence after disconnect without stale delivery", async () => {
    const harness = await createFlagTransitionHarness();
    const persistence = createDeferred<void>();
    const before = playerRecord();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      harness.playerService.persistPlayerSnapshotInTransaction.mockImplementationOnce(() => persistence.promise);
      harness.flagService.getFlag.mockResolvedValue(testFlag());
      harness.socket.send(visitFlag("failed-after-disconnect"));
      await vi.waitFor(() => expect(harness.playerService.persistPlayerSnapshotInTransaction).toHaveBeenCalledOnce());
      harness.socket.terminate();
      await vi.waitFor(() => expect(harness.registry.activeConnectionIdForPlayer("player-1")).toBeNull());
      persistence.reject(new Error("database unavailable"));
      await vi.waitFor(() => expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(false));

      expect(harness.playerService.persistPlayerSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
        lat: before.position.lat,
        lon: before.position.lon,
        anchorLat: before.anchor.lat,
        anchorLon: before.anchor.lon
      });
      expect(harness.gameState.getPlayer("player-1")).toBeDefined();
      expect(harness.messages.some(
        (message) => message.type === "FLAG_VISITED" ||
          (message.type === "ERROR" && message.requestId === "failed-after-disconnect")
      )).toBe(false);
    } finally {
      persistence.resolve();
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("does not roll back a committed flag visit when optional Resource Vision delivery fails", async () => {
    const harness = await createFlagTransitionHarness();
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => expect(harness.messages.some((message) => message.type === "WELCOME")).toBe(true));
      harness.collectibles.resourceVisionStatus.mockRejectedValueOnce(new Error("resource status unavailable"));
      harness.flagService.getFlag.mockResolvedValue(testFlag());
      harness.socket.send(visitFlag("resource-delivery-failure"));
      await vi.waitFor(() => expect(harness.messages.some(
        (message) => message.type === "FLAG_VISITED" && message.requestId === "resource-delivery-failure"
      )).toBe(true));
      await vi.waitFor(() => expect(harness.runtime.hasPlayerWorldTransition("player-1")).toBe(false));
      expect(harness.gameState.getResourceVision("player-1")?.flagId).toBe(testFlag().id);
      const committed = harness.gameState.snapshotForPlayer("player-1");
      expect(committed).toMatchObject({
        anchorLat: testFlag().lat,
        anchorLon: testFlag().lon
      });
      expect(distanceMeters(
        { lat: committed.lat, lon: committed.lon },
        { lat: testFlag().lat, lon: testFlag().lon }
      )).toBeCloseTo(75, 1);
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it.each([
    [false, "DEVELOPER_COMMAND_FORBIDDEN"],
    [true, "DEV_MOB_SPAWNED"]
  ] as const)(
    "enforces owner-only development world spawning at the authoritative socket boundary (owner=%s)",
    async (ownerAuthorized, expectedType) => {
      const app = Fastify();
      const config = loadConfig({
        NODE_ENV: "test",
        DEV_TOOLS_ENABLED: "true",
        DEV_ADMIN_TOOLS_ENABLED: "true"
      });
      const logger = createLogger("test");
      const registry = new ConnectionRegistry();
      const gameState = new GameState(config, logger);
      const playerService = {
        loadPlayer: vi.fn(async () => playerRecord()),
        markOnline: vi.fn(async () => undefined),
        persistPlayerSnapshot: vi.fn(async () => undefined),
        markOffline: vi.fn(async () => undefined)
      } as unknown as PlayerService;
      const authService = {
        sessionCookieName: "aa_session_dev",
        assertOrigin: vi.fn(),
        ...developerAuthMethods(
          ownerAuthorized ? ["developer:world-mutate"] : []
        ),
        authenticateSession: vi.fn(async () => ({
          sessionId: "session-1",
          verifiedGoogleSubject: ownerAuthorized ? "owner-subject" : "ordinary-subject",
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
        recordConnectionEvent: vi.fn(async () => undefined)
      } as unknown as AuthService;
      const combat = new CombatEngine({
        tickRateHz: 20,
        isPlayerAuthorityActive: (_playerId, accountId, connectionId) =>
          registry.isActiveConnection(accountId, connectionId)
      });
      const combatProfiles = {
        getOrCreate: vi.fn(async () => ({
          playerId: "player-1",
          maxHealth: 100,
          currentHealth: 100,
          baseAttackDamage: 10
        })),
        persistProfiles: vi.fn(async () => undefined)
      } as unknown as CombatProfileService;
      const worldRuntime = new WorldRuntime(config, registry, gameState, combat, logger);
      const developerSpawnedMobs = developerMobService(combat);
      const developerSpawnedPlants = {
        spawn: vi.fn(async () => ({
          entityId: "plant:dev:test",
          creatorPlayerId: "player-1",
          requestId: "plant-1",
          plantKey: "flax" as const,
          resourceType: "flax_fiber" as const,
          quantity: 3,
          regionCode: "NM",
          zoneId: "world:NM",
          position: { lat: 35.08445, lon: -106.6504 },
          state: "available" as const,
          stateRevision: 0,
          createdAt: new Date().toISOString(),
          harvestedAt: null,
          harvestedByPlayerId: null
        })),
        clearPersisted: vi.fn(async () => 1),
        recover: vi.fn(async () => [])
      } as never;

      await app.register(cookie);
      installAuthGuard(app, config, authService);
      await registerRealtime({
          infrastructure: {
              app: app,
              registry: registry,
              logger: logger,
              config: config
          },
          authority: {
              gameState: gameState,
              flagService: { listFlags: vi.fn(async () => []) } as unknown as FlagService,
              playerService: playerService,
              auth: authService,
              worldRuntime: worldRuntime
          },
          capabilities: {
          ...worldBootstrapLocationFixtures(),
              combat: combat,
              developerSpawnedMobs,
              developerSpawnedPlants,
              combatProfiles: combatProfiles
          }
      });
      await app.ready();
      const socket = await app.injectWS("/ws", {
        headers: {
          origin: config.CLIENT_ORIGIN,
          cookie: "aa_session_dev=test-session"
        }
      });
      const messages: ServerMessage[] = [];
      socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
      try {
        socket.send(hello());
        await vi.waitFor(() => {
          expect(messages.some((message) => message.type === "WELCOME")).toBe(true);
        });
        socket.send(JSON.stringify({
          type: "DEV_SPAWN_MOB",
          requestId: "spawn-1",
          archetype: "goblin",
          lat: 35.08445,
          lon: -106.6504
        }));
        socket.send(JSON.stringify({
          type: "DEV_SPAWN_PLANT",
          requestId: "plant-1",
          plantKey: "flax",
          lat: 35.08445,
          lon: -106.6504
        }));
        if (ownerAuthorized) {
          await vi.waitFor(() => expect(messages.some(
            (message) => message.type === "DEV_MOB_SPAWNED"
          )).toBe(true));
          await vi.waitFor(() => expect(messages.some(
            (message) => message.type === "DEV_PLANT_SPAWNED"
          )).toBe(true));
          expect(worldRuntime.commands.metricsSnapshot().depth).toBe(0);
        } else {
          for (const crafted of [
            { type: "DEV_CLEAR_MOBS", requestId: "clear-1" },
            { type: "DEV_CLEAR_PLANTS", requestId: "clear-plants-1" },
            {
              type: "DEV_TELEPORT",
              requestId: "teleport-1",
              lat: 35.08445,
              lon: -106.6504
            },
            {
              type: "DEV_VISIT_MINE",
              requestId: "mine-1",
              mineId: "11111111-1111-4111-8111-111111111111"
            },
            {
              type: "GRANT_OWN_DEV_ASSETS",
              requestId: "grant-1",
              gold: "100"
            },
            {
              type: "ADJUST_OWN_DEV_PROGRESSION",
              operationId: "progression-1",
              progressionType: "character_level",
              targetRank: 10
            },
            {
              type: "SET_OWN_DEV_SUBCLASS_UNLOCK",
              operationId: "subclass-1",
              subclassId: "reaver",
              unlocked: true
            },
            {
              type: "RESET_OWN_DEV_CLASS_COOLDOWNS",
              requestId: "cooldowns-1"
            }
          ]) {
            socket.send(JSON.stringify(crafted));
          }
        }
        await vi.waitFor(() => {
          if (expectedType === "DEVELOPER_COMMAND_FORBIDDEN") {
            expect(messages.filter(
              (message) => message.type === "ERROR" && message.code === expectedType
            )).toHaveLength(10);
          } else {
            expect(messages.some((message) => message.type === expectedType)).toBe(true);
          }
        });
        if (!ownerAuthorized) {
          expect(worldRuntime.commands.metricsSnapshot().depth).toBe(0);
          expect(messages.filter(
            (message): message is Extract<ServerMessage, { type: "ERROR" }> =>
              message.type === "ERROR" && message.code === "DEVELOPER_COMMAND_FORBIDDEN"
          ).every((message) => message.message === "Developer command is unavailable")).toBe(true);
        }
        const combatSnapshotsBefore = messages.filter(
          (message) => message.type === "COMBAT_SNAPSHOT"
        ).length;
        socket.send(JSON.stringify({
          type: "REQUEST_WORLD_RESYNC",
          requestId: "resync-1",
          combatSequence: 0,
          playerSequence: 0
        }));
        await vi.waitFor(() => {
          expect(
            messages.filter((message) => message.type === "COMBAT_SNAPSHOT").length
          ).toBeGreaterThan(combatSnapshotsBefore);
          expect(messages.some((message) => message.type === "PLAYER_SNAPSHOT")).toBe(true);
        });
        socket.send(JSON.stringify({
          type: "REQUEST_WORLD_RESYNC",
          requestId: "resync-2",
          combatSequence: 0,
          playerSequence: 0
        }));
        await vi.waitFor(() => {
          expect(messages.some(
            (message) => message.type === "ERROR" && message.code === "RESYNC_RATE_LIMITED"
          )).toBe(true);
        });
      } finally {
        socket.terminate();
        await app.close();
      }
    }
  );

  it("preserves movement order across live-session validation and async flag visits", async () => {
    const dateNow = vi.spyOn(Date, "now");
    let nowMs = 1_000;
    dateNow.mockImplementation(() => nowMs);
    const app = Fastify();
    const config = loadConfig({
      NODE_ENV: "test",
      PLAYER_SPEED_MPS: "500",
      WORLD_COMMAND_QUEUE_PER_PLAYER_MAX: "2"
    });
    const logger = createLogger("test");
    const registry = new ConnectionRegistry();
    const gameState = new GameState(config, logger);
    const revalidation = createDeferred<Awaited<ReturnType<AuthService["authenticateSession"]>>>();
    const flagLookup = createDeferred<FlagSnapshot | null>();
    const cityLookup = createDeferred<CitySnapshot | null>();
    const session = {
      sessionId: "session-1",
      verifiedEmail: "ash@example.com",
      account: {
        id: "account-1",
        status: "active" as const,
        trustTier: "new" as const,
        riskScore: 0,
        testAccessStatus: "approved" as const,
        testAccessRequestedAt: new Date(),
        testAccessDecidedAt: new Date(),
        createdAt: new Date(),
        lastLoginAt: null
      },
      player: {
        id: "player-1",
        accountId: "account-1",
        displayName: "Ash",
        personalFlagColor: "blue" as const,
        onboardingCompletedAt: new Date()
      },
      deviceInstallationId: "device-1",
      csrfToken: "csrf"
    };
    const authService = {
      sessionCookieName: "aa_session_dev",
      assertOrigin: vi.fn(),
      ...developerAuthMethods(),
      authenticateSession: vi.fn()
        .mockResolvedValueOnce(session)
        .mockImplementationOnce(() => revalidation.promise),
      recordConnectionEvent: vi.fn(async () => undefined)
    } as unknown as AuthService;
    const playerService = {
      loadPlayer: vi.fn(async () => playerRecord()),
      markOnline: vi.fn(async () => undefined),
      persistPlayerSnapshot: vi.fn(async () => undefined),
      persistPlayerSnapshotInTransaction: vi.fn(async () => undefined),
      persistTravelSnapshot: vi.fn(async () => ({
        replayed: false,
        cost: 1,
        hungerBefore: 2_000,
        hungerAfter: 1_999,
        baseCapacity: 2_000
      })),
      persistTravelSnapshotInTransaction: vi.fn(async () => ({
        replayed: false,
        cost: 1,
        hungerBefore: 2_000,
        hungerAfter: 1_999,
        baseCapacity: 2_000
      })),
      markOffline: vi.fn(async () => undefined)
    } as unknown as PlayerService;
    const orderedFlag: FlagSnapshot = {
        id: "00000000-0000-4000-8000-000000000001",
        controlType: "kingdom",
        ownerId: "player-1",
        name: "Ordered Flag",
        lat: 35.0844,
        lon: -106.6504,
        packageId: null,
        elevationM: null,
        terrainClass: null,
        biome: null,
        ecoregion: null,
        claimRadiusM: 350,
        cityId: null,
        createdAt: "2026-07-09T00:00:00.000Z"
      };
    const overflowFlag = {
      ...flagSnapshot("00000000-0000-4000-8000-000000000003", 35.0944),
      controlType: "kingdom" as const
    };
    const flagService = {
      listFlags: vi.fn(async () => []),
      getFlag: vi.fn((flagId: string) => {
        if (flagId === "00000000-0000-4000-8000-000000000001") {
          return worldRuntime.hasPlayerWorldTransition("player-1")
            ? flagLookup.promise : Promise.resolve(orderedFlag);
        }
        return Promise.resolve(flagId === overflowFlag.id ? overflowFlag : null);
      })
    } as unknown as FlagService;
    const nearbyCity = citySnapshot("00000000-0000-4000-8000-000000000011");
    const cityService = {
      districtBenefits: { refreshRuntime: vi.fn(async () => undefined), clearRuntime: vi.fn() },
      listCitiesNear: vi.fn(async () => [nearbyCity]),
      getCity: vi.fn(() => cityLookup.promise)
    } as unknown as CityService;
    const combat = new CombatEngine({
      tickRateHz: 20,
      isPlayerAuthorityActive: (_playerId, accountId, connectionId) =>
        registry.isActiveConnection(accountId, connectionId)
    });
    const combatProfiles = {
      getOrCreate: vi.fn(async () => ({
        playerId: "player-1",
        maxHealth: 100,
        currentHealth: 100,
        baseAttackDamage: 10
      })),
      persistProfiles: vi.fn(async () => undefined)
    } as unknown as CombatProfileService;
    const worldRuntime = new WorldRuntime(config, registry, gameState, combat, logger);

    await app.register(cookie);
    installAuthGuard(app, config, authService);
    await registerRealtime({
        infrastructure: {
            app: app,
            registry: registry,
            logger: logger,
            config: config
        },
        authority: {
            gameState: gameState,
            flagService: flagService,
            playerService: playerService,
            auth: authService,
            worldRuntime: worldRuntime
        },
        capabilities: {
          ...worldBootstrapLocationFixtures(),
            combat: combat,
            combatProfiles: combatProfiles,
            cities: cityService
        }
    });
    await app.ready();
    const socket = await app.injectWS("/ws", {
      headers: {
        origin: config.CLIENT_ORIGIN,
        cookie: "aa_session_dev=test-session"
      }
    });
    const messages: ServerMessage[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));

    try {
      socket.send(hello());
      await vi.waitFor(() => {
        expect(messages.some((message) => message.type === "WELCOME")).toBe(true);
      });
      nowMs += 60_001;
      socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "move-a",
        lat: 35.0845,
        lon: -106.6504
      } satisfies ClientMessage));
      await vi.waitFor(() => expect(authService.authenticateSession).toHaveBeenCalledTimes(2));
      socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "move-b",
        lat: 35.0846,
        lon: -106.6504
      } satisfies ClientMessage));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(worldRuntime.commands.metricsSnapshot().depth).toBe(0);
      revalidation.resolve(session);
      await vi.waitFor(() => expect(worldRuntime.commands.metricsSnapshot().depth).toBe(2));

      worldRuntime.tick(0.05);

      await vi.waitFor(() => {
        expect(messages.filter((message) => message.type === "MOVE_ACCEPTED")).toHaveLength(2);
      });

      const acceptances = messages.filter(
        (message): message is Extract<ServerMessage, { type: "MOVE_ACCEPTED" }> =>
          message.type === "MOVE_ACCEPTED"
      );
      expect(acceptances.map((message) => message.requestId)).toEqual(["move-a", "move-b"]);
      expect(gameState.getPlayer("player-1")?.position).toEqual({
        lat: 35.0846,
        lon: -106.6504
      });

      const citySnapshotsBeforeFlagVisit = messages.filter(
        (message) => message.type === "CITIES_SNAPSHOT"
      ).length;
      socket.send(JSON.stringify({
        type: "VISIT_FLAG",
        requestId: "visit-ordered",
        flagId: "00000000-0000-4000-8000-000000000001",
        source: "visible_map"
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(flagService.getFlag).toHaveBeenCalledWith(
          "00000000-0000-4000-8000-000000000001"
        );
        expect(worldRuntime.commands.metricsSnapshot().depth).toBe(0);
      });

      await vi.waitFor(() => expect(worldRuntime.hasPlayerWorldTransition("player-1")).toBe(true));
      const postVisitTarget = { lat: 35.0847, lon: -106.6504 };
      socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "move-after-visit",
        boundTravelRequestId: "visit-ordered",
        ...postVisitTarget
      } satisfies ClientMessage));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(worldRuntime.commands.metricsSnapshot().depth).toBe(0);

      flagLookup.resolve(orderedFlag);
      await vi.waitFor(() => {
        expect(messages.some(
          (message) =>
            message.type === "FLAG_VISITED" && message.requestId === "visit-ordered"
        )).toBe(true);
        expect(messages.filter(
          (message) => message.type === "CITIES_SNAPSHOT"
        ).length).toBeGreaterThan(citySnapshotsBeforeFlagVisit);
        expect(messages.some(
          (message) =>
            message.type === "CITIES_SNAPSHOT" &&
            message.cities.some((city) => city.id === nearbyCity.id)
        )).toBe(true);
      });
      await vi.waitFor(() => expect(
        worldRuntime.hasPlayerWorldTransition("player-1")
      ).toBe(false));
      expect(worldRuntime.commands.metricsSnapshot().depth).toBe(1);
      worldRuntime.tick(0.05);
      expect(worldRuntime.commands.metricsSnapshot().depth).toBe(0);
      await vi.waitFor(() => expect(messages.some(
        (message) => message.type === "MOVE_ACCEPTED" &&
          message.requestId === "move-after-visit"
      )).toBe(true));

      socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "move-after-commit",
        ...postVisitTarget
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(worldRuntime.commands.metricsSnapshot().depth).toBe(1);
      });
      worldRuntime.tick(0);
      expect(gameState.getPlayer("player-1")?.target).toEqual(postVisitTarget);
      await vi.waitFor(() => {
        expect(messages.some(
          (message) =>
            message.type === "MOVE_ACCEPTED" && message.requestId === "move-after-commit"
        )).toBe(true);
      });

      socket.send(JSON.stringify({
        type: "VISIT_FLAG",
        requestId: "visit-missing",
        flagId: "00000000-0000-4000-8000-000000000002",
        source: "visible_map"
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(messages.some(
          (message) =>
            message.type === "ERROR" &&
            message.requestId === "visit-missing" &&
            message.code === "FLAG_NOT_FOUND"
        )).toBe(true);
      });
      expect(worldRuntime.commands.metricsSnapshot().depth).toBe(0);
      expect(gameState.getPlayer("player-1")?.target).toEqual(postVisitTarget);

      const citySnapshotsBeforeCityVisit = messages.filter(
        (message) => message.type === "CITIES_SNAPSHOT"
      ).length;
      socket.send(JSON.stringify({
        type: "VISIT_CITY",
        requestId: "visit-city-ordered",
        cityId: "00000000-0000-4000-8000-000000000010"
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(cityService.getCity).toHaveBeenCalledWith(
          "00000000-0000-4000-8000-000000000010"
        );
        expect(worldRuntime.commands.metricsSnapshot().depth).toBe(0);
      });
      const postCityTarget = { lat: 35.0851, lon: -106.6504 };
      socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "move-after-city",
        ...postCityTarget
      } satisfies ClientMessage));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(worldRuntime.commands.metricsSnapshot().depth).toBe(0);

      cityLookup.resolve(citySnapshot("00000000-0000-4000-8000-000000000010"));
      await vi.waitFor(() => {
        expect(worldRuntime.commands.metricsSnapshot().depth).toBe(1);
        expect(messages.some(
          (message) =>
            message.type === "CITY_VISITED" && message.requestId === "visit-city-ordered"
        )).toBe(true);
        expect(messages.filter(
          (message) => message.type === "CITIES_SNAPSHOT"
        ).length).toBeGreaterThan(citySnapshotsBeforeCityVisit);
      });
      worldRuntime.tick(0);
      await vi.waitFor(() => expect(messages.some((message) =>
        message.type === "MOVE_ACCEPTED" && message.requestId === "move-after-city"
      )).toBe(true));
      socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "move-after-city-commit",
        ...postCityTarget
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(worldRuntime.commands.metricsSnapshot().depth).toBe(1);
      });
      worldRuntime.tick(0);
      expect(gameState.getPlayer("player-1")?.target).toEqual(postCityTarget);

      const positionBeforeOverflowVisit = gameState.getPlayer("player-1")?.position;
      const visitsBeforeOverflow = messages.filter(
        (message) => message.type === "FLAG_VISITED"
      ).length;
      for (const [requestId, lat] of [
        ["fill-a", 35.0845],
        ["fill-b", 35.0846]
      ] as const) {
        socket.send(JSON.stringify({
          type: "MOVE_TO",
          requestId,
          lat,
          lon: -106.6504
        } satisfies ClientMessage));
      }
      await vi.waitFor(() => expect(worldRuntime.commands.metricsSnapshot().depth).toBe(2));
      socket.send(JSON.stringify({
        type: "VISIT_FLAG",
        requestId: "visit-overflow",
        flagId: overflowFlag.id,
        source: "visible_map"
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(messages.some(
          (message) =>
            message.type === "ERROR" &&
            message.requestId === "visit-overflow" &&
            message.code === "PLAYER_WORLD_COMMAND_PENDING"
        )).toBe(true);
      });
      expect(messages.filter((message) => message.type === "FLAG_VISITED")).toHaveLength(
        visitsBeforeOverflow
      );
      expect(gameState.getPlayer("player-1")?.position).toEqual(positionBeforeOverflowVisit);

      (authService.authenticateSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new AuthError("TEST_ACCESS_REVOKED", "Test access revoked", 403)
      );
      nowMs += 60_001;
      socket.send(JSON.stringify({
        type: "MOVE_TO",
        requestId: "move-after-revocation",
        lat: 35.0847,
        lon: -106.6504
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(messages.some(
          (message) =>
            message.type === "AUTH_SESSION_INVALID" &&
            message.code === "TEST_ACCESS_REVOKED"
        )).toBe(true);
      });
    } finally {
      revalidation.resolve(session);
      flagLookup.resolve(null);
      cityLookup.resolve(null);
      socket.terminate();
      await app.close();
      dateNow.mockRestore();
    }
  });

  it("replicates city founding, public joining, flag conversion, and reconnect membership", async () => {
    const app = Fastify();
    const config = loadConfig({
      NODE_ENV: "test",
      CITY_FLAG_CONVERSION_DURATION_MS: "10"
    });
    const logger = createLogger("test");
    const registry = new ConnectionRegistry();
    const gameState = new GameState(config, logger);
    let city = citySnapshot("00000000-0000-4000-8000-000000000020");
    const memberships = new Map<string, {
      cityId: string;
      cityName: string;
      role: "mayor" | "member";
      joinedAt: string;
      expansionFlagCount: number;
      expansionFlagLimit: number;
    }>();
    const getCityMembership = vi.fn(
      async (playerId: string) => memberships.get(playerId) ?? null
    );
    let founded = false;
    const sessionFor = (playerId: string, accountId: string, displayName: string) => ({
      sessionId: `session-${playerId}`,
      verifiedEmail: `${playerId}@example.com`,
      account: {
        id: accountId,
        status: "active" as const,
        trustTier: "new" as const,
        riskScore: 0,
        testAccessStatus: "approved" as const,
        testAccessRequestedAt: new Date(),
        testAccessDecidedAt: new Date(),
        createdAt: new Date(),
        lastLoginAt: null
      },
      player: {
        id: playerId,
        accountId,
        displayName,
        personalFlagColor: "blue" as const,
        onboardingCompletedAt: new Date()
      },
      deviceInstallationId: `device-${playerId}`,
      csrfToken: "csrf"
    });
    const ashSession = sessionFor("player-a", "account-a", "Ash");
    const bexSession = sessionFor("player-b", "account-b", "Bex");
    const authService = {
      sessionCookieName: "aa_session_dev",
      assertOrigin: vi.fn(),
      ...developerAuthMethods(),
      authenticateSession: vi.fn()
        .mockResolvedValueOnce(ashSession)
        .mockResolvedValueOnce(bexSession)
        .mockResolvedValueOnce(bexSession),
      recordConnectionEvent: vi.fn(async () => undefined)
    } as unknown as AuthService;
    const playerService = {
      loadPlayer: vi.fn(async (playerId: string) => ({
        ...playerRecord(),
        playerId,
        username: playerId === "player-a" ? "Ash" : "Bex"
      })),
      markOnline: vi.fn(async () => undefined),
      persistPlayerSnapshot: vi.fn(async () => undefined),
      markOffline: vi.fn(async () => undefined)
    } as unknown as PlayerService;
    const seatFlag: FlagSnapshot = {
      ...flagSnapshot(city.seatFlagId),
      controlType: "city_seat",
      cityId: city.id
    };
    const contributedFlag: FlagSnapshot = {
      ...flagSnapshot("00000000-0000-4000-8000-000000000021"),
      controlType: "city",
      ownerId: "player-b",
      cityId: city.id
    };
    const foundingTerritoryFlags = [
      seatFlag,
      ...Array.from({ length: 5 }, (_, index): FlagSnapshot => ({
        ...flagSnapshot(
          `00000000-0000-4000-8000-${String(30 + index).padStart(12, "0")}`
        ),
        controlType: "city",
        cityId: city.id
      }))
    ];
    const flagService = {
      listFlags: vi.fn(async () => []),
      currentFlagSetRevision: vi.fn(async () => 42),
      getMapFlag: vi.fn(async (flagId: string) =>
        flagId === contributedFlag.id
          ? contributedFlag
          : foundingTerritoryFlags.find(({ id }) => id === flagId) ?? null)
    } as unknown as FlagService;
    const cityService = {
      districtBenefits: { refreshRuntime: vi.fn(async () => undefined), clearRuntime: vi.fn() },
      listCitiesNear: vi.fn(async () => founded ? [city] : []),
      getMembership: getCityMembership,
      foundCity: vi.fn(async () => {
        founded = true;
        memberships.set("player-a", {
          cityId: city.id,
          cityName: city.name,
          role: "mayor",
          joinedAt: "2026-07-18T00:00:00.000Z",
          expansionFlagCount: 0,
          expansionFlagLimit: 6
        });
        return {
          city,
          seatFlagId: seatFlag.id,
          territoryFlagIds: foundingTerritoryFlags.map(({ id }) => id),
          annexedFlags: [],
          replayed: false
        };
      }),
      joinCity: vi.fn(async (playerId: string) => {
        const membership = {
          cityId: city.id,
          cityName: city.name,
          role: "member" as const,
          joinedAt: "2026-07-18T00:01:00.000Z",
          expansionFlagCount: 0,
          expansionFlagLimit: 11
        };
        memberships.set(playerId, membership);
        for (const [memberId, current] of memberships) {
          memberships.set(memberId, { ...current, expansionFlagLimit: 11 });
        }
        return {
          membership,
          info: {
            city,
            memberCount: memberships.size,
            expansionFlagCount: 0,
            expansionFlagLimit: 11,
            membership,
            joinAllowed: false,
            joinReason: "Already a member",
            mayorClaimAllowed: false,
            mayorClaimReason: "Ash is the current Mayor"
          },
          replayed: false
        };
      }),
      leaveCity: vi.fn(async (playerId: string) => {
        memberships.delete(playerId);
        for (const [memberId, current] of memberships) {
          memberships.set(memberId, { ...current, expansionFlagLimit: 6 });
        }
        return {
          cityId: city.id,
          info: {
            city,
            memberCount: memberships.size,
            expansionFlagCount: 0,
            expansionFlagLimit: 6,
            membership: null,
            joinAllowed: true,
            joinReason: null,
            mayorClaimAllowed: false,
            mayorClaimReason: "Join this city before becoming Mayor"
          },
          replayed: false
        };
      }),
      relinquishMayor: vi.fn(async (playerId: string) => {
        const { mayorUsername: _mayorUsername, mayorColor: _mayorColor, ...withoutMayor } = city;
        void _mayorUsername;
        void _mayorColor;
        city = { ...withoutMayor, mayorPlayerId: null };
        const membership = memberships.get(playerId);
        if (membership) memberships.set(playerId, { ...membership, role: "member" });
        return { city, replayed: false };
      }),
      claimMayor: vi.fn(async (playerId: string) => {
        city = {
          ...city,
          mayorPlayerId: playerId,
          mayorUsername: playerId === "player-b" ? "Bex" : playerId
        };
        const membership = memberships.get(playerId);
        if (membership) memberships.set(playerId, { ...membership, role: "mayor" });
        return { city, replayed: false };
      }),
      previewCityFlagConversion: vi.fn(async (
        _playerId: string,
        flagId: string
      ) => ({
        cityId: city.id,
        cityName: city.name,
        flagId,
        flagName: contributedFlag.name,
        position: {
          lat: contributedFlag.lat,
          lon: contributedFlag.lon
        }
      })),
      replayCityFlagConversion: vi.fn(async () => null),
      convertCityFlag: vi.fn(async () => {
        const membership = memberships.get("player-b");
        if (membership) {
          memberships.set("player-b", { ...membership, expansionFlagCount: 1 });
        }
        return {
          cityId: city.id,
          flagId: contributedFlag.id,
          memberCount: 1,
          expansionFlagCount: 1,
          expansionFlagLimit: 6,
          replayed: false
        };
      })
    } as unknown as CityService;

    await app.register(cookie);
    installAuthGuard(app, config, authService);
    await registerRealtime({
        infrastructure: {
            app: app,
            registry: registry,
            logger: logger,
            config: config
        },
        authority: {
            gameState: gameState,
            flagService: flagService,
            playerService: playerService,
            auth: authService,
        },
        capabilities: {
          ...worldBootstrapLocationFixtures(),
            combat: new CombatEngine({ tickRateHz: config.SERVER_TICK_HZ }),
            cities: cityService
        }
    });
    await app.ready();
    const headers = {
      origin: config.CLIENT_ORIGIN,
      cookie: "aa_session_dev=test-session"
    };
    const ash = await app.injectWS("/ws", { headers });
    const bex = await app.injectWS("/ws", { headers });
    const ashMessages: ServerMessage[] = [];
    const bexMessages: ServerMessage[] = [];
    ash.on("message", (data) => ashMessages.push(JSON.parse(data.toString()) as ServerMessage));
    bex.on("message", (data) => bexMessages.push(JSON.parse(data.toString()) as ServerMessage));

    try {
      ash.send(hello());
      bex.send(hello());
      await vi.waitFor(() => {
        expect(ashMessages.some(({ type }) => type === "WELCOME")).toBe(true);
        expect(bexMessages.some(({ type }) => type === "WELCOME")).toBe(true);
      });

      ash.send(JSON.stringify({
        type: "FOUND_CITY",
        requestId: "found-city",
        flagId: seatFlag.id
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(ashMessages.some(({ type }) => type === "CITY_FOUNDED")).toBe(true);
        expect(ashMessages.some(
          (message) => message.type === "CITY_TERRITORY_SYNC" &&
            message.flags.some((flag) => flag.controlType === "city_seat")
        )).toBe(true);
        expect(ashMessages.filter(
          (message) => message.type === "FLAG_UPDATED" &&
            message.flag.cityId === city.id &&
            message.flagSetRevision === 42
        )).toHaveLength(6);
        expect(bexMessages.some(
          (message) => message.type === "CITIES_SNAPSHOT" && message.cities[0]?.id === city.id
        )).toBe(true);
      });

      bex.send(JSON.stringify({
        type: "JOIN_CITY",
        requestId: "join-city",
        cityId: city.id
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(bexMessages.some(
          (message) => message.type === "CITY_JOINED" && message.membership.role === "member"
        )).toBe(true);
        expect(ashMessages.some(
          (message) => message.type === "SOCIAL_STATE_CHANGED" && message.playerId === "player-b"
        )).toBe(true);
      });

      ash.send(JSON.stringify({
        type: "RELINQUISH_CITY_MAYOR",
        requestId: "relinquish-city-mayor",
        cityId: city.id
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(bexMessages.some(
          (message) =>
            message.type === "CITY_MAYOR_UPDATED" &&
            message.action === "relinquished" &&
            message.city.mayorPlayerId === null
        )).toBe(true);
      });

      bex.send(JSON.stringify({
        type: "CLAIM_CITY_MAYOR",
        requestId: "claim-city-mayor",
        cityId: city.id
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(ashMessages.some(
          (message) =>
            message.type === "CITY_MAYOR_UPDATED" &&
            message.action === "claimed" &&
            message.city.mayorPlayerId === "player-b"
        )).toBe(true);
        expect(bexMessages.some(
          (message) =>
            message.type === "CITY_MAYOR_UPDATED" &&
            message.action === "claimed" &&
            message.city.mayorPlayerId === "player-b"
        )).toBe(true);
        expect(bexMessages.some(
          (message) =>
            message.type === "CITY_MEMBERSHIP_SNAPSHOT" &&
            message.membership?.role === "mayor"
        )).toBe(true);
      });

      ash.send(JSON.stringify({
        type: "LEAVE_CITY",
        requestId: "leave-city",
        cityId: city.id
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(ashMessages.some(
          (message) =>
            message.type === "CITY_LEFT" &&
            message.cityId === city.id &&
            message.info.memberCount === 1
        )).toBe(true);
        expect(bexMessages.some(
          (message) =>
            message.type === "CITY_MEMBERSHIP_UPDATED" &&
            message.action === "left" &&
            message.playerId === "player-a" &&
            message.memberCount === 1
        )).toBe(true);
        expect(ashMessages.some(
          (message) =>
            message.type === "CITY_MEMBERSHIP_SNAPSHOT" &&
            message.membership === null
        )).toBe(true);
      });

      bex.send(JSON.stringify({
        type: "CONVERT_CITY_FLAG",
        requestId: "convert-city-flag",
        flagId: contributedFlag.id
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(bexMessages.some(
          (message) =>
            message.type === "CITY_FLAG_CONVERSION_STARTED" &&
            message.requestId === "convert-city-flag"
        )).toBe(true);
        expect(bexMessages.some(({ type }) => type === "CITY_FLAG_CONVERTED")).toBe(true);
        expect(ashMessages.some(
          (message) => message.type === "FLAG_UPDATED" && message.flag.id === contributedFlag.id
        )).toBe(true);
      });

      bex.terminate();
      const reconnected = await app.injectWS("/ws", { headers });
      const reconnectMessages: ServerMessage[] = [];
      reconnected.on("message", (data) =>
        reconnectMessages.push(JSON.parse(data.toString()) as ServerMessage));
      reconnected.send(hello());
      await vi.waitFor(() => {
        expect(reconnectMessages.some(
          (message) =>
            message.type === "CITY_MEMBERSHIP_SNAPSHOT" &&
            message.membership?.cityId === city.id &&
            message.membership.role === "mayor" &&
            message.membership.expansionFlagCount === 1 &&
            message.membership.expansionFlagLimit === 6
        )).toBe(true);
        expect(reconnectMessages.some(
          (message) => message.type === "CITIES_SNAPSHOT" && message.cities[0]?.id === city.id
        )).toBe(true);
      });
      reconnected.terminate();
    } finally {
      ash.terminate();
      bex.terminate();
      await app.close();
    }
  });

});

async function createFlagTransitionHarness(
  configOverrides: NodeJS.ProcessEnv = {},
  worldLookup?: {
    lookup(lat: number, lon: number): Promise<unknown>;
    lookupGameplayEnvironment(lat: number, lon: number): Promise<unknown>;
  },
  options: {
    developerCapabilities?: DeveloperCapability[];
    pets?: PetService;
    flagAccess?: FlagAccessService;
    resourceVisionJobs?: ResourceVisionJobQueue;
    populationV2?: PopulationV2RealtimeHooks;
    manorPresence?: ManorPresenceService;
    manorStorage?: ManorStorageService;
    manorRuntime?: ManorRuntime;
    canonicalLocation?: PlayerLocationSnapshot;
    websocketPath?: string;
    captureTelemetryPlayerSnapshot?: (
      playerId: string,
      sessionId: string,
      reason: "login" | "logout" | "terminal_disconnect"
    ) => void | Promise<void>;
    player?: PlayerRecord;
  } = {}
) {
  const app = Fastify();
  const config = loadConfig({ NODE_ENV: "test", ...configOverrides });
  const logger = createLogger("test");
  const registry = new ConnectionRegistry();
  const gameState = new GameState(config, logger);
  const flagLookup = createDeferred<FlagSnapshot | null>();
  const rollbackTravelTransaction = vi.fn();
  let flagRecheckPending = true;
  const flagService = {
    listFlags: vi.fn(async () => []),
    // Catalog lookup precedes the transition; gate the authoritative recheck.
    getFlag: vi.fn(async () => {
      if (runtime.hasPlayerWorldTransition("player-1") && flagRecheckPending) {
        flagRecheckPending = false;
        return flagLookup.promise;
      }
      return testFlag();
    }),
    createForPlayer: vi.fn(async () => ({ flag: testFlag() })),
    structureWarfare: {
      recoverRepairsForServerShutdown: vi.fn(async () => undefined),
      reconcileIgnitions: vi.fn(async () => [])
    }
  };
  const persistPlayerSnapshotInTransaction = vi.fn(async (_client: unknown, snapshot: PlayerSnapshot): Promise<void> => {
    void snapshot;
  });
  const playerService = {
    loadPlayer: vi.fn(async () => options.player ?? playerRecord()),
    markOnline: vi.fn(async () => undefined),
    persistPlayerSnapshot: vi.fn(async (snapshot: PlayerSnapshot): Promise<void> => {
      void snapshot;
    }),
    persistPlayerSnapshotInTransaction,
    persistTravelSnapshot: vi.fn(async () => ({
      replayed: false,
      cost: 1,
      hungerBefore: 2_000,
      hungerAfter: 1_999,
      baseCapacity: 2_000
    })),
    persistTravelSnapshotInTransaction: vi.fn(async (client: unknown, snapshot: PlayerSnapshot) => {
      await persistPlayerSnapshotInTransaction(client, snapshot);
      return {
        replayed: false,
        cost: 1,
        hungerBefore: 2_000,
        hungerAfter: 1_999,
        baseCapacity: 2_000
      };
    }),
    markOffline: vi.fn(async () => undefined)
  };
  const playerLocations = {
    load: vi.fn(async () => options.canonicalLocation ?? null),
    commitPortalTransition: vi.fn(async (input: Parameters<PlayerLocationService["commitPortalTransition"]>[0]) => ({
      location: { ...input.destination, zoneId: "world:world_v1_lat35_lon-107", revision: input.expectedRevision + 1 }
    }))
  } as unknown as PlayerLocationService;
  const authService = {
    sessionCookieName: "aa_session_dev",
    assertOrigin: vi.fn(),
    ...developerAuthMethods(options.developerCapabilities ?? ["developer:world-mutate"]),
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
    recordConnectionEvent: vi.fn(async () => undefined)
  } as unknown as AuthService;
  const combat = new CombatEngine({
    tickRateHz: config.SERVER_TICK_HZ,
    playerMovementSpeedMps: config.PLAYER_SPEED_MPS,
    isPlayerAuthorityActive: (playerId, accountId, connectionId) =>
      registry.isActiveConnection(accountId, connectionId) &&
      registry.isActivePlayerConnection(playerId, connectionId),
    getAuthoritativeViewCircle: (playerId) => gameState.getGameplayViewCircle(playerId),
    movePlayerToward: (playerId, target) => gameState.setCombatTarget(playerId, target),
    stopPlayer: (playerId) => gameState.stopPlayer(playerId)
  });
  const combatProfiles = {
    getOrCreate: vi.fn(async () => ({
      playerId: "player-1",
      maxHealth: 100,
      currentHealth: 100,
      baseAttackDamage: 10
    })),
    persistProfiles: vi.fn(async () => undefined)
  } as unknown as CombatProfileService;
  const runtime = new WorldRuntime(config, registry, gameState, combat, logger);
  const developerSpawnedMobs = developerMobService(combat);
  const collectibles = {
    resourceVisionStatus: vi.fn(async () => null),
    listAvailableInVision: vi.fn(async (
      regionCode: string,
      resourceVision: ResourceVision | null
    ) => {
      void regionCode;
      void resourceVision;
      return [];
    }),
    waterHighlightsForVision: vi.fn(async () => []),
    inventoryForPlayer: vi.fn(async () => ({
      playerId: "player-1",
      items: [],
      totals: { wood: 0, stone: 0, food: 0, ore: 0, water: 0 }
    })),
    collectWaterAt: vi.fn()
  };
  const harvestSessions = {
    startHarvest: vi.fn(),
    completeHarvest: vi.fn(),
    cancelHarvest: vi.fn(),
    activeSessionForPlayer: vi.fn(async () => null)
  };
  const droppedItems = {
    dropItem: vi.fn(async () => { throw new Error("fixture has no droppable item"); }),
    isEquipmentDrop: vi.fn(async () => false),
    pickupDroppedItem: vi.fn(async () => { throw new Error("fixture has no ground item"); }),
    listActive: vi.fn(async () => []),
    listActiveInGameplayCircle: vi.fn(async () => []),
    listActiveManorDrops: vi.fn(async () => [])
  };

  await app.register(cookie);
  installAuthGuard(app, config, authService);
  const realtime = await registerRealtime({
      infrastructure: {
          app: app,
          registry: registry,
          logger: logger,
          config: config,
          worldLookup: worldLookup as never,
          ...(options.captureTelemetryPlayerSnapshot
            ? {
                captureTelemetryPlayerSnapshot:
                  options.captureTelemetryPlayerSnapshot
              }
            : {})
      },
      authority: {
          gameState: gameState,
          flagService: flagService as unknown as FlagService,
          playerService: playerService as unknown as PlayerService,
          auth: authService,
          worldRuntime: runtime,
          flagAccess: options.flagAccess ?? permissiveFlagAccess(rollbackTravelTransaction)
      },
      capabilities: {
          ...worldBootstrapLocationFixtures(),
          collectibles: collectibles as unknown as CollectibleService,
          harvestSessions: harvestSessions as unknown as HarvestSessionService,
          resourceVisionJobs: options.resourceVisionJobs,
          droppedItems: droppedItems as unknown as DroppedItemService,
          combat: combat,
          developerSpawnedMobs,
          combatProfiles: combatProfiles,
          manorPresence: options.manorPresence,
          manorStorage: options.manorStorage,
          manorRuntime: options.manorRuntime,
          pets: options.pets,
          playerLocations,
          portals: new PortalRegistry()
      },
      operations: {
          populationV2: options.populationV2
      }
  });
  await app.ready();
  const socket = await app.injectWS(options.websocketPath ?? "/ws", {
    headers: {
      origin: config.CLIENT_ORIGIN,
      cookie: "aa_session_dev=test-session"
    }
  });
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  const headers = {
    origin: config.CLIENT_ORIGIN,
    cookie: "aa_session_dev=test-session"
  };
  return {
    app,
    socket,
    headers,
    messages,
    realtime,
    runtime,
    combat,
    logger,
    registry,
    gameState,
    authService,
    flagLookup,
    rollbackTravelTransaction,
    flagService,
    playerService,
    collectibles,
    harvestSessions,
    droppedItems
  };
}

let developerMobSequence = 0;

function developerMobService(combat: CombatEngine): DeveloperSpawnedMobService {
  const owned = new Set<string>();
  return {
    spawn: vi.fn(async (input) => {
      const entityId = `mob:dev:websocket-${++developerMobSequence}`;
      const mob = combat.spawnMob({
        entityId,
        archetype: input.archetype,
        ...(input.appearanceVariant ? { appearanceVariant: input.appearanceVariant } : {}),
        worldAi: true,
        position: input.position,
        homePosition: input.position,
        regionCode: input.regionCode,
        zoneId: input.zoneId,
        originFlagId: input.originFlagId
      });
      owned.add(entityId);
      return {
        entityId,
        creatorPlayerId: input.creatorPlayerId,
        requestId: input.requestId,
        archetype: input.archetype,
        appearanceVariant: mob.appearanceVariant ?? "normal",
        regionCode: input.regionCode,
        zoneId: input.zoneId,
        position: input.position,
        originFlagId: input.originFlagId
      };
    }),
    recover: vi.fn(async () => undefined),
    owns: vi.fn((entityId: string) => owned.has(entityId)),
    removeAfterDefeat: vi.fn(async (entityId: string) => {
      owned.delete(entityId);
    }),
    clearPersisted: vi.fn(async () => {
      let removedCount = 0;
      for (const entityId of owned) {
        if (combat.despawnMob(entityId)) removedCount += 1;
      }
      owned.clear();
      return removedCount;
    })
  } as unknown as DeveloperSpawnedMobService;
}

function permissiveFlagAccess(onRollback: () => void = () => undefined): FlagAccessService {
  const authorization = {
    flagId: testFlag().id,
    controlType: "personal",
    ownerPlayerId: "player-1",
    mode: "public" as const,
    publicTollGold: 0n,
    travelerAccountId: "account-1",
    ownerAccountId: "account-1",
    decision: {
      allowed: true,
      requestable: false,
      reasonCode: "ALLOWED_OWNER" as const,
      tollGold: "0"
    }
  };
  return {
    authorize: vi.fn(async () => authorization),
    executeTravel: vi.fn(async (input) => {
      try {
        return {
          authorization,
          value: await input.commit({} as Parameters<typeof input.commit>[0], authorization),
          replayed: false,
          travelerGoldBalance: null,
          ownerGoldBalance: null
        };
      } catch (error) {
        onRollback();
        throw error;
      }
    })
  } as unknown as FlagAccessService;
}

async function createCombatReplacementHarness() {
  const app = Fastify();
  const config = loadConfig({ NODE_ENV: "test" });
  const logger = createLogger("test");
  const registry = new ConnectionRegistry();
  const gameState = new GameState(config, logger);
  const playerService = {
    loadPlayer: vi.fn(async () => playerRecord()),
    markOnline: vi.fn(async () => undefined),
    persistPlayerSnapshot: vi.fn(async () => undefined),
    markOffline: vi.fn(async () => undefined)
  } as unknown as PlayerService;
  const authService = {
    sessionCookieName: "aa_session_dev",
    assertOrigin: vi.fn(),
    ...developerAuthMethods(),
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
    recordConnectionEvent: vi.fn(async () => undefined)
  } as unknown as AuthService;
  const combat = new CombatEngine({
    tickRateHz: 20,
    isPlayerAuthorityActive: (playerId, accountId, connectionId) =>
      registry.isActiveConnection(accountId, connectionId) &&
      registry.isActivePlayerConnection(playerId, connectionId),
    getAuthoritativeViewCircle: (playerId) => gameState.getGameplayViewCircle(playerId)
  });
  const combatProfiles = {
    getOrCreate: vi.fn(async () => ({
      playerId: "player-1",
      maxHealth: 100,
      currentHealth: 50,
      baseAttackDamage: 10,
      defense: 0,
      persistenceVersion: 1
    })),
    persistProfiles: vi.fn(async () => undefined)
  };
  let classSnapshot = replacementDruidSnapshot();
  const classes = {
    getOrCreate: vi.fn(async () => classSnapshot),
    loadRuntime: vi.fn(async () => ({
      activeClassId: "druid" as const,
      resourceId: "rage" as const,
      resourceCurrent: 100,
      resourceReserved: 0,
      rage: 0,
      rageReserved: 0,
      queuedAbilityId: null,
      queuedTargetEntityId: null,
      queuedAtTick: null,
      cooldownEndsAt: {},
      statusEffects: [],
      counters: {},
      combatGeneration: 0,
      lastCombatAt: null,
      savedAt: Date.now()
    })),
    persistRuntime: vi.fn(async () => undefined),
    activateClass: vi.fn(async (_playerId: string, classId: string) => {
      if (classId === "knight") classSnapshot = replacementKnightSnapshot();
      return { replayed: false, snapshot: classSnapshot };
    }),
    activateSubclass: vi.fn(async () => ({ replayed: false, snapshot: classSnapshot })),
    updateLoadout: vi.fn(async (
      _playerId: string,
      loadout: ClassSnapshot["loadout"]
    ) => {
      classSnapshot = { ...classSnapshot, loadout };
      return { replayed: false, snapshot: classSnapshot };
    })
  };
  const equipmentSnapshot = replacementDruidEquipment();
  let equipmentRuntimeConnected = false;
  const equipment = {
    ensureStarterLoadout: vi.fn(async () => ({
      applied: false,
      replayed: true,
      equipment: equipmentSnapshot
    })),
    getSnapshot: vi.fn(async () => equipmentSnapshot),
    runtimeSnapshot: vi.fn(() =>
      equipmentRuntimeConnected ? equipmentSnapshot : null
    ),
    connectRuntime: vi.fn(async () => {
      equipmentRuntimeConnected = true;
      return equipmentSnapshot;
    }),
    setRuntimeContext: vi.fn(() => equipmentSnapshot),
    pendingActivation: vi.fn(() => null),
    flushAndRelease: vi.fn(async () => {
      equipmentRuntimeConnected = false;
    })
  };
  const progression = {
    getOrCreate: vi.fn(async () => ({
      playerId: "player-1",
      totalXp: 0,
      level: 0,
      curveVersion: 1,
      persistenceVersion: 1,
      xpIntoLevel: 0,
      xpForNextLevel: 100,
      nextLevelTotalXp: 100,
      atCap: false,
      pveStats: {
        maxHealth: 100,
        attackPower: 10,
        defense: 0,
        attackIntervalMs: 2_000,
        attackRangeM: 75
      }
    }))
  };
  const partyAuthority = new InMemoryPartyAuthority();
  partyAuthority.createParty("party:inviter", "leader-1", "create-inviter-party");
  partyAuthority.inviteMember("player-1", "leader-1", "invite-player-1");
  const runtime = new WorldRuntime(config, registry, gameState, combat, logger);

  await app.register(cookie);
  installAuthGuard(app, config, authService);
  await registerRealtime({
      infrastructure: {
          app: app,
          registry: registry,
          logger: logger,
          config: config
      },
      authority: {
          gameState: gameState,
          flagService: { listFlags: vi.fn(async () => []) } as unknown as FlagService,
          playerService: playerService,
          auth: authService,
          worldRuntime: runtime
      },
      capabilities: {
          ...worldBootstrapLocationFixtures(),
          combat: combat,
          combatProfiles: combatProfiles as unknown as CombatProfileService,
          progression: progression as unknown as ProgressionService,
          equipment: equipment as unknown as EquipmentService,
          classes: classes as unknown as ClassService,
          partyAuthority: partyAuthority
      }
  });
  await app.ready();
  const headers = {
    origin: config.CLIENT_ORIGIN,
    cookie: "aa_session_dev=test-session"
  };
  const socket = await app.injectWS("/ws", { headers });
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  return {
    app,
    socket,
    headers,
    messages,
    registry,
    combat,
    combatProfiles,
    classes,
    equipment
  };
}

function replacementDruidSnapshot(): ClassSnapshot {
  const progress = (classId: "warrior" | "hunter" | "knight" | "druid", level: number) => ({
    classId,
    level,
    xp: level === 25 ? 38_000 : 0,
    nextLevelXp: level === 25 ? null : 100,
    completedAt: null
  });
  const classes = [
    progress("warrior", 0),
    progress("hunter", 0),
    progress("knight", 0),
    progress("druid", 25)
  ];
  const subclassIds = ["reaver", "warden", "sharpshooter", "stalker"] as const;
  return {
    playerId: "player-1",
    characterLevel: 0,
    activeClassId: "druid",
    activeSubclassId: null,
    warrior: classes[0]!,
    hunter: classes[1]!,
    knight: classes[2]!,
    druid: classes[3]!,
    classes,
    subclasses: subclassIds.map((subclassId) => ({
      classId: subclassId === "reaver" || subclassId === "warden" ? "warrior" : "hunter",
      subclassId,
      unlocked: false
    })),
    selectedSubclasses: { warrior: null, hunter: null },
    loadout: {
      resetActives: [null, null],
      normalActives: ["druid_rejuvenation", null],
      passiveTiers: [null, null, null], ultimateActive: null
    },
    resource: {
      classId: "druid",
      resourceId: "rage",
      displayName: "Rage",
      current: 100,
      maximum: 100,
      reserved: 0,
      updatedAt: new Date(0).toISOString()
    },
    resources: [],
    weaponMode: "ranged",
    legacyIds: [],
    rage: 0,
    maximumRage: 100,
    queuedAbility: null,
    cooldownEndsAt: {},
    serverTime: Date.now(),
    revision: 1
  };
}

function replacementKnightSnapshot(): ClassSnapshot {
  const base = replacementDruidSnapshot();
  const knight = {
    classId: "knight" as const,
    level: 25,
    xp: 38_000,
    nextLevelXp: null,
    completedAt: null
  };
  return {
    ...base,
    activeClassId: "knight",
    activeSubclassId: null,
    knight,
    classes: base.classes!.map((entry) => entry.classId === "knight" ? knight : entry),
    loadout: {
      resetActives: [null, null],
      normalActives: [null, null],
      passiveTiers: [null, null, null], ultimateActive: null
    },
    resource: {
      classId: "knight",
      resourceId: "rage",
      displayName: "Rage",
      current: 0,
      maximum: 100,
      reserved: 0,
      updatedAt: new Date(0).toISOString()
    },
    weaponMode: "melee"
  };
}

function replacementDruidEquipment(): EquipmentSnapshotV2 {
  const now = new Date(0).toISOString();
  const instance = (
    definitionId: "starter_staff" | "padded_tunic",
    instanceId: string
  ): EquipmentInstanceV2 => {
    const definition = requireEquipmentDefinition(definitionId);
    const derived = resolveEquipmentItemDerivedStats({
      item: { instanceId, definition, itemLevel: 0 },
      slot: definition.slot,
      classId: "druid"
    });
    return {
      instanceId,
      definitionId,
      displayName: definition.displayName,
      ownerPlayerId: "player-1",
      location: "equipped",
      equippedSlot: definition.slot,
      itemLevel: 0,
      maximumItemLevel: MAX_EQUIPMENT_LEVEL,
      category: definition.category,
      balanceVersion: EQUIPMENT_BALANCE_VERSION,
      enchantmentIdentity: null,
      attackPowerBonus: definition.attackPowerBonus,
      defenseBonus: definitionId === "padded_tunic" ? 10 : 0,
      weaponCategory: definition.weaponCategory,
      armorCategory: definition.armorCategory,
      twoHanded: definition.twoHanded,
      savedKitIndices: [],
      derived,
      nextUpgradeLevel: 1,
      nextUpgradeCost: String(equipmentUpgradeCost(0)),
      upgradeDisabledReason: null,
      createdAt: now,
      updatedAt: now
    };
  };
  const weapon = instance(
    "starter_staff",
    "00000000-0000-4000-8000-000000000001"
  );
  const chest = instance(
    "padded_tunic",
    "00000000-0000-4000-8000-000000000002"
  );
  const active = emptyEquipmentSlots<EquipmentInstanceV2 | null>(null);
  active.chest = chest;
  active.melee = weapon;
  const derivedStats = resolveEquipmentCombatStats({
    context: "pve",
    characterLevel: 0,
    classId: "druid",
    classRank: 25,
    loadout: {
      active: {
        ...emptyEquipmentSlots(null),
        chest: {
          instanceId: chest.instanceId,
          definition: requireEquipmentDefinition(chest.definitionId),
          itemLevel: chest.itemLevel
        },
        melee: {
          instanceId: weapon.instanceId,
          definition: requireEquipmentDefinition(weapon.definitionId),
          itemLevel: weapon.itemLevel
        }
      },
      readiedWeaponSlot: "melee"
    }
  });
  const emptyKitItems = emptyEquipmentSlots<EquipmentInstanceV2 | null>(null);
  return {
    snapshotVersion: 2,
    balanceVersion: EQUIPMENT_BALANCE_VERSION,
    playerId: "player-1",
    characterLevel: 25,
    repairMessage: null,
    instances: [weapon, chest],
    active,
    readiedWeaponSlot: "melee",
    activeKitIndex: null,
    kits: ([1, 2, 3, 4, 5, 6] as const).map((kitIndex) => ({
      kitIndex,
      name: `Kit ${kitIndex}`,
      readiedWeaponSlot: "melee",
      items: { ...emptyKitItems },
      valid: false,
      invalidReason: "incomplete",
      revision: 0
    })),
    inventoryRevision: 1,
    activeRevision: 1,
    checkpointRevision: 1,
    derivedStats: {
      ...derivedStats,
      pveDefense: 10
    },
    weapon,
    chest,
    totalAttackPowerBonus: 2,
    totalDefenseBonus: 10
  };
}

function visitFlag(requestId: string): string {
  return JSON.stringify({
    type: "VISIT_FLAG",
    requestId,
    flagId: testFlag().id,
    source: "visible_map"
  } satisfies ClientMessage);
}

function testFlag(): FlagSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    controlType: "personal",
    ownerId: "player-1",
    ownerUsername: "Ash",
    ownerColor: "#38bdf8",
    name: "Mesa Camp",
    lat: 35.09,
    lon: -106.66,
    packageId: null,
    elevationM: null,
    terrainClass: null,
    biome: null,
    ecoregion: null,
    cityId: null,
    claimRadiusM: 700,
    createdAt: "2026-07-11T00:00:00.000Z"
  };
}

function errorCodes(messages: ServerMessage[]): string[] {
  return messages.flatMap((message) => message.type === "ERROR" ? [message.code] : []);
}

function hello(): string {
  return JSON.stringify({
    type: "HELLO"
  } satisfies ClientMessage);
}

function helloErrors(messages: ServerMessage[]): Array<Extract<ServerMessage, { type: "ERROR" }>> {
  return messages.filter(
    (message): message is Extract<ServerMessage, { type: "ERROR" }> =>
      message.type === "ERROR" && message.code === "HELLO_ALREADY_RECEIVED"
  );
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
    updatedAt: new Date("2026-07-09T00:00:00.000Z")
  };
}

function flagSnapshot(id: string, lat = 35.0844): FlagSnapshot {
  return {
    id,
    controlType: "personal",
    ownerId: "player-1",
    name: "Ordered Flag",
    lat,
    lon: -106.6504,
    packageId: null,
    elevationM: null,
    terrainClass: null,
    biome: null,
    ecoregion: null,
    claimRadiusM: 350,
    cityId: null,
    createdAt: "2026-07-09T00:00:00.000Z"
  };
}

function citySnapshot(id: string): CitySnapshot {
  return {
    id,
    worldId: "main",
    worldSettlementId: "settlement-1",
    worldSettlementSource: "test",
    worldSourceSettlementId: "source-1",
    settlementClass: null,
    settlementReleaseId: null,
    settlementReleaseFingerprint: null,
    name: "Ordered City",
    countryCode: "US",
    regionCode: "NM",
    founderPlayerId: "player-1",
    mayorPlayerId: "player-1",
    mayorConfirmed: true,
    founderMayorClaimDeadline: null,
    seatFlagId: "00000000-0000-4000-8000-000000000001",
    lat: 35.085,
    lon: -106.6504,
    active: true,
    jumpable: true,
    constructionPhase: "complete",
    constructionCompletedAt: "2026-01-01T00:00:00.000Z",
    constructionContributions: [],
    spatialRevision: "1",
    foundingAnnexRadiusM: 1_000,
    createdAt: "2026-07-09T00:00:00.000Z"
  };
}

function developerAuthMethods(
  capabilities: DeveloperCapability[] = []
) {
  return {
    requireGameplayReady: vi.fn(),
    developerCapabilities: vi.fn(() => [...capabilities]),
    hasDeveloperCapability: vi.fn((
      _session: Parameters<AuthService["hasDeveloperCapability"]>[0],
      capability: DeveloperCapability
    ) => capabilities.includes(capability)),
    authorizeDeveloperCommand: vi.fn(async (
      _session: Parameters<AuthService["authorizeDeveloperCommand"]>[0],
      input: Parameters<AuthService["authorizeDeveloperCommand"]>[1]
    ) => {
      if (!capabilities.includes(input.capability)) {
        throw new Error("developer command forbidden");
      }
    }),
    recordDeveloperCommandResult: vi.fn(async () => undefined)
  };
}

function productionEconomyConfig() {
  return loadConfig({
    NODE_ENV: "production",
    AUTH_RUNTIME_MODE: "public",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "test-client-id",
    APP_PUBLIC_ORIGIN: "https://game.example",
    AUTH_ALLOWED_ORIGINS: "https://game.example",
    AUTH_TRUST_PROXY: "127.0.0.1,::1",
    AUTH_SESSION_TOKEN_HMAC_KEY: "session-key-aaaaaaaaaaaaaaaaaaaaaaaa",
    AUTH_DEVICE_TOKEN_HMAC_KEY: "device-key-bbbbbbbbbbbbbbbbbbbbbbbbb",
    AUTH_NETWORK_HMAC_KEY: "network-key-ccccccccccccccccccccccccc",
    INITIAL_SPAWN_HMAC_KEY: "spawn-key-dddddddddddddddddddddddddd",
    DOG_GENETICS_HMAC_KEY: "dog-key-eeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: "test-access-admin-subject",
    ALLOW_UNRESOLVED_FLAGS_IN_DEV: "false",
    DEV_TOOLS_ENABLED: "true",
    DEV_ADMIN_TOOLS_ENABLED: "true",
    DEV_PRODUCTION_ECONOMY_MUTATION_ENABLED: "true",
    DEV_AUTHORIZED_GOOGLE_SUBJECTS: "owner-google-subject",
    RUNTIME_SHA: "f".repeat(40)
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
