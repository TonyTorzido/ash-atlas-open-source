import type {
  ActiveCityStructureType,
  CityStructureSnapshot,
  CityStructureType,
  RuntimePngInteractionGeometry
} from "@ash-atlas/shared";
import {
  isRuntimePngWorldObjectFixedKey,
  isRuntimePngMasterScaleEligible,
  RUNTIME_PNG_PRESENTATION_CATALOG,
  WORLD_OBJECT_ZOOM_POLICY
} from "@ash-atlas/shared";

import {
  SPRITE_BASE_ZOOM,
  spriteHeightForZoom,
  type SpritePresentation
} from "./spritePresentation.js";
import { worldPngFixedMasterScale } from "./worldPngMasterScale.js";

export type FixedWorldPngPresentation = Readonly<{
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  hitGeometry: RuntimePngInteractionGeometry;
  source: string;
  definedIn: string;
  masterScaleKey: string;
}>;

export type ZoomScaledWorldPngPresentation = FixedWorldPngPresentation & Readonly<{
  baseHeightPx: number;
  minHeightPx: number;
  maxHeightPx: number | null;
  zoomStrength: number;
}>;

const DEFINED_IN = "apps/client/src/map/worldPngPresentation.ts";

export function isRenderableCityStructureType(
  type: CityStructureType
): type is ActiveCityStructureType {
  return type === "city_house" ||
    type === "mayor_house" ||
    type === "oil_well" ||
    type === "quartz_hut" ||
    type === "library" ||
    type === "warehouse" ||
    type === "cistern_warrens" ||
    type === "salon" ||
    type === "city_kennel" ||
    type === "market" ||
    type === "barracks" ||
    type === "demolition_factory" ||
    type === "monument";
}

export const WORLD_PNG_PRESENTATION = {
  atlasShrine: worldObject("atlasShrine"),
  city: worldObject("city"),
  manor: worldObject("manor"),
  furnace: worldObject("furnace"),
  greenhouse: worldObject("greenhouse"),
  kitchen: worldObject("kitchen"),
  loom: worldObject("loom"),
  tannery: worldObject("tannery"),
  cityStructures: {
    city_house: worldObject("cityStructures.city_house"),
    mayor_house: worldObject("cityStructures.mayor_house"),
    oil_well: worldObject("cityStructures.oil_well"),
    warehouse: worldObject("cityStructures.warehouse"),
    cistern_warrens: worldObject("cityStructures.cistern_warrens"),
    salon: worldObject("cityStructures.salon"),
    city_kennel: worldObject("cityStructures.city_kennel"),
    market: worldObject("cityStructures.market"),
    barracks: worldObject("cityStructures.barracks"),
    armory: worldObject("cityStructures.armory"),
    demolition_factory: worldObject("cityStructures.demolition_factory"),
    siege_workshop: worldObject("cityStructures.siege_workshop"),
    powder_works: worldObject("cityStructures.powder_works"),
    goblin_market: worldObject("cityStructures.goblin_market"),
    monument_mining: worldObject("cityStructures.monument_mining"),
    monument_forestry: worldObject("cityStructures.monument_forestry"),
    monument_hunting: worldObject("cityStructures.monument_hunting")
  },
  resinGain: fixed("resinGain"),
  worldMapAtlasShrine: fixed("worldMapAtlasShrine"),
  worldMapManor: fixed("worldMapManor"),
  worldMapCity: fixed("worldMapCity"),
  worldMapKingdom: fixed("worldMapKingdom")
} as const;

export type CityStructurePresentationKey =
  Exclude<ActiveCityStructureType, "monument" | "quartz_hut" | "library"> |
  "goblin_market" |
  "monument_mining" |
  "monument_forestry" |
  "monument_hunting";

export function cityStructurePresentationKey(
  structure: Pick<CityStructureSnapshot, "type" | "districtType">
): CityStructurePresentationKey | null {
  if (!isRenderableCityStructureType(structure.type)) return null;
  // No Quartz Hut art yet: it draws with the Oil Well sprite (the same
  // fallback pattern as the Loom using the Tannery texture) and its own label.
  if (structure.type === "quartz_hut") return "oil_well";
  // No Library art yet: it draws with the Warehouse sprite and its own label.
  if (structure.type === "library") return "warehouse";
  if (structure.type !== "monument") return structure.type;
  return structure.districtType === "forestry"
    ? "monument_forestry"
    : structure.districtType === "hunting"
      ? "monument_hunting"
      : "monument_mining";
}

export function worldPngDimensionsForZoom(
  presentation: ZoomScaledWorldPngPresentation,
  zoom: number,
  scale = 1
): Readonly<{ width: number; height: number }> {
  const height = spriteHeightForZoom(
    zoom,
    SPRITE_BASE_ZOOM,
    scaledSpritePresentation(presentation, scale)
  );
  const zoomScale = height /
    (presentation.height * scale * worldPngFixedMasterScale(presentation.masterScaleKey));
  return {
    width: presentation.width * scale * worldPngFixedMasterScale(presentation.masterScaleKey) * zoomScale,
    height
  };
}

export function worldPngScaleForZoom(
  presentation: ZoomScaledWorldPngPresentation,
  zoom: number
): number {
  return worldPngDimensionsForZoom(presentation, zoom).height / presentation.height;
}

export function scaledSpritePresentation(
  presentation: ZoomScaledWorldPngPresentation,
  scale = 1
): SpritePresentation {
  return {
    baseHeightPx: presentation.baseHeightPx * scale,
    minHeightPx: presentation.minHeightPx * scale,
    maxHeightPx: presentation.maxHeightPx === null
      ? null
      : presentation.maxHeightPx * scale,
    zoomStrength: presentation.zoomStrength,
    anchorX: presentation.anchorX,
    anchorY: presentation.anchorY,
    hitGeometry: presentation.hitGeometry,
    masterScaleEligible: isRuntimePngMasterScaleEligible(
      "fixed",
      presentation.masterScaleKey
    )
  };
}

export function fixedWorldPngDimensions(
  presentation: FixedWorldPngPresentation
): Readonly<{ width: number; height: number }> {
  const masterScale = worldPngFixedMasterScale(presentation.masterScaleKey);
  return {
    width: presentation.width * masterScale,
    height: presentation.height * masterScale
  };
}

export function worldPngInteractionHitBox(input: Readonly<{
  x: number;
  y: number;
  zoom: number;
  presentation: ZoomScaledWorldPngPresentation;
  scale?: number;
  paddingPx?: number;
}>): ScreenHitBox {
  const scale = input.scale ?? 1;
  const dimensions = worldPngDimensionsForZoom(input.presentation, input.zoom, scale);
  const zoomScale = dimensions.height / input.presentation.height;
  const geometry = input.presentation.hitGeometry.shape === "circle"
    ? { ...input.presentation.hitGeometry, radiusPx: input.presentation.hitGeometry.radiusPx * zoomScale }
    : input.presentation.hitGeometry;
  return pngInteractionHitBox({
    x: input.x,
    y: input.y,
    width: dimensions.width,
    height: dimensions.height,
    anchorX: input.presentation.anchorX,
    anchorY: input.presentation.anchorY,
    geometry,
    ...(input.paddingPx === undefined ? {} : { paddingPx: input.paddingPx })
  });
}

function fixed(
  key: keyof typeof RUNTIME_PNG_PRESENTATION_CATALOG.fixed
): FixedWorldPngPresentation {
  const presentation = RUNTIME_PNG_PRESENTATION_CATALOG.fixed[key];
  return {
    ...presentation,
    source: `WORLD_PNG_PRESENTATION.${key}`,
    definedIn: DEFINED_IN,
    masterScaleKey: key
  };
}

function worldObject(
  key: keyof typeof RUNTIME_PNG_PRESENTATION_CATALOG.fixed
): ZoomScaledWorldPngPresentation {
  if (!isRuntimePngWorldObjectFixedKey(key)) {
    throw new Error(`Fixed PNG ${key} is not registered as a zoom-scaled world object`);
  }
  const presentation = fixed(key);
  return {
    ...presentation,
    baseHeightPx: presentation.height,
    minHeightPx: presentation.height * WORLD_OBJECT_ZOOM_POLICY.minScale,
    maxHeightPx: WORLD_OBJECT_ZOOM_POLICY.maxScale === null
      ? null
      : presentation.height * WORLD_OBJECT_ZOOM_POLICY.maxScale,
    zoomStrength: WORLD_OBJECT_ZOOM_POLICY.zoomStrength
  };
}

export type ScreenHitBox = Readonly<
  | { shape: "circle"; x: number; y: number; radius: number }
  | { shape: "rectangle"; left: number; top: number; right: number; bottom: number }
>;

export const WORLD_LABEL_HITBOX_GAP_PX = 2;

export function worldLabelPositionBelowHitBox(
  hitBox: ScreenHitBox
): Readonly<{ x: number; y: number }> {
  return hitBox.shape === "circle"
    ? { x: hitBox.x, y: hitBox.y + hitBox.radius + WORLD_LABEL_HITBOX_GAP_PX }
    : {
        x: (hitBox.left + hitBox.right) / 2,
        y: hitBox.bottom + WORLD_LABEL_HITBOX_GAP_PX
      };
}

export function pngInteractionHitBox(input: Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  geometry: RuntimePngInteractionGeometry;
  paddingPx?: number;
}>): ScreenHitBox {
  const centerX = input.x + (input.geometry.centerX - input.anchorX) * input.width;
  const centerY = input.y + (input.geometry.centerY - input.anchorY) * input.height;
  if (input.geometry.shape === "circle") {
    return {
      shape: "circle",
      x: centerX,
      y: centerY,
      radius: input.geometry.radiusPx
    };
  }
  const halfWidth = input.width * input.geometry.width / 2 + (input.paddingPx ?? 0);
  const halfHeight = input.height * input.geometry.height / 2 + (input.paddingPx ?? 0);
  return {
    shape: "rectangle",
    left: centerX - halfWidth,
    top: centerY - halfHeight,
    right: centerX + halfWidth,
    bottom: centerY + halfHeight
  };
}
