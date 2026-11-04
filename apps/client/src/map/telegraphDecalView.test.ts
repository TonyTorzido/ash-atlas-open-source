import { Graphics } from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MOB_SIGNATURES } from "@ash-atlas/shared";
import {
  TELEGRAPH_DEFAULT_PALETTE,
  TELEGRAPH_DECAL,
  TELEGRAPH_SIGNATURE_OUTLINE_SCALE,
  TelegraphDecalView,
  createTelegraphScreenShape,
  telegraphMarksForAbility
} from "./telegraphDecal.js";

afterEach(() => vi.restoreAllMocks());

function circle(ox: number) {
  return { ...createTelegraphScreenShape(), kind: "circle" as const, ox, oy: 40, radius: 90 };
}

function line(dir: number) {
  return { ...createTelegraphScreenShape(), kind: "line" as const, ox: 200, oy: 200, reach: 160, halfWidth: 12, dir };
}

describe("telegraph decal view", () => {
  it("draws a signature with the heavier outline (and a basic with the normal one)", () => {
    const stroke = vi.spyOn(Graphics.prototype, "stroke");
    const widths = (signature: boolean): number[] => {
      stroke.mockClear();
      const view = new TelegraphDecalView();
      view.update(circle(100), 0.3, -1, 9, "none", TELEGRAPH_DEFAULT_PALETTE, 1, false, 1_000, signature);
      const result = stroke.mock.calls.map(([style]) => (style as { width?: number }).width ?? 0);
      view.destroy();
      return result;
    };
    const basic = widths(false);
    const signature = widths(true);
    expect(basic).toContain(TELEGRAPH_DECAL.outlineWidth);
    expect(basic).not.toContain(TELEGRAPH_DECAL.outlineWidth * TELEGRAPH_SIGNATURE_OUTLINE_SCALE);
    expect(signature).toContain(TELEGRAPH_DECAL.outlineWidth * TELEGRAPH_SIGNATURE_OUTLINE_SCALE);
    expect(signature.length).toBeGreaterThan(basic.length);
  });

  it("one caster's three volley lines draw as three independent decals", () => {
    const facings = [-0.3, 0, 0.3];
    const views = facings.map(() => new TelegraphDecalView());
    views.forEach((view, index) => {
      expect(view.update(line(facings[index]!), 0.5, -1, 11 + index, telegraphMarksForAbility(MOB_SIGNATURES.volley.abilityIds[index]!, "line"),
        TELEGRAPH_DEFAULT_PALETTE, 1, false, 1_000, true)).toBe(true);
    });
    expect(views.map((view) => view.root.rotation)).toEqual(facings);
    expect(views.every((view) => view.root.visible)).toBe(true);
    expect(new Set(views.map((view) => view.root)).size).toBe(3);
    for (const view of views) view.destroy();
  });

  it("marks: the lunge lane gets chevrons like the charge", () => {
    expect(telegraphMarksForAbility("pack_lunge", "line")).toBe("chevrons");
    expect(telegraphMarksForAbility("brute_charge", "line")).toBe("chevrons");
    expect(telegraphMarksForAbility("brute_slam", "circle")).toBe("cracks");
  });

  it("does not re-tessellate its static layers as the warning advances or the camera pans", () => {
    const clear = vi.spyOn(Graphics.prototype, "clear");
    const view = new TelegraphDecalView();
    view.update(circle(100), 0.1, -1, 7, "none", TELEGRAPH_DEFAULT_PALETTE, 1, false, 1_000);
    const afterFirst = clear.mock.calls.length;
    view.update(circle(100), 0.4, -1, 7, "none", TELEGRAPH_DEFAULT_PALETTE, 1, false, 1_100);
    view.update(circle(160), 0.7, -1, 7, "none", TELEGRAPH_DEFAULT_PALETTE, 1, false, 1_200);
    // Only the growing-fill layer is cleared per frame; stamp, tint, outline and inner line are kept.
    expect(clear.mock.calls.length - afterFirst).toBeLessThanOrEqual(2);
    expect(view.root.position.x).toBe(160);
    view.destroy();
  });

  it("rebuilds the static layers when the shape size changes and hides when faint", () => {
    const view = new TelegraphDecalView();
    expect(view.update(circle(0), 0.5, -1, 7, "none", TELEGRAPH_DEFAULT_PALETTE, 1, false, 0)).toBe(true);
    const clear = vi.spyOn(Graphics.prototype, "clear");
    view.update({ ...circle(0), radius: 120 }, 0.5, -1, 7, "none", TELEGRAPH_DEFAULT_PALETTE, 1, false, 0);
    expect(clear.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(view.update(circle(0), 0.5, -1, 7, "none", TELEGRAPH_DEFAULT_PALETTE, 0, false, 0)).toBe(false);
    expect(view.root.visible).toBe(false);
    view.destroy();
  });
});
