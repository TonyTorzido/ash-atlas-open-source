import { describe, expect, it } from "vitest";

import monastery from "./data/interiors/still_hand_monastery.json" with { type: "json" };
import { STILL_HAND_MONASTERY_DUNGEON_ID, STILL_HAND_MONASTERY_ROOM_IDS, isStillHandMonasteryZone } from "./stillHandMonastery.js";

describe("Monastery of the Still Hand", () => {
  it("lists exactly the dungeon's rooms", () => {
    expect(monastery.id).toBe(STILL_HAND_MONASTERY_DUNGEON_ID);
    expect([...STILL_HAND_MONASTERY_ROOM_IDS].sort()).toEqual(monastery.rooms.map((room) => room.id).sort());
  });

  it("recognises Monastery combat zones only", () => {
    expect(isStillHandMonasteryZone("interior:abc-123:grandmaster_sanctum")).toBe(true);
    expect(isStillHandMonasteryZone("interior:abc-123:heartwood")).toBe(false);
    expect(isStillHandMonasteryZone("bell_hall")).toBe(false);
    expect(isStillHandMonasteryZone(null)).toBe(false);
  });

  it("gates entry at level 22 with the torch cost and a 6-day lockout", () => {
    expect(monastery.modules.access).toEqual({
      entryCost: [{ itemId: "refined_oil", quantity: 18 }, { itemId: "wood", quantity: 1 }],
      lockoutDays: 6,
      minimumLevel: 22
    });
  });
});
