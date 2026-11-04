import type { CollectibleNode } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  ELAPSED_REPEATABLE_TIMER_REFRESH_MS,
  repeatableTimerReconciliation
} from "./repeatableTimerReconciliation.js";

describe("repeatable timer reconciliation", () => {
  it("reconciles an elapsed visible timer at a bounded cadence without changing readiness", () => {
    const node = depleted({
      repeatableTimerVisibility: "visible",
      repeatableReadyAt: "2026-07-29T12:00:00.000Z"
    });
    const first = repeatableTimerReconciliation(
      node,
      Date.parse("2026-07-29T12:00:01.000Z"),
      null
    );
    expect(first.request).toBe(true);
    expect(node.repeatableState).toBe("depleted");

    expect(repeatableTimerReconciliation(
      node,
      first.memory!.requestedAt
        + ELAPSED_REPEATABLE_TIMER_REFRESH_MS - 1,
      first.memory
    ).request).toBe(false);
    expect(repeatableTimerReconciliation(
      node,
      first.memory!.requestedAt + ELAPSED_REPEATABLE_TIMER_REFRESH_MS,
      first.memory
    ).request).toBe(true);
    expect(node.repeatableState).toBe("depleted");
  });

  it("does not reconcile a visible timer before its deadline", () => {
    expect(repeatableTimerReconciliation(depleted({
      repeatableTimerVisibility: "visible",
      repeatableReadyAt: "2026-07-29T12:05:00.000Z"
    }), Date.parse("2026-07-29T12:00:00.000Z"), null))
      .toEqual({ request: false, memory: null });
  });

  it("never polls an intentionally redacted timer", () => {
    const node = depleted({
      repeatableTimerVisibility: "redacted",
      repeatableReadyAt: null
    });
    expect(repeatableTimerReconciliation(node, 1_000, null))
      .toEqual({ request: false, memory: null });
    expect(repeatableTimerReconciliation(node, 60_000, null))
      .toEqual({ request: false, memory: null });
  });

  it("reconciles a malformed visible timer only once per authority revision", () => {
    const node = depleted({
      repeatableTimerVisibility: "visible",
      repeatableReadyAt: null
    });
    const first = repeatableTimerReconciliation(node, 1_000, null);
    expect(first.request).toBe(true);
    expect(repeatableTimerReconciliation(node, 60_000, first.memory).request)
      .toBe(false);
    expect(repeatableTimerReconciliation({
      ...node,
      repeatableRevision: 5
    }, 60_000, first.memory).request).toBe(true);
  });
});

function depleted(
  overrides: Partial<CollectibleNode>
): CollectibleNode {
  return {
    id: "mine-1",
    type: "stone",
    lat: 35,
    lon: -106,
    quantity: 1,
    state: "harvested",
    createdAt: "",
    harvestedAt: null,
    sourceCellId: "repeatable:mine-1",
    waterKind: null,
    presentationOwner: "repeatable-resource",
    repeatableNodeType: "stone_mine",
    repeatableState: "depleted",
    repeatableRevision: 4,
    ...overrides
  };
}
