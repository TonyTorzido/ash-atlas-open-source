import { describe, expect, it, vi } from "vitest";

import type { SalonRuntime, SalonService } from "../../game/salon.js";
import type { GameState } from "../../game/state.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import { createManorHandler, type ManorHandlerContext } from "./manorHandler.js";
import { createSalonHandler } from "./salonHandler.js";

describe("legacy interior transition frames", () => {
  for (const type of ["ENTER_MANOR", "EXIT_MANOR"] as const) {
    it(`rejects external ${type} without invoking a projection`, async () => {
      const sendManorError = vi.fn();
      const handler = createManorHandler({
        state: { playerId: "player-1", connectionId: "connection-1" },
        socket: { send: vi.fn() } as unknown as SocketLike,
        sendManorError
      } as unknown as ManorHandlerContext);

      if (type === "ENTER_MANOR") {
        await handler({
          type,
          requestId: "request-1",
          manorId: "00000000-0000-4000-8000-000000000001"
        });
      } else {
        await handler({
          type,
          requestId: "request-1",
          manorSessionId: "00000000-0000-4000-8000-000000000002"
        });
      }

      expect(sendManorError).toHaveBeenCalledWith(
        expect.anything(),
        "request-1",
        expect.objectContaining({ code: "USE_PORTAL_REQUIRED" })
      );
    });
  }

  for (const type of ["ENTER_SALON", "EXIT_SALON"] as const) {
    it(`rejects external ${type} without invoking Salon state`, async () => {
      const sent: Array<{ type: string; code?: string }> = [];
      const salon = { enter: vi.fn(), exit: vi.fn() } as unknown as SalonService;
      const salonRuntime = { get: vi.fn() } as unknown as SalonRuntime;
      const handler = createSalonHandler({
        state: { playerId: "player-1" },
        socket: { send: vi.fn() } as unknown as SocketLike,
        registry: {
          send: vi.fn((_playerId: string, message: { type: string; code?: string }) => {
            sent.push(message);
          })
        } as unknown as ConnectionRegistry,
        gameState: {} as GameState,
        salon,
        salonRuntime
      });

      if (type === "ENTER_SALON") {
        await handler({
          type,
          requestId: "request-1",
          structureId: "00000000-0000-4000-8000-000000000003",
          expectedPlacementRevision: "7"
        });
      } else {
        await handler({
          type,
          requestId: "request-1",
          salonSessionId: "00000000-0000-4000-8000-000000000004"
        });
      }

      expect(sent).toContainEqual(expect.objectContaining({
        type: "SALON_ERROR",
        code: "USE_PORTAL_REQUIRED"
      }));
      expect(salon.enter).not.toHaveBeenCalled();
      expect(salon.exit).not.toHaveBeenCalled();
    });
  }
});
