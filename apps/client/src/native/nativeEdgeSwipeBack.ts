/**
 * In-app left-edge swipe for the iOS shell. Capacitor's WKWebView does not enable
 * back/forward navigation gestures, so the OS edge swipe never reaches
 * `history.back()` there. Android uses the system back gesture through Capacitor's
 * `backButton`, and mobile browsers handle the edge swipe themselves, so only the
 * iOS native shell installs this. It reuses the same back resolution as Android.
 */
export type NativeEdgeSwipeBackOptions = Readonly<{
  /** True while something can be stepped back from (a menu, chat, or dialog). */
  isActive(): boolean;
  onBack(): void;
}>;

const EDGE_START_PX = 24;
const COMMIT_DISTANCE_PX = 64;
const HORIZONTAL_RATIO = 1.5;

export function subscribeNativeEdgeSwipeBack(
  options: NativeEdgeSwipeBackOptions,
  target: Document = document
): () => void {
  let start: { x: number; y: number } | null = null;
  const onTouchStart = (event: TouchEvent): void => {
    start = null;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    if (touch.clientX > EDGE_START_PX || !options.isActive()) return;
    if (canScrollLeft(event.target)) return;
    start = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchMove = (event: TouchEvent): void => {
    if (event.touches.length > 1) start = null;
  };
  const onTouchEnd = (event: TouchEvent): void => {
    const origin = start;
    start = null;
    const touch = event.changedTouches[0];
    if (!origin || !touch) return;
    const dx = touch.clientX - origin.x;
    const dy = Math.abs(touch.clientY - origin.y);
    if (dx >= COMMIT_DISTANCE_PX && dx >= dy * HORIZONTAL_RATIO) options.onBack();
  };
  const onTouchCancel = (): void => { start = null; };
  const listener = { capture: true, passive: true } as const;
  target.addEventListener("touchstart", onTouchStart, listener);
  target.addEventListener("touchmove", onTouchMove, listener);
  target.addEventListener("touchend", onTouchEnd, listener);
  target.addEventListener("touchcancel", onTouchCancel, listener);
  return () => {
    target.removeEventListener("touchstart", onTouchStart, listener);
    target.removeEventListener("touchmove", onTouchMove, listener);
    target.removeEventListener("touchend", onTouchEnd, listener);
    target.removeEventListener("touchcancel", onTouchCancel, listener);
  };
}

/** A horizontal scroller that is already scrolled owns a rightward swipe from the edge. */
function canScrollLeft(node: EventTarget | null): boolean {
  for (let element = node instanceof Element ? node : null; element; element = element.parentElement) {
    if (element.scrollLeft > 0 && element.scrollWidth > element.clientWidth) return true;
  }
  return false;
}
