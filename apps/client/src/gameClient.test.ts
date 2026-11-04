import { afterEach, describe, expect, it, vi } from "vitest";

import { gameplayLatencyTrace } from "./diagnostics/gameplayLatencyTrace.js";
import {
  GameClient,
  clientCommandAdmissionPolicy
} from "./gameClient.js";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  sendError: Error | null = null;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number }) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(value);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
  }

  emit(type: string, event: { data?: unknown; code?: number } = {}): void {
    if (type === "open") {
      this.readyState = FakeWebSocket.OPEN;
    } else if (type === "close") {
      this.readyState = 3;
      this.closed = true;
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  activeListenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.length, 0);
  }
}

describe("GameClient authenticated bootstrap", () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends HELLO without a client-selected player identity", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());

    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");

    const socketUrl = new URL(socket?.url ?? "");
    expect(`${socketUrl.protocol}//${socketUrl.host}${socketUrl.pathname}`).toBe("ws://server/ws");
    expect(Object.fromEntries(socketUrl.searchParams)).toEqual({
      aaProtocolId: "ash-atlas",
      aaProtocolMin: "3",
      aaProtocolMax: "3",
      aaProtocolCapabilities: "welcome-protocol-metadata,welcome-release-sha,welcome-version-metadata,client-suspend,scoped-flag-snapshots,viewport-flag-loading-v1,prepared-flag-arrival-v1,territory-collapse-v1",
      aaClientPlatform: "web",
      aaClientSha: expect.stringMatching(/^[0-9a-f]{40}$/u)
    });
    expect(socket?.sent.map((message) => JSON.parse(message))).toContainEqual({ type: "HELLO" });
  });

  it("tracks the server connection generation separately from the transport generation", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());

    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    expect(client.currentServerConnectionGeneration()).toBe(0);

    socket.emit("message", {
      data: JSON.stringify({
        ...serverWelcome(),
        connectionId: "connection-1",
        connectionGeneration: 17
      })
    });

    expect(client.currentServerConnectionGeneration()).toBe(17);
    expect(client.currentConnectionGeneration()).not.toBe(17);
  });

  it("submits an immediate severe-stall sample with a client-side cooldown", () => {
    vi.stubEnv("VITE_CLOSED_TEST_TELEMETRY_ENABLED", "true");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0"
    });
    vi.stubGlobal("window", {
      innerWidth: 1280,
      innerHeight: 720,
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 2),
      clearTimeout: vi.fn(),
      matchMedia: vi.fn(() => ({ matches: false }))
    });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    client.markAuthoritativeBootstrapComplete();
    socket.sent.length = 0;

    client.noteFrameForTelemetry(300);
    client.noteFrameForTelemetry(400);

    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({
        type: "TELEMETRY_BATCH",
        samples: [
          expect.objectContaining({ reason: "severe_frame_stall" })
        ]
      })
    ]);
  });

  it("queues a bounded startup terminal event until authoritative WELCOME", () => {
    vi.stubEnv("VITE_CLOSED_TEST_TELEMETRY_ENABLED", "true");
    vi.stubEnv("VITE_GAME_BUILD_SHA", "a".repeat(64));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 15; Mobile) Chrome/140.0.0.0"
    });
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      matchMedia: vi.fn(() => ({ matches: true }))
    });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");

    expect(client.recordStartupTerminal({
      outcome: "timeout",
      reason: "startup_timeout",
      elapsedStartupMs: 30_000,
      phase: "connected",
      attempt: 0,
      socketState: "open",
      welcomeReceived: true,
      progressionReceived: true,
      locationReceived: true,
      playerReceived: true,
      flagsReceived: true,
      mapReady: true,
      mapPainted: false,
      overlayReady: true,
      worldReady: true,
      presentationSnapshotReceived: false,
      hasCompletedBootstrap: false,
      connectionId: "connection-1",
      connectionGeneration: 1,
      relocationRevision: 2,
      resourceVisionRevision: 3,
      gameplayViewGeneration: 4,
      populationPreparationGeneration: 5
    })).toBe(true);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([{ type: "HELLO" }]);

    socket.emit("message", { data: JSON.stringify(serverWelcome()) });

    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "STARTUP_TERMINAL_TELEMETRY",
      outcome: "timeout",
      reason: "startup_timeout",
      elapsedStartupMs: 30_000,
      phase: "connected",
      attempt: 0,
      socketState: "open",
      welcomeReceived: true,
      progressionReceived: true,
      locationReceived: true,
      playerReceived: true,
      flagsReceived: true,
      mapReady: true,
      mapPainted: false,
      overlayReady: true,
      worldReady: true,
      presentationSnapshotReceived: false,
      hasCompletedBootstrap: false,
      connectionId: "connection-1",
      connectionGeneration: 1,
      relocationRevision: 2,
      resourceVisionRevision: 3,
      gameplayViewGeneration: 4,
      populationPreparationGeneration: 5,
      deviceCategory: "phone",
      operatingSystemFamily: "Android",
      browserFamily: "Chrome",
      browserMajorVersion: 140,
      installedPwa: true,
      clientReleaseIdentifier: "a".repeat(64)
    });
  });

  it("aggregates ordinary socket traffic while retaining safe relevant message types", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let flushTraffic: (() => void) | undefined;
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((callback: () => void) => {
        flushTraffic = callback;
        return 2;
      }),
      clearTimeout: vi.fn()
    });
    vi.spyOn(gameplayLatencyTrace, "isRecording").mockReturnValue(true);
    const record = vi.spyOn(gameplayLatencyTrace, "record").mockReturnValue(true);
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    record.mockClear();

    for (let index = 0; index < 25; index += 1) {
      socket.emit("message", {
        data: JSON.stringify({ type: "PONG", clientTime: index, serverTime: index })
      });
    }
    socket.emit("message", {
      data: JSON.stringify({
        type: "MOVE_ACCEPTED",
        requestId: "move-one",
        movementRevision: 1,
        target: { lat: 35.0844, lon: -106.6504 }
      })
    });

    expect(record.mock.calls.filter(([, name]) =>
      name === "websocket_relevant_message_received"
    )).toEqual([[
      "networking",
      "websocket_relevant_message_received",
      { wireType: "MOVE_ACCEPTED" }
    ]]);
    expect(record.mock.calls.some(([, name]) =>
      name === "websocket_message_received"
    )).toBe(false);
    flushTraffic?.();
    expect(record).toHaveBeenCalledWith(
      "networking",
      "websocket_traffic_summary",
      { messageCount: 25 }
    );
  });

  it("stops gameplay when a newer connection replaces the session", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const onSessionInvalid = vi.fn();
    const client = new GameClient("ws://server", handlers(onSessionInvalid));
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");

    socket?.emit("message", {
      data: JSON.stringify({ type: "SESSION_REPLACED", message: "new connection" })
    });

    expect(onSessionInvalid).toHaveBeenCalledWith("SESSION_REPLACED", "new connection");
    expect(socket?.closed).toBe(true);
  });

  it("treats the authoritative replacement close code as Session Moved when its message is lost", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const onSessionInvalid = vi.fn();
    const onClose = vi.fn();
    const client = new GameClient("ws://server", { ...handlers(onSessionInvalid), onClose });
    client.connect();

    FakeWebSocket.instances[0]?.emit("close", { code: 4002 });

    expect(onSessionInvalid).toHaveBeenCalledWith(
      "SESSION_REPLACED",
      "Ash Atlas was opened on another device."
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("continues transient reconnect scheduling beyond three attempts", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const reconnects: Array<() => void> = [];
    const setTimeout = vi.fn((callback: () => void) => {
      reconnects.push(callback);
      return reconnects.length;
    });
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout,
      clearTimeout: vi.fn()
    });
    const clientHandlers = handlers();
    const client = new GameClient("ws://server", clientHandlers);
    client.connect();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      FakeWebSocket.instances[attempt]?.emit("close", { code: 1006 });
      reconnects[attempt]?.();
    }

    expect(clientHandlers.onClose).toHaveBeenCalledTimes(8);
    expect(setTimeout).toHaveBeenCalledTimes(8);
    expect(FakeWebSocket.instances).toHaveLength(9);
  });

  it("stops at 180 seconds and lets a later foreground signal start a fresh window", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 2),
      clearTimeout: vi.fn()
    });
    const onRecoveryWindowEnded = vi.fn();
    const client = new GameClient("ws://server", {
      ...handlers(),
      onRecoveryWindowEnded
    });
    client.connect();
    FakeWebSocket.instances[0]?.emit("close", { code: 1006 });

    expect(client.recoverIfNeeded(181_000)).toBe("stopped");
    expect(onRecoveryWindowEnded).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);

    expect(client.recoverIfNeeded(181_001)).toBe("reconnecting");
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("blocks normal commands until session bootstrap completes", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");

    expect(client.moveTo(35, -106)).toBeNull();
    expect(client.startAttack("mob:pending").outcome.status)
      .toBe("session-bootstrap-pending");
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([{ type: "HELLO" }]);

    client.markAuthoritativeBootstrapComplete();
    expect(client.moveTo(35, -106)).not.toBeNull();
    expect(client.startAttack("mob:ready").outcome.status).toBe("sent");
  });

  it("keeps chat, direct messages, movement, and server-validated entity actions available while the world view prepares", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    client.markAuthoritativeBootstrapComplete();
    client.markAuthoritativeViewPreparing({
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 1,
      relocationRevision: 2,
      resourceVisionRevision: 3,
      gameplayViewGeneration: 4,
      populationPreparationGeneration: 5
    });

    const chatRequestId = client.sendChatMessage(
      "general",
      "arrived",
      "chat-after-jump"
    );
    const directMessageRequestId = client.sendDirectMessage(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "still here"
    );
    const moveRequestId = client.moveTo(35.0001, -106.0001);
    const attack = client.startAttack("mob:confirmed");

    expect(chatRequestId).toBe("chat-after-jump");
    expect(directMessageRequestId).not.toBeNull();
    expect(moveRequestId).not.toBeNull();
    expect(attack.outcome).toMatchObject({
      status: "sent",
      readiness: "world-preparing"
    });
    expect(client.readinessState()).toMatchObject({
      transportReady: true,
      sessionBootstrapComplete: true,
      worldViewState: "preparing"
    });
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CHAT_SEND" }),
        expect.objectContaining({ type: "DM_SEND" }),
        expect.objectContaining({ type: "MOVE_TO" }),
        expect.objectContaining({ type: "START_ATTACK" })
      ])
    );
  });

  it("classifies command families without using world convergence as a transport gate", () => {
    expect(clientCommandAdmissionPolicy("CHAT_SEND")).toEqual({
      family: "session",
      requiresSessionBootstrap: true,
      worldViewAdmission: "not-required"
    });
    expect(clientCommandAdmissionPolicy("DM_SEND")).toEqual({
      family: "session",
      requiresSessionBootstrap: true,
      worldViewAdmission: "not-required"
    });
    expect(clientCommandAdmissionPolicy("MOVE_TO")).toEqual({
      family: "movement",
      requiresSessionBootstrap: true,
      worldViewAdmission: "server-authoritative"
    });
    expect(clientCommandAdmissionPolicy("START_ATTACK")).toEqual({
      family: "world-entity",
      requiresSessionBootstrap: true,
      worldViewAdmission: "server-authoritative"
    });
    expect(clientCommandAdmissionPolicy("START_HARVEST")).toEqual({
      family: "world-entity",
      requiresSessionBootstrap: true,
      worldViewAdmission: "server-authoritative"
    });
  });

  it("sends one best-effort suspend frame and resumes with a fresh socket", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      clearTimeout: vi.fn()
    });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    client.markAuthoritativeBootstrapComplete();

    client.suspend();
    client.suspend();

    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "APP_SUSPEND"
    });
    expect(socket.sent.filter((value) => JSON.parse(value).type === "APP_SUSPEND"))
      .toHaveLength(1);
    expect(socket.closeCode).toBe(1001);
    expect(client.recoverIfNeeded()).toBe("reconnecting");
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("starts a fresh recovery window when resuming from suspend long after the app was hidden", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const start = 1_000;
    vi.spyOn(Date, "now").mockReturnValue(start);
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 2),
      clearTimeout: vi.fn()
    });
    const onRecoveryWindowEnded = vi.fn();
    const client = new GameClient("ws://server", { ...handlers(), onRecoveryWindowEnded });
    client.connect();
    FakeWebSocket.instances[0]?.emit("open");
    client.markAuthoritativeBootstrapComplete();

    client.suspend();

    expect(client.recoverIfNeeded(start + 10 * 60_000)).toBe("reconnecting");
    expect(onRecoveryWindowEnded).not.toHaveBeenCalled();
  });

  it("sends intent-only combat and server-owned mob requests", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");
    client.markAuthoritativeBootstrapComplete();

    client.startAttack("mob:one");
    client.spawnMob("goblin", 35.0844, -106.6504);
    client.requestWorldResync(7, 4);
    const sent = socket?.sent.map((message) => JSON.parse(message)) ?? [];
    expect(sent).toContainEqual(expect.objectContaining({
      type: "START_ATTACK",
      targetEntityId: "mob:one"
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: "DEV_SPAWN_MOB",
      archetype: "goblin",
      lat: 35.0844,
      lon: -106.6504
    }));
    expect(sent.some((message) => "damage" in message || "attackerId" in message)).toBe(false);
    expect(sent).toContainEqual(expect.objectContaining({
      type: "REQUEST_WORLD_RESYNC",
      combatSequence: 7,
      playerSequence: 4
    }));
  });

  it("creates one identified movement command for one move intent", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");
    client.markAuthoritativeBootstrapComplete();

    const requestId = client.moveTo(35.0845, -106.6503);

    const movementMessages = socket?.sent
      .map((message) => JSON.parse(message))
      .filter(({ type }) => type === "MOVE_TO");
    expect(movementMessages).toEqual([{
      type: "MOVE_TO",
      requestId,
      lat: 35.0845,
      lon: -106.6503
    }]);
    expect(requestId).toEqual(expect.any(String));
  });

  it("correlates a first post-travel move without sending destination authority", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    client.markAuthoritativeBootstrapComplete();

    const moveRequestId = client.moveTo(35.0845, -106.6503, "travel-request");

    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "MOVE_TO",
      requestId: moveRequestId,
      boundTravelRequestId: "travel-request",
      lat: 35.0845,
      lon: -106.6503
    });
  });

  it("uses the App-owned travel request ID without double-recording click telemetry", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const record = vi.spyOn(gameplayLatencyTrace, "record").mockReturnValue(true);
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    client.markAuthoritativeBootstrapComplete();
    const requestId = "11111111-1111-4111-8111-111111111111";

    expect(client.visitFlag(
      "22222222-2222-4222-8222-222222222222",
      requestId
    )).toBe(requestId);

    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "VISIT_FLAG",
      requestId,
      flagId: "22222222-2222-4222-8222-222222222222",
      source: "visible_map"
    });
    expect(record.mock.calls.some(([, name]) =>
      name === "flag_travel_clicked"
    )).toBe(false);
  });

  it("sends server-resolved manor target intents without client authority claims", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    client.markAuthoritativeBootstrapComplete();
    const manorId = "22222222-2222-4222-8222-222222222222";
    const enter = client.enterManor(manorId);
    const jump = client.jumpToManor(manorId);
    const sent = socket.sent.map((value) => JSON.parse(value));
    expect(sent).toContainEqual({
      type: "USE_PORTAL",
      requestId: enter,
      portalId: `manor:${manorId}:world-to-main`,
      expectedLocationRevision: 0
    });
    expect(sent).toContainEqual({ type: "JUMP_TO_MANOR", requestId: jump, manorId });
    expect(sent.some((message) => "playerId" in message || "returnLat" in message || "accessSource" in message)).toBe(false);
  });

  it("does not expose an unsent movement request while disconnected", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());

    expect(client.moveTo(35.0845, -106.6503)).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("does not queue or replay disconnected gameplay, social, or economic mutations", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());

    expect(client.moveTo(35, -106)).toBeNull();
    expect(client.placeFlag("Camp")).toBeNull();
    expect(client.travelToPartyLeader("travel-one")).toBeNull();
    expect(client.marketCreateOrder(
      "market-one",
      "00000000-0000-4000-8000-000000000002",
      "simple",
      "sell",
      "ore",
      "1",
      "1"
    )).toBe(false);
    expect(client.upgradeEquipment(
      "equipment-one",
      0,
      "upgrade-one",
      "00000000-0000-4000-8000-000000000001",
      0
    )).toBeNull();
    expect(client.activateClass("warrior")).toBe(false);
    expect(client.requestPetState()).toBeNull();
    expect(client.buildManor()).toBeNull();
    expect(client.sendChatMessage("public:general", "hello", "chat-one")).toBeNull();
    expect(client.sendDirectMessage("conversation-one", "message-one", "hello")).toBeNull();

    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([{ type: "HELLO" }]);
    client.disconnect();
  });

  it("sends identified flag-build cancellation and authoritative teleport intents", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");
    client.markAuthoritativeBootstrapComplete();
    const buildRequestId = client.placeFlag("Camp");
    const buildId = "11111111-1111-4111-8111-111111111111";
    client.cancelFlagBuild(buildId);
    const teleportRequestId = client.devTeleport(35.68, 139.69);
    const sent = socket?.sent.map((message) => JSON.parse(message)) ?? [];
    expect(sent).toContainEqual({ type: "PLACE_FLAG", requestId: buildRequestId, name: "Camp" });
    expect(sent).toContainEqual(expect.objectContaining({ type: "CANCEL_FLAG_BUILD", buildId }));
    expect(sent).toContainEqual({ type: "DEV_TELEPORT", requestId: teleportRequestId, lat: 35.68, lon: 139.69 });
  });

  it("keeps one active socket, listener set, and ping timer after a Strict Mode reconnect", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const setInterval = vi.fn()
      .mockReturnValueOnce(101)
      .mockReturnValueOnce(102);
    const clearInterval = vi.fn();
    vi.stubGlobal("window", { setInterval, clearInterval });
    const clientHandlers = handlers();
    const client = new GameClient("ws://server", clientHandlers);
    client.connect();
    const staleSocket = FakeWebSocket.instances[0]!;
    staleSocket.emit("open");
    expect(setInterval).toHaveBeenCalledOnce();

    client.connect();
    const activeSocket = FakeWebSocket.instances[1]!;
    expect(staleSocket.closed).toBe(true);
    expect(clearInterval).toHaveBeenCalledWith(101);
    expect(["open", "message", "error", "close"].map((type) =>
      staleSocket.listenerCount(type)
    )).toEqual([0, 0, 0, 0]);

    staleSocket.emit("open");
    staleSocket.emit("message", {
      data: JSON.stringify({ type: "PONG", clientTime: 1, serverTime: 2 })
    });
    staleSocket.emit("error");
    staleSocket.emit("close");
    expect(clientHandlers.onOpen).toHaveBeenCalledOnce();
    expect(clientHandlers.onMessage).not.toHaveBeenCalled();
    expect(clientHandlers.onError).not.toHaveBeenCalled();
    expect(clientHandlers.onClose).not.toHaveBeenCalled();
    expect(setInterval).toHaveBeenCalledOnce();

    activeSocket.emit("open");
    expect(setInterval).toHaveBeenCalledTimes(2);
    expect(["open", "message", "error", "close"].map((type) =>
      activeSocket.listenerCount(type)
    )).toEqual([1, 1, 1, 1]);

    client.disconnect();
    expect(activeSocket.closed).toBe(true);
    expect(clearInterval).toHaveBeenLastCalledWith(102);
    expect(["open", "message", "error", "close"].map((type) =>
      activeSocket.listenerCount(type)
    )).toEqual([0, 0, 0, 0]);
  });

  it("sends city intent without client-owned identity, name, settlement, or coordinates", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");
    client.markAuthoritativeBootstrapComplete();

    const flagId = "00000000-0000-4000-8000-000000000001";
    client.foundCity(flagId);
    const message = socket?.sent.map((value) => JSON.parse(value)).find(({ type }) => type === "FOUND_CITY");
    expect(message).toEqual({ type: "FOUND_CITY", requestId: expect.any(String), flagId });
  });

  it("sends chat intent without client-owned identity, sequence, or timestamp", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");
    client.markAuthoritativeBootstrapComplete();

    const requestId = "05000000-0000-4000-8000-000000000123";
    expect(client.sendChatMessage("public:general", "hello", requestId)).toBe(requestId);
    const localRequestId = "06000000-0000-4000-8000-000000000123";
    expect(client.sendChatMessage("local:map", "nearby only", localRequestId)).toBe(localRequestId);
    const selectionRequestId = client.selectChatChannel("public:trading", 42);
    client.requestChatHistory("public:trading", "older", 12);
    client.updateChatRead("public:trading", 42);
    const chat = socket?.sent.map((value) => JSON.parse(value)).filter(({ type }) =>
      type.startsWith("CHAT_")) ?? [];
    expect(chat).toEqual(expect.arrayContaining([
      { type: "CHAT_SEND", requestId, channelKey: "public:general", body: "hello" },
      { type: "CHAT_SEND", requestId: localRequestId, channelKey: "local:map", body: "nearby only" },
      expect.objectContaining({
        type: "CHAT_SELECT_CHANNEL",
        requestId: selectionRequestId,
        afterSequence: 42
      }),
      expect.objectContaining({ type: "CHAT_HISTORY_REQUEST", cursorSequence: 12, limit: 50 }),
      expect.objectContaining({ type: "CHAT_READ_UPDATE", lastReadSequence: 42 })
    ]));
    expect(chat.some((message) =>
      "senderPlayerId" in message || "sequence" in message || "serverCreatedAt" in message
    )).toBe(false);
  });

  it("uses the authenticated game socket for the complete direct-message protocol", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    client.markAuthoritativeBootstrapComplete();

    const peerPlayerId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const clientMessageId = "33333333-3333-4333-8333-333333333333";
    client.bootstrapDirectMessages();
    client.syncDirectMessages("42");
    client.listDirectMessages("next-page");
    client.openDirectMessage(peerPlayerId);
    client.requestDirectMessageHistory(conversationId, "40");
    client.sendDirectMessage(conversationId, clientMessageId, "hello privately");
    client.acknowledgeDirectMessageDelivery(conversationId, "41");
    client.updateDirectMessageRead(conversationId, "41");
    client.setDirectMessageMute(conversationId, true);
    client.setDirectMessagePreferences({ soundsEnabled: false, suppressBannersDuringCombat: true });
    client.acknowledgeDirectMessageEvents("42");

    expect(FakeWebSocket.instances).toHaveLength(1);
    const messages = socket.sent.map((value) => JSON.parse(value));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "DM_BOOTSTRAP" }),
      expect.objectContaining({ type: "DM_SYNC", afterEventSequence: "42", limit: 100 }),
      expect.objectContaining({ type: "DM_LIST", cursor: "next-page", limit: 25 }),
      expect.objectContaining({ type: "DM_OPEN", peerPlayerId }),
      expect.objectContaining({ type: "DM_HISTORY", conversationId, beforeSequence: "40", limit: 50 }),
      expect.objectContaining({ type: "DM_SEND", conversationId, clientMessageId, body: "hello privately" }),
      expect.objectContaining({ type: "DM_DELIVERED", conversationId, throughSequence: "41" }),
      expect.objectContaining({ type: "DM_READ", conversationId, throughSequence: "41" }),
      expect.objectContaining({ type: "DM_MUTE", conversationId, muted: true }),
      expect.objectContaining({
        type: "DM_PREFERENCES",
        preferences: { soundsEnabled: false, suppressBannersDuringCombat: true }
      }),
      expect.objectContaining({ type: "DM_EVENT_ACK", throughEventSequence: "42" })
    ]));
    expect(messages.filter(({ type }) => type.startsWith("DM_")).every((message) =>
      !("senderPlayerId" in message) && !("recipientPlayerId" in message)
    )).toBe(true);
  });

  it("sends plain Kingdom chat intent", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");
    client.markAuthoritativeBootstrapComplete();

    client.sendKingdomChat("hello kingdom", "chat-request-1");
    expect(socket?.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "KINGDOM_CHAT_SEND",
      requestId: "chat-request-1",
      content: "hello kingdom"
    });
  });

  it("reconnects on an unplanned mobile-style close and restores HELLO", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let reconnect: (() => void) | undefined;
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((callback: () => void) => {
        reconnect = callback;
        return 2;
      }),
      clearTimeout: vi.fn()
    });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const first = FakeWebSocket.instances[0];
    first?.emit("open");
    first?.emit("close", { code: 1006 });
    expect(reconnect).toBeTypeOf("function");
    reconnect?.();
    const second = FakeWebSocket.instances[1];
    second?.emit("open");
    expect(second?.sent.map((message) => JSON.parse(message))).toContainEqual({ type: "HELLO" });
    client.disconnect();
  });

  it("recycles an open socket that stops receiving downstream activity", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const intervals: Array<() => void> = [];
    const reconnects: Array<() => void> = [];
    vi.stubGlobal("window", {
      setInterval: vi.fn((callback: () => void) => {
        intervals.push(callback);
        return intervals.length;
      }),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((callback: () => void) => {
        reconnects.push(callback);
        return reconnects.length + 100;
      }),
      clearTimeout: vi.fn()
    });
    const clientHandlers = handlers();
    const trace = vi.spyOn(gameplayLatencyTrace, "record");
    const client = new GameClient("ws://server", clientHandlers);
    client.connect();
    const first = FakeWebSocket.instances[0]!;
    first.emit("open");

    now = 6_000;
    intervals[0]?.();
    expect(first.sent.map((message) => JSON.parse(message)))
      .toContainEqual(expect.objectContaining({ type: "PING" }));

    now = 21_001;
    intervals[0]?.();
    expect(first.closed).toBe(true);
    expect(first.closeCode).toBe(4000);
    expect(first.closeReason).toBe("server activity timeout");
    expect(clientHandlers.onClose).toHaveBeenCalledWith(
      expect.objectContaining({ code: 4000, reason: "server activity timeout" })
    );
    expect(trace).toHaveBeenCalledWith(
      "networking",
      "websocket_activity_timeout",
      { inactiveMs: 20_001 },
      { failure: true }
    );
    expect(reconnects).toHaveLength(1);

    reconnects[0]?.();
    const second = FakeWebSocket.instances[1]!;
    second.emit("open");
    expect(second.sent.map((message) => JSON.parse(message)))
      .toContainEqual({ type: "HELLO" });
    client.disconnect();
  });

  it("replaces a stale open socket when a suspended app resumes", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const stale = FakeWebSocket.instances[0]!;
    stale.emit("open");

    expect(client.recoverIfNeeded(Date.now() + 20_001)).toBe("reconnecting");
    expect(stale.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]?.emit("open");
    expect(FakeWebSocket.instances[1]?.sent.map((value) => JSON.parse(value)))
      .toContainEqual({ type: "HELLO" });
    client.disconnect();
  });

  it("keeps increasing jittered reconnect backoff until a compatible WELCOME", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const reconnects: Array<() => void> = [];
    const delays: number[] = [];
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((callback: () => void, delay: number) => {
        reconnects.push(callback);
        delays.push(delay);
        return reconnects.length + 1;
      }),
      clearTimeout: vi.fn()
    });
    const client = new GameClient("ws://server", handlers(), () => 0.5);
    client.connect();
    const first = FakeWebSocket.instances[0];
    first?.emit("open");
    first?.emit("close", { code: 1006 });
    reconnects.shift()?.();
    const second = FakeWebSocket.instances[1];
    second?.emit("open");
    second?.emit("close", { code: 1006 });

    expect(delays).toEqual([0, 250]);
    client.disconnect();
  });

  it("fences stale reconnect and ping timer callbacks", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const intervals: Array<() => void> = [];
    const reconnects: Array<() => void> = [];
    vi.stubGlobal("window", {
      setInterval: vi.fn((callback: () => void) => {
        intervals.push(callback);
        return intervals.length;
      }),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((callback: () => void) => {
        reconnects.push(callback);
        return reconnects.length + 100;
      }),
      clearTimeout: vi.fn()
    });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const first = FakeWebSocket.instances[0]!;
    first.emit("open");
    first.emit("close", { code: 1006 });
    const stalePing = intervals[0]!;
    const staleReconnect = reconnects[0]!;

    client.connect();
    const current = FakeWebSocket.instances[1]!;
    current.emit("open");
    stalePing();
    staleReconnect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(current.sent.map((value) => JSON.parse(value))).toEqual([{ type: "HELLO" }]);
    client.disconnect();
  });

  it("survives 100 welcomed reconnect cycles with one socket and no leaked timers or listeners", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let nextTimerId = 0;
    const intervals = new Map<number, () => void>();
    const timeouts = new Map<number, () => void>();
    vi.stubGlobal("window", {
      setInterval: vi.fn((callback: () => void) => {
        const id = ++nextTimerId;
        intervals.set(id, callback);
        return id;
      }),
      clearInterval: vi.fn((id: number) => intervals.delete(id)),
      setTimeout: vi.fn((callback: () => void) => {
        const id = ++nextTimerId;
        timeouts.set(id, callback);
        return id;
      }),
      clearTimeout: vi.fn((id: number) => timeouts.delete(id))
    });
    const client = new GameClient("ws://server", handlers(), () => 0.5);
    client.connect();

    for (let cycle = 0; cycle < 100; cycle += 1) {
      const socket = FakeWebSocket.instances[cycle]!;
      socket.emit("open");
      socket.emit("message", { data: JSON.stringify(serverWelcome()) });
      expect(intervals.size).toBe(1);
      socket.emit("close", { code: 1006 });
      expect(intervals.size).toBe(0);
      expect(timeouts.size).toBe(1);
      const [timerId, reconnect] = [...timeouts.entries()][0]!;
      timeouts.delete(timerId);
      reconnect();
      expect(socket.activeListenerCount()).toBe(0);
    }

    const active = FakeWebSocket.instances[100]!;
    active.emit("open");
    active.emit("message", { data: JSON.stringify(serverWelcome()) });
    expect(FakeWebSocket.instances.filter((socket) => !socket.closed)).toEqual([active]);
    expect(active.activeListenerCount()).toBe(4);
    expect(intervals.size).toBe(1);
    expect(timeouts.size).toBe(0);

    client.disconnect();
    expect(intervals.size).toBe(0);
    expect(timeouts.size).toBe(0);
    expect(active.activeListenerCount()).toBe(0);
  });

  it("resets reconnect backoff only after a compatible legacy WELCOME", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const reconnects: Array<() => void> = [];
    const delays: number[] = [];
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((callback: () => void, delay: number) => {
        reconnects.push(callback);
        delays.push(delay);
        return reconnects.length + 1;
      }),
      clearTimeout: vi.fn()
    });
    const client = new GameClient("ws://server", handlers(), () => 0.5);
    client.connect();
    FakeWebSocket.instances[0]?.emit("open");
    FakeWebSocket.instances[0]?.emit("close", { code: 1006 });
    reconnects.shift()?.();
    FakeWebSocket.instances[1]?.emit("open");
    FakeWebSocket.instances[1]?.emit("message", { data: JSON.stringify(serverWelcome()) });
    client.markAuthoritativeBootstrapComplete();
    FakeWebSocket.instances[1]?.emit("close", { code: 1006 });

    expect(delays).toEqual([0, 0]);
    client.disconnect();
  });

  it("reports a capability-gated WELCOME release identity", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const onServerComponentRelease = vi.fn();
    const client = new GameClient("ws://server", {
      ...handlers(),
      onServerComponentRelease
    });
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    socket.emit("message", { data: JSON.stringify({
      ...serverWelcome({
        protocolId: "ash-atlas",
        minVersion: 3,
        maxVersion: 3,
        version: 3,
        capabilities: ["welcome-release-sha"]
      }),
      releaseSha: "a".repeat(40)
    }) });

    expect(onServerComponentRelease).toHaveBeenCalledWith("a".repeat(40));
    client.disconnect();
  });

  it("preserves caller-supplied market idempotency keys and sends intent-only values", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");
    client.markAuthoritativeBootstrapComplete();

    const marketSessionId = "00000000-0000-4000-8000-000000000002";
    client.marketCreateOrder("stable-create-request", marketSessionId, "merchant", "buy", "ore", "4", "9");
    client.marketSimpleBuy(
      "stable-buy-request",
      marketSessionId,
      "00000000-0000-4000-8000-000000000001",
      "36"
    );
    client.marketSetSubscriptions("subscription-request", marketSessionId, ["ore"], "ore", true, 7);

    const messages = socket?.sent.map((value) => JSON.parse(value)) ?? [];
    expect(messages).toContainEqual({
      type: "MARKET_CREATE_ORDER",
      requestId: "stable-create-request",
      marketSessionId,
      interface: "merchant",
      side: "buy",
      itemIdentity: "ore",
      quantity: "4",
      unitPrice: "9"
    });
    expect(messages).toContainEqual({
      type: "MARKET_SIMPLE_BUY",
      requestId: "stable-buy-request",
      marketSessionId,
      quoteId: "00000000-0000-4000-8000-000000000001",
      maximumTotal: "36"
    });
    expect(messages).toContainEqual(expect.objectContaining({
      type: "MARKET_SET_SUBSCRIPTIONS",
      revision: 7
    }));
    expect(messages.some((message) =>
      "playerId" in message || "sellerId" in message || "balance" in message || "fee" in message
    )).toBe(false);
  });

  it("rejects malformed inbound market wire values before they reach UI state", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const onMessage = vi.fn();
    const onError = vi.fn();
    const client = new GameClient("ws://server", {
      ...handlers(),
      onMessage,
      onError
    });
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");

    socket?.emit("message", {
      data: JSON.stringify({
        type: "MARKET_BOOK_CHANGED",
        itemId: "ore",
        bookVersion: "01"
      })
    });
    expect(onError).toHaveBeenCalledWith("Malformed MARKET_BOOK_CHANGED server frame");
    expect(onMessage).not.toHaveBeenCalled();

    socket?.emit("message", {
      data: JSON.stringify({
        type: "MARKET_BOOK_CHANGED",
        itemId: "ore",
        bookVersion: "2"
      })
    });
    expect(onMessage).toHaveBeenCalledWith({
      type: "MARKET_BOOK_CHANGED",
      itemId: "ore",
      bookVersion: "2"
    });
  });

  it("stops without reconnecting when a future server selects an incompatible protocol", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const setTimeout = vi.fn(() => 1);
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout,
      clearTimeout: vi.fn()
    });
    const onProtocolIncompatible = vi.fn();
    const onMessage = vi.fn();
    const client = new GameClient("ws://server", {
      ...handlers(),
      onMessage,
      onProtocolIncompatible
    });
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify(serverWelcome({
        protocolId: "ash-atlas",
        minVersion: 4,
        maxVersion: 4,
        version: 4,
        capabilities: []
      }))
    });

    expect(onProtocolIncompatible).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
    expect(socket.closeCode).toBe(4003);
    expect(socket.closeReason).toBe("protocol incompatible");
    expect(setTimeout).not.toHaveBeenCalled();
  });

  it("treats the server incompatibility close as terminal without a retry storm", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const setTimeout = vi.fn(() => 1);
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout,
      clearTimeout: vi.fn()
    });
    const onProtocolIncompatible = vi.fn();
    const onClose = vi.fn();
    const client = new GameClient("ws://server", {
      ...handlers(),
      onClose,
      onProtocolIncompatible
    });
    client.connect();
    FakeWebSocket.instances[0]?.emit("close", { code: 4003 });

    expect(onProtocolIncompatible).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
  });

  it("contains malformed and unknown frames and recycles only after a bounded threshold", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const setTimeout = vi.fn(() => 1);
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout,
      clearTimeout: vi.fn()
    });
    const onMessage = vi.fn();
    const onError = vi.fn();
    const client = new GameClient("ws://server", {
      ...handlers(),
      onMessage,
      onError
    }, () => 0.5);
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    socket.emit("message", { data: "{" });
    socket.emit("message", { data: JSON.stringify({ type: "FUTURE_FRAME" }) });
    socket.emit("message", { data: JSON.stringify({ type: "PONG", clientTime: "bad" }) });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(3);
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1002);
    expect(setTimeout).toHaveBeenCalledOnce();
  });

  it("reports a send exception without throwing or replaying the command", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const onError = vi.fn();
    const client = new GameClient("ws://server", { ...handlers(), onError });
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    client.markAuthoritativeBootstrapComplete();
    socket.sendError = new Error("send failed");

    expect(client.moveTo(35, -106)).toBeNull();
    expect(onError).toHaveBeenCalledWith("send failed");
    expect(socket.sent.filter((value) => JSON.parse(value).type === "MOVE_TO")).toEqual([]);
  });

  it("sends self-only class progression intent", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "00000000-0000-4000-8000-0000000000c2") });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");
    client.markAuthoritativeBootstrapComplete();

    client.adjustOwnDevProgression("warrior_level", 4);
    expect(socket?.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "ADJUST_OWN_DEV_PROGRESSION",
      operationId: "00000000-0000-4000-8000-0000000000c2",
      progressionType: "warrior_level",
      targetRank: 4
    });
  });

  it("sends class ability and party intents without client-owned authority", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "00000000-0000-4000-8000-0000000000c2") });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.emit("open");
    client.markAuthoritativeBootstrapComplete();

    client.useNormalAbility("druid_rejuvenation", "player-ally", "friendly");
    client.useUniversalTaunt();
    client.createParty();
    client.invitePartyMember("player-ally");
    expect(socket?.sent.map((message) => JSON.parse(message))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "USE_NORMAL_ABILITY",
        abilityId: "druid_rejuvenation",
        targetEntityId: "player-ally",
        targetMode: "friendly"
      }),
      expect.objectContaining({ type: "USE_UNIVERSAL_TAUNT" }),
      expect.objectContaining({ type: "CREATE_PARTY" }),
      expect.objectContaining({ type: "ADD_PARTY_MEMBER", targetPlayerId: "player-ally" })
    ]));
  });

  it("sends travel intents without client-selected destinations or party authority", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "00000000-0000-4000-8000-0000000000c2") });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    client.markAuthoritativeBootstrapComplete();

    const inviteId = "00000000-0000-4000-8000-000000000002";
    client.sendTravelInvite("player-ally");
    const acceptRequestId = client.respondTravelInvite(inviteId, "accept");
    client.cancelTravelInvite(inviteId);
    client.setPartyTravelAllowed(true);
    client.setPartyAutoFollow(true);
    const partyTravelRequestId = client.travelToPartyLeader();

    const messages = socket.sent.map((message) => JSON.parse(message));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "SEND_TRAVEL_INVITE", targetPlayerId: "player-ally" }),
      expect.objectContaining({
        type: "RESPOND_TRAVEL_INVITE",
        requestId: acceptRequestId,
        inviteId,
        response: "accept"
      }),
      expect.objectContaining({ type: "CANCEL_TRAVEL_INVITE", inviteId }),
      expect.objectContaining({ type: "SET_PARTY_TRAVEL_ALLOWED", allowed: true }),
      expect.objectContaining({ type: "SET_PARTY_AUTO_FOLLOW", enabled: true }),
      expect.objectContaining({ type: "TRAVEL_TO_PARTY_LEADER", requestId: partyTravelRequestId })
    ]));
    expect(messages.some((message) =>
      "lat" in message || "lon" in message || "sourceFlagId" in message || "leaderPlayerId" in message
    )).toBe(false);
  });

  it("preserves stable equipment and combat-kit request identities", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    const client = new GameClient("ws://server", handlers());
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    client.markAuthoritativeBootstrapComplete();

    expect(client.upgradeEquipment(
      "00000000-0000-4000-8000-000000000001",
      0,
      "upgrade-zero-one",
      "00000000-0000-4000-8000-000000000002",
      6
    )).toBe("upgrade-zero-one");
    expect(client.upgradeEquipment(
      "00000000-0000-4000-8000-000000000001",
      0,
      "upgrade-at-manor",
      "00000000-0000-4000-8000-000000000002",
      7
    )).toBe("upgrade-at-manor");
    expect(client.saveCombatKit(1, 9, "save-one")).toBe("save-one");
    expect(client.renameCombatKit(1, "Pressure", "rename-one")).toBe("rename-one");
    expect(client.clearCombatKit(1, 9, "clear-one")).toBe("clear-one");
    expect(client.activateCombatKit(6, 9, "activate-six")).toBe("activate-six");
    expect(client.toggleReadiedWeapon("secondary", 9, "ready-ranged")).toBe("ready-ranged");

    expect(socket.sent.map((message) => JSON.parse(message))).toEqual(expect.arrayContaining([
      {
        type: "UPGRADE_EQUIPMENT",
        requestId: "upgrade-zero-one",
        instanceId: "00000000-0000-4000-8000-000000000001",
        expectedLevel: 0,
        manorSessionId: "00000000-0000-4000-8000-000000000002",
        manorMovementSequence: 6
      },
      {
        type: "UPGRADE_EQUIPMENT",
        requestId: "upgrade-at-manor",
        instanceId: "00000000-0000-4000-8000-000000000001",
        expectedLevel: 0,
        manorSessionId: "00000000-0000-4000-8000-000000000002",
        manorMovementSequence: 7
      },
      {
        type: "SAVE_COMBAT_KIT",
        requestId: "save-one",
        kitIndex: 1,
        expectedInventoryRevision: 9
      },
      {
        type: "RENAME_COMBAT_KIT",
        requestId: "rename-one",
        kitIndex: 1,
        name: "Pressure"
      },
      {
        type: "CLEAR_COMBAT_KIT",
        requestId: "clear-one",
        kitIndex: 1,
        expectedInventoryRevision: 9
      },
      {
        type: "ACTIVATE_COMBAT_KIT",
        requestId: "activate-six",
        kitIndex: 6,
        expectedInventoryRevision: 9
      },
      {
        type: "TOGGLE_READIED_WEAPON",
        requestId: "ready-ranged",
        readiedWeaponSlot: "secondary",
        expectedInventoryRevision: 9
      }
    ]));
  });
});

function serverWelcome(protocol?: {
  protocolId: string;
  minVersion: number;
  maxVersion: number;
  version: number;
  capabilities: string[];
}) {
  return {
    type: "WELCOME",
    playerId: "player-1",
    username: "Ash",
    spawn: { lat: 35.0844, lon: -106.6504 },
    anchor: { lat: 35.0844, lon: -106.6504 },
    moveLeashRadiusM: 900,
    flagClaimRadiusM: 150,
    playerSpeedMps: 3,
    serverTickHz: 20,
    regionCode: "NM",
    zoneId: "zone-1",
    developerCapabilities: [],
    serverTime: 1,
    ...(protocol ? { protocol } : {})
  };
}

function handlers(onSessionInvalid = vi.fn()) {
  return {
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onMessage: vi.fn(),
    onError: vi.fn(),
    onSessionInvalid
  };
}
