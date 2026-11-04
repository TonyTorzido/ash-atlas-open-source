import { describe, expect, it } from "vitest";
import { PLAYER_BASE_HEIGHT_PX } from "@ash-atlas/player-renderer";

import {
  playerMapPresentationForZoom,
  playerMapMarkerEffectiveScreenHeightForRenderer,
  playerMapMarkerRootScaleForRenderer,
  PLAYER_MAP_MARKER_MIN_SCREEN_HEIGHT_PX
} from "../map/spritePresentation.js";
import {
  WORLD_MAP_REMOTE_PLAYER_SCALE,
  worldMapPlayerMarkerRenderHeight
} from "./worldMapPlayerMarker.js";

describe("World Map player marker height", () => {
  it("keeps remote player art at exactly three-quarter local scale", () => {
    expect(WORLD_MAP_REMOTE_PLAYER_SCALE).toBe(0.75);
  });

  it("accounts for player scale when preserving top padding", () => {
    expect(worldMapPlayerMarkerRenderHeight(-300, 0.25)).toBe(81);
    expect(worldMapPlayerMarkerRenderHeight(-300, 0.5)).toBe(156);
  });

  it("uses the shared restrained globe marker floor for shallow appearance bounds", () => {
    const rootScale = playerMapMarkerRootScaleForRenderer(1.3);
    expect(worldMapPlayerMarkerRenderHeight(-40, rootScale)).toBe(36);
    expect(playerMapMarkerEffectiveScreenHeightForRenderer(1.3))
      .toBe(PLAYER_MAP_MARKER_MIN_SCREEN_HEIGHT_PX);
  });

  it("keeps regular Pixi and standalone canvas player pixels equivalent", () => {
    for (const rendererOverallScale of [0.8, 1, 1.3]) {
      const regular = playerMapPresentationForZoom(0, rendererOverallScale);
      const standaloneRootScale = playerMapMarkerRootScaleForRenderer(
        rendererOverallScale
      );
      const standalone = PLAYER_BASE_HEIGHT_PX *
        rendererOverallScale * standaloneRootScale;

      expect(regular.screenHeightPx).toBeCloseTo(standalone);
      expect(standalone).toBeCloseTo(PLAYER_MAP_MARKER_MIN_SCREEN_HEIGHT_PX);
      expect(regular.artworkHeightPx / PLAYER_BASE_HEIGHT_PX)
        .toBeCloseTo(playerMapMarkerRootScaleForRenderer(rendererOverallScale));
    }
  });
});
