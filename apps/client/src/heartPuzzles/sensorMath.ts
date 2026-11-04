/**
 * Pure sensor math for the Ash Heart puzzle dungeons. No browser APIs here so
 * every function can be unit tested; sensorHub.ts wires these to the browser.
 */

export type Vec2 = Readonly<{ x: number; y: number }>;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Low-pass filter step. `amount` 0..1: higher follows the input faster. */
export const smooth = (prev: number, next: number, amount: number): number => prev + (next - prev) * amount;

/**
 * Convert DeviceOrientation beta/gamma (degrees) into a screen-space slope
 * vector: +x means the screen's right side is lower, +y means its bottom is
 * lower (the way a marble would roll). `screenAngle` is screen.orientation.angle.
 */
export const slopeFromOrientation = (betaDeg: number, gammaDeg: number, screenAngle: number): Vec2 => {
  const angle = ((Math.round(screenAngle / 90) * 90) % 360 + 360) % 360;
  switch (angle) {
    case 90: return { x: betaDeg, y: -gammaDeg };
    case 180: return { x: -gammaDeg, y: -betaDeg };
    case 270: return { x: -betaDeg, y: gammaDeg };
    default: return { x: gammaDeg, y: betaDeg };
  }
};

/** Slope in degrees -> normalized tilt (-1..1 per axis, magnitude capped at 1), with a small dead zone. */
export const normalizeTilt = (slope: Vec2, maxDeg: number, deadZoneDeg = 0): Vec2 => {
  const mag = Math.hypot(slope.x, slope.y);
  if (mag <= deadZoneDeg || mag === 0) return { x: 0, y: 0 };
  const eased = Math.min(1, (mag - deadZoneDeg) / Math.max(1e-6, maxDeg - deadZoneDeg));
  return { x: (slope.x / mag) * eased, y: (slope.y / mag) * eased };
};

/** Shake strength: how far the total acceleration (incl. gravity) departs from 1 g, in m/s^2. */
export const shakeMagnitude = (ax: number, ay: number, az: number): number =>
  Math.abs(Math.hypot(ax, ay, az) - 9.81);

/** Face down from accelerationIncludingGravity: z points out of the screen, so face-down reads about -9.8. */
export const isFaceDownFromAccel = (az: number, threshold = 7): boolean => az < -threshold;

/** Face down from orientation angles, for devices without usable accelerometer values. */
export const isFaceDownFromOrientation = (betaDeg: number, gammaDeg: number): boolean =>
  Math.abs(betaDeg) > 150 && Math.abs(gammaDeg) < 35;

/** Compass heading 0..360 (0 = north, clockwise). iOS gives webkitCompassHeading directly. */
export const compassHeading = (alphaDeg: number | null, webkitHeading?: number | null): number | null => {
  if (webkitHeading !== undefined && webkitHeading !== null && Number.isFinite(webkitHeading)) {
    return ((webkitHeading % 360) + 360) % 360;
  }
  if (alphaDeg === null || !Number.isFinite(alphaDeg)) return null;
  return (((360 - alphaDeg) % 360) + 360) % 360;
};

/** Signed shortest difference from `from` to `to`, in degrees (-180..180]. */
export const headingDelta = (from: number, to: number): number => {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
};

export const DOWN_VECTORS: readonly Vec2[] = [
  { x: 0, y: 1 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: -1, y: 0 }
];

/**
 * Which way is "down" in screen coordinates, snapped to 4 directions with
 * hysteresis so the room does not flicker when the phone is held diagonally.
 * `ax`/`ay` are accelerationIncludingGravity (device axes, y up).
 */
export const snapGravity = (ax: number, ay: number, prev: Vec2 = DOWN_VECTORS[0]!, hysteresis = 1.3): Vec2 => {
  const gx = -ax;
  const gy = ay; // screen y is down; device y is up and the sensor reads the reaction to gravity
  const dominantX = Math.abs(gx) > Math.abs(gy);
  const prevHorizontal = prev.x !== 0;
  const major = dominantX ? Math.abs(gx) : Math.abs(gy);
  const minor = dominantX ? Math.abs(gy) : Math.abs(gx);
  if (dominantX !== prevHorizontal && major < minor * hysteresis) return prev;
  return dominantX ? { x: Math.sign(gx), y: 0 } : { x: 0, y: Math.sign(gy) };
};

/** Gravity direction implied by screen rotation alone (touch/mouse fallback uses buttons that set this). */
export const gravityFromRotationSteps = (steps: number): Vec2 => DOWN_VECTORS[((steps % 4) + 4) % 4]!;

/** Root-mean-square level of a time-domain buffer (floats -1..1). */
export const rmsLevel = (buffer: ArrayLike<number>): number => {
  if (buffer.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) sum += buffer[i]! * buffer[i]!;
  return Math.sqrt(sum / buffer.length);
};

/**
 * Pitch (Hz) via autocorrelation, or null when too quiet / unclear. Good for a
 * hum between about 70 and 800 Hz.
 */
export const detectPitchHz = (
  buffer: ArrayLike<number>,
  sampleRate: number,
  options: Readonly<{ minHz?: number; maxHz?: number; minRms?: number; minClarity?: number }> = {}
): number | null => {
  const minHz = options.minHz ?? 70;
  const maxHz = options.maxHz ?? 800;
  const minRms = options.minRms ?? 0.015;
  const minClarity = options.minClarity ?? 0.55;
  const n = buffer.length;
  if (rmsLevel(buffer) < minRms) return null;
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(n - 1, Math.floor(sampleRate / minHz));
  let energy = 0;
  for (let i = 0; i < n; i += 1) energy += buffer[i]! * buffer[i]!;
  if (energy === 0) return null;
  const corr = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1 && lag < n; lag += 1) {
    let c = 0;
    for (let i = 0; i + lag < n; i += 1) c += buffer[i]! * buffer[i + lag]!;
    corr[lag] = c;
  }
  // First strong local peak (not the global one) avoids octave-down errors.
  let best = -1;
  const threshold = energy * minClarity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const c = corr[lag]!;
    if (c > threshold && c >= corr[lag - 1]! && c >= corr[lag + 1]!) { best = lag; break; }
  }
  if (best === -1) return null;
  const a = corr[best - 1]!;
  const b = corr[best]!;
  const c = corr[best + 1]!;
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return sampleRate / (best + shift);
};

/** Cents between two frequencies (positive when `hz` is above `target`). */
export const centsOff = (hz: number, target: number): number => 1200 * Math.log2(hz / target);

export type TouchPoint = Readonly<{ id: number; x: number; y: number }>;

/** Distinct held touch points (multi-finger plates). Deduplicates by id. */
export const heldTouchPoints = (points: readonly TouchPoint[]): readonly TouchPoint[] => {
  const seen = new Map<number, TouchPoint>();
  for (const p of points) seen.set(p.id, p);
  return [...seen.values()];
};
