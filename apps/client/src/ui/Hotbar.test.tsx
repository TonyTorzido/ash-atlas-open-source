// @vitest-environment jsdom

import {
  emptyInventoryTotals,
  HOTBAR_PLAYER_SLOT_IDS,
  type PlayerInventoryItem,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Hotbar, type HotbarAnchorBuild, type HotbarProps } from "./Hotbar.js";

const emptySlots = () => HOTBAR_PLAYER_SLOT_IDS.map((slotId) => ({ slotId, binding: null }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function inventoryItem(
  resourceType: PlayerInventoryItem["resourceType"],
  overrides: Partial<PlayerInventoryItem> = {}
): PlayerInventoryItem {
  return {
    playerId: "player-1",
    resourceType,
    variant: "default",
    quantity: 3,
    entryId: `${String(resourceType)}-entry`,
    stackId: `${String(resourceType)}-stack`,
    ...overrides
  };
}

function inventory(items: PlayerInventoryItem[]): PlayerInventorySnapshot {
  return { playerId: "player-1", revision: 1, items, totals: emptyInventoryTotals() };
}

function renderHotbar(overrides: Partial<HotbarProps> = {}) {
  const onSlotsChange = vi.fn();
  const onUseConsumable = vi.fn(() => true);
  const onFishWithRod = vi.fn(() => true);
  const props: HotbarProps = {
    slots: emptySlots(),
    inventory: inventory([
      inventoryItem("simple_food"),
      inventoryItem("giving_berry"),
      inventoryItem("fishing_rod", { entryId: "rod-entry", stackId: "rod-entry", rodId: "rod-1", usesRemaining: 8 })
    ]),
    inventorySnapshotAvailable: true,
    online: true,
    onSlotsChange,
    onUseConsumable,
    onFishWithRod,
    ...overrides
  };
  const view = render(<Hotbar {...props} />);
  return { ...view, onSlotsChange, onUseConsumable, onFishWithRod, props };
}

describe("Hotbar Plant Sapling and Shovel action slots", () => {
  it("presses the bound actions and saves them from the Tools picker group", () => {
    const slots = emptySlots().map((slot) => slot.slotId === "left-4"
      ? { ...slot, binding: { kind: "action", actionId: "plant_sapling" } as const }
      : slot.slotId === "right-4" ? { ...slot, binding: { kind: "action", actionId: "dig_treasure" } as const } : slot);
    const plant = { pressable: true, onPress: vi.fn() };
    const dig = { pressable: false, onPress: vi.fn() };
    const { onSlotsChange } = renderHotbar({ slots, utilityActions: { plant_sapling: plant, dig_treasure: dig } });
    fireEvent.click(screen.getByRole("button", { name: "Plant Sapling" }));
    expect(plant.onPress).toHaveBeenCalledOnce();
    // An unavailable press still reaches the action so it can explain itself.
    fireEvent.click(screen.getByRole("button", { name: "Shovel, unavailable" }));
    expect(dig.onPress).toHaveBeenCalledOnce();

    fireEvent.contextMenu(document.querySelector('[data-hotbar-slot="left-3"]')!);
    fireEvent.click(screen.getByRole("button", { name: /^Tools/ }));
    fireEvent.click(screen.getByRole("option", { name: /Shovel/ }));
    expect(onSlotsChange).toHaveBeenCalledWith(expect.arrayContaining([
      { slotId: "left-3", binding: { kind: "action", actionId: "dig_treasure" } }
    ]));
  });
});

describe("Hotbar build action slot", () => {
  const buildSlots = () => emptySlots().map((slot) => slot.slotId === "left-4"
    ? { ...slot, binding: { kind: "action", actionId: "anchor_build" } as const }
    : slot);
  const anchor = (overrides: Partial<HotbarAnchorBuild> = {}): HotbarAnchorBuild => ({
    kind: "flag", color: "#3366cc", pressable: true, unavailableReason: null,
    onPlace: vi.fn(), onPlan: vi.fn(), ...overrides
  });

  it("places a flag on tap and opens the planner on hold, by touch or mouse", () => {
    vi.useFakeTimers();
    const anchorBuild = anchor();
    renderHotbar({ slots: buildSlots(), anchorBuild });
    const build = screen.getByRole("button", { name: "Place flag where you are standing; hold for planning mode" });
    fireEvent.click(build);
    expect(anchorBuild.onPlace).toHaveBeenCalledOnce();

    fireEvent.pointerDown(build, { pointerType: "touch" });
    fireEvent.contextMenu(build);
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(build);
    fireEvent.click(build);
    expect(anchorBuild.onPlan).toHaveBeenCalledOnce();
    expect(anchorBuild.onPlace).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText(/Choose item for left-4/)).toBeNull();

    fireEvent.pointerDown(build, { pointerType: "mouse", button: 0 });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(build, { pointerType: "mouse" });
    fireEvent.click(build);
    expect(anchorBuild.onPlan).toHaveBeenCalledTimes(2);
    expect(anchorBuild.onPlace).toHaveBeenCalledOnce();
  });

  it("a touch tap activates on pointerup (no click while another finger holds the joystick), once even if a click follows", () => {
    const anchorBuild = anchor();
    renderHotbar({ slots: buildSlots(), anchorBuild });
    const build = screen.getByRole("button", { name: "Place flag where you are standing; hold for planning mode" });
    // Second finger: the browser sends pointerdown and pointerup but no click.
    fireEvent.pointerDown(build, { pointerType: "touch", pointerId: 7, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(build, { pointerType: "touch", pointerId: 7, clientX: 12, clientY: 11 });
    expect(anchorBuild.onPlace).toHaveBeenCalledOnce();
    // An ordinary single-finger tap sends the click too: it must not place twice.
    fireEvent.pointerDown(build, { pointerType: "touch", pointerId: 8, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(build, { pointerType: "touch", pointerId: 8, clientX: 10, clientY: 10 });
    fireEvent.click(build);
    expect(anchorBuild.onPlace).toHaveBeenCalledTimes(2);
    // A mouse click (no pointer tap recorded) and a keyboard click still work.
    fireEvent.click(build);
    expect(anchorBuild.onPlace).toHaveBeenCalledTimes(3);
  });

  it("draws the flag in the player's color, and a right-click opens the slot options", () => {
    const anchorBuild = anchor();
    renderHotbar({ slots: buildSlots(), anchorBuild });
    const build = screen.getByRole("button", { name: /hold for planning mode/ });
    expect(build.querySelector('.ash-hotbar-action-glyph path[fill="#3366cc"]')).not.toBeNull();

    fireEvent.contextMenu(build);
    expect(screen.getByLabelText("Choose item for left-4 actions")).toBeTruthy();
    expect(anchorBuild.onPlan).not.toHaveBeenCalled();
  });

  it("offers the builder in the slot picker and saves it as an action binding", () => {
    const { onSlotsChange } = renderHotbar();
    fireEvent.contextMenu(document.querySelector('[data-hotbar-slot="right-4"]')!);
    fireEvent.click(screen.getByRole("button", { name: /^Building:/ }));
    fireEvent.click(screen.getByRole("option", { name: /Flag \/ Buoy builder/ }));
    expect(onSlotsChange).toHaveBeenCalledWith(expect.arrayContaining([
      { slotId: "right-4", binding: { kind: "action", actionId: "anchor_build" } }
    ]));
  });
});

describe("Hotbar", () => {
  it("renders ten utility slots and unlocks the bottom two rows on both sides", () => {
    renderHotbar();
    expect(document.querySelectorAll("[data-hotbar-slot]")).toHaveLength(8);
    expect(document.querySelectorAll(".ash-hotbar-rail-left [data-hotbar-slot]")).toHaveLength(4);
    expect(document.querySelectorAll(".ash-hotbar-rail-right [data-hotbar-slot]")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /Core game action slot/ })).toBeNull();
    const emptySlot = screen.getByRole("button", { name: /Empty utility slot 8/ });
    expect(emptySlot.getAttribute("aria-disabled")).toBe("false");
    expect((emptySlot as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /Empty utility slot 4/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /Empty utility slot 3/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelectorAll(".ash-hotbar-slot.unlocked")).toHaveLength(4);
    const lockedSlot = screen.getByRole("button", { name: /Locked utility slot 1/ });
    expect((lockedSlot as HTMLButtonElement).disabled).toBe(true);
    expect(lockedSlot.querySelector(".protection-lock-icon")).not.toBeNull();
    expect(lockedSlot.querySelector(".ash-hotbar-empty-glyph")).toBeNull();
    expect(emptySlot.querySelector(".ash-hotbar-empty-glyph")).not.toBeNull();
    const fiveRows = renderHotbar({ visibleRows: 5 });
    expect(fiveRows.container.querySelectorAll("[data-hotbar-slot]")).toHaveLength(10);
    expect(document.querySelector("[data-hotbar-slot=\"core\"]")).toBeNull();
  });

  it("hides both rails without changing the keyboard-owned component contract", () => {
    const view = renderHotbar({ visible: false });
    const hotbar = view.container.querySelector<HTMLElement>(".ash-hotbar");
    // Stays mounted so the rails can slide out; inert removes it from taps, focus and AT.
    expect(hotbar?.dataset.shown).toBe("false");
    expect(hotbar?.hasAttribute("inert")).toBe(true);
    expect(hotbar?.querySelectorAll(".ash-hotbar-rail")).toHaveLength(2);
  });

  it("normalizes a bottom-adjacent persisted layout against the measured rendered footprint", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("ash-hotbar") ? 250 : this.classList.contains("ash-hotbar-slot") ? 48 : 0;
      return { x: 0, y: 0, top: 0, right: 0, bottom: height, left: 0, width: 0, height, toJSON: () => ({}) } as DOMRect;
    });
    renderHotbar({ visibleRows: 4, rowPositions: [0, 52, 64, 76, 84] });

    const positions = Array.from(document.querySelectorAll<HTMLElement>(".ash-hotbar-rail-left .ash-hotbar-row"))
      .map((row) => Number.parseFloat(row.style.getPropertyValue("--ash-hotbar-row-position")));
    expect(positions).toEqual([0, 36, 58.4, 80.8]);
    expect(positions.every((position, index) => index === 0 || position - positions[index - 1]! >= 22.4)).toBe(true);
  });

  it("fits five rows inside a short measured mobile track without overlap", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("ash-hotbar") ? 250 : this.classList.contains("ash-hotbar-slot") ? 48 : 0;
      return { x: 0, y: 0, top: 0, right: 480, bottom: height, left: 0, width: 480, height, toJSON: () => ({}) } as DOMRect;
    });
    renderHotbar({ visibleRows: 5, rowPositions: [0, 0, 0, 0, 0] });

    const hotbar = document.querySelector<HTMLElement>(".ash-hotbar");
    const rowHeight = Number.parseFloat(hotbar?.style.getPropertyValue("--ash-hotbar-row-height") ?? "0");
    const positions = Array.from(document.querySelectorAll<HTMLElement>(".ash-hotbar-rail-left .ash-hotbar-row"))
      .map((row) => Number.parseFloat(row.style.getPropertyValue("--ash-hotbar-row-position")));
    const tops = positions.map((position) => position / 100 * 250);

    expect(rowHeight).toBeCloseTo(46.8);
    expect(tops.every((top, index) => index === 0 || top - tops[index - 1]! >= rowHeight + 4 - 0.01)).toBe(true);
    expect(tops.at(-1)! + rowHeight).toBeLessThanOrEqual(250.01);
  });

  it("uses the full tall desktop track with the enlarged tile footprint", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("ash-hotbar") ? 640 : this.classList.contains("ash-hotbar-slot") ? 64 : 0;
      return { x: 0, y: 0, top: 0, right: 0, bottom: height, left: 0, width: 0, height, toJSON: () => ({}) } as DOMRect;
    });
    renderHotbar({ visibleRows: 5, rowPositions: [0, 21, 42, 63, 84] });

    const hotbar = document.querySelector<HTMLElement>(".ash-hotbar");
    const positions = Array.from(document.querySelectorAll<HTMLElement>(".ash-hotbar-rail-left .ash-hotbar-row"))
      .map((row) => Number.parseFloat(row.style.getPropertyValue("--ash-hotbar-row-position")));
    const tops = positions.map((position) => position / 100 * 640);

    expect(hotbar?.style.getPropertyValue("--ash-hotbar-row-height")).toBe("64px");
    expect(positions).toEqual([0, 21, 42, 63, 84]);
    expect(tops.every((top, index) => index === 0 || top - tops[index - 1]! >= 72 - 0.01)).toBe(true);
    expect(tops.at(-1)! + 64).toBeLessThanOrEqual(640.01);
  });

  it("re-normalizes against the full track after a viewport resize", async () => {
    let trackHeight = 640;
    let slotHeight = 64;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("ash-hotbar") ? trackHeight : this.classList.contains("ash-hotbar-slot") ? slotHeight : 0;
      return { x: 0, y: 0, top: 0, right: 480, bottom: height, left: 0, width: 480, height, toJSON: () => ({}) } as DOMRect;
    });
    renderHotbar({ visibleRows: 5, rowPositions: [0, 12, 24, 36, 48] });
    expect(Array.from(document.querySelectorAll<HTMLElement>(".ash-hotbar-rail-left .ash-hotbar-row"))
      .map((row) => Number.parseFloat(row.style.getPropertyValue("--ash-hotbar-row-position"))))
      .toEqual([0, 12, 24, 36, 48]);

    trackHeight = 320;
    slotHeight = 48;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(Array.from(document.querySelectorAll<HTMLElement>(".ash-hotbar-rail-left .ash-hotbar-row"))
      .map((row) => Number.parseFloat(row.style.getPropertyValue("--ash-hotbar-row-position"))))
      .toEqual([0, 17.5, 35, 52.5, 70]));
    expect(document.querySelector<HTMLElement>(".ash-hotbar")?.dataset.layoutMeasured).toBe("true");
  });

  it("keeps rows hidden until an initially zero track reports valid geometry", async () => {
    let trackHeight = 0;
    let slotHeight = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("ash-hotbar") ? trackHeight : this.classList.contains("ash-hotbar-slot") ? slotHeight : 0;
      return { x: 0, y: 0, top: 0, right: 480, bottom: height, left: 0, width: 480, height, toJSON: () => ({}) } as DOMRect;
    });
    renderHotbar({ visibleRows: 5, rowPositions: [0, 0, 0, 0, 0] });
    const hotbar = document.querySelector<HTMLElement>(".ash-hotbar")!;
    expect(hotbar.dataset.layoutMeasured).toBe("false");

    trackHeight = 320;
    slotHeight = 48;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(hotbar.dataset.layoutMeasured).toBe("true"));
    expect(Array.from(hotbar.querySelectorAll<HTMLElement>(".ash-hotbar-rail-left .ash-hotbar-row"))
      .map((row) => Number.parseFloat(row.style.getPropertyValue("--ash-hotbar-row-position"))))
      .toEqual([0, 17.5, 35, 52.5, 70]);
  });

  it("edits the measured live rows as a draft and commits only on Accept", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("ash-hotbar")) {
        return { x: 0, y: 100, top: 100, right: 480, bottom: 420, left: 0, width: 480, height: 320, toJSON: () => ({}) } as DOMRect;
      }
      if (this.classList.contains("ash-hotbar-row")) {
        const row = Number(this.dataset.hotbarRow ?? "1") - 1;
        const top = 100 + row * 69;
        return { x: 0, y: top, top, right: 90, bottom: top + 48, left: 0, width: 90, height: 48, toJSON: () => ({}) } as DOMRect;
      }
      if (this.classList.contains("ash-hotbar-slot")) {
        return { x: 0, y: 100, top: 100, right: 90, bottom: 148, left: 0, width: 90, height: 48, toJSON: () => ({}) } as DOMRect;
      }
      return { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    });
    const onDone = vi.fn();
    const onCancel = vi.fn();
    renderHotbar({
      visibleRows: 4,
      rowPositions: [0, 21, 42, 63, 84],
      layoutEdit: { rowCount: 4, rowPositions: [0, 21, 42, 63, 84] },
      onLayoutEditDone: onDone,
      onLayoutEditCancel: onCancel
    });

    const rowTwo = screen.getByRole("slider", { name: "Move Row 2 vertically" });
    expect(rowTwo.classList.contains("ash-hotbar-layout-editor-row")).toBe(true);
    expect(document.querySelectorAll(".ash-hotbar-row.is-layout-editing")).toHaveLength(8);
    fireEvent.keyDown(rowTwo, { key: "ArrowDown" });
    expect(rowTwo.getAttribute("aria-valuenow")).toBe("22");
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith(4, expect.arrayContaining([0, 22]));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps the latest Accept draft through controlled reopen and remount", async () => {
    let trackHeight = 320;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("ash-hotbar")) {
        return { x: 0, y: 100, top: 100, right: 480, bottom: 100 + trackHeight, left: 0, width: 480, height: trackHeight, toJSON: () => ({}) } as DOMRect;
      }
      if (this.classList.contains("ash-hotbar-row")) {
        const row = Number(this.dataset.hotbarRow ?? "1") - 1;
        const top = 100 + row * 69;
        return { x: 0, y: top, top, right: 90, bottom: top + 48, left: 0, width: 90, height: 48, toJSON: () => ({}) } as DOMRect;
      }
      if (this.classList.contains("ash-hotbar-slot")) {
        return { x: 0, y: 100, top: 100, right: 90, bottom: 148, left: 0, width: 90, height: 48, toJSON: () => ({}) } as DOMRect;
      }
      return { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    });
    const onSlotsChange = vi.fn();
    const onUseConsumable = vi.fn(() => true);
    const onFishWithRod = vi.fn(() => true);
    const initialPositions = [0, 21, 42, 63, 84];
    function Harness(): React.JSX.Element {
      const [savedPositions, setSavedPositions] = useState(initialPositions);
      const [editing, setEditing] = useState(true);
      const [reloadKey, setReloadKey] = useState(0);
      const [doneCalls, setDoneCalls] = useState(0);
      return <>
        <button type="button" onClick={() => setEditing(true)}>Reopen</button>
        <button type="button" onClick={() => setReloadKey((current) => current + 1)}>Reload</button>
        <output data-testid="saved-positions">{savedPositions.join(",")}</output>
        <output data-testid="done-calls">{doneCalls}</output>
        <Hotbar
          key={reloadKey}
          slots={emptySlots()}
          inventory={inventory([])}
          inventorySnapshotAvailable={true}
          online={true}
          rowPositions={savedPositions}
          layoutEdit={editing ? { rowCount: 4, rowPositions: savedPositions } : null}
          onSlotsChange={onSlotsChange}
          onLayoutEditDone={(_rowCount, nextPositions) => {
            setDoneCalls((current) => current + 1);
            setSavedPositions([...nextPositions]);
            setEditing(false);
          }}
          onLayoutEditCancel={() => setEditing(false)}
          onUseConsumable={onUseConsumable}
          onFishWithRod={onFishWithRod}
        />
      </>;
    }

    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Move Row 2 vertically" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.getByTestId("saved-positions").textContent).toBe("0,22,42,63,84"));
    expect(screen.getByTestId("done-calls").textContent).toBe("1");
    expect(screen.queryByRole("slider", { name: "Move Row 2 vertically" })).toBeNull();
    trackHeight = 500;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("saved-positions").textContent).toBe("0,22,42,63,84");

    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Move Row 2 vertically" }).getAttribute("aria-valuenow")).toBe("22"));
    fireEvent.keyDown(screen.getByRole("slider", { name: "Move Row 2 vertically" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("slider", { name: "Move Row 2 vertically" })).toBeNull());
    expect(screen.getByTestId("saved-positions").textContent).toBe("0,22,42,63,84");

    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Move Row 2 vertically" }).getAttribute("aria-valuenow")).toBe("22"));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Move Row 2 vertically" }).getAttribute("aria-valuenow")).toBe("22"));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(screen.getByTestId("saved-positions").textContent).toBe("0,22,42,63,84");
    expect(screen.getByTestId("done-calls").textContent).toBe("2");
  });

  it("keeps clustered tall-phone editor bands aligned with gameplay rows after Accept", async () => {
    const trackHeight = 640;
    const rect = (top: number, height: number, left = 0, width = 90): DOMRect => ({
      x: left,
      y: top,
      top,
      right: left + width,
      bottom: top + height,
      left,
      width,
      height,
      toJSON: () => ({})
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("ash-hotbar")) return rect(100, trackHeight, 0, 480);
      if (this.classList.contains("ash-hotbar-row")) {
        const position = Number.parseFloat(this.style.getPropertyValue("--ash-hotbar-row-position") || "0");
        return rect(100 + position / 100 * trackHeight, 48);
      }
      if (this.classList.contains("ash-hotbar-slot")) {
        const row = this.closest<HTMLElement>(".ash-hotbar-row");
        const position = Number.parseFloat(row?.style.getPropertyValue("--ash-hotbar-row-position") || "0");
        return rect(100 + position / 100 * trackHeight, 48);
      }
      return rect(0, 0, 0, 0);
    });
    const initialPositions = [60, 68, 76, 85, 93];
    const onSlotsChange = vi.fn();
    const onUseConsumable = vi.fn(() => true);
    const onFishWithRod = vi.fn(() => true);
    function Harness(): React.JSX.Element {
      const [savedPositions, setSavedPositions] = useState(initialPositions);
      const [editing, setEditing] = useState(true);
      return <Hotbar
        slots={emptySlots()}
        inventory={inventory([])}
        inventorySnapshotAvailable={true}
        online={true}
        visibleRows={5}
        rowPositions={savedPositions}
        layoutEdit={editing ? { rowCount: 5, rowPositions: savedPositions } : null}
        onSlotsChange={onSlotsChange}
        onLayoutEditDone={(_rowCount, nextPositions) => {
          setSavedPositions([...nextPositions]);
          setEditing(false);
        }}
        onLayoutEditCancel={() => setEditing(false)}
        onUseConsumable={onUseConsumable}
        onFishWithRod={onFishWithRod}
      />;
    }

    render(<Harness />);
    await waitFor(() => expect(document.querySelectorAll(".ash-hotbar-layout-editor-row")).toHaveLength(5));
    const gameplayRows = () => Array.from(document.querySelectorAll<HTMLElement>(".ash-hotbar-rail-left .ash-hotbar-row"));
    const editorRows = () => Array.from(document.querySelectorAll<HTMLElement>(".ash-hotbar-layout-editor-row"));
    const beforePositions = gameplayRows().map((row) => row.style.getPropertyValue("--ash-hotbar-row-position"));
    editorRows().forEach((editorRow, index) => {
      expect(Number.parseFloat(editorRow.style.getPropertyValue("--ash-hotbar-edit-top")))
        .toBeCloseTo(gameplayRows()[index]!.getBoundingClientRect().top);
    });

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(document.querySelectorAll(".ash-hotbar-layout-editor-row")).toHaveLength(0));
    expect(gameplayRows().map((row) => row.style.getPropertyValue("--ash-hotbar-row-position"))).toEqual(beforePositions);
    const afterTops = gameplayRows().map((row) => row.getBoundingClientRect().top);
    expect(afterTops.every((top, index) => index === 0 || top - afterTops[index - 1]! >= 56 - 0.01)).toBe(true);
  });

  it("moves rows through the full measured desktop track", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("ash-hotbar") ? 640 : this.classList.contains("ash-hotbar-slot") ? 64 : 0;
      return { x: 0, y: 0, top: 0, right: 480, bottom: height, left: 0, width: 480, height, toJSON: () => ({}) } as DOMRect;
    });
    const onDone = vi.fn();
    renderHotbar({
      visibleRows: 4,
      rowPositions: [0, 21, 42, 63, 84],
      layoutEdit: { rowCount: 4, rowPositions: [0, 21, 42, 63, 84] },
      onLayoutEditDone: onDone
    });

    const rowTwo = screen.getByRole("slider", { name: "Move Row 2 vertically" });
    expect(rowTwo.getAttribute("aria-valuenow")).toBe("21");
    fireEvent.keyDown(rowTwo, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onDone).toHaveBeenCalledWith(4, [0, 22, 42, 63, 84]);
  });

  it("spans each editor handle across the measured gameplay track in a stage", async () => {
    const rect = (top: number, height: number, left: number, width: number): DOMRect => ({
      x: left,
      y: top,
      top,
      right: left + width,
      bottom: top + height,
      left,
      width,
      height,
      toJSON: () => ({})
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("ash-hotbar") || this.classList.contains("ash-hotbar-layout-editor")) {
        return rect(100, 320, 240, 480);
      }
      if (this.classList.contains("ash-hotbar-row")) {
        const row = Number(this.dataset.hotbarRow ?? "1") - 1;
        return rect(100 + row * 69, 64, 240, 90);
      }
      if (this.classList.contains("ash-hotbar-slot")) return rect(100, 64, 240, 90);
      return rect(0, 0, 0, 0);
    });
    renderHotbar({
      visibleRows: 4,
      rowPositions: [0, 21, 42, 63, 84],
      layoutEdit: { rowCount: 4, rowPositions: [0, 21, 42, 63, 84] }
    });

    await waitFor(() => expect(document.querySelectorAll(".ash-hotbar-layout-editor-row")).toHaveLength(4));
    const firstEditorRow = document.querySelector<HTMLElement>(".ash-hotbar-layout-editor-row");
    expect(firstEditorRow?.style.getPropertyValue("--ash-hotbar-edit-left")).toBe("0px");
    expect(firstEditorRow?.style.getPropertyValue("--ash-hotbar-edit-width")).toBe("480px");
  });

  it("uses the live mobile track width again after a viewport resize", async () => {
    let trackWidth = 320;
    const rect = (top: number, height: number, left: number, width: number): DOMRect => ({
      x: left,
      y: top,
      top,
      right: left + width,
      bottom: top + height,
      left,
      width,
      height,
      toJSON: () => ({})
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("ash-hotbar") || this.classList.contains("ash-hotbar-layout-editor")) {
        return rect(0, 320, 0, trackWidth);
      }
      if (this.classList.contains("ash-hotbar-row")) {
        const row = Number(this.dataset.hotbarRow ?? "1") - 1;
        return rect(row * 55, 48, 0, Math.min(trackWidth, 90));
      }
      if (this.classList.contains("ash-hotbar-slot")) return rect(0, 48, 0, Math.min(trackWidth, 90));
      return rect(0, 0, 0, 0);
    });
    renderHotbar({
      visibleRows: 4,
      rowPositions: [0, 20, 40, 60, 80],
      layoutEdit: { rowCount: 4, rowPositions: [0, 20, 40, 60, 80] }
    });

    await waitFor(() => expect(document.querySelector<HTMLElement>(".ash-hotbar-layout-editor-row")
      ?.style.getPropertyValue("--ash-hotbar-edit-width")).toBe("320px"));

    trackWidth = 375;
    void act(() => window.dispatchEvent(new Event("resize")));
    await waitFor(() => expect(document.querySelector<HTMLElement>(".ash-hotbar-layout-editor-row")
      ?.style.getPropertyValue("--ash-hotbar-edit-width")).toBe("375px"));
  });

  it("moves a live paired row by touch drag without firing its slot action", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("ash-hotbar")) {
        return { x: 0, y: 100, top: 100, right: 480, bottom: 420, left: 0, width: 480, height: 320, toJSON: () => ({}) } as DOMRect;
      }
      if (this.classList.contains("ash-hotbar-row")) {
        const row = Number(this.dataset.hotbarRow ?? "1") - 1;
        const top = 100 + row * 69;
        return { x: 0, y: top, top, right: 90, bottom: top + 48, left: 0, width: 90, height: 48, toJSON: () => ({}) } as DOMRect;
      }
      if (this.classList.contains("ash-hotbar-slot")) {
        return { x: 0, y: 100, top: 100, right: 90, bottom: 148, left: 0, width: 90, height: 48, toJSON: () => ({}) } as DOMRect;
      }
      return { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    });
    const onDone = vi.fn();
    const onUseConsumable = vi.fn(() => true);
    const boundSlots = emptySlots().map((slot) => slot.slotId === "right-3"
      ? { ...slot, binding: { kind: "consumable" as const, itemId: "giving_berry", variant: "default" } }
      : slot);
    renderHotbar({
      slots: boundSlots,
      layoutEdit: { rowCount: 4, rowPositions: [0, 21, 42, 63, 84] },
      onLayoutEditDone: onDone,
      onUseConsumable
    });
    const rowTwo = screen.getByRole("slider", { name: "Move Row 2 vertically" });
    const pointerEvent = (type: string, clientY: number): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        pointerId: { value: 7 },
        pointerType: { value: "touch" },
        clientY: { value: clientY }
      });
      return event;
    };
    fireEvent(rowTwo, pointerEvent("pointerdown", 169));
    fireEvent(rowTwo, pointerEvent("pointermove", 200));
    fireEvent(rowTwo, pointerEvent("pointerup", 200));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(onDone).toHaveBeenCalledWith(4, [0, 31.25, 48.75, 66.25, 84]);
    expect(onUseConsumable).not.toHaveBeenCalled();
  });

  it("blocks slot actions while the live editor is open and rolls back on Cancel", () => {
    const boundSlots = emptySlots().map((slot) => slot.slotId === "right-3"
      ? { ...slot, binding: { kind: "consumable" as const, itemId: "giving_berry", variant: "default" } }
      : slot);
    const onCancel = vi.fn();
    const view = renderHotbar({
      slots: boundSlots,
      layoutEdit: { rowCount: 4, rowPositions: [0, 21, 42, 63, 84] },
      onLayoutEditCancel: onCancel
    });
    const slot = screen.getByRole("button", { name: /Giving Berry/ });
    expect((slot as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot);
    expect(screen.queryByLabelText("Choose item for right-3 actions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    view.rerender(<Hotbar {...view.props} slots={boundSlots} layoutEdit={null} />);
    expect(screen.getByRole("button", { name: /Giving Berry/ })).toBeTruthy();
  });

  it("assigns and clears bindings through the canonical picker", () => {
    const view = renderHotbar();
    fireEvent.click(screen.getByRole("button", { name: /Empty utility slot 8/ }));
    expect(screen.getByLabelText("Choose item for right-3 actions")).toBeTruthy();
    // An empty slot offers groups first and no slot management.
    expect(screen.queryByRole("button", { name: "Clear binding" })).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Healing: 1 available" }));
    fireEvent.click(screen.getByRole("option", { name: /Giving Berry/ }));
    expect(view.onSlotsChange).toHaveBeenCalledWith(expect.arrayContaining([
      { slotId: "right-3", binding: { kind: "consumable", itemId: "giving_berry", variant: "default" } }
    ]));

    view.onSlotsChange.mockClear();
    const boundSlots = emptySlots().map((slot) => slot.slotId === "right-3"
      ? { ...slot, binding: { kind: "consumable" as const, itemId: "giving_berry", variant: "default" } }
      : slot);
    view.rerender(<Hotbar {...view.props} slots={boundSlots} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Giving Berry/ }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear binding" }));
    expect(view.onSlotsChange).toHaveBeenCalledWith(expect.arrayContaining([{ slotId: "right-3", binding: null }]));
  });

  it("groups picker choices, greys out empty groups, and returns from a group", () => {
    renderHotbar({ inventory: inventory([inventoryItem("giving_berry")]) });
    fireEvent.click(screen.getByRole("button", { name: /Empty utility slot 8/ }));
    expect(screen.getByText("Quick slot 8")).toBeTruthy();
    const fishing = screen.getByRole("button", { name: "Fishing: none on you" }) as HTMLButtonElement;
    expect(fishing.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Building: 1 available" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Healing: 1 available" }));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "‹ All groups" }));
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByRole("button", { name: "Building: 1 available" })).toBeTruthy();
  });

  it("swaps adjacent bindings from the picker for touch-friendly reorder", () => {
    const leftOne = { kind: "fishing_rod" as const, rodId: "rod-1" };
    const leftTwo = { kind: "consumable" as const, itemId: "giving_berry", variant: "default" };
    const slots = emptySlots().map((slot) => slot.slotId === "right-3"
      ? { ...slot, binding: leftOne }
      : slot.slotId === "right-4" ? { ...slot, binding: leftTwo } : slot);
    const { onSlotsChange } = renderHotbar({ slots });
    fireEvent.contextMenu(screen.getByRole("button", { name: /Fishing Rod/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move later" }));
    expect(onSlotsChange).toHaveBeenCalledWith(expect.arrayContaining([
      { slotId: "right-3", binding: leftTwo },
      { slotId: "right-4", binding: leftOne }
    ]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens management on a touch long press without activating the slot", () => {
    vi.useFakeTimers();
    const boundSlots = emptySlots().map((slot) => slot.slotId === "right-3"
      ? { ...slot, binding: { kind: "consumable" as const, itemId: "giving_berry", variant: "default" } }
      : slot);
    const { onUseConsumable } = renderHotbar({ slots: boundSlots });
    const slot = screen.getByRole("button", { name: /Giving Berry/ });
    fireEvent.pointerDown(slot, { pointerType: "touch" });
    void act(() => vi.advanceTimersByTime(500));
    expect(screen.getByLabelText("Choose item for right-3 actions")).toBeTruthy();
    // The slot's own hold action runs; the item-name tooltip never listens for touch here.
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerUp(slot, { pointerType: "touch" });
    fireEvent.click(slot);
    expect(onUseConsumable).not.toHaveBeenCalled();
  });

  it("activates fresh consumable and rod state, while zero quantity becomes unavailable", () => {
    const foodSlots = emptySlots().map((slot) => slot.slotId === "right-3"
      ? { ...slot, binding: { kind: "consumable" as const, itemId: "giving_berry", variant: "default" } }
      : slot);
    const view = renderHotbar({ slots: foodSlots });
    const foodButton = screen.getByRole("button", { name: /Giving Berry/ });
    expect(foodButton.querySelector("img.item-artwork")).not.toBeNull();
    expect(foodButton.querySelector(".ash-hotbar-empty-glyph")).toBeNull();
    fireEvent.click(foodButton);
    expect(view.onUseConsumable).toHaveBeenCalledWith("giving_berry", "giving_berry-entry");

    view.rerender(<Hotbar {...view.props} slots={foodSlots} inventory={inventory([inventoryItem("giving_berry", { quantity: 0 })])} />);
    const unavailable = screen.getByRole("button", { name: /Giving Berry, unavailable/ });
    expect(unavailable.getAttribute("aria-disabled")).toBe("false");
    expect((unavailable as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(unavailable);
    expect(screen.getByLabelText("Choose item for right-3 actions")).toBeTruthy();

    cleanup();
    const rodSlots = emptySlots().map((slot) => slot.slotId === "right-4"
      ? { ...slot, binding: { kind: "fishing_rod" as const, rodId: "rod-1" } }
      : slot);
    const rodView = renderHotbar({ slots: rodSlots });
    fireEvent.click(screen.getByRole("button", { name: /Fishing Rod/ }));
    expect(rodView.onFishWithRod).toHaveBeenCalledWith("rod-1");
  });

  it("announces only a truly blocked management state as disabled", () => {
    renderHotbar({ disabled: true });
    const emptySlot = screen.getByRole("button", { name: /Empty utility slot 8/ });
    expect(emptySlot.getAttribute("aria-disabled")).toBe("true");
    expect((emptySlot as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(emptySlot);
    expect(screen.queryByLabelText("Choose item for right-3 actions")).toBeNull();
  });

  it("keeps keyboard labels for keyboard-capable layouts and stays presentational", () => {
    const slots = emptySlots().map((slot) => slot.slotId === "right-3"
      ? { ...slot, binding: { kind: "consumable" as const, itemId: "giving_berry", variant: "default" } }
      : slot);
    const view = renderHotbar({ slots });
    expect(document.querySelectorAll(".ash-hotbar-slot kbd")).toHaveLength(8);
    expect(screen.getByRole("button", { name: /Giving Berry/ }).getAttribute("aria-keyshortcuts")).toBe("8");

    fireEvent.keyDown(window, { key: "1" });
    expect(view.onUseConsumable).not.toHaveBeenCalled();

    view.rerender(<Hotbar {...view.props} slots={slots} showKeyLabels={false} />);
    expect(document.querySelectorAll(".ash-hotbar-slot kbd")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Giving Berry/ }).getAttribute("aria-keyshortcuts")).toBeNull();
  });

  it("dismisses the ordinary assignment picker from Escape or outside click", () => {
    const view = renderHotbar();
    fireEvent.click(screen.getByRole("button", { name: /Empty utility slot 8/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByLabelText("Choose item for right-3 actions")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Empty utility slot 8/ }));
    // An outside tap (not a drag) dismisses; jsdom pointer events drop coordinates.
    act(() => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
      document.body.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 5, clientY: 5 }));
    });
    expect(screen.queryByLabelText("Choose item for right-3 actions")).toBeNull();
  });
});
