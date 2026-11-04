import { findKeyboardMovementBlock } from "../gamepad/gamepadScope.js";

/**
 * Named hotbar actions and their current defaults.  Keeping the action ids
 * separate from the display key makes the input contract ready for future
 * remapping without making the hotbar component responsible for keyboard
 * ownership.
 */
export const HOTBAR_SLOT_ACTIONS = [
  { id: "hotbar.slot.1", defaultKey: "1", conflictKey: "Alt+1" },
  { id: "hotbar.slot.2", defaultKey: "2", conflictKey: "Alt+2" },
  { id: "hotbar.slot.3", defaultKey: "3", conflictKey: "Alt+3" },
  { id: "hotbar.slot.4", defaultKey: "4", conflictKey: "Alt+4" },
  { id: "hotbar.slot.5", defaultKey: "5", conflictKey: "Alt+5" },
  { id: "hotbar.slot.6", defaultKey: "6", conflictKey: "Alt+6" },
  { id: "hotbar.slot.7", defaultKey: "7", conflictKey: "Alt+7" },
  { id: "hotbar.slot.8", defaultKey: "8", conflictKey: "Alt+8" },
  { id: "hotbar.slot.9", defaultKey: "9", conflictKey: "Alt+9" },
  { id: "hotbar.slot.10", defaultKey: "0", conflictKey: "Alt+0" }
] as const;

export type HotbarSlotAction = (typeof HOTBAR_SLOT_ACTIONS)[number]["id"];
export type HotbarKeybind = string;

export const HOTBAR_DEFAULT_KEYBINDS: readonly HotbarKeybind[] =
  HOTBAR_SLOT_ACTIONS.map((action) => action.defaultKey);
export const HOTBAR_CONFLICT_KEYBINDS: readonly HotbarKeybind[] =
  HOTBAR_SLOT_ACTIONS.map((action) => action.conflictKey);

export function hotbarKeybindsForLegacyConflict(
  legacyConflict: boolean
): readonly HotbarKeybind[] {
  return legacyConflict ? HOTBAR_CONFLICT_KEYBINDS : HOTBAR_DEFAULT_KEYBINDS;
}

export type HotbarActionResolution = Readonly<{
  action: HotbarSlotAction;
  slotIndex: number;
  keybind: HotbarKeybind;
}>;

/** Resolve one physical key event to one named hotbar action. */
export function resolveHotbarSlotAction(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  keybinds: readonly HotbarKeybind[]
): HotbarActionResolution | null {
  const slotIndex = keybinds.findIndex((keybind) => keybindMatchesEvent(keybind, event));
  const action = HOTBAR_SLOT_ACTIONS[slotIndex];
  if (!action) return null;
  return { action: action.id, slotIndex, keybind: keybinds[slotIndex]! };
}

/**
 * Global hotbar handling is intentionally conservative.  The App owns this
 * guard so prompts, editors, and browser key handling cannot receive a second
 * activation from a presentational Hotbar render.
 */
export function hotbarKeyEventAllowed(
  event: Pick<KeyboardEvent, "defaultPrevented" | "repeat" | "isComposing" | "target">,
  _root: ParentNode | null = null
): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (isEditableTarget(event.target)) return false;
  // Only a real modal or the open Game Menu owns the number keys. Chat, messages and other
  // non-modal windows stay open while the player fights.
  if (findKeyboardMovementBlock("")) return false;
  return true;
}

function keybindMatchesEvent(
  keybind: HotbarKeybind,
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
): boolean {
  const parts = keybind.split("+");
  const key = parts.at(-1)?.toLowerCase();
  if (!key || event.key.toLowerCase() !== key) return false;
  const alt = parts.includes("Alt");
  const shift = parts.includes("Shift");
  return event.altKey === alt && event.shiftKey === shift && !event.ctrlKey && !event.metaKey;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"]), [role=\"textbox\"]")
  );
}
