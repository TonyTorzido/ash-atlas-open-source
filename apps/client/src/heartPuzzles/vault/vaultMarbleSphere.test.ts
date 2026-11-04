import { describe, expect, it } from "vitest";

import { buildMarbleSurface, MARBLE_SPHERE_INNER, renderMarbleSphere, rollMarble, type MarbleOrientation } from "./vaultMarbleSphere.js";

const IDENTITY: MarbleOrientation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const PX = 72;

/** A grey painted ball (radius 40 on an 100 px canvas) with one red spot at its centre. */
const spotSurface = () => {
  const w = 100;
  const rgba = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const k = (y * w + x) * 4;
      const spot = Math.hypot(x - 50, y - 50) < 5;
      rgba[k] = spot ? 230 : 160; rgba[k + 1] = spot ? 20 : 160; rgba[k + 2] = spot ? 20 : 160; rgba[k + 3] = 255;
    }
  }
  return buildMarbleSurface(rgba, w, w, 40, 64);
};

/** Centroid (pixels) of the red pixels in a rendered frame, or null when the spot is on the far side. */
const redCentroid = (orient: MarbleOrientation, surface: ReturnType<typeof spotSurface>) => {
  const out = new Uint8ClampedArray(PX * PX * 4);
  renderMarbleSphere(out, PX, orient, surface);
  let n = 0, sx = 0, sy = 0;
  for (let j = 0; j < PX; j += 1) {
    for (let i = 0; i < PX; i += 1) {
      const k = (j * PX + i) * 4;
      if (out[k + 3] === 255 && out[k]! > out[k + 1]! * 2 && out[k]! > 60) { n += 1; sx += i; sy += j; }
    }
  }
  return n === 0 ? null : { x: sx / n, y: sy / n, n };
};

describe("marble sphere roll", () => {
  const surface = spotSurface();
  const radius = 20; // board pixels; the sphere's inner disc spans PX * inner pixels for 2 * radius board pixels
  // The equal-area map shows the centre of the painting at sqrt(2) scale; the motion itself is unchanged.
  const pxPerBoard = (PX * MARBLE_SPHERE_INNER) / (2 * radius);

  it("moves the surface with the direction of travel by the distance rolled", () => {
    const start = redCentroid(IDENTITY, surface)!;
    expect(Math.abs(start.x - PX / 2)).toBeLessThan(1.5);
    for (const [dx, dy] of [[4, 0], [-4, 0], [0, 4], [0, -4], [3, 3]] as const) {
      const moved = redCentroid(rollMarble(IDENTITY, dx, dy, radius), surface)!;
      // At the centre of the ball the surface keeps pace with the ball: shift = distance (small angles).
      expect(moved.x - start.x).toBeCloseTo(dx * pxPerBoard, 0);
      expect(moved.y - start.y).toBeCloseTo(dy * pxPerBoard, 0);
    }
  });

  it("accumulates consistently: many small steps equal one step, and a full circumference comes back round", () => {
    let small = IDENTITY;
    for (let i = 0; i < 10; i += 1) small = rollMarble(small, 0.6, 0, radius);
    const once = rollMarble(IDENTITY, 6, 0, radius);
    for (let i = 0; i < 9; i += 1) expect(small[i]!).toBeCloseTo(once[i]!, 6);
    let full = IDENTITY;
    for (let i = 0; i < 100; i += 1) full = rollMarble(full, (2 * Math.PI * radius) / 100, 0, radius);
    for (let i = 0; i < 9; i += 1) expect(full[i]!).toBeCloseTo(IDENTITY[i]!, 6);
    // Half way round the spot is on the far side... and the far side shows the same map (no seam).
    const half = rollMarble(IDENTITY, Math.PI * radius, 0, radius);
    expect(redCentroid(half, surface)).not.toBeNull();
  });

  it("keeps the outline ring and the light fixed while the surface turns", () => {
    const a = new Uint8ClampedArray(PX * PX * 4);
    const b = new Uint8ClampedArray(PX * PX * 4);
    renderMarbleSphere(a, PX, IDENTITY, surface);
    renderMarbleSphere(b, PX, rollMarble(IDENTITY, 13, -7, radius), surface);
    const ring = ((PX / 2) * PX + 1) * 4; // left edge, middle row: outline
    expect([a[ring], a[ring + 1], a[ring + 2]]).toEqual([b[ring], b[ring + 1], b[ring + 2]]);
    // A plain grey patch is brighter toward the upper-left light than toward the lower right, in both frames.
    const lum = (img: Uint8ClampedArray, i: number, j: number) => img[(j * PX + i) * 4]!;
    expect(lum(a, 22, 22)).toBeGreaterThan(lum(a, 50, 50));
    expect(lum(b, 22, 22)).toBeGreaterThan(lum(b, 50, 50));
  });
});
