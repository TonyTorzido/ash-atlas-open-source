// Atlas Animator multi-view swag: renders existing clips on a view rig as 30 fps GIFs with the real renderer.
// Run from packages/animator:
//   npx tsx scripts/views/view-clips.ts <out-dir> <scale> <prefix> <rig.anim.json> <clip> [<clip> ...]
// writes <out-dir>/<prefix>-<clip>-<scale>x-30fps.gif (background b4b9c2, the sheets' grey).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderFrames, writeGif } from "../../src/cli/render.js";

const [outDir, scale, prefix, rig, ...clips] = process.argv.slice(2) as string[];
mkdirSync(outDir!, { recursive: true });
for (const clip of clips) {
  const r = await renderFrames({ document: rig!, clip, fps: 30, scale: Number(scale), background: 0xb4b9c2 });
  const out = join(outDir!, `${prefix}-${clip}-${scale}x-30fps.gif`);
  writeGif(r, out);
  console.log("wrote", out, r.frames.length, "frames");
}
