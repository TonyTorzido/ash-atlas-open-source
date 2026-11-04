import type { BackpackSnapshot, ClientMessage } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { BackpackClient, shouldAcceptBackpackSnapshot } from "./backpackClient.js";
import type { ClientCommandPort } from "../clientCommandPort.js";

describe("backpack snapshot acceptance", () => {
  it("accepts only a newer authoritative revision for the active player", () => {
    const current = snapshot("player-1", 4, 47);
    expect(shouldAcceptBackpackSnapshot(current, snapshot("player-1", 5, 55), "player-1"))
      .toBe(true);
    expect(shouldAcceptBackpackSnapshot(current, snapshot("player-1", 4, 40), "player-1"))
      .toBe(false);
    expect(shouldAcceptBackpackSnapshot(current, snapshot("player-1", 3, 40), "player-1"))
      .toBe(false);
    expect(shouldAcceptBackpackSnapshot(current, snapshot("player-2", 6, 55), "player-1"))
      .toBe(false);
  });

  it("retains backpack capacity until the first authoritative snapshot arrives", () => {
    const retained = snapshot("player-1", 4, 47);
    expect(shouldAcceptBackpackSnapshot(retained, snapshot("player-1", 3, 40), "player-1"))
      .toBe(false);
    expect(retained.effectiveSlots).toBe(47);
    expect(shouldAcceptBackpackSnapshot(null, snapshot("player-1", 0, 40), "player-1"))
      .toBe(true);
  });
});

describe("backpack crafting command", () => {
  it("sends only the canonical Crafting request and returns its request ID", () => {
    const sent: ClientMessage[] = [];
    const client = new BackpackClient(portFor(sent));
    expect(client.craft("craft-request-1")).toBe("craft-request-1");
    expect(sent).toEqual([{
      type: "CRAFT_BACKPACK",
      requestId: "craft-request-1"
    }]);
  });
});

function portFor(sent: ClientMessage[]): ClientCommandPort {
  return {
    send(message) {
      sent.push(message);
      return { status: "sent", readiness: "ready", connectionGeneration: 1 };
    }
  };
}

function snapshot(
  playerId: string,
  revision: number,
  effectiveSlots: number
): BackpackSnapshot {
  return {
    playerId,
    revision,
    baseSlots: 40,
    backpackBonusSlots: effectiveSlots - 40,
    effectiveSlots,
    maximumSlots: 100,
    equipped: [null, null, null, null],
    instances: []
  };
}
