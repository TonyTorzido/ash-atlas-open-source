import { describe, expect, it, vi } from "vitest";

import { createDeveloperHandler } from "./developerHandler.js";

describe("Developer capital founding authorization", () => {
  it.each([
    { authorized: false, expectedCalls: 0 },
    { authorized: true, expectedCalls: 1 }
  ])("requires developer:world-mutate before planning (authorized=$authorized)", async ({
    authorized,
    expectedCalls
  }) => {
    const authorizeDeveloperCommand = vi.fn(async () => {
      if (!authorized) throw new Error("forbidden");
    });
    const recordDeveloperCommandResult = vi.fn(async () => undefined);
    const plan = { cityName: "Albuquerque", placedFlags: [], skippedFlags: [] };
    const foundDeveloperCapital = vi.fn(async () => ({
      dryRun: true,
      replayed: false,
      plan,
      city: null,
      territoryFlagIds: [],
      structures: [],
      membership: null,
      leftHouse: null
    }));
    const safeSendServerMessage = vi.fn(() => true);
    const sendCombatError = vi.fn();
    const handler = createDeveloperHandler({
      state: { playerId: "player-1", connectionId: "connection-1" },
      socket: {},
      authenticatedSession: { player: { id: "player-1" } },
      auth: { authorizeDeveloperCommand, recordDeveloperCommandResult },
      cities: { foundDeveloperCapital },
      gameState: { getPlayer: () => ({ playerId: "player-1" }) },
      registry: { broadcast: vi.fn() },
      safeSendServerMessage,
      sendCombatError,
      logger: { warn: vi.fn() }
    } as never);

    await handler({
      type: "DEV_FOUND_CAPITAL",
      requestId: "capital-plan-1",
      dryRun: true,
      leaveCurrentCity: false
    });

    expect(authorizeDeveloperCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        capability: "developer:world-mutate",
        command: "capital.found.plan",
        operationKey: "capital-plan-1"
      })
    );
    expect(foundDeveloperCapital).toHaveBeenCalledTimes(expectedCalls);
    if (authorized) {
      expect(sendCombatError).not.toHaveBeenCalled();
      expect(safeSendServerMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: "DEV_CAPITAL_FOUNDING_RESULT",
          requestId: "capital-plan-1",
          dryRun: true,
          plan
        })
      );
    } else {
      expect(sendCombatError).toHaveBeenCalledWith(
        expect.anything(),
        "capital-plan-1",
        "DEVELOPER_COMMAND_FORBIDDEN",
        "Developer command is unavailable"
      );
      expect(safeSendServerMessage).not.toHaveBeenCalled();
    }
  });
});
