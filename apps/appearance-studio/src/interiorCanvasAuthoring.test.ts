import { describe, expect, it } from "vitest";

import { shouldClosePolygon } from "./interiorCanvasAuthoring.js";

describe("interior canvas authoring", () => {
  it("closes every polygon tool from the highlighted first dot after three vertices", () => {
    const draft = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }];
    expect(shouldClosePolygon(draft, { x: 117, y: 112 })).toBe(true);
    expect(shouldClosePolygon(draft, { x: 130, y: 100 })).toBe(false);
    expect(shouldClosePolygon(draft.slice(0, 2), draft[0]!)).toBe(false);
  });
});
