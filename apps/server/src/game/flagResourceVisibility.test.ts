import type { ResourceVision } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { isPreparedFlagVisionActive } from "./flagResourceVisibility.js";

describe("prepared flag resource visibility", () => {
  it("withholds prepared resources until that flag is the active visited vision", () => {
    const prepared = vision("new-flag");

    expect(isPreparedFlagVisionActive(null, prepared)).toBe(false);
    expect(isPreparedFlagVisionActive(vision("previous-flag"), prepared)).toBe(false);
    expect(isPreparedFlagVisionActive(vision("new-flag"), prepared)).toBe(true);
  });
});

function vision(flagId: string): ResourceVision {
  return {
    flagId,
    flagName: flagId,
    center: { lat: 35, lon: -106 },
    movementLeashRadiusM: 1_250,
    paddingM: 250,
    radiusM: 1_500
  };
}
