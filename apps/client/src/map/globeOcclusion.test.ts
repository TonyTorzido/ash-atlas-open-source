import { describe, expect, it } from "vitest";

import {
  globeOverlayOpacityForAngularDistance,
  globeOverlayOpacityForMap,
  sphericalAngularDistanceDegrees
} from "./globeOcclusion.js";

describe("globe overlay occlusion", () => {
  it("fades overlay content before the limb and hides it at the horizon", () => {
    expect(globeOverlayOpacityForAngularDistance(79)).toBe(1);
    expect(globeOverlayOpacityForAngularDistance(85)).toBeCloseTo(0.5);
    expect(globeOverlayOpacityForAngularDistance(90)).toBe(0);
    expect(globeOverlayOpacityForAngularDistance(120)).toBe(0);
  });

  it("uses the globe projection while preserving normal map overlays", () => {
    const globeMap = {
      getCenter: () => ({ lat: 0, lng: 0 }),
      getProjection: () => ({ type: "globe" }),
      transform: { isLocationOccluded: () => false }
    } as unknown as Parameters<typeof globeOverlayOpacityForMap>[0];
    const flatMap = {
      getCenter: () => ({ lat: 0, lng: 0 }),
      getProjection: () => ({ type: "mercator" }),
      transform: { isLocationOccluded: () => false }
    } as unknown as Parameters<typeof globeOverlayOpacityForMap>[0];

    expect(globeOverlayOpacityForMap(globeMap, { lat: 0, lon: 90 })).toBe(0);
    expect(globeOverlayOpacityForMap(globeMap, { lat: 0, lon: 80 })).toBe(1);
    expect(globeOverlayOpacityForMap(flatMap, { lat: 0, lon: 180 })).toBe(1);
    const loadingMap = { ...flatMap, getProjection: () => undefined } as unknown as typeof flatMap;
    expect(globeOverlayOpacityForMap(loadingMap, { lat: 0, lon: 180 })).toBe(1);
  });

  it("calculates shortest spherical distance across the date line", () => {
    expect(sphericalAngularDistanceDegrees(0, 179, 0, -179)).toBeCloseTo(2);
  });
});
