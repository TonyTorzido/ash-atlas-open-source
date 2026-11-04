import { describe, expect, it } from "vitest";

import { angleDiffDeg, minSlotAngleDeg, reachableArcHalfDeg } from "@ash-atlas/shared";
import { assignRings, relaxSlots, TokenLedger, type RingItem } from "./mobTactics.js";

describe("mob tactics chunk 4 pure pieces", () => {
  it("reachableArcHalfDeg: whole ring, partial arc, unreachable", () => {
    expect(reachableArcHalfDeg(85, 50, 160)).toBe(180);
    expect(reachableArcHalfDeg(85, 185, 0)).toBe(180);
    expect(reachableArcHalfDeg(85, 185, 160)).toBeCloseTo(59.7, 0);
    expect(reachableArcHalfDeg(85, 400, 160)).toBe(0);
  });

  it("spreads slots evenly inside a reachable arc instead of bunching at its edge", () => {
    const items = ["a", "b", "c", "d"].map((id, index) => ({
      id, bearingDeg: 88 + index, prevSlotDeg: null, arcCenterDeg: 90, arcHalfDeg: 60
    }));
    const slots = [...relaxSlots(items, 85).values()].sort((left, right) => left - right);
    const min = minSlotAngleDeg(85);
    for (const slot of slots) expect(Math.abs(angleDiffDeg(90, slot))).toBeLessThanOrEqual(60 + 1e-6);
    for (let index = 1; index < slots.length; index += 1) {
      expect(slots[index]! - slots[index - 1]!).toBeGreaterThanOrEqual(min - 1e-6);
    }
  });

  it("assignRings: engage seats cap and waiting-time order without occupant preference", () => {
    const item = (id: string, score: number, currentRing: RingItem["currentRing"]): RingItem =>
      ({ id, pool: "melee", score, attackRangeM: 100, currentRing });
    const rings = assignRings(
      [item("occupant", 100, "engage"), item("waiter", 5_000, "wait"), item("other", 50, "engage")],
      { engageSeats: 1, preferCurrent: false }
    );
    expect(rings.get("waiter")!.ring).toBe("engage");
    expect(rings.get("occupant")!.ring).toBe("wait");
    expect(rings.get("other")!.ring).toBe("wait");
    // Default keeps occupants first (chunk 2 behaviour).
    expect(assignRings([item("occupant", 100, "engage"), item("waiter", 5_000, "wait")], { engageSeats: 1 }).get("occupant")!.ring)
      .toBe("engage");
  });

  it("validate returns a shared empty result when nothing is stale", () => {
    const ledger = new TokenLedger("p", 20);
    expect(ledger.validate(() => true, 1)).toBe(ledger.validate(() => true, 2));
  });
});
