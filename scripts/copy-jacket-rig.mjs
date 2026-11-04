#!/usr/bin/env node
// Re-runnable: copy the Jacket B player rigs, then pre-render the approved clips into sprite sheets for the client.
//   node scripts/copy-jacket-rig.mjs [--ref <git ref>] [--dir <rig folder on disk>] [--scale 0.42]
// Source (no art edits, files are copied as built by packages/animator/scripts/views/five-anims-jacketb-rigs.sh):
//   default --ref feature/atlas-animator-turnfront--from-t1511 (its committed rigs, read with git show);
//   --dir reads a folder on disk instead (e.g. uncommitted rebuilds).
// Steps: 1. copy the 3 rigs to packages/animator/rigs/jacketb/ (the live-rig dev path, not shipped);
//        2. `animator render --png-dir` each clip, 30 fps fixed steps, transparent background;
//        3. trim each clip to its union box, drop duplicate frames, pack into pages <= 2048 px and write
//           apps/client/src/assets/player-rig/jacketb/*.png + jacketb-sheets.json;
//        4. 8-bit palette PNGs (libimagequant through sharp, dithered), as the gather sheets;
//        5. jacketb-torso.json: the chest bone's per-frame transform for each clip (the back sword rides it;
//           packages/animator/scripts/gather/torso-xf-jacketb.ts).
// Clips (five-anims 01-03): idle = front-turn00-faceA idle_weight_shift 96 f; walkL = front-turn15-faceA
// walk_in_place 28 f; walkR = front-turn15-faceA-mirin walk_in_place 28 f, drawn image-flipped by the client (as the
// evidence renders clip 02).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repo, "packages/animator/package.json"));
const { PNG } = require("pngjs");

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const REF = arg("ref", "feature/atlas-animator-turnfront--from-t1511");
const DIR = arg("dir", null);
// Output px per rig canvas px. 0.42 = 1:1 with the device pixels of the max-zoom player on a DPR 3 phone (measured in
// the feature runtime 2026-10-20: at 0.34 the sprite drew 0.4118 CSS px per sheet px = 1.235 device px, an upscale
// that read blurry; 0.34 * 1.235 = 0.42). The figure (~1120 canvas px) renders ~472 px tall.
const SCALE = Number(arg("scale", "0.42"));
const REF_PATH = "docs/plans/atlas-animator-demos/views/turned-front/five-anims/jacketb/rig";
const RIGS = ["front-turn00-faceA", "front-turn15-faceA", "front-turn15-faceA-mirin"];
const EXTS = [".anim.json", ".atlas.json", ".atlas.png"];
const CLIPS = [
  { id: "idle", rig: "front-turn00-faceA", clip: "idle_weight_shift", frames: 96, flip: false },
  { id: "walkL", rig: "front-turn15-faceA", clip: "walk_in_place", frames: 28, flip: false },
  { id: "walkR", rig: "front-turn15-faceA-mirin", clip: "walk_in_place", frames: 28, flip: true },
  // Turned standing (after a stop, before front idle): the idle clip on the turned rigs, every 30 fps pose (the old
  // 4-frame holds stepped the breath at 7.5 fps).
  { id: "standL", rig: "front-turn15-faceA", clip: "idle_weight_shift", frames: 96, flip: false },
  { id: "standR", rig: "front-turn15-faceA-mirin", clip: "idle_weight_shift", frames: 96, flip: true }
];
const PAGE_MAX = 2048;
// Generous render frame in canvas px; root (skeleton origin) here.
const BOX = { w: 1650, h: 1880, ox: 824, oy: 1294 };
const RENDER_W = Math.round(BOX.w * SCALE), RENDER_H = Math.round(BOX.h * SCALE), ROOT_X = Math.round(BOX.ox * SCALE), ROOT_Y = Math.round(BOX.oy * SCALE);

const rigDir = join(repo, "packages/animator/rigs/jacketb");
const outDir = join(repo, "apps/client/src/assets/player-rig/jacketb");
mkdirSync(rigDir, { recursive: true });

// 1. copy
let source = DIR ? resolve(DIR) : `${REF}:${REF_PATH}`;
for (const rig of RIGS) for (const ext of EXTS) {
  const to = join(rigDir, rig + ext);
  if (DIR) {
    const from = join(DIR, rig + ext);
    if (!existsSync(from)) throw new Error(`missing ${from}`);
    copyFileSync(from, to);
  } else {
    writeFileSync(to, execFileSync("git", ["-C", repo, "show", `${REF}:${REF_PATH}/${rig}${ext}`], { maxBuffer: 64 << 20 }));
  }
}
const sourceSha = DIR ? null : execFileSync("git", ["-C", repo, "rev-parse", REF]).toString().trim();
console.log(`copied ${RIGS.length} rigs from ${source}${sourceSha ? ` (${sourceSha.slice(0, 9)})` : ""}`);

// 2. render
const tmp = mkdtempSync(join(tmpdir(), "jacket-rig-"));
const cli = join(repo, "packages/animator/src/cli/animator.ts");
const read = (file) => PNG.sync.read(readFileSync(file));
const rendered = {};
for (const c of CLIPS) {
  const dir = join(tmp, c.id);
  execFileSync(process.execPath, [join(repo, "node_modules/tsx/dist/cli.mjs"), cli, "render", join(rigDir, `${c.rig}.anim.json`),
    "--clip", c.clip, "--fps", "30", "--frames", String(c.frames), "--scale", String(SCALE),
    "--size", `${RENDER_W}x${RENDER_H}`, "--origin", `${ROOT_X},${ROOT_Y}`, "--background", "transparent", "--png-dir", dir],
    { stdio: "inherit", cwd: repo });
  const all = readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => read(join(dir, f)));
  if (all.length !== c.frames) throw new Error(`${c.id}: ${all.length} frames, expected ${c.frames}`);
  // Held poses: frame i shows the pose of frame i - i % hold (kept frames show their own); dedupe then packs each once.
  rendered[c.id] = all.map((_, i) => all[c.hold && !c.keep?.includes(i) ? i - (i % c.hold) : i]);
}

// 3. trim, dedupe, pack
const bbox = (im) => {
  let x0 = im.width, y0 = im.height, x1 = -1, y1 = -1;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    if (im.data[(y * im.width + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
};
for (const f of readdirSync(outDir)) rmSync(join(outDir, f));
const idle0 = bbox(rendered.idle[0]);
const manifest = {
  format: "jacket-sheets@1",
  source: DIR ? { dir: source } : { ref: REF, sha: sourceSha },
  scale: SCALE,
  fps: 30,
  // The front idle setup frame: figure height and foot line (px below the root), the in-game size reference.
  figureHeightPx: idle0.y1 - idle0.y0 + 1,
  footBelowRootPx: idle0.y1 + 1 - ROOT_Y,
  clips: {}
};
let bytes = 0, texels = 0;
for (const c of CLIPS) {
  const frames = rendered[c.id];
  const u = frames.map(bbox).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
  if (u.x0 <= 0 || u.y0 <= 0 || u.x1 >= RENDER_W - 1 || u.y1 >= RENDER_H - 1) throw new Error(`${c.id}: figure touches the render edge; enlarge RENDER_W/H`);
  const w = u.x1 - u.x0 + 2, h = u.y1 - u.y0 + 2; // 1 px transparent gutter right/bottom
  const unique = []; const index = []; const seen = new Map();
  for (const im of frames) {
    const crop = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h - 1; y++) im.data.copy(crop, y * w * 4, ((u.y0 + y) * im.width + u.x0) * 4, ((u.y0 + y) * im.width + u.x1 + 1) * 4);
    const key = createHash("sha1").update(crop).digest("hex");
    if (!seen.has(key)) { seen.set(key, unique.length); unique.push(crop); }
    index.push(seen.get(key));
  }
  const cols = Math.max(1, Math.floor(PAGE_MAX / w));
  const rowsPerPage = Math.max(1, Math.floor(PAGE_MAX / h));
  const perPage = cols * rowsPerPage;
  const pages = [];
  const cells = [];
  for (let p = 0; p * perPage < unique.length; p++) {
    const count = Math.min(perPage, unique.length - p * perPage);
    const pw = Math.min(cols, count) * w, ph = Math.ceil(count / cols) * h;
    const page = new PNG({ width: pw, height: ph });
    page.data.fill(0);
    for (let k = 0; k < count; k++) {
      const cx = (k % cols) * w, cy = Math.floor(k / cols) * h;
      const crop = unique[p * perPage + k];
      for (let y = 0; y < h; y++) crop.copy(page.data, ((cy + y) * pw + cx) * 4, y * w * 4, (y + 1) * w * 4);
      cells.push([p, cx, cy]);
    }
    const file = `${c.id}-${p}.png`;
    const buf = PNG.sync.write(page, { colorType: 6, deflateLevel: 9 });
    writeFileSync(join(outDir, file), buf);
    bytes += buf.length; texels += pw * ph;
    pages.push(file);
  }
  manifest.clips[c.id] = {
    rig: c.rig, clip: c.clip, flip: c.flip, frameWidth: w, frameHeight: h,
    // Root (feet anchor column / skeleton origin) inside a frame, px.
    rootX: ROOT_X - u.x0, rootY: ROOT_Y - u.y0,
    pages, frames: index.map((i) => cells[i])
  };
  console.log(`${c.id}: ${frames.length} frames, ${unique.length} unique, ${w}x${h}, ${pages.length} page(s)`);
}
writeFileSync(join(outDir, "jacketb-sheets.json"), `${JSON.stringify(manifest)}\n`);
rmSync(tmp, { recursive: true, force: true });
// 4. 8-bit palette PNGs: the GPU size is unchanged (decoded to RGBA), the download about a fifth.
const sharp = createRequire(join(repo, "apps/client/package.json"))("sharp");
for (const f of readdirSync(outDir).filter((f) => f.endsWith(".png"))) {
  const buf = await sharp(join(outDir, f)).png({ palette: true, colours: 256, quality: 100, dither: 1, effort: 10, compressionLevel: 9 }).toBuffer();
  writeFileSync(join(outDir, f), buf);
}
const quantBytes = readdirSync(outDir).filter((f) => f.endsWith(".png")).reduce((n, f) => n + readFileSync(join(outDir, f)).length, 0);
console.log(`sheets: ${(bytes / 1048576).toFixed(2)} MB RGBA PNG -> ${(quantBytes / 1048576).toFixed(2)} MB 8-bit PNG, ${(texels * 4 / 1048576).toFixed(1)} MB as RGBA textures (+1/3 with mipmaps)`);
// 5. per-frame torso (chest) transforms, for the sword on the back
execFileSync(process.execPath, [join(repo, "node_modules/tsx/dist/cli.mjs"), "scripts/gather/torso-xf-jacketb.ts", join(outDir, "jacketb-torso.json")],
  { stdio: "inherit", cwd: join(repo, "packages/animator") });
