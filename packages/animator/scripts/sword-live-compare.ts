// Live vs Atlas Animator sword, side by side at the same key times, and the idle -> slash -> idle GIF rendered as one
// real sequence (sword_ready, then sword_slash queued at the end of the idle loop, then sword_ready again).
// Run from packages/animator after scripts/live-sword-reference.ts and the held import:
//   npx tsx scripts/sword-live-compare.ts
import { join } from "node:path";
import { renderFrames, writeGif } from "../src/cli/render.js";
import { decodePng, readPng, writePng } from "../src/tools/png.js";
import { grid } from "../src/tools/review.js";

const DIR = "../../docs/plans/atlas-animator-demos/attacks/sword";
const RIG = join(DIR, "rig/template7-armlayer-body-sword.anim.json");
const LIVE = join(DIR, "live-reference/keys");
const BG = 0x1e2430; // the live reference background

// [live key index (live-sword-reference.ts KEYS), our clip, our frame, label]; ours runs the live program at 35 ms per
// frame with the 2-frame hitstop after contact (f3-5), so live 210 ms = f8, 280 = f10, 350 = f12
const PAIRS: [number, string, number, string][] = [
  [0, "sword_ready", 0, "rest / idle"],
  [2, "sword_slash", 1, "windup peak (live 49 ms, ours f1)"],
  [3, "sword_slash", 2, "strike (live 77 ms, ours f2)"],
  [4, "sword_slash", 3, "contact (live 105 ms, ours f3 hit)"],
  [5, "sword_slash", 8, "follow (live 210 ms, ours f8)"],
  [6, "sword_slash", 10, "return (live 280 ms, ours f10)"],
  [7, "sword_slash", 12, "end (live 350 ms, ours f12)"]
];

async function main() {
  const s = 0.28;
  const view = { scale: s, width: Math.round(960 * s), height: Math.round(1180 * s), x: Math.round(620 * s), y: Math.round(820 * s), background: BG };
  const slash = await renderFrames({ document: RIG, clip: "sword_slash", fps: 30, ...view });
  const ready = await renderFrames({ document: RIG, clip: "sword_ready", fps: 30, frames: 1, ...view });
  const live = PAIRS.map(([k, , , label]) => ({ image: readPng(join(LIVE, `live-sword-left-key${k}.png`)), label: `LIVE ${label}` }));
  const ours = PAIRS.map(([, clip, f, label]) => ({ image: decodePng(((clip === "sword_ready" ? ready : slash).frames[f] as { png: Buffer }).png), label: `OURS ${label}` }));
  writePng(join(DIR, "live-vs-ours-keys-sheet.png"), grid([...live, ...ours], PAIRS.length, 2, true));

  // idle (one 2 s loop) -> slash (0.7 s) -> idle (1 s), one render of the queued clips
  const seq = await renderFrames({ document: RIG, clip: "sword_ready", queue: ["sword_slash", "sword_ready"], fps: 30, frames: 60 + 21 + 30, ...view });
  writeGif(seq, join(DIR, "template7-armlayer-body-sword-idle-slash-idle-view028-30fps.gif"));
  console.log("wrote compare sheet and the idle-slash-idle GIF", seq.frames.length, "frames");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
