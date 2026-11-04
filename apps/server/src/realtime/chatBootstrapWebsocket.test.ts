import {
  CHAT_CHANNEL_KEYS,
  CHAT_LOCAL_CHANNEL_KEY,
  type ChatChannel,
  type ClientMessage,
  type ServerMessage
} from "@ash-atlas/shared";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import { loadConfig } from "../config.js";
import type { ChatRealtimeCoordinator } from "../chat/chatRealtime.js";
import type { CityService } from "../game/cities.js";
import { CombatEngine } from "../game/combat/combatEngine.js";
import type { CombatProfileService } from "../game/combat/combatProfiles.js";
import type { DroppedItemService } from "../game/droppedItems.js";
import type { FlagService } from "../game/flags.js";
import type { KingdomService } from "../game/kingdoms.js";
import type { PetService } from "../game/petService.js";
import type { PlayerService } from "../game/players.js";
import { GameState, type PlayerRecord } from "../game/state.js";
import type { WorldMapService } from "../game/worldMap.js";
import { createLogger } from "../logger.js";
import { ConnectionRegistry } from "./connectionRegistry.js";
import { registerRealtime } from "./websocket.js";
import { worldBootstrapLocationFixtures } from "./worldBootstrapTestFixtures.js";

type Failure =
  | "cities"
  | "city-membership"
  | "world-map"
  | "kingdoms"
  | "pets"
  | "combat"
  | "flags";

describe("independent public chat websocket bootstrap", () => {
  it.each([
    "cities",
    "city-membership",
    "world-map",
    "kingdoms",
    "pets",
    "combat",
    "flags"
  ] as const)("still delivers all channels when %s bootstrap throws", async (failure) => {
    const harness = await createHarness(failure);
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.messages.some(({ type }) => type === "WELCOME"), JSON.stringify(harness.messages)).toBe(true);
        expect(harness.messages.some(({ type }) => type === "CHAT_CHANNELS_SNAPSHOT")).toBe(true);
        expect(harness.messages.some(({ type }) => type === "DROPPED_ITEMS_SNAPSHOT")).toBe(true);
      });

      const snapshot = harness.messages.find(
        (message): message is Extract<ServerMessage, { type: "CHAT_CHANNELS_SNAPSHOT" }> =>
          message.type === "CHAT_CHANNELS_SNAPSHOT"
      );
      expect(snapshot?.channels.map(({ key, displayName }) => [key, displayName])).toEqual([
        ["public:general", "General"],
        ["public:trading", "Trading"],
        ["public:hunting", "Hunting"],
        ["local:map", "Local"]
      ]);
      expect(harness.messages.some(
        (message) => message.type === "ERROR" && message.code === "WEBSOCKET_ERROR"
      )).toBe(false);
    } finally {
      harness.socket.terminate();
      await harness.app.close();
    }
  });

  it("reports chat unavailable, continues gameplay, and coalesces idempotent retries", async () => {
    const retryGate = deferred<void>();
    const harness = await createHarness(undefined, retryGate);
    try {
      harness.socket.send(hello());
      await vi.waitFor(() => {
        expect(harness.messages.some(({ type }) => type === "WELCOME")).toBe(true);
        expect(harness.messages.some(({ type }) => type === "CHAT_UNAVAILABLE")).toBe(true);
        expect(harness.messages.some(({ type }) => type === "DROPPED_ITEMS_SNAPSHOT")).toBe(true);
      });

      harness.socket.send(JSON.stringify({ type: "REQUEST_CHAT_BOOTSTRAP" } satisfies ClientMessage));
      harness.socket.send(JSON.stringify({ type: "REQUEST_CHAT_BOOTSTRAP" } satisfies ClientMessage));
      await vi.waitFor(() => expect(harness.chatConnect).toHaveBeenCalledTimes(2));
      retryGate.resolve();
      await vi.waitFor(() => {
        expect(harness.messages.filter(({ type }) => type === "CHAT_CHANNELS_SNAPSHOT"))
          .toHaveLength(1);
      });

      harness.socket.send(JSON.stringify({ type: "REQUEST_CHAT_BOOTSTRAP" } satisfies ClientMessage));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(harness.chatConnect).toHaveBeenCalledTimes(2);
      expect(harness.messages.filter(({ type }) => type === "CHAT_CHANNELS_SNAPSHOT"))
        .toHaveLength(1);
      expect(harness.messages.filter(({ type }) => type === "CHAT_UNAVAILABLE"))
        .toHaveLength(1);
    } finally {
      retryGate.resolve();
      harness.socket.terminate();
      await harness.app.close();
    }
  });
});

async function createHarness(failure?: Failure, retryGate?: Deferred<void>) {
  const app = Fastify();
  const config = loadConfig({ NODE_ENV: "test", RUNTIME_SHA: "a".repeat(40) });
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
    recordConnectionEvent: vi.fn(async () => undefined),
    requireGameplayReady: vi.fn(),
    developerCapabilities: vi.fn(() => []),
    hasDeveloperCapability: vi.fn(() => false),
    authorizeDeveloperCommand: vi.fn(async () => {
      throw new Error("developer command forbidden");
    }),
    recordDeveloperCommandResult: vi.fn(async () => undefined)
  } as unknown as AuthService;

  const flagService = {
    listFlags: vi.fn(async () => {
      if (failure === "flags") throw new Error("flag bootstrap failed");
      return [];
    })
  } as unknown as FlagService;
  const cities = failure === "cities" || failure === "city-membership"
    ? {
        districtBenefits: { refreshRuntime: vi.fn(async () => undefined) },
        listCitiesNear: vi.fn(async () => {
          if (failure === "cities") throw new Error("city listing failed");
          return [];
        }),
        getMembership: vi.fn(async () => {
          if (failure === "city-membership") throw new Error("city membership failed");
          return null;
        })
      } as unknown as CityService
    : undefined;
  const worldMap = failure === "world-map"
    ? {
        discoverAtAuthoritativePosition: vi.fn(async () => undefined),
        snapshot: vi.fn(async () => {
          throw new Error("world map failed");
        })
      } as unknown as WorldMapService
    : undefined;
  const kingdoms = failure === "kingdoms"
    ? {
        statModifiers: vi.fn(async () => null),
        getState: vi.fn(async () => {
          throw new Error("kingdom state failed");
        })
      } as unknown as KingdomService
    : undefined;
  const pets = failure === "pets"
    ? {
        state: vi.fn(async () => {
          throw new Error("pet state failed");
        })
      } as unknown as PetService
    : undefined;
  const combat = new CombatEngine({ tickRateHz: 20 });
  if (failure === "combat") {
    vi.spyOn(combat, "snapshotForPlayer").mockImplementation(() => {
      throw new Error("combat snapshot failed");
    });
  }
  const combatProfiles = combat
    ? {
        getOrCreate: vi.fn(async () => ({
          playerId: "player-1",
          maxHealth: 100,
          currentHealth: 100,
          baseAttackDamage: 10
        })),
        persistProfiles: vi.fn(async () => undefined)
      } as unknown as CombatProfileService
    : undefined;
  const droppedItems = {
    listActive: vi.fn(async () => []),
    listActiveInGameplayCircle: vi.fn(async () => [])
  } as unknown as DroppedItemService;

  let connectAttempt = 0;
  const chatConnect = vi.fn(async (connectionId: string) => {
    connectAttempt += 1;
    if (retryGate && connectAttempt === 1) {
      throw new Error("chat catalog unavailable");
    }
    if (retryGate) await retryGate.promise;
    registry.sendToConnection(connectionId, chatSnapshot());
  });
  const chats = {
    connect: chatConnect,
    disconnect: vi.fn()
  } as unknown as ChatRealtimeCoordinator;

  await app.register(cookie);
  installAuthGuard(app, config, authService);
  await registerRealtime({
      infrastructure: {
          app: app,
          registry: registry,
          logger: logger,
          config: config,
      },
      authority: {
          gameState: gameState,
          flagService: flagService,
          playerService: playerService,
          auth: authService,
      },
      capabilities: {
          ...worldBootstrapLocationFixtures(),
          droppedItems: droppedItems,
          combat: combat,
          combatProfiles: combatProfiles,
          cities: cities,
          chats: chats,
          kingdoms: kingdoms,
          worldMap: worldMap,
          pets: pets
      },
      operations: {}
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
  return { app, socket, messages, chatConnect };
}

function hello(): string {
  return JSON.stringify({ type: "HELLO" } satisfies ClientMessage);
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

function chatSnapshot(): Extract<ServerMessage, { type: "CHAT_CHANNELS_SNAPSHOT" }> {
  return {
    type: "CHAT_CHANNELS_SNAPSHOT",
    channels: CHAT_CHANNEL_KEYS.map((key, index) => channel(key, index)),
    readStates: [],
    previews: [],
    selectedChannelKey: "public:general",
    pinnedChannelCategories: ["general", "trading", "hunting", "local"],
    onlinePlayerCount: {
      count: 1,
      revision: 1,
      observedAt: "2026-07-21T00:00:00.000Z",
      players: [{ playerId: "player-1", displayName: "Player One" }]
    }
  };
}

function channel(key: string, index: number): ChatChannel {
  const local = key === CHAT_LOCAL_CHANNEL_KEY;
  return {
    id: `05000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    key,
    type: local ? "local" : "public",
    category: local
      ? "local"
      : key.split(":").at(-1) as "general" | "trading" | "hunting",
    displayName: ["General", "Trading", "Hunting", "Local"][index]!,
    visibilityPolicy: "authenticated",
    sendAccessPolicy: "authenticated",
    historyRetentionPolicy: local ? "live-session" : "durable",
    rateLimitPolicy: key === "public:trading" ? "strict-repeat" : "normal",
    moderationPolicy: "public-v1",
    active: true,
    latestSequence: 0,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z"
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value?: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: (value?: T) => resolve(value as T) };
}
