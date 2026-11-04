import { describe, expect, it, vi } from "vitest";
import { layoutPhoneActions, type PhoneAction } from "./phoneActionModel.js";

const action = (id: string, priority: number, preferredSide?: "left" | "right"): PhoneAction => ({
  id, label: id, icon: "more", category: "context", priority,
  ...(preferredSide ? { preferredSide } : {}),
  enabled: true, execute: vi.fn()
});

describe("phone action presentation", () => {
  it("prioritizes six direct actions and overflows the rest", () => {
    const result = layoutPhoneActions(Array.from({ length: 8 }, (_, index) => action(`a${index}`, 8 - index)), "right");
    expect(result.left).toHaveLength(3);
    expect(result.right).toHaveLength(3);
    expect(result.overflow.map(({ id }) => id)).toEqual(["a6", "a7"]);
  });

  it("mirrors preferred sides for left-handed play", () => {
    const actions = [action("attack", 10, "right"), action("build", 5, "left")];
    expect(layoutPhoneActions(actions, "right").right[0]?.id).toBe("attack");
    expect(layoutPhoneActions(actions, "left").left[0]?.id).toBe("attack");
  });

  it("removes contextual actions as soon as callers remove them", () => {
    expect(layoutPhoneActions([action("pickup", 10)], "right").left.concat(layoutPhoneActions([action("pickup", 10)], "right").right)).toHaveLength(1);
    expect(layoutPhoneActions([], "right")).toMatchObject({ left: [], right: [], overflow: [] });
  });

  it("keeps deliberate low-priority actions in overflow even when rail space exists", () => {
    const foundCity = { ...action("found-city", 1), overflowOnly: true };
    expect(layoutPhoneActions([foundCity], "right")).toMatchObject({ left: [], right: [], overflow: [foundCity] });
  });
});
