import { parseClientMessage } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  createConnectionMessageAdmission,
  isManorRateLimitedMessage,
  isWorldOnlyWhileInDungeon
} from "./connectionMessageAdmission.js";
import type { SocketLike } from "./connectionRegistry.js";
import type { MarketHandler } from "./handlers/marketHandler.js";

describe("Manor request admission", () => {
  it.each([
    "OPEN_MANOR_STORAGE",
    "OPEN_FURNACE",
    "OPEN_JEWEL_STATION",
    "PREPARE_JEWEL_EQUIPMENT",
    "IMBUE_JEWEL_EQUIPMENT"
  ])("rate limits %s", (type) => {
    expect(isManorRateLimitedMessage(type)).toBe(true);
  });

  it.each([
    [
      "OPEN_JEWEL_STATION",
      { manorSessionId: "00000000-0000-4000-8000-000000000001", movementSequence: 0 },
      "JEWEL_STATION_ERROR"
    ],
    [
      "OPEN_FURNACE",
      { furnaceId: "00000000-0000-4000-8000-000000000002" },
      "FURNACE_ERROR"
    ],
    [
      "OPEN_MANOR_STORAGE",
      { manorSessionId: "00000000-0000-4000-8000-000000000003" },
      "MANOR_ERROR"
    ]
  ])("rejects an excessive %s request with its domain error", (type, fields, errorType) => {
    const sent: unknown[] = [];
    const socket: SocketLike = {
      readyState: 1,
      send: (data) => sent.push(JSON.parse(data)),
      close: () => undefined
    };
    const admission = createConnectionMessageAdmission({
      state: { playerId: "player-1" },
      socket,
      marketHandler: { admit: () => true } as unknown as MarketHandler
    });
    const message = parseClientMessage(JSON.stringify({
      type,
      requestId: "rate-limited-request",
      ...fields
    }));

    for (let index = 0; index < 80; index += 1) {
      expect(admission.admitBeforeTouch(message)).toBe(true);
    }
    expect(admission.admitBeforeTouch(message)).toBe(false);
    expect(sent).toEqual([{
      type: errorType,
      requestId: "rate-limited-request",
      code: "RATE_LIMITED",
      message: "Too many manor requests; slow down briefly."
    }]);
  });
});

describe("Cistern Warrens message admission", () => {
  it.each([
    "MOVE_TO",
    "PLACE_FLAG",
    "BUILD_CITY_FACILITY",
    "START_HARVEST",
    "DROP_ITEM",
    "MARKET_OPEN",
    "TRAVEL_TO_PARTY_LEADER"
  ])("blocks world action %s", (type) => {
    expect(isWorldOnlyWhileInDungeon(type)).toBe(true);
  });

  it.each([
    "DUNGEON_MOVE_TO",
    "DUNGEON_INTERACT",
    "EXIT_CISTERN_WARRENS",
    "START_ATTACK",
    "CANCEL_ATTACK",
    "USE_NORMAL_ABILITY",
    "MOVE_INVENTORY_STACK",
    "CHAT_SEND"
  ])("allows dungeon or normal HUD action %s", (type) => {
    expect(isWorldOnlyWhileInDungeon(type)).toBe(false);
  });

  it.each([
    ["dungeon-resource:crypt_ore_1", true],
    ["00000000-0000-4000-8000-000000000009", false]
  ])("inside a dungeon admits START_HARVEST for %s: %s", (nodeId, admitted) => {
    const sent: unknown[] = [];
    const admission = createConnectionMessageAdmission({
      state: { playerId: "player-1" },
      socket: { readyState: 1, send: (data) => sent.push(JSON.parse(data)), close: () => undefined },
      marketHandler: { admit: () => true } as unknown as MarketHandler,
      dungeon: {
        isInside: () => true,
        snapshotForPlayer: () => ({ name: "Ashen Crypt" })
      } as never
    });
    const message = parseClientMessage(JSON.stringify({
      type: "START_HARVEST",
      requestId: "harvest-request",
      nodeId,
      expectedPresentationOwner: "repeatable-resource",
      expectedEntityRevision: 0,
      expectedRelocationRevision: 0,
      expectedResourceVisionRevision: 0,
      expectedGameplayViewGeneration: 0
    }));
    expect(admission.admitAfterTouch(message)).toBe(admitted);
    expect(sent.length).toBe(admitted ? 0 : 1);
  });
});

describe("SWING admission (overworld and dungeon runs; never a manor interior)", () => {
  const swingMessage = () => parseClientMessage(JSON.stringify({
    type: "SWING",
    requestId: "swing-request",
    seq: 1,
    dirX: 1,
    dirY: 0,
    lagMs: 50
  }));

  it("admits SWING inside a dungeon run", () => {
    const admission = createConnectionMessageAdmission({
      state: { playerId: "player-1" },
      socket: { readyState: 1, send: () => undefined, close: () => undefined },
      marketHandler: { admit: () => true } as unknown as MarketHandler,
      dungeon: { isInside: () => true, snapshotForPlayer: () => ({ name: "Ashen Crypt" }) }
    } as never);
    expect(admission.admitAfterTouch(swingMessage())).toBe(true);
  });

  it.each([
    ["inside a manor interior", { manorRuntime: { isInside: () => true } }, "MANOR_ERROR"]
  ])("rejects SWING %s", (_label, context, errorType) => {
    const sent: Array<{ type: string; requestId?: string }> = [];
    const admission = createConnectionMessageAdmission({
      state: { playerId: "player-1" },
      socket: { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)), close: () => undefined },
      marketHandler: { admit: () => true } as unknown as MarketHandler,
      ...context
    } as never);

    expect(admission.admitAfterTouch(swingMessage())).toBe(false);
    expect(sent).toEqual([expect.objectContaining({ type: errorType, requestId: "swing-request" })]);
  });

  it("admits SWING on the overworld", () => {
    const admission = createConnectionMessageAdmission({
      state: { playerId: "player-1" },
      socket: { readyState: 1, send: () => undefined, close: () => undefined },
      marketHandler: { admit: () => true } as unknown as MarketHandler,
      dungeon: { isInside: () => false } as never,
      manorRuntime: { isInside: () => false } as never
    });

    expect(admission.admitAfterTouch(swingMessage())).toBe(true);
  });
});
