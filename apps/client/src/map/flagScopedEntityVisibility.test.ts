import { describe, expect, it } from "vitest";

import {
  matchesActiveFlagCircle,
  matchesActiveResourceVision
} from "./flagScopedEntityVisibility.js";

describe("flag-scoped entity visibility", () => {
  it("accepts only updates and snapshots owned by the active flag", () => {
    expect(matchesActiveFlagCircle("flag-north", "flag-north")).toBe(true);
    expect(matchesActiveFlagCircle("flag-south", "flag-north")).toBe(false);
    expect(matchesActiveFlagCircle(null, "flag-north")).toBe(false);
  });

  it("accepts shared open-area snapshots without inventing a durable flag", () => {
    const openArea = {
      flagId: "synthetic-area-id",
      flagName: "Open area",
      destinationKind: "area" as const,
      center: { lat: 35.0844, lon: -106.6504 },
      movementLeashRadiusM: 1_250,
      paddingM: 0,
      radiusM: 1_500
    };
    expect(matchesActiveResourceVision(null, openArea)).toBe(true);
    expect(matchesActiveResourceVision("real-flag", openArea)).toBe(false);
    expect(matchesActiveResourceVision("real-flag", {
      ...openArea,
      flagId: "real-flag",
      destinationKind: "flag"
    })).toBe(true);
  });
});
