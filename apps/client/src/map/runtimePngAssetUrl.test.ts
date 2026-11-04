import { afterEach, describe, expect, it, vi } from "vitest";

import {
  greenhouseCropStageAssetUrl,
  runtimePngAssetUrl,
  selectedRuntimePngContentPack,
  setRuntimePngAssetUrlOverrides
} from "./runtimePngAssetUrl.js";

afterEach(() => setRuntimePngAssetUrlOverrides([]));

describe("runtime PNG asset URL resolver", () => {
  it("resolves an authored canonical client PNG", () => {
    expect(runtimePngAssetUrl("apps/client/src/assets/deer.png")).toBeTruthy();
  });

  it("resolves all four authored Giving Berry tree stages", () => {
    for (const name of ["seedling", "middle-2", "fruiting", "mature"]) {
      expect(runtimePngAssetUrl(`apps/client/src/assets/plants/giving-berry-tree-${name}.png`)).toBeTruthy();
    }
  });

  it("resolves bundled registered slots and keeps unknown paths on the fallback path", () => {
    expect(runtimePngAssetUrl("apps/client/src/assets/military/units/infantry.png"))
      .toBeTruthy();
    expect(runtimePngAssetUrl("apps/client/src/assets/structures/loom.png"))
      .toBeTruthy();
    expect(runtimePngAssetUrl("apps/client/src/assets/structures/not-authored.png"))
      .toBeNull();
    expect(runtimePngAssetUrl("apps/client/public/military/infantry.png")).toBeNull();
  });

  it("uses the verified session override for a registered path and falls back after it is cleared", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const path = "apps/client/src/assets/chat-crests/lion.png";
    setRuntimePngAssetUrlOverrides([{ relativeFile: path, url: "blob:verified-content-pack" }]);
    expect(runtimePngAssetUrl(path)).toBe("blob:verified-content-pack");

    setRuntimePngAssetUrlOverrides([]);

    expect(runtimePngAssetUrl(path)).toBeTruthy();
    expect(revoke).toHaveBeenCalledWith("blob:verified-content-pack");
    revoke.mockRestore();
  });

  it("pins the selected pack identity and crop presentation catalog for the session", () => {
    const catalog = [{
      cropId: "wheat",
      displayName: "Wheat",
      seedDisplayName: "Wheat Seed",
      seedItemId: "wheat_seed" as const,
      seedVariant: null,
      stages: [1, 2, 3, 4].map((stage) => ({
        stage,
        artId: `wheat_stage_${stage}`,
        assetId: `wheat-stage-${stage}`,
        pivotX: 0.5,
        pivotY: 0.5,
        offsetX: 0,
        offsetY: 0,
        scale: 0.8
      }))
    }];
    const packId = "a".repeat(64);

    setRuntimePngAssetUrlOverrides([], packId, catalog, [1, 2, 3, 4].map((stage) => ({
      cropId: "wheat",
      stage,
      url: `blob:wheat-stage-${stage}`
    })));

    expect(selectedRuntimePngContentPack()).toEqual({ packId, greenhouseCropPresentations: catalog });
    expect(greenhouseCropStageAssetUrl("wheat", 2)).toBe("blob:wheat-stage-2");
    expect(greenhouseCropStageAssetUrl("moonbean", 2)).toBeNull();
    setRuntimePngAssetUrlOverrides([]);
    expect(selectedRuntimePngContentPack()).toEqual({ packId: null, greenhouseCropPresentations: [] });
    expect(greenhouseCropStageAssetUrl("wheat", 2)).toBeNull();
  });
});
