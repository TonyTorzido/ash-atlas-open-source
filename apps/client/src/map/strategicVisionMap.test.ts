import { distanceMeters } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => ({ default: {} }));

import { strategicBoundaryRing } from "./strategicVisionMap.js";

describe("strategic vision boundary", () => {
  it("keeps a ring crossing the antimeridian continuous around its center", () => {
    const center = { lat: -17.8, lon: 179.99 };
    const ring = strategicBoundaryRing(center, 5_000);
    const longitudes = ring.map(([lon]) => lon!);
    expect(Math.max(...longitudes) - Math.min(...longitudes)).toBeLessThan(0.2);
    expect(Math.max(...longitudes)).toBeGreaterThan(180);
    for (const [lon, lat] of ring) {
      expect(distanceMeters(center, { lat: lat!, lon: lon! })).toBeCloseTo(5_000, 0);
    }
  });
});
