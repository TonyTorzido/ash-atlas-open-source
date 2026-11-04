import { describe, expect, it } from "vitest";

import { parseClientMessage, parseServerMessage } from "./protocol.js";

describe("progression client protocol", () => {
  it("accepts only instance, slot, and request identity for equipment", () => {
    const valid = {
      type: "EQUIP_ITEM",
      requestId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      slot: "melee"
    };
    expect(parseClientMessage(JSON.stringify(valid))).toEqual(valid);
    expect(() => parseClientMessage(JSON.stringify({ ...valid, attackPowerBonus: 999 })))
      .toThrow();
    expect(() => parseClientMessage(JSON.stringify({ ...valid, defenseBonus: 999 })))
      .toThrow();
  });

  it("rejects client-authored XP and level fields", () => {
    const request = { type: "REQUEST_PROGRESSION_SNAPSHOT", requestId: crypto.randomUUID() };
    expect(parseClientMessage(JSON.stringify(request))).toEqual(request);
    expect(() => parseClientMessage(JSON.stringify({ ...request, xp: 500_000 }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ ...request, level: 25 }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({
      type: "XP_GRANTED",
      requestId: crypto.randomUUID(),
      xp: 500_000
    }))).toThrow();
  });

  it("accepts an optional authoritative death penalty presentation", () => {
    const frame = {
      type: "PROGRESSION_SNAPSHOT",
      progression: progressionSnapshot(14_364),
      deathPenalty: { operationKey: "player-death:one", xpLost: 906 }
    };
    expect(parseServerMessage(JSON.stringify(frame))).toEqual(frame);
    expect(() => parseServerMessage(JSON.stringify({
      ...frame,
      deathPenalty: { ...frame.deathPenalty, xpLost: -1 }
    }))).toThrow();
  });
});

function progressionSnapshot(totalXp: number) {
  return {
    playerId: "player-1",
    totalXp,
    level: 1,
    curveVersion: 3,
    persistenceVersion: 2,
    xpIntoLevel: 7_170,
    xpForNextLevel: 8_076,
    nextLevelTotalXp: 15_270,
    atCap: false,
    pveStats: {
      maxHealth: 100,
      attackPower: 10,
      defense: 0,
      attackIntervalMs: 1_600,
      attackRangeM: 100
    }
  };
}
