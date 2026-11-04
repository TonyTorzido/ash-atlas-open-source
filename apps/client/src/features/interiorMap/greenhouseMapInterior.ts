import {
  GREENHOUSE_DOOR_ASSET_PATH,
  GREENHOUSE_GIVING_BERRY_TREE_CROP_ID,
  GREENHOUSE_POT_ASSET_PATH,
  GREENHOUSE_ROOM_HEIGHT,
  GREENHOUSE_ROOM_WIDTH,
  GREENHOUSE_STUDIO_CATALOG,
  greenhousePlantStageArtFrame,
  greenhouseTemplateFootprint,
  greenhouseTemplateImageFrame,
  type GreenhouseCropCatalogEntrySnapshot,
  type GreenhousePlacementKind,
  type GreenhouseStateSnapshot,
  type RuntimePngGreenhouseCropPresentation
} from "@ash-atlas/shared";

import type { InteriorSpriteItem } from "../../map/mapObjects.js";
import {
  greenhouseCropStageAssetUrl,
  runtimePngAssetUrl,
  selectedRuntimePngContentPack
} from "../../map/runtimePngAssetUrl.js";
import { svgDataUrl } from "./roomMapInterior.js";

/**
 * The Greenhouse on the map renderer (INTERIOR_MAP_RENDERER.md P4): floor, authored overlays, door,
 * farm plots with their crop stage art, the water tank and the placement preview as map sprites,
 * in the same draw order as the DOM scene (all below the player).
 */

export const GREENHOUSE_ROOM = { width: GREENHOUSE_ROOM_WIDTH, height: GREENHOUSE_ROOM_HEIGHT } as const;
export const GREENHOUSE_FLOOR_ASSET_PATH = "apps/client/src/assets/structures/greenhouse-floor.png";

export function greenhouseMapSpaceKey(greenhouseId: string): string {
  return `greenhouse:${greenhouseId}`;
}

export type GreenhouseCropStageArt = Readonly<{
  stagePresentation: RuntimePngGreenhouseCropPresentation["stages"][number];
  url: string;
}>;

/** Verified stage art for one crop stage (authored Giving Berry Tree art, else the selected content pack's). */
export function greenhouseCropStageArt(
  cropCatalog: GreenhouseStateSnapshot["cropCatalog"],
  cropId: string,
  stage: number
): GreenhouseCropStageArt | null {
  if (cropId === GREENHOUSE_GIVING_BERRY_TREE_CROP_ID && stage >= 1 && stage <= 4) {
    const authored = GREENHOUSE_STUDIO_CATALOG.geometry.stageArt.find((entry) => entry.cropId === cropId && entry.stage === stage);
    const authoredUrl = authored ? runtimePngAssetUrl(authored.assetPath) : null;
    if (authored && authoredUrl) {
      return {
        stagePresentation: {
          stage,
          artId: authored.artId,
          assetId: authored.artId,
          pivotX: authored.pivotX,
          pivotY: authored.pivotY,
          offsetX: authored.offsetX,
          offsetY: authored.offsetY,
          scale: authored.scale
        },
        url: authoredUrl
      };
    }
    return null;
  }
  const selectedContentPack = selectedRuntimePngContentPack();
  if (!cropCatalog?.packId || selectedContentPack.packId !== cropCatalog.packId) return null;
  const crop: GreenhouseCropCatalogEntrySnapshot | undefined = cropCatalog.crops.find((entry) => entry.cropId === cropId);
  if (!crop || stage < 1 || stage > crop.stageArtIds.length) return null;
  const presentation = selectedContentPack.greenhouseCropPresentations.find((entry) => entry.cropId === cropId);
  const stagePresentation = presentation?.stages.find((entry) => entry.stage === stage);
  if (!stagePresentation || stagePresentation.artId !== crop.stageArtIds[stage - 1]) return null;
  const url = greenhouseCropStageAssetUrl(cropId, stage);
  return url ? { stagePresentation, url } : null;
}

/** The live placement preview (from the Greenhouse HUD scene). */
export type GreenhouseMapPlacementPreview = Readonly<{
  kind: GreenhousePlacementKind;
  x: number;
  y: number;
  valid: boolean;
}>;

/** One placement footprint outline (fixed per kind and validity, so moving the preview reuses the texture). */
const footprintCache = new Map<string, Readonly<{ url: string; minX: number; minY: number; width: number; height: number }>>();
function footprintArt(kind: GreenhousePlacementKind, valid: boolean) {
  const cacheKey = `${kind}:${valid}`;
  const cached = footprintCache.get(cacheKey);
  if (cached) return cached;
  const points = greenhouseTemplateFootprint(GREENHOUSE_STUDIO_CATALOG, kind, 0, 0);
  const pad = 3;
  const minX = Math.min(...points.map((point) => point.x)) - pad;
  const minY = Math.min(...points.map((point) => point.y)) - pad;
  const width = Math.max(...points.map((point) => point.x)) + pad - minX;
  const height = Math.max(...points.map((point) => point.y)) + pad - minY;
  const stroke = valid ? "#fde68a" : "#f18d8d";
  const fill = valid ? "rgba(253,230,138,0.16)" : "rgba(219,95,95,0.18)";
  const art = {
    url: svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}">` +
      `<polygon points="${points.map((point) => `${point.x},${point.y}`).join(" ")}" fill="${fill}" stroke="${stroke}" stroke-width="3"/></svg>`),
    minX, minY, width, height
  };
  footprintCache.set(cacheKey, art);
  return art;
}

function frameSprite(
  key: string,
  url: string,
  frame: Readonly<{ x: number; y: number; width: number; height: number }>,
  zIndex: number,
  extra: Partial<InteriorSpriteItem> = {}
): InteriorSpriteItem {
  return {
    key, url, layerId: "below_player",
    x: frame.x, y: frame.y, width: frame.width, height: frame.height, anchorX: 0, anchorY: 0, zIndex,
    ...extra
  };
}

export function greenhouseSprites(input: Readonly<{
  state: GreenhouseStateSnapshot;
  preview: GreenhouseMapPlacementPreview | null;
}>): InteriorSpriteItem[] {
  const { state } = input;
  const sprites: InteriorSpriteItem[] = [];
  const floorUrl = runtimePngAssetUrl(GREENHOUSE_FLOOR_ASSET_PATH);
  if (floorUrl) {
    sprites.push({
      key: "greenhouse-floor", url: floorUrl, layerId: "background",
      x: 0, y: 0, width: GREENHOUSE_ROOM_WIDTH, height: GREENHOUSE_ROOM_HEIGHT, anchorX: 0, anchorY: 0, zIndex: -1, fit: "contain"
    });
  }
  for (const overlay of GREENHOUSE_STUDIO_CATALOG.overlays) {
    const url = runtimePngAssetUrl(overlay.assetPath);
    if (!url) continue;
    // CSS: transform-origin top left, rotate() then scale().
    sprites.push({
      key: `greenhouse-overlay:${overlay.overlayId}`, url,
      layerId: overlay.zIndex >= 25 ? "above_player" : "below_player",
      x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height, anchorX: 0, anchorY: 0,
      rotationDeg: overlay.rotationDeg, scaleX: overlay.scaleX, scaleY: overlay.scaleY, zIndex: overlay.zIndex
    });
  }
  const exit = GREENHOUSE_STUDIO_CATALOG.geometry.exit;
  const doorUrl = runtimePngAssetUrl(exit.assetPath || GREENHOUSE_DOOR_ASSET_PATH);
  if (doorUrl) {
    sprites.push(frameSprite("greenhouse-door", doorUrl, {
      x: exit.x - exit.pivotX * exit.renderWidth,
      y: exit.y - exit.pivotY * exit.renderHeight,
      width: exit.renderWidth,
      height: exit.renderHeight
    }, 14));
  }
  const preview = input.preview;
  if (preview) {
    const footprint = footprintArt(preview.kind, preview.valid);
    sprites.push(frameSprite("greenhouse-placement-footprint", footprint.url, {
      x: preview.x + footprint.minX,
      y: preview.y + footprint.minY,
      width: footprint.width,
      height: footprint.height
    }, 10));
  }
  const potUrl = runtimePngAssetUrl(GREENHOUSE_POT_ASSET_PATH);
  for (const anchor of state.greenhouse.anchors) {
    if (anchor.placed === false) continue;
    if (potUrl) {
      sprites.push(frameSprite(`greenhouse-pot:${anchor.anchorId}`, potUrl,
        greenhouseTemplateImageFrame(GREENHOUSE_STUDIO_CATALOG, "pot", anchor.x, anchor.y), 14));
    }
    if (!anchor.plant) continue;
    const art = greenhouseCropStageArt(state.cropCatalog, anchor.plant.cropId, anchor.plant.stage);
    // Same verified-art rule as the DOM scene's GreenhouseAnchor.
    if (!art || (art.stagePresentation.artId !== anchor.plant.artId && anchor.plant.cropId !== GREENHOUSE_GIVING_BERRY_TREE_CROP_ID)) continue;
    sprites.push(frameSprite(`greenhouse-crop:${anchor.anchorId}`, art.url,
      greenhousePlantStageArtFrame(GREENHOUSE_STUDIO_CATALOG, art.stagePresentation, anchor.x, anchor.y), 15, { fit: "contain" }));
  }
  if (preview) {
    const template = preview.kind === "pot"
      ? GREENHOUSE_STUDIO_CATALOG.geometry.templates.pot
      : GREENHOUSE_STUDIO_CATALOG.geometry.templates.waterTank;
    const url = runtimePngAssetUrl(template.assetPath);
    if (url) {
      sprites.push(frameSprite("greenhouse-placement-preview", url,
        greenhouseTemplateImageFrame(GREENHOUSE_STUDIO_CATALOG, preview.kind, preview.x, preview.y), 16, { alpha: 0.55 }));
    }
  }
  const tank = state.greenhouse.waterStorage ?? { ...GREENHOUSE_STUDIO_CATALOG.waterStorage, placed: true };
  const tankUrl = runtimePngAssetUrl(GREENHOUSE_STUDIO_CATALOG.geometry.templates.waterTank.assetPath);
  if (tank.placed !== false && tankUrl) {
    sprites.push(frameSprite("greenhouse-tank", tankUrl,
      greenhouseTemplateImageFrame(GREENHOUSE_STUDIO_CATALOG, "water_tank", tank.x, tank.y), 14));
  }
  return sprites;
}
