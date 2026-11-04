import { describe, expect, it } from "vitest";

import { MOB_ARCHETYPE_KEYS } from "./combat.js";
import { DUNGEON_BOSS_DEFINITIONS, dungeonBossDefinition } from "./dungeonBossDefinitions.js";

describe("dungeon boss definitions", () => {
  it("has unique ids, real archetypes, and never claims overworld boss ids", () => {
    const ids = DUNGEON_BOSS_DEFINITIONS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of DUNGEON_BOSS_DEFINITIONS) {
      expect(MOB_ARCHETYPE_KEYS).toContain(definition.archetypeKey);
      expect(definition.id.startsWith("legendary_")).toBe(false);
    }
    expect(dungeonBossDefinition("dungeon_slime_miniboss")).toMatchObject({ archetypeKey: "slime_miniboss", controllerId: "dungeon" });
    expect(dungeonBossDefinition("dungeon_fire_bird")?.controllerId).toBe("dungeon");
    expect(dungeonBossDefinition("xoral")?.controllerId).toBe("xoral");
  });
});
