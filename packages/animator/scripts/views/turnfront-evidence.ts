// Turned-front PREVIEW evidence (packages/animator/README.md). Run from
// packages/animator after `python scripts/views/turnfront.py` has written the turned rigs into turned-front/rig:
//   npx tsx scripts/views/turnfront-evidence.ts
// Writes into docs/plans/atlas-animator-demos/views/turned-front/:
// - angles-rest-walk-view040.png / -view0471.png: straight front | 10 | 15 | 20 deg, rest and two walk frames, labelled;
// - angles-walk-view040-30fps.gif (+ -view0471): the four bodies walking side by side in one GIF, labelled by angle;
// - jacketb-before-after-view040.png / -view0471.png / -3x-diagnostic.png (nearest, diagnostic only): Jacket B straight front (BEFORE) vs
//   reprojected at 15 and 20 deg (AFTER), rest + walk frames;
// - jacketb-turn15-walk-view040-30fps.gif (+ -mirrored, + -view0471): Jacket B at 15 deg walking, BEFORE | AFTER;
// - jacketb-vs-refs.png: the reprojection beside the consult-14 reference turnarounds.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { renderFrames, writeGif, type RenderResult } from "../../src/cli/render.js";
import { decodePng, encodePng, readPng, writePng } from "../../src/tools/png.js";
import { grid, drawText, fillRect } from "../../src/tools/review.js";
import type { MutableImage, RgbaImage } from "../../src/tools/image.js";

const DIR = "../../docs/plans/atlas-animator-demos/views/turned-front";
const RIG = (n: string) => join(DIR, "rig", `${n}.anim.json`);
const REFS = "C:/Users/dev/Documents/art-drops/animator-consult-14/refs";
const BG = 0x1e2430;
// [scale, tag]: 0.4 = the phone-size review view; 0.4712 = max in-game zoom (2x the live 0.2356 display scale)
const VIEWS: [number, string][] = [[0.4, "040"], [0.4712, "0471"]];
const ANGLES: [string, string][] = [["00", "FRONT 0"], ["10", "TURN 10"], ["15", "TURN 15"], ["20", "TURN 20"]];
const WALK_FRAMES = [8, 23];

function frame(scale: number) {
  // the figure spans canvas x 542 +- 260 and y 960 - 700 .. 960 + 290 (head top to feet)
  const w = Math.round(620 * scale), h = Math.round(1040 * scale);
  return { scale, width: w, height: h, x: Math.round(w / 2), y: Math.round(h - 310 * scale), background: BG };
}
const img = (r: RenderResult, i: number) => decodePng(r.frames[i]!.png as Buffer);

function flip(im: RgbaImage): MutableImage {
  const out = { width: im.width, height: im.height, data: new Uint8Array(im.data.length) };
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    const s = (y * im.width + (im.width - 1 - x)) * 4;
    out.data.set(im.data.subarray(s, s + 4), (y * im.width + x) * 4);
  }
  return out;
}
function scaleNearest(im: RgbaImage, k: number): MutableImage {
  const out = { width: im.width * k, height: im.height * k, data: new Uint8Array(im.width * k * im.height * k * 4) };
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const s = (Math.floor(y / k) * im.width + Math.floor(x / k)) * 4;
    out.data.set(im.data.subarray(s, s + 4), (y * out.width + x) * 4);
  }
  return out;
}
function crop(im: RgbaImage, x0: number, y0: number, w: number, h: number): MutableImage {
  const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(im.width - 1, Math.max(0, x0 + x)), sy = Math.min(im.height - 1, Math.max(0, y0 + y));
    out.data.set(im.data.subarray((sy * im.width + sx) * 4, (sy * im.width + sx) * 4 + 4), (y * w + x) * 4);
  }
  return out;
}
function hcat(ims: RgbaImage[], labels: string[], gap = 6): MutableImage {
  const lh = 22;
  const w = ims.reduce((s, i) => s + i.width + gap, gap), h = Math.max(...ims.map((i) => i.height)) + lh;
  const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  fillRect(out, 0, 0, w, h, [0x1e, 0x24, 0x30]);
  let x = gap;
  ims.forEach((im, k) => {
    for (let y = 0; y < im.height; y++) out.data.set(im.data.subarray(y * im.width * 4, (y + 1) * im.width * 4), ((y + lh) * w + x) * 4);
    drawText(out, labels[k]!, x + 2, 4, 2, [240, 240, 240]);
    x += im.width + gap;
  });
  return out;
}
/** One GIF of several renders side by side (same frame count), each labelled. */
function sideBySide(rs: RenderResult[], labels: string[], flipAll = false): RenderResult {
  const frames = rs[0]!.frames.map((f, i) => {
    const ims = rs.map((r) => (flipAll ? flip(img(r, i)) : img(r, i)));
    return { ...f, png: encodePng(hcat(ims, labels)) };
  });
  const first = decodePng(frames[0]!.png as Buffer);
  return { ...rs[0]!, width: first.width, height: first.height, frames };
}

async function main() {
  for (const [scale, tag] of VIEWS) {
    const v = frame(scale);
    // 1. angle previews
    const walks: RenderResult[] = [];
    const tiles: { image: RgbaImage; label: string }[] = [];
    for (const [a, label] of ANGLES) {
      const rest = await renderFrames({ document: RIG(`body-turn${a}`), fps: 30, frames: 1, ...v });
      const walk = await renderFrames({ document: RIG(`body-turn${a}`), clip: "walk_in_place", fps: 30, ...v });
      walks.push(walk);
      tiles.push({ image: img(rest, 0), label: `${label} rest` });
      for (const f of WALK_FRAMES) tiles.push({ image: img(walk, f), label: `${label} walk f${f}` });
    }
    writePng(join(DIR, `angles-rest-walk-view${tag}.png`), grid(tiles, 3 * 4, 1, true));
    writeGif(sideBySide(walks, ANGLES.map(([, l]) => l)), join(DIR, `angles-walk-view${tag}-30fps.gif`));

    // 2. Jacket B before / after
    const jb: [string, string][] = [["jacketb-turn00", "BEFORE front"], ["jacketb-turn15", "AFTER 15"], ["jacketb-turn20", "AFTER 20"]];
    const jt: { image: RgbaImage; label: string }[] = [];
    const jw: RenderResult[] = [];
    for (const [n, label] of jb) {
      const rest = await renderFrames({ document: RIG(n), fps: 30, frames: 1, ...v });
      const walk = await renderFrames({ document: RIG(n), clip: "walk_in_place", fps: 30, ...v });
      jw.push(walk);
      jt.push({ image: img(rest, 0), label: `${label} rest` });
      for (const f of WALK_FRAMES) jt.push({ image: img(walk, f), label: `${label} walk f${f}` });
    }
    writePng(join(DIR, `jacketb-before-after-view${tag}.png`), grid(jt, 9, 1, true));
    writeGif(sideBySide([jw[0]!, jw[1]!], ["BEFORE front", "AFTER 15"]), join(DIR, `jacketb-turn15-walk-view${tag}-30fps.gif`));
    if (tag === "040") {
      writeGif(sideBySide([jw[1]!], ["AFTER 15 mirrored"], true), join(DIR, `jacketb-turn15-walk-view${tag}-30fps-mirrored.gif`));
      // 3x diagnostic of the torso (nearest), rest: BEFORE | AFTER 15 | AFTER 20
      const cx = Math.round(v.x - 270 * scale), cy = Math.round(v.y - 390 * scale), cw = Math.round(540 * scale), ch = Math.round(420 * scale);
      const crops = jt.filter((_, i) => i % 3 === 0).map((t) => scaleNearest(crop(t.image, cx, cy, cw, ch), 3));
      writePng(join(DIR, "jacketb-before-after-3x-diagnostic.png"), hcat(crops, ["BEFORE front (3x)", "AFTER 15 (3x)", "AFTER 20 (3x)"]));
      // 3. the references
      const refs = ["four-direction-reference.png", "turnaround-jacketB-turned.png"].filter((f) => existsSync(join(REFS, f)));
      const ref = refs.map((f) => readPng(join(REFS, f)));
      const ours = hcat(jt.filter((_, i) => i % 3 === 0).map((t) => t.image), ["BEFORE front", "AFTER 15", "AFTER 20"]);
      const scaled = ref.map((r) => {
        const k = Math.max(1, Math.ceil(r.height / ours.height));
        return k > 1 ? downscale(r, k) : r;
      });
      writePng(join(DIR, "jacketb-vs-refs.png"), hcat([ours, ...scaled], ["OURS", ...refs.map((f) => (f.startsWith("four") ? "REF 4-DIR" : "REF TURNAROUND 60"))]));
    }
  }
  console.log("wrote turned-front evidence");
}
function downscale(im: RgbaImage, k: number): MutableImage {
  const w = Math.floor(im.width / k), h = Math.floor(im.height / k);
  const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += im.data[((y * k + j) * im.width + x * k + i) * 4 + c]!;
    out.data[(y * w + x) * 4 + c] = Math.round(s / (k * k));
  }
  return out;
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
