import { interiorLocalToLngLat } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { puzzleCenteredSafeRect, puzzleRoomCamera, puzzleSafeRect, type ScreenRect } from "./puzzleCameraFrame.js";

const METERS_PER_UNIT = 0.1;
const project = (camera: { center: { lat: number; lon: number }; zoom: number }, viewport: { width: number; height: number },
  point: { x: number; y: number }) => {
  const perDegree = 512 * 2 ** camera.zoom / 360;
  const lngLat = interiorLocalToLngLat(point, METERS_PER_UNIT);
  return { x: viewport.width / 2 + (lngLat.lon - camera.center.lon) * perDegree, y: viewport.height / 2 - (lngLat.lat - camera.center.lat) * perDegree };
};
const inside = (p: { x: number; y: number }, r: ScreenRect) => p.x >= r.left - 0.5 && p.x <= r.right + 0.5 && p.y >= r.top - 0.5 && p.y <= r.bottom + 0.5;
const overlaps = (a: ScreenRect, b: ScreenRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** HUD obstacles roughly as laid out: card top-centre, tilt pad right, joystick left, bottom bar. */
const hud = (w: number, h: number): ScreenRect[] => [
  { left: w / 2 - 150, top: 64, right: w / 2 + 150, bottom: 160 },
  { left: w - 70 - 150, top: h - 182 - 150, right: w - 70, bottom: h - 182 },
  { left: 20, top: h - 260, right: 160, bottom: h - 120 },
  { left: Math.max(0, w / 2 - 340), top: h - 80, right: Math.min(w, w / 2 + 340), bottom: h - 10 }
];

describe("puzzle room camera framing", () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
    it(`fits the whole room clear of the HUD at ${viewport.width}x${viewport.height}`, () => {
      const room = { roomWidth: 1000, roomHeight: 1300, metersPerUnit: METERS_PER_UNIT };
      const obstacles = hud(viewport.width, viewport.height);
      const safe = puzzleSafeRect(viewport, obstacles, room.roomWidth / room.roomHeight);
      for (const obstacle of obstacles) expect(overlaps(safe, obstacle)).toBe(false);
      expect(safe.right - safe.left).toBeGreaterThan(100);
      expect(safe.bottom - safe.top).toBeGreaterThan(100);
      const camera = puzzleRoomCamera(room, viewport, safe, { minZoom: 5, maxZoom: 22 });
      for (const corner of [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 1300 }, { x: 1000, y: 1300 }]) {
        expect(inside(project(camera, viewport, corner), safe)).toBe(true);
      }
      const middle = project(camera, viewport, { x: 500, y: 650 });
      expect(middle.x).toBeCloseTo((safe.left + safe.right) / 2, 0);
      expect(middle.y).toBeCloseTo((safe.top + safe.bottom) / 2, 0);
    });
  }

  it("cuts a centred card away from the side when that leaves a bigger room (landscape phone)", () => {
    const viewport = { width: 812, height: 375 };
    const safe = puzzleSafeRect(viewport, [{ left: 256, top: 64, right: 556, bottom: 200 }], 1000 / 1300);
    expect(safe.bottom - safe.top).toBeGreaterThan(300);
  });

  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
    it(`keeps the room centred on screen, clear of the HUD, at ${viewport.width}x${viewport.height}`, () => {
      const w = viewport.width;
      const h = viewport.height;
      // A compact chip at the top centre, a portrait card top left, hotbar columns, stick and tilt pad, bottom bar.
      const obstacles: ScreenRect[] = [
        { left: w / 2 - 80, top: 64, right: w / 2 + 80, bottom: 98 },
        { left: 16, top: 12, right: Math.min(w / 2 - 20, 327), bottom: 90 },
        { left: 6, top: h * 0.5, right: 58, bottom: h * 0.85 },
        { left: w - 58, top: h * 0.5, right: w - 6, bottom: h * 0.85 },
        { left: w - 200, top: h - 300, right: w - 90, bottom: h - 190 },
        { left: Math.max(0, w / 2 - 340), top: h - 80, right: Math.min(w, w / 2 + 340), bottom: h - 10 }
      ];
      const aspect = 1080 / 1510;
      const safe = puzzleCenteredSafeRect(viewport, obstacles, aspect);
      for (const obstacle of obstacles) expect(overlaps(safe, obstacle)).toBe(false);
      expect((safe.left + safe.right) / 2).toBeCloseTo(w / 2, 5);
      expect(Math.min((safe.right - safe.left) / aspect, safe.bottom - safe.top)).toBeGreaterThan(150);
    });
  }
});
