// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PetSnapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PetHudBar } from "./PetHudBar.js";

// jsdom has no PointerEvent; give fireEvent.pointer* the fields the gesture reads.
if (typeof window.PointerEvent === "undefined") {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: typeof TestPointerEvent }).PointerEvent = TestPointerEvent;
}
HTMLElement.prototype.setPointerCapture ??= () => undefined;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pet = {
  id: "pet-1", species: "ember_drake", name: "Ember Drake", level: 0, effectiveLevel: 0,
  unlockedAbilities: [], status: "active", activeUntil: new Date(Date.now() + 3_600_000).toISOString(),
  restUntil: null, pausedRemainingMs: null, lastFedAt: new Date().toISOString(),
  health: 100, maxHealth: 100, damage: 1, defense: 0, abilityReadyAt: {}
} as unknown as PetSnapshot;

describe("PetHudBar drag-to-place Stay", () => {
  it("holding the Stay button and releasing on the map places the pet, without a Stay tap", () => {
    vi.useFakeTimers();
    const onPlaceStay = vi.fn();
    const onCommand = vi.fn();
    render(<PetHudBar pet={pet} staying={false} busy={false} onCommand={onCommand} onAbility={vi.fn()} onPlaceStay={onPlaceStay} />);
    const button = screen.getByRole("button", { name: "Stay" });
    expect(button.querySelector("img")?.getAttribute("draggable")).toBe("false");
    // A native drag attempt must be refused so it can't cancel the pointer gesture.
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    button.dispatchEvent(dragStart);
    expect(dragStart.defaultPrevented).toBe(true);
    fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 5, clientY: 5 });
    act(() => { vi.advanceTimersByTime(400); });
    expect(button.getAttribute("data-placing")).toBe("true");
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.click(button);
    expect(onPlaceStay).toHaveBeenCalledWith({ x: 400, y: 300 });
    expect(onCommand).not.toHaveBeenCalled();
  });
});
