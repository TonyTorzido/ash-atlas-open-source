import { useCallback, useEffect, useRef, useState } from "react";

export type HudNoticeTone = "info" | "success" | "warning";
export type HudNotice = Readonly<{
  id: number;
  text: string;
  tone: HudNoticeTone;
  /** Exact duplicates merge into one row that counts up. */
  count: number;
  expiresAt: number;
}>;
export type HudNoticeInput = Readonly<{ text: string; tone?: HudNoticeTone }>;

export const HUD_NOTICE_LIFETIME_MS = 3_500;
export const HUD_NOTICE_MAX = 3;

/**
 * Adds notices to the lane queue: one short line each, exact duplicates merge (count up, lifetime
 * refreshes), and only the newest `max` lines stay so a burst never replays stale news.
 */
export function pushHudNotices(
  queue: readonly HudNotice[],
  incoming: readonly HudNoticeInput[],
  now: number,
  nextId: () => number,
  max = HUD_NOTICE_MAX,
  lifetimeMs = HUD_NOTICE_LIFETIME_MS
): HudNotice[] {
  let next = [...queue];
  for (const notice of incoming) {
    const text = notice.text.trim();
    if (!text) continue;
    const tone = notice.tone ?? "info";
    const existing = next.findIndex((entry) => entry.text === text && entry.tone === tone);
    if (existing >= 0) {
      const entry = next[existing]!;
      next = [...next.slice(0, existing), ...next.slice(existing + 1),
        { ...entry, count: entry.count + 1, expiresAt: now + lifetimeMs }];
    } else next.push({ id: nextId(), text, tone, count: 1, expiresAt: now + lifetimeMs });
  }
  return next.slice(-max);
}

export function pruneHudNotices(queue: readonly HudNotice[], now: number): HudNotice[] {
  return queue.filter((notice) => notice.expiresAt > now);
}

function clockMs(): number {
  return Date.now();
}

/** Queue state for the notice lane; every notice fades on its own timer. */
export function useHudNoticeQueue(): {
  notices: readonly HudNotice[];
  push(incoming: readonly HudNoticeInput[]): void;
  clear(): void;
} {
  const [notices, setNotices] = useState<readonly HudNotice[]>([]);
  const idRef = useRef(0);
  const push = useCallback((incoming: readonly HudNoticeInput[]): void => {
    const now = clockMs();
    setNotices((queue) => pushHudNotices(pruneHudNotices(queue, now), incoming, now, () => (idRef.current += 1)));
  }, []);
  const clear = useCallback((): void => setNotices([]), []);
  useEffect(() => {
    if (notices.length === 0) return;
    const soonest = Math.min(...notices.map((notice) => notice.expiresAt));
    const timer = window.setTimeout(
      () => setNotices((queue) => pruneHudNotices(queue, clockMs())),
      Math.max(0, soonest - clockMs()) + 20
    );
    return () => window.clearTimeout(timer);
  }, [notices]);
  return { notices, push, clear };
}

/** Short stacked lines in the HUD notice lane (top-centre, under the chat row). */
export function HudNoticeStack({ notices, label = "Notices" }: Readonly<{
  notices: readonly HudNotice[];
  label?: string;
}>): React.JSX.Element | null {
  if (notices.length === 0) return null;
  return <ul className="hud-notice-stack" aria-label={label} role="status" aria-live="polite">
    {notices.map((notice) => <li
      key={`${notice.id}:${notice.count}`}
      className={`hud-notice hud-notice-${notice.tone}`}
    >
      <span className="hud-notice-text">{notice.text}</span>
      {notice.count > 1 ? <span className="hud-notice-count">×{notice.count}</span> : null}
    </li>)}
  </ul>;
}
