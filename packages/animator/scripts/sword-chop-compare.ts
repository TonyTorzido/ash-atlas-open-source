// PROTOTYPE (sword chop round): live swing (top) vs our overhead chop on the full character (trail, then no trail) at
// the same key times and the LIVE display scale (0.2356 display px per canvas px = live frame px per template px),
// plus the idle -> chop -> idle GIFs rendered as one queued sequence. Run from packages/animator after the held import
// into docs/plans/atlas-animator-demos/attacks/sword-chop:
//   npx tsx scripts/sword-chop-compare.ts
import { join } from "node:path";
import { renderFrames, writeGif } from "../src/cli/render.js";
import { decodePng, readPng, writePng } from "../src/tools/png.js";
import { grid } from "../src/tools/review.js";

const DIR = "../../docs/plans/atlas-animator-demos/attacks/sword-chop";
const RIG = join(DIR, "rig/template7-armlayer-legs-face-sword.anim.json");
const LIVE = "../../docs/plans/atlas-animator-demos/attacks/sword/live-reference/keys";
const BG = 0x1e2430;
const S = 0.2356;
// live frame 320 x 320 with the character's feet at 0.97 H and x 0.56 W; same placement for ours (root at the feet line)
const view = { scale: S, width: 320, height: 320, x: Math.round(320 * 0.56), y: Math.round(320 * 0.97 - (1243 - 960) * S), background: BG };

// [live key index, our clip frame (-1 = ready), label]
const PAIRS: [number, number, string][] = [
  [0, -1, "rest / idle"],
  [2, 1, "windup (live 49 ms, ours f1 35 ms)"],
  [3, 2, "strike (live 77 ms, ours f2)"],
  [4, 3, "contact (live 105 ms, ours f3 hit)"],
  [5, 8, "follow (live 210 ms, ours f8)"],
  [6, 10, "return (live 280 ms, ours f10)"],
  [7, 12, "end (live 350 ms, ours f12)"]
];

async function main() {
  const ready = await renderFrames({ document: RIG, clip: "sword_ready", fps: 30, frames: 1, ...view });
  const live = PAIRS.map(([k, , label]) => ({ image: readPng(join(LIVE, `live-sword-left-key${k}.png`)), label: `LIVE ${label}` }));
  const rows = [];
  for (const clip of ["sword_chop_overhead", "sword_chop_overhead_notrail"]) {
    const r = await renderFrames({ document: RIG, clip, fps: 30, ...view });
    rows.push(PAIRS.map(([, f, label]) => ({ image: decodePng(((f < 0 ? ready : r).frames[Math.max(0, f)] as { png: Buffer }).png), label: `OURS${clip.endsWith("notrail") ? " no trail" : ""} ${label}` })));
    const seq = await renderFrames({ document: RIG, clip: "sword_ready", queue: [clip, "sword_ready"], fps: 30, frames: 60 + 21 + 30, ...view });
    writeGif(seq, join(DIR, `full-idle-${clip.replace(/_/g, "-")}-idle-view02356-30fps.gif`));
    const big = await renderFrames({ document: RIG, clip: "sword_ready", queue: [clip, "sword_ready"], fps: 30, frames: 60 + 21 + 30, ...view, scale: S * 2, width: 640, height: 640, x: view.x * 2, y: view.y * 2 });
    writeGif(big, join(DIR, `full-idle-${clip.replace(/_/g, "-")}-idle-view0471-x2-30fps.gif`));
    writePng(join(DIR, `${clip}-30fps-sheet-view02356.png`), grid(r.frames.slice(0, 14).map((fr, i) => ({ image: decodePng((fr as { png: Buffer }).png), label: `f${i}` })), 7, 2, true));
  }
  writePng(join(DIR, "live-vs-chop-keys-sheet-view02356.png"), grid([...live, ...rows[0]!, ...rows[1]!], PAIRS.length, 3, true));
  console.log("wrote the compare sheet, 30 fps sheets and GIFs");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
