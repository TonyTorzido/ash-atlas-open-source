#!/usr/bin/env node
// Re-runnable: the stock-armour player (2026-10-21). Two parts, both frame-aligned with the Jacket B sheets' format
// (scripts/copy-jacket-rig.mjs: 0.42 scale, 30 fps, render frame 1650x1880 with the root at 824,1294, trimmed to the
// clip's union box + 1 px gutter, duplicate frames packed once, pages <= 2048 px, 8-bit palette PNGs):
//   1. the BARE STOCK body sheets (tank + black pants; the body the garment layers were cut against):
//      apps/client/src/assets/player-rig/stock-body/*.png + stock-body-sheets.json. Clips: idle, walkL/R, standL/R
//      and every gather clip per side (chopL, chopR, ...), the same ids, rigs, frame counts and render frame as
//      packages/animator/scripts/views/garment-layer-sheets.ts (its `--body-mode stock` body);
//   2. the four stock armours' garment layers, copied as built by that tool (no art edits):
//      apps/client/src/assets/player-rig/stock-armour/<item>/*.png + <item>-layers.json.
//   3. the sword walk (sword out, 2026-10-21): sword_walkL / sword_walkR for the bare body and each armour's layer,
//      rendered here by packages/animator/scripts/views/garment-layer-sheets.ts --sword-walk (the animator branch ships
//      no sword_walk layers) from the same rigs at the same ref. The clip is the Jacket B sword walk's derivation
//      (scripts/gather/sword-walk.ts) on the stock rigs, which share the skeleton, walk and IK, so the Jacket B
//      sword walk's grip transform (jacketb-sword.json) holds for every frame.
// The client draws body frame i then layer frame i of the same clip, each anchored at its own rootX/rootY.
//   node scripts/copy-stock-armour.mjs [--ref <git ref>] [--check <dir with the tool's --body-out pages>] [--sword-walk-only]
// --sword-walk-only: step 3 alone, merged into the existing sheets and manifests (steps 1-2 untouched).
// --check compares every body page pixel for pixel with the tool's own body render (they must be identical).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const animator = join(repo, "packages/animator");
const require = createRequire(join(animator, "package.json"));
const { PNG } = require("pngjs");
const sharp = createRequire(join(repo, "apps/client/package.json"))("sharp");

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const REF = arg("ref", "feature/atlas-animator-stockarmour--from-t1511");
const CHECK = arg("check", null);
const SWORD_WALK_ONLY = process.argv.includes("--sword-walk-only");
const SWORD_WALK_CLIPS = ["sword_walkL", "sword_walkR"];
const BODY_PATH = "docs/plans/atlas-animator-demos/views/turned-front/five-anims/rig";
const LAYER_PATH = "docs/plans/atlas-animator-demos/views/turned-front/stock-armour";
const ITEMS = ["cloth", "leather", "chainmail", "breastplate"];
const RIGS = ["front-turn00-faceA", "front-turn15-faceA", "front-turn15-faceA-mirin"];
const SCALE = 0.42;
const BOX = { w: 1650, h: 1880, ox: 824, oy: 1294 };
const RW = Math.round(BOX.w * SCALE), RH = Math.round(BOX.h * SCALE), RX = Math.round(BOX.ox * SCALE), RY = Math.round(BOX.oy * SCALE);
const PAGE_MAX = 2048;
const CLIPS = [
  { id: "idle", rig: "front-turn00-faceA", clip: "idle_weight_shift", frames: 96, flip: false },
  { id: "walkL", rig: "front-turn15-faceA", clip: "walk_in_place", frames: 28, flip: false },
  { id: "walkR", rig: "front-turn15-faceA-mirin", clip: "walk_in_place", frames: 28, flip: true },
  { id: "standL", rig: "front-turn15-faceA", clip: "idle_weight_shift", frames: 96, flip: false },
  { id: "standR", rig: "front-turn15-faceA-mirin", clip: "idle_weight_shift", frames: 96, flip: true }
];

const git = (...a) => execFileSync("git", ["-C", repo, ...a], { maxBuffer: 256 << 20 });
const sha = git("rev-parse", REF).toString().trim();
const tsx = join(repo, "node_modules/tsx/dist/cli.mjs");
const work = mkdtempSync(join(tmpdir(), "stock-armour-"));

// 1a. the bare stock rigs (no art edits)
const rigDir = join(work, "rig");
mkdirSync(rigDir, { recursive: true });
for (const rig of RIGS) for (const ext of [".anim.json", ".atlas.json", ".atlas.png"]) {
  writeFileSync(join(rigDir, rig + ext), git("show", `${REF}:${BODY_PATH}/${rig}${ext}`));
}
if (!SWORD_WALK_ONLY) {
// 1b. the gather clips (bone timelines authored on the Jacket B turned rigs) copied onto the stock turned rigs
const gatherDir = join(work, "gather");
execFileSync(process.execPath, [tsx, "scripts/gather/gather-clips-jacketb.ts", gatherDir, "gather"], { cwd: animator, stdio: "inherit" });
const gatherClips = JSON.parse(readFileSync(join(gatherDir, "gather-clips.json"), "utf8")).clips;
for (const rig of ["front-turn15-faceA", "front-turn15-faceA-mirin"]) {
  const doc = JSON.parse(readFileSync(join(rigDir, `${rig}.anim.json`), "utf8"));
  const g = JSON.parse(readFileSync(join(gatherDir, `${rig}.anim.json`), "utf8"));
  if (JSON.stringify(doc.bones) !== JSON.stringify(g.bones)) throw new Error(`${rig}: the stock skeleton differs from Jacket B's; the gather clips cannot be copied`);
  for (const [k, v] of Object.entries(g.animations)) {
    if (!k.startsWith("gather_")) continue;
    if (Object.keys(v).some((x) => !["duration", "loop", "fps", "bones"].includes(x))) throw new Error(`${k}: not a bone-only clip`);
    doc.animations[k] = v;
  }
  writeFileSync(join(rigDir, `${rig}.anim.json`), JSON.stringify(doc));
}
for (const [id, c] of Object.entries(gatherClips)) {
  // As the layer tool: c.frames poses (a one-shot clip's end pose is not rendered; the client clamps to the last frame).
  CLIPS.push({ id: `${id}L`, rig: "front-turn15-faceA", clip: c.anim, frames: c.frames, flip: false, gather: true });
  CLIPS.push({ id: `${id}R`, rig: "front-turn15-faceA-mirin", clip: c.anim, frames: c.frames, flip: true, gather: true });
}

// 1c. render, trim, dedupe, pack
const bodyOut = join(repo, "apps/client/src/assets/player-rig/stock-body");
mkdirSync(bodyOut, { recursive: true });
for (const f of readdirSync(bodyOut)) rmSync(join(bodyOut, f));
const read = (file) => PNG.sync.read(readFileSync(file));
const bbox = (im) => {
  let x0 = im.width, y0 = im.height, x1 = -1, y1 = -1;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    if (im.data[(y * im.width + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
};
const manifest = { format: "stock-body-sheets@1", source: { ref: REF, sha, path: BODY_PATH }, scale: SCALE, fps: 30, clips: {} };
let texels = 0;
for (const c of CLIPS) {
  const dir = join(work, `r-${c.id}`);
  execFileSync(process.execPath, [tsx, join(animator, "src/cli/animator.ts"), "render", join(rigDir, `${c.rig}.anim.json`),
    "--clip", c.clip, "--fps", "30", "--frames", String(c.frames), "--scale", String(SCALE),
    "--size", `${RW}x${RH}`, "--origin", `${RX},${RY}`, "--background", "transparent", "--png-dir", dir],
    { stdio: ["ignore", "ignore", "inherit"], cwd: repo });
  const frames = readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => read(join(dir, f)));
  if (frames.length !== c.frames) throw new Error(`${c.id}: ${frames.length} frames, expected ${c.frames}`);
  const u = frames.map(bbox).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
  if (u.x0 <= 0 || u.y0 <= 0 || u.x1 >= RW - 1 || u.y1 >= RH - 1) throw new Error(`${c.id}: figure touches the render edge`);
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
    const file = `${c.id}-${p}.png`;
    const buf = await sharp(PNG.sync.write(page, { colorType: 6 })).png({ palette: true, colours: 256, quality: 100, dither: 1, effort: 10, compressionLevel: 9 }).toBuffer();
    writeFileSync(join(bodyOut, file), buf);
    texels += pw * ph;
    pages.push(file);
  }
  manifest.clips[c.id] = { rig: c.rig, clip: c.clip, flip: c.flip, frameWidth: w, frameHeight: h, rootX: RX - u.x0, rootY: RY - u.y0, pages, frames: index.map((i) => cells[i]) };
  console.log(`body ${c.id}: ${frames.length} frames, ${unique.length} unique, ${w}x${h}, ${pages.length} page(s)`);
}
writeFileSync(join(bodyOut, "stock-body-sheets.json"), `${JSON.stringify(manifest)}\n`);
console.log(`stock body: ${(texels * 4 / 1048576).toFixed(1)} MB as RGBA textures (all clips)`);

// 2. the garment layers, as built (absolute source paths dropped from the manifest)
for (const item of ITEMS) {
  const out = join(repo, "apps/client/src/assets/player-rig/stock-armour", item);
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) rmSync(join(out, f));
  const src = `${LAYER_PATH}/${item}/layers`;
  const layers = JSON.parse(git("show", `${REF}:${src}/${item}-layers.json`).toString());
  if (layers.format !== "garment-layers@1" || layers.scale !== SCALE || (layers.bodyMode ?? "stock") !== "stock") throw new Error(`${item}: unexpected layer manifest`);
  delete layers.outfit; delete layers.body;
  layers.source = { ref: REF, sha, path: src };
  for (const [id, c] of Object.entries(layers.clips)) {
    const body = manifest.clips[id];
    if (!body) throw new Error(`${item}: no body clip ${id}`);
    if (c.frames.length !== body.frames.length || c.flip !== body.flip) throw new Error(`${item} ${id}: ${c.frames.length} layer frames vs ${body.frames.length} body`);
    for (const page of c.pages) writeFileSync(join(out, page), git("show", `${REF}:${src}/${page}`));
  }
  for (const id of Object.keys(manifest.clips)) if (!layers.clips[id]) throw new Error(`${item}: no layer clip ${id}`);
  writeFileSync(join(out, `${item}-layers.json`), `${JSON.stringify(layers)}\n`);
  console.log(`layers ${item}: ${Object.keys(layers.clips).length} clips`);
}

}

// 3. the sword walk: the layer tool renders the bare body and each armour's layer for the two sword walk clips.
{
  const bodyOut = join(repo, "apps/client/src/assets/player-rig/stock-body");
  const bodyManifestPath = join(bodyOut, "stock-body-sheets.json");
  const bodyManifest = JSON.parse(readFileSync(bodyManifestPath, "utf8"));
  const owned = (f) => SWORD_WALK_CLIPS.some((id) => f.startsWith(`${id}-`));
  for (const f of readdirSync(bodyOut)) if (owned(f)) rmSync(join(bodyOut, f));
  let bodyDone = null;
  for (const item of ITEMS) {
    const outfit = join(work, `outfit-${item}`), out = join(work, `sw-${item}`), body = join(work, `sw-body-${item}`);
    mkdirSync(outfit, { recursive: true });
    for (const rig of RIGS) for (const ext of [".anim.json", ".atlas.json", ".atlas.png"]) {
      writeFileSync(join(outfit, rig + ext), git("show", `${REF}:${LAYER_PATH}/${item}/rig/${rig}${ext}`));
    }
    execFileSync(process.execPath, [tsx, "scripts/views/garment-layer-sheets.ts", "--outfit", outfit, "--name", item, "--out", out,
      "--body", rigDir, "--body-out", body, "--sword-walk", "--clips", SWORD_WALK_CLIPS.join(","), "--scale", String(SCALE)],
      { cwd: animator, stdio: ["ignore", "inherit", "inherit"] });
    const bm = JSON.parse(readFileSync(join(body, "body-sheets.json"), "utf8"));
    if (bm.scale !== SCALE || bm.fps !== 30) throw new Error(`${item}: sword walk body scale / fps`);
    if (bodyDone === null) {
      for (const id of SWORD_WALK_CLIPS) {
        for (const page of bm.clips[id].pages) writeFileSync(join(bodyOut, page), readFileSync(join(body, page)));
        bodyManifest.clips[id] = bm.clips[id];
      }
      bodyDone = bm;
    } else {
      // the body is the same bare stock for every item: its pages must come out identical
      for (const id of SWORD_WALK_CLIPS) for (const page of bm.clips[id].pages) {
        if (!readFileSync(join(body, page)).equals(readFileSync(join(bodyOut, page)))) throw new Error(`${item}: sword walk body page ${page} differs`);
      }
    }
    const layerOut = join(repo, "apps/client/src/assets/player-rig/stock-armour", item);
    const layerManifestPath = join(layerOut, `${item}-layers.json`);
    const layers = JSON.parse(readFileSync(layerManifestPath, "utf8"));
    const lm = JSON.parse(readFileSync(join(out, `${item}-layers.json`), "utf8"));
    for (const f of readdirSync(layerOut)) if (owned(f)) rmSync(join(layerOut, f));
    for (const id of SWORD_WALK_CLIPS) {
      const c = lm.clips[id];
      if (c.frames.length !== bodyManifest.clips[id].frames.length || c.flip !== bodyManifest.clips[id].flip) throw new Error(`${item} ${id}: layer / body frames differ`);
      for (const page of c.pages) writeFileSync(join(layerOut, page), readFileSync(join(out, page)));
      layers.clips[id] = c;
    }
    layers.swordWalk = { tool: "packages/animator/scripts/views/garment-layer-sheets.ts --sword-walk", ref: REF, sha };
    writeFileSync(layerManifestPath, `${JSON.stringify(layers)}\n`);
    const report = JSON.parse(readFileSync(join(out, "layers-report.json"), "utf8"));
    for (const id of SWORD_WALK_CLIPS) console.log(`sword walk ${item} ${id}: composite 8-bit max ${report.clips[id].composite.eightBit.max}, unrepresentable ${report.clips[id].composite.unrepresentablePx} px`);
  }
  writeFileSync(bodyManifestPath, `${JSON.stringify(bodyManifest)}\n`);
}

// optional: the body pages vs the layer tool's own body render
if (CHECK) {
  let bad = 0;
  for (const f of readdirSync(bodyOut).filter((f) => f.endsWith(".png"))) {
    const ref = join(CHECK, f);
    if (!existsSync(ref)) { console.log(`check: ${f} missing in ${CHECK}`); bad++; continue; }
    const [a, b] = await Promise.all([join(bodyOut, f), ref].map((p) => sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
    if (a.info.width !== b.info.width || a.info.height !== b.info.height || !a.data.equals(b.data)) { console.log(`check: ${f} differs`); bad++; }
  }
  console.log(bad ? `check: ${bad} body page(s) differ` : "check: every body page matches the layer tool's body render");
  if (bad) process.exitCode = 1;
}
rmSync(work, { recursive: true, force: true });
