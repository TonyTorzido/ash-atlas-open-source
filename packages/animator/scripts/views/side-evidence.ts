/*
 * Atlas Animator multi-view, phase 2b evidence (packages/animator/README.md): the rest pose of the front body
 * rig, the turned-side rig and the side rig flipped (the other facing), side by side at 0.4 and 1x canvas scale.
 *   npx tsx scripts/views/side-evidence.ts <front anim.json> <side anim.json> <out dir>
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderFrames } from "../../src/cli/render.js";
import { decodePng, writePng } from "../../src/tools/png.js";
import { grid } from "../../src/tools/review.js";
import type { RgbaImage } from "../../src/tools/image.js";

const [front, side, out] = process.argv.slice(2) as [string, string, string];
mkdirSync(out, { recursive: true });

/** Crop to the opaque box of the pair (same box for every view, padded). */
function cropBox(imgs: RgbaImage[], pad: number): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const im of imgs) for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    const o = (y * im.width + x) * 4;
    const bg = im.data[o] === 0x2b && im.data[o + 1] === 0x2b && im.data[o + 2] === 0x2b;
    if (bg) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), x1 + pad, y1 + pad];
}
function crop(im: RgbaImage, [x0, y0, x1, y1]: [number, number, number, number]): RgbaImage {
  const w = Math.min(im.width, x1) - x0;
  const h = Math.min(im.height, y1) - y0;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(im.data.subarray(((y0 + y) * im.width + x0) * 4, ((y0 + y) * im.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data };
}
function flip(im: RgbaImage): RgbaImage {
  const data = new Uint8Array(im.data.length);
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) data.set(im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4), (y * im.width + (im.width - 1 - x)) * 4);
  return { width: im.width, height: im.height, data };
}

for (const [tag, scale] of [["040", 0.4], ["1x", 1]] as const) {
  const shot = async (doc: string) => decodePng((await renderFrames({ document: doc, clip: null, scale, background: 0x2b2b2b })).frames[0]?.png as Buffer);
  const f = await shot(front);
  const s = await shot(side);
  const box = cropBox([f, s, flip(s)], Math.round(12 * scale) + 2);
  const tiles = [
    { image: crop(f, box), label: `front ${tag}` },
    { image: crop(s, box), label: `side ${tag}` },
    { image: crop(flip(s), box), label: `side mirrored ${tag}` }
  ];
  writePng(join(out, `rig-front-side-mirrored-rest-${tag}.png`), grid(tiles, 3, 1));
  process.stdout.write(`wrote rig-front-side-mirrored-rest-${tag}.png\n`);
}
