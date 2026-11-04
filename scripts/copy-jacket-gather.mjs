#!/usr/bin/env node
// Re-runnable: Jacket B gathering + flag-building sheets (docs/plans/player-gather-anims.md).
//   node scripts/copy-jacket-gather.mjs                 -> apps/client/src/assets/player-rig/jacketb-gather/*.png + jacketb-gather.json
//   node scripts/copy-jacket-gather.mjs --evidence      -> docs/plans/player-gather-anims/ (GIF + contact sheet per clip, tool attached, view 0.4 and 0.471)
//   --only a,b: just these clips; the other clips' sheets and manifest entries are kept as they are
//   --set sword: the sword walk (sword arm held at the drawn ready pose, docs/plans/player-sword-keyposes/README.md)
//                -> jacketb-sword/sword_walk*.png + its jacketb-sword.json entry; the drawn swing key poses in the same
//                folder and manifest (keyposes*, written by scripts/pack-sword-keyposes.py) are kept
//   --set sword-combo --evidence: the retired rig combo clips (docs/plans/player-sword-combo.md), evidence only
// Needs the rigs copied by scripts/copy-jacket-rig.mjs (packages/animator/rigs/jacketb).
// Steps: 1. packages/animator/scripts/gather/gather-clips-jacketb.ts authors the clips on both turned rigs and the
//           per-frame item (tool / flag) transforms (tools are not baked into the sheets);
//        2. `animator render --png-dir` each clip on L15 and on the mirrored-input R rig (drawn image-flipped);
//        3. holds (every `hold`-th pose held, `keep` frames whole; every clip now ships hold 1 = all 30 fps poses),
//           trim to the union box, dedupe, pack into pages <= 2048 px, 8-bit palette PNGs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const animator = join(repo, "packages/animator");
const require = createRequire(join(animator, "package.json"));
const { PNG } = require("pngjs");
const EVIDENCE = process.argv.includes("--evidence");
const SET_ARG = process.argv.includes("--set") ? process.argv[process.argv.indexOf("--set") + 1] : "gather";
const SET = SET_ARG === "sword" || SET_ARG === "sword-combo" ? SET_ARG : "gather";
if (SET === "sword-combo" && !EVIDENCE) throw new Error("--set sword-combo is retired (not shipped): --evidence only");
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? process.argv[i + 1].split(",") : null; })();
const SCALE = 0.42; // as the body sheets (scripts/copy-jacket-rig.mjs): 1:1 with the max-zoom player on a DPR 3 phone
const RIGS = { L: "front-turn15-faceA", R: "front-turn15-faceA-mirin" };
const PAGE_MAX = 2048;
// Generous render frame in canvas px around the skeleton origin (arms overhead, lunges); tools are composited later.
const BOX = { w: 1900, h: 2000, ox: 950, oy: 1350 };

const tsx = join(repo, "node_modules/tsx/dist/cli.mjs");
const work = mkdtempSync(join(tmpdir(), "jacket-gather-"));
const rigOut = join(work, "rig");
execFileSync(process.execPath, [tsx, "scripts/gather/gather-clips-jacketb.ts", rigOut, SET], { cwd: animator, stdio: "inherit" });
for (const rig of Object.values(RIGS)) for (const ext of [".atlas.json", ".atlas.png"]) {
  const from = join(animator, "rigs/jacketb", rig + ext);
  if (!existsSync(from)) throw new Error(`missing ${from}; run scripts/copy-jacket-rig.mjs first`);
  copyFileSync(from, join(rigOut, rig + ext));
}
const clips = JSON.parse(readFileSync(join(rigOut, `${SET}-clips.json`), "utf8"));
const read = (file) => PNG.sync.read(readFileSync(file));
function render(rig, c, scale, dir) {
  const frames = c.loop ? c.frames : c.frames + 1;
  execFileSync(process.execPath, [tsx, join(animator, "src/cli/animator.ts"), "render", join(rigOut, `${rig}.anim.json`),
    "--clip", c.anim, "--fps", "30", "--frames", String(frames), "--scale", String(scale),
    "--size", `${Math.round(BOX.w * scale)}x${Math.round(BOX.h * scale)}`, "--origin", `${Math.round(BOX.ox * scale)},${Math.round(BOX.oy * scale)}`,
    "--background", "transparent", "--png-dir", dir], { stdio: ["ignore", "ignore", "inherit"], cwd: repo });
  return readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => join(dir, f));
}
const unknown = (ONLY ?? []).filter((id) => !clips.clips[id]);
if (unknown.length) throw new Error(`--only: no ${SET} clip ${unknown.join(", ")} (have ${Object.keys(clips.clips).join(", ")})`);
const ids = Object.keys(clips.clips).filter((id) => !ONLY || ONLY.includes(id));

if (EVIDENCE) {
  const outDir = join(repo, SET === "sword-combo" ? "docs/plans/player-sword-combo" : SET === "sword" ? "docs/plans/player-sword-keyposes/walk" : "docs/plans/player-gather-anims");
  mkdirSync(outDir, { recursive: true });
  const jobs = [];
  for (const id of ids) for (const view of [0.4, 0.471]) {
    const dir = join(work, `ev-${id}-${view}`);
    render(RIGS.L, clips.clips[id], view, dir);
    jobs.push({ id, view, dir, ox: Math.round(BOX.ox * view), oy: Math.round(BOX.oy * view) });
    console.log(`rendered ${id} @ ${view}`);
  }
  writeFileSync(join(work, "jobs.json"), JSON.stringify({ clips: clips.clips, jobs, outDir, sequence: SET === "sword-combo" ? { id: "combo-loop", clips: ids } : null }));
  execFileSync("python", [join(repo, "scripts/jacket-gather-evidence.py"), join(work, "jobs.json")], { stdio: "inherit", cwd: repo });
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

// Sheets
const outDir = join(repo, `apps/client/src/assets/player-rig/jacketb-${SET}`);
const manifestPath = join(outDir, `jacketb-${SET}.json`);
mkdirSync(outDir, { recursive: true });
// --only keeps every other clip: its pages stay and its manifest entry is carried over (a partial manifest would drop it).
const previous = (ONLY || SET === "sword") && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
if (ONLY && !previous) throw new Error(`--only needs an existing ${manifestPath}; run without --only first`);
const ownedBy = (f) => ids.some((id) => f.startsWith(`${id}L-`) || f.startsWith(`${id}R-`));
// The sword set shares its folder with the drawn key poses (keyposes*.png, scripts/pack-sword-keyposes.py): only
// its own clips' pages go.
for (const f of readdirSync(outDir)) if ((!ONLY && SET !== "sword") || (f.endsWith(".png") && ownedBy(f))) rmSync(join(outDir, f));
const written = [];
const bbox = (im) => {
  let x0 = im.width, y0 = im.height, x1 = -1, y1 = -1;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    if (im.data[(y * im.width + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
};
const W = Math.round(BOX.w * SCALE), H = Math.round(BOX.h * SCALE), OX = Math.round(BOX.ox * SCALE), OY = Math.round(BOX.oy * SCALE);
const manifest = { format: `jacket-${SET}-sheets@1`, scale: SCALE, fps: 30, gripLocal: clips.gripLocal, clips: {} };
let bytes = 0, texels = 0, uniqueTotal = 0;
for (const id of ids) {
  const c = clips.clips[id];
  const entry = { frames: c.frames, loop: c.loop, contact: c.contact, item: c.item, xf: c.xf, views: {} };
  for (const [side, rig] of Object.entries(RIGS)) {
    const all = render(rig, c, SCALE, join(work, `${id}-${side}`)).map(read);
    // Held poses: frame i shows the pose of frame i - i % hold, except the kept (contact) frames.
    const frames = all.map((_, i) => all[c.keep.includes(i) ? i : i - (i % c.hold)]);
    const u = frames.map(bbox).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
    if (u.x0 <= 0 || u.y0 <= 0 || u.x1 >= W - 1 || u.y1 >= H - 1) throw new Error(`${id} ${side}: figure touches the render edge`);
    const w = u.x1 - u.x0 + 2, h = u.y1 - u.y0 + 2;
    const unique = [], index = [], seen = new Map();
    for (const im of frames) {
      const crop = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h - 1; y++) im.data.copy(crop, y * w * 4, ((u.y0 + y) * im.width + u.x0) * 4, ((u.y0 + y) * im.width + u.x1 + 1) * 4);
      const key = createHash("sha1").update(crop).digest("hex");
      if (!seen.has(key)) { seen.set(key, unique.length); unique.push(crop); }
      index.push(seen.get(key));
    }
    const cols = Math.max(1, Math.floor(PAGE_MAX / w)), perPage = cols * Math.max(1, Math.floor(PAGE_MAX / h));
    const pages = [], cells = [];
    for (let p = 0; p * perPage < unique.length; p++) {
      const count = Math.min(perPage, unique.length - p * perPage);
      const pw = Math.min(cols, count) * w, ph = Math.ceil(count / cols) * h;
      const page = new PNG({ width: pw, height: ph });
      page.data.fill(0);
      for (let k = 0; k < count; k++) {
        const cx = (k % cols) * w, cy = Math.floor(k / cols) * h, crop = unique[p * perPage + k];
        for (let y = 0; y < h; y++) crop.copy(page.data, ((cy + y) * pw + cx) * 4, y * w * 4, (y + 1) * w * 4);
        cells.push([p, cx, cy]);
      }
      const file = `${id}${side}-${p}.png`;
      const buf = PNG.sync.write(page, { colorType: 6, deflateLevel: 9 });
      writeFileSync(join(outDir, file), buf);
      written.push(file);
      bytes += buf.length; texels += pw * ph;
      pages.push(file);
    }
    uniqueTotal += unique.length;
    entry.views[side] = { rig, flip: side === "R", frameWidth: w, frameHeight: h, rootX: OX - u.x0, rootY: OY - u.y0, pages, frames: index.map((i) => cells[i]) };
    console.log(`${id}${side}: ${frames.length} frames, ${unique.length} unique, ${w}x${h}, ${pages.length} page(s)`);
  }
  manifest.clips[id] = entry;
}
if (previous?.keyposes) manifest.keyposes = previous.keyposes;
if (previous && ONLY) {
  // Authored order; clips not re-rendered keep their previous entry.
  const merged = {};
  for (const id of Object.keys(clips.clips)) {
    const entry = manifest.clips[id] ?? previous.clips[id];
    if (entry) merged[id] = entry;
  }
  for (const [id, entry] of Object.entries(previous.clips)) if (!merged[id]) merged[id] = entry;
  manifest.clips = merged;
}
writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
// 8-bit palette PNGs (libimagequant through sharp, dithered): about a seventh of the bytes, checked visually on crops
// at view 0.471; the GPU size is unchanged (decoded to RGBA).
const sharp = createRequire(join(repo, "apps/client/package.json"))("sharp");
for (const f of written) {
  const buf = await sharp(join(outDir, f)).png({ palette: true, colours: 256, quality: 100, dither: 1, effort: 10, compressionLevel: 9 }).toBuffer();
  writeFileSync(join(outDir, f), buf);
}
bytes = readdirSync(outDir).filter((f) => f.endsWith(".png")).reduce((n, f) => n + readFileSync(join(outDir, f)).length, 0);
rmSync(work, { recursive: true, force: true });
console.log(`${SET} sheets: ${uniqueTotal} unique frames, ${(bytes / 1048576).toFixed(2)} MB PNG, ${(texels * 4 / 1048576).toFixed(1)} MB as RGBA textures (+1/3 with mipmaps)`);
