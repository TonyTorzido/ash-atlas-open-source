import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, SyntheticEvent } from "react";
import { createPortal } from "react-dom";

/** Touch hold time before an item's name shows; long enough to stay clear of a tap. */
export const ITEM_NAME_LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;

type Anchor = { left: number; top: number; bottom: number };

/**
 * Names an item picture that has no visible name: on hover or focus for mouse and keyboard, on a long
 * press for touch. The tooltip is portaled to the document body so scroll containers never clip it, and a
 * long press swallows the click that follows so it never runs the underlying tap action.
 */
/** "full": hover, focus and touch long-press. "hover-only": for hosts with their own hold or drag behaviour, never listens for touch. */
export type ItemNameTooltipMode = "full" | "hover-only";

export function useItemNameTooltip(label: string, mode: ItemNameTooltipMode = "full"): {
  bind: {
    onPointerEnter(event: ReactPointerEvent<Element>): void;
    onPointerLeave(event: ReactPointerEvent<Element>): void;
    onPointerDown(event: ReactPointerEvent<Element>): void;
    onPointerMove(event: ReactPointerEvent<Element>): void;
    onPointerUp(event: ReactPointerEvent<Element>): void;
    onPointerCancel(event: ReactPointerEvent<Element>): void;
    onFocus(event: SyntheticEvent<Element>): void;
    onBlur(): void;
    onClickCapture(event: SyntheticEvent<Element>): void;
    onContextMenu(event: SyntheticEvent<Element>): void;
  };
  tip: ReactNode;
} {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  const touchHeld = useRef(false);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clearTimer, [clearTimer]);

  const show = useCallback((element: Element) => {
    const rect = element.getBoundingClientRect();
    setAnchor({ left: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
  }, []);
  const hide = useCallback(() => setAnchor(null), []);

  const bind = {
    onPointerEnter(event: ReactPointerEvent<Element>) {
      if (event.pointerType === "mouse") show(event.currentTarget);
    },
    onPointerLeave(event: ReactPointerEvent<Element>) {
      if (event.pointerType === "mouse") hide();
    },
    onPointerDown(event: ReactPointerEvent<Element>) {
      if (mode === "hover-only" || event.pointerType === "mouse") return;
      const target = event.currentTarget;
      swallowClick.current = false;
      touchHeld.current = false;
      start.current = { x: event.clientX, y: event.clientY };
      clearTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        swallowClick.current = true;
        touchHeld.current = true;
        show(target);
      }, ITEM_NAME_LONG_PRESS_MS);
    },
    onPointerMove(event: ReactPointerEvent<Element>) {
      const origin = start.current;
      if (!origin || timer.current === null) return;
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > MOVE_CANCEL_PX) clearTimer();
    },
    onPointerUp(event: ReactPointerEvent<Element>) {
      if (event.pointerType === "mouse") return;
      clearTimer();
      if (touchHeld.current) { touchHeld.current = false; hide(); }
    },
    onPointerCancel() {
      clearTimer();
      swallowClick.current = false;
      touchHeld.current = false;
      hide();
    },
    onFocus(event: SyntheticEvent<Element>) { show(event.currentTarget); },
    onBlur() { hide(); },
    onClickCapture(event: SyntheticEvent<Element>) {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu(event: SyntheticEvent<Element>) {
      if (touchHeld.current || swallowClick.current || timer.current !== null) event.preventDefault();
    }
  };

  // Tapping anywhere else dismisses a tooltip that stayed open.
  useEffect(() => {
    if (anchor === null) return;
    const dismiss = () => setAnchor(null);
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [anchor]);

  const below = anchor !== null && anchor.top < 40;
  const tip = anchor !== null && typeof document !== "undefined"
    ? createPortal(
      <span
        className="item-name-tooltip"
        role="tooltip"
        data-place={below ? "below" : "above"}
        style={{
          left: Math.min(Math.max(anchor.left, 64), Math.max(64, window.innerWidth - 64)),
          top: below ? anchor.bottom + 6 : anchor.top - 6
        }}
      >{label}</span>,
      document.body
    )
    : null;

  return { bind, tip };
}
