import { describe, expect, it } from "vitest";

import {
  fishingCatchPercentileFromSize,
  fishingCatchSpecies,
  isFishableCanonicalSurface
} from "./fishing.js";

describe("fishing catch provenance", () => {
  it("keeps species labels aligned with the authoritative water type", () => {
    expect(fishingCatchSpecies("lake")).toBe("freshwater_fish");
    expect(fishingCatchSpecies("river")).toBe("freshwater_fish");
    expect(fishingCatchSpecies("ocean")).toBe("ocean_fish");
    expect(fishingCatchSpecies("ocean", "ashen_fish")).toBe("ocean_fish");
    expect(fishingCatchSpecies("ocean", " squid ")).toBe("squid");
  });

  it("keeps the same-species percentile deterministic and monotonic at boundaries", () => {
    const smaller = fishingCatchPercentileFromSize(23.5);
    const larger = fishingCatchPercentileFromSize(23.6);

    expect(smaller).toBeCloseTo(0.62, 10);
    expect(larger).toBeGreaterThan(smaller);
    expect(larger).toBeGreaterThan(0);
    expect(fishingCatchPercentileFromSize(8)).toBe(0);
    expect(fishingCatchPercentileFromSize(33)).toBe(1);
  });
});

describe("fishing canonical surface admission", () => {
  it("requires the authoritative surface and matching freshwater class", () => {
    const river = {
      surfaceKind: "water" as const,
      isLand: false,
      isSaltwater: false,
      waterKind: "river" as const,
      riverSurface: { isRiver: true, waterKind: "river" as const },
      lakeSurface: null,
      oceanCoastSurface: null
    };
    expect(isFishableCanonicalSurface(river, "river")).toBe(true);
    expect(isFishableCanonicalSurface(river, "lake")).toBe(false);
    expect(isFishableCanonicalSurface({ ...river, surfaceKind: "land", isLand: true }, "river")).toBe(false);
    expect(isFishableCanonicalSurface({ ...river, waterKind: "lake" }, "river")).toBe(false);
    expect(isFishableCanonicalSurface({ ...river, riverSurface: null }, "river")).toBe(false);
  });

  it("accepts coastal and deep ocean cells only with the ocean authority", () => {
    const ocean = {
      surfaceKind: "water" as const,
      isLand: false,
      isSaltwater: true,
      waterKind: "ocean" as const,
      riverSurface: null,
      lakeSurface: null,
      oceanCoastSurface: { isOceanCoast: true, waterKind: "ocean" as const }
    };
    expect(isFishableCanonicalSurface(ocean, "ocean")).toBe(true);
    expect(isFishableCanonicalSurface({ ...ocean, oceanCoastSurface: { isOceanCoast: false, waterKind: null } }, "ocean")).toBe(true);
    expect(isFishableCanonicalSurface({ ...ocean, oceanCoastSurface: null }, "ocean")).toBe(false);
    expect(isFishableCanonicalSurface({ ...ocean, isSaltwater: false }, "ocean")).toBe(false);
  });
});
