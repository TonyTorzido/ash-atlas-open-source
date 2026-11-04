import { describe, expect, it } from "vitest";
import { hasUsableElementDimensions } from "./elementDimensions.js";

describe("hasUsableElementDimensions", () => {
  it("accepts a visible mobile viewport", () => {
    expect(hasUsableElementDimensions({ getBoundingClientRect: () => ({ width: 390, height: 844 }) as DOMRect })).toBe(true);
  });
  it("rejects a zero-sized render target", () => {
    expect(hasUsableElementDimensions({ getBoundingClientRect: () => ({ width: 390, height: 0 }) as DOMRect })).toBe(false);
  });
});
