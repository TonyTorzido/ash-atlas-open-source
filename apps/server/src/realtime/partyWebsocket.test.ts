import type { ClientMessage, ServerMessage } from "@ash-atlas/shared";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import { loadConfig } from "../config.js";
import { CombatEngine } from "../game/combat/combatEngine.js";
import { worldBootstrapLocationFixtures } from "./worldBootstrapTestFixtures.js";
import type { FlagService } from "../game/flags.js";
import {
  InMemoryPartyAuthority,
  type MutablePartyAuthority
} from "../game/party/PartyAuthority.js";
import type { PlayerService } from "../game/players.js";
import type { RecentPlayersService } from "../game/recentPlayers.js";
import { GameState, type PlayerRecord } from "../game/state.js";
import { createLogger } from "../logger.js";
import { ConnectionRegistry } from "./connectionRegistry.js";
import { registerRealtime } from "./websocket.js";

describe("authenticated party WebSocket commands", () => {
  it("requires target consent, enforces leader authority, and broadcasts membership and invites", async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const app = Fastify();
    const logger = createLogger("test");
    const registry = new ConnectionRegistry();
    const gameState = new GameState(config, logger);
    const authority = new InMemoryPartyAuthority();
    const recentPlayers = { recordPartyJoin: vi.fn() };
    const playerService = {
      loadPlayer: vi.fn(async (playerId: string) => playerRecord(playerId)),
      markOnline: vi.fn(async () => undefined),
      persistPlayerSnapshot: vi.fn(async () => undefined),
      markOffline: vi.fn(async () => undefined)
    } as unknown as PlayerService;
    const flagService = { listFlags: vi.fn(async () => []) } as unknown as FlagService;
    const authService = partyAuthService();

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
            combat: new CombatEngine({ tickRateHz: config.SERVER_TICK_HZ }),
            partyAuthority: authority,
            recentPlayers: recentPlayers as unknown as RecentPlayersService
        },
        operations: {}
    });
    await app.ready();

    const clients = await Promise.all(["player-a", "player-b", "player-c"].map(async (playerId) => {
      const socket = await app.injectWS("/ws", {
        headers: {
          origin: config.CLIENT_ORIGIN,
          cookie: `aa_session_dev=token-${playerId}`
        }
      });
      const messages: ServerMessage[] = [];
      socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
      socket.send(JSON.stringify({ type: "HELLO" } satisfies ClientMessage));
      await vi.waitFor(() => expect(messages.some((message) => message.type === "WELCOME")).toBe(true));
      expect(lastPartySnapshot(messages)?.party).toBeNull();
      expect(lastPartySnapshot(messages)?.invites).toEqual([]);
      expect(lastPartySnapshot(messages)?.outgoingInvites).toEqual([]);
      return { playerId, socket, messages };
    }));
    const [leader, member, third] = clients as [
      (typeof clients)[number],
      (typeof clients)[number],
      (typeof clients)[number]
    ];

    try {
      leader.socket.send(partyCommand({ type: "CREATE_PARTY", requestId: "create" }));
      await waitForPartyResponse(leader.messages, "create", 1);
      expect(partyResponse(leader.messages, "create")?.party).toMatchObject({
        leaderPlayerId: "player-a",
        memberPlayerIds: ["player-a"],
        revision: 1
      });

      leader.socket.send(partyCommand({ type: "CREATE_PARTY", requestId: "create" }));
      await waitForError(leader.messages, "create", "PARTY_REQUEST_DUPLICATE");
      expect(authority.partyForPlayer("player-a")?.revision).toBe(1);

      leader.socket.send(partyCommand({
        type: "ADD_PARTY_MEMBER",
        requestId: "add-b",
        targetPlayerId: "player-b"
      }));
      await waitForPartyResponse(leader.messages, "add-b", 1);
      expect(partyResponse(leader.messages, "add-b")?.outgoingInvites).toMatchObject([{
        targetPlayerId: "player-b"
      }]);
      await vi.waitFor(() => expect(lastPartySnapshot(member.messages)?.invites).toHaveLength(1));
      expect(lastPartySnapshot(member.messages)).toMatchObject({
        party: null,
        invites: [{
          leaderPlayerId: "player-a",
          inviterPlayerId: "player-a"
        }]
      });
      expect(authority.partyForPlayer("player-b")).toBeNull();

      member.socket.send(partyCommand({
        type: "ACCEPT_PARTY_INVITE",
        requestId: "accept-b",
        partyId: lastPartySnapshot(member.messages)!.invites[0]!.partyId
      }));
      await waitForPartyResponse(member.messages, "accept-b", 2);
      await vi.waitFor(() => expect(lastPartySnapshot(leader.messages)?.party?.revision).toBe(2));
      expect(lastPartySnapshot(leader.messages)?.outgoingInvites).toEqual([]);
      expect(partyResponse(member.messages, "accept-b")).toMatchObject({
        party: { memberPlayerIds: ["player-a", "player-b"] },
        invites: []
      });
      expect(recentPlayers.recordPartyJoin).toHaveBeenCalledWith("player-b", ["player-a"]);

      member.socket.send(partyCommand({
        type: "SET_PARTY_TRAVEL_ALLOWED",
        requestId: "member-forged-travel-setting",
        allowed: true
      }));
      await waitForError(member.messages, "member-forged-travel-setting", "PARTY_NOT_LEADER");
      member.socket.send(partyCommand({
        type: "TRAVEL_TO_PARTY_LEADER",
        requestId: "travel-disabled"
      }));
      await waitForError(member.messages, "travel-disabled", "PARTY_UNAVAILABLE");

      leader.socket.send(partyCommand({
        type: "ADD_PARTY_MEMBER",
        requestId: "add-b",
        targetPlayerId: "player-c"
      }));
      await waitForError(leader.messages, "add-b", "PARTY_OPERATION_CONFLICT");

      member.socket.send(partyCommand({
        type: "ADD_PARTY_MEMBER",
        requestId: "non-leader-add",
        targetPlayerId: "player-c"
      }));
      await waitForError(member.messages, "non-leader-add", "PARTY_NOT_LEADER");
      expect(authority.partyForPlayer("player-c")).toBeNull();

      leader.socket.send(partyCommand({
        type: "ADD_PARTY_MEMBER",
        requestId: "add-c",
        targetPlayerId: "player-c"
      }));
      await waitForPartyResponse(leader.messages, "add-c", 2);
      expect(partyResponse(leader.messages, "add-c")?.outgoingInvites).toMatchObject([{
        targetPlayerId: "player-c"
      }]);
      await vi.waitFor(() => expect(lastPartySnapshot(third.messages)?.invites).toHaveLength(1));
      expect(authority.partyForPlayer("player-c")).toBeNull();

      const partyId = lastPartySnapshot(third.messages)!.invites[0]!.partyId;
      third.socket.send(partyCommand({
        type: "DECLINE_PARTY_INVITE",
        requestId: "decline-c",
        partyId
      }));
      await vi.waitFor(() => expect(partyResponse(third.messages, "decline-c")).toMatchObject({
        party: null,
        invites: []
      }));
      await vi.waitFor(() => expect(lastPartySnapshot(leader.messages)?.outgoingInvites).toEqual([]));
      expect(authority.partyForPlayer("player-c")).toBeNull();

      leader.socket.send(partyCommand({
        type: "ADD_PARTY_MEMBER",
        requestId: "add-c-again",
        targetPlayerId: "player-c"
      }));
      await waitForPartyResponse(leader.messages, "add-c-again", 2);
      third.socket.send(partyCommand({
        type: "ACCEPT_PARTY_INVITE",
        requestId: "accept-c",
        partyId
      }));
      await waitForPartyResponse(third.messages, "accept-c", 3);
      expect(recentPlayers.recordPartyJoin).toHaveBeenCalledWith(
        "player-c",
        ["player-a", "player-b"]
      );

      leader.socket.send(partyCommand({
        type: "CHANGE_PARTY_LEADER",
        requestId: "leader-b",
        targetPlayerId: "player-b"
      }));
      await waitForPartyResponse(leader.messages, "leader-b", 4);
      expect(partyResponse(leader.messages, "leader-b")?.party?.leaderPlayerId).toBe("player-b");

      leader.socket.send(partyCommand({
        type: "CHANGE_PARTY_LEADER",
        requestId: "leader-b",
        targetPlayerId: "player-b"
      }));
      await waitForError(leader.messages, "leader-b", "PARTY_REQUEST_DUPLICATE");

      member.socket.send(partyCommand({
        type: "REMOVE_PARTY_MEMBER",
        requestId: "remove-a",
        targetPlayerId: "player-a"
      }));
      await waitForPartyResponse(member.messages, "remove-a", 5);
      await vi.waitFor(() => expect(lastPartySnapshot(leader.messages)?.party).toBeNull());
      expect(partyResponse(member.messages, "remove-a")?.party?.memberPlayerIds)
        .toEqual(["player-b", "player-c"]);

      third.socket.send(partyCommand({ type: "LEAVE_PARTY", requestId: "leave-c" }));
      await vi.waitFor(() => expect(partyResponse(third.messages, "leave-c")?.party).toBeNull());
      await vi.waitFor(() => expect(lastPartySnapshot(member.messages)?.party?.revision).toBe(6));
      expect(authority.partyForPlayer("player-b")?.memberPlayerIds).toEqual(["player-b"]);
    } finally {
      for (const client of clients) client.socket.terminate();
      await app.close();
    }
  });

  it("invites an offline, non-visible target without AOI, flag, city, kingdom, or population scope", async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const app = Fastify();
    const logger = createLogger("test");
    const registry = new ConnectionRegistry();
    const authority = new InMemoryPartyAuthority();
    const playerService = {
      loadPlayer: vi.fn(async (playerId: string) => playerRecord(playerId)),
      markOnline: vi.fn(async () => undefined),
      persistPlayerSnapshot: vi.fn(async () => undefined),
      markOffline: vi.fn(async () => undefined)
    } as unknown as PlayerService;
    const authService = partyAuthService();

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
            gameState: new GameState(config, logger),
            flagService: { listFlags: vi.fn(async () => []) } as unknown as FlagService,
            playerService: playerService,
            auth: authService,
        },
        capabilities: {
            ...worldBootstrapLocationFixtures(),
            combat: new CombatEngine({ tickRateHz: config.SERVER_TICK_HZ }),
            partyAuthority: authority
        }
    });
    await app.ready();
    const socket = await app.injectWS("/ws", {
      headers: { origin: config.CLIENT_ORIGIN, cookie: "aa_session_dev=token-player-a" }
    });
    const messages: ServerMessage[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));

    try {
      socket.send(JSON.stringify({ type: "HELLO" } satisfies ClientMessage));
      await vi.waitFor(() => expect(messages.some((message) => message.type === "WELCOME")).toBe(true));
      socket.send(partyCommand({ type: "CREATE_PARTY", requestId: "create" }));
      await waitForPartyResponse(messages, "create", 1);
      socket.send(partyCommand({
        type: "ADD_PARTY_MEMBER",
        requestId: "offline",
        targetPlayerId: "player-offline"
      }));
      await waitForPartyResponse(messages, "offline", 1);
      expect(authority.partyForPlayer("player-offline")).toBeNull();
      expect(authority.invitesForPlayer("player-offline")).toMatchObject([{
        leaderPlayerId: "player-a",
        inviterPlayerId: "player-a"
      }]);
    } finally {
      socket.terminate();
      await app.close();
    }
  });

  it("waits for an in-flight party mutation before replacing socket authority", async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const app = Fastify();
    const logger = createLogger("test");
    const registry = new ConnectionRegistry();
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots([{
      partyId: "party:inviter",
      leaderPlayerId: "leader",
      memberPlayerIds: ["leader"],
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 1
    }]);
    authority.loadInvites([{
      partyId: "party:inviter",
      leaderPlayerId: "leader",
      inviterPlayerId: "leader",
      targetPlayerId: "player-a",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }]);
    const mutationStarted = createDeferred<void>();
    const releaseMutation = createDeferred<void>();
    const originalAcceptInvite = authority.acceptInvite.bind(authority);
    (authority as MutablePartyAuthority).acceptInvite = async (partyId, playerId, requestId) => {
      mutationStarted.resolve();
      await releaseMutation.promise;
      return originalAcceptInvite(partyId, playerId, requestId);
    };
    const markOnline = vi.fn(async () => undefined);
    const playerService = {
      loadPlayer: vi.fn(async (playerId: string) => playerRecord(playerId)),
      markOnline,
      persistPlayerSnapshot: vi.fn(async () => undefined),
      markOffline: vi.fn(async () => undefined)
    } as unknown as PlayerService;
    const authService = partyAuthService();

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
            gameState: new GameState(config, logger),
            flagService: { listFlags: vi.fn(async () => []) } as unknown as FlagService,
            playerService: playerService,
            auth: authService,
        },
        capabilities: {
            ...worldBootstrapLocationFixtures(),
            combat: new CombatEngine({ tickRateHz: config.SERVER_TICK_HZ }),
            partyAuthority: authority
        }
    });
    await app.ready();
    const headers = { origin: config.CLIENT_ORIGIN, cookie: "aa_session_dev=token-player-a" };
    const first = await app.injectWS("/ws", { headers });
    const firstMessages: ServerMessage[] = [];
    first.on("message", (data) => firstMessages.push(JSON.parse(data.toString()) as ServerMessage));
    let replacement: Awaited<ReturnType<typeof app.injectWS>> | null = null;

    try {
      first.send(JSON.stringify({ type: "HELLO" } satisfies ClientMessage));
      await vi.waitFor(() => expect(firstMessages.some((message) => message.type === "WELCOME")).toBe(true));
      first.send(partyCommand({
        type: "ACCEPT_PARTY_INVITE",
        requestId: "accept-during-replacement",
        partyId: "party:inviter"
      }));
      await mutationStarted.promise;

      const replacementMessages: ServerMessage[] = [];
      replacement = await app.injectWS("/ws", { headers });
      replacement.on("message", (data) => {
        replacementMessages.push(JSON.parse(data.toString()) as ServerMessage);
      });
      replacement.send(JSON.stringify({ type: "HELLO" } satisfies ClientMessage));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(markOnline).toHaveBeenCalledOnce();
      expect(replacementMessages.some((message) => message.type === "WELCOME")).toBe(false);

      releaseMutation.resolve();
      await vi.waitFor(() => {
        expect(markOnline).toHaveBeenCalledTimes(2);
        expect(replacementMessages.some((message) => message.type === "WELCOME")).toBe(true);
        expect(lastPartySnapshot(replacementMessages)?.party?.memberPlayerIds)
          .toEqual(["leader", "player-a"]);
      });
      expect(registry.connectionCountForPlayer("player-a")).toBe(1);
    } finally {
      releaseMutation.resolve();
      replacement?.terminate();
      first.terminate();
      await app.close();
    }
  });
});

function partyAuthService(): AuthService {
  return {
    sessionCookieName: "aa_session_dev",
    assertOrigin: vi.fn(),
    authenticateSession: vi.fn(async (token: string | null) => {
      const playerId = token?.replace(/^token-/, "");
      if (!playerId) return null;
      return {
        sessionId: `session-${playerId}`,
        account: {
          id: `account-${playerId}`,
          status: "active",
          trustTier: "new",
          riskScore: 0,
          createdAt: new Date(),
          lastLoginAt: null
        },
        player: { id: playerId, accountId: `account-${playerId}`, displayName: playerId },
        deviceInstallationId: `device-${playerId}`,
        csrfToken: "csrf"
      };
    }),
    requireGameplayReady: vi.fn(),
    developerCapabilities: vi.fn(() => []),
    recordConnectionEvent: vi.fn(async () => undefined)
  } as unknown as AuthService;
}

function playerRecord(playerId: string): PlayerRecord {
  return {
    playerId,
    username: playerId,
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

function partyCommand(message: Extract<ClientMessage, {
  type:
    | "CREATE_PARTY"
    | "ADD_PARTY_MEMBER"
    | "REMOVE_PARTY_MEMBER"
    | "LEAVE_PARTY"
    | "CHANGE_PARTY_LEADER"
    | "ACCEPT_PARTY_INVITE"
    | "DECLINE_PARTY_INVITE"
    | "SET_PARTY_TRAVEL_ALLOWED"
    | "TRAVEL_TO_PARTY_LEADER";
}>): string {
  return JSON.stringify(message);
}

function partyResponse(messages: ServerMessage[], requestId: string) {
  return messages.find((message): message is Extract<ServerMessage, { type: "PARTY_SNAPSHOT" }> =>
    message.type === "PARTY_SNAPSHOT" && message.requestId === requestId
  );
}

function lastPartySnapshot(messages: ServerMessage[]) {
  return messages.filter((message): message is Extract<ServerMessage, { type: "PARTY_SNAPSHOT" }> =>
    message.type === "PARTY_SNAPSHOT"
  ).at(-1);
}

async function waitForPartyResponse(
  messages: ServerMessage[],
  requestId: string,
  revision: number
): Promise<void> {
  await vi.waitFor(() => expect(partyResponse(messages, requestId)?.party?.revision).toBe(revision));
}

async function waitForError(messages: ServerMessage[], requestId: string, code: string): Promise<void> {
  await vi.waitFor(() => expect(messages.some((message) =>
    message.type === "ERROR" && message.requestId === requestId && message.code === code
  )).toBe(true));
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
