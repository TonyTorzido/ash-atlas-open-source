/**
 * Floating twin sticks: pure geometry. Each thumb has a big activation region in its bottom corner. A touch inside
 * it plants the stick base on that point (clamped to stay fully inside the region), the base trails a finger that
 * drags past its radius, and a tap is a touch that never moved past the dead zone and was not held. The DOM layer
 * (JoystickMovement) only measures the screen and feeds these functions.
 */

export type Point = Readonly<{ x: number; y: number }>;
export type Rect = Readonly<{ left: number; top: number; right: number; bottom: number }>;
export type StickSide = "left" | "right";

/** Region size: a fraction of the viewport, clamped so a tablet or a tiny phone stays sensible (CSS px). */
export const FLOATING_REGION = {
  /** Movement thumb: the lower-left corner only (portrait ~40 % of the width, landscape capped by maxWidth). */
  widthFraction: 0.4,
  minWidth: 150,
  maxWidth: 230,
  heightFraction: 0.38,
  minHeight: 150,
  maxHeight: 320,
  /** Narrowest a region may get when the landscape dock squeezes it. */
  squeezedMinWidth: 96,
  dockGap: 4,
  /** A measured rail cap is ignored when it would leave a region shorter than this (rail missing or mid-layout). */
  minCappedHeight: 40,
  /** Short landscape zones (viewport fractions, edge to edge) with a floor so they stay thumb-usable on a small phone. */
  landscape: {
    left: { widthFraction: 0.225, heightFraction: 0.32 },
    right: { widthFraction: 0.25, heightFraction: 0.29 },
    minWidth: 150,
    minHeight: 110
  }
} as const;

export type FloatingViewport = Readonly<{
  width: number;
  height: number;
  safeLeft: number;
  safeRight: number;
  /** Bottom safe-area inset. */
  safeBottom: number;
  /** Height of the bottom dock including its home clearance (portrait). */
  dockHeight: number;
  /** Short landscape: the dock is a narrow centred strip, so the regions run to the bottom safe edge beside it. */
  shortLandscape: boolean;
  /** Horizontal extent of the dock strip (only used in short landscape). */
  dockSpan?: Readonly<{ left: number; right: number }> | null;
  /** Bottom edge of the lowest hotbar slot on that side. The region never reaches above it, so no stick plants at or above the bottom slot row. */
  leftRailBottom?: number | null;
  rightRailBottom?: number | null;
}>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The activation region of one thumb, in viewport pixels. Bottom is the dock top (portrait) or the bottom safe edge (short landscape). */
export function floatingRegion(side: StickSide, vp: FloatingViewport): Rect {
  const R = FLOATING_REGION;
  const width = clamp(vp.width * R.widthFraction, R.minWidth, R.maxWidth);
  const height = clamp(vp.height * R.heightFraction, R.minHeight, R.maxHeight);
  // Short landscape: the corner zones are owned by the controls right out to the screen edges (safe-area strips
  // included), so a thumb in the corner can never pan or zoom the map. Planting stays inside the safe area (plantBounds).
  const bottom = vp.shortLandscape ? vp.height : vp.height - vp.dockHeight;
  if (vp.shortLandscape) {
    // Owner-drawn corner boxes: edge to edge, a bottom slice of the screen, nothing near the middle or the slot rails.
    const L = R.landscape;
    const f = side === "left" ? L.left : L.right;
    const w = Math.max(L.minWidth, vp.width * f.widthFraction);
    const h = Math.max(L.minHeight, vp.height * f.heightFraction);
    return side === "left"
      ? { left: 0, top: vp.height - h, right: w, bottom: vp.height }
      : { left: vp.width - w, top: vp.height - h, right: vp.width, bottom: vp.height };
  }
  // Portrait: the two thumb zones are mirror images (same width, height and bottom offset). The rail cap is the lower of the
  // two rails so neither zone reaches a slot, and the side inset is the larger safe inset.
  const rails = [vp.leftRailBottom, vp.rightRailBottom].filter((r): r is number => typeof r === "number" && Number.isFinite(r));
  const railBottom = rails.length > 0 ? Math.max(...rails) : null;
  const capped = railBottom !== null && railBottom <= bottom - R.minCappedHeight;
  // With a measured rail the region is exactly the space under the lowest slot; otherwise the viewport fraction.
  const top = capped ? Math.max(0, railBottom) : Math.max(0, bottom - height);
  const inset = Math.max(vp.safeLeft, vp.safeRight);
  return side === "left"
    ? { left: inset, top, right: inset + width, bottom }
    : { left: vp.width - inset - width, top, right: vp.width - inset, bottom };
}

export function pointInRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

/** Centre for a base of `radius` planted at `point`: the base stays entirely inside `bounds`. */
export function clampBaseCenter(point: Point, radius: number, bounds: Rect): Point {
  const minX = bounds.left + radius;
  const maxX = bounds.right - radius;
  const minY = bounds.top + radius;
  const maxY = bounds.bottom - radius;
  return {
    x: minX > maxX ? (bounds.left + bounds.right) / 2 : clamp(point.x, minX, maxX),
    y: minY > maxY ? (bounds.top + bounds.bottom) / 2 : clamp(point.y, minY, maxY)
  };
}

/** Resting spot of a stick base: the exact centre of its zone (moved only if the base would not fit inside the zone). */
export function restingBaseCenter(region: Rect, radius: number): Point {
  return clampBaseCenter({ x: (region.left + region.right) / 2, y: (region.top + region.bottom) / 2 }, radius, region);
}

/** Trailing re-centre: a finger past `radius` from the origin drags the origin along, so the finger sits exactly on the rim. */
export function trailOrigin(origin: Point, finger: Point, radius: number): Point {
  const dx = finger.x - origin.x;
  const dy = finger.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (!(length > radius) || length === 0) return origin;
  return { x: finger.x - (dx / length) * radius, y: finger.y - (dy / length) * radius };
}

/** Stick vector (finger relative to the origin), clamped to `radius`. */
export function stickVector(origin: Point, finger: Point, radius: number): { dx: number; dy: number } {
  const dx = finger.x - origin.x;
  const dy = finger.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (length > radius) return { dx: (dx / length) * radius, dy: (dy / length) * radius };
  return { dx, dy };
}

/** A tap: the finger never left the dead zone and was released before the hold-to-repeat time. */
export function isTapGesture(maxMovePx: number, heldMs: number, deadZonePx: number, holdMs: number): boolean {
  return maxMovePx <= deadZonePx && heldMs < holdMs;
}

/** A change in the measured geometry up to this size commits at once; a bigger one has to be seen twice in a row. */
export const GEOMETRY_SMALL_SHIFT_PX = 3;

export type MeasureDecision = "ignore" | "pending" | "commit";

/**
 * Decides whether a fresh floating-geometry measure may replace the committed one. A half-laid-out layout (rest anchor
 * missing, or a hotbar rail that was measured before and is not now) is ignored once a good geometry exists, and a
 * large jump must repeat identically in the next measure so a transient viewport on unlock never moves the sticks.
 */
export function decideMeasure(input: {
  committed: { key: string; values: readonly number[] } | null;
  candidate: { key: string; values: readonly number[] };
  pendingKey: string | null;
  restMissing: boolean;
  railLost: boolean;
}): MeasureDecision {
  const { committed, candidate } = input;
  if (committed === null) return "commit";
  if (input.restMissing || input.railLost) return "ignore";
  if (candidate.key === committed.key) return "ignore";
  let shift = candidate.values.length === committed.values.length ? 0 : Infinity;
  if (Number.isFinite(shift)) {
    for (let i = 0; i < candidate.values.length; i += 1) shift = Math.max(shift, Math.abs(candidate.values[i]! - committed.values[i]!));
  }
  if (shift <= GEOMETRY_SMALL_SHIFT_PX) return "commit";
  return input.pendingKey === candidate.key ? "commit" : "pending";
}
