import { setWorldPngMasterScalePreview } from "../map/worldPngMasterScale.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEV_PNG_ASSETS } from "./devPngCatalog.js";
import { calculateDevPngSize, formatDevPngDimensions } from "./devPngSizing.js";

// Exercise authored dimensions independently of the production master multiplier.
beforeEach(() => { setWorldPngMasterScalePreview(1); });
afterEach(() => { setWorldPngMasterScalePreview(null); });

describe("PNG Lab sizing authority", () => {
  it("applies the multiplier to fixed production dimensions without zoom drift", () => {
    const asset = DEV_PNG_ASSETS.find(({ productionSize }) => productionSize?.kind === "fixed")!;
    const first = calculateDevPngSize(asset, { width: 999, height: 333 }, 10, 1.5);
    const second = calculateDevPngSize(asset, { width: 999, height: 333 }, 18, 1.5);
    expect(first).toEqual(second);
    expect(first.width).toBe(asset.productionSize!.kind === "fixed" ? asset.productionSize!.width * 1.5 : 0);
  });

  it("preserves intrinsic aspect ratio for zoom-scaled production sizing", () => {
    const asset = DEV_PNG_ASSETS.find(({ productionSize }) => productionSize?.kind === "zoom-scaled")!;
    const size = calculateDevPngSize(asset, { width: 200, height: 100 }, 14, 2);
    expect(size.width).toBeCloseTo(size.height! * 2);
    expect(size.basis).toBe("zoom-scaled production");
  });

  it("labels unknown production sizes as intrinsic fallback without inventing dimensions", () => {
    const asset = DEV_PNG_ASSETS.find(({ productionSize, placeable }) => !productionSize && placeable)!;
    expect(calculateDevPngSize(asset, null, 14, 1)).toMatchObject({
      width: null,
      height: null,
      basis: "intrinsic fallback"
    });
    expect(formatDevPngDimensions(calculateDevPngSize(asset, { width: 48, height: 72 }, 14, 1.5))).toBe("72 × 108 px");
  });
});
