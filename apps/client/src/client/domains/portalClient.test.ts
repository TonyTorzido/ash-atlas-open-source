import type { ClientMessage } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import type { ClientCommandPort } from "../clientCommandPort.js";
import { PortalClient } from "./portalClient.js";

describe("PortalClient cancellation", () => {
  it("cancels a transition whose plan arrives after manual movement", () => {
    const messages: ClientMessage[] = [];
    const port: ClientCommandPort = {
      send: vi.fn((message: ClientMessage) => {
        messages.push(message);
        return {
          status: "sent" as const,
          readiness: "ready" as const,
          connectionGeneration: 1
        };
      })
    };
    const client = new PortalClient(port);

    const requestId = client.use("city-salon:salon-1:world-to-main", "4");
    expect(requestId).not.toBeNull();
    expect(client.cancel()).toBe(true);
    client.notePlan(requestId!, "transition-1");

    expect(messages.map((message) => message.type)).toEqual([
      "USE_PORTAL",
      "CANCEL_PORTAL_TRANSITION"
    ]);
    expect(messages[1]).toMatchObject({ transitionId: "transition-1" });
  });

  it("preserves an explicit immediate approach request for universal exits", () => {
    const messages: ClientMessage[] = [];
    const port: ClientCommandPort = {
      send: vi.fn((message: ClientMessage) => {
        messages.push(message);
        return {
          status: "sent" as const,
          readiness: "ready" as const,
          connectionGeneration: 1
        };
      })
    };
    const client = new PortalClient(port);

    expect(client.use("manor:manor-a:main-to-world", undefined, { approach: "immediate" }))
      .not.toBeNull();
    expect(messages[0]).toMatchObject({
      type: "USE_PORTAL",
      portalId: "manor:manor-a:main-to-world",
      approach: "immediate"
    });
  });
});
