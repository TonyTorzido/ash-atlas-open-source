// Five stock-body animations: evidence (docs/plans/atlas-animator-demos/views/turned-front/five-anims/five-anims-PLAN.md).
// Run from packages/animator after `bash scripts/views/five-anims-rigs.sh`:
//   npx tsx scripts/views/five-anims-evidence.ts
// then `python scripts/views/five_anims_gates.py` (reads gates-render.json written here, writes gates.json).
// One frame per scale for every clip: width 2 round(320 s) + 1 (odd, so an image flip keeps the root column), height
// round(1448 s), root x = (w - 1) / 2, root y = h - round(300 s), bg 0x1e2430, 30 fps, no retiming.
// Clips: 1 idle (front 0, idle_weight_shift, 96 f); 2 walk down-right = image flip of the front L15 rig built with
// mirrored inputs; 3 walk down-left = front L15; 4 walk up-right = image flip of the back L15 rig built with mirrored
// inputs; 5 walk up-left = back L15 (walk_in_place, 30 f).
// Writes into five-anims/: 0N-<name>-view{040,0471}-30fps.gif, five-up-view{040,0471}-30fps.mp4 (the LCM of the clip lengths: 672 f for 96 + 28)
// and five-up-view{040,0471}-30fps.gif when that GIF is <= 25 MB, else five-up-walks-view{040,0471}-30fps.gif (30 f), sheet-0N-<name>.png (8 frames per row, a row per scale),
// joints/0N-<name>-view0471.png + -4x-diagnostic.png, backhair-heads-view0471.png, feet-back-heel-vs-toe-view0471.png,
// gates-render.json (the render-side gate measurements: G2 framing, G3 idle vs round 2, G6 flip, G7 loops, G8 swim,
// G9 enclosed background holes, and the per-frame motion table: head top, lowest foot row, hand centroids).
// Refine (REFINE-PLAN item 11): `--clips 1,2,3` (default; the locked clips) renders only those clips; the multi-up
// files are then named three-up-*; the back-only sheets (back hair heads, back body, feet) render only with 4 or 5.
// GIF frame times alternate 30/40 ms (centisecond rounding); the MP4 is exact.
// `--set jacketb` (2026-10-20): the same clips 01-03 from five-anims/jacketb/rig (scripts/views/five-anims-jacketb-rigs.sh,
// Jacket B on the refined stock) into five-anims/jacketb/; the joints sheets add the jacket crops (collar, both armpits,
// both cuffs, hem) at the walk's arm swing extremes (f8 / f22) and the contacts (f0 / f14).
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ffmpegPath, renderFrames, writeMp4, type RenderResult } from "../../src/cli/render.js";
import { decodePng, encodePng, writePng } from "../../src/tools/png.js";
import { drawText, fillRect } from "../../src/tools/review.js";
import type { MutableImage, RgbaImage } from "../../src/tools/image.js";

const SET = (() => { const i = process.argv.indexOf("--set"); return i > 0 ? process.argv[i + 1]! : ""; })();
const DIR = join("../../docs/plans/atlas-animator-demos/views/turned-front/five-anims", SET);
const WHO = SET === "jacketb" ? "Jacket B" : "stock body";
const RIG = (n: string) => join(DIR, "rig", `${n}.anim.json`);
const ROUND2 = "../../docs/plans/atlas-animator-demos/views/turned-front/round2/rig/body-turn00-face-shift.anim.json";
const BG = 0x1e2430;
const BG3: [number, number, number] = [0x1e, 0x24, 0x30];
const VIEWS: [number, string][] = [[0.4, "040"], [0.4712, "0471"]];
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (xs: number[]) => xs.reduce((a, b) => (a * b) / gcd(a, b), 1);
const GIF_LIMIT = 25 * 1024 * 1024;

type Clip = { n: number; name: string; label: string; rig: string; clip: string; frames: number; flip: boolean; back: boolean; sheetFrames: number[] };
const WALK_SHEET = [0, 4, 8, 12, 16, 20, 23, 27]; // includes f8 and f23 (legacy 30 f walk: the parked back clips)
// refine P2 (owner D1): the front walks are the template light-step walk, 28 f; contacts f0 / f14 (the lowest pelvis),
// passing f7 / f21 (the highest)
const WALK28_SHEET = [0, 3, 7, 10, 14, 17, 21, 24];
const CLIPS: Clip[] = [
  { n: 1, name: "idle-front", label: "1 IDLE FRONT", rig: "front-turn00-faceA", clip: "idle_weight_shift", frames: 96, flip: false, back: false, sheetFrames: [0, 12, 24, 36, 48, 60, 72, 84] },
  { n: 2, name: "walk-downright-frontR15", label: "2 WALK DOWN-RIGHT", rig: "front-turn15-faceA-mirin", clip: "walk_in_place", frames: 28, flip: true, back: false, sheetFrames: WALK28_SHEET },
  { n: 3, name: "walk-downleft-frontL15", label: "3 WALK DOWN-LEFT", rig: "front-turn15-faceA", clip: "walk_in_place", frames: 28, flip: false, back: false, sheetFrames: WALK28_SHEET },
  { n: 4, name: "walk-upright-backR15", label: "4 WALK UP-RIGHT", rig: "back-turn15-hair-mirin", clip: "walk_in_place", frames: 30, flip: true, back: true, sheetFrames: WALK_SHEET },
  { n: 5, name: "walk-upleft-backL15", label: "5 WALK UP-LEFT", rig: "back-turn15-hair", clip: "walk_in_place", frames: 30, flip: false, back: true, sheetFrames: WALK_SHEET }
];
const tag = (c: Clip) => `0${c.n}-${c.name}`;
const clipsArg = (() => { const i = process.argv.indexOf("--clips"); return i > 0 ? process.argv[i + 1]! : "1,2,3"; })();
const PICK = clipsArg.split(",").map(Number);
const SEL = CLIPS.filter((c) => PICK.includes(c.n));
const UP = SEL.length === 5 ? "five-up" : SEL.length === 3 ? "three-up" : `${SEL.length}-up`;
const WITH_BACK = SEL.some((c) => c.back);

function frame(scale: number) {
  const w = 2 * Math.round(320 * scale) + 1, h = Math.round(1448 * scale);
  return { scale, width: w, height: h, x: (w - 1) / 2, y: h - Math.round(300 * scale), background: BG };
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
function crop(im: RgbaImage, x: number, y: number, w: number, h: number): MutableImage {
  const out = blank(w, h);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const sx = x + xx, sy = y + yy;
    if (sx < 0 || sy < 0 || sx >= im.width || sy >= im.height) continue;
    out.data.set(im.data.subarray((sy * im.width + sx) * 4, (sy * im.width + sx) * 4 + 4), (yy * w + xx) * 4);
  }
  return out;
}
function upscale(im: RgbaImage, k: number): MutableImage {
  const out = { width: im.width * k, height: im.height * k, data: new Uint8Array(im.width * k * im.height * k * 4) };
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const s = (Math.floor(y / k) * im.width + Math.floor(x / k)) * 4;
    out.data.set(im.data.subarray(s, s + 4), (y * out.width + x) * 4);
  }
  return out;
}
function sheet(rows: { title: string; tiles: [string, RgbaImage][] }[], gap = 8, font = 2): MutableImage {
  const lh = 11 * font, th = 11 * font;
  const w = Math.max(...rows.map((r) => r.tiles.reduce((s, [, i]) => s + i.width + gap, gap)));
  const h = rows.reduce((s, r) => s + th + lh + Math.max(...r.tiles.map(([, i]) => i.height)) + gap, gap);
  const out = blank(w, h);
  let y = gap;
  for (const r of rows) {
    drawText(out, r.title, gap, y + 2, font, [255, 214, 120]);
    y += th;
    let x = gap;
    for (const [label, im] of r.tiles) {
      drawText(out, label, x + 2, y + 2, font, [240, 240, 240]);
      over(out, im, x, y + lh);
      x += im.width + gap;
    }
    y += lh + Math.max(...r.tiles.map(([, i]) => i.height)) + gap;
  }
  return out;
}
/** GIF with a palette from the frame differences, unchanged-rectangle encoding and exact-duplicate frame dropping
 * (variable frame delays keep the timing). */
function writeGifSmall(frames: RgbaImage[], path: string, fps = 30) {
  const dir = mkdtempSync(join(tmpdir(), "five-anims-gif-"));
  try {
    frames.forEach((f, i) => writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.png`), encodePng(f)));
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", join(dir, "f%04d.png"),
      "-filter_complex", "mpdecimate=hi=1:lo=1:frac=0:max=0,split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
      "-fps_mode", "vfr", "-loop", "0", resolve(path)];
    const r = spawnSync(ffmpegPath(), args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const gif = (frames: RgbaImage[], fps = 30): RenderResult => ({
  frames: frames.map((f, i) => ({ time: i / fps, png: encodePng(f) })), width: frames[0]!.width, height: frames[0]!.height, fps,
  clip: "five-up", renderer: "composite", scale: 1, missingTextures: []
} as unknown as RenderResult);

// ---- measurements -----------------------------------------------------------------------------------------
const isBg = (d: ArrayLike<number>, i: number) => Math.abs(d[i]! - BG3[0]) + Math.abs(d[i + 1]! - BG3[1]) + Math.abs(d[i + 2]! - BG3[2]) <= 6;
function rowsOf(im: RgbaImage) {
  let top = -1, bottom = -1;
  for (let y = 0; y < im.height; y++) {
    let any = false;
    for (let x = 0; x < im.width; x++) if (!isBg(im.data, (y * im.width + x) * 4)) { any = true; break; }
    if (any) { if (top < 0) top = y; bottom = y; }
  }
  return { top, bottom };
}
function meanDiff(a: RgbaImage, b: RgbaImage) {
  let s = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) s += Math.abs(a.data[i + c]! - b.data[i + c]!);
  return s / (a.width * a.height * 3);
}
function maxDiffRegion(a: RgbaImage, b: RgbaImage, y0: number, y1: number) {
  let m = 0, s = 0, n = 0, px = 0, at: [number, number] = [-1, -1];
  for (let y = y0; y < y1; y++) for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4;
    let any = false;
    for (let c = 0; c < 3; c++) { const d = Math.abs(a.data[i + c]! - b.data[i + c]!); if (d > m) { m = d; at = [x, y]; } if (d) any = true; s += d; n++; }
    if (any) px++;
  }
  return { max: m, mean: s / n, pixelsDiffering: px, maxAt: at };
}
/** Alpha-weighted centroid of a transparent-background render. */
function centroid(im: RgbaImage) {
  let sx = 0, sy = 0, sw = 0;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    const a = im.data[(y * im.width + x) * 4 + 3]! / 255;
    sx += a * (x + 0.5); sy += a * (y + 0.5); sw += a;
  }
  return { x: sx / sw, y: sy / sw };
}
/** Enclosed background holes: 4-connected background components that do not touch the frame border, over minPx. */
function holes(im: RgbaImage, minPx = 3) {
  const w = im.width, h = im.height, seen = new Uint8Array(w * h), out: { px: number; x: number; y: number }[] = [];
  const bg = (i: number) => isBg(im.data, i * 4);
  for (let s0 = 0; s0 < w * h; s0++) {
    if (seen[s0] || !bg(s0)) continue;
    const stack = [s0];
    seen[s0] = 1;
    let n = 0, sx = 0, sy = 0, border = false;
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i - x) / w;
      n++; sx += x; sy += y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !seen[j] && bg(j)) { seen[j] = 1; stack.push(j); }
    }
    if (!border && n > minPx) out.push({ px: n, x: Math.round(sx / n), y: Math.round(sy / n) });
  }
  return out;
}
/** A copy of the rig keeping only the given slots (written next to the rig so the atlas resolves). */
function onlySlots(rig: string, keep: string[], suffix: string) {
  const doc = JSON.parse(readFileSync(RIG(rig), "utf8"));
  for (const s of doc.slots as { name: string; attachment?: string | null }[]) if (!keep.includes(s.name)) s.attachment = null;
  // refine P7: a dropped slot's attachment timeline (the eyes slot's blink keys) would switch it back on
  for (const a of Object.values(doc.animations ?? {}) as { slots?: Record<string, unknown> }[]) for (const n of Object.keys(a.slots ?? {})) if (!keep.includes(n)) delete a.slots![n];
  const dir = join(DIR, "rig", "tmp");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${rig}-${suffix}.anim.json`);
  writeFileSync(p, JSON.stringify(doc));
  const at = JSON.parse(readFileSync(join(DIR, "rig", `${rig}.atlas.json`), "utf8"));
  copyFileSync(join(DIR, "rig", at.pages[0].file), join(dir, at.pages[0].file));
  writeFileSync(p.replace(".anim.json", ".atlas.json"), JSON.stringify(at));
  return p;
}

// ---- crops for the joints sheets (1x skeleton px relative to the root; x mirrored for flipped clips; "far" is the
// far arm's side of the unflipped rig: screen-left on the front L15 rigs, screen-right on the back L15 rigs) -------
type Box = { name: string; x: number; y: number; w: number; h: number; far?: boolean; near?: boolean };
const BOXES: Box[] = [
  { name: "neck + nape", x: 0, y: -280, w: 260, h: 120 },
  { name: "shoulders + armholes", x: 0, y: -215, w: 380, h: 140 },
  { name: "far elbow wrist fist", x: 165, y: -105, w: 190, h: 240, far: true },
  { name: "waistband + hems", x: 0, y: 30, w: 320, h: 170 },
  { name: "knees ankles feet", x: 0, y: 175, w: 360, h: 260 },
  { name: "hair end L", x: -235, y: -420, w: 160, h: 200 },
  { name: "hair end R", x: 235, y: -420, w: 160, h: 200 },
  { name: "crown / fill seam", x: -30, y: -640, w: 380, h: 140 },
  { name: "eyes", x: 0, y: -535, w: 320, h: 120 }
];
// jacket crops (1x skeleton px, root-relative; far = the far arm's side as above, near = the other side)
const JACKET_BOXES: Box[] = [
  { name: "collar", x: 0, y: -292, w: 260, h: 110 },
  { name: "armpit far", x: 110, y: -165, w: 120, h: 130, far: true },
  { name: "armpit near", x: 110, y: -165, w: 120, h: 130, near: true },
  { name: "cuff far", x: 205, y: -78, w: 160, h: 130, far: true },
  { name: "cuff near", x: 205, y: -78, w: 160, h: 130, near: true },
  { name: "hem", x: 0, y: -10, w: 340, h: 90 }
];

async function main() {
  const G: Record<string, unknown> = {};
  const g2: Record<string, unknown> = {}, g7: Record<string, unknown> = {}, g6: Record<string, unknown> = {}, g8: Record<string, unknown> = {};
  for (const [scale, vt] of VIEWS) {
    const v = frame(scale);
    const clips: MutableImage[][] = [];
    for (const c of SEL) {
      const r = await renderFrames({ document: RIG(c.rig), clip: c.clip, fps: 30, frames: c.frames, ...v });
      const fr = r.frames.map((_, i) => (c.flip ? flip(img(r, i)) : img(r, i)));
      clips.push(fr);
      writeGifSmall(fr, join(DIR, `${tag(c)}-view${vt}-30fps.gif`));
      // G7: frame count, loop seam vs the median consecutive difference
      const diffs = fr.map((f, i) => meanDiff(f, fr[(i + 1) % fr.length]!));
      const seam = diffs[diffs.length - 1]!;
      const med = [...diffs.slice(0, -1)].sort((a, b) => a - b)[Math.floor((diffs.length - 1) / 2)]!;
      g7[`${tag(c)}@${vt}`] = { frames: fr.length, expected: c.frames, seamDiff: +seam.toFixed(4), medianDiff: +med.toFixed(4), ratio: +(seam / Math.max(med, 1e-9)).toFixed(3), pass: fr.length === c.frames && seam <= 1.5 * med };
      // G6: flip is an involution on every frame of the flipped clips
      if (c.flip) {
        let same = true;
        for (const f of fr) { const ff = flip(flip(f)); for (let i = 0; i < f.data.length; i++) if (ff.data[i] !== f.data[i]) { same = false; break; } }
        g6[`flipFlip ${tag(c)}@${vt}`] = same;
      }
    }
    // G2: same frame, same root, rest foot row +-1, hair top +-2 (setup pose renders)
    const rest: { clip: string; width: number; height: number; top: number; bottom: number }[] = [];
    for (const c of SEL) {
      const r = await renderFrames({ document: RIG(c.rig), fps: 30, frames: 1, ...v });
      const im = c.flip ? flip(img(r, 0)) : img(r, 0);
      rest.push({ clip: tag(c), width: im.width, height: im.height, ...rowsOf(im) });
    }
    const span = (k: "top" | "bottom") => Math.max(...rest.map((r) => r[k])) - Math.min(...rest.map((r) => r[k]));
    g2[vt] = { frame: { width: v.width, height: v.height, rootX: v.x, rootY: v.y }, rest, footRowSpan: span("bottom"), hairTopSpan: span("top"),
      pass: rest.every((r) => r.width === v.width && r.height === v.height) && span("bottom") <= 1 && span("top") <= 2 };
    // multi-up (LCM of the clip lengths) and, when that GIF is too big, walks-only
    const fiveUp = (n: number, which: number[]) => {
      const out: MutableImage[] = [];
      for (let i = 0; i < n; i++) out.push(sheet([{ title: `${WHO}  view ${scale}  30 fps`, tiles: which.map((k) => [SEL[k]!.label, clips[k]![i % clips[k]!.length]!] as [string, RgbaImage]) }], 6, 2));
      return out;
    };
    // the multi-up GIF is measured in a temp file: over GIF_LIMIT (it is: ~75 MB at 0.4) it is not kept; the
    // full five-up is kept as an MP4 (seamless) and the GIF as walks-only
    const idx = SEL.map((_, k) => k);
    const walks = idx.filter((k) => SEL[k]!.frames !== 96);
    const all = fiveUp(lcm(SEL.map((c) => c.frames)), idx); // seamless: the LCM of the clip lengths (96, 28 -> 672)
    const tmpGif = join(mkdtempSync(join(tmpdir(), "five-up-")), "five-up.gif");
    writeGifSmall(all, tmpGif);
    const bytes = statSync(tmpGif).size;
    G[`${UP}GifBytes${vt}`] = bytes;
    if (bytes > GIF_LIMIT) writeGifSmall(fiveUp(lcm(walks.map((k) => SEL[k]!.frames)), walks), join(DIR, `${UP}-walks-view${vt}-30fps.gif`));
    else copyFileSync(tmpGif, join(DIR, `${UP}-view${vt}-30fps.gif`));
    rmSync(tmpGif, { force: true });
    writeMp4(gif(all), join(DIR, `${UP}-view${vt}-30fps.mp4`));
    // sheets: keep this scale's tiles for the per-clip sheet (a row per scale)
    (G as Record<string, unknown>)[`tiles${vt}`] = SEL.map((c, k) => c.sheetFrames.map((i) => [`f${i}`, clips[k]![i]!] as [string, RgbaImage]));
    // joints at 0.471
    if (vt === "0471") {
      mkdirSync(join(DIR, "joints"), { recursive: true });
      SEL.forEach((c, k) => {
        // jacketb: the walk's arm swing extremes (hand x extremes at 0.471) are f8 / f22, the contacts f0 / f14
        const picks = c.frames === 96 ? [0, 48] : c.frames === 28 ? (SET === "jacketb" ? [0, 8, 14, 22] : [0, 7, 14, 21]) : [8, 23];
        const rows1: { title: string; tiles: [string, RgbaImage][] }[] = [], rows4: typeof rows1 = [];
        for (const i of picks) {
          const t1: [string, RgbaImage][] = [], t4: [string, RgbaImage][] = [];
          for (const b of SET === "jacketb" ? [...JACKET_BOXES, ...BOXES] : BOXES) {
            if (b.name === "eyes" && c.back) continue;
            const farSign = (b.far || b.near) ? (c.back ? 1 : -1) * (c.flip ? -1 : 1) * (b.near ? -1 : 1) : 1;
            const bx = (b.far || b.near) ? farSign * b.x : (c.flip ? -b.x : b.x);
            const w = Math.round(b.w * scale), h = Math.round(b.h * scale);
            const cx = Math.round(v.x + bx * scale - w / 2), cy = Math.round(v.y + b.y * scale - h / 2);
            const cr = crop(clips[k]![i]!, cx, cy, w, h);
            t1.push([b.name, cr]);
            t4.push([b.name, upscale(cr, 4)]);
          }
          rows1.push({ title: `${c.label}  f${i}  view ${scale} 1:1`, tiles: t1 });
          rows4.push({ title: `${c.label}  f${i}  view ${scale} x4 nearest`, tiles: t4 });
        }
        writePng(join(DIR, "joints", `${tag(c)}-view0471.png`), sheet(rows1, 8, 1));
        writePng(join(DIR, "joints", `${tag(c)}-4x-diagnostic.png`), sheet(rows4, 8, 2));
      });
      // G3: idle (front 0) head vs round 2 FRONT 0 (same face/hair; the body differs only in the shorts colour)
      const a = img(await renderFrames({ document: RIG("front-turn00-faceA"), fps: 30, frames: 1, ...v }), 0);
      const b = img(await renderFrames({ document: ROUND2, fps: 30, frames: 1, ...v }), 0);
      // refine P1: rows above the shoulders (the shoulder strap ink is body brown now, owner D2; first differing row 405 at 0.471)
      const neckRow = Math.round(v.y - 300 * scale);
      G.g3IdleVsRound2 = { headRows: [0, neckRow], ...maxDiffRegion(a, b, 0, neckRow) };
      // G8: hair (and face) rigid on the head bone: per frame, |hair centroid - head centroid| constant (the rigid-fit
      // residual; rotation-invariant) within 0.5 px
      // G9 holes and the motion table (head top row, lowest foot row, hand centroids per frame; flipped clips measured
      // in their final orientation). Head zone = rows above the neck (v.y - 240 s): REFINE-PLAN item 6 (P4).
      const neck = Math.round(v.y - 240 * scale);
      const g9: Record<string, unknown> = {}, motion: Record<string, unknown> = {};
      for (const [k, c] of SEL.entries()) {
        const fr = clips[k]!;
        const hs = fr.map((f) => holes(f));
        const head = hs.map((l) => l.filter((q) => q.y < neck)), body = hs.map((l) => l.filter((q) => q.y >= neck));
        const mx = (l: { px: number }[][]) => Math.max(0, ...l.flat().map((q) => q.px));
        g9[tag(c)] = { framesWithHeadHoles: head.filter((l) => l.length).length, maxHeadHolePx: mx(head), framesWithBodyHoles: body.filter((l) => l.length).length,
          maxBodyHolePx: mx(body), bodyHoles: body.flatMap((l, i) => l.map((q) => ({ f: i, ...q }))).slice(0, 40), headHoleSample: head.flatMap((l, i) => l.map((q) => ({ f: i, ...q }))).slice(0, 6),
          pass: body.every((l) => l.length === 0) };
        const vT = { ...v, background: null };
        const hand = async (slot: string) => {
          const r = await renderFrames({ document: onlySlots(c.rig, [slot], slot), clip: c.clip, fps: 30, frames: c.frames, ...vT });
          return r.frames.map((_, i) => { const p = centroid(c.flip ? flip(img(r, i)) : img(r, i)); return [+p.x.toFixed(1), +p.y.toFixed(1)]; });
        };
        const hl = await hand("hand"), hr = await hand("hand_r");
        motion[tag(c)] = { headTop: fr.map((f) => rowsOf(f).top), lowestRow: fr.map((f) => rowsOf(f).bottom), handSlot: hl, handSlotR: hr };
      }
      G.g9 = g9;
      G.motion0471 = motion;
      G.flippedClips = SEL.filter((c) => c.flip).length;
      for (const c of SEL) {
        // refine P7: the face parts are separate slots; G8 tracks hair + brows + nose + mouth (the eyes slot is the one
        // the blink swaps, so it is left out of the centroid and every frame counts)
        // (a part the rig has no slot for, e.g. no nose by default, is skipped)
        const present = new Set((JSON.parse(readFileSync(RIG(c.rig), "utf8")).slots as { name: string }[]).map((s) => s.name));
        const hairSlots = (c.back ? ["hair"] : ["hair", "brows", "nose", "mouth"]).filter((n) => present.has(n));
        const vT = { ...v, background: null };
        const rh = await renderFrames({ document: onlySlots(c.rig, ["head"], "head"), clip: c.clip, fps: 30, frames: c.frames, ...vT });
        const rr = await renderFrames({ document: onlySlots(c.rig, hairSlots, "hair"), clip: c.clip, fps: 30, frames: c.frames, ...vT });
        const len: number[] = [], ang: number[] = [];
        for (let i = 0; i < c.frames; i++) {
          const p = centroid(img(rh, i)), q = centroid(img(rr, i));
          len.push(Math.hypot(q.x - p.x, q.y - p.y));
          ang.push((Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI);
        }
        const keep = len.map((_, i) => i);
        const dev = Math.max(...keep.map((i) => Math.abs(len[i]! - len[0]!)));
        const angK = keep.map((i) => ang[i]!);
        g8[tag(c)] = { offsetLenPx: +len[0]!.toFixed(2), maxLenDeviationPx: +dev.toFixed(3), angleRangeDeg: +(Math.max(...angK) - Math.min(...angK)).toFixed(2),
          framesMeasured: keep.length, pass: dev <= 0.5 };
      }
      rmSync(join(DIR, "rig", "tmp"), { recursive: true, force: true });
      if (WITH_BACK) {
      // back hair: round 1's generated fill vs the drawn hair (both on the drawn body), at 0 and 15, heads at 1:1 and x2
      const head = async (doc: string) => {
        const im = img(await renderFrames({ document: doc, fps: 30, frames: 1, ...v }), 0);
        const w = Math.round(700 * scale), h = Math.round(640 * scale);
        return crop(im, Math.round(v.x - w / 2), Math.round(v.y - 900 * scale), w, h);
      };
      const heads: [string, string][] = [
        ["GENERATED 0", join(DIR, "rig", "before", "back-turn00-hair-fill.anim.json")],
        ["GENERATED L15", join(DIR, "rig", "before", "back-turn15-hair-fill.anim.json")],
        ["DRAWN 0", RIG("back-turn00-hair")],
        ["DRAWN L15", RIG("back-turn15-hair")],
        ["DRAWN R15 (flip)", RIG("back-turn15-hair-mirin")]
      ];
      const ht: [string, RgbaImage][] = [];
      for (const [label, doc] of heads) { const h = await head(doc); ht.push([label, label.includes("flip") ? flip(h) : h]); }
      writePng(join(DIR, "backhair-heads-view0471.png"), sheet([
        { title: `back hair  view ${scale}  1:1`, tiles: ht },
        { title: "x2 nearest", tiles: ht.slice(0, 4).map(([l, i]) => [l, upscale(i, 2)] as [string, RgbaImage]) }
      ]));
      // back body: round 1 (generated back art, old body + fill hair) vs round 2 (drawn body + drawn hair), toe feet
      const bodyTile = async (doc: string) => {
        const im = img(await renderFrames({ document: doc, fps: 30, frames: 1, ...v }), 0);
        const w = Math.round(700 * scale), h = Math.round(1180 * scale);
        return crop(im, Math.round(v.x - w / 2), Math.round(v.y - 890 * scale), w, h);
      };
      const torso = (im: RgbaImage) => upscale(crop(im, Math.round(im.width / 2 - 200 * scale), Math.round(560 * scale), Math.round(400 * scale), Math.round(560 * scale)), 2);
      const bodies: [string, string][] = [
        ["BEFORE 0 (generated)", join(DIR, "rig", "before", "back-old-turn00-hair.anim.json")], ["AFTER 0 (drawn)", RIG("back-turn00-hair")],
        ["BEFORE L15 (generated)", join(DIR, "rig", "before", "back-old-turn15-hair.anim.json")], ["AFTER L15 (drawn)", RIG("back-turn15-hair")]
      ];
      const bt: [string, RgbaImage][] = [];
      for (const [label, doc] of bodies) bt.push([label, await bodyTile(doc)]);
      writePng(join(DIR, "back-body-before-after-view0471.png"), sheet([
        { title: `back body  view ${scale}  1:1  (before = round 1 generated back art; after = drawn)`, tiles: bt },
        { title: "torso x2 nearest", tiles: bt.map(([l, i]) => [l, torso(i)] as [string, RgbaImage]) }
      ]));
      // back feet: heel (-, round 1 default) / flat (0) / toe (+, the clips since round 2)
      const feet: [string, string][] = [["- HEEL (round 1)", "feet/back-heel-turn15-hair"], ["0 FLAT", "feet/back-flat-turn15-hair"], ["+ TOE (clips)", "back-turn15-hair"]];
      const ft: [string, RgbaImage][] = [], fz: [string, RgbaImage][] = [];
      for (const [label, rig] of feet) {
        const im = img(await renderFrames({ document: RIG(rig), fps: 30, frames: 1, ...v }), 0);
        ft.push([label, im]);
        const w = Math.round(380 * scale), h = Math.round(150 * scale);
        fz.push([label, upscale(crop(im, Math.round(v.x - w / 2), Math.round(v.y + 250 * scale - h / 2), w, h), 3)]);
      }
      writePng(join(DIR, "feet-back-heel-vs-toe-view0471.png"), sheet([
        { title: `back L15 feet shear  view ${scale}  (facing screen-left; toe = below the ankle swings screen-left, used by the clips)`, tiles: ft },
        { title: "feet x3 nearest", tiles: fz }
      ]));
      }
    }
  }
  // per-clip sheets: a row per scale
  SEL.forEach((c, k) => {
    const rows = VIEWS.map(([s, vt]) => ({ title: `${c.label}  ${c.clip}  view ${s}`, tiles: (G[`tiles${vt}`] as [string, RgbaImage][][])[k]! }));
    writePng(join(DIR, `sheet-${tag(c)}.png`), sheet(rows));
  });
  for (const [, vt] of VIEWS) delete G[`tiles${vt}`];
  writeFileSync(join(DIR, "gates-render.json"), JSON.stringify({ g2, g6, g7, g8, ...G }, null, 1));
  console.log("wrote five-anims evidence");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
