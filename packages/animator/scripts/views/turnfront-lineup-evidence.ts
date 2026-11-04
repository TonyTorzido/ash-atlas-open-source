// Lineup of every character view (packages/animator/README.md). Run from
// packages/animator after `bash scripts/views/turnfront-lineup-rigs.sh`:
//   npx tsx scripts/views/turnfront-lineup-evidence.ts
// Jacket B worn, face combo A (almond eyes, soldier crop) on the front views, the stand-in back hair on the back views.
// Order: FRONT (idle) | TURNED LEFT | TURNED RIGHT | BACK | BACK TURNED LEFT | BACK TURNED RIGHT. "Right" views are image
// flips of the "left" ones (what a runtime mirror shows). view040 = 0.4 phone size, view0471 = max in-game zoom.
// Writes into views/turned-front/lineup/:
// - lineup-view{040,0471}.png: the six views at rest (row 1, Jacket B) + the bare back body BACK / BACK TURNED L / R
//   (row 2);
// - lineup-walk-view{040,0471}-30fps.gif: the six views walking in sync (walk_in_place, same phase);
// (the turnaround GIFs were dropped 2026-10-19: dropped the circle demo; five-anims/ has the clips)
// - back-turn-diagnostic-view0471.png: BACK vs BACK TURNED LEFT at max zoom with the spine line and head axis marked.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { renderFrames, writeGif, type RenderResult } from "../../src/cli/render.js";
import { decodePng, encodePng, writePng } from "../../src/tools/png.js";
import { drawText, fillRect } from "../../src/tools/review.js";
import type { MutableImage, RgbaImage } from "../../src/tools/image.js";

const DIR = "../../docs/plans/atlas-animator-demos/views/turned-front/lineup";
const RIG = (n: string) => join(DIR, "rig", `${n}.anim.json`);
const BG = 0x1e2430;
const BG3: [number, number, number] = [0x1e, 0x24, 0x30];
const VIEWS: [number, string][] = [[0.4, "040"], [0.4712, "0471"]];
const WALK = 30; // walk_in_place is 1 s: 30 frames per loop at 30 fps

type View = { label: string; rig: string; flip: boolean };
const LINEUP: View[] = [
  { label: "FRONT (IDLE)", rig: "jacketb-turn00-faceA", flip: false },
  { label: "TURNED LEFT", rig: "jacketb-turn15-faceA", flip: false },
  { label: "TURNED RIGHT", rig: "jacketb-turn15-faceA", flip: true },
  { label: "BACK", rig: "jacketb-back-turn00-hairA", flip: false },
  { label: "BACK TURNED LEFT", rig: "jacketb-back-turn15-hairA", flip: false },
  { label: "BACK TURNED RIGHT", rig: "jacketb-back-turn15-hairA", flip: true }
];
const BARE: View[] = [
  { label: "BARE BACK", rig: "body-back-turn00-hairA", flip: false },
  { label: "BARE BACK TURNED LEFT", rig: "body-back-turn15-hairA", flip: false },
  { label: "BARE BACK TURNED RIGHT", rig: "body-back-turn15-hairA", flip: true }
];
function frame(scale: number, background: number | null = BG) {
  const w = Math.round(640 * scale), h = Math.round(1180 * scale);
  return { scale, width: w, height: h, x: Math.round(w / 2), y: Math.round(h - 300 * scale), background };
}
const img = (r: RenderResult, i: number) => decodePng(r.frames[i % r.frames.length]!.png as Buffer);
function flip(im: RgbaImage): MutableImage {
  const out = { width: im.width, height: im.height, data: new Uint8Array(im.data.length) };
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    const s = (y * im.width + (im.width - 1 - x)) * 4;
    out.data.set(im.data.subarray(s, s + 4), (y * im.width + x) * 4);
  }
  return out;
}
const blank = (w: number, h: number): MutableImage => {
  const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  fillRect(out, 0, 0, w, h, BG3);
  return out;
};
/** Alpha-over (straight alpha) of src onto an opaque dst at x, y. */
function over(dst: MutableImage, src: RgbaImage, x: number, y: number) {
  for (let yy = 0; yy < src.height; yy++) {
    const dy = y + yy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let xx = 0; xx < src.width; xx++) {
      const dx = x + xx;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (yy * src.width + xx) * 4, d = (dy * dst.width + dx) * 4, a = src.data[s + 3]! / 255;
      if (a === 0) continue;
      for (let c = 0; c < 3; c++) dst.data[d + c] = Math.round(src.data[s + c]! * a + dst.data[d + c]! * (1 - a));
      dst.data[d + 3] = 255;
    }
  }
}
function sheet(rows: { title: string; tiles: [string, RgbaImage][] }[], gap = 8): MutableImage {
  const lh = 22, th = 22;
  const w = Math.max(...rows.map((r) => r.tiles.reduce((s, [, i]) => s + i.width + gap, gap)));
  const h = rows.reduce((s, r) => s + th + lh + Math.max(...r.tiles.map(([, i]) => i.height)) + gap, gap);
  const out = blank(w, h);
  let y = gap;
  for (const r of rows) {
    drawText(out, r.title, gap, y + 2, 2, [255, 214, 120]);
    y += th;
    let x = gap;
    for (const [label, im] of r.tiles) {
      drawText(out, label, x + 2, y + 2, 2, [240, 240, 240]);
      over(out, im, x, y + lh);
      x += im.width + gap;
    }
    y += lh + Math.max(...r.tiles.map(([, i]) => i.height)) + gap;
  }
  return out;
}
const pick = (r: RenderResult, i: number, v: View) => (v.flip ? flip(img(r, i)) : img(r, i));
const gif = (frames: MutableImage[], fps = 30): RenderResult => ({
  frames: frames.map((f, i) => ({ time: i / fps, png: encodePng(f) })), width: frames[0]!.width, height: frames[0]!.height, fps,
  clip: "walk_in_place", renderer: "composite", scale: 1, missingTextures: []
} as unknown as RenderResult);

async function main() {
  for (const [scale, tag] of VIEWS) {
    const v = frame(scale);
    const cache = new Map<string, RenderResult>();
    const walkOf = async (rig: string, background: number | null = BG) => {
      const key = `${rig}|${background}`;
      if (!cache.has(key)) cache.set(key, await renderFrames({ document: RIG(rig), clip: "walk_in_place", fps: 30, frames: WALK, ...frame(scale, background) }));
      return cache.get(key)!;
    };
    const rest = async (view: View) => {
      const im = img(await renderFrames({ document: RIG(view.rig), fps: 30, frames: 1, ...v }), 0);
      return view.flip ? flip(im) : im;
    };
    // 1. rest lineup
    const row1: [string, RgbaImage][] = [];
    for (const view of LINEUP) row1.push([view.label, await rest(view)]);
    const row2: [string, RgbaImage][] = [];
    for (const view of BARE) row2.push([view.label, await rest(view)]);
    writePng(join(DIR, `lineup-view${tag}.png`), sheet([
      { title: `jacket B + face combo A (almond / soldier crop)  view ${scale}  rest`, tiles: row1 },
      { title: "bare back body + stand-in back hair", tiles: row2 }
    ]));
    // 2. lineup walking in sync
    const walks: RenderResult[] = [];
    for (const view of LINEUP) walks.push(await walkOf(view.rig));
    const wf: MutableImage[] = [];
    for (let i = 0; i < WALK; i++) wf.push(sheet([{ title: `walking in sync  view ${scale}`, tiles: LINEUP.map((view, k) => [view.label, pick(walks[k]!, i, view)] as [string, RgbaImage]) }]));
    writeGif(gif(wf), join(DIR, `lineup-walk-view${tag}-30fps.gif`));
    // 4. max zoom diagnostic: back vs back turned left, spine (canvas x of the chest centre line) and head axis marked
    if (tag === "0471") {
      const params = JSON.parse(readFileSync(join(DIR, "rig", "jacketb-back-turn15.params.json"), "utf-8"));
      const hair = JSON.parse(readFileSync(join(DIR, "rig", "jacketb-back-turn15-hairA.face.json"), "utf-8"));
      const tiles: [string, RgbaImage][] = [];
      for (const [label, rig, spine, head] of [
        ["BACK", "jacketb-back-turn00-hairA", 0, 0],
        ["BACK TURNED LEFT", "jacketb-back-turn15-hairA", params.centreLineShiftChest as number, (params.headDx as number) + (hair.hairShiftPx as number)]
      ] as [string, string, number, number][]) {
        const im = img(await renderFrames({ document: RIG(rig), fps: 30, frames: 1, ...v }), 0) as MutableImage;
        const mark = (dx: number, y0: number, y1: number, col: [number, number, number]) => {
          const x = Math.round(v.x + dx * scale);
          for (let y = Math.round(v.y + y0 * scale); y < Math.round(v.y + y1 * scale); y += 4) fillRect(im, x, y, 1, 2, col);
        };
        mark(0, -960, 400, [120, 120, 120]); // the straight back's axis
        mark(spine, -330, -40, [255, 214, 120]); // spine line on the chest
        mark(head, -800, -480, [140, 220, 255]); // back-of-head centre (head bone shift + hair shift)
        tiles.push([label, im]);
      }
      writePng(join(DIR, `back-turn-diagnostic-view${tag}.png`), sheet([{ title: "grey axis  yellow spine  blue head", tiles }]));
    }
  }
  console.log("wrote lineup evidence");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
