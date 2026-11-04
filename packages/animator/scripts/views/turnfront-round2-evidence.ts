// Turned-front round 2 evidence (docs/plans/atlas-animator-demos/views/turned-front/round2/README.md). Run from
// packages/animator after scripts/views/turnfront-round2-rigs.sh:
//   npx tsx scripts/views/turnfront-round2-evidence.ts
// Writes into views/turned-front/round2/ (view040 = the 0.4 phone-size review view, view0471 = max in-game zoom):
// - angles-rest-walk-view{040,0471}.png: FRONT 0 | TURN 15 | TURN 20 with face + hair (combo A, hair shifted), rest
//   plus walk f8 / f23; angles-walk-view{040,0471}-30fps.gif (+ -mirrored: facing screen-right);
// - combos-view{040,0471}.png: four face + hair combos at 0 / 15 / 20 (rest), head crops at max zoom;
// - hair-shift-vs-flip-view0471.png: per hair (A soldier crop, B layered bob, C spikey, D page cut): FRONT, 15 shifted,
//   15 shifted + flipped, 20 shifted, 20 shifted + flipped (head crops);
// - feet-round1-vs-round2-view0471.png: the feet at 15 / 20, round 1 (at the camera) vs round 2 (toed toward the turn).
// Round 2b (owner pick: 15 deg, the face projected on the head at the body angle), `npx tsx ... 2b`, into round2/2b/:
// - combos-front-old15-new15-view0471.png: per combo FRONT | OLD 15 (round 2 slide, 1.6x) | NEW 15 (projected), heads;
// - walk15-view{040,0471}-30fps.gif (+ -mirrored): FRONT 0 | NEW 15 walking, combo A, hair shifted.
// Round 2c (`... 2c`, into round2/2c/): combos-front-2b15-new15-view0471.png and the same walk GIFs on the 2c rig.
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { renderFrames, writeGif, type RenderResult } from "../../src/cli/render.js";
import { decodePng, encodePng, writePng } from "../../src/tools/png.js";
import { drawText, fillRect } from "../../src/tools/review.js";
import type { MutableImage, RgbaImage } from "../../src/tools/image.js";

const DIR = "../../docs/plans/atlas-animator-demos/views/turned-front/round2";
const RIG = (n: string) => join(DIR, "rig", `${n}.anim.json`);
const R1 = (n: string) => join(DIR, "..", "rig", `${n}.anim.json`);
const BG = 0x1e2430;
const VIEWS: [number, string][] = [[0.4, "040"], [0.4712, "0471"]];
const ANGLES: [string, string][] = [["00", "FRONT 0"], ["15", "TURN 15"], ["20", "TURN 20"]];
const WALK_FRAMES = [8, 23];
const COMBOS: [string, string][] = [["A", "A almond/soldier crop"], ["B", "B round/layered bob"], ["C", "C determined/spikey"], ["D", "D dot/page cut"]];

function frame(scale: number) {
  // head top (hair) ~ canvas y 90 to the feet ~ 1250
  const w = Math.round(640 * scale), h = Math.round(1180 * scale);
  return { scale, width: w, height: h, x: Math.round(w / 2), y: Math.round(h - 300 * scale), background: BG };
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
function crop(im: RgbaImage, x0: number, y0: number, w: number, h: number): MutableImage {
  const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(im.width - 1, Math.max(0, x0 + x)), sy = Math.min(im.height - 1, Math.max(0, y0 + y));
    out.data.set(im.data.subarray((sy * im.width + sx) * 4, (sy * im.width + sx) * 4 + 4), (y * w + x) * 4);
  }
  return out;
}
/** Rows of labelled tiles (each row: [label, image][]), one row label on the left. */
function sheet(rows: { title: string; tiles: [string, RgbaImage][] }[], gap = 8): MutableImage {
  const lh = 22, th = 22;
  const w = Math.max(...rows.map((r) => r.tiles.reduce((s, [, i]) => s + i.width + gap, gap)));
  const h = rows.reduce((s, r) => s + th + lh + Math.max(...r.tiles.map(([, i]) => i.height)) + gap, gap);
  const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  fillRect(out, 0, 0, w, h, [0x1e, 0x24, 0x30]);
  let y = gap;
  for (const r of rows) {
    drawText(out, r.title, gap, y + 2, 2, [255, 214, 120]);
    y += th;
    let x = gap;
    for (const [label, im] of r.tiles) {
      drawText(out, label, x + 2, y + 2, 2, [240, 240, 240]);
      for (let yy = 0; yy < im.height; yy++) out.data.set(im.data.subarray(yy * im.width * 4, (yy + 1) * im.width * 4), ((y + lh + yy) * w + x) * 4);
      x += im.width + gap;
    }
    y += lh + Math.max(...r.tiles.map(([, i]) => i.height)) + gap;
  }
  return out;
}
function hcat(ims: RgbaImage[], labels: string[], gap = 6): MutableImage {
  return sheet([{ title: "", tiles: ims.map((im, i) => [labels[i]!, im] as [string, RgbaImage]) }], gap);
}
function sideBySide(rs: RenderResult[], labels: string[], flipAll = false): RenderResult {
  const frames = rs[0]!.frames.map((f, i) => ({ ...f, png: encodePng(hcat(rs.map((r) => (flipAll ? flip(img(r, i)) : img(r, i))), labels)) }));
  const first = decodePng(frames[0]!.png as Buffer);
  return { ...rs[0]!, width: first.width, height: first.height, frames };
}
async function rest(doc: string, v: ReturnType<typeof frame>) {
  return img(await renderFrames({ document: doc, fps: 30, frames: 1, ...v }), 0);
}
/** The head (hair top to chin) of a rest render: canvas x 542 +- 290, y 80 .. 700. */
const headCrop = (im: RgbaImage, v: ReturnType<typeof frame>) =>
  crop(im, Math.round(v.x - 290 * v.scale), Math.round(v.y - (960 - 80) * v.scale), Math.round(580 * v.scale), Math.round(620 * v.scale));
const feetCrop = (im: RgbaImage, v: ReturnType<typeof frame>) =>
  crop(im, Math.round(v.x - 230 * v.scale), Math.round(v.y + 120 * v.scale), Math.round(460 * v.scale), Math.round(200 * v.scale));

async function main() {
  for (const [scale, tag] of VIEWS) {
    const v = frame(scale);
    // 1. angles with face + hair, rest + walk
    const walks: RenderResult[] = [];
    const tiles: [string, RgbaImage][] = [];
    for (const [a, label] of ANGLES) {
      const doc = RIG(`body-turn${a}-face-shift`);
      const walk = await renderFrames({ document: doc, clip: "walk_in_place", fps: 30, ...v });
      walks.push(walk);
      tiles.push([`${label} rest`, await rest(doc, v)]);
      for (const f of WALK_FRAMES) tiles.push([`${label} walk f${f}`, img(walk, f)]);
    }
    writePng(join(DIR, `angles-rest-walk-view${tag}.png`), sheet([{ title: `combo A, hair shifted, view ${scale} (facing screen-left)`, tiles }]));
    writeGif(sideBySide(walks, ANGLES.map(([, l]) => l)), join(DIR, `angles-walk-view${tag}-30fps.gif`));
    writeGif(sideBySide(walks, ANGLES.map(([, l]) => `${l} MIRRORED`), true), join(DIR, `angles-walk-view${tag}-30fps-mirrored.gif`));

    // 2. combos
    const rows = [];
    for (const [c, title] of COMBOS) {
      const t: [string, RgbaImage][] = [];
      for (const [a, label] of ANGLES) {
        const im = await rest(join(DIR, "rig/combos", `combo${c}-turn${a}-shift.anim.json`), v);
        t.push([label, tag === "0471" ? headCrop(im, v) : im]);
      }
      rows.push({ title: `combo ${title} (hair shifted)`, tiles: t });
    }
    if (tag === "040") {
      // phone size: all four combos in one row per angle set, whole body
      writePng(join(DIR, `combos-view${tag}.png`), sheet(rows));
    } else {
      writePng(join(DIR, `combos-view${tag}.png`), sheet(rows));
      // 3. hair shifted vs shifted + flipped (head crops at max zoom)
      const hrows = [];
      for (const [c, title] of COMBOS) {
        const t: [string, RgbaImage][] = [["FRONT", headCrop(await rest(join(DIR, "rig/combos", `combo${c}-turn00-shift.anim.json`), v), v)]];
        for (const a of ["15", "20"]) for (const m of ["shift", "flip"]) {
          t.push([`${a} ${m === "shift" ? "SHIFTED" : "SHIFT+FLIP"}`, headCrop(await rest(join(DIR, "rig/combos", `combo${c}-turn${a}-${m}.anim.json`), v), v)]);
        }
        hrows.push({ title: `hair ${title.split("/")[1]}`, tiles: t });
      }
      writePng(join(DIR, `hair-shift-vs-flip-view${tag}.png`), sheet(hrows));
      // 4. feet: round 1 vs round 2
      const ft: [string, RgbaImage][] = [["FRONT", feetCrop(await rest(RIG("body-turn00"), v), v)]];
      for (const a of ["15", "20"]) {
        ft.push([`${a} ROUND 1`, feetCrop(await rest(R1(`body-turn${a}`), v), v)]);
        ft.push([`${a} ROUND 2`, feetCrop(await rest(RIG(`body-turn${a}`), v), v)]);
      }
      const walk15 = await renderFrames({ document: RIG("body-turn15"), clip: "walk_in_place", fps: 30, ...v });
      for (const f of WALK_FRAMES) ft.push([`15 R2 walk f${f}`, feetCrop(img(walk15, f), v)]);
      writePng(join(DIR, `feet-round1-vs-round2-view${tag}.png`), sheet([{ title: "feet (facing screen-left)", tiles: ft }]));
    }
  }
  console.log("wrote turned-front round 2 evidence");
}
/** Round 2b ("2b": FRONT | OLD 15 slid | NEW 15 projected) and 2c ("2c": FRONT | 2B 15 | NEW 15 clamped). */
async function main2b(round: "2b" | "2c") {
  const OUT = join(DIR, round);
  mkdirSync(OUT, { recursive: true });
  const C = (n: string) => join(DIR, "rig/combos", `${n}.anim.json`);
  for (const [scale, tag] of VIEWS) {
    const v = frame(scale);
    if (tag === "0471") {
      const rows = [];
      for (const [c, title] of COMBOS) {
        const [mid, midLabel, last, lastLabel] = round === "2b"
          ? [`combo${c}-turn15-shift`, "OLD 15 (slid)", `combo${c}-turn15-proj-shift`, "NEW 15 (projected)"]
          : [`combo${c}-turn15-proj-shift`, "2B 15 (projected)", `combo${c}-turn15-p2c-shift`, "NEW 15 (no widening)"];
        rows.push({ title: `combo ${title} (hair shifted)`, tiles: [
          ["FRONT", headCrop(await rest(C(`combo${c}-turn00-shift`), v), v)],
          [midLabel, headCrop(await rest(C(mid), v), v)],
          [lastLabel, headCrop(await rest(C(last), v), v)]
        ] as [string, RgbaImage][] });
      }
      writePng(join(OUT, round === "2b" ? `combos-front-old15-new15-view${tag}.png` : `combos-front-2b15-new15-view${tag}.png`), sheet(rows));
    }
    const walks = [];
    for (const n of ["body-turn00-face-shift", round === "2b" ? "body-turn15-faceproj-shift" : "body-turn15-face2c-shift"]) walks.push(await renderFrames({ document: RIG(n), clip: "walk_in_place", fps: 30, ...v }));
    writeGif(sideBySide(walks, ["FRONT 0", "TURN 15"]), join(OUT, `walk15-view${tag}-30fps.gif`));
    writeGif(sideBySide(walks, ["FRONT 0 MIRRORED", "TURN 15 MIRRORED"], true), join(OUT, `walk15-view${tag}-30fps-mirrored.gif`));
  }
  console.log(`wrote turned-front round ${round} evidence`);
}
(process.argv[2] === "2b" || process.argv[2] === "2c" ? main2b(process.argv[2]) : main()).catch((e) => {
  console.error(e);
  process.exit(1);
});
