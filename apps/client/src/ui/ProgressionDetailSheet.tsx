import { useEffect, useReducer, useRef, type ReactNode } from "react";

/**
 * Detail surface shared by the Skills & Professions tabs: a bottom sheet on phone and a
 * docked side panel on desktop. The page underneath stays mounted and keeps its scroll.
 * Styles live in SkillTreeV3Panel.css (`.skill-v3-sheet`).
 *
 * Opening and closing are one motion (fade plus a slight rise, with the scrim fading in step).
 * The sheet is never unmounted mid-motion: `useRetainedSheet` keeps the last sheet mounted in a
 * `closing` state until its exit animation ends, so Back and the scrim do not pop it out.
 */
export const PROGRESSION_SHEET_EXIT_MS = 160;

export function ProgressionDetailSheet({ layout, onClose, closing = false, children }: Readonly<{ layout: "desktop" | "phone"; onClose(): void; closing?: boolean; children: ReactNode }>): React.JSX.Element {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { sheetRef.current?.focus({ preventScroll: true }); }, []);
  const state = closing ? "closing" : "open";
  return <>
    <div className="skill-v3-sheet-scrim" data-state={state} aria-hidden="true" {...(closing ? {} : { onClick: onClose })} />
    <div ref={sheetRef} className="skill-v3-sheet" data-layout={layout} data-state={state} tabIndex={-1} {...(closing ? { inert: true, "aria-hidden": true } : {})}>
      {children}
    </div>
  </>;
}

type HeldSheet = Readonly<{ key: string; node: ReactNode }>;

function prefersReducedMotion(): boolean {
  try { return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/**
 * Returns the sheet to render: the live one, or (for one exit animation) the one that was just
 * dismissed, flagged `closing`. Dropped immediately under reduced motion, or when `animateExit` is
 * false. Callers keep their docked-column layout while the result is non-null so desktop closes too.
 */
export function useRetainedSheet(key: string | null, node: ReactNode, animateExit = true): (HeldSheet & Readonly<{ closing: boolean }>) | null {
  const held = useRef<HeldSheet | null>(null);
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  const live = key !== null && node !== null && node !== undefined;
  if (live) held.current = { key, node };
  const closing = !live && held.current !== null && animateExit && !prefersReducedMotion();
  if (!live && !closing) held.current = null;
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => { held.current = null; rerender(); }, PROGRESSION_SHEET_EXIT_MS + 40);
    return () => window.clearTimeout(timer);
  }, [closing]);
  return held.current ? { ...held.current, closing } : null;
}
