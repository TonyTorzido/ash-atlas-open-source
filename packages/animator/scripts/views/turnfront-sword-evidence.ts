// Turned-front sword chop evidence. Run from packages/animator after scripts/views/turnfront-sword-clips.ts and the
// held import into views/turned-front/sword (README there):
//   npx tsx scripts/views/turnfront-sword-evidence.ts
// Writes into docs/plans/atlas-animator-demos/views/turned-front/sword/:
// - turn15-ready-chop-ready-view{040,0471}-30fps.gif (+ -mirrored for 040): ONE queued render ready (1 s) -> chop ->
//   ready (1 s), cropped to the frames' shared box; 0.4 = phone-size review view, 0.4712 = max in-game zoom;
// - turn15-chop-every-frame-view040.png: every frame of the chop, labelled (hit frame marked).
import { join } from "node:path";
import { renderFrames, writeGif, type RenderResult } from "../../src/cli/render.js";
import { decodePng, encodePng, writePng } from "../../src/tools/png.js";
import { grid } from "../../src/tools/review.js";
import type { RgbaImage } from "../../src/tools/image.js";

const DIR = "../../docs/plans/atlas-animator-demos/views/turned-front/sword";
const RIG = join(DIR, "rig/jacketb-turn15-sword.anim.json");
const BG = 0x1e2430;
const CHOP_FRAMES = 24;
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
const cropped = (r: RenderResult, imgs: RgbaImage[], b: [number, number, number, number], flip: boolean): RenderResult =>
  ({ ...r, width: b[2] - b[0], height: b[3] - b[1], frames: r.frames.map((f, i) => ({ ...f, png: encodePng(crop(imgs[i]!, b, flip)) })) });

async function main() {
  for (const [scale, tag] of [[0.4, "040"], [0.4712, "0471"]] as const) {
    const w = Math.round(1500 * scale), h = Math.round(1400 * scale);
    const v = { scale, width: w, height: h, x: Math.round(w * 0.55), y: Math.round(h - 330 * scale), background: BG };
    const seq = await renderFrames({ document: RIG, clip: "turn_sword_ready", queue: ["turn_sword_chop", "turn_sword_ready"], fps: 30, frames: 30 + CHOP_FRAMES + 30, ...v });
    const imgs = seq.frames.map((f) => decodePng(f.png as Buffer));
    const b = box(imgs, 6);
    writeGif(cropped(seq, imgs, b, false), join(DIR, `turn15-ready-chop-ready-view${tag}-30fps.gif`));
    if (tag === "040") {
      writeGif(cropped(seq, imgs, b, true), join(DIR, `turn15-ready-chop-ready-view${tag}-30fps-mirrored.gif`));
      const r = await renderFrames({ document: RIG, clip: "turn_sword_chop", fps: 30, frames: CHOP_FRAMES + 1, ...v });
      const ims = r.frames.map((f) => decodePng(f.png as Buffer));
      const bb = box(ims, 4);
      const LBL: Record<number, string> = { 0: " ready", 3: " antic", 5: " strike", 6: " HIT", 8: " hold end", 12: " follow", 16: " recover" };
      writePng(join(DIR, "turn15-chop-every-frame-view040.png"), grid(ims.map((im, i) => ({ image: crop(im, bb), label: `TURN15 f${i}${LBL[i] ?? ""}` })), 9, undefined, true));
    }
  }
  console.log("wrote turned-front sword evidence");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
