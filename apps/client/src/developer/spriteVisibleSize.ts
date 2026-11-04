import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Measures how big each mob/pet/boss PNG actually looks in game. On-screen height is the
 * presentation `baseHeightPx` applied to the FULL PNG canvas (transparent margin included), so the
 * visible creature height is `baseHeightPx * (opaque bbox height / canvas height)`.
 * Shared by `pnpm sprite:sizes` and the sprite size guard test.
 */

/** Alpha above this counts as visible (matches the diagnosis that sized the reference mobs). */
export const VISIBLE_ALPHA_THRESHOLD = 24;

const CLIENT_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_DATA = resolve(CLIENT_SRC, "../../../packages/shared/src/data");

export interface PngMeasure {
  readonly width: number;
  readonly height: number;
  /** Opaque bounding box height / canvas height. */
  readonly fillHeight: number;
  /** Opaque bounding box width / canvas width. */
  readonly fillWidth: number;
}

export function measurePng(buffer: Buffer): PngMeasure {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24]!;
  const colorType = buffer[25]!;
  const interlace = buffer[28]!;
  if (interlace !== 0) throw new Error("Interlaced PNG not supported");
  if (colorType !== 6 && colorType !== 2 && colorType !== 4 && colorType !== 0) {
    throw new Error(`PNG color type ${colorType} not supported`);
  }
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} not supported`);
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType]!;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const hasAlpha = colorType === 6 || colorType === 4;
  let prev = Buffer.alloc(stride);
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart]!;
    const row = Buffer.from(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = (row[i]! + add) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const alpha = hasAlpha ? row[x * channels + channels - 1]! : 255;
      if (alpha > VISIBLE_ALPHA_THRESHOLD) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    prev = row;
  }
  if (bottom < 0) return { width, height, fillHeight: 0, fillWidth: 0 };
  return {
    width,
    height,
    fillHeight: (bottom - top + 1) / height,
    fillWidth: (right - left + 1) / width
  };
}

export interface SpriteSizeRow {
  readonly group: "mob" | "pet" | "boss";
  /** MobArtworkKey, pet species, or boss id. */
  readonly artKey: string;
  /** Key in runtime-png-presentation.json sprites (or the boss catalog). */
  readonly presentationKey: string;
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly fillHeight: number;
  readonly fillWidth: number;
  readonly baseHeightPx: number;
  readonly visibleHeightPx: number;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function readJson<T>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

type PresentationFile = {
  sprites: Record<string, { baseHeightPx: number }>;
};

export function loadSpritePresentations(): PresentationFile["sprites"] {
  return readJson<PresentationFile>(resolve(SHARED_DATA, "runtime-png-presentation.json")).sprites;
}

/** artworkKey -> absolute PNG path, parsed from mobArtwork.ts (PNG imports + dungeon globs). */
function parseMobArtworkFiles(): Map<string, string> {
  const source = readText(resolve(CLIENT_SRC, "map/mobArtwork.ts"));
  const imports = new Map<string, string>();
  for (const match of source.matchAll(/^import (\w+) from "(\.\.\/assets\/[^"]+\.png)";/gm)) {
    imports.set(match[1]!, resolve(CLIENT_SRC, "map", match[2]!));
  }
  const block = /export const MOB_ARTWORK_URLS = \{([\s\S]*?)\n\} as/.exec(source)?.[1] ?? "";
  const files = new Map<string, string>();
  for (const line of block.split("\n")) {
    const glob = /^\s*(\w+): \w+\["(\.\.\/assets\/[^"]+\.png)"\]/.exec(line);
    if (glob) {
      files.set(glob[1]!, resolve(CLIENT_SRC, "map", glob[2]!));
      continue;
    }
    const aliased = /^\s*(\w+): (\w+),?\s*$/.exec(line);
    const plain = /^\s*(\w+),?\s*$/.exec(line);
    const key = aliased?.[1] ?? plain?.[1];
    const ref = aliased?.[2] ?? plain?.[1];
    if (key && ref && imports.has(ref)) files.set(key, imports.get(ref)!);
  }
  return files;
}

/** artworkKey -> presentation key, parsed from mobSpritePresentation.ts. */
function parseMobPresentationKeys(): Map<string, string> {
  const source = readText(resolve(CLIENT_SRC, "map/mobSpritePresentation.ts"));
  const keys = new Map<string, string>();
  for (const match of source.matchAll(/^\s*(\w+): SPRITE_PRESENTATION\.(\w+),?$/gm)) {
    keys.set(match[1]!, match[2]!);
  }
  return keys;
}

function parsePetFiles(): Array<{ species: string; file: string; presentationKey: string }> {
  const source = readText(resolve(CLIENT_SRC, "petArtwork.ts"));
  const imports = new Map<string, string>();
  for (const match of source.matchAll(/^import (\w+) from "(\.\/assets\/(?:pets|dogs)\/[^"]+\.png)";/gm)) {
    imports.set(match[1]!, resolve(CLIENT_SRC, match[2]!));
  }
  const rows: Array<{ species: string; file: string; presentationKey: string }> = [];
  for (const [name, section] of [
    ["PET_ARTWORK_URLS", "petCompanion"],
    ["MINION_ARTWORK_URLS", "minionLarge"]
  ] as const) {
    const block = new RegExp(`export const ${name}[^=]*= \\{([\\s\\S]*?)\\n\\};`).exec(source)?.[1] ?? "";
    for (const match of block.matchAll(/^\s*(\w+): (\w+),?$/gm)) {
      const file = imports.get(match[2]!);
      if (!file) continue;
      rows.push({
        species: match[1]!,
        file,
        presentationKey: match[1] === "trail_hound" ? "dog" : match[1] === "glade_wisp" ? "petWisp" : section
      });
    }
  }
  return rows;
}

function bossRows(): Array<{ id: string; file: string; baseHeightPx: number }> {
  const catalog = readJson<{
    bosses: Array<{ bossId: string; bodyAssetKey: string; presentation: { baseHeightPx: number } }>;
  }>(resolve(SHARED_DATA, "boss-appearance-catalog.json"));
  const dirs = [
    resolve(CLIENT_SRC, "assets"),
    resolve(CLIENT_SRC, "../../../packages/player-renderer/src/assets/boss-appearance")
  ];
  const rows: Array<{ id: string; file: string; baseHeightPx: number }> = [];
  for (const boss of catalog.bosses) {
    for (const dir of dirs) {
      try {
        const file = resolve(dir, boss.bodyAssetKey);
        readFileSync(file).subarray(0, 1);
        rows.push({ id: boss.bossId, file, baseHeightPx: boss.presentation.baseHeightPx });
        break;
      } catch {
        // try the next directory
      }
    }
  }
  return rows;
}

const measureCache = new Map<string, PngMeasure>();
function measureFile(file: string): PngMeasure {
  let measure = measureCache.get(file);
  if (!measure) {
    measure = measurePng(readFileSync(file));
    measureCache.set(file, measure);
  }
  return measure;
}

/** One row per wired mob artwork key, pet species and boss catalog entry. */
export function measureSpriteSizes(): SpriteSizeRow[] {
  const presentations = loadSpritePresentations();
  const rows: SpriteSizeRow[] = [];
  const push = (
    group: SpriteSizeRow["group"],
    artKey: string,
    presentationKey: string,
    file: string,
    baseHeightPx: number
  ): void => {
    const measure = measureFile(file);
    rows.push({
      group,
      artKey,
      presentationKey,
      file,
      width: measure.width,
      height: measure.height,
      fillHeight: measure.fillHeight,
      fillWidth: measure.fillWidth,
      baseHeightPx,
      visibleHeightPx: baseHeightPx * measure.fillHeight
    });
  };
  const files = parseMobArtworkFiles();
  const presentationKeys = parseMobPresentationKeys();
  for (const [artKey, file] of files) {
    const presentationKey = presentationKeys.get(artKey) ?? (artKey === "generic" ? "genericMob" : artKey);
    const base = presentations[presentationKey]?.baseHeightPx;
    if (base === undefined) continue;
    push("mob", artKey, presentationKey, file, base);
  }
  for (const pet of parsePetFiles()) {
    const base = presentations[pet.presentationKey]?.baseHeightPx;
    if (base === undefined) continue;
    push("pet", pet.species, pet.presentationKey, pet.file, base);
  }
  for (const boss of bossRows()) {
    push("boss", boss.id, boss.id, boss.file, boss.baseHeightPx);
  }
  return rows;
}
