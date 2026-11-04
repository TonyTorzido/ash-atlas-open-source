import {
  runtimePngItemGroundHitGeometry,
  runtimePngItemPresentation,
  runtimePngItemPresentationKey,
  type RuntimePngInteractionGeometry,
  type RuntimeSpritePresentation
} from "@ash-atlas/shared";

import { groundItemVisualHeight } from "../map/spritePresentation.js";

export type GroundItemGeometry = Readonly<{
  artworkKey: string;
  presentation: RuntimeSpritePresentation;
  geometry: RuntimePngInteractionGeometry;
  visualWidthUnits: number;
  visualHeightUnits: number;
  hitWidthUnits: number;
  hitHeightUnits: number;
  hitOffsetXUnits: number;
  hitOffsetYUnits: number;
}>;

/**
 * Resolve one item ground frame for every indoor renderer. The visual frame
 * is square because ItemArtwork uses contain-fit artwork; normalized custom
 * hit geometry changes only the button frame, never the authored visual size.
 */
export function groundItemGeometryForArtwork(
  itemId: string,
  variant: string | null | undefined,
  playerVisualHeight: number
): GroundItemGeometry {
  const artworkKey = itemId === "enchantment_stone" && variant
    ? `${itemId}:${variant}`
    : runtimePngItemPresentationKey(itemId);
  const presentation = runtimePngItemPresentation(artworkKey)
    ?? runtimePngItemPresentation("leather")!;
  const geometry = runtimePngItemGroundHitGeometry(presentation);
  const visualHeightUnits = groundItemVisualHeight(playerVisualHeight, presentation);
  const geometryWidth = geometry.shape === "rectangle"
    ? geometry.width
    : geometry.radiusPx * 2 / 28;
  const geometryHeight = geometry.shape === "rectangle"
    ? geometry.height
    : geometry.radiusPx * 2 / 28;
  return {
    artworkKey,
    presentation,
    geometry,
    visualWidthUnits: visualHeightUnits,
    visualHeightUnits,
    hitWidthUnits: visualHeightUnits * geometryWidth,
    hitHeightUnits: visualHeightUnits * geometryHeight,
    hitOffsetXUnits: (geometry.centerX - 0.5) * visualHeightUnits,
    hitOffsetYUnits: (geometry.centerY - 0.5) * visualHeightUnits
  };
}

