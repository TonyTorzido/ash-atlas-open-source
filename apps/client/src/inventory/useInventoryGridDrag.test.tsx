// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useInventoryGridDrag } from "./useInventoryGridDrag.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "elementFromPoint");
  vi.restoreAllMocks();
});

describe("useInventoryGridDrag", () => {
  it("dispatches one cross-pane transfer and suppresses the detail-zero click", () => {
    vi.useFakeTimers();
    const transfer = vi.fn();
    const action = vi.fn();
    const view = render(<DragHarness onTransfer={transfer} onAction={action} />);
    const source = view.getByRole("button", { name: "Source" });
    const target = view.getByTestId("target");
    const elementFromPoint = vi.fn((x: number, y: number) =>
      x === 30 && y === 30 ? target : source
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPoint
    });

    fireEvent(source, pointerEvent("pointerdown", {
      pointerId: 7,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10
    }));
    expect(source.classList.contains("drag-arming")).toBe(false);
    act(() => { vi.advanceTimersByTime(100); });
    expect(source.classList.contains("drag-arming")).toBe(true);
    act(() => { vi.advanceTimersByTime(400); });
    expect(source.classList.contains("dragging")).toBe(true);
    expect(document.querySelector(".inventory-drag-preview")).toBeNull();
    fireEvent(window, pointerEvent("pointermove", {
      pointerId: 7,
      pointerType: "mouse",
      clientX: 30,
      clientY: 30
    }));
    fireEvent(window, pointerEvent("pointerup", {
      pointerId: 7,
      pointerType: "mouse",
      clientX: 30,
      clientY: 30
    }));
    expect(elementFromPoint).toHaveBeenLastCalledWith(30, 30);
    fireEvent.click(source, { detail: 0 });

    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer).toHaveBeenCalledWith("source-id", "storage");
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(source, { detail: 0 });
    expect(action).toHaveBeenCalledOnce();
  });

  it("leaves default touch gestures to native scrolling without dragging or opening details", () => {
    vi.useFakeTimers();
    const transfer = vi.fn();
    const action = vi.fn();
    const view = render(<DragHarness onTransfer={transfer} onAction={action} />);
    const source = view.getByRole("button", { name: "Source" });
    const target = view.getByTestId("target");
    const scrollArea = source.closest<HTMLElement>(".inventory-grid-shell")!;
    scrollArea.scrollTop = 50;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => target)
    });

    const down = pointerEvent("pointerdown", {
      pointerId: 8,
      pointerType: "touch",
      clientX: 10,
      clientY: 10
    });
    fireEvent(source, down);
    const move = pointerEvent("pointermove", {
      pointerId: 8,
      pointerType: "touch",
      clientX: 10,
      clientY: 30
    });
    fireEvent(window, move);
    act(() => { vi.advanceTimersByTime(500); });
    const up = pointerEvent("pointerup", {
      pointerId: 8,
      pointerType: "touch",
      clientX: 10,
      clientY: 30
    });
    fireEvent(window, up);

    expect(transfer).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect([down, move, up].every((event) => !event.defaultPrevented)).toBe(true);
    expect(scrollArea.scrollTop).toBe(50);
    expect(source.classList.contains("drag-arming")).toBe(false);
    expect(source.classList.contains("dragging")).toBe(false);
  });

  it("preserves a plain detail-zero activation when no gesture completed", () => {
    const action = vi.fn();
    const view = render(<DragHarness onTransfer={vi.fn()} onAction={action} />);
    fireEvent.click(view.getByRole("button", { name: "Source" }), { detail: 0 });
    expect(action).toHaveBeenCalledOnce();
  });
});

function pointerEvent(
  type: string,
  init: MouseEventInit & { pointerId: number; pointerType: string }
): PointerEvent {
  const event = new MouseEvent(type, { ...init, bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    pointerType: { value: init.pointerType }
  });
  return event as PointerEvent;
}

function DragHarness({
  onTransfer,
  onAction
}: {
  onTransfer(id: string, pane: string): void;
  onAction(): void;
}): React.JSX.Element {
  const drag = useInventoryGridDrag({
    enabled: true,
    sourcePane: "inventory",
    onMove: vi.fn(),
    onTransfer
  });
  return (
    <div>
      <section className="inventory-grid-shell" data-inventory-transfer-pane="inventory">
        <button
          type="button"
          aria-label="Source"
          className={`${drag.armingStackId === "source-id" ? "drag-arming" : ""}${
            drag.draggingStackId === "source-id" ? " dragging" : ""
          }`}
          data-inventory-slot-index="0"
          onPointerDown={(event) => drag.begin(event, "source-id", 0)}
          onClick={(event) => {
            if (!drag.consumeClick(event)) onAction();
          }}
          onLostPointerCapture={drag.lostPointerCapture}
        >
          Source
        </button>
      </section>
      <section
        data-testid="target"
        data-inventory-transfer-pane="storage"
        data-inventory-slot-index="0"
      />
    </div>
  );
}
