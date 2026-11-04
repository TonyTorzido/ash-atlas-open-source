export function subscribeAppResume(
  documentTarget: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">,
  windowTarget: Pick<Window, "addEventListener" | "removeEventListener">,
  onResume: () => void
): () => void {
  const resume = (): void => {
    if (documentTarget.visibilityState !== "hidden") onResume();
  };
  documentTarget.addEventListener("visibilitychange", resume);
  windowTarget.addEventListener("pageshow", resume);
  windowTarget.addEventListener("online", resume);
  return () => {
    documentTarget.removeEventListener("visibilitychange", resume);
    windowTarget.removeEventListener("pageshow", resume);
    windowTarget.removeEventListener("online", resume);
  };
}

/**
 * How long the app may stay hidden before the socket is suspended. A quick lock/unlock
 * inside this window keeps the connection and the on-screen world untouched.
 */
export const SUSPEND_GRACE_MS = 8000;

export function subscribeAppLifecycle(
  documentTarget: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">,
  windowTarget: Pick<Window, "addEventListener" | "removeEventListener">,
  handlers: {
    onSuspend(): void;
    onResume(): void;
    onOnline(): void;
    onOffline(): void;
  },
  subscribeNativeState?: (handler: (active: boolean) => void) => (() => void)
): () => void {
  let nativeActive = true;
  let lastResume = -Infinity;
  let hiddenAt: number | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let suspended = false;
  const isBackground = (): boolean => !nativeActive || documentTarget.visibilityState === "hidden";
  const clearGrace = (): void => {
    if (graceTimer !== null) clearTimeout(graceTimer);
    graceTimer = null;
  };
  const suspendNow = (): void => {
    clearGrace();
    if (suspended) return;
    suspended = true;
    handlers.onSuspend();
  };
  const enterBackground = (): void => {
    if (hiddenAt !== null) return;
    hiddenAt = Date.now();
    clearGrace();
    graceTimer = setTimeout(() => { graceTimer = null; suspendNow(); }, SUSPEND_GRACE_MS);
  };
  const resume = (): void => {
    if (isBackground()) return;
    // Mobile browsers freeze timers while locked, so the grace timer may never have fired.
    // Judge by wall clock and suspend first so a long lock reconnects through the normal path.
    const wasLong = hiddenAt !== null && Date.now() - hiddenAt >= SUSPEND_GRACE_MS;
    clearGrace();
    hiddenAt = null;
    if (wasLong) suspendNow();
    suspended = false;
    // Native and DOM signals often describe the same transition.
    const now = Date.now();
    if (subscribeNativeState && now - lastResume < 100) return;
    lastResume = now;
    handlers.onResume();
  };
  const unsubscribeNative = subscribeNativeState?.((active) => {
    if (nativeActive === active) return;
    nativeActive = active;
    if (active) resume();
    else {
      lastResume = -Infinity;
      enterBackground();
    }
  });
  const visibilityChanged = (): void => {
    if (documentTarget.visibilityState === "hidden") enterBackground();
    else resume();
  };
  const pageHidden = (): void => { lastResume = -Infinity; hiddenAt = null; suspendNow(); };
  const pageShown = (): void => {
    if (documentTarget.visibilityState !== "hidden") resume();
  };
  documentTarget.addEventListener("visibilitychange", visibilityChanged);
  windowTarget.addEventListener("pagehide", pageHidden);
  windowTarget.addEventListener("pageshow", pageShown);
  windowTarget.addEventListener("online", handlers.onOnline);
  windowTarget.addEventListener("offline", handlers.onOffline);
  return () => {
    clearGrace();
    unsubscribeNative?.();
    documentTarget.removeEventListener("visibilitychange", visibilityChanged);
    windowTarget.removeEventListener("pagehide", pageHidden);
    windowTarget.removeEventListener("pageshow", pageShown);
    windowTarget.removeEventListener("online", handlers.onOnline);
    windowTarget.removeEventListener("offline", handlers.onOffline);
  };
}
