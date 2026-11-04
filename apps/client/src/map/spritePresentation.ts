import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  DEFAULT_PLAYER_BODY_VARIANT_ID,
  RUNTIME_PNG_PRESENTATION_CATALOG,
  WORLD_OBJECT_ZOOM_POLICY,
  playerTemplateTransform,
  playerOverallScale,
  runtimePngItemPresentation,
  runtimePngItemGroundHitGeometry,
  runtimePngItemGroundVisualHeight,
  type RuntimePngInteractionGeometry,
  type RuntimeSpritePresentation
} from "@ash-atlas/shared";
import { PLAYER_BASE_HEIGHT_PX } from "@ash-atlas/player-renderer";

import {
  GAMEPLAY_MAP_DETAIL_FULL_ZOOM,
  GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
  gameplayMapDetailAlphaForZoom
} from "./mapZoomConfig.js";
import { worldPngSpriteMasterScale } from "./worldPngMasterScale.js";

export type SpritePresentation = Omit<RuntimeSpritePresentation, "hitGeometry"> & {
  hitGeometry?: RuntimePngInteractionGeometry;
  hitRadiusPx?: number;
  masterScaleEligible?: boolean;
};

export const SPRITE_BASE_ZOOM = WORLD_OBJECT_ZOOM_POLICY.baseZoom;

export const SPRITE_PRESENTATION = RUNTIME_PNG_PRESENTATION_CATALOG.sprites;

/**
 * Resolve item drops through the shared item presentation contract. Older
 * item ids intentionally fall back to the established leather-sized frame so
 * missing metadata can never make a raw PNG dimension determine world size.
 */
export function itemSpritePresentationForArtwork(
  artworkKey: string
): RuntimeSpritePresentation {
  const presentation = runtimePngItemPresentation(artworkKey) ?? SPRITE_PRESENTATION.leather;
  const groundHitGeometry = runtimePngItemGroundHitGeometry(presentation);
  if (groundHitGeometry === presentation.hitGeometry) return presentation;
  return {
    ...presentation,
    hitGeometry: groundHitGeometry
  };
}

/**
 * At globe scale a player is a map marker, not a shrinking local actor. Both
 * globe paths resolve this same visible-art floor after their renderer's
 * authored body and appearance transforms.
 */
export const PLAYER_MAP_MARKER_ZOOM_THRESHOLD = GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM;
export const PLAYER_MAP_MARKER_TRANSITION_START_ZOOM = GAMEPLAY_MAP_DETAIL_FULL_ZOOM;
/** Shared final visible-art height after the PlayerRenderer transform chain. */
export const PLAYER_MAP_MARKER_MIN_SCREEN_HEIGHT_PX = 36;

export type PlayerMapPresentationMode = "local" | "transition" | "marker";

export type PlayerMapPresentation = Readonly<{
  mode: PlayerMapPresentationMode;
  transitionProgress: number;
  screenHeightPx: number;
  artworkHeightPx: number;
  healthBarVisible: boolean;
}>;

export function playerMapPresentationForZoom(
  zoom: number,
  rendererScale = 1,
  hasCombat = false,
  // Raw camera zoom for the globe/marker LOD band; `zoom` is the ground-scale
  // (equator-equivalent) zoom that sizes the sprite.
  cameraZoom = zoom
): PlayerMapPresentation {
  const safeZoom = Number.isFinite(zoom) ? zoom : SPRITE_BASE_ZOOM;
  const safeRendererScale = Number.isFinite(rendererScale) && rendererScale > 0
    ? rendererScale
    : 1;
  const naturalScreenHeight = spriteHeightForZoom(
    safeZoom,
    SPRITE_BASE_ZOOM,
    SPRITE_PRESENTATION.player
  ) * safeRendererScale;
  const transitionProgress = 1 - gameplayMapDetailAlphaForZoom(
    Number.isFinite(cameraZoom) ? cameraZoom : safeZoom
  );
  const mode: PlayerMapPresentationMode = transitionProgress <= 0
    ? "local"
    : transitionProgress >= 1
      ? "marker"
      : "transition";
  const screenHeightPx = naturalScreenHeight +
    (PLAYER_MAP_MARKER_MIN_SCREEN_HEIGHT_PX - naturalScreenHeight) * transitionProgress;
  return {
    mode,
    transitionProgress,
    screenHeightPx,
    artworkHeightPx: screenHeightPx / safeRendererScale,
    healthBarVisible: hasCombat && mode === "local"
  };
}

/**
 * Resolves the external PlayerRenderer root scale needed for the shared
 * visible-art marker height. The renderer's internal authored body and
 * appearance scale are supplied explicitly so standalone canvas and regular
 * Pixi do not rely on a second fixed marker factor.
 */
export function playerMapMarkerRootScaleForRenderer(rendererScale: number): number {
  const safeRendererScale = Number.isFinite(rendererScale) && rendererScale > 0
    ? rendererScale
    : 1;
  return PLAYER_MAP_MARKER_MIN_SCREEN_HEIGHT_PX /
    (PLAYER_BASE_HEIGHT_PX * safeRendererScale);
}

export function playerMapMarkerEffectiveScreenHeightForRenderer(
  rendererScale: number
): number {
  const safeRendererScale = Number.isFinite(rendererScale) && rendererScale > 0
    ? rendererScale
    : 1;
  return PLAYER_BASE_HEIGHT_PX * safeRendererScale *
    playerMapMarkerRootScaleForRenderer(safeRendererScale);
}

export function playerMapMarkerScreenHeightForZoom(zoom: number): number {
  return playerMapPresentationForZoom(zoom).screenHeightPx;
}

export function playerMapMarkerModeForZoom(zoom: number): boolean {
  return playerMapPresentationForZoom(zoom).mode === "marker";
}

export function playerMapHealthBarVisibleForZoom(
  zoom: number,
  hasCombat: boolean
): boolean {
  return playerMapPresentationForZoom(zoom, 1, hasCombat).healthBarVisible;
}

export function playerMapMarkerArtworkHeightForZoom(
  zoom: number,
  rendererScale = 1
): number {
  return playerMapPresentationForZoom(zoom, rendererScale).artworkHeightPx;
}

export function spriteHeightForZoom(
  currentZoom: number,
  baseZoom: number,
  presentation: SpritePresentation
): number {
  const safeBaseZoom = Number.isFinite(baseZoom) ? baseZoom : SPRITE_BASE_ZOOM;
  const safeCurrentZoom = Number.isFinite(currentZoom) ? currentZoom : safeBaseZoom;
  const scaledHeight =
    presentation.baseHeightPx *
    2 ** ((safeCurrentZoom - safeBaseZoom) * presentation.zoomStrength);
  const masterScale = worldPngSpriteMasterScale(presentation as RuntimeSpritePresentation & {
    masterScaleEligible?: boolean;
  });
  const minimumClampedHeight = Math.max(scaledHeight, presentation.minHeightPx) * masterScale;
  return presentation.maxHeightPx === null
    ? minimumClampedHeight
    : Math.min(minimumClampedHeight, presentation.maxHeightPx * masterScale);
}

export function textureScaleForHeight(targetHeightPx: number, textureHeightPx: number): number {
  return Number.isFinite(textureHeightPx) && textureHeightPx > 0
    ? targetHeightPx / textureHeightPx
    : 1;
}

export function spriteHorizontalScale(presentation: SpritePresentation): number {
  return presentation.horizontalScale ?? 1;
}

/**
 * Returns the effective world-rendered mob height relative to the normal
 * overworld player. Both sides use the same zoom policy, while the mob also
 * receives the runtime PNG master scale and the player renderer applies its
 * authored body-template and overall scales after the canonical player height
 * is resolved.
 */
export function worldMobPlayerSizeRatio(
  presentation: SpritePresentation,
  currentZoom = SPRITE_BASE_ZOOM
): number {
  const mobHeight = spriteHeightForZoom(
    currentZoom,
    SPRITE_BASE_ZOOM,
    presentation
  );
  const playerHeight = spriteHeightForZoom(
    currentZoom,
    SPRITE_BASE_ZOOM,
    SPRITE_PRESENTATION.player
  ) * defaultPlayerRendererScale();
  // The player also follows the master scale on the map, but dungeon scenes size
  // the player from a fixed target, so compare against the unscaled player to keep
  // indoor mob proportions unchanged.
  return mobHeight / (playerHeight / worldPngSpriteMasterScale(SPRITE_PRESENTATION.player));
}

/**
 * Projects a world mob's effective size into a dungeon whose player target
 * height is supplied in local scene units. Dungeon stage zoom is applied to
 * both actors by the shared scene transform, and the player target receives
 * the same renderer scales as the normal overworld player; authored encounter
 * visualScale remains an additional mob-only factor.
 */
export function dungeonMobVisualHeight(
  playerVisualHeight: number,
  presentation: SpritePresentation,
  visualScale = 1
): number {
  return playerVisualHeight * defaultPlayerRendererScale() *
    worldMobPlayerSizeRatio(presentation) * visualScale;
}

/**
 * Resolve an item drop's visual height in an indoor scene. The indoor player
 * target and the world player's authored 28px sprite share the same
 * PlayerRenderer body/template transforms, so this keeps the item/player
 * ratio identical in Manor and dungeon scenes.
 */
export function groundItemVisualHeight(
  playerVisualHeight: number,
  presentation: SpritePresentation,
  currentZoom = SPRITE_BASE_ZOOM
): number {
  return runtimePngItemGroundVisualHeight(
    spriteHeightForZoom(currentZoom, SPRITE_BASE_ZOOM, presentation),
    playerVisualHeight
  );
}

/** The world-equivalent height used by the outdoor drop renderer. */
export function worldGroundItemVisualHeight(
  presentation: SpritePresentation,
  currentZoom = SPRITE_BASE_ZOOM
): number {
  // Outdoor item sprites already live in the same map-pixel zoom space as the
  // authored 28px player presentation. Applying `groundItemVisualHeight`
  // here would apply the shared zoom curve a second time (once to the item
  // and once through the player target), changing the item/player ratio while
  // the map zooms. Indoor callers project the authored base height into their
  // player target with `groundItemVisualHeight`; outdoor callers only need the
  // one normal world zoom resolution.
  return spriteHeightForZoom(currentZoom, SPRITE_BASE_ZOOM, presentation);
}

/**
 * Resolves the base scale for a projectile rendered in the dungeon scene.
 * Projectile artwork is authored in the same player-local pixel space as the
 * overworld renderer, so the dungeon's local player target height is the
 * only additional scene scale needed before the authored projectile scale is
 * applied by the shared projectile transform.
 */
export function dungeonProjectileBaseScale(playerVisualHeight: number): number {
  return playerVisualHeight / SPRITE_PRESENTATION.player.baseHeightPx;
}

function defaultPlayerRendererScale(): number {
  return playerTemplateTransform(
    DEFAULT_PLAYER_APPEARANCE_CATALOG,
    DEFAULT_PLAYER_BODY_VARIANT_ID,
    "idle"
  ).scale * playerOverallScale(
    DEFAULT_PLAYER_APPEARANCE_CATALOG,
    DEFAULT_PLAYER_BODY_VARIANT_ID
  );
}

export function spriteLayoutForZoom(
  x: number,
  y: number,
  sourceHeightPx: number,
  currentZoom: number,
  presentation: SpritePresentation
): Readonly<{ x: number; y: number; scale: number; scaleX: number; scaleY: number }> {
  const scale = textureScaleForHeight(
    spriteHeightForZoom(currentZoom, SPRITE_BASE_ZOOM, presentation),
    sourceHeightPx
  );
  return {
    x,
    y,
    scale,
    scaleX: scale * spriteHorizontalScale(presentation),
    scaleY: scale
  };
}

export function staticSpriteLocalScaleDuringTransform(
  committedLocalScale: number,
  parentTransformScale: number,
  currentZoom: number,
  committedZoom: number,
  presentation: SpritePresentation
): number {
  const safeParentScale =
    Number.isFinite(parentTransformScale) && parentTransformScale > 0
      ? parentTransformScale
      : 1;
  const committedHeight = spriteHeightForZoom(
    committedZoom,
    SPRITE_BASE_ZOOM,
    presentation
  );
  const currentHeight = spriteHeightForZoom(
    currentZoom,
    SPRITE_BASE_ZOOM,
    presentation
  );
  return committedLocalScale * (currentHeight / committedHeight) / safeParentScale;
}

/**
 * Readable 2.5D (docs/plans/hurt-circles.md): hit tests live on the ground at the feet, but projectiles fly and
 * impact VFX spawn at chest height. Chest height is this share of the entity's drawn sprite height, one value per
 * entity type (a humanoid's chest sits higher in its frame than a four-legged mob's).
 */
export const COMBAT_CHEST_HEIGHT_SHARE: Readonly<Record<"player" | "mob", number>> = { player: 0.5, mob: 0.45 };

/** Screen lift (px above the feet) of an entity's chest for a sprite drawn `spriteHeightPx` tall. */
export function combatChestLiftPx(spriteHeightPx: number, kind: "player" | "mob"): number {
  return Number.isFinite(spriteHeightPx) && spriteHeightPx > 0 ? spriteHeightPx * COMBAT_CHEST_HEIGHT_SHARE[kind] : 0;
}

/** Chest point of an entity whose feet (anchor) are at (x, y) on screen; writes into `out`. */
export function combatChestPointInto(
  x: number, y: number, spriteHeightPx: number, kind: "player" | "mob", out: { x: number; y: number }
): { x: number; y: number } {
  out.x = x;
  out.y = y - combatChestLiftPx(spriteHeightPx, kind);
  return out;
}
