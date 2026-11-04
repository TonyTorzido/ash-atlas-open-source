import { describe, expect, it, vi } from "vitest";

import { createDeveloperHandler } from "./developerHandler.js";

const entrance = {
  entranceId: "dev-dungeon-1",
  dungeonId: "cistern_warrens",
  portalId: "dungeon:dev-dungeon-1:world-to-entrance",
  portalRevision: "developer:1:1:1:1",
  interactionLabel: "Descend into Sewer",
  name: "Cistern Warrens",
  description: "A fixture dungeon entrance.",
  regionCode: "world_v1_lat35_lon-107",
  lat: 35.1,
  lon: -106.6,
  interactionRadiusM: 95,
  footprintRadiusM: 35,
  presentation: "cave" as const,
  assetKey: null,
  developerSpawned: true,
  templateId: "cistern_warrens_world_entrance",
  placementRevision: 1,
  createdAt: "2026-09-07T00:00:00.000Z",
  dungeonRevision: "1"
};

describe("Developer dungeon entrance command authority", () => {
  it.each([
    {
      name: "spawn",
      message: {
        type: "DEV_SPAWN_DUNGEON_ENTRANCE" as const,
        requestId: "spawn-1",
        templateId: "cistern_warrens_world_entrance",
        lat: 35.1,
        lon: -106.6
      },
      capability: "developer:world-mutate" as const,
      command: "dungeon-entrance.spawn",
      target: "cistern_warrens_world_entrance"
    },
    {
      name: "list",
      message: {
        type: "DEV_LIST_DUNGEON_ENTRANCES" as const,
        requestId: "list-1"
      },
      capability: "developer:observe" as const,
      command: "dungeon-entrance.list",
      target: null
    },
    {
      name: "delete",
      message: {
        type: "DEV_DELETE_DUNGEON_ENTRANCE" as const,
        requestId: "delete-1",
        entranceId: entrance.entranceId
      },
      capability: "developer:world-mutate" as const,
      command: "dungeon-entrance.delete",
      target: entrance.entranceId
    }
  ])("rejects $name before calling the dungeon service", async ({
    message,
    capability,
    command,
    target
  }) => {
    const context = makeContext(false);
    await createDeveloperHandler(context as never)(message);

    expect(context.authorizeDeveloperCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        capability,
        command,
        target,
        operationKey: message.requestId
      })
    );
    expect(context.sendCombatError).toHaveBeenCalledWith(
      expect.anything(),
      message.requestId,
      "DEVELOPER_COMMAND_FORBIDDEN",
      "Developer command is unavailable"
    );
    expect(context.developerSpawnedDungeons.spawn).not.toHaveBeenCalled();
    expect(context.developerSpawnedDungeons.listActive).not.toHaveBeenCalled();
    expect(context.developerSpawnedDungeons.delete).not.toHaveBeenCalled();
  });
});

describe("Developer dungeon entrance command auditing", () => {
  it("records successful spawn, list, and tombstone commands", async () => {
    const context = makeContext(true);

    await createDeveloperHandler(context as never)({
      type: "DEV_SPAWN_DUNGEON_ENTRANCE",
      requestId: "spawn-1",
      templateId: "cistern_warrens_world_entrance",
      lat: 35.1,
      lon: -106.6
    });
    await createDeveloperHandler(context as never)({
      type: "DEV_LIST_DUNGEON_ENTRANCES",
      requestId: "list-1"
    });
    await createDeveloperHandler(context as never)({
      type: "DEV_DELETE_DUNGEON_ENTRANCE",
      requestId: "delete-1",
      entranceId: entrance.entranceId
    });

    expect(context.developerSpawnedDungeons.spawn).toHaveBeenCalledWith(expect.objectContaining({
      creatorPlayerId: "player-1",
      requestId: "spawn-1",
      templateId: "cistern_warrens_world_entrance",
      position: { lat: 35.1, lon: -106.6 }
    }));
    expect(context.developerSpawnedDungeons.listActive).toHaveBeenCalledTimes(1);
    expect(context.developerSpawnedDungeons.delete).toHaveBeenCalledWith(
      "player-1",
      "delete-1",
      entrance.entranceId
    );
    expect(context.recordDeveloperCommandResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        capability: "developer:world-mutate",
        command: "dungeon-entrance.spawn",
        outcome: "succeeded",
        operationKey: "spawn-1"
      })
    );
    expect(context.recordDeveloperCommandResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        capability: "developer:observe",
        command: "dungeon-entrance.list",
        outcome: "succeeded",
        operationKey: "list-1"
      })
    );
    expect(context.recordDeveloperCommandResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        capability: "developer:world-mutate",
        command: "dungeon-entrance.delete",
        outcome: "succeeded",
        operationKey: "delete-1"
      })
    );
  });
});

describe("Developer dungeon run reset", () => {
  it("is refused without the developer capability and never touches the run", async () => {
    const context = makeContext(false);
    await createDeveloperHandler(context as never)({ type: "DEV_RESET_DUNGEON_RUN", requestId: "reset-1" });
    expect(context.authorizeDeveloperCommand).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      capability: "developer:world-mutate", command: "dungeon-run.reset", operationKey: "reset-1"
    }));
    expect(context.sendCombatError).toHaveBeenCalledWith(expect.anything(), "reset-1", "DEVELOPER_COMMAND_FORBIDDEN", "Developer command is unavailable");
    expect(context.dungeon.resetDeveloperRun).not.toHaveBeenCalled();
  });

  it("resets the developer's own run, sends the fresh snapshot and records the result", async () => {
    const context = makeContext(true);
    await createDeveloperHandler(context as never)({ type: "DEV_RESET_DUNGEON_RUN", requestId: "reset-2" });
    expect(context.dungeon.resetDeveloperRun).toHaveBeenCalledWith("player-1");
    expect(context.safeSendServerMessage).toHaveBeenCalledWith(expect.anything(), {
      type: "DUNGEON_SNAPSHOT", requestId: "reset-2", snapshot: { sessionId: "s-1", completed: false }
    });
    expect(context.recordDeveloperCommandResult).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: "dungeon-run.reset", outcome: "succeeded", operationKey: "reset-2"
    }));
  });
});

function makeContext(authorized: boolean) {
  const authorizeDeveloperCommand = vi.fn(async () => {
    if (!authorized) throw new Error("forbidden");
  });
  const recordDeveloperCommandResult = vi.fn(async () => undefined);
  const service = {
    spawn: vi.fn(async () => ({ replayed: false, entrance })),
    listActive: vi.fn(async () => [{ entranceId: entrance.entranceId }]),
    snapshotFor: vi.fn(() => entrance),
    delete: vi.fn(async () => ({ replayed: false, entrance }))
  };
  return {
    state: { playerId: "player-1", connectionId: "connection-1" },
    socket: {},
    authenticatedSession: { player: { id: "player-1" } },
    authorizeDeveloperCommand,
    recordDeveloperCommandResult,
    auth: { authorizeDeveloperCommand, recordDeveloperCommandResult },
    developerSpawnedDungeons: service,
    dungeon: { resetDeveloperRun: vi.fn(async () => ({ sessionId: "s-1", completed: false })) },
    registry: {
      activeConnectionIdForPlayer: vi.fn(() => "connection-1"),
      broadcast: vi.fn()
    },
    gameState: { getPlayer: vi.fn(() => ({ playerId: "player-1" })) },
    playerAuthorityFence: {
      run: vi.fn(async (_playerId: string, operation: () => Promise<unknown>) => operation())
    },
    safeSendServerMessage: vi.fn(() => true),
    sendCombatError: vi.fn(),
    logger: {}
  };
}
