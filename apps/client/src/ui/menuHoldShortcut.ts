import {
  MOBILE_MENU_ROOT,
  MOBILE_MENU_ROOT_UTILITIES,
  type MobileMenuDestinationId
} from "../mobileGameMenu.js";

export type MenuHoldShortcutChoice = Readonly<{ id: MobileMenuDestinationId; label: string }>;

/** Every app reachable from the Game Menu, in menu order, once each. */
export const MENU_HOLD_SHORTCUT_CHOICES: readonly MenuHoldShortcutChoice[] = (() => {
  const choices: MenuHoldShortcutChoice[] = [];
  const add = (id: MobileMenuDestinationId, label: string): void => {
    if (!choices.some((choice) => choice.id === id)) choices.push({ id, label });
  };
  for (const entry of MOBILE_MENU_ROOT) add(entry.id, entry.label);
  for (const entry of MOBILE_MENU_ROOT_UTILITIES) add(entry.id, entry.label);
  return choices;
})();

const shortcutKey = (playerId: string): string => `ash-atlas:menu-hold-shortcut:v1:${playerId}`;
const DOCK_GESTURE_HINT_KEY = "ash-atlas:dock-gesture-hint:v1";

/** The Menu-hold app for this character on this device, or null when none is chosen. */
export function readMenuHoldShortcut(playerId: string | null | undefined): MobileMenuDestinationId | null {
  if (!playerId) return null;
  try {
    const stored = globalThis.localStorage?.getItem(shortcutKey(playerId));
    return MENU_HOLD_SHORTCUT_CHOICES.find((choice) => choice.id === stored)?.id ?? null;
  } catch {
    return null;
  }
}

export function saveMenuHoldShortcut(playerId: string | null | undefined, id: MobileMenuDestinationId | null): boolean {
  if (!playerId) return false;
  try {
    if (id) globalThis.localStorage?.setItem(shortcutKey(playerId), id);
    else globalThis.localStorage?.removeItem(shortcutKey(playerId));
    return true;
  } catch {
    return false;
  }
}

export function readDockGestureHintSeen(): boolean {
  try {
    return globalThis.localStorage?.getItem(DOCK_GESTURE_HINT_KEY) === "seen";
  } catch {
    return true;
  }
}

export function markDockGestureHintSeen(): void {
  try {
    globalThis.localStorage?.setItem(DOCK_GESTURE_HINT_KEY, "seen");
  } catch {
    // Storage can be unavailable in private modes; the hint simply shows again.
  }
}
