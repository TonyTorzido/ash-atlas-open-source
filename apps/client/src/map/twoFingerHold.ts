export const TWO_FINGER_HOLD_DURATION_MS = 600;
export const TWO_FINGER_HOLD_TOUCH_MOVEMENT_TOLERANCE_PX = 24;
export const TWO_FINGER_HOLD_MIDPOINT_MOVEMENT_TOLERANCE_PX = 18;
export const TWO_FINGER_HOLD_DISTANCE_CHANGE_TOLERANCE_PX = 18;
const COMPLETED_HOLD_SUPPRESSION_MS = 800;

/** Touches that started on the map. A finger held on the on-screen stick or a button is not part of a map gesture. */
function mapTouches(event: TouchEvent, root: HTMLElement): Touch[] {
  return Array.from(event.touches).filter((touch) => !(touch.target instanceof Node) || root.contains(touch.target));
}

type Point = { x: number; y: number };
type ActiveHold = {
  points: Map<number, Point>;
  midpoint: Point;
  distance: number;
  timer: ReturnType<typeof setTimeout> | null;
  fired: boolean;
};

export function bindTwoFingerHold(
  target: HTMLElement,
  onHold: () => void
): () => void {
  let active: ActiveHold | null = null;
  let blockedUntilAllTouchesLift = false;
  let completedHoldPendingRelease = false;
  let suppressUntil = 0;

  const cancelActive = (): void => {
    if (!active) return;
    if (active.timer !== null) clearTimeout(active.timer);
    active = null;
  };
  const blockActiveSequence = (): void => {
    cancelActive();
    blockedUntilAllTouchesLift = true;
  };
  const onTouchStart = (event: TouchEvent): void => {
    if (blockedUntilAllTouchesLift) return;
    if (mapTouches(event, target).length !== 2) {
      if (active) blockActiveSequence();
      return;
    }
    const first = mapTouches(event, target)[0]!;
    const second = mapTouches(event, target)[1]!;
    const hold: ActiveHold = {
      points: new Map([
        [first.identifier, point(first)],
        [second.identifier, point(second)]
      ]),
      midpoint: midpoint(point(first), point(second)),
      distance: distance(point(first), point(second)),
      timer: null,
      fired: false
    };
    active = hold;
    hold.timer = setTimeout(() => {
      if (active !== hold || blockedUntilAllTouchesLift) return;
      hold.timer = null;
      hold.fired = true;
      blockedUntilAllTouchesLift = true;
      completedHoldPendingRelease = true;
      onHold();
    }, TWO_FINGER_HOLD_DURATION_MS);
  };
  const onTouchMove = (event: TouchEvent): void => {
    if (completedHoldPendingRelease) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!active) return;
    if (mapTouches(event, target).length !== 2) {
      blockActiveSequence();
      return;
    }
    const currentPoints = new Map(
      mapTouches(event, target).map((touch) => [touch.identifier, point(touch)] as const)
    );
    for (const [identifier, start] of active.points) {
      const current = currentPoints.get(identifier);
      if (!current || distance(start, current) > TWO_FINGER_HOLD_TOUCH_MOVEMENT_TOLERANCE_PX) {
        blockActiveSequence();
        return;
      }
    }
    const [firstId, secondId] = [...active.points.keys()];
    const first = currentPoints.get(firstId!)!;
    const second = currentPoints.get(secondId!)!;
    if (
      distance(active.midpoint, midpoint(first, second))
        > TWO_FINGER_HOLD_MIDPOINT_MOVEMENT_TOLERANCE_PX ||
      Math.abs(distance(first, second) - active.distance)
        > TWO_FINGER_HOLD_DISTANCE_CHANGE_TOLERANCE_PX
    ) {
      blockActiveSequence();
    }
  };
  const finishTouches = (event: TouchEvent): void => {
    const suppress = completedHoldPendingRelease;
    if (active) cancelActive();
    if (mapTouches(event, target).length === 0) {
      blockedUntilAllTouchesLift = false;
      completedHoldPendingRelease = false;
      if (suppress) suppressUntil = performance.now() + COMPLETED_HOLD_SUPPRESSION_MS;
    } else {
      blockedUntilAllTouchesLift = true;
    }
    if (suppress) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const onTouchCancel = (event: TouchEvent): void => {
    finishTouches(event);
  };
  const suppressCompletedHold = (event: Event): void => {
    if (!completedHoldPendingRelease && performance.now() >= suppressUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const options = { capture: true, passive: false } as const;
  target.addEventListener("touchstart", onTouchStart, options);
  target.addEventListener("touchmove", onTouchMove, options);
  target.addEventListener("touchend", finishTouches, options);
  target.addEventListener("touchcancel", onTouchCancel, options);
  target.addEventListener("click", suppressCompletedHold, options);
  target.addEventListener("dblclick", suppressCompletedHold, options);
  target.addEventListener("contextmenu", suppressCompletedHold, options);

  return () => {
    cancelActive();
    target.removeEventListener("touchstart", onTouchStart, options);
    target.removeEventListener("touchmove", onTouchMove, options);
    target.removeEventListener("touchend", finishTouches, options);
    target.removeEventListener("touchcancel", onTouchCancel, options);
    target.removeEventListener("click", suppressCompletedHold, options);
    target.removeEventListener("dblclick", suppressCompletedHold, options);
    target.removeEventListener("contextmenu", suppressCompletedHold, options);
  };
}

function point(touch: Touch): Point {
  return { x: touch.clientX, y: touch.clientY };
}

function midpoint(first: Point, second: Point): Point {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2
  };
}

function distance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}
