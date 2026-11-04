import { describe, expect, it, vi } from "vitest";

import { createDeveloperHandler } from "./developerHandler.js";

const cityId = "11111111-1111-4111-8111-111111111111";

describe("Developer Goblin Village deletion authorization", () => {
  it.each([
    { authorized: false, expectedDeletes: 0 },
    { authorized: true, expectedDeletes: 1 }
  ])("enforces world-mutation authority before deletion (authorized=$authorized)", async ({
    authorized,
    expectedDeletes
  }) => {
    const authorizeDeveloperCommand = vi.fn(async () => {
      if (!authorized) throw new Error("forbidden");
    });
    const recordDeveloperCommandResult = vi.fn(async () => undefined);
    const deleteVillage = vi.fn(async () => ({
      replayed: false,
      city: { cityId, name: "Goblin Village", hallLat: 35.0844, hallLon: -106.6504 },
      removedFlagIds: [],
      structureIds: [],
      affectedZoneIds: []
    }));
    const listActiveVillages = vi.fn(async () => []);
    const broadcast = vi.fn();
    const safeSendServerMessage = vi.fn(() => true);
    const sendCombatError = vi.fn();
    const handler = createDeveloperHandler({
      state: { playerId: "player-1", connectionId: "connection-1" },
      socket: {},
      authenticatedSession: { player: { id: "player-1" } },
      auth: { authorizeDeveloperCommand, recordDeveloperCommandResult },
      goblinVillage: { deleteVillage, listActiveVillages },
      registry: { broadcast },
      safeSendServerMessage,
      sendCombatError,
      logger: {}
    } as never);

    await handler({
      type: "DEV_DELETE_GOBLIN_VILLAGE",
      requestId: "delete-goblin-village-1",
      cityId
    });

    expect(authorizeDeveloperCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        capability: "developer:world-mutate",
        command: "goblin-village.delete",
        target: cityId,
        operationKey: "delete-goblin-village-1"
      })
    );
    expect(deleteVillage).toHaveBeenCalledTimes(expectedDeletes);
    if (authorized) {
      expect(sendCombatError).not.toHaveBeenCalled();
      expect(safeSendServerMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: "DEV_GOBLIN_VILLAGE_DELETED",
          requestId: "delete-goblin-village-1"
        })
      );
    } else {
      expect(sendCombatError).toHaveBeenCalledWith(
        expect.anything(),
        "delete-goblin-village-1",
        "DEVELOPER_COMMAND_FORBIDDEN",
        "Developer command is unavailable"
      );
      expect(safeSendServerMessage).not.toHaveBeenCalled();
    }
  });
});

describe("Developer Goblin Village spawn publication", () => {
  it("refreshes combat scope for the spawner and deduplicated nearby players", async () => {
    const authorizeDeveloperCommand = vi.fn(async () => undefined);
    const recordDeveloperCommandResult = vi.fn(async () => undefined);
    const flags = [
      { id: "flag-1", lat: 35.0844, lon: -106.6504 },
      { id: "flag-2", lat: 35.0850, lon: -106.6510 }
    ];
    const market = { id: "market-1", lat: 35.0847, lon: -106.6507 };
    const spawn = vi.fn(async () => ({
      replayed: false,
      city: { id: cityId },
      flags,
      market
    }));
    const playerIdsWhoseGameplayViewCircleContains = vi.fn()
      .mockReturnValueOnce(["player-near", "player-shared"])
      .mockReturnValueOnce(["player-shared"])
      .mockReturnValueOnce(["player-market"]);
    const sendCombatScopeSnapshot = vi.fn();
    const handler = createDeveloperHandler({
      state: { playerId: "player-1", connectionId: "connection-1" },
      socket: {},
      authenticatedSession: { player: { id: "player-1" } },
      auth: { authorizeDeveloperCommand, recordDeveloperCommandResult },
      goblinVillage: { spawn },
      gameState: {
        getPlayer: () => ({ playerId: "player-1" }),
        playerIdsWhoseGameplayViewCircleContains
      },
      registry: {},
      safeSendServerMessage: vi.fn(() => true),
      sendCombatError: vi.fn(),
      sendCombatScopeSnapshot,
      logger: {}
    } as never);

    await handler({
      type: "DEV_SPAWN_GOBLIN_VILLAGE",
      requestId: "spawn-goblin-village-1",
      lat: 35.0844,
      lon: -106.6504
    });

    expect(playerIdsWhoseGameplayViewCircleContains.mock.calls.map(([point]) => point))
      .toEqual([...flags, market]);
    expect(sendCombatScopeSnapshot.mock.calls.map(([playerId]) => playerId))
      .toEqual(["player-1", "player-near", "player-shared", "player-market"]);
  });
});
