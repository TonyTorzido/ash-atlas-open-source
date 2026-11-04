import { describe, expect, it } from "vitest";

import { relocationCooldownBlocksRelocate } from "./relocationAvailability.js";

describe("relocationCooldownBlocksRelocate", () => {
  it("blocks only during a cooldown without a server exemption", () => {
    expect(relocationCooldownBlocksRelocate(0, false)).toBe(false);
    expect(relocationCooldownBlocksRelocate(0, true)).toBe(false);
    expect(relocationCooldownBlocksRelocate(3_600, false)).toBe(true);
    expect(relocationCooldownBlocksRelocate(3_600, true)).toBe(false);
  });
});
