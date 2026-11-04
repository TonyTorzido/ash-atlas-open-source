// @vitest-environment jsdom

import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameAppCard } from "./GameAppShell.js";
import { ITEM_NAME_LONG_PRESS_MS } from "./ItemNameTooltip.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { CraftStatusMark, MaterialChip } from "./MaterialRequirements.js";

/** jsdom has no PointerEvent, so attach pointerType by hand. */
function firePointer(element: Element, type: "pointerOver" | "pointerOut" | "pointerDown" | "pointerUp", pointerType: "mouse" | "touch", init: object = {}): void {
  const event = createEvent[type](element, init);
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(element, event);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("card status mark", () => {
  it("renders inside the card title row with its accessible label", () => {
    render(<GameAppCard title="Tannery" status={<CraftStatusMark ready={false} />} description="Cures hides.">body</GameAppCard>);
    const mark = screen.getByRole("img", { name: "Cannot build yet" });
    const row = screen.getByRole("heading", { name: "Tannery" }).parentElement!;
    expect(row.classList.contains("game-app-card-title-row")).toBe(true);
    expect(row.contains(mark)).toBe(true);
    expect(row.nextElementSibling?.textContent).toBe("Cures hides.");
  });
});

describe("item name tooltip", () => {
  it("shows the material name on hover and hides on leave", () => {
    render(<MaterialChip itemId="wood" name="Wood" need={25} have={30} />);
    const chip = screen.getByRole("img", { name: /Wood 25/ });
    firePointer(chip, "pointerOver", "mouse");
    expect(screen.getByRole("tooltip").textContent).toBe("Wood");
    firePointer(chip, "pointerOut", "mouse");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows on keyboard focus", () => {
    render(<MaterialChip itemId="wood" name="Wood" need={25} have={30} />);
    fireEvent.focus(screen.getByRole("img", { name: /Wood 25/ }));
    expect(screen.getByRole("tooltip").textContent).toBe("Wood");
  });

  it("shows on touch long-press, dismisses on release, and swallows the click", () => {
    const onClick = vi.fn();
    const { container } = render(<button type="button" onClick={onClick}><ItemArtwork itemId="stone" label="Stone" /></button>);
    const img = container.querySelector("img")!;
    firePointer(img, "pointerDown", "touch", { clientX: 5, clientY: 5 });
    act(() => { vi.advanceTimersByTime(ITEM_NAME_LONG_PRESS_MS - 10); });
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => { vi.advanceTimersByTime(20); });
    expect(screen.getByRole("tooltip").textContent).toBe("Stone");
    firePointer(img, "pointerUp", "touch");
    fireEvent.click(img);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("hover-only hosts keep PC hover but ignore touch holds and never swallow taps", () => {
    const onClick = vi.fn();
    const { container } = render(<button type="button" onClick={onClick}><ItemArtwork itemId="stone" label="Stone" nameTooltip="hover-only" /></button>);
    const img = container.querySelector("img")!;
    firePointer(img, "pointerDown", "touch", { clientX: 5, clientY: 5 });
    act(() => { vi.advanceTimersByTime(ITEM_NAME_LONG_PRESS_MS * 2); });
    expect(screen.queryByRole("tooltip")).toBeNull();
    firePointer(img, "pointerUp", "touch");
    fireEvent.click(img);
    expect(onClick).toHaveBeenCalledTimes(1);
    firePointer(img, "pointerOver", "mouse");
    expect(screen.getByRole("tooltip").textContent).toBe("Stone");
  });

  it("lets a quick tap through without a tooltip", () => {
    const onClick = vi.fn();
    const { container } = render(<button type="button" onClick={onClick}><ItemArtwork itemId="stone" label="Stone" /></button>);
    const img = container.querySelector("img")!;
    firePointer(img, "pointerDown", "touch", { clientX: 5, clientY: 5 });
    firePointer(img, "pointerUp", "touch");
    act(() => { vi.advanceTimersByTime(ITEM_NAME_LONG_PRESS_MS * 2); });
    fireEvent.click(img);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
