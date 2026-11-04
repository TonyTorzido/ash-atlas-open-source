import { describe, expect, it, vi } from "vitest";

import { createDeveloperHandler } from "./developerHandler.js";

const position = { lat: 35.0844, lon: -106.6504 };
const flag = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test Tower",
  lat: position.lat,
  lon: position.lon,
  reinforcementLevel: 3,
  health: 2_400,
  maximumHealth: 2_400,
  developerTestTarget: true
};

describe("Developer military test spawn authority", () => {
  it.each([
    {
      name: "test flag",
      message: {
        type: "DEV_SPAWN_TEST_FLAG" as const,
        requestId: "flag-1",
        targetKind: "tower" as const,
        ...position
      },
      service: "flagService",
      capability: "developer:world-mutate" as const,
      command: "military-test.flag.spawn"
    },
    {
      name: "test unit",
      message: {
        type: "DEV_SPAWN_TEST_UNIT" as const,
        requestId: "unit-1",
        unitType: "bomber" as const,
        ...position
      },
      service: "militaryIndustry",
      capability: "developer:world-mutate" as const,
      command: "military-test.unit.spawn"
    }
  ])("denies $name before invoking its service", async ({ message, service, capability, command }) => {
    const context = makeContext(false);
    await createDeveloperHandler(context as never)(message);

    expect(context.authorizeDeveloperCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        capability,
        command,
        target: "targetKind" in message ? message.targetKind : message.unitType,
        operationKey: message.requestId
      })
    );
    expect(context.sendCombatError).toHaveBeenCalledWith(
      expect.anything(),
      message.requestId,
      "DEVELOPER_COMMAND_FORBIDDEN",
      "Developer command is unavailable"
    );
    if (service === "flagService") {
      expect(context.flagService.createDeveloperTestFlag).not.toHaveBeenCalled();
    } else {
      expect(context.cities.militaryIndustry.spawnDeveloperUnit).not.toHaveBeenCalled();
    }
  });

  it("passes the bounded position and request id through for an allowed flag spawn", async () => {
    const context = makeContext(true);

    await createDeveloperHandler(context as never)({
      type: "DEV_SPAWN_TEST_FLAG",
      requestId: "flag-1",
      targetKind: "tower",
      ...position
    });

    expect(context.flagService.createDeveloperTestFlag).toHaveBeenCalledWith({
      creatorPlayerId: "player-1",
      requestId: "flag-1",
      targetKind: "tower",
      position
    });
    expect(context.safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "DEV_TEST_FLAG_SPAWNED",
        requestId: "flag-1",
        targetKind: "tower",
        replayed: false,
        flag
      })
    );
    expect(context.recordDeveloperCommandResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        command: "military-test.flag.spawn",
        outcome: "succeeded",
        operationKey: "flag-1"
      })
    );
  });

  it("publishes a replayed unit spawn without asking the service to create another unit", async () => {
    const context = makeContext(true);
    context.cities.militaryIndustry.spawnDeveloperUnit.mockResolvedValue({
      replayed: true,
      snapshot: { groups: [], units: [] },
      unitId: "22222222-2222-4222-8222-222222222222",
      groupId: "33333333-3333-4333-8333-333333333333"
    });

    await createDeveloperHandler(context as never)({
      type: "DEV_SPAWN_TEST_UNIT",
      requestId: "unit-1",
      unitType: "bomber",
      ...position
    });

    expect(context.cities.militaryIndustry.spawnDeveloperUnit).toHaveBeenCalledTimes(1);
    expect(context.cities.militaryIndustry.spawnDeveloperUnit).toHaveBeenCalledWith(
      { playerId: "player-1", position },
      "bomber",
      "unit-1"
    );
    expect(context.safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "DEV_TEST_UNIT_SPAWNED",
        requestId: "unit-1",
        unitType: "bomber",
        replayed: true,
        unitId: "22222222-2222-4222-8222-222222222222",
        groupId: "33333333-3333-4333-8333-333333333333"
      })
    );
  });
});

function makeContext(authorized: boolean) {
  const authorizeDeveloperCommand = vi.fn(async () => {
    if (!authorized) throw new Error("forbidden");
  });
  const recordDeveloperCommandResult = vi.fn(async () => undefined);
  const createDeveloperTestFlag = vi.fn(async () => ({ replayed: false, flag }));
  const spawnDeveloperUnit = vi.fn(async () => ({
    replayed: false,
    snapshot: { groups: [], units: [] },
    unitId: "44444444-4444-4444-8444-444444444444",
    groupId: "55555555-5555-4555-8555-555555555555"
  }));
  return {
    state: { playerId: "player-1", connectionId: "connection-1" },
    socket: {},
    authenticatedSession: { player: { id: "player-1" } },
    auth: { authorizeDeveloperCommand, recordDeveloperCommandResult },
    authorizeDeveloperCommand,
    recordDeveloperCommandResult,
    config: { DEV_MOB_MAX_SPAWN_DISTANCE_M: 1000 },
    flagService: { createDeveloperTestFlag },
    cities: { militaryIndustry: { spawnDeveloperUnit } },
    gameState: {
      getPlayer: vi.fn(() => ({ playerId: "player-1", position })),
      playerIdsWhoseGameplayViewCircleContains: vi.fn(() => [])
    },
    registry: {
      activeConnectionIdForPlayer: vi.fn(() => "connection-1"),
      broadcast: vi.fn()
    },
    playerAuthorityFence: {
      run: vi.fn(async (_playerId: string, operation: () => Promise<unknown>) => operation())
    },
    rejectDuringPlayerWorldTransition: vi.fn(() => false),
    safeSendServerMessage: vi.fn(() => true),
    sendCombatError: vi.fn(),
    sendCombatScopeSnapshot: vi.fn(),
    logger: {}
  };
}
