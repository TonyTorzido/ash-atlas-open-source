import { describe, expect, it } from "vitest";

import { MOB_SPAWN_FADE_MS, mobSpawnAlpha } from "./mobSpawnVisibility.js";

describe("mob spawn visibility", () => {
  it("smoothly fades from transparent to opaque over 600ms", () => {
    expect(mobSpawnAlpha(1_000, 1_000, false)).toBe(0);
    expect(mobSpawnAlpha(1_000, 1_000 + MOB_SPAWN_FADE_MS / 2, false))
      .toBeCloseTo(0.5);
    expect(mobSpawnAlpha(1_000, 1_000 + MOB_SPAWN_FADE_MS, false)).toBe(1);
  });

  it("is immediately opaque for reduced motion", () => {
    expect(mobSpawnAlpha(1_000, 1_000, true)).toBe(1);
  });
});
