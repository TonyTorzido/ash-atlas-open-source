/**
 * Naming shared by the build-time sprite downscaler (overlaySpriteDerivatives
 * plugin in vite.config.ts) and the overlay's texture loader. Pure string
 * helpers only so the Vite config can import them without pulling in Pixi.
 */
export const OVERLAY_SPRITE_MAX_SIDE_PX = 1024;
export const OVERLAY_SPRITE_DERIVATIVE_SUFFIX = ".s1024.png";
/** Replaced at dev-serve and build time with the JSON size table. */
export const OVERLAY_SPRITE_SIZES_MARKER = "__ASH_ATLAS_OVERLAY_SPRITE_SIZES__";

/** Source pixel size by asset key, for sources that have a downscaled derivative. */
export type OverlaySpriteSizeTable = Readonly<Record<string, readonly [number, number]>>;

/**
 * Asset key shared by dev and production URLs: the path after the last
 * `assets/` segment, so `/src/assets/mobs/wolf.png` is `mobs/wolf.png` and the
 * hashed `/assets/wolf-AbC123.png` is `wolf-AbC123.png`.
 */
export function overlaySpriteAssetKey(url: string): string | null {
  if (/^(?:data|blob):/i.test(url)) return null;
  const path = url.split(/[?#]/u, 1)[0] ?? "";
  if (!/\.png$/iu.test(path)) return null;
  const match = /(?:^|\/)assets\/((?:(?!(?:^|\/)assets\/).)+)$/u.exec(path);
  return match?.[1] ?? null;
}

export function overlaySpriteDerivativeUrl(url: string): string {
  return url.replace(/\.png(?=$|[?#])/iu, OVERLAY_SPRITE_DERIVATIVE_SUFFIX);
}

export function overlaySpriteDerivativeKey(key: string): string {
  return key.replace(/\.png$/iu, OVERLAY_SPRITE_DERIVATIVE_SUFFIX);
}

export type OverlaySpriteSource = Readonly<{
  /** URL to fetch: the downscaled derivative. */
  url: string;
  /** Logical (source art) size the sprite must still present at. */
  width: number;
  height: number;
}>;

export function overlaySpriteSource(
  table: OverlaySpriteSizeTable,
  url: string
): OverlaySpriteSource | null {
  const key = overlaySpriteAssetKey(url);
  const size = key === null ? undefined : table[key];
  if (!size) return null;
  return { url: overlaySpriteDerivativeUrl(url), width: size[0], height: size[1] };
}
