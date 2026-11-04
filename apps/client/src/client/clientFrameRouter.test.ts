import { SERVER_MESSAGE_VALIDATION_ROUTES, type ServerMessage } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  CLIENT_SERVER_MESSAGE_OWNERSHIP,
  routeClientServerMessage,
  type ClientFrameFamily,
  type ClientFrameHandler,
  type ClientFrameHandlers
} from "./clientFrameRouter.js";

const families = [
  "session",
  "world",
  "flags",
  "settlements",
  "travel",
  "party",
  "manor",
  "dungeon",
  "backpack",
  "harvesting",
  "combatEquipment",
  "social",
  "market",
  "pets",
  "packages",
  "developer",
  "portal"
] as const satisfies readonly ClientFrameFamily[];

function createHandlers(handler: ClientFrameHandler = vi.fn()): ClientFrameHandlers {
  return {
    session: handler,
    world: handler,
    flags: handler,
    settlements: handler,
    travel: handler,
    party: handler,
    manor: handler,
    dungeon: handler,
    backpack: handler,
    harvesting: handler,
    combatEquipment: handler,
    social: handler,
    market: handler,
    pets: handler,
    packages: handler,
    developer: handler,
    portal: handler,
    terminal: vi.fn()
  };
}

describe("client ServerMessage routing", () => {
  it("owns every validated discriminant exactly once", () => {
    const routeTypes = Object.keys(CLIENT_SERVER_MESSAGE_OWNERSHIP).sort();
    const validatedTypes = Object.keys(SERVER_MESSAGE_VALIDATION_ROUTES).sort();
    expect(routeTypes).toEqual(validatedTypes);
    expect(new Set(routeTypes).size).toBe(validatedTypes.length);
    expect(new Set(families).size).toBe(families.length);
  });

  it("dispatches every non-terminal frame once to its primary family", () => {
    for (const [type, family] of Object.entries(CLIENT_SERVER_MESSAGE_OWNERSHIP)) {
      if (type === "SESSION_REPLACED" || type === "AUTH_SESSION_INVALID") continue;
      const handlers = createHandlers();
      const primary = vi.fn();
      handlers[family as ClientFrameFamily] = primary;
      routeClientServerMessage({ type } as ServerMessage, handlers);
      expect(primary, type).toHaveBeenCalledOnce();
      expect(handlers.terminal, type).not.toHaveBeenCalled();
    }
  });

  it("fences terminal frames before feature handlers and observers", () => {
    const feature = vi.fn();
    const handlers = createHandlers(feature);
    const observer = vi.fn();

    routeClientServerMessage(
      { type: "SESSION_REPLACED" } as ServerMessage,
      handlers,
      [observer]
    );
    routeClientServerMessage(
      { type: "AUTH_SESSION_INVALID" } as ServerMessage,
      handlers,
      [observer]
    );

    expect(handlers.terminal).toHaveBeenCalledTimes(2);
    expect(feature).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it("runs explicit observers once in declaration order after the primary handler", () => {
    const order: string[] = [];
    const handlers = createHandlers(() => order.push("primary"));
    routeClientServerMessage(
      { type: "PONG", clientTime: 1, serverTime: 2 },
      handlers,
      [
        () => order.push("observer-one"),
        () => order.push("observer-two")
      ]
    );
    expect(order).toEqual(["primary", "observer-one", "observer-two"]);
  });
});
