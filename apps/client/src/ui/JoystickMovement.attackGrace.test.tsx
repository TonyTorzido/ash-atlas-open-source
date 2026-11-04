// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attackAimTelemetryForTest } from "../combat/attackAimTelemetry.js";
import type { SwingDirection } from "../combat/swing.js";
import { localMoveInput } from "../movement/localMoveInput.js";
import { JoystickMovement } from "./JoystickMovement.js";

/**
 * Touch attack button, first swing (t1559 owner report: "walking left, attack right, it still swings left first").
 * Walking left, the thumb lands on the attack stick and pulls right with human timing: the old 18 px crossed at 60, 120
 * or 200 ms. Every one must swing right (east, map north up) before any auto-aimed swing. A plain tap auto-aims.
 */

// jsdom has no PointerEvent: a MouseEvent carrying pointerId / pointerType is enough for React's onPointer* handlers.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "touch";
  }
}

type Call = { kind: "auto" } | { kind: "aim"; direction: SwingDirection; atMs: number };

let calls: Call[];

function renderStick(): HTMLElement {
  calls = [];
  const view = render(
    <JoystickMovement
      stickVisible
      getWorldState={() => null}
      onMove={() => undefined}
      onDash={() => false}
      panCamera={() => undefined}
      actionCombat
      onSwingAuto={() => { calls.push({ kind: "auto" }); return true; }}
      onSwing={(direction) => { calls.push({ kind: "aim", direction, atMs: performance.now() }); return true; }}
    />
  );
  const el = document.querySelector(".joystick-attack");
  if (!el) throw new Error(`no attack button: ${document.body.innerHTML.slice(0, 400)}`);
  return el as HTMLElement;
}

const X0 = 300;
const Y0 = 500;

function pointer(el: HTMLElement, type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y = Y0): void {
  fireEvent[type](el, { clientX: x, clientY: y, pointerId: 7, pointerType: "touch", bubbles: true });
}

/**
 * Human land-and-pull: the thumb rests ~35% of the time, then accelerates right, crossing 18 px at `crossMs`. Moves every
 * 16 ms (one pointermove per frame on a phone); frames run in between.
 */
async function landAndPull(el: HTMLElement, crossMs: number, holdAfterMs = 200): Promise<void> {
  const restMs = crossMs * 0.35;
  pointer(el, "pointerDown", X0);
  for (let t = 16; t <= crossMs + 64; t += 16) {
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    const travel = t <= restMs ? 0.6 : 18 * ((t - restMs) / (crossMs - restMs)) ** 2;
    pointer(el, "pointerMove", X0 + travel, Y0 + 0.3 * Math.sin(t));
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(holdAfterMs); });
  pointer(el, "pointerUp", X0 + 30);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  attackAimTelemetryForTest.reset();
  // Walking left on the movement stick.
  localMoveInput.active = true;
  localMoveInput.dx = -1;
  localMoveInput.dy = 0;
});

afterEach(() => {
  cleanup();
  localMoveInput.active = false;
  localMoveInput.dx = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("attack button first swing while walking the other way", () => {
  for (const crossMs of [60, 120, 200]) {
    it(`a pull crossing 18 px at ${crossMs} ms swings toward the pull first`, async () => {
      const el = renderStick();
      await landAndPull(el, crossMs);
      expect(calls.length).toBeGreaterThan(0);
      const first = calls[0]!;
      expect(first.kind).toBe("aim");
      if (first.kind !== "aim") return;
      expect(first.direction.dirX).toBeGreaterThan(0.95);
      // No auto-aimed swing anywhere in the gesture.
      expect(calls.some((call) => call.kind === "auto")).toBe(false);
      const row = attackAimTelemetryForTest.pending()[0]!;
      expect(row.split(",")[0]).toBe("drag");
      // Swing side R, movement side L.
      expect(row.split(",").slice(5, 7)).toEqual(["R", "L"]);
    });
  }

  it("a fast flick whose moves were coalesced into the pointerup swings toward the lift point", async () => {
    const el = renderStick();
    pointer(el, "pointerDown", X0);
    await act(async () => { await vi.advanceTimersByTimeAsync(48); });
    pointer(el, "pointerUp", X0 + 24);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("aim");
    expect(attackAimTelemetryForTest.pending()[0]!.split(",")[0]).toBe("flick");
  });

  it("a plain tap swings auto-aimed on the lift, once", async () => {
    const el = renderStick();
    pointer(el, "pointerDown", X0);
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    pointer(el, "pointerMove", X0 + 3, Y0 - 2);
    await act(async () => { await vi.advanceTimersByTimeAsync(48); });
    pointer(el, "pointerUp", X0 + 5, Y0 - 3);
    expect(calls).toEqual([{ kind: "auto" }]);
    const [source, firstMoveMs, decideMs] = attackAimTelemetryForTest.pending()[0]!.split(",");
    expect([source, firstMoveMs, decideMs]).toEqual(["tap", "32", "80"]);
  });

  it("a still hold swings auto-aimed when the 150 ms grace ends", async () => {
    const el = renderStick();
    pointer(el, "pointerDown", X0);
    await act(async () => { await vi.advanceTimersByTimeAsync(140); });
    expect(calls).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(calls).toEqual([{ kind: "auto" }]);
    pointer(el, "pointerUp", X0);
    expect(attackAimTelemetryForTest.pending()[0]!.split(",")[0]).toBe("hold");
  });
});
