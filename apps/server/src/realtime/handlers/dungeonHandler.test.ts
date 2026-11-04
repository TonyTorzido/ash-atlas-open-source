import { describe, expect, it, vi } from "vitest";

import {
  createDungeonHandler,
  type DungeonHandlerContext
} from "./dungeonHandler.js";

describe("Cistern Warrens realtime portal authority", () => {
  it.each([
    {
      message: {
        type: "ENTER_CISTERN_WARRENS" as const,
        requestId: "enter-request",
        sewerId: "sewer-1"
      },
      requestId: "enter-request"
    },
    {
      message: {
        type: "EXIT_CISTERN_WARRENS" as const,
        requestId: "exit-request",
        sessionId: "session-1"
      },
      requestId: "exit-request"
    }
  ])("rejects legacy $message.type transition requests", async ({ message, requestId }) => {
    const send = vi.fn();
    const handler = createDungeonHandler({
      state: { playerId: "player-1", connectionId: "connection-1" },
      authenticatedSession: null,
      registry: { send },
      gameState: {},
      dungeon: {}
    } as unknown as DungeonHandlerContext);

    await handler(message);

    expect(send).toHaveBeenCalledWith("player-1", expect.objectContaining({
      type: "DUNGEON_ERROR",
      requestId,
      code: "USE_PORTAL_REQUIRED"
    }));
  });
});
