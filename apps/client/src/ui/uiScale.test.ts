import { describe, expect, it } from "vitest";

import { desktopWidthTier, effectiveUiScale } from "./uiScale.js";

describe("desktop interface size", () => {
  it("uses the chosen size when the window can hold a 1100 × 600 scaled layout", () => {
    expect(effectiveUiScale(1.5, 1920, 1000)).toBe(1.5);
    expect(effectiveUiScale(0.9, 1100, 600)).toBe(0.9);
  });

  it("shrinks a large size only as far as the window requires, never below 100%", () => {
    expect(effectiveUiScale(1.5, 1280, 720)).toBeCloseTo(1280 / 1100);
    expect(effectiveUiScale(1.5, 1100, 620)).toBe(1);
  });

  it("drops command labels by scaled width, not screen width", () => {
    expect(desktopWidthTier(1920 / 1.5)).toBe("medium");
    expect(desktopWidthTier(1920)).toBe("wide");
    expect(desktopWidthTier(1280 / 1.164)).toBe("narrow");
  });
});

describe("interface size range", () => {
  it("clamps to 50–150% and snaps to 5% steps", async () => {
    const { normalizeUiScale } = await import("./uiScale.js");
    expect(normalizeUiScale(0.3)).toBe(0.5);
    expect(normalizeUiScale(2)).toBe(1.5);
    expect(normalizeUiScale(0.92)).toBeCloseTo(0.9);
    expect(normalizeUiScale(Number.NaN)).toBe(1);
  });

  it("keeps a chosen size below 100% as-is", () => {
    expect(effectiveUiScale(0.5, 1920, 1080)).toBe(0.5);
  });
});
