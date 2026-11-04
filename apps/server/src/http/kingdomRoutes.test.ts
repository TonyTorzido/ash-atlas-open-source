import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

import type { AuthenticatedSession } from "../auth/types.js";
import type { AppConfig } from "../config.js";
import type { GameState } from "../game/state.js";
import type { FlagService } from "../game/flags.js";
import type { KingdomService } from "../game/kingdoms.js";
import type { AppLogger } from "../logger.js";
import { ConnectionRegistry, type SocketLike } from "../realtime/connectionRegistry.js";
import {
  KingdomRouteRateGate,
  deliverKingdomSpatialChanges,
  publicMutationResult,
  publishFlagUpdates,
  registerKingdomRoutes,
  runPostCommit,
  sendInventorySnapshot
} from "./kingdomRoutes.js";

describe("Kingdom route hardening", () => {
  it("contains post-commit failures and continues later effects", async () => {
    const warn = vi.fn();
    const later = vi.fn();
    await expect(runPostCommit({ warn } as unknown as AppLogger, "donate", "player-1", [
      async () => { throw new Error("stat refresh failed"); },
      later
    ])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "player-1", operation: "donate" }),
      "Kingdom post-commit effect failed"
    );
    expect(later).toHaveBeenCalledOnce();
  });

  it("pushes the committed authoritative inventory through the standard resource message", async () => {
    const registry = new ConnectionRegistry();
    const playerSocket = socket();
    registry.add({
      playerId: "player-1", username: "Player", regionCode: "NM", zoneId: "world:NM", socket: playerSocket
    });
    const inventory = { totals: { wood: 0, stone: 0, food: 0, ore: 0, water: 0 }, items: [] };
    const service = { inventorySnapshot: vi.fn(async () => inventory) } as unknown as KingdomService;

    await sendInventorySnapshot(registry, service, "player-1");

    expect(service.inventorySnapshot).toHaveBeenCalledWith("player-1");
    expect(JSON.parse(String(vi.mocked(playerSocket.send).mock.calls[0]![0]))).toMatchObject({
      type: "PLAYER_RESOURCES_UPDATED",
      playerId: "player-1",
      inventory
    });
  });

  it("broadcasts the transformed founding source as an in-place Seat update", async () => {
    const registry = new ConnectionRegistry();
    const first = socket();
    const second = socket();
    registry.add({ playerId: "player-1", username: "One", regionCode: "NM", zoneId: "world:NM", socket: first });
    registry.add({ playerId: "player-2", username: "Two", regionCode: "NM", zoneId: "world:NM", socket: second });
    const seat = {
      id: "source-flag",
      controlType: "kingdom_seat",
      kingdomId: "kingdom-a",
      kingdomSeatId: "seat-a"
    };
    const flags = { getMapFlag: vi.fn(async () => seat) } as unknown as FlagService;

    await publishFlagUpdates(flags, registry, ["source-flag"], "transformed");

    expect(flags.getMapFlag).toHaveBeenCalledOnce();
    for (const target of [first, second]) {
      expect(JSON.parse(String(vi.mocked(target.send).mock.calls[0]![0]))).toEqual({
        type: "FLAG_UPDATED",
        flag: seat
      });
    }
  });

  it("keeps internal delivery metadata out of HTTP mutation responses", () => {
    expect(publicMutationResult({
      state: null,
      stateRefreshRequired: true,
      replayed: false,
      spatialChanges: [],
      notificationPlayerIds: ["private-audience"]
    })).toEqual({ state: null, stateRefreshRequired: true, replayed: false });
  });

  it("routes validated advancement-project start and cancellation mutations", async () => {
    const app = Fastify();
    app.decorateRequest("authSession", null);
    app.addHook("onRequest", async (request) => {
      request.authSession = {
        player: { id: "player-1" }
      } as AuthenticatedSession;
    });
    const startAdvancementProject = vi.fn(async () => ({
      state: null,
      stateRefreshRequired: true,
      replayed: false,
      notificationPlayerIds: ["private-audience"]
    }));
    const cancelAdvancementProject = vi.fn(async () => ({
      state: null,
      stateRefreshRequired: false,
      replayed: true,
      notificationPlayerIds: ["private-audience"]
    }));
    const refreshPlayerStats = vi.fn(async () => {});
    registerKingdomRoutes(
      app,
      { startAdvancementProject, cancelAdvancementProject } as unknown as KingdomService,
      {} as FlagService,
      {} as GameState,
      new ConnectionRegistry(),
      { warn: vi.fn(), error: vi.fn() } as unknown as AppLogger,
      {
        KINGDOM_FOUNDING_QUOTE_RATE_MAX: 10,
        KINGDOM_MUTATION_RATE_MAX: 30,
        KINGDOM_MUTATION_RATE_WINDOW_SECONDS: 10
      } as AppConfig,
      refreshPlayerStats
    );

    const started = await app.inject({
      method: "POST",
      url: "/api/kingdom/project/start",
      payload: { requestId: "start-project", targetLevel: 2 }
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({
      state: null,
      stateRefreshRequired: true,
      replayed: false
    });
    expect(startAdvancementProject).toHaveBeenCalledWith("player-1", {
      requestId: "start-project",
      targetLevel: 2
    });
    expect(refreshPlayerStats).toHaveBeenCalledWith(["player-1"]);

    const projectId = "00000000-0000-4000-8000-000000900010";
    const cancelled = await app.inject({
      method: "POST",
      url: "/api/kingdom/project/cancel",
      payload: { requestId: "cancel-project", projectId }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({
      state: null,
      stateRefreshRequired: false,
      replayed: true
    });
    expect(cancelAdvancementProject).toHaveBeenCalledWith("player-1", {
      requestId: "cancel-project",
      projectId
    });

    await app.close();
  });

  it("authoritatively limits repeated expensive mutations", () => {
    const gate = new KingdomRouteRateGate();
    expect(gate.consume("player-1", "mutation", 2, 10_000)).toBe(true);
    expect(gate.consume("player-1", "mutation", 2, 10_000)).toBe(true);
    expect(gate.consume("player-1", "mutation", 2, 10_000)).toBe(false);
    expect(gate.consume("player-2", "mutation", 2, 10_000)).toBe(true);
  });

  it("lazily removes inactive rate windows", () => {
    const gate = new KingdomRouteRateGate();
    gate.consume("old-player", "mutation", 2, 1_000, 1);
    expect(gate.sizeForTests()).toBe(1);
    gate.consume("new-player", "mutation", 2, 1_000, 2_000);
    expect(gate.sizeForTests()).toBe(1);
  });

  it("sends removal to old viewers, upsert to new/current viewers, and nothing distant", () => {
    const registry = new ConnectionRegistry();
    const sockets = [socket(), socket(), socket(), socket()];
    const positions = [
      { lat: 35, lon: -106 },
      { lat: 35, lon: -105.5 },
      { lat: 35, lon: -105.75 },
      { lat: 40, lon: -100 }
    ];
    sockets.forEach((item, index) => registry.add({
      playerId: `player-${index}`,
      username: `Player${index}`,
      regionCode: "NM",
      zoneId: "world:NM",
      socket: item
    }));
    const gameState = {
      getPlayer(playerId: string) {
        const index = Number(playerId.split("-")[1]);
        return { playerId, position: positions[index] };
      }
    } as unknown as GameState;

    deliverKingdomSpatialChanges(
      [{ previous: objectEntity(-106, "1"), current: objectEntity(-105.5, "2"), spatialRevision: "2" }],
      gameState,
      registry,
      30_000
    );

    expect(sentType(sockets[0]!)).toBe("KINGDOM_SPATIAL_CHANGES");
    expect(sentType(sockets[1]!)).toBe("KINGDOM_SPATIAL_CHANGES");
    expect(sentType(sockets[2]!)).toBe("KINGDOM_SPATIAL_CHANGES");
    expect(sockets[3]!.send).not.toHaveBeenCalled();
    const payload = JSON.parse(String(vi.mocked(sockets[1]!.send).mock.calls[0]![0]));
    expect(payload.changes).toHaveLength(1);
    expect(payload.changes[0].entity.object).toMatchObject({ id: "object-1", kind: "decoration" });
    expect(payload.changes[0].entity.object).not.toHaveProperty("personalOwnerPlayerId");
    expect(payload).not.toHaveProperty("roster");
  });

  it("delivers a critical batch through soft WebSocket backpressure", () => {
    const registry = new ConnectionRegistry(1, 1_000, 20);
    const pressured = socket();
    pressured.bufferedAmount = 10;
    registry.add({
      playerId: "pressured-player",
      username: "Pressured",
      regionCode: "NM",
      zoneId: "world:NM",
      socket: pressured
    });
    deliverKingdomSpatialChanges(
      [{ previous: null, current: objectEntity(-106, "3"), spatialRevision: "3" }],
      { getPlayer: () => ({ position: { lat: 35, lon: -106 } }) } as unknown as GameState,
      registry,
      30_000
    );
    expect(pressured.send).toHaveBeenCalledOnce();
    expect(registry.metricsSnapshot().replaceableSkipped).toBe(0);
  });

  it("sends multiple visible changes in one batch and closes at hard backpressure", () => {
    const registry = new ConnectionRegistry(1, 5, 20);
    const healthy = socket();
    const blocked = socket();
    blocked.bufferedAmount = 10;
    registry.add({ playerId: "healthy", username: "Healthy", regionCode: "NM", zoneId: "world:NM", socket: healthy });
    registry.add({ playerId: "blocked", username: "Blocked", regionCode: "NM", zoneId: "world:NM", socket: blocked });
    const state = { getPlayer: () => ({ position: { lat: 35, lon: -106 } }) } as unknown as GameState;
    deliverKingdomSpatialChanges([
      { previous: null, current: objectEntity(-106, "4"), spatialRevision: "4" },
      { previous: objectEntity(-106, "5"), current: null, spatialRevision: "6" }
    ], state, registry, 30_000);
    expect(healthy.send).toHaveBeenCalledOnce();
    expect(JSON.parse(String(vi.mocked(healthy.send).mock.calls[0]![0])).changes).toHaveLength(2);
    expect(blocked.send).not.toHaveBeenCalled();
    expect(blocked.close).toHaveBeenCalledWith(4008, "websocket backpressure limit exceeded");
  });
});

function objectEntity(lon: number, spatialRevision: string) {
  return {
    entityType: "object" as const,
    id: "object-1",
    kingdomId: "kingdom-1",
    objectKind: "decoration" as const,
    object: {
      id: "object-1",
      kingdomId: "kingdom-1",
      kind: "decoration" as const,
      typeId: "banner" as const,
      displayName: "Banner",
      lat: 35,
      lon,
      rotation: 0,
      spatialRevision
    }
  };
}

function sentType(value: SocketLike): string {
  return JSON.parse(String(vi.mocked(value.send).mock.calls[0]![0])).type as string;
}

function socket(): SocketLike {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn()
  };
}
