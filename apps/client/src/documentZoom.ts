// Interactive UI surfaces keep the trunk behaviour (desktop: browser zoom
// enlarges the interface; touch: page zoom is cancelled).
const UI_SURFACE_SELECTOR = [
  "button", "a", "input", "select", "textarea", "label", "summary", "[contenteditable]",
  "[role=dialog]", "[role=menu]", "[role=listbox]", "[role=tooltip]", "[aria-modal=true]",
  "[role=button]", "[role=tab]", "[role=tablist]", "[role=slider]",
  ".maplibregl-ctrl",
  ".desktop-floating-window", ".phone-menu-layer", ".phone-destination-shell", ".game-app"
].join(",");

function isDesktopPresentation(): boolean {
  return document.documentElement.dataset.presentation === "desktop";
}

function isTransparentNonContent(element: Element): boolean {
  const style = getComputedStyle(element);
  const background = style.backgroundColor;
  const transparentBackground =
    background === "" || background === "transparent" || /^rgba\([^)]*,\s*0\)$/.test(background) ||
    /\/\s*0(?:\.0+)?\s*\)$/.test(background);
  if (!transparentBackground || style.backgroundImage !== "none" && style.backgroundImage !== "") return false;
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    if (parseFloat(style[`border${side}Width`] || "0") > 0 && style[`border${side}Style`] !== "none") return false;
  }
  return !Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
}

function activeGameplayMapRoot(): HTMLElement | null {
  const root = document.querySelector<HTMLElement>(".map-root");
  if (!root || root.closest("[inert]") || root.classList.contains("manor-hidden")) return null;
  return root;
}

function pointerOverMap(root: HTMLElement, event: Event): boolean {
  const { clientX, clientY } = event as Partial<MouseEvent>;
  if (typeof clientX !== "number" || typeof clientY !== "number") return true;
  const rect = root.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

/**
 * The map (overworld and map-rendered interiors) when the event target is the
 * gameplay area: the map itself or a transparent non-interactive HUD layer
 * stacked over it. Panels, menus and controls return null.
 */
function gameplayMapFor(event: Event): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const root = activeGameplayMapRoot();
  if (!root || !pointerOverMap(root, event)) return null;
  if (target.closest(UI_SURFACE_SELECTOR)) return null;
  if (root.contains(target)) return root;
  return isTransparentNonContent(target) ? root : null;
}

export function preventDocumentGestureZoom(event: Event): void {
  // Safari synthesizes MapLibre's ctrl-wheel pinch events only when the
  // corresponding trackpad gesture is allowed. Touch devices keep their guard.
  if (
    navigator.platform.startsWith("Mac") && navigator.maxTouchPoints === 0 &&
    gameplayMapFor(event)
  ) {
    return;
  }
  event.preventDefault();
}

export function preventDocumentWheelZoom(event: WheelEvent): void {
  // Document bubble phase: MapLibre already received (and cancelled) events
  // whose target is inside the map. Pinch or Ctrl+wheel over transparent HUD
  // layers never reaches it, so forward it to the map and never let the page zoom.
  if (event.ctrlKey && !event.defaultPrevented) {
    const root = gameplayMapFor(event);
    if (root) {
      event.preventDefault();
      const target = event.target as Element;
      if (!root.contains(target)) {
        const forwarded = new WheelEvent("wheel", {
          bubbles: true, cancelable: true, composed: true,
          clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
          deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
          ctrlKey: true, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey
        });
        (root.querySelector(".maplibregl-canvas-container") ?? root).dispatchEvent(forwarded);
      }
      return;
    }
  }
  // Desktop keeps browser Ctrl+wheel zoom outside the map so players can
  // enlarge the interface.
  if (isDesktopPresentation()) return;
  if (event.ctrlKey) event.preventDefault();
}
