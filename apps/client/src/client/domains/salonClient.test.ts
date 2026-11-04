import type { ClientMessage } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import type { ClientCommandPort } from "../clientCommandPort.js";
import { SalonClient } from "./salonClient.js";

describe("SalonClient", () => {
  it("owns Salon movement and editor command payloads", () => {
    const messages: ClientMessage[] = [];
    const port: ClientCommandPort = {
      send: vi.fn((message) => {
        messages.push(message);
        return { status: "sent", readiness: "ready", connectionGeneration: 1 } as const;
      })
    };
    const client = new SalonClient(port);

    expect(client.moveTo("salon-1", 4, 5)).not.toBeNull();
    expect(client.beginCustomize("salon-1", 7)).not.toBeNull();
    expect(client.saveAppearance({
      editorSessionId: "editor-1",
      expectedAppearanceRevision: 3,
      catalogRevision: 11,
      changes: { hair: "hair-short" }
    })).not.toBeNull();
    expect(client.cancelCustomize("editor-1")).not.toBeNull();

    expect(messages.map((message) => message.type)).toEqual([
      "SALON_MOVE_TO",
      "BEGIN_SALON_CUSTOMIZE",
      "SAVE_SALON_APPEARANCE",
      "CANCEL_SALON_CUSTOMIZE"
    ]);
  });
});
