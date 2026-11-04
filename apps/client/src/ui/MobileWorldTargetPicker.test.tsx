// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GameTargetPicker } from "./GameTargetPicker.js";
import { MobileWorldTargetPicker } from "./MobileWorldTargetPicker.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("MobileWorldTargetPicker", () => {
  it("keeps fruit gathering separate from detail selection and uses the shared quick-action layout", () => {
    const onSelect = vi.fn();
    const onQuickAction = vi.fn();
    const choices = [
      { key: "fruit", name: "Giving Tree (Fruiting)", category: "Resource",
        quickAction: { label: "Gather", enabled: true } },
      { key: "plain", name: "Giving Tree", category: "Resource",
        quickAction: { label: "Chop", enabled: true } }
    ];
    const view = render(<MobileWorldTargetPicker choices={choices} onSelect={onSelect}
      onQuickAction={onQuickAction} onClose={vi.fn()} />);
    const gather = screen.getByRole("button", { name: "Gather" });
    expect(gather.closest(".has-quick-action")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Chop" }).closest(".has-quick-action")).not.toBeNull();
    fireEvent.click(gather);
    expect(onQuickAction).toHaveBeenCalledWith("fruit");
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Giving Tree \(Fruiting\)/ }));
    expect(onSelect).toHaveBeenCalledWith("fruit");
    view.rerender(<MobileWorldTargetPicker choices={[{ ...choices[0]!,
      quickAction: { label: "Gather", enabled: false } }]}
      onSelect={onSelect} onQuickAction={onQuickAction} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Gather" })).toBeNull();
  });

  it("focuses the first target and restores focus after Escape", () => {
    const onHighlight = vi.fn();
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open targets</button>
        {open ? <MobileWorldTargetPicker
          choices={[{ key: "flag:1", name: "North Watch", category: "Territory flag" }]}
          onSelect={vi.fn()}
          onQuickAction={vi.fn()}
          onHighlight={onHighlight}
          onClose={() => setOpen(false)}
        /> : null}
      </>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open targets" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /North Watch/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose a world target" })).toBeNull();
    expect(onHighlight).toHaveBeenLastCalledWith(null);
    expect(document.activeElement).toBe(trigger);
  });

  it("lists every stacked target and selects one before showing its actions", () => {
    const onSelect = vi.fn();
    render(
      <MobileWorldTargetPicker
        choices={[
          { key: "flag:1", name: "North Watch", category: "Territory flag", meta: "30m", detail: "Public · Free" },
          { key: "dropped_item:2", name: "Wood", category: "Dropped item" },
          { key: "player:3", name: "Ash", category: "Player" }
        ]}
        onSelect={onSelect}
        onQuickAction={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog", { name: "Choose a world target" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Choose Target" })).toBeTruthy();
    expect(screen.queryByText(/Map marker/)).toBeNull();
    const distance = screen.getByText("30m");
    expect(distance.classList.contains("game-interaction-meta")).toBe(true);
    expect(distance.parentElement?.textContent).toBe("Territory flag30mPublic · Free");
    expect(screen.getByText("Public · Free").classList.contains("game-interaction-detail-status")).toBe(true);
    expect(screen.getAllByRole("button")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: /Ash/ }));
    expect(onSelect).toHaveBeenCalledWith("player:3");
  });

  it("keeps the last hovered or focused target preview active until another target replaces it", () => {
    const onHighlight = vi.fn();
    render(
      <MobileWorldTargetPicker
        choices={[
          {
            key: "flag:1",
            name: "North Watch",
            category: "Territory flag",
            quickAction: { label: "Travel", enabled: true }
          },
          { key: "player:2", name: "Ash", category: "Player" }
        ]}
        onSelect={vi.fn()}
        onQuickAction={vi.fn()}
        onHighlight={onHighlight}
        onClose={vi.fn()}
      />
    );

    const northWatch = screen.getByRole("button", { name: /North Watch/ });
    const visit = screen.getByRole("button", { name: "Travel" });
    const ash = screen.getByRole("button", { name: /Ash/ });
    const northRow = northWatch.closest(".mobile-world-target-row");
    const row = ash.closest(".mobile-world-target-row");
    expect(row).toBeTruthy();
    expect(document.activeElement).toBe(northWatch);
    expect(northRow?.classList.contains("is-highlighted")).toBe(true);
    expect(row?.classList.contains("is-highlighted")).toBe(false);
    fireEvent.pointerEnter(row!);
    expect(onHighlight).toHaveBeenLastCalledWith("player:2");
    expect(northRow?.classList.contains("is-highlighted")).toBe(false);
    expect(row?.classList.contains("is-highlighted")).toBe(true);
    fireEvent.pointerLeave(row!);
    expect(onHighlight).toHaveBeenLastCalledWith("player:2");
    expect(northRow?.classList.contains("is-highlighted")).toBe(false);
    expect(row?.classList.contains("is-highlighted")).toBe(true);
    fireEvent.blur(northWatch, { relatedTarget: visit });
    fireEvent.focus(visit);
    expect(onHighlight).toHaveBeenLastCalledWith("flag:1");
    fireEvent.blur(visit, { relatedTarget: document.body });
    expect(onHighlight).toHaveBeenLastCalledWith("flag:1");
    expect(northRow?.classList.contains("is-highlighted")).toBe(true);
    expect(row?.classList.contains("is-highlighted")).toBe(false);
  });

  it("keeps the original row pressed when a touch drag crosses another row", () => {
    vi.useFakeTimers();
    installPointerEvent();
    const onSelect = vi.fn();
    const onQuickAction = vi.fn();
    const onHighlight = vi.fn();
    render(
      <MobileWorldTargetPicker
        choices={[
          {
            key: "combat_entity:deer-a",
            name: "Deer",
            category: "Creature",
            meta: "614m",
            quickAction: { label: "Attack", enabled: true }
          },
          {
            key: "combat_entity:deer-b",
            name: "Deer",
            category: "Creature",
            meta: "676m",
            quickAction: { label: "Attack", enabled: true }
          }
        ]}
        onSelect={onSelect}
        onQuickAction={onQuickAction}
        onHighlight={onHighlight}
        onClose={vi.fn()}
      />
    );

    const details = screen.getAllByRole("button", { name: /Deer/ });
    const attacks = screen.getAllByRole("button", { name: "Attack" });
    const source = details[0]!;
    const preview = details[1]!;
    const destination = attacks[1]!;
    installPointerCapture(source);
    let hitTarget: Element = source;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => hitTarget)
    });

    fireEvent.pointerDown(source, { pointerId: 7, pointerType: "touch" });
    vi.advanceTimersByTime(300);
    hitTarget = preview;
    fireEvent.pointerMove(source, { pointerId: 7, pointerType: "touch", clientX: 10, clientY: 80 });
    hitTarget = destination;
    fireEvent.pointerUp(source, { pointerId: 7, pointerType: "touch", clientX: 10, clientY: 90 });
    fireEvent.click(source);

    expect(onSelect).not.toHaveBeenCalled();
    expect(onQuickAction).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Choose a world target" })).toBeTruthy();
  });

  it("does not activate another row after a primary mouse drag", () => {
    installPointerEvent();
    const onSelect = vi.fn();
    const onQuickAction = vi.fn();
    render(
      <MobileWorldTargetPicker
        choices={[
          {
            key: "collectible:giving-tree-a",
            name: "Giving Tree",
            category: "Resource",
            quickAction: { label: "Chop", enabled: true }
          },
          {
            key: "collectible:giving-tree-b",
            name: "Giving Tree",
            category: "Resource",
            quickAction: { label: "Chop", enabled: true }
          }
        ]}
        onSelect={onSelect}
        onQuickAction={onQuickAction}
        onClose={vi.fn()}
      />
    );

    const source = screen.getAllByRole("button", { name: /Giving Tree/ })[0]!;
    const destination = screen.getAllByRole("button", { name: "Chop" })[1]!;
    installPointerCapture(source);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => destination)
    });

    fireEvent.pointerDown(source, { pointerId: 26, pointerType: "mouse", button: 2 });
    fireEvent.pointerMove(source, {
      pointerId: 26,
      pointerType: "mouse",
      buttons: 2,
      clientX: 20,
      clientY: 80
    });
    fireEvent.pointerUp(source, {
      pointerId: 26,
      pointerType: "mouse",
      button: 2,
      clientX: 20,
      clientY: 80
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onQuickAction).not.toHaveBeenCalled();

    fireEvent.pointerDown(source, { pointerId: 27, pointerType: "mouse", button: 0 });
    fireEvent.pointerMove(source, {
      pointerId: 27,
      pointerType: "mouse",
      buttons: 1,
      clientX: 20,
      clientY: 80
    });
    fireEvent.pointerUp(source, {
      pointerId: 27,
      pointerType: "mouse",
      button: 0,
      clientX: 20,
      clientY: 80
    });
    fireEvent.click(source);

    expect(onSelect).not.toHaveBeenCalled();
    expect(onQuickAction).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Choose a world target" })).toBeTruthy();
  });

  it("does not activate a different row when a held press is released over it", () => {
    vi.useFakeTimers();
    installPointerEvent();
    const onSelect = vi.fn();
    const onQuickAction = vi.fn();
    render(
      <MobileWorldTargetPicker
        choices={[
          { key: "wolf", name: "Wolf", category: "Creature", quickAction: { label: "Attack", enabled: true } },
          { key: "bear", name: "Bear", category: "Creature", quickAction: { label: "Attack", enabled: true } }
        ]}
        onSelect={onSelect}
        onQuickAction={onQuickAction}
        onClose={vi.fn()}
      />
    );

    const source = screen.getAllByRole("button", { name: "Attack" })[0]!;
    const destination = screen.getByRole("button", { name: /Bear/ });
    installPointerCapture(source);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => destination)
    });

    fireEvent.pointerDown(source, { pointerId: 17, pointerType: "pen" });
    vi.advanceTimersByTime(300);
    fireEvent.pointerUp(source, { pointerId: 17, pointerType: "pen", clientX: 20, clientY: 80 });
    fireEvent.click(source);

    expect(onSelect).not.toHaveBeenCalled();
    expect(onQuickAction).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Choose a world target" })).toBeTruthy();
  });

  it("activates a stationary held detail once", () => {
    vi.useFakeTimers();
    installPointerEvent();
    const onSelect = vi.fn();
    render(
      <MobileWorldTargetPicker
        choices={[{ key: "tree", name: "Giving Tree", category: "Resource" }]}
        onSelect={onSelect}
        onQuickAction={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const detail = screen.getByRole("button", { name: /Giving Tree/ });
    installPointerCapture(detail);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => detail)
    });
    fireEvent.pointerDown(detail, { pointerId: 18, pointerType: "touch" });
    vi.advanceTimersByTime(300);
    fireEvent.pointerUp(detail, { pointerId: 18, pointerType: "touch", clientX: 20, clientY: 20 });
    fireEvent.click(detail);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("tree");
  });

  it("activates the original detail after movement within the small threshold", () => {
    installPointerEvent();
    const onSelect = vi.fn();
    render(
      <MobileWorldTargetPicker
        choices={[{ key: "tree", name: "Giving Tree", category: "Resource" }]}
        onSelect={onSelect}
        onQuickAction={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const detail = screen.getByRole("button", { name: /Giving Tree/ });
    installPointerCapture(detail);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => detail)
    });
    fireEvent.pointerDown(detail, { pointerId: 21, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(detail, { pointerId: 21, pointerType: "touch", clientX: 15, clientY: 14 });
    fireEvent.pointerUp(detail, { pointerId: 21, pointerType: "touch", clientX: 15, clientY: 14 });
    fireEvent.click(detail);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("tree");
  });

  it("keeps Take All and Cancel tied to their original controls after a drag", () => {
    installPointerEvent();
    const onFooterAction = vi.fn();
    const onCancel = vi.fn();
    render(
      <GameTargetPicker
        title="Choose Item"
        choices={[
          { key: "wood", name: "Wood", category: "Dropped item", quickAction: { label: "Take", enabled: true } },
          { key: "leather", name: "Leather", category: "Dropped item", quickAction: { label: "Take", enabled: true } }
        ]}
        footerAction={{ label: "Take All", enabled: true }}
        onFooterAction={onFooterAction}
        onSelect={vi.fn()}
        onQuickAction={vi.fn()}
        onCancel={onCancel}
      />
    );

    const takeAll = screen.getByRole("button", { name: "Take All" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    installPointerCapture(takeAll);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => cancel)
    });
    fireEvent.pointerDown(takeAll, { pointerId: 22, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(takeAll, { pointerId: 22, pointerType: "touch", clientX: 10, clientY: 70 });
    fireEvent.pointerUp(takeAll, { pointerId: 22, pointerType: "touch", clientX: 10, clientY: 70 });
    fireEvent.click(takeAll);

    expect(onFooterAction).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Choose a target" })).toBeTruthy();
  });

  it("does nothing when a hold is released over disabled or busy quick actions", () => {
    vi.useFakeTimers();
    installPointerEvent();
    const onSelect = vi.fn();
    const onQuickAction = vi.fn();
    render(
      <MobileWorldTargetPicker
        choices={[
          { key: "wolf", name: "Wolf", category: "Creature" },
          { key: "bear", name: "Bear", category: "Creature", quickAction: { label: "Attack", enabled: false } },
          { key: "deer", name: "Deer", category: "Creature", quickAction: { label: "Attack", enabled: true, busy: true } }
        ]}
        onSelect={onSelect}
        onQuickAction={onQuickAction}
        onClose={vi.fn()}
      />
    );

    const source = screen.getByRole("button", { name: /Wolf/ });
    const [disabledQuick, busyQuick] = screen.getAllByRole("button", { name: "Attack" });
    installPointerCapture(source);
    let hitTarget = disabledQuick!;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => hitTarget)
    });
    fireEvent.pointerDown(source, { pointerId: 19, pointerType: "touch" });
    vi.advanceTimersByTime(300);
    fireEvent.pointerUp(source, { pointerId: 19, pointerType: "touch", clientX: 20, clientY: 80 });
    fireEvent.click(source);
    hitTarget = busyQuick!;
    fireEvent.pointerDown(source, { pointerId: 20, pointerType: "touch" });
    vi.advanceTimersByTime(300);
    fireEvent.pointerUp(source, { pointerId: 20, pointerType: "touch", clientX: 20, clientY: 120 });
    fireEvent.click(source);

    expect(onSelect).not.toHaveBeenCalled();
    expect(onQuickAction).not.toHaveBeenCalled();
  });

  it("cancels without an action when a held drag is released outside the picker", () => {
    vi.useFakeTimers();
    installPointerEvent();
    const onSelect = vi.fn();
    const onQuickAction = vi.fn();
    const onClose = vi.fn();
    const onUnderlyingPointerUp = vi.fn();
    render(<div onPointerUp={onUnderlyingPointerUp}>
        <button type="button">Map target</button>
        <MobileWorldTargetPicker
          choices={[{ key: "wolf", name: "Wolf", category: "Creature", quickAction: { label: "Attack", enabled: true } }]}
          onSelect={onSelect}
          onQuickAction={onQuickAction}
          onClose={onClose}
        />
      </div>);

    const source = screen.getByRole("button", { name: /Wolf/ });
    const outside = screen.getByRole("button", { name: "Map target" });
    installPointerCapture(source);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => outside)
    });
    fireEvent.pointerDown(source, { pointerId: 20, pointerType: "touch" });
    vi.advanceTimersByTime(300);
    fireEvent.pointerUp(source, { pointerId: 20, pointerType: "touch", clientX: 500, clientY: 500 });
    fireEvent.click(source);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onQuickAction).not.toHaveBeenCalled();
    expect(onUnderlyingPointerUp).not.toHaveBeenCalled();
  });

  it("keeps short taps normal and restores focus preview after pointer cancel", () => {
    vi.useFakeTimers();
    installPointerEvent();
    const onSelect = vi.fn();
    const onQuickAction = vi.fn();
    const onHighlight = vi.fn();
    const onClose = vi.fn();
    render(
      <MobileWorldTargetPicker
        choices={[
          { key: "flag:1", name: "North Watch", category: "Territory flag" },
          { key: "player:2", name: "Ash", category: "Player" }
        ]}
        onSelect={onSelect}
        onQuickAction={onQuickAction}
        onHighlight={onHighlight}
        onClose={onClose}
      />
    );

    const northWatch = screen.getByRole("button", { name: /North Watch/ });
    fireEvent.pointerDown(northWatch, { pointerId: 8, pointerType: "pen" });
    fireEvent.pointerUp(northWatch, { pointerId: 8, pointerType: "pen" });
    fireEvent.click(northWatch);
    expect(onSelect).toHaveBeenCalledWith("flag:1");

    fireEvent.pointerDown(northWatch, { pointerId: 9, pointerType: "touch" });
    vi.advanceTimersByTime(300);
    fireEvent.pointerCancel(northWatch, { pointerId: 9, pointerType: "touch" });
    expect(onHighlight).toHaveBeenLastCalledWith("flag:1");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onQuickAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Choose a world target" })).toBeTruthy();
  });

  it("keeps detail and quick actions independent", () => {
    const onSelect = vi.fn();
    const onQuickAction = vi.fn();
    render(
      <MobileWorldTargetPicker
        choices={[{
          key: "collectible:1",
          name: "Giving Tree",
          category: "Resource",
          quickAction: { label: "Chop", enabled: true }
        }]}
        onSelect={onSelect}
        onQuickAction={onQuickAction}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Chop" }));
    expect(onQuickAction).toHaveBeenCalledWith("collectible:1");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Giving Tree/ }));
    expect(onSelect).toHaveBeenCalledWith("collectible:1");
    expect(onQuickAction).toHaveBeenCalledTimes(1);
  });

  it("hides unavailable quick actions without reason text", () => {
    const onQuickAction = vi.fn();
    render(
      <MobileWorldTargetPicker
        choices={[{
          key: "combat_entity:1",
          name: "Wolf",
          category: "Creature",
          quickAction: {
            label: "Attack",
            enabled: false,
            disabledReason: "Cannot attack while disconnected."
          }
        }]}
        onSelect={vi.fn()}
        onQuickAction={onQuickAction}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Attack" })).toBeNull();
    expect(screen.queryByText("Cannot attack while disconnected.")).toBeNull();
    expect(onQuickAction).not.toHaveBeenCalled();
  });
});

function installPointerEvent(): void {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "";
    }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
}

function installPointerCapture(element: HTMLElement): void {
  Object.defineProperty(element, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(element, "hasPointerCapture", { configurable: true, value: () => true });
  Object.defineProperty(element, "releasePointerCapture", { configurable: true, value: vi.fn() });
}
