import { describe, expect, it } from "vitest";
import { clampBaseCenter, decideMeasure, floatingRegion, restingBaseCenter, isTapGesture, pointInRect, stickVector, trailOrigin, type FloatingViewport } from "./floatingStick.js";

const portrait: FloatingViewport = { width: 393, height: 852, safeLeft: 0, safeRight: 0, safeBottom: 34, dockHeight: 142, shortLandscape: false };
const landscape: FloatingViewport = { width: 852, height: 393, safeLeft: 59, safeRight: 59, safeBottom: 21, dockHeight: 61, shortLandscape: true, dockSpan: { left: 300, right: 552 } };

describe("floatingRegion", () => {
  it("portrait regions mirror each other, start at the dock top and are 40% x 38%", () => {
    const l = floatingRegion("left", portrait);
    const r = floatingRegion("right", portrait);
    expect(l.left).toBe(0);
    expect(l.right).toBeCloseTo(157.2, 1);
    expect(l.bottom).toBe(852 - 142);
    expect(l.bottom - l.top).toBe(320);
    expect(r.right).toBe(393);
    expect(393 - r.left).toBeCloseTo(l.right - l.left, 5);
    expect(l.right).toBeLessThan(r.left);
  });
  it("clamps the size on huge and tiny screens", () => {
    const big = floatingRegion("left", { ...portrait, width: 1200, height: 1600 });
    expect(big.right - big.left).toBe(230);
    expect(big.bottom - big.top).toBe(320);
    const tiny = floatingRegion("left", { ...portrait, width: 200, height: 300 });
    expect(tiny.right - tiny.left).toBe(150);
    expect(tiny.bottom - tiny.top).toBe(150);
  });
  it("portrait respects the safe edges", () => {
    const l = floatingRegion("left", { ...portrait, safeLeft: 12, safeRight: 12 });
    const r = floatingRegion("right", { ...portrait, safeLeft: 12, safeRight: 12 });
    expect(l.left).toBe(12);
    expect(r.right).toBe(393 - 12);
  });
  it("short landscape owns the corners out to the screen edges, planting stays inside the safe area", () => {
    const l = floatingRegion("left", landscape);
    const r = floatingRegion("right", landscape);
    expect(l.left).toBe(0);
    expect(r.right).toBe(852);
    expect(l.bottom).toBe(393);
    expect(r.bottom).toBe(393);
  });
  it("both controls rest at the exact centre of their zones, in landscape and portrait, never shifted for the safe area", () => {
    for (const vp of [landscape, { ...landscape, width: 932, height: 430 }, portrait, { ...portrait, width: 430, height: 932 }]) {
      for (const side of ["left", "right"] as const) {
        const z = floatingRegion(side, vp);
        const rest = restingBaseCenter(z, 50);
        expect(rest.x).toBeCloseTo((z.left + z.right) / 2, 5);
        expect(rest.y).toBeCloseTo((z.top + z.bottom) / 2, 5);
      }
    }
    const l = floatingRegion("left", { ...landscape, width: 932, height: 430 });
    expect(restingBaseCenter(l, 51).x, "centre of 0-209.7, not pushed in by the 59 px inset").toBeCloseTo(104.85, 1);
  });
  it("portrait zones are exact mirror images: same width, height and bottom", () => {
    for (const vp of [portrait, { ...portrait, width: 430, height: 932 }, { ...portrait, leftRailBottom: 560, rightRailBottom: 575 }]) {
      const l = floatingRegion("left", vp);
      const r = floatingRegion("right", vp);
      expect(r.right - r.left).toBeCloseTo(l.right - l.left, 6);
      expect(r.bottom - r.top).toBeCloseTo(l.bottom - l.top, 6);
      expect(r.bottom).toBe(l.bottom);
      expect(vp.width - r.right).toBeCloseTo(l.left, 6);
    }
  });
  it("short landscape zones are the owner boxes: 932x430 gives x 0-210 / y 292-430 and x 698-932 / y 305-430", () => {
    const vp = { ...landscape, width: 932, height: 430, dockSpan: { left: 283, right: 649 } };
    const l = floatingRegion("left", vp);
    const r = floatingRegion("right", vp);
    expect([l.left, Math.round(l.right), Math.round(l.top), l.bottom]).toEqual([0, 210, 292, 430]);
    expect([Math.round(r.left), r.right, Math.round(r.top), r.bottom]).toEqual([699, 932, 305, 430]);
  });
  it("short landscape zones keep a thumb-usable minimum on a tiny screen", () => {
    const tiny = floatingRegion("left", { ...landscape, width: 560, height: 280 });
    expect(tiny.right - tiny.left).toBeGreaterThanOrEqual(150);
    expect(tiny.bottom - tiny.top).toBeGreaterThanOrEqual(110);
  });
  it("short landscape stops each region at the dock strip", () => {
    const l = floatingRegion("left", landscape);
    const r = floatingRegion("right", landscape);
    expect(l.right).toBeLessThanOrEqual(300 - 4);
    expect(r.left).toBeGreaterThanOrEqual(552 + 4);
  });
});

describe("floatingRegion rail cap", () => {
  it("portrait zones top is the lower of the two lowest slot bottoms, not the viewport fraction", () => {
    const l = floatingRegion("left", { ...portrait, leftRailBottom: 560, rightRailBottom: 575 });
    const r = floatingRegion("right", { ...portrait, leftRailBottom: 560, rightRailBottom: 575 });
    expect(l.top).toBe(575);
    expect(r.top).toBe(575);
    expect(l.bottom).toBe(710);
  });
  it("short landscape ignores the rail cap: the zone is the owner-drawn bottom slice", () => {
    const l = floatingRegion("left", { ...landscape, leftRailBottom: 250 });
    expect(l.top).toBeCloseTo(393 * (1 - 0.32), 5);
    expect(l.bottom).toBe(393);
  });
  it("a tall measured cap can never lift a region above the slot line", () => {
    const l = floatingRegion("left", { ...portrait, leftRailBottom: 100 });
    expect(l.top).toBe(100);
  });
  it("ignores a missing or degenerate rail and keeps the fraction rule", () => {
    expect(floatingRegion("left", portrait).top).toBe(710 - 320);
    expect(floatingRegion("left", { ...portrait, leftRailBottom: 700 }).top).toBe(710 - 320);
    expect(floatingRegion("left", { ...portrait, leftRailBottom: null }).top).toBe(710 - 320);
  });
  it("planted base stays below the cap", () => {
    const region = floatingRegion("left", { ...portrait, leftRailBottom: 560 });
    const c = clampBaseCenter({ x: 50, y: 100 }, 40, region);
    expect(c.y - 40).toBeGreaterThanOrEqual(560);
  });
});

describe("hit test and base clamp", () => {
  const region = { left: 0, top: 400, right: 177, bottom: 710 };
  it("tests points against the region", () => {
    expect(pointInRect({ x: 50, y: 500 }, region)).toBe(true);
    expect(pointInRect({ x: 200, y: 500 }, region)).toBe(false);
    expect(pointInRect({ x: 50, y: 720 }, region)).toBe(false);
  });
  it("keeps the base fully inside the region", () => {
    expect(clampBaseCenter({ x: 5, y: 705 }, 46, region)).toEqual({ x: 46, y: 664 });
    expect(clampBaseCenter({ x: 100, y: 550 }, 46, region)).toEqual({ x: 100, y: 550 });
    expect(clampBaseCenter({ x: 170, y: 402 }, 46, region)).toEqual({ x: 131, y: 446 });
  });
  it("centres in a region smaller than the base", () => {
    expect(clampBaseCenter({ x: 0, y: 0 }, 100, { left: 0, top: 0, right: 100, bottom: 100 })).toEqual({ x: 50, y: 50 });
  });
});

describe("trailing re-centre and stick vector", () => {
  it("leaves the origin while the finger is inside the radius", () => {
    expect(trailOrigin({ x: 100, y: 100 }, { x: 130, y: 100 }, 46)).toEqual({ x: 100, y: 100 });
  });
  it("drags the origin so the finger rests on the rim", () => {
    const o = trailOrigin({ x: 100, y: 100 }, { x: 200, y: 100 }, 46);
    expect(o.x).toBeCloseTo(154, 5);
    expect(o.y).toBe(100);
    const v = stickVector(o, { x: 200, y: 100 }, 46);
    expect(v.dx).toBeCloseTo(46, 5);
    expect(v.dy).toBeCloseTo(0, 5);
  });
  it("a direction change responds at once after trailing", () => {
    const o = trailOrigin({ x: 100, y: 100 }, { x: 300, y: 100 }, 46);
    const v = stickVector(o, { x: o.x, y: 100 + 30 }, 46);
    expect(Math.abs(v.dx)).toBeLessThan(1e-9);
    expect(v.dy).toBe(30);
  });
  it("clamps the vector to the radius", () => {
    const v = stickVector({ x: 0, y: 0 }, { x: 300, y: 400 }, 50);
    expect(Math.hypot(v.dx, v.dy)).toBeCloseTo(50, 5);
  });
});

describe("isTapGesture", () => {
  it("is a tap only inside the dead zone and before the hold time", () => {
    expect(isTapGesture(4, 120, 10, 400)).toBe(true);
    expect(isTapGesture(11, 120, 10, 400)).toBe(false);
    expect(isTapGesture(4, 400, 10, 400)).toBe(false);
  });
});

describe("restingBaseCenter", () => {
  it("rests at the region centre in both orientations", () => {
    for (const vp of [portrait, landscape]) {
      const r = floatingRegion("left", vp);
      expect(restingBaseCenter(r, 46)).toEqual({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
    }
  });
  it("stays fully inside a region shorter than the base", () => {
    expect(restingBaseCenter({ left: 0, top: 600, right: 177, bottom: 640 }, 46)).toEqual({ x: 88.5, y: 620 });
  });
  it("keeps a base inside a region that is only just big enough", () => {
    expect(restingBaseCenter({ left: 10, top: 100, right: 102, bottom: 192 }, 46)).toEqual({ x: 56, y: 146 });
  });
});

describe("decideMeasure", () => {
  const committed = { key: "a", values: [0, 100, 200, 300] };
  const base = { committed, pendingKey: null, restMissing: false, railLost: false };
  it("commits the first measure", () => {
    expect(decideMeasure({ ...base, committed: null, candidate: { key: "a", values: [1] }, restMissing: true })).toBe("commit");
  });
  it("ignores a half-laid-out measure once a good one exists", () => {
    const candidate = { key: "b", values: [0, 400, 200, 300] };
    expect(decideMeasure({ ...base, candidate, restMissing: true })).toBe("ignore");
    expect(decideMeasure({ ...base, candidate, railLost: true })).toBe("ignore");
  });
  it("commits a small shift at once and a big one only when repeated", () => {
    expect(decideMeasure({ ...base, candidate: { key: "b", values: [0, 102, 200, 300] } })).toBe("commit");
    const big = { key: "c", values: [0, 400, 200, 300] };
    expect(decideMeasure({ ...base, candidate: big })).toBe("pending");
    expect(decideMeasure({ ...base, candidate: big, pendingKey: "c" })).toBe("commit");
    expect(decideMeasure({ ...base, candidate: big, pendingKey: "x" })).toBe("pending");
  });
});
