/**
 * Camera target filter (docs/plans/map-shake.md). The follow camera does not chase the rendered player point directly: that
 * point carries prediction corrections, server snaps and uneven sample times, and a camera that copies it frame by frame
 * shakes the whole map while the sprite stays centred. This filter turns it into a smooth, prediction-stable target:
 *
 * - position low-pass with velocity feed-forward (no trailing at a steady walk),
 * - velocity measured per frame but bounded by an acceleration limit, so a correction step is never read as a speed,
 * - fixed integration sub-steps, so 60, 90 and 120 Hz and dropped frames all give the same curve,
 * - no step backwards along the current movement axis (a correction may slow the camera, never send it back).
 *
 * Units are world pixels at the current zoom (a world point's screen position minus a fixed origin's, which camera pans do not
 * change), so the tuning matches the follow's own pixel tuning. The caller restarts the filter when the zoom or bearing changes.
 */
export type FilterPoint = Readonly<{ x: number; y: number }>;

export const CAMERA_TARGET_FILTER = {
  /** Settle (about 98 percent) of the pull from the filtered point to the raw point. */
  positionSettleMs: 300,
  /** Settle of the velocity estimate. */
  velocitySettleMs: 400,
  /** Largest change of the measured velocity per second (px/s²): a walk start passes, a correction step in one frame does not. */
  maxAccelPxS2: 4_000,
  /** Below this speed (px/s) there is no movement axis (turning on the spot, stopping) and the camera may move any way. */
  axisMinPxS: 20,
  /** A jump bigger than this (px: teleport, travel, respawn) restarts the filter at the new point. */
  resetDistancePx: 300,
  /** Integration sub-step (ms). */
  stepMs: 4,
  /** Longest frame integrated; longer stalls are treated as this long. */
  maxFrameMs: 100
} as const;

export class CameraTargetFilter {
  private pos: FilterPoint | null = null;
  private lastRaw: FilterPoint | null = null;
  private vel: FilterPoint = { x: 0, y: 0 };
  private measured: FilterPoint = { x: 0, y: 0 };

  constructor(private readonly tuning: typeof CAMERA_TARGET_FILTER = CAMERA_TARGET_FILTER) {}

  reset(): void {
    this.pos = null;
    this.lastRaw = null;
    this.vel = { x: 0, y: 0 };
    this.measured = { x: 0, y: 0 };
  }

  /** Filtered velocity (px/s). */
  velocity(): FilterPoint { return this.vel; }

  /** Unit movement axis, or null while slower than axisMinPxS. */
  axis(): FilterPoint | null {
    const speed = Math.hypot(this.vel.x, this.vel.y);
    return speed >= this.tuning.axisMinPxS ? { x: this.vel.x / speed, y: this.vel.y / speed } : null;
  }

  update(raw: FilterPoint, dtMs: number): FilterPoint {
    const t = this.tuning;
    if (!this.pos || !this.lastRaw || Math.hypot(raw.x - this.pos.x, raw.y - this.pos.y) > t.resetDistancePx) {
      this.pos = raw;
      this.lastRaw = raw;
      this.vel = { x: 0, y: 0 };
      this.measured = { x: 0, y: 0 };
      return raw;
    }
    const dt = Math.min(t.maxFrameMs, Math.max(0, dtMs));
    if (dt <= 0) return this.pos;
    const from = this.lastRaw;
    // Measured speed this frame, changed from the last measurement by at most maxAccel * dt.
    let mx = ((raw.x - from.x) / dt) * 1_000;
    let my = ((raw.y - from.y) / dt) * 1_000;
    const dmx = mx - this.measured.x;
    const dmy = my - this.measured.y;
    const dMag = Math.hypot(dmx, dmy);
    const maxDelta = (t.maxAccelPxS2 * dt) / 1_000;
    if (dMag > maxDelta) {
      mx = this.measured.x + (dmx / dMag) * maxDelta;
      my = this.measured.y + (dmy / dMag) * maxDelta;
    }
    this.measured = { x: mx, y: my };

    const axis = this.axis();
    const start = this.pos;
    const steps = Math.max(1, Math.ceil(dt / t.stepMs));
    const h = dt / steps;
    const kv = 1 - Math.exp(-h / (t.velocitySettleMs / 4));
    const kp = 1 - Math.exp(-h / (t.positionSettleMs / 4));
    let px = start.x;
    let py = start.y;
    let vx = this.vel.x;
    let vy = this.vel.y;
    for (let i = 1; i <= steps; i += 1) {
      // The raw point is spread over the frame, so a dropped frame is not one big step.
      const f = i / steps;
      const rx = from.x + (raw.x - from.x) * f;
      const ry = from.y + (raw.y - from.y) * f;
      vx += (mx - vx) * kv;
      vy += (my - vy) * kv;
      px += (vx * h) / 1_000;
      py += (vy * h) / 1_000;
      px += (rx - px) * kp;
      py += (ry - py) * kp;
    }
    if (axis) {
      const along = (px - start.x) * axis.x + (py - start.y) * axis.y;
      if (along < 0) {
        px -= axis.x * along;
        py -= axis.y * along;
      }
    }
    this.pos = { x: px, y: py };
    this.vel = { x: vx, y: vy };
    this.lastRaw = raw;
    return this.pos;
  }
}
