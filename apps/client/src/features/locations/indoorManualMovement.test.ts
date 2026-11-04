import { describe, expect, it, vi } from "vitest";

import {
  isIndoorManualMovementDisabled,
  runIndoorManualMovement
} from "./indoorManualMovement.js";

describe("indoor manual movement", () => {
  it("cancels the portal transition before running and returning the movement result", () => {
    const order: string[] = [];
    const cancel = vi.fn(() => { order.push("cancel"); });
    const result = runIndoorManualMovement(cancel, () => {
      order.push("move");
      return "sent" as const;
    });
    expect(order).toEqual(["cancel", "move"]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(result).toBe("sent");
  });

  it.each([
    ["idle", false],
    ["requesting", false],
    ["approaching", false],
    ["threshold_reached", false],
    ["covered", true],
    ["committed", true],
    ["revealing", true],
    ["failed", false]
  ] as const)("applies the online movement lock for %s", (phase, expected) => {
    expect(isIndoorManualMovementDisabled(true, phase)).toBe(expected);
    expect(isIndoorManualMovementDisabled(false, phase)).toBe(true);
  });
});
