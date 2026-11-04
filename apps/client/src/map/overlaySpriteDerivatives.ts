import { Rectangle, type Texture } from "pixi.js";
import {
  overlaySpriteSource,
  type OverlaySpriteSizeTable,
  type OverlaySpriteSource
} from "./overlaySpriteDerivativeNaming.js";

function parseSizeTable(raw: string): OverlaySpriteSizeTable {
  // Unreplaced (tests, tooling without the Vite plugin) is not JSON: no derivatives.
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as OverlaySpriteSizeTable : {};
  } catch {
    return {};
  }
}

const sizeTable: OverlaySpriteSizeTable = parseSizeTable("__ASH_ATLAS_OVERLAY_SPRITE_SIZES__");

/** The downscaled derivative and logical size for a source URL, or null when none is served. */
export function overlaySpriteDerivativeFor(url: string): OverlaySpriteSource | null {
  return overlaySpriteSource(sizeTable, url);
}

/**
 * Makes a texture loaded from a downscaled derivative present at the source
 * art's size. `orig` is the logical size Pixi uses for sprite bounds,
 * `texture.width/height`, and `sprite.width/height`; `frame` stays the pixel
 * size, so UVs still span the whole image.
 */
export function applyLogicalTextureSize(texture: Texture, width: number, height: number): void {
  if (texture.orig.width === width && texture.orig.height === height) return;
  (texture as { orig: Rectangle }).orig = new Rectangle(0, 0, width, height);
}
