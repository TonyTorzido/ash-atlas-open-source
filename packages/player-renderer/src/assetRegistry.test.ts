import { describe, expect, it } from "vitest";

import {
  PLAYER_APPEARANCE_ASSET_URLS,
  playerAppearanceAssetUrl,
  setRuntimePlayerAppearanceAssetUrlOverrides
} from "./assetRegistry.js";

describe("player appearance asset registry", () => {
  it("uses verified runtime artwork for an existing catalog key and restores bundled art when cleared", () => {
    const assetKey = "bodies/template7b-clean.png";
    const bundledUrl = PLAYER_APPEARANCE_ASSET_URLS[assetKey];
    expect(bundledUrl).toBeTruthy();

    setRuntimePlayerAppearanceAssetUrlOverrides([{
      assetKey,
      url: "blob:verified-player-skin"
    }]);
    expect(playerAppearanceAssetUrl(assetKey)).toBe("blob:verified-player-skin");

    setRuntimePlayerAppearanceAssetUrlOverrides([]);
    expect(playerAppearanceAssetUrl(assetKey)).toBe(bundledUrl);
  });
});
