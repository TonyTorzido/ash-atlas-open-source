// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GearSlot } from "./GearSlot.js";

const SETS = [
  { name: "Set 1", color: "#111111" },
  { name: "Set 2", color: "#222222" },
  { name: "Set 3", color: "#333333" }
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Left rail: slot spans x 0–48; fan entries are 48px wide with 6px gaps from x 56. */
function layOut(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const entry = this.classList.contains("ash-gear-fan-entry")
      ? Array.from(this.parentElement!.children).indexOf(this)
      : -1;
    const left = entry >= 0 ? 56 + entry * 54 : 0;
    return { left, right: left + 48, top: 100, bottom: 148, width: 48, height: 48, x: left, y: 100, toJSON: () => ({}) } as DOMRect;
  });
}

function pointer(target: Element, type: string, clientX: number, clientY = 124): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}

describe("GearSlot", () => {
  it("equips the set under the release point after a slide, ignoring vertical wobble", () => {
    layOut();
    const onEquip = vi.fn();
    render(<GearSlot side="left" sets={SETS} currentIndex={0} disabled={false} onEquip={onEquip} />);
    const slot = screen.getByRole("button", { name: /Gear set: Set 1/ });
    pointer(slot, "pointerdown", 24);
    expect(screen.getByRole("menu", { name: "Gear sets" })).toBeTruthy();
    pointer(slot, "pointermove", 90);
    pointer(slot, "pointermove", 180, 150);
    pointer(slot, "pointerup", 180, 150);
    expect(onEquip).toHaveBeenCalledWith(2);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stays open on a plain press for tapping, and cancels a slide released off the row", () => {
    layOut();
    const onEquip = vi.fn();
    render(<GearSlot side="left" sets={SETS} currentIndex={0} disabled={false} onEquip={onEquip} />);
    const slot = screen.getByRole("button", { name: /Gear set/ });
    pointer(slot, "pointerdown", 24);
    pointer(slot, "pointerup", 24);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Equip Set 2" }));
    expect(onEquip).toHaveBeenCalledWith(1);

    pointer(slot, "pointerdown", 24);
    pointer(slot, "pointermove", 120);
    pointer(slot, "pointerup", 120, 400);
    expect(onEquip).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
