import { describe, expect, it } from "vitest";

import { HoldTapTracker, X_HOLD_MS, selectQuickAction, type QuickCandidate } from "./quickActionSelection.js";

const items: QuickCandidate[] = [
  { kind: "attack", id: "mob-near", distanceM: 20 },
  { kind: "harvest", id: "tree", distanceM: 40 },
  { kind: "pickup", id: "drop", distanceM: 30 },
  { kind: "harvest", id: "far", distanceM: 151 }
];

describe("quick action selection", () => {
  it("ignores attackable targets unless Aggressive", () => {
    expect(selectQuickAction(items, { aggressive: false })?.id).toBe("drop");
    expect(selectQuickAction(items, { aggressive: true })?.id).toBe("mob-near");
  });

  it("searches up to 150 m and picks the closest", () => {
    expect(selectQuickAction([{ kind: "harvest", id: "edge", distanceM: 150 }], { aggressive: false })?.id).toBe("edge");
    expect(selectQuickAction([{ kind: "harvest", id: "far", distanceM: 150.5 }], { aggressive: true })).toBeNull();
    expect(selectQuickAction([], { aggressive: true })).toBeNull();
  });
});

describe("X hold versus tap", () => {
  it("acts on a quick release and does not toggle", () => {
    const x = new HoldTapTracker();
    x.down(0);
    expect(x.poll(X_HOLD_MS - 1)).toBeNull();
    expect(x.up(X_HOLD_MS - 1)).toBe("tap");
  });

  it("toggles once at the hold time and its release is not a tap", () => {
    const x = new HoldTapTracker();
    x.down(1000);
    expect(x.poll(1000 + X_HOLD_MS)).toBe("toggle");
    expect(x.poll(1000 + X_HOLD_MS + 50)).toBeNull();
    expect(x.up(1000 + X_HOLD_MS + 200)).toBeNull();
  });

  it("does not tap on a release that never started", () => {
    expect(new HoldTapTracker().up(10)).toBeNull();
  });
});
