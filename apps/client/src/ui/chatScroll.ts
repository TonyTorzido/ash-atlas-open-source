type ProgrammaticScrollGuard = { current: number };

export type BottomPinScheduler = {
  schedule(): void;
  cancel(): void;
};

export type TouchScrollBoundaryGuard = {
  dispose(): void;
};

export function exactMaximumScrollTop(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

export function setProgrammaticScrollTop(
  element: HTMLElement,
  scrollTop: number,
  guard: ProgrammaticScrollGuard
): void {
  if (Math.abs(element.scrollTop - scrollTop) <= 1) return;
  const operation = guard.current + 1;
  guard.current = operation;
  element.scrollTop = scrollTop;
  scheduleFrame(() => {
    if (guard.current === operation) guard.current = 0;
  });
}

export function createBottomPinScheduler(
  getElement: () => HTMLElement | null,
  shouldPin: () => boolean,
  guard: ProgrammaticScrollGuard
): BottomPinScheduler {
  let firstFrame: number | null = null;
  let finalFrame: number | null = null;

  const cancel = (): void => {
    if (firstFrame !== null) cancelFrame(firstFrame);
    if (finalFrame !== null) cancelFrame(finalFrame);
    firstFrame = null;
    finalFrame = null;
  };
  const pin = (): void => {
    const element = getElement();
    if (element && shouldPin()) {
      setProgrammaticScrollTop(element, exactMaximumScrollTop(element), guard);
    }
  };

  return {
    schedule(): void {
      cancel();
      pin();
      firstFrame = scheduleFrame(() => {
        firstFrame = null;
        pin();
        finalFrame = scheduleFrame(() => {
          finalFrame = null;
          pin();
        });
      });
    },
    cancel
  };
}

export function preserveFocusedTextEntryOnPointerDown(
  event: { preventDefault(): void },
  textarea: HTMLTextAreaElement | null
): void {
  if (textarea && document.activeElement === textarea) event.preventDefault();
}

export function installTouchScrollBoundaryGuard(
  element: HTMLElement,
  shouldGuard: () => boolean,
  edgeGestureWidth = 24
): TouchScrollBoundaryGuard {
  let start: { x: number; y: number } | null = null;

  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    start = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const clearStart = (): void => {
    start = null;
  };
  const onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!start || !touch || !shouldGuard()) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) >= Math.abs(deltaY)) return;
    if (start.x <= edgeGestureWidth && deltaX > 0) return;

    const maximumScrollTop = exactMaximumScrollTop(element);
    const atTop = element.scrollTop <= 0;
    const atBottom = element.scrollTop >= maximumScrollTop - 1;
    if (maximumScrollTop === 0 || (deltaY > 0 && atTop) || (deltaY < 0 && atBottom)) {
      event.preventDefault();
    }
  };

  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchmove", onTouchMove, { passive: false });
  element.addEventListener("touchend", clearStart, { passive: true });
  element.addEventListener("touchcancel", clearStart, { passive: true });
  return {
    dispose(): void {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", clearStart);
      element.removeEventListener("touchcancel", clearStart);
    }
  };
}

function scheduleFrame(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(performance.now()), 0);
}

function cancelFrame(handle: number): void {
  if (typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(handle);
  } else {
    window.clearTimeout(handle);
  }
}
