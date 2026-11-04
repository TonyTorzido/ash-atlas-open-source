/**
 * Player camera (docs/plans/camera-lock.md, docs/plans/hud-landscape.md): the joystick follow, the combat zoom and the
 * off-screen player indicator. Pure rules and math; the per-frame driver lives in playerFollowController.ts.
 * Everything here is render-only: world-space movement, aiming and dash input never read the camera.
 */

/** Every tunable of the player camera in one place. Screen fractions are of the map canvas. */
export const PLAYER_CAMERA = {
  /** Time for the camera to settle (about 98 percent of the way) after the player moves; the gentle follow uses it. */
  settleMs: 500,
  /** Safe area the player is steered back into (soft, smoothed): inner 70 percent wide, bottom quarter left to the touch controls. */
  safeMargin: { left: 0.15, right: 0.15, top: 0.15, bottom: 0.25 },
  /** Hard limit enforced after smoothing, so a dash or a sprint can never push the player off screen or under the controls. */
  hardMargin: { left: 0.06, right: 0.06, top: 0.08, bottom: 0.2 },
  /** A player this close outside the hard area (one sprint step) is still pulled back; farther out is a manual pan and left alone. */
  hardSlackPx: 24,
  /** The follow ends once the camera is this close (px) to the player and no movement input is held. */
  doneEpsilonPx: 1.5,
  /** Settle time (ms) of the blend from last frame's pan in the gentle follow. */
  panBlendMs: 480,
  /** Follow mode: the camera keeps the player centred while movement input is held (joystick, keys, pad). */
  follow: {
    /** Settle time of the error pull (about 98 percent). */
    settleMs: 200,
    /** Settle time of the blend from last frame's pan. */
    blendMs: 100,
    /** Largest per-frame player screen move (px) that is fed forward; a dash or a teleport exceeds it. */
    feedForwardMaxPx: 12,
    /** After a dash step the follow keeps the slower settle and blend for this long. */
    gentleMs: 600
  },
  /** A frame longer than this is treated as this long, so a stall does not jump the camera. */
  maxFrameMs: 64,
  /** Combat zoom: one soft zoom in while the player fights. It never zooms back out (the player does that by hand). */
  combatZoom: {
    /** Zoom levels (ground-scale) above the player's play zoom. About 1.5x magnification. */
    stepLevels: 0.55,
    /** Length of the zoom in: one smootherstep (zero speed and acceleration at both ends), driven in the follow's frame loop. */
    easeMs: 900,
    /** No combat signal for this long ends the fight (the next fight may zoom again). */
    exitDelayMs: 3_500,
    /** How often the combat state is sampled (ms); no per-frame work while idle. */
    pollMs: 150,
    /** Mobs this far (m) from the player must stay on screen: the step is cut back so the canvas half-height still covers it. */
    keepVisibleRadiusM: 280,
    /** Share of the canvas half-extent (smaller side) the keep-visible radius may fill. */
    edgeFill: 0.9,
    /** Never zoom in past this ground-scale zoom. */
    maxGroundZoom: 17,
    /** Zooms closer than this (levels) to the target are already there. */
    minStepLevels: 0.05
  },
  /** Off-screen player indicator. */
  indicator: {
    /** The player counts as off screen when the sprite point is this far outside the canvas. */
    offscreenPadPx: 4,
    /** Keep the badge inside the canvas by these insets (sides clear the slot rails, the top the status stack, the bottom the touch controls). */
    insetPx: { left: 66, right: 66, top: 84, bottom: 190 },
    fadeMs: 180
  }
} as const;

export type Point = Readonly<{ x: number; y: number }>;
export type Size = Readonly<{ width: number; height: number }>;
export type Rect = Readonly<{ minX: number; maxX: number; minY: number; maxY: number }>;

type Margin = Readonly<{ left: number; right: number; top: number; bottom: number }>;

export function marginRect(size: Size, margin: Margin): Rect {
  return {
    minX: size.width * margin.left,
    maxX: size.width * (1 - margin.right),
    minY: size.height * margin.top,
    maxY: size.height * (1 - margin.bottom)
  };
}

export const safeRect = (size: Size): Rect => marginRect(size, PLAYER_CAMERA.safeMargin);
export const hardRect = (size: Size): Rect => marginRect(size, PLAYER_CAMERA.hardMargin);

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * The pan (screen px, the camera centre moves by it) that centres `target` while keeping `player` inside `safe`.
 */
export function framingPan(target: Point, player: Point, center: Point, safe: Rect): Point {
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  // The player lands at player - pan: pull the pan so that point stays inside the safe rect.
  return {
    x: player.x - clamp(player.x - dx, safe.minX, safe.maxX),
    y: player.y - clamp(player.y - dy, safe.minY, safe.maxY)
  };
}

/** Exponential smoothing: the share of the remaining pan applied this frame. */
export function smoothingShare(dtMs: number, settleMs: number = PLAYER_CAMERA.settleMs): number {
  const tau = settleMs / 4;
  return 1 - Math.exp(-Math.max(0, dtMs) / tau);
}

/** Clamp a pan so the player ends inside `limit` (the hard guarantee). */
export function limitPanToKeepPlayer(pan: Point, player: Point, limit: Rect): Point {
  return {
    x: player.x - clamp(player.x - pan.x, limit.minX, limit.maxX),
    y: player.y - clamp(player.y - pan.y, limit.minY, limit.maxY)
  };
}

const WORLD_METERS_PER_PX_AT_ZOOM_0 = 78_271.517; // 40,075,017 m / 512 px (MapLibre 512 px tiles), equator

/**
 * Ground-scale zoom to hold while fighting, from the ground-scale zoom the player had. One step in, but cut back so the
 * mobs within keepVisibleRadiusM of the player still fit the smaller side of the canvas; never out, never above the cap.
 */
export function combatZoomTarget(baseGroundZoom: number, size: Size): number {
  const z = PLAYER_CAMERA.combatZoom;
  const halfPx = (Math.min(size.width, size.height) / 2) * z.edgeFill;
  const fitZoom = halfPx > 0 ? Math.log2(WORLD_METERS_PER_PX_AT_ZOOM_0 / (z.keepVisibleRadiusM / halfPx)) : baseGroundZoom;
  const target = Math.min(baseGroundZoom + z.stepLevels, Math.max(baseGroundZoom, fitZoom), Math.max(baseGroundZoom, z.maxGroundZoom));
  return target - baseGroundZoom < z.minStepLevels ? baseGroundZoom : target;
}

/** Smootherstep: 0..1 in, 0..1 out, zero speed and acceleration at both ends (no hitch at the start or the end of the zoom). */
export const smootherstep = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
};

const mercatorX = (lngDeg: number): number => (lngDeg + 180) / 360;
const mercatorY = (latDeg: number): number => 0.5 - Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360)) / (2 * Math.PI);
const lngOf = (x: number): number => x * 360 - 180;
const latOf = (y: number): number => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
/** Rotates a screen-space vector by the map bearing into the world-aligned frame. */
const rotate = (v: Point, deg: number): Point => {
  const a = (deg * Math.PI) / 180;
  return { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) };
};

/**
 * The camera centre for one combined zoom + follow-pan frame. The zoom is taken around the player (its screen offset from
 * the centre, `playerOffsetPx`, stays the same), then the camera moves `panPx` toward it, all in one jump.
 * `zoomTo` is the camera zoom after the frame; `bearingDeg` the map bearing (screen to world rotation).
 */
export function zoomFramingCenter(player: Readonly<{ lat: number; lon: number }>, playerOffsetPx: Point, panPx: Point, zoomTo: number, bearingDeg: number): { lng: number; lat: number } {
  const scale = 512 * 2 ** zoomTo;
  const world = rotate({ x: playerOffsetPx.x - panPx.x, y: playerOffsetPx.y - panPx.y }, bearingDeg);
  return { lng: lngOf(mercatorX(player.lon) - world.x / scale), lat: latOf(mercatorY(player.lat) - world.y / scale) };
}

export type IndicatorPlacement = Readonly<{
  visible: boolean;
  x: number;
  y: number;
  /** Degrees clockwise from pointing right (screen +x). */
  angleDeg: number;
}>;

/** Where the "your player is over there" badge goes: clamped to the inset canvas edge on the ray toward the player. */
export function indicatorPlacement(player: Point, size: Size): IndicatorPlacement {
  const { offscreenPadPx, insetPx } = PLAYER_CAMERA.indicator;
  const outside = player.x < -offscreenPadPx || player.x > size.width + offscreenPadPx
    || player.y < -offscreenPadPx || player.y > size.height + offscreenPadPx;
  const cx = size.width / 2;
  const cy = size.height / 2;
  const dx = player.x - cx;
  const dy = player.y - cy;
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (!outside) return { visible: false, x: cx, y: cy, angleDeg };
  const minX = insetPx.left;
  const maxX = size.width - insetPx.right;
  const minY = insetPx.top;
  const maxY = size.height - insetPx.bottom;
  // Scale the ray until it meets the inset rectangle (the centre of the canvas is inside it).
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : (dx > 0 ? maxX - cx : minX - cx) / dx;
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : (dy > 0 ? maxY - cy : minY - cy) / dy;
  const s = Math.min(sx, sy);
  return { visible: true, x: cx + dx * s, y: cy + dy * s, angleDeg };
}
