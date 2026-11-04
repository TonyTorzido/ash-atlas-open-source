// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  HOTBAR_CONFLICT_KEYBINDS,
  HOTBAR_DEFAULT_KEYBINDS,
  HOTBAR_SLOT_ACTIONS,
  hotbarKeybindsForLegacyConflict,
  hotbarKeyEventAllowed,
  resolveHotbarSlotAction
} from "./keybindRegistry.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe("hotbar keybind registry", () => {
  it("defines stable named actions with plain and conflict-safe defaults", () => {
    expect(HOTBAR_SLOT_ACTIONS.map((action) => action.id)).toEqual([
      "hotbar.slot.1",
      "hotbar.slot.2",
      "hotbar.slot.3",
      "hotbar.slot.4",
      "hotbar.slot.5",
      "hotbar.slot.6",
      "hotbar.slot.7",
      "hotbar.slot.8",
      "hotbar.slot.9",
      "hotbar.slot.10"
    ]);
    expect(hotbarKeybindsForLegacyConflict(false)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
    expect(hotbarKeybindsForLegacyConflict(true)).toEqual(["Alt+1", "Alt+2", "Alt+3", "Alt+4", "Alt+5", "Alt+6", "Alt+7", "Alt+8", "Alt+9", "Alt+0"]);
  });

  it("resolves exactly one slot action for each configured key", () => {
    expect(resolveHotbarSlotAction(
      new KeyboardEvent("keydown", { key: "1" }),
      HOTBAR_DEFAULT_KEYBINDS
    )).toEqual({ action: "hotbar.slot.1", slotIndex: 0, keybind: "1" });
    expect(resolveHotbarSlotAction(
      new KeyboardEvent("keydown", { key: "0" }),
      HOTBAR_DEFAULT_KEYBINDS
    )).toEqual({ action: "hotbar.slot.10", slotIndex: 9, keybind: "0" });
    expect(resolveHotbarSlotAction(
      new KeyboardEvent("keydown", { key: "1", altKey: true }),
      HOTBAR_CONFLICT_KEYBINDS
    )).toEqual({ action: "hotbar.slot.1", slotIndex: 0, keybind: "Alt+1" });
    expect(resolveHotbarSlotAction(
      new KeyboardEvent("keydown", { key: "1" }),
      HOTBAR_CONFLICT_KEYBINDS
    )).toBeNull();
  });

  it("blocks typing, modal-owned, repeated, composing, and already-handled events", () => {
    expect(hotbarKeyEventAllowed(new KeyboardEvent("keydown", { key: "1" }))).toBe(true);
    expect(hotbarKeyEventAllowed(new KeyboardEvent("keydown", { key: "1", repeat: true }))).toBe(false);
    expect(hotbarKeyEventAllowed(new KeyboardEvent("keydown", { key: "1", isComposing: true }))).toBe(false);

    const handled = new KeyboardEvent("keydown", { key: "1", cancelable: true });
    handled.preventDefault();
    expect(hotbarKeyEventAllowed(handled)).toBe(false);

    const input = document.createElement("input");
    document.body.append(input);
    const inputEvent = new KeyboardEvent("keydown", { key: "1", bubbles: true });
    input.dispatchEvent(inputEvent);
    expect(hotbarKeyEventAllowed(inputEvent)).toBe(false);

    input.remove();
    const visible = (element: HTMLElement): void => {
      element.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100, toJSON: () => ({}) });
    };
    const chat = document.createElement("aside");
    chat.setAttribute("role", "dialog");
    visible(chat);
    document.body.append(chat);
    expect(hotbarKeyEventAllowed(new KeyboardEvent("keydown", { key: "1" }))).toBe(true);
    chat.remove();

    const modal = document.createElement("aside");
    modal.setAttribute("aria-modal", "true");
    visible(modal);
    document.body.append(modal);
    expect(hotbarKeyEventAllowed(new KeyboardEvent("keydown", { key: "1" }))).toBe(false);
  });
});
