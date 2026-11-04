import { DEFAULT_PLAYER_SPEED_MPS } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  createPlayerWalkMotionState,
  observePlayerWalkMotion
} from "./playerWalkMotion.js";

const DEGREES_PER_METER = 1 / 111_320;

describe("player walk motion detection", () => {
  it("walks at normal speed, holds briefly, then stops", () => {
    const state = createPlayerWalkMotionState();
    let lat = 10;
    let now = 1000;
    expect(observePlayerWalkMotion(state, lat, 20, now)).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      now += 16;
      lat += DEFAULT_PLAYER_SPEED_MPS * 0.016 * DEGREES_PER_METER;
      expect(observePlayerWalkMotion(state, lat, 20, now)).toBe(true);
    }
    now += 100;
    expect(observePlayerWalkMotion(state, lat, 20, now)).toBe(true);
    now += 100;
    expect(observePlayerWalkMotion(state, lat, 20, now)).toBe(false);
  });

  it("ignores tiny corrections and teleports", () => {
    const state = createPlayerWalkMotionState();
    let now = 0;
    observePlayerWalkMotion(state, 10, 20, now);
    for (let i = 0; i < 20; i += 1) {
      now += 16;
      expect(observePlayerWalkMotion(
        state,
        10 + (i % 2) * 0.05 * DEGREES_PER_METER,
        20,
        now
      )).toBe(false);
    }
    now += 16;
    expect(observePlayerWalkMotion(state, 10.5, 20, now)).toBe(false);
  });
});
