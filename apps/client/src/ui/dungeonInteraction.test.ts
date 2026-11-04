import { describe, expect, it } from "vitest";

import { dungeonObjectActionLabel, dungeonObjectApproachPoint } from "./dungeonInteraction.js";

describe("dungeonObjectApproachPoint", () => {
  it("targets the player-facing side safely inside the interaction radius", () => {
    const target = dungeonObjectApproachPoint(
      { x: 100, y: 100 },
      { x: 300, y: 250, interactionRadius: 80 }
    );
    expect(Math.hypot(target.x - 300, target.y - 250)).toBeCloseTo(60);
    expect(target.x).toBeLessThan(300);
    expect(target.y).toBeLessThan(250);
    expect(target).not.toEqual({ x: 300, y: 250 });
  });

  it("is finite when player and object coordinates coincide", () => {
    expect(dungeonObjectApproachPoint(
      { x: 12, y: 18 },
      { x: 12, y: 18, interactionRadius: 40 }
    )).toEqual({ x: 12, y: 18 });
  });
});

describe("dungeonObjectActionLabel", () => {
  it("prefers the authored label and otherwise derives a verb from the object kind", () => {
    expect(dungeonObjectActionLabel({ kind: "chest", name: "Crypt Chest" })).toBe("Open Crypt Chest");
    expect(dungeonObjectActionLabel({ kind: "switch", name: "Iron Lever" })).toBe("Pull Iron Lever");
    expect(dungeonObjectActionLabel({ kind: "decoration", name: "Urn" })).toBe("Use Urn");
    expect(dungeonObjectActionLabel({ kind: "chest", name: "Crypt Chest", interactionLabel: "Loot Chest" }))
      .toBe("Loot Chest");
  });
});
