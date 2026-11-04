import { describe, expect, it } from "vitest";

import { parseServerMessage } from "./protocol.js";

describe("Creature Book protocol", () => {
  it("parses multiple strict habitat restrictions", () => {
    const frame = creatureBookFrame([
      { groupId: "environment", categoryIds: ["greenwood"], label: "Forest" },
      { groupId: "elevation", categoryIds: ["moderate", "high"], label: "High Country" }
    ]);

    expect(parseServerMessage(JSON.stringify(frame))).toEqual(frame);
  });

  it.each([
    [[{ groupId: "weather", categoryIds: ["greenwood"], label: "Forest" }]],
    [[{ groupId: "environment", categoryIds: ["high"], label: "Forest" }]],
    [[{ groupId: "environment", categoryIds: [], label: "Forest" }]],
    [[{ groupId: "environment", categoryIds: ["greenwood"], label: "" }]],
    [[{ groupId: "environment", categoryIds: ["greenwood"], label: "Forest", extra: true }]],
    [[]],
    [[
      { groupId: "environment", categoryIds: ["greenwood"], label: "Forest" },
      { groupId: "environment", categoryIds: ["plains"], label: "Grassland" }
    ]]
  ])("rejects invalid habitat restrictions %#", (restrictions) => {
    expect(() => parseServerMessage(JSON.stringify(creatureBookFrame(restrictions)))).toThrow();
  });

  it("parses a discovered plant entry with a redacted habitat before its threshold", () => {
    const frame = {
      type: "CREATURE_BOOK_SNAPSHOT",
      snapshot: {
        slots: [],
        plants: [{
          bookOrder: 0,
          unlocked: true,
          plantKey: "flax",
          name: "Wild Flax",
          rarity: "common",
          active: 12,
          totalHarvests: 1,
          habitat: { kind: "natural", progress: 1, threshold: 5, restrictions: null }
        }]
      }
    } as const;

    expect(parseServerMessage(JSON.stringify(frame))).toEqual(frame);
  });
});

function creatureBookFrame(restrictions: readonly unknown[]) {
  return {
    type: "CREATURE_BOOK_SNAPSHOT",
    snapshot: {
      slots: [{
        bookOrder: 0,
        unlocked: true,
        archetypeKey: "deer",
        name: "Deer",
        rarity: "common",
        ashenUnlocked: false,
        habitat: {
          kind: "natural",
          progress: 100,
          threshold: 100,
          restrictions,
          active: "any_time"
        },
        killCount: 100,
        drops: []
      }]
    }
  };
}
