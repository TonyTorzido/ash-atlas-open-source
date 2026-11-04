/** DOM helpers: find the open menu or popup a controller should navigate, and its focusable options. */

const POPUP_SELECTOR = ".game-target-picker, .game-action-prompt, .game-compact-prompt, [role=\"dialog\"]";
const FOCUSABLE_SELECTOR = "button, a[href], select, input:not([type=\"hidden\"]), [role=\"button\"], [role=\"menuitem\"], [role=\"option\"]";

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
}

export type GamepadScope = Readonly<{ kind: "menu" | "popup"; root: Element }>;

/** The topmost open Game Menu or popup, or null when the player is looking at the world. */
export function findGamepadScope(): GamepadScope | null {
  const menu = document.querySelector(".phone-hud.phone-hud-menu-open");
  if (menu && isVisible(menu)) return { kind: "menu", root: menu };
  const popups = Array.from(document.querySelectorAll(POPUP_SELECTOR)).filter(isVisible);
  const popup = popups[popups.length - 1];
  return popup ? { kind: "popup", root: popup } : null;
}

export function focusableOptions(scope: GamepadScope): HTMLElement[] {
  return Array.from(scope.root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) =>
    !(element as HTMLButtonElement).disabled
    && element.getAttribute("aria-hidden") !== "true"
    && element.closest(".phone-bottom-menu-compartment") === null
    && isVisible(element)
  );
}

/** A close or back control inside the scope, if it has one. */
export function findCloseControl(scope: GamepadScope): HTMLElement | null {
  const matcher = /close|dismiss|back|cancel|return to game/i;
  return focusableOptions(scope).find((element) =>
    matcher.test(element.getAttribute("aria-label") ?? "") || matcher.test(element.textContent ?? "")
  ) ?? null;
}

export function hotbarSlotButtons(side: "left" | "right"): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`.ash-hotbar-rail-${side} .ash-hotbar-slot`));
}

export type KeyboardMovementBlock = Readonly<{ reason: string; element: Element | null }>;

function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : "";
  const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
  return `${element.tagName.toLowerCase()}${id}${classes ? `.${classes}` : ""}`.slice(0, 60);
}

const ARROW_CODES: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * Why a movement key (WASD, arrows, Space dash) should not move the player right now, or null to let it through.
 * Only a truly modal surface blocks: the open Game Menu or an aria-modal="true" element. Non-modal desktop windows
 * (chat, messages, floating prompts, target pickers) stay open while the player walks. Arrow keys also yield when
 * focus sits on a control inside such a window, where they navigate lists and tabs.
 */
export function findKeyboardMovementBlock(code: string, active: Element | null = document.activeElement): KeyboardMovementBlock | null {
  const menu = document.querySelector(".phone-hud.phone-hud-menu-open");
  if (menu && isVisible(menu)) return { reason: `menu-open ${describeElement(menu)}`, element: menu };
  const modal = Array.from(document.querySelectorAll('[aria-modal="true"]')).filter(isVisible).pop();
  if (modal) return { reason: `modal ${describeElement(modal)}`, element: modal };
  if (ARROW_CODES.has(code) && active && active !== document.body && active !== document.documentElement) {
    const windowRoot = active.closest(POPUP_SELECTOR);
    if (windowRoot && windowRoot !== active && active.matches(FOCUSABLE_SELECTOR)) {
      return { reason: `arrow-focus-in-window ${describeElement(windowRoot)}`, element: windowRoot };
    }
  }
  return null;
}
