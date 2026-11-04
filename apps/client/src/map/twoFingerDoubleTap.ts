const MAX_TAP_DURATION_MS = 250;
const MAX_DOUBLE_TAP_DELAY_MS = 400;
const MAX_TOUCH_MOVEMENT_PX = 24;
const MAX_TAP_DISTANCE_PX = 64;

/** Touches that started on the map. A finger held on the on-screen stick or a button is not part of a map gesture. */
function mapTouches(event: TouchEvent, root: HTMLElement): Touch[] {
  return Array.from(event.touches).filter((touch) => !(touch.target instanceof Node) || root.contains(touch.target));
}

type Point = { x: number; y: number };
type ActiveTap = {
  startedAt: number;
  points: Map<number, Point>;
  midpoint: Point;
};

export function bindTwoFingerDoubleTap(
  target: HTMLElement,
  onDoubleTap: () => void,
  now: () => number = () => performance.now()
): () => void {
  let activeTap: ActiveTap | null = null;
  let previousTap: ({ at: number } & Point) | null = null;

  const onTouchStart = (event: TouchEvent): void => {
    if (mapTouches(event, target).length !== 2) {
      activeTap = null;
      return;
    }
    const first = mapTouches(event, target)[0]!;
    const second = mapTouches(event, target)[1]!;
    activeTap = {
      startedAt: now(),
      points: new Map([
        [first.identifier, point(first)],
        [second.identifier, point(second)]
      ]),
      midpoint: midpoint(first, second)
    };
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (!activeTap || mapTouches(event, target).length !== 2) {
      activeTap = null;
      return;
    }
    for (const touch of mapTouches(event, target)) {
      const start = activeTap.points.get(touch.identifier);
      if (!start || distance(start, point(touch)) > MAX_TOUCH_MOVEMENT_PX) {
        activeTap = null;
        return;
      }
    }
  };

  const onTouchEnd = (event: TouchEvent): void => {
    if (!activeTap || mapTouches(event, target).length !== 0) return;
    const completed = activeTap;
    activeTap = null;
    const completedAt = now();
    if (completedAt - completed.startedAt > MAX_TAP_DURATION_MS) {
      previousTap = null;
      return;
    }
    if (
      previousTap &&
      completedAt - previousTap.at <= MAX_DOUBLE_TAP_DELAY_MS &&
      distance(previousTap, completed.midpoint) <= MAX_TAP_DISTANCE_PX
    ) {
      previousTap = null;
      event.preventDefault();
      onDoubleTap();
      return;
    }
    previousTap = { at: completedAt, ...completed.midpoint };
  };

  const onTouchCancel = (): void => {
    activeTap = null;
    previousTap = null;
  };
  const options = { capture: true, passive: false } as const;
  target.addEventListener("touchstart", onTouchStart, options);
  target.addEventListener("touchmove", onTouchMove, options);
  target.addEventListener("touchend", onTouchEnd, options);
  target.addEventListener("touchcancel", onTouchCancel, options);
  return () => {
    target.removeEventListener("touchstart", onTouchStart, options);
    target.removeEventListener("touchmove", onTouchMove, options);
    target.removeEventListener("touchend", onTouchEnd, options);
    target.removeEventListener("touchcancel", onTouchCancel, options);
  };
}

function point(touch: Touch): Point {
  return { x: touch.clientX, y: touch.clientY };
}

function midpoint(first: Touch, second: Touch): Point {
  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2
  };
}

function distance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}
