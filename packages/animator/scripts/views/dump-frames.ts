/*
 * Refine P6 (G10): every frame of one clip at one view scale, framed as five-anims-evidence.ts frames them, as PNGs.
 *   npx tsx scripts/views/dump-frames.ts <rig.anim.json> <clip> <frames> <out dir> [scale = 0.4712]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderFrames } from "../../src/cli/render.js";

async function main() {
  const [rig, clip, n, out, sc] = process.argv.slice(2) as [string, string, string, string, string?];
  const scale = Number(sc ?? 0.4712);
  const width = 2 * Math.round(320 * scale) + 1, height = Math.round(1448 * scale);
  mkdirSync(out, { recursive: true });
  const r = await renderFrames({ document: rig, clip, fps: 30, frames: Number(n), scale, width, height, x: (width - 1) / 2, y: height - Math.round(300 * scale), background: 0x1e2430 });
  r.frames.forEach((f, i) => writeFileSync(join(out, `f${String(i).padStart(3, "0")}.png`), f.png as Buffer));
}
void main();
