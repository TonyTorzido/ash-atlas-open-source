import { describe, expect, it } from "vitest";

import { cubicEaseInOut } from "./flagTravelCamera.js";
import {
  flagTravelPlayerPositionAt,
  isCurrentFlagTravelPlayerMotion,
  paddedViewportCenter,
  type FlagTravelPlayerMotionPlan
} from "./flagTravelPlayerMotion.js";

function scenario(input: Readonly<{
  width: number;
  height: number;
  origin: Readonly<{ x: number; y: number }>;
}>): FlagTravelPlayerMotionPlan {
  return {
    captureId: 7,
    cameraGeneration: 42,
    originScreen: input.origin,
    destinationScreen: paddedViewportCenter({
      width: input.width,
      height: input.height,
      padding: { top: 0, right: 0, bottom: 0, left: 0 }
    }),
    destination: { lat: 35.1, lon: -106.6 },
    startedAtMs: 1_000,
    durationMs: 210,
    easing: cubicEaseInOut
  };
}

describe("flag travel local-player motion", () => {
  it.each([
    {
      name: "943x798 lower-left origin",
      width: 943,
      height: 798,
      origin: { x: 110, y: 690 }
    },
    {
      name: "520x463 upper-right origin",
      width: 520,
      height: 463,
      origin: { x: 465, y: 70 }
    }
  ])("moves $name along the cubic path without a commit snap", (input) => {
    const plan = scenario(input);
    const positions = [0, 0.25, 0.5, 0.75, 1].map((progress) =>
      flagTravelPlayerPositionAt(
        plan,
        plan.startedAtMs + plan.durationMs * progress
      )
    );

    expect(positions[0]).toEqual(plan.originScreen);
    for (const [index, rawProgress] of [0.25, 0.5, 0.75].entries()) {
      const progress = cubicEaseInOut(rawProgress);
      expect(positions[index + 1]).toEqual({
        x:
          plan.originScreen.x +
          (plan.destinationScreen.x - plan.originScreen.x) * progress,
        y:
          plan.originScreen.y +
          (plan.destinationScreen.y - plan.originScreen.y) * progress
      });
    }
    expect(positions[3]).not.toEqual(plan.originScreen);
    expect(positions[4]).toEqual(plan.destinationScreen);
    expect(Math.hypot(
      positions[4]!.x - plan.destinationScreen.x,
      positions[4]!.y - plan.destinationScreen.y
    )).toBeLessThanOrEqual(1);
  });

  it("uses the actual padded viewport center", () => {
    expect(paddedViewportCenter({
      width: 943,
      height: 798,
      padding: { top: 24, right: 30, bottom: 10, left: 50 }
    })).toEqual({ x: 481.5, y: 406 });
  });

  it("rejects stale and absent camera generations", () => {
    const plan = scenario({
      width: 943,
      height: 798,
      origin: { x: 110, y: 690 }
    });
    expect(isCurrentFlagTravelPlayerMotion(plan, 42)).toBe(true);
    expect(isCurrentFlagTravelPlayerMotion(plan, 41)).toBe(false);
    expect(isCurrentFlagTravelPlayerMotion(plan, null)).toBe(false);
  });
});
