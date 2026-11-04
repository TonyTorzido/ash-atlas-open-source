import { describe, expect, it } from "vitest";

import { globeCameraPosition, isSurfacePointOnNearSide } from "./globeMarkerOcclusion.js";

const view = (lng: number, lat: number, pitch = 0, bearing = 0) =>
  globeCameraPosition({ lng, lat }, bearing, pitch, 3);

describe("globe marker occlusion", () => {
  it("shows the centre and hides the antipode", () => {
    expect(isSurfacePointOnNearSide(view(-106, 35), -106, 35)).toBe(true);
    expect(isSurfacePointOnNearSide(view(-106, 35), 74, -35)).toBe(false);
  });

  it("hides points across the antimeridian and on the opposite pole", () => {
    expect(isSurfacePointOnNearSide(view(179, 0), -179, 0)).toBe(true);
    expect(isSurfacePointOnNearSide(view(0, 0), 180, 0)).toBe(false);
    expect(isSurfacePointOnNearSide(view(0, -85), 0, 85)).toBe(false);
    expect(isSurfacePointOnNearSide(view(0, -85), 120, -80)).toBe(true);
    expect(isSurfacePointOnNearSide(view(30, 88), -150, -60)).toBe(false);
  });

  it("hides beyond-horizon points even on the near hemisphere and accounts for pitch", () => {
    expect(isSurfacePointOnNearSide(view(0, 0), 80, 0)).toBe(false);
    expect(isSurfacePointOnNearSide(view(0, 0), 60, 0)).toBe(true);
    expect(isSurfacePointOnNearSide(view(0, 0, 60, 0), 0, 70)).toBe(false);
    expect(isSurfacePointOnNearSide(view(0, 0, 60, 0), 0, -40)).toBe(true);
  });
});
