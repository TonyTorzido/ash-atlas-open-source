import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fishingCastCameraOffset, shouldCenterCamera, shouldRequestFishingCastCamera } from "./cameraFollow.js";
import {
  PLAYER_BASE_HEIGHT_PX,
  PLAYER_BASE_ZOOM,
  PLAYER_MAX_HEIGHT_PX,
  PLAYER_MIN_HEIGHT_PX,
  playerSpriteHeightForZoom
} from "./pixiOverlay.js";
import { setWorldPngMasterScalePreview } from "./worldPngMasterScale.js";

beforeEach(() => { setWorldPngMasterScalePreview(1); });
afterEach(() => { setWorldPngMasterScalePreview(null); });

describe("camera centering policy", () => {
  it("allows only explicit camera actions", () => {
    expect(shouldCenterCamera("recenter")).toBe(true);
    expect(shouldCenterCamera("visit-flag")).toBe(true);
    expect(shouldCenterCamera("visit-city")).toBe(true);
    expect(shouldCenterCamera("fishing-cast")).toBe(true);
    expect(shouldCenterCamera("dev-teleport")).toBe(true);
  });

  it("rejects player updates and map interactions", () => {
    expect(shouldCenterCamera("player-update")).toBe(false);
    expect(shouldCenterCamera("map-interaction")).toBe(false);
  });

  it("keeps a cast point in the upper third without changing zoom", () => {
    expect(fishingCastCameraOffset(600)).toEqual([0, -100]);
    expect(fishingCastCameraOffset(0)).toEqual([0, -1]);
  });

  it("requests one reframe per accepted cast until the viewport materially changes", () => {
    const first = { key: "encounter-1:35:-106", width: 390, height: 600, profile: "phone" };
    expect(shouldRequestFishingCastCamera(null, first)).toBe(true);
    expect(shouldRequestFishingCastCamera(first, first)).toBe(false);
    expect(shouldRequestFishingCastCamera(first, { ...first, height: 679 })).toBe(false);
    expect(shouldRequestFishingCastCamera(first, { ...first, height: 680 })).toBe(true);
    expect(shouldRequestFishingCastCamera(first, { ...first, key: "encounter-2:35:-106" })).toBe(true);
  });

  it("keeps the player height floor and uncapped five-percent zoom growth", () => {
    expect(playerSpriteHeightForZoom(PLAYER_BASE_ZOOM)).toBe(PLAYER_BASE_HEIGHT_PX);
    expect(playerSpriteHeightForZoom(-20)).toBe(PLAYER_MIN_HEIGHT_PX);
    expect(PLAYER_MAX_HEIGHT_PX).toBeNull();
    expect(playerSpriteHeightForZoom(PLAYER_BASE_ZOOM + 0.1)).toBeCloseTo(28 * 1.05);
    expect(playerSpriteHeightForZoom(PLAYER_BASE_ZOOM + 3)).toBeCloseTo(28 * 1.05 ** 30);
  });
});
