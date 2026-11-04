// PROTOTYPE (side sword go/no-go): evidence for the side-view sword chop on the dressed turned-side rig. Run from
// packages/animator after scripts/views/side-sword-clips.ts and the held import into views/side-sword:
//   npx tsx scripts/views/side-sword-evidence.ts
// Writes into docs/plans/atlas-animator-demos/views/side-sword/:
// - side-idle-<clip>-idle-view{02356,040}-30fps.gif: ONE queued render side_sword_ready (2 s) -> clip -> ready (1 s),
//   cropped to the frames' shared box, at the live display scale 0.2356 and at 0.4; `-mirrored` = the same frames
//   flipped (facing screen-right);
// - live-vs-side-keys-sheet-view02356.png: the live front swing (live-reference/keys) over ours at the same key times;
// - <clip>-30fps-sheet-view040.png: every frame of the clip at 0.4.
import { join } from "node:path";
import { renderFrames, writeGif, type RenderResult } from "../../src/cli/render.js";
import { decodePng, encodePng, readPng, writePng } from "../../src/tools/png.js";
import { grid } from "../../src/tools/review.js";
import type { RgbaImage } from "../../src/tools/image.js";

const DIR = "../../docs/plans/atlas-animator-demos/views/side-sword";
const RIG = join(DIR, "rig/body-side-legs-sword.anim.json");
const LIVE = "../../docs/plans/atlas-animator-demos/attacks/sword/live-reference/keys";
const BG = 0x1e2430;
const S = 0.2356;
const CLIPS = ["side_sword_slash", "side_sword_slash_notrail"];
const isBg = (d: Uint8Array, o: number) => d[o] === 0x1e && d[o + 1] === 0x24 && d[o + 2] === 0x30;

function box(imgs: RgbaImage[], pad: number): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const im of imgs) for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    if (isBg(im.data, (y * im.width + x) * 4)) continue;
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const w = imgs[0]!.width, h = imgs[0]!.height;
  return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(w, x1 + pad + 1), Math.min(h, y1 + pad + 1)];
}
function crop(im: RgbaImage, [x0, y0, x1, y1]: [number, number, number, number], flip = false): RgbaImage {
  const w = x1 - x0, h = y1 - y0;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = flip ? x1 - 1 - x : x0 + x;
    data.set(im.data.subarray(((y0 + y) * im.width + sx) * 4, ((y0 + y) * im.width + sx) * 4 + 4), (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}
function cropped(r: RenderResult, imgs: RgbaImage[], b: [number, number, number, number], flip: boolean): RenderResult {
  return { ...r, width: b[2] - b[0], height: b[3] - b[1], frames: r.frames.map((f, i) => ({ ...f, png: encodePng(crop(imgs[i]!, b, flip)) })) };
}

async function main() {
  // the live frame: 320 x 320, feet at 0.97 H, x 0.56 W (scripts/sword-chop-compare.ts); ours facing left like live
  const view = { scale: S, width: 320, height: 320, x: Math.round(320 * 0.56), y: Math.round(320 * 0.97 - (1243 - 960) * S), background: BG };
  for (const clip of CLIPS) {
    for (const [scale, tag] of [[S, "02356"], [0.4, "040"]] as const) {
      const k = scale / S;
      const seq = await renderFrames({ document: RIG, clip: "side_sword_ready", queue: [clip, "side_sword_ready"], fps: 30, frames: 60 + 21 + 30, scale, width: Math.round(420 * k), height: Math.round(360 * k), x: Math.round(250 * k), y: Math.round(360 * k * 0.95 - 283 * scale), background: BG });
      const imgs = seq.frames.map((f) => decodePng(f.png as Buffer));
      const b = box(imgs, Math.round(6 * k));
      const stem = `side-idle-${clip.replace(/^side_sword_/, "").replace(/_/g, "-")}-idle-view${tag}-30fps`;
      writeGif(cropped(seq, imgs, b, false), join(DIR, `${stem}.gif`));
      writeGif(cropped(seq, imgs, b, true), join(DIR, `${stem}-mirrored.gif`));
    }
    const r = await renderFrames({ document: RIG, clip, fps: 30, scale: 0.4, width: 720, height: 620, x: 430, y: 476, background: BG });
    const imgs = r.frames.map((f) => decodePng(f.png as Buffer));
    const b = box(imgs, 4);
    writePng(join(DIR, `${clip}-30fps-sheet-view040.png`), grid(imgs.map((im, i) => ({ image: crop(im, b), label: `f${i}${i === 3 ? " hit" : ""}` })), 8, undefined, true));
  }
  // key times: [live key index, our frame (-1 = ready), label]
  const PAIRS: [number, number, string][] = [
    [0, -1, "rest / idle"],
    [2, 1, "windup (live 49 ms, ours f1 33 ms)"],
    [3, 2, "strike (live 77 ms, ours f2 67 ms)"],
    [4, 3, "contact (live 105 ms, ours f3 100 ms hit)"],
    [5, 6, "follow (live 210 ms, ours f6 200 ms)"],
    [6, 8, "return (live 280 ms, ours f8 267 ms)"],
    [7, 11, "end (live 350 ms, ours f11 367 ms)"]
  ];
  const ready = await renderFrames({ document: RIG, clip: "side_sword_ready", fps: 30, frames: 1, ...view });
  const rows = [PAIRS.map(([k, , label]) => ({ image: readPng(join(LIVE, `live-sword-left-key${k}.png`)), label: `LIVE front ${label}` }))];
  for (const clip of CLIPS) {
    const r = await renderFrames({ document: RIG, clip, fps: 30, ...view });
    rows.push(PAIRS.map(([, f, label]) => ({ image: decodePng(((f < 0 ? ready : r).frames[Math.max(0, f)] as { png: Buffer }).png), label: `SIDE${clip.endsWith("notrail") ? " no trail" : " trail"} ${label}` })));
  }
  writePng(join(DIR, "live-vs-side-keys-sheet-view02356.png"), grid(rows.flat(), PAIRS.length, 3, true));
  console.log("wrote the side sword GIFs, frame sheets and the live-vs-side key sheet");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
