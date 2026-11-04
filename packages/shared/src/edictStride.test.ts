import { describe, expect, it } from "vitest";

import { DUNGEON_SKILL_TURN_INS, EDICT_STRIDE, edictStrideDamage } from "./dungeonSkills.js";

describe("Edict Stride numbers", () => {
  it("deals 4 / 4-9 / 9 per 100 m with 135 / 100 / 70 second cooldowns", () => {
    expect(edictStrideDamage(1, 100, 0.9)).toBe(4);
    expect(edictStrideDamage(2, 100, 0)).toBe(4);
    expect(edictStrideDamage(2, 100, 0.5)).toBe(6.5);
    expect(edictStrideDamage(2, 100, 1)).toBe(9);
    expect(edictStrideDamage(3, 50, 0)).toBe(4.5);
    expect(edictStrideDamage(0, 100, 1)).toBe(0);
    expect(EDICT_STRIDE.cooldownMs.slice(1)).toEqual([135_000, 100_000, 70_000]);
    expect(EDICT_STRIDE.sealCost).toBe(2);
  });

  it("unlocks with 440 Edict Seals in the Fallen Prison", () => {
    expect(DUNGEON_SKILL_TURN_INS.edict_stride).toMatchObject({ dungeonId: "fallen_prison", tokenItemId: "edict_seal", tokenCost: 440 });
  });
});
