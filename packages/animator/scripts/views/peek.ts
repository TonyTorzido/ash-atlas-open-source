/*
 * Atlas Animator multi-view, phase 2b: cheap previews of a built view rig, cropped to the character.
 *   npx tsx scripts/views/peek.ts <rig.anim.json> <out dir> <prefix> [--rest <name>] [<clip> ...]
 * --rest writes <out>/<prefix>-<name>.png (rest pose at 1x); each clip writes <out>/<prefix>-<clip>.gif (0.4, 30 fps).
 * Crops are the opaque box of the frames (background b4b9c2), padded; frames share one box.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderFrames, writeGif } from "../../src/cli/render.js";
import { decodePng, encodePng } from "../../src/tools/png.js";
import type { RgbaImage } from "../../src/tools/image.js";

const BG = 0xb4b9c2;
const args = process.argv.slice(2);
const [rig, out, prefix] = args as [string, string, string];
let restName: string | null = null;
const clips: string[] = [];
for (let i = 3; i < args.length; i++) {
  if (args[i] === "--rest") restName = args[++i] as string;
  else clips.push(args[i] as string);
}
mkdirSync(out, { recursive: true });

function box(imgs: RgbaImage[], pad: number): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const im of imgs) for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    const o = (y * im.width + x) * 4;
    if (im.data[o] === 0xb4 && im.data[o + 1] === 0xb9 && im.data[o + 2] === 0xc2) continue;
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const w = imgs[0]!.width, h = imgs[0]!.height;
  return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(w, x1 + pad + 1), Math.min(h, y1 + pad + 1)];
}
function crop(im: RgbaImage, [x0, y0, x1, y1]: [number, number, number, number]): RgbaImage {
  const w = x1 - x0, h = y1 - y0;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(im.data.subarray(((y0 + y) * im.width + x0) * 4, ((y0 + y) * im.width + x1) * 4), y * w * 4);
  return { width: w, height: h, data };
}

if (restName) {
  const r = await renderFrames({ document: rig, clip: null, scale: 1, background: BG });
  const im = decodePng(r.frames[0]!.png as Buffer);
  const path = join(out, `${prefix}-${restName}.png`);
  writeFileSync(path, encodePng(crop(im, box([im], 14))));
  console.log("wrote", path);
}
for (const clip of clips) {
  const r = await renderFrames({ document: rig, clip, fps: 30, scale: 0.4, background: BG });
  const imgs = r.frames.map((f) => decodePng(f.png as Buffer));
  const b = box(imgs, 6);
  const frames = r.frames.map((f, i) => ({ ...f, png: encodePng(crop(imgs[i]!, b)) }));
  const path = join(out, `${prefix}-${clip}.gif`);
  writeGif({ ...r, frames, width: b[2] - b[0], height: b[3] - b[1] }, path);
  console.log("wrote", path, frames.length, "frames");
}
