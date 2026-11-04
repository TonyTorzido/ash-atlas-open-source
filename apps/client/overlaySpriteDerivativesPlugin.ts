import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import type { Plugin } from "vite";
import {
  OVERLAY_SPRITE_DERIVATIVE_SUFFIX,
  OVERLAY_SPRITE_MAX_SIDE_PX,
  OVERLAY_SPRITE_SIZES_MARKER,
  overlaySpriteDerivativeKey,
  type OverlaySpriteSizeTable
} from "./src/map/overlaySpriteDerivativeNaming.js";

/**
 * Serves world-overlay sprite art downscaled to at most 1024 px on the longest
 * side. Source PNGs are never touched: the build emits `<name>.s1024.png`
 * beside each large overlay sprite, and the dev server derives it on request.
 * The overlay loads the derivative and restores the source size for
 * presentation (see applyLogicalTextureSize). Player appearance art, UI art,
 * and dungeon floors are not in the candidate set.
 */

// src/assets folders the Pixi overlay draws from. Everything else (fishing and
// plant backgrounds, world overlays, crests, ability icons, greenhouse UI
// overlays) keeps its original file only.
const OVERLAY_ASSET_FOLDERS = new Set([
  "", "structures", "mobs", "items", "status-effects", "goblins", "military", "dogs",
  "city-construction"
]);
const EXCLUDED_ASSET_FOLDERS = ["structures/greenhouse-overlays"];
// public/assets files the overlay loads: dungeon entrance art.
const PUBLIC_OVERLAY_FILE = /(?:^|\/)(?:entrance|orc-cave-entrance)\.png$/u;

type Derivative = Readonly<{
  buffer: Buffer;
  sourceWidth: number;
  sourceHeight: number;
}>;

type Candidate = Readonly<{ file: string; key: string; derivativeFileName: string }>;

/** `path` is relative to src/assets. */
export function isOverlaySpriteAssetPath(path: string): boolean {
  const normalized = path.split(sep).join("/");
  if (!/\.png$/iu.test(normalized)) return false;
  if (EXCLUDED_ASSET_FOLDERS.some((folder) => normalized.startsWith(`${folder}/`))) return false;
  const slash = normalized.lastIndexOf("/");
  const folderPath = slash < 0 ? "" : normalized.slice(0, slash);
  // Allowed folders and their nested folders (mobs/ashen, items/enchantment-stones).
  return OVERLAY_ASSET_FOLDERS.has(folderPath.split("/")[0] ?? "");
}

function* walkPngs(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkPngs(path);
    else if (entry.isFile() && /\.png$/iu.test(entry.name)) yield path;
  }
}

/** Replaces the quoted marker literal with the JSON table as a string literal. */
export function injectSizeTable(code: string, table: OverlaySpriteSizeTable): string {
  const literal = JSON.stringify(JSON.stringify(table));
  const quoted = new RegExp(`(["'\`])${OVERLAY_SPRITE_SIZES_MARKER}\\1`, "gu");
  return code.replace(quoted, () => literal);
}

export function overlaySpriteDerivatives(): Plugin {
  let root = process.cwd();
  let isBuild = false;
  const derivatives = new Map<string, Promise<Derivative | null>>();

  const derive = (file: string): Promise<Derivative | null> => {
    let pending = derivatives.get(file);
    if (!pending) {
      pending = (async () => {
        const input = await readFile(file);
        const metadata = await sharp(input).metadata();
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        if (Math.max(width, height) <= OVERLAY_SPRITE_MAX_SIDE_PX) return null;
        const buffer = await sharp(input)
          .resize({
            width: OVERLAY_SPRITE_MAX_SIDE_PX,
            height: OVERLAY_SPRITE_MAX_SIDE_PX,
            fit: "inside",
            withoutEnlargement: true,
            kernel: "lanczos3"
          })
          .png({ compressionLevel: 9, effort: 10 })
          .toBuffer();
        return { buffer, sourceWidth: width, sourceHeight: height };
      })();
      derivatives.set(file, pending);
    }
    return pending;
  };

  // Dev only needs the source size to build the table; the resize itself waits
  // for the first request for that derivative.
  const measure = async (file: string): Promise<[number, number] | null> => {
    const metadata = await sharp(file).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    return Math.max(width, height) > OVERLAY_SPRITE_MAX_SIDE_PX ? [width, height] : null;
  };

  const assetsRoot = (): string => join(root, "src", "assets");
  const publicAssetsRoot = (): string => join(root, "public", "assets");

  const sourceCandidates = (): Candidate[] =>
    [...walkPngs(assetsRoot())]
      .filter((file) => isOverlaySpriteAssetPath(relative(assetsRoot(), file)))
      .map((file) => {
        const key = relative(assetsRoot(), file).split(sep).join("/");
        return { file, key, derivativeFileName: overlaySpriteDerivativeKey(key) };
      });

  const publicCandidates = (): Candidate[] =>
    [...walkPngs(publicAssetsRoot())]
      .map((file) => relative(publicAssetsRoot(), file).split(sep).join("/"))
      .filter((key) => PUBLIC_OVERLAY_FILE.test(key))
      .map((key) => ({
        file: join(publicAssetsRoot(), key),
        key,
        derivativeFileName: overlaySpriteDerivativeKey(key)
      }));

  return {
    name: "ash-atlas-overlay-sprite-derivatives",
    configResolved(config) {
      root = config.root;
      isBuild = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
        } catch {
          return next();
        }
        if (!pathname.endsWith(OVERLAY_SPRITE_DERIVATIVE_SUFFIX)) return next();
        const sourcePath = `${pathname.slice(0, -OVERLAY_SPRITE_DERIVATIVE_SUFFIX.length)}.png`;
        let file: string | null = null;
        if (sourcePath.startsWith("/src/assets/")) {
          const relativePath = sourcePath.slice("/src/assets/".length);
          if (isOverlaySpriteAssetPath(relativePath)) file = resolve(assetsRoot(), relativePath);
        } else if (sourcePath.startsWith("/assets/")) {
          const relativePath = sourcePath.slice("/assets/".length);
          if (PUBLIC_OVERLAY_FILE.test(relativePath)) file = resolve(publicAssetsRoot(), relativePath);
        }
        if (
          !file ||
          !(file.startsWith(assetsRoot() + sep) || file.startsWith(publicAssetsRoot() + sep)) ||
          !existsSync(file)
        ) return next();
        try {
          const derivative = await derive(file);
          if (!derivative) return next();
          response.statusCode = 200;
          response.setHeader("Content-Type", "image/png");
          response.setHeader("Cache-Control", "no-cache");
          response.end(derivative.buffer);
        } catch {
          next();
        }
      });
    },
    async transform(code, id) {
      if (isBuild || !code.includes(OVERLAY_SPRITE_SIZES_MARKER)) return null;
      if (!(id.split("?", 1)[0] ?? "").endsWith("src/map/overlaySpriteDerivatives.ts")) return null;
      const table: Record<string, [number, number]> = {};
      for (const candidate of [...sourceCandidates(), ...publicCandidates()]) {
        const size = await measure(candidate.file);
        if (size) table[candidate.key] = size;
      }
      return { code: injectSizeTable(code, table), map: null };
    },
    async generateBundle(_options, bundle) {
      const table: Record<string, [number, number]> = {};
      const sourceByPath = new Map(sourceCandidates().map((candidate) => [candidate.file, candidate]));
      for (const output of Object.values(bundle)) {
        if (output.type !== "asset") continue;
        for (const name of output.originalFileNames ?? []) {
          const candidate = sourceByPath.get(resolve(root, name));
          if (!candidate) continue;
          const derivative = await derive(candidate.file);
          if (!derivative) continue;
          table[output.fileName.replace(/^assets\//u, "")] = [derivative.sourceWidth, derivative.sourceHeight];
          this.emitFile({
            type: "asset",
            fileName: overlaySpriteDerivativeKey(output.fileName),
            source: derivative.buffer
          });
          break;
        }
      }
      for (const candidate of publicCandidates()) {
        const derivative = await derive(candidate.file);
        if (!derivative) continue;
        table[candidate.key] = [derivative.sourceWidth, derivative.sourceHeight];
        this.emitFile({
          type: "asset",
          fileName: `assets/${candidate.derivativeFileName}`,
          source: derivative.buffer
        });
      }
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk" && output.code.includes(OVERLAY_SPRITE_SIZES_MARKER)) {
          output.code = injectSizeTable(output.code, table);
        }
      }
    }
  };
}
