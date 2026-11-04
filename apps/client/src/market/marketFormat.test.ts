import { describe, expect, it } from "vitest";

import {
  calculateMarketFee,
  compareMarketIntegers,
  formatGold,
  multiplyMarketIntegers,
  normalizePositiveMarketInput,
  parseMarketInteger
} from "./marketFormat.js";

describe("market integer formatting", () => {
  it("keeps economic arithmetic exact with bigint wire values", () => {
    expect(parseMarketInteger("9007199254740993")).toBe(9_007_199_254_740_993n);
    expect(multiplyMarketIntegers("1000000000", "10000")).toBe(10_000_000_000_000n);
    expect(calculateMarketFee(19_999n, 125)).toBe(249n);
    expect(formatGold("9007199254740993")).toBe("9,007,199,254,740,993 gold");
  });

  it("rejects noncanonical input instead of silently coercing it", () => {
    for (const value of ["", "0", "-1", "1.5", "1e3", "000", "10000000000000000000"]) {
      expect(normalizePositiveMarketInput(value)).toBeNull();
    }
    expect(normalizePositiveMarketInput("00012")).toBe("12");
    expect(() => parseMarketInteger("1e3")).toThrow("Invalid market integer");
  });

  it("sorts nullable asks without converting them to Number", () => {
    expect(compareMarketIntegers("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareMarketIntegers(null, "1")).toBe(1);
    expect(compareMarketIntegers("1", null)).toBe(-1);
  });
});
