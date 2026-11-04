/**
 * The display frame's clock (docs/plans/map-shake.md). The overlay frame reads the local player's predicted position at the
 * requestAnimationFrame timestamp, and that read advances the prediction (PlayerRenderTimeline keeps the furthest time it has
 * been asked for). On iOS the joystick's touch events and timers run between the frame's timestamp and its callbacks; when they
 * asked with performance.now() the prediction was already past the frame time, so the frame rendered the event's moment
 * instead of its own and the per-frame steps went uneven (judder, read as map shake). Code outside the frame asks with
 * frameClockNow(): the last frame's time while frames are running, so it never moves the prediction past the next frame.
 */
let lastFrameMs = 0;
let lastFrameWallMs = 0;
/** Without a frame for this long the frame loop is idle and wall time is used. */
const IDLE_AFTER_MS = 100;

export function noteFrameClock(frameMs: number): void {
  lastFrameMs = frameMs;
  lastFrameWallMs = performance.now();
}

export function frameClockNow(): number {
  const wall = performance.now();
  return lastFrameWallMs > 0 && wall - lastFrameWallMs < IDLE_AFTER_MS ? lastFrameMs : wall;
}
