import { setWorldPngMasterScalePreview } from "./worldPngMasterScale.js";
import { PLAYER_BASE_HEIGHT_PX } from "@ash-atlas/player-renderer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAP_ZOOM,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  MOBILE_MIN_MAP_ZOOM
} from "./createMap.js";
import {
  SPRITE_BASE_ZOOM,
  SPRITE_PRESENTATION,
  dungeonMobVisualHeight,
  dungeonProjectileBaseScale,
  groundItemVisualHeight,
  playerMapMarkerArtworkHeightForZoom,
  playerMapMarkerEffectiveScreenHeightForRenderer,
  playerMapHealthBarVisibleForZoom,
  playerMapMarkerRootScaleForRenderer,
  playerMapMarkerScreenHeightForZoom,
  playerMapMarkerModeForZoom,
  playerMapPresentationForZoom,
  PLAYER_MAP_MARKER_MIN_SCREEN_HEIGHT_PX,
  PLAYER_MAP_MARKER_TRANSITION_START_ZOOM,
  PLAYER_MAP_MARKER_ZOOM_THRESHOLD,
  spriteHeightForZoom,
  spriteLayoutForZoom,
  staticSpriteLocalScaleDuringTransform,
  textureScaleForHeight,
  worldMobPlayerSizeRatio,
  worldGroundItemVisualHeight
} from "./spritePresentation.js";

// Exercise authored dimensions independently of the production master multiplier.
beforeEach(() => { setWorldPngMasterScalePreview(1); });
afterEach(() => { setWorldPngMasterScalePreview(null); });

describe("world sprite zoom presentation", () => {
  it("uses the authoritative default map zoom and requested baseline heights", () => {
    expect(SPRITE_BASE_ZOOM).toBe(DEFAULT_MAP_ZOOM);
    const heights = baseHeights();
    expect(Object.keys(heights).sort()).toEqual(Object.keys(SPRITE_PRESENTATION).sort());
    expect(heights).toMatchObject({
      alligator: 57,
      bear: 65.5,
      buoy: 61.5,
      chinesePistache: 81.5,
      city: 87.7,
      coalMine: 87.8,
      coastalCrab: 40,
      deer: 69.5,
      dog: 38.7,
      fireBird: 100,
      flax: 54,
      flag: 37.5,
      frog: 43.2,
      // Canvas-relative bases: the redrawn goblin / healer / traveler PNGs fill 60-80% of their canvas, so
      // these restore the original on-screen heights (49 / 50.9 / 55.7 px visible). See spriteSizeGuard.test.ts.
      genericMob: 54,
      hog: 66.2,
      iceBird: 100,
      ironMine: 87.8,
      jellyfish: 42,
      kingdomSeat: 140,
      leather: 28,
      lightningBird: 100,
      mysteriousTraveler: 68.4,
      ogre: 67.2,
      goblinBasic: 73,
      goblinWarrior: 51.8,
      goblinArcher: 55.7,
      goblinHealer: 59.4,
      goblinHall: 125.3,
      player: 28,
      sapCrawler: 54.6,
      squid: 56,
      stone: 28,
      stoneMine: 87.8,
      sulfurMine: 50,
      tree: 86.4,
      willowTree: 113.8,
      wolf: 65.4,
      wood: 28
    });
    for (const presentation of Object.values(SPRITE_PRESENTATION)) {
      expect(spriteHeightForZoom(
        SPRITE_BASE_ZOOM,
        SPRITE_BASE_ZOOM,
        presentation
      )).toBe(presentation.baseHeightPx);
    }
  });

  it("uses the reference player dimensions without changing local or remote presentation", () => {
    const localHeight = spriteHeightForZoom(
      SPRITE_BASE_ZOOM,
      SPRITE_BASE_ZOOM,
      SPRITE_PRESENTATION.player
    );
    const remoteHeight = spriteHeightForZoom(
      SPRITE_BASE_ZOOM,
      SPRITE_BASE_ZOOM,
      SPRITE_PRESENTATION.player
    );

    expect(localHeight).toBe(28);
    expect(remoteHeight).toBe(localHeight);
    expect(SPRITE_PRESENTATION.player.minHeightPx).toBe(7);
    expect(SPRITE_PRESENTATION.player.maxHeightPx).toBeNull();
  });

  it("transitions continuously from local rendering into the shared globe marker", () => {
    const local = playerMapPresentationForZoom(
      PLAYER_MAP_MARKER_TRANSITION_START_ZOOM,
      1,
      true
    );
    const localNaturalHeight = spriteHeightForZoom(
      PLAYER_MAP_MARKER_TRANSITION_START_ZOOM,
      SPRITE_BASE_ZOOM,
      SPRITE_PRESENTATION.player
    );
    expect(local.mode).toBe("local");
    expect(local.transitionProgress).toBe(0);
    expect(local.screenHeightPx).toBe(localNaturalHeight);
    expect(local.healthBarVisible).toBe(true);

    const midpointZoom = (
      PLAYER_MAP_MARKER_TRANSITION_START_ZOOM + PLAYER_MAP_MARKER_ZOOM_THRESHOLD
    ) / 2;
    const midpoint = playerMapPresentationForZoom(midpointZoom, 1, true);
    expect(midpoint.mode).toBe("transition");
    expect(midpoint.transitionProgress).toBeCloseTo(0.5);
    expect(midpoint.screenHeightPx).toBeGreaterThan(local.screenHeightPx);
    expect(midpoint.screenHeightPx).toBeLessThan(PLAYER_MAP_MARKER_MIN_SCREEN_HEIGHT_PX);
    expect(midpoint.healthBarVisible).toBe(false);

    const marker = playerMapPresentationForZoom(
      PLAYER_MAP_MARKER_ZOOM_THRESHOLD,
      1,
      true
    );
    expect(marker.mode).toBe("marker");
    expect(marker.transitionProgress).toBe(1);
    expect(marker.screenHeightPx).toBe(PLAYER_MAP_MARKER_MIN_SCREEN_HEIGHT_PX);
    expect(marker.healthBarVisible).toBe(false);
    expect(playerMapMarkerModeForZoom(PLAYER_MAP_MARKER_ZOOM_THRESHOLD)).toBe(true);
    expect(playerMapMarkerScreenHeightForZoom(PLAYER_MAP_MARKER_ZOOM_THRESHOLD))
      .toBe(PLAYER_MAP_MARKER_MIN_SCREEN_HEIGHT_PX);

    for (const boundary of [
      PLAYER_MAP_MARKER_TRANSITION_START_ZOOM,
      PLAYER_MAP_MARKER_ZOOM_THRESHOLD
    ]) {
      const before = playerMapPresentationForZoom(boundary - 0.001).screenHeightPx;
      const after = playerMapPresentationForZoom(boundary + 0.001).screenHeightPx;
      expect(Math.abs(before - after)).toBeLessThan(0.05);
    }
  });

  it("matches the standalone canvas marker after renderer transforms", () => {
    for (const rendererScale of [0.8, 1, 1.3]) {
      const regular = playerMapPresentationForZoom(
        PLAYER_MAP_MARKER_ZOOM_THRESHOLD,
        rendererScale
      );
      const standaloneRootScale = playerMapMarkerRootScaleForRenderer(rendererScale);
      const standaloneEffectiveHeight =
        PLAYER_BASE_HEIGHT_PX * rendererScale * standaloneRootScale;

      expect(regular.screenHeightPx).toBeCloseTo(standaloneEffectiveHeight);
      expect(playerMapMarkerEffectiveScreenHeightForRenderer(rendererScale))
        .toBeCloseTo(standaloneEffectiveHeight);
      expect(regular.artworkHeightPx).toBeCloseTo(
        PLAYER_BASE_HEIGHT_PX * playerMapMarkerRootScaleForRenderer(rendererScale)
      );
      expect(regular.artworkHeightPx / PLAYER_BASE_HEIGHT_PX)
        .toBeCloseTo(playerMapMarkerRootScaleForRenderer(rendererScale));
    }
  });

  it("keeps equivalent globe zooms monotonic and preserves close local state", () => {
    expect(playerMapHealthBarVisibleForZoom(PLAYER_MAP_MARKER_TRANSITION_START_ZOOM + 1, true))
      .toBe(true);
    expect(playerMapHealthBarVisibleForZoom(PLAYER_MAP_MARKER_ZOOM_THRESHOLD, false)).toBe(false);

    const zooms = [
      PLAYER_MAP_MARKER_ZOOM_THRESHOLD,
      5,
      6,
      7,
      PLAYER_MAP_MARKER_TRANSITION_START_ZOOM,
      PLAYER_MAP_MARKER_TRANSITION_START_ZOOM + 1
    ];
    const heights = zooms.map((zoom) => playerMapMarkerScreenHeightForZoom(zoom));
    for (let index = 1; index < heights.length; index += 1) {
      expect(heights[index]).toBeLessThanOrEqual(heights[index - 1]!);
    }
    expect(playerMapMarkerArtworkHeightForZoom(
      PLAYER_MAP_MARKER_TRANSITION_START_ZOOM + 1,
      1.65
    )).toBeCloseTo(spriteHeightForZoom(
      PLAYER_MAP_MARKER_TRANSITION_START_ZOOM + 1,
      SPRITE_BASE_ZOOM,
      SPRITE_PRESENTATION.player
    ));
  });

  it("composes mob master scale and player renderer scales for dungeon sizing", () => {
    setWorldPngMasterScalePreview(1.2);
    const expectedRatio = 57 * 1.2 / (28 * 1.65 * 1.3);

    expect(worldMobPlayerSizeRatio(SPRITE_PRESENTATION.alligator))
      .toBeCloseTo(expectedRatio);
    expect(dungeonMobVisualHeight(35, SPRITE_PRESENTATION.alligator, 1.25))
      .toBeCloseTo(35 * 1.65 * 1.3 * expectedRatio * 1.25);
  });

  it("uses the dungeon player target height as the shared projectile base scale", () => {
    expect(dungeonProjectileBaseScale(35)).toBeCloseTo(35 / SPRITE_PRESENTATION.player.baseHeightPx);
    expect(dungeonProjectileBaseScale(35) * 0.04).toBeCloseTo(0.05);
    expect(dungeonProjectileBaseScale(35) * 0.0125).toBeCloseTo(0.015625);
    expect(dungeonProjectileBaseScale(35) * 0.05).toBeCloseTo(0.0625);
  });

  it("keeps item ground height proportional across outdoor, Manor, and dungeon players", () => {
    const item = SPRITE_PRESENTATION.iron_bar;
    const manorHeight = groundItemVisualHeight(70, item);
    const dungeonHeight = groundItemVisualHeight(52.5, item);
    const outdoorHeight = worldGroundItemVisualHeight(item);

    expect(outdoorHeight).toBeCloseTo(item.baseHeightPx);
    expect(manorHeight / 70).toBeCloseTo(outdoorHeight / item.baseHeightPx);
    expect(dungeonHeight / 52.5).toBeCloseTo(outdoorHeight / item.baseHeightPx);

    const zoom = SPRITE_BASE_ZOOM + 0.8;
    const zoomedOutdoorHeight = worldGroundItemVisualHeight(item, zoom);
    const zoomedPlayerHeight = spriteHeightForZoom(
      zoom,
      SPRITE_BASE_ZOOM,
      SPRITE_PRESENTATION.player
    ) * 1.65 * 1.3;
    expect(zoomedOutdoorHeight / zoomedPlayerHeight)
      .toBeCloseTo(outdoorHeight / (28 * 1.65 * 1.3));

    const largerItem = {
      ...item,
      baseHeightPx: 56,
      minHeightPx: 14
    };
    expect(groundItemVisualHeight(70, largerItem)).toBeCloseTo(140);
  });

  it("keeps the effective mob-to-player ratio stable across the shared zoom policy", () => {
    setWorldPngMasterScalePreview(1.2);
    const expectedRatio = 73 * 1.2 / (28 * 1.65 * 1.3);
    for (const zoom of [MOBILE_MIN_MAP_ZOOM, SPRITE_BASE_ZOOM, 15.5, MAX_MAP_ZOOM]) {
      expect(worldMobPlayerSizeRatio(SPRITE_PRESENTATION.goblinBasic, zoom))
        .toBeCloseTo(expectedRatio);
    }
  });

  it("uses a 150% flag baseline with the shared zoom scaling and stable anchors", () => {
    const previousFlagHeight = 25;
    const presentation = SPRITE_PRESENTATION.flag;
    expect(presentation.baseHeightPx).toBe(previousFlagHeight * 1.5);
    expect(presentation.anchorX).toBe(0.5);
    expect(presentation.anchorY).toBe(1);

    const minimumZoomHeight = spriteHeightForZoom(
      MIN_MAP_ZOOM,
      SPRITE_BASE_ZOOM,
      presentation
    );
    const maximumZoomHeight = spriteHeightForZoom(
      MAX_MAP_ZOOM,
      SPRITE_BASE_ZOOM,
      presentation
    );
    expect(minimumZoomHeight).toBeGreaterThanOrEqual(presentation.minHeightPx);
    expect(minimumZoomHeight).toBeLessThan(presentation.baseHeightPx);
    expect(maximumZoomHeight).toBeGreaterThan(presentation.baseHeightPx);
  });

  it("keeps flag world coordinates fixed while zoom changes", () => {
    const point = { x: 412.25, y: 267.75 };
    const minimum = spriteLayoutForZoom(
      point.x,
      point.y,
      25,
      MIN_MAP_ZOOM,
      SPRITE_PRESENTATION.flag
    );
    const maximum = spriteLayoutForZoom(
      point.x,
      point.y,
      25,
      MAX_MAP_ZOOM,
      SPRITE_PRESENTATION.flag
    );

    expect(minimum).toMatchObject(point);
    expect(maximum).toMatchObject(point);
    expect(minimum.scale).not.toBe(maximum.scale);
  });

  it("grows every representative sprite by exactly 5% per +0.1 zoom without an upper cap", () => {
    const expectedRatio = (zoom: number) => Math.max(
      0.25,
      2 ** ((zoom - 15) * 0.70389327891398)
    );
    for (const presentation of [
      SPRITE_PRESENTATION.genericMob,
      SPRITE_PRESENTATION.tree,
      SPRITE_PRESENTATION.stone,
      SPRITE_PRESENTATION.city
    ]) {
      for (const zoom of [MOBILE_MIN_MAP_ZOOM, SPRITE_BASE_ZOOM, 15.1, 15.2, MAX_MAP_ZOOM]) {
        expect(spriteHeightForZoom(zoom, SPRITE_BASE_ZOOM, presentation) /
          presentation.baseHeightPx).toBeCloseTo(expectedRatio(zoom));
      }
      expect(spriteHeightForZoom(15.1, SPRITE_BASE_ZOOM, presentation) /
        presentation.baseHeightPx).toBeCloseTo(1.05, 12);
      expect(spriteHeightForZoom(15.2, SPRITE_BASE_ZOOM, presentation) /
        spriteHeightForZoom(15.1, SPRITE_BASE_ZOOM, presentation)).toBeCloseTo(1.05, 12);
      expect(spriteHeightForZoom(MAX_MAP_ZOOM, SPRITE_BASE_ZOOM, presentation) /
        presentation.baseHeightPx).toBeCloseTo(4.321942375150668);
    }
  });

  it("uses the measured ground anchors for image artwork", () => {
    expect(SPRITE_PRESENTATION.deer.anchorY).toBe(0.85);
    expect(SPRITE_PRESENTATION.ogre.anchorY).toBe(0.90727454977531);
    expect(SPRITE_PRESENTATION.wolf.anchorY).toBe(0.89);
    expect(SPRITE_PRESENTATION.sapCrawler.anchorY).toBe(0.836);
    expect(SPRITE_PRESENTATION.hog.anchorY).toBe(0.861);
    expect(SPRITE_PRESENTATION.bear.anchorY).toBe(0.8045770393452855);
    expect(SPRITE_PRESENTATION.mysteriousTraveler.anchorY).toBe(0.9105350888060458);
    expect(SPRITE_PRESENTATION.frog.anchorY).toBe(0.725912731214657);
    expect(SPRITE_PRESENTATION.alligator.anchorY).toBe(0.804);
    expect(SPRITE_PRESENTATION.squid.anchorY).toBe(0.6635992848894217);
    expect(SPRITE_PRESENTATION.jellyfish.anchorY).toBe(0.7848598327361722);
    expect(SPRITE_PRESENTATION.tree.anchorY).toBe(0.888);
    expect(SPRITE_PRESENTATION.flax.anchorY).toBe(0.94);
    expect(SPRITE_PRESENTATION.stoneMine.anchorY).toBe(0.658567796630188);
    expect(SPRITE_PRESENTATION.sulfurMine.anchorY).toBe(0.7545774758715016);
    expect(SPRITE_PRESENTATION.stone.anchorY).toBe(0.779);
    expect(SPRITE_PRESENTATION.wood.anchorY).toBe(0.891);
    expect(SPRITE_PRESENTATION.leather.anchorY).toBe(0.815);
  });

  it("is monotonic through integer, fractional, and out-of-range zooms", () => {
    const zooms = [13.5, 14, 14.625, 15, 16];
    for (const presentation of Object.values(SPRITE_PRESENTATION)) {
      const heights = zooms.map((zoom) =>
        spriteHeightForZoom(zoom, SPRITE_BASE_ZOOM, presentation)
      );
      for (let index = 1; index < heights.length; index += 1) {
        expect(heights[index]).toBeGreaterThanOrEqual(heights[index - 1]!);
      }
    }
  });

  it("keeps the lower floor without imposing an upper cap", () => {
    for (const presentation of Object.values(SPRITE_PRESENTATION)) {
      expect(spriteHeightForZoom(-100, SPRITE_BASE_ZOOM, presentation))
        .toBe(presentation.minHeightPx);
      expect(spriteHeightForZoom(100, SPRITE_BASE_ZOOM, presentation))
        .toBeGreaterThan(presentation.baseHeightPx);
    }
  });

  it("falls back safely for non-finite zoom input", () => {
    const presentation = SPRITE_PRESENTATION.player;
    for (const zoom of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(spriteHeightForZoom(zoom, SPRITE_BASE_ZOOM, presentation))
        .toBe(presentation.baseHeightPx);
    }
    expect(spriteHeightForZoom(
      SPRITE_BASE_ZOOM,
      Number.NaN,
      presentation
    )).toBe(presentation.baseHeightPx);
  });

  it("preserves texture aspect ratio with one uniform scale", () => {
    const scale = textureScaleForHeight(50, 100);
    expect(scale).toBe(0.5);
    expect(200 * scale).toBe(100);
    expect(100 * scale).toBe(50);
    expect(textureScaleForHeight(50, 0)).toBe(1);
  });

  it("applies horizontal stretch without changing height or zoom scale", () => {
    const presentation = { ...SPRITE_PRESENTATION.dog, horizontalScale: 1.5 };
    const layout = spriteLayoutForZoom(10, 20, 100, SPRITE_BASE_ZOOM, presentation);

    expect(layout.scaleY).toBeCloseTo(presentation.baseHeightPx / 100);
    expect(layout.scaleX).toBeCloseTo(layout.scaleY * 1.5);
    expect(spriteHeightForZoom(SPRITE_BASE_ZOOM, SPRITE_BASE_ZOOM, presentation))
      .toBe(presentation.baseHeightPx);

    const parentScale = 2;
    const correctedScale = staticSpriteLocalScaleDuringTransform(
      layout.scaleY,
      parentScale,
      SPRITE_BASE_ZOOM + 1,
      SPRITE_BASE_ZOOM,
      presentation
    );
    expect(correctedScale * presentation.horizontalScale * parentScale)
      .toBeCloseTo(correctedScale * parentScale * 1.5);
  });

  it("counter-scales frozen static sprites so the parent transform is not applied twice", () => {
    const presentation = SPRITE_PRESENTATION.tree;
    const committedZoom = SPRITE_BASE_ZOOM;
    const currentZoom = committedZoom + 0.5;
    const parentScale = 2 ** (currentZoom - committedZoom);
    const textureHeight = 200;
    const committedLocalScale = textureScaleForHeight(
      presentation.baseHeightPx,
      textureHeight
    );
    const correctedLocalScale = staticSpriteLocalScaleDuringTransform(
      committedLocalScale,
      parentScale,
      currentZoom,
      committedZoom,
      presentation
    );
    const renderedHeight = textureHeight * correctedLocalScale * parentScale;

    expect(renderedHeight).toBeCloseTo(
      spriteHeightForZoom(currentZoom, SPRITE_BASE_ZOOM, presentation)
    );
    expect(renderedHeight).not.toBeCloseTo(presentation.baseHeightPx * parentScale);
  });

  it("does not compound flag scale across repeated frozen transforms or remounts", () => {
    const presentation = SPRITE_PRESENTATION.flag;
    const committedZoom = SPRITE_BASE_ZOOM;
    const currentZoom = MAX_MAP_ZOOM;
    const parentScale = 2 ** (currentZoom - committedZoom);
    const committedScale = textureScaleForHeight(
      presentation.baseHeightPx,
      25
    );
    const first = staticSpriteLocalScaleDuringTransform(
      committedScale,
      parentScale,
      currentZoom,
      committedZoom,
      presentation
    );
    const repeated = staticSpriteLocalScaleDuringTransform(
      committedScale,
      parentScale,
      currentZoom,
      committedZoom,
      presentation
    );
    const remounted = staticSpriteLocalScaleDuringTransform(
      committedScale,
      parentScale,
      currentZoom,
      committedZoom,
      presentation
    );

    expect(repeated).toBe(first);
    expect(remounted).toBe(first);
    expect(25 * first * parentScale).toBeCloseTo(
      spriteHeightForZoom(currentZoom, SPRITE_BASE_ZOOM, presentation)
    );
  });
});

function baseHeights(): Record<string, number> {
  return Object.fromEntries(
    Object.entries(SPRITE_PRESENTATION).map(([key, value]) => [key, value.baseHeightPx])
  );
}
