import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { clampWindowBounds, resizeWindowBounds, type WindowBounds, type WindowArea, type WindowResizeCorner } from "./desktopWindowBounds.js";
import { defaultDesktopWindowBounds, DESKTOP_WINDOW_RESET_EVENT, readSavedWindowBounds, restoreWindowBounds, saveWindowBounds } from "./desktopWindowLayout.js";
import { activeUiScale } from "./uiScale.js";

// Placement survives close/reopen for this session; moves and resizes are also
// saved per character on this device (desktopWindowLayout).
const sessionBounds = new Map<string, WindowBounds>();
/** Compact prompts size to their content until the player drags a resize handle. */
const manuallySized = new Set<string>();
const windowStack: HTMLElement[] = [];
// Registered before any window mounts, so "Reset window positions" clears the
// session cache before open windows re-measure.
if (typeof window !== "undefined") window.addEventListener(DESKTOP_WINDOW_RESET_EVENT, () => { sessionBounds.clear(); manuallySized.clear(); });
const WindowContext = createContext(false);
const titleSelector = ".game-app-header, .phone-menu-header, .chat-panel-header, .direct-messages-titlebar, .game-compact-heading";
const resizeCorners: WindowResizeCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

export function DesktopWindowTitle({ children, className = "" }: { children: ReactNode; className?: string }): React.JSX.Element {
  return useContext(WindowContext)
    ? <span role="button" tabIndex={0} className={`desktop-window-drag ${className}`} aria-label={`Move ${typeof children === "string" ? children : "app"} window`} title="Drag title bar to move · Arrow keys move · Shift moves faster"><span className="desktop-window-move-glyph" aria-hidden="true">⠿</span>{children}</span>
    : <strong className={className}>{children}</strong>;
}

type Props = HTMLAttributes<HTMLElement> & {
  windowKey: string;
  children: ReactNode;
  onRequestClose?(): void;
  overlayRef?: RefObject<HTMLElement | null>;
  compact?: boolean;
  minimized?: boolean;
};

/** Shared desktop geometry and input contract for chat, apps, and action menus. */
export function DesktopWindow({ windowKey, children, className = "", onRequestClose, overlayRef, compact = false, minimized = false, ...props }: Props): React.JSX.Element {
  const elementRef = useRef<HTMLElement | null>(null);
  const [bounds, setBounds] = useState<WindowBounds | null>(null);
  const boundsRef = useRef<WindowBounds | null>(null);
  const areaRef = useRef<WindowArea>({ width: 1, height: 1 });
  const gesture = useRef<{ pointer: number; x: number; y: number; bounds: WindowBounds; corner: WindowResizeCorner | undefined; target: HTMLElement } | null>(null);
  const minimum = compact ? { width: 260, height: 140 } : { width: 420, height: 360 };
  const update = (value: WindowBounds, persist = true): void => {
    const next = clampWindowBounds(value, areaRef.current, minimum);
    sessionBounds.set(windowKey, next);
    if (persist) saveWindowBounds(windowKey, next);
    boundsRef.current = next;
    setBounds(next);
  };
  const activate = (): void => {
    const element = elementRef.current;
    if (!element) return;
    const index = windowStack.indexOf(element);
    if (index >= 0) windowStack.splice(index, 1);
    windowStack.push(element);
    windowStack.forEach((item, order) => { item.style.zIndex = String(110 + order); });
  };
  const finish = (): void => {
    const active = gesture.current;
    gesture.current = null;
    if (active?.target.hasPointerCapture?.(active.pointer)) active.target.releasePointerCapture(active.pointer);
  };
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const measure = (): void => {
      // Bounds live in the window's own (interface-size scaled) CSS pixels, so
      // viewport pixels are divided by the scale before clamping.
      const scale = activeUiScale();
      const viewportWidth = window.innerWidth / scale;
      const hud = document.querySelector(".phone-bottom-bar")?.getBoundingClientRect();
      const height = (hud && hud.height > 0 ? Math.min(window.innerHeight, hud.top) : window.innerHeight - 88) / scale;
      // Windows stay below the top chat plaque so it is never covered.
      const chat = document.querySelector(".chat-top-bar")?.getBoundingClientRect();
      const top = chat && chat.height > 0 ? Math.min(Math.max(8, chat.bottom / scale + 6), height / 2) : 8;
      areaRef.current = { width: viewportWidth, height: Math.max(80, height - 8), top };
      const promptHeight = compact ? Math.max(140, element.scrollHeight + 2) : 0;
      const saved = sessionBounds.get(windowKey) ?? readSavedWindowBounds(windowKey);
      // Measuring never persists: only a player move or resize is saved.
      update(saved ? restoreWindowBounds(saved, areaRef.current, minimum) : defaultDesktopWindowBounds(windowKey, areaRef.current, compact, promptHeight), false);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener(DESKTOP_WINDOW_RESET_EVENT, measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const hud = document.querySelector(".phone-bottom-bar");
    if (hud) observer?.observe(hud);
    const scaleObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);
    scaleObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-scale", "data-presentation"] });
    return () => { window.removeEventListener("resize", measure); window.removeEventListener(DESKTOP_WINDOW_RESET_EVENT, measure); observer?.disconnect(); scaleObserver?.disconnect(); finish(); };
  }, [windowKey, compact]);
  useEffect(() => {
    const element = elementRef.current;
    const previousFocus = document.activeElement;
    activate();
    element?.focus({ preventScroll: true });
    return () => {
      const index = windowStack.indexOf(element!);
      if (index >= 0) windowStack.splice(index, 1);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  const start = (event: PointerEvent<HTMLElement>, corner?: WindowResizeCorner): void => {
    if (event.button !== 0 || !boundsRef.current) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, bounds: boundsRef.current, corner, target: event.currentTarget };
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>, corner?: WindowResizeCorner): void => {
    const current = boundsRef.current;
    if (!current || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 40 : 10;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (corner) manuallySized.add(windowKey);
    update(corner ? resizeWindowBounds(current, areaRef.current, corner, dx, dy, minimum) : { ...current, x: current.x + dx, y: current.y + dy });
  };
  const frame = <WindowContext.Provider value><aside {...props} ref={(element) => { elementRef.current = element; if (overlayRef) overlayRef.current = element; }}
    role="dialog" aria-modal="false" tabIndex={-1} data-desktop-window={windowKey}
    className={`desktop-floating-window ${compact ? "desktop-floating-window-compact" : ""} ${className}`}
    style={{ ...props.style, ...(bounds ? { left: bounds.x, top: bounds.y, width: bounds.width, height: minimized || (compact && !manuallySized.has(windowKey)) ? "auto" : bounds.height, ...(compact && !manuallySized.has(windowKey) ? { maxHeight: areaRef.current.height } : {}) } : {}) }}
    onFocusCapture={activate}
    onPointerDownCapture={(event) => {
      activate();
      const target = event.target as HTMLElement;
      if (!target.closest(titleSelector) || target.closest("button, input, select, textarea, a, [role='tab']")) return;
      start(event);
    }}
    onPointerDown={(event) => event.stopPropagation()}
    onPointerMove={(event) => {
      const active = gesture.current;
      if (!active || active.pointer !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const scale = activeUiScale();
      const dx = (event.clientX - active.x) / scale, dy = (event.clientY - active.y) / scale;
      if (active.corner) manuallySized.add(windowKey);
      update(active.corner ? resizeWindowBounds(active.bounds, areaRef.current, active.corner, dx, dy, minimum) : { ...active.bounds, x: active.bounds.x + dx, y: active.bounds.y + dy });
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onClick={(event) => { event.stopPropagation(); props.onClick?.(event); }}
    onKeyDown={(event) => {
      if ((event.target as HTMLElement).closest(".desktop-window-drag")) keyboard(event);
      props.onKeyDown?.(event);
      if (event.key === "Escape" && !event.defaultPrevented && windowStack.at(-1) === elementRef.current) {
        event.preventDefault(); event.stopPropagation(); onRequestClose?.();
      }
    }}>
    {children}
    {!minimized ? resizeCorners.map((corner) => <button key={corner} type="button" className="desktop-window-resize" data-resize-corner={corner}
      aria-label={`Resize window from ${corner.replace("-", " ")}`} title="Drag corner to resize · Arrow keys move this corner · Shift resizes faster"
      onPointerDown={(event) => start(event, corner)} onKeyDown={(event) => keyboard(event, corner)} />) : null}
  </aside></WindowContext.Provider>;
  // All desktop windows share one stacking/positioning owner, including prompts
  // opened by the isolated HUD dock or from another app's contained body.
  return typeof document === "undefined" ? frame : createPortal(frame, document.body);
}
