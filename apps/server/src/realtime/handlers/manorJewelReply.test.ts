import { describe, expect, it, vi } from "vitest";

import type { JewelStationService } from "../../game/jewelStation.js";
import type { ManorRuntime } from "../../game/manor.js";
import type { GreenhouseService } from "../../game/greenhouses.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import { createManorHandler, type ManorHandlerContext } from "./manorHandler.js";

describe("Jewel Station replies", () => {
  it("returns the state to the requesting socket instead of another active connection", async () => {
    const socket = { send: vi.fn() } as unknown as SocketLike;
    const safeSendServerMessage = vi.fn(() => true);
    const registry = { send: vi.fn() } as unknown as ConnectionRegistry;
    const state = {
      equipment: { instances: [] },
      inventory: { items: [] },
      achievements: { achievements: [] }
    };
    const handler = createManorHandler({
      state: { playerId: "player-1", connectionId: "connection-1" },
      socket,
      logger: {},
      registry,
      manorRuntime: { authorizeJewel: vi.fn() } as unknown as ManorRuntime,
      jewelStation: { state: vi.fn(async () => state) } as unknown as JewelStationService,
      safeSendServerMessage
    } as unknown as ManorHandlerContext);

    await handler({
      type: "OPEN_JEWEL_STATION",
      requestId: "open-1",
      manorSessionId: "00000000-0000-4000-8000-000000000001",
      movementSequence: 1
    });

    expect(safeSendServerMessage).toHaveBeenCalledWith(
      socket,
      { type: "JEWEL_STATION_STATE", requestId: "open-1", state },
      expect.anything(),
      expect.objectContaining({
        playerId: "player-1",
        requestId: "open-1",
        action: "open-jewel-station"
      })
    );
    expect(registry.send).not.toHaveBeenCalled();
  });

  it("dispatches BUILD_GREENHOUSE through the production manor handler context", async () => {
    const registry = { send: vi.fn() } as unknown as ConnectionRegistry;
    const player = {
      playerId: "player-1",
      position: { lat: 1, lon: 2 },
      regionCode: "test"
    };
    const result = {
      status: "constructing" as const,
      build: {
        buildId: "build-1",
        position: { lat: 1, lon: 2 },
        eligibility: { isRiverbank: false, policyId: "test", policyDistanceM: 500, checkedAt: new Date(0).toISOString() },
        startedAt: 1,
        completesAt: 30_001,
        durationMs: 30_000
      },
      inventory: { items: [], totals: {}, capacity: { used: 0, max: 100 } },
      replayed: false
    };
    const handler = createManorHandler({
      state: { playerId: "player-1", connectionId: "connection-1" },
      socket: { send: vi.fn() } as unknown as SocketLike,
      logger: { warn: vi.fn() },
      registry,
      gameState: {
        getPlayer: vi.fn(() => player),
        isWorldPresent: vi.fn(() => true),
        stopPlayer: vi.fn(),
        setMovementBlocked: vi.fn(),
        isMovementBlocked: vi.fn(() => false)
      },
      worldRuntime: { hasPlayerWorldTransition: vi.fn(() => false), hasPendingCommand: vi.fn(() => false) },
      greenhouses: { build: vi.fn(async () => result) } as unknown as GreenhouseService,
      playerAuthorityFence: { run: vi.fn(async (_playerId: string, action: () => Promise<void>) => action()) },
      activeHarvestSessionForPlayer: vi.fn(async () => null),
      sendManorError: vi.fn()
    } as unknown as ManorHandlerContext);

    await handler({ type: "BUILD_GREENHOUSE", requestId: "build-request-1" });

    expect(registry.send).toHaveBeenCalledWith("player-1", expect.objectContaining({
      type: "GREENHOUSE_BUILD_STARTED",
      requestId: "build-request-1",
      build: result.build
    }));
  });
});
