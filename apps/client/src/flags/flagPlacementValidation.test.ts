import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FLAG_PLACEMENT_VALIDATION_TIMEOUT_MS,
  FlagPlacementValidationGate
} from "./flagPlacementValidation.js";

describe("FlagPlacementValidationGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends before publishing validating UI state", () => {
    const order: string[] = [];
    const gate = new FlagPlacementValidationGate(
      (state) => order.push(state ? "validating" : "clear"),
      vi.fn(),
      () => 100
    );

    expect(gate.begin(() => {
      order.push("sent");
      return "request-1";
    })).toMatchObject({ status: "sent", validation: { requestId: "request-1", sentAt: 100 } });
    expect(order).toEqual(["sent", "validating"]);
  });

  it("does not wait for unresolved geometry or preview work and blocks duplicate clicks", () => {
    const geometry = new Promise<never>(() => undefined);
    const preview = new Promise<never>(() => undefined);
    void geometry;
    void preview;
    const send = vi.fn(() => "request-1");
    const gate = new FlagPlacementValidationGate(vi.fn(), vi.fn());

    expect(gate.begin(send).status).toBe("sent");
    expect(gate.begin(send).status).toBe("duplicate");
    expect(send).toHaveBeenCalledOnce();
  });

  it("clears on matching server completion and on timeout", () => {
    const changes = vi.fn();
    const timedOut = vi.fn();
    const gate = new FlagPlacementValidationGate(changes, timedOut);
    gate.begin(() => "request-1");
    expect(gate.complete("different-request")).toBe(false);
    expect(gate.complete("request-1")).toBe(true);
    expect(gate.pending()).toBeNull();

    gate.begin(() => "request-2");
    vi.advanceTimersByTime(FLAG_PLACEMENT_VALIDATION_TIMEOUT_MS);
    expect(gate.pending()).toBeNull();
    expect(timedOut).toHaveBeenCalledOnce();
  });
});
