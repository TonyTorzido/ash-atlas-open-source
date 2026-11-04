// Layered garment sheets (2026-10-20, stock armour Phase B; no game wiring yet). One garment-only sheet set per item,
// drawn by the client OVER the shared body sheets (the bare refined stock, five-anims/rig), frame-aligned with them.
//   npx tsx scripts/views/garment-layer-sheets.ts --outfit <outfit rig dir> --name <item> --out <dir>
//     [--body <body rig dir>] [--body-mode stock|dressed|dressed-cover] [--scale 0.42] [--gather <dir>] [--body-out <dir>]
//     [--clips idle,walkL,...] [--sword-walk] [--diag]   (--diag: the worst frame per clip as F | B | L | error mask)
// Copied into the game repo from feature/atlas-animator-stockarmour--from-t1511 (f6bebf953) on 2026-10-21 for the
// stock-armour sword walk (scripts/copy-stock-armour.mjs); the only changes are --sword-walk and the body manifest
// (<body-out>/body-sheets.json: per clip the body frame size, root, pages and cells, as stock-body-sheets.json).
// --sword-walk: also the clips sword_walkL / sword_walkR: the sword_walk animation derived from each rig's own
// walk_in_place by ../gather/sword-walk.ts (the same derivation as the Jacket B sword walk sheets; the stock and Jacket B
// turned rigs share the skeleton, walk and IK, so the pose and the exported grip are identical).
// Same render frame, scale, clip list and packing as the game's scripts/copy-jacket-rig.mjs (BOX 1650x1880, root
// 824,1294, 30 fps, pages <= 2048 px, duplicate frames packed once, 8-bit palette PNGs through sharp/libimagequant).
// --gather <dir>: the output of the game's packages/animator/scripts/gather/gather-clips-jacketb.ts (gather-clips.json
// + the two turned rigs with the gather_* clips). Those clips are bone timelines only; they are copied onto the body
// and the outfit rigs (the skeletons must hash equal) and rendered the same way.
//
// The layer is DERIVED, not slot-filtered. The garment interleaves with the body in draw order (garment torso, then
// each arm over it, then that arm's sleeve over the arm, then the head over the collar), so the garment slots alone
// drawn after the body are wrong (the torso would cover both arms), and a slot layer that also carries the arms and
// head redraws their anti-aliased edges a second time over the body sheet (alpha compounds: not +-1). Instead, per
// pixel, the layer L is solved from the full-outfit render F and the body render B so that L over B = F:
//   F == B (+-1)          -> L transparent (the body sheet already shows it: arms over the garment, the head, legs);
//   B.a == 0 or 255       -> L = F;
//   0 < B.a < F.a         -> L.a = (F.a - B.a) / (1 - B.a), L.rgb = (F.rgb F.a - (1 - L.a) B.rgb B.a) / L.a;
//   F.a < B.a (or F.a == B.a with a colour change) -> NOT representable by one over-layer (the outfit removes body
//                            alpha there); counted as `unrepresentable` and written as L = F.
// Every frame is then composited back (L over B, straight-alpha 8-bit, rounded) and compared with F: the report gives
// the worst channel error (premultiplied rgb and alpha, 0-255) and the pixels over 1, before and after 8-bit
// quantisation (the 8-bit full-outfit sheet's own error vs F is given as the baseline).
// Writes <out>/<clip>-<page>.png (8-bit), <out>/<name>-layers.json (manifest: per clip the layer frame size, its root
// inside the frame, pages, per-frame cells) and <out>/layers-report.json (sizes, GPU memory, composite check).
// --body-out <dir>: also writes the shared body sheets (same format) there, for their size and the composite check.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderFrames } from "../../src/cli/render.js";
import { SWORD_WALK, swordWalkFrom } from "../gather/sword-walk.js";
import { decodePng, encodePng } from "../../src/tools/png.js";
import type { RgbaImage } from "../../src/tools/image.js";

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1]! : d; };
const D = "../../docs/plans/atlas-animator-demos/views/turned-front";
const OUTFIT = resolve(arg("outfit")!);
const NAME = arg("name")!;
const OUT = resolve(arg("out")!);
const BODY = resolve(arg("body", join(D, "five-anims/rig"))!);
// --body-mode: the body the layers are cut against (2026-10-21).
//   stock (default)  the bare refined stock rigs in --body (shared; the 2026-10-20 format);
//   dressed          the outfit rig with its garment slots emptied, the tank hidden (the dressing's HIDES): the stock
//                    body exactly as the dressing leaves it (black-pants waist, the outfit's turn and face). Shared
//                    across items (the dressing edits no body slot per item), but the garment's coverage trims of the
//                    body contours (pants / torso outline past the hem, forearm under the cuff) are missing;
//   dressed-cover    as dressed, but the garment stays as an invisible coverer (its atlas region cleared, its own
//                    contours removed), so the body contours are trimmed exactly as in the outfit. Per ITEM (the trims
//                    follow the garment's geometry): the closest match, but not a shared sheet.
// The tank stays hidden in the dressed bodies, as in every outfit (restoring it pokes its flank and, in the raised-arm
// gather poses, its armhole past the garment: body alpha the outfit removes, which no over-layer can express).
const BODY_MODE = arg("body-mode", "stock")!;
if (!["stock", "dressed", "dressed-cover"].includes(BODY_MODE)) throw new Error(`--body-mode ${BODY_MODE}: stock | dressed | dressed-cover`);
const BODY_OUT = arg("body-out") ? resolve(arg("body-out")!) : null;
const GATHER = arg("gather") ? resolve(arg("gather")!) : null;
const SCALE = Number(arg("scale", "0.42"));
const BOX = { w: 1650, h: 1880, ox: 824, oy: 1294 };
const RW = Math.round(BOX.w * SCALE), RH = Math.round(BOX.h * SCALE), RX = Math.round(BOX.ox * SCALE), RY = Math.round(BOX.oy * SCALE);
const PAGE_MAX = 2048;
const DIAG = process.argv.includes("--diag");

type Clip = { id: string; rig: string; clip: string; frames: number; flip: boolean; gather?: boolean; swordWalk?: boolean };
const CLIPS: Clip[] = [
  { id: "idle", rig: "front-turn00-faceA", clip: "idle_weight_shift", frames: 96, flip: false },
  { id: "walkL", rig: "front-turn15-faceA", clip: "walk_in_place", frames: 28, flip: false },
  { id: "walkR", rig: "front-turn15-faceA-mirin", clip: "walk_in_place", frames: 28, flip: true },
  { id: "standL", rig: "front-turn15-faceA", clip: "idle_weight_shift", frames: 96, flip: false },
  { id: "standR", rig: "front-turn15-faceA-mirin", clip: "idle_weight_shift", frames: 96, flip: true }
];
if (GATHER) {
  const g = JSON.parse(readFileSync(join(GATHER, "gather-clips.json"), "utf8")) as { clips: Record<string, { anim: string; frames: number }> };
  for (const [id, c] of Object.entries(g.clips)) {
    CLIPS.push({ id: `${id}L`, rig: "front-turn15-faceA", clip: c.anim, frames: c.frames, flip: false, gather: true });
    CLIPS.push({ id: `${id}R`, rig: "front-turn15-faceA-mirin", clip: c.anim, frames: c.frames, flip: true, gather: true });
  }
}
if (process.argv.includes("--sword-walk")) {
  CLIPS.push({ id: "sword_walkL", rig: "front-turn15-faceA", clip: "sword_walk", frames: SWORD_WALK.frames, flip: false, swordWalk: true });
  CLIPS.push({ id: "sword_walkR", rig: "front-turn15-faceA-mirin", clip: "sword_walk", frames: SWORD_WALK.frames, flip: true, swordWalk: true });
}
const only = arg("clips")?.split(",");
const RUN = only ? CLIPS.filter((c) => only.includes(c.id)) : CLIPS;

const hash = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
const tmp = mkdtempSync(join(tmpdir(), "garment-layers-"));

/** The rig document to render: the rig itself, or (gather clips) a temp copy with the gather_* clips added. */
function docFor(dir: string, rig: string, gather: boolean, body = false, swordWalk = false): { document: string; atlas: string } {
  const dressed = body && BODY_MODE !== "stock", cover = BODY_MODE === "dressed-cover";
  const src = dressed ? OUTFIT : dir;
  const document = join(src, `${rig}.anim.json`), atlas = join(src, `${rig}.atlas.json`);
  if (!gather && !dressed && !swordWalk) return { document, atlas };
  const doc = JSON.parse(readFileSync(document, "utf8"));
  if (swordWalk) {
    doc.animations.sword_walk = swordWalkFrom(doc.animations.walk_in_place);
    if (!dressed) {
      const out = join(tmp, `${hash(src)}-${rig}-sword_walk.anim.json`);
      writeFileSync(out, JSON.stringify(doc));
      return { document: out, atlas };
    }
  }
  if (dressed) {
    // the garment's own contours go (dressed-cover: its mesh stays as an invisible coverer, see clearedAtlas)
    for (const by of Object.values(doc.skins.body.contours as Record<string, Record<string, unknown>>))
      for (const n of Object.keys(by)) if (n.startsWith(NAME)) delete by[n];
    for (const s of doc.slots as { name: string; attachment?: string }[]) {
      if (s.name.startsWith(NAME) && !cover) delete s.attachment;
    }
  }
  const bodyAtlas = dressed && cover ? clearedAtlas(src, rig) : atlas;
  if (!gather) {
    const out = join(tmp, `${hash(src)}-${rig}-body${swordWalk ? "-sword_walk" : ""}.anim.json`);
    writeFileSync(out, JSON.stringify(doc));
    return { document: out, atlas: bodyAtlas };
  }
  const gsrc = JSON.parse(readFileSync(join(GATHER!, `${rig}.anim.json`), "utf8"));
  if (hash(doc.bones) !== hash(gsrc.bones)) throw new Error(`${dir}/${rig}: bones differ from the gather rig; the clips cannot be copied`);
  for (const [k, v] of Object.entries(gsrc.animations as Record<string, { bones?: unknown; slots?: unknown }>)) {
    if (!k.startsWith("gather_")) continue;
    if (Object.keys(v).some((x) => !["duration", "loop", "fps", "bones"].includes(x))) throw new Error(`${k}: not a bone-only clip`);
    doc.animations[k] = v;
  }
  const out = join(tmp, `${hash(src)}-${rig}${dressed ? "-body" : ""}-gather.anim.json`);
  writeFileSync(out, JSON.stringify(doc));
  return { document: out, atlas: bodyAtlas };
}

/** A temp copy of the rig's atlas with every garment region (garment/<NAME>*) made fully transparent. */
const cleared = new Map<string, string>();
function clearedAtlas(dir: string, rig: string): string {
  const key = join(dir, rig);
  if (cleared.has(key)) return cleared.get(key)!;
  const at = JSON.parse(readFileSync(join(dir, `${rig}.atlas.json`), "utf8")) as { pages: { file: string; regions: Record<string, { x: number; y: number; width: number; height: number }> }[] };
  for (const pg of at.pages) {
    const img = decodePng(readFileSync(join(dir, pg.file)));
    for (const [path, r] of Object.entries(pg.regions)) {
      if (!path.startsWith(`garment/${NAME}`)) continue;
      for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) img.data[(y * img.width + x) * 4 + 3] = 0;
    }
    pg.file = `${hash(key)}-${pg.file}`;
    writeFileSync(join(tmp, pg.file), encodePng(img));
  }
  const out = join(tmp, `${hash(key)}-${rig}.atlas.json`);
  writeFileSync(out, JSON.stringify(at));
  cleared.set(key, out);
  return out;
}

async function render(dir: string, c: Clip, body = false): Promise<RgbaImage[]> {
  const r = await renderFrames({ ...docFor(dir, c.rig, !!c.gather, body, !!c.swordWalk), clip: c.clip, fps: 30, frames: c.frames, scale: SCALE, width: RW, height: RH, x: RX, y: RY, background: null });
  if (r.missingTextures.length) throw new Error(`${dir}/${c.rig}: missing textures ${r.missingTextures.join(", ")}`);
  return r.frames.map((f) => decodePng(f.png as Buffer));
}

/** L such that L over B = F (straight alpha, 8-bit); see the header. */
function derive(F: RgbaImage, B: RgbaImage): { L: RgbaImage; unrepresentable: number } {
  const n = F.width * F.height, L = new Uint8Array(n * 4);
  let unrepresentable = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const fa = F.data[o + 3]!, ba = B.data[o + 3]!;
    let same = true;
    for (let c = 0; c < 4; c++) if (Math.abs(F.data[o + c]! - B.data[o + c]!) > 1) { same = false; break; }
    if (same || (fa === 0 && ba === 0)) continue;
    if (ba === 0 || ba === 255 || fa < ba || (fa === ba && fa < 255)) {
      if (fa < ba || (ba > 0 && ba < 255 && fa === ba) || (ba === 255 && fa < 255)) {
        // best effort: the candidate (clear, F, F opaque) with the smallest composite error
        unrepresentable++;
        const f = F.data.subarray(o, o + 4), b = { width: 1, height: 1, data: B.data.subarray(o, o + 4) }, ref = { width: 1, height: 1, data: f };
        const cands = [new Uint8Array(4), Uint8Array.from(f), Uint8Array.from([f[0]!, f[1]!, f[2]!, 255])];
        const best = cands.map((d) => ({ d, e: compositeError({ width: 1, height: 1, data: d }, b, ref).max })).sort((x, y) => x.e - y.e)[0]!;
        L.set(best.d, o);
        continue;
      }
      L.set(F.data.subarray(o, o + 4), o);
      continue;
    }
    const af = fa / 255, ab = ba / 255, al = (af - ab) / (1 - ab);
    for (let c = 0; c < 3; c++) L[o + c] = Math.max(0, Math.min(255, Math.round((F.data[o + c]! * af - (1 - al) * B.data[o + c]! * ab) / al)));
    L[o + 3] = Math.round(al * 255);
  }
  return { L: { width: F.width, height: F.height, data: L }, unrepresentable };
}

/** Composite error of (top over bottom) vs ref: worst premultiplied channel / alpha difference and pixels over 1. */
function compositeError(top: RgbaImage, bottom: RgbaImage, ref: RgbaImage): { max: number; over1: number } {
  let max = 0, over1 = 0;
  for (let o = 0; o < ref.data.length; o += 4) {
    const ta = top.data[o + 3]! / 255, ba = bottom.data[o + 3]! / 255, ra = ref.data[o + 3]! / 255;
    const a = ta + (1 - ta) * ba;
    let e = Math.abs(Math.round(a * 255) - ref.data[o + 3]!);
    for (let c = 0; c < 3; c++) {
      const p = top.data[o + c]! * ta + bottom.data[o + c]! * (1 - ta) * ba; // premultiplied result
      const straight = a > 0 ? Math.round(p / a) : 0;
      e = Math.max(e, Math.abs(Math.round(straight * a) - Math.round(ref.data[o + c]! * ra)));
    }
    if (e > max) max = e;
    if (e > 1) over1++;
  }
  return { max, over1 };
}

const bbox = (im: RgbaImage) => {
  let x0 = im.width, y0 = im.height, x1 = -1, y1 = -1;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    if (im.data[(y * im.width + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
};

type Packed = { frameWidth: number; frameHeight: number; rootX: number; rootY: number; pages: string[]; frames: [number, number, number][]; unique: number; texels: number; rgbaBytes: number; crop: { x0: number; y0: number } };
/** copy-jacket-rig.mjs step 3: trim to the clip's union box (+1 px gutter), dedupe, pack pages <= PAGE_MAX. */
function pack(id: string, frames: RgbaImage[], dir: string): Packed {
  const boxes = frames.map(bbox).filter((b) => b.x1 >= 0);
  const u = boxes.length ? boxes.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) })) : { x0: 0, y0: 0, x1: 0, y1: 0 };
  if (u.x0 <= 0 || u.y0 <= 0 || u.x1 >= RW - 1 || u.y1 >= RH - 1) throw new Error(`${id}: figure touches the render edge`);
  const w = u.x1 - u.x0 + 2, h = u.y1 - u.y0 + 2;
  const unique: Uint8Array[] = [], index: number[] = [], seen = new Map<string, number>();
  for (const im of frames) {
    const crop = new Uint8Array(w * h * 4);
    for (let y = 0; y < h - 1; y++) crop.set(im.data.subarray(((u.y0 + y) * im.width + u.x0) * 4, ((u.y0 + y) * im.width + u.x1 + 1) * 4), y * w * 4);
    const key = createHash("sha1").update(crop).digest("hex");
    if (!seen.has(key)) { seen.set(key, unique.length); unique.push(crop); }
    index.push(seen.get(key)!);
  }
  const cols = Math.max(1, Math.floor(PAGE_MAX / w)), perPage = cols * Math.max(1, Math.floor(PAGE_MAX / h));
  const pages: string[] = [], cells: [number, number, number][] = [];
  let texels = 0, rgbaBytes = 0;
  for (let p = 0; p * perPage < unique.length; p++) {
    const count = Math.min(perPage, unique.length - p * perPage);
    const pw = Math.min(cols, count) * w, ph = Math.ceil(count / cols) * h;
    const data = new Uint8Array(pw * ph * 4);
    for (let k = 0; k < count; k++) {
      const cx = (k % cols) * w, cy = Math.floor(k / cols) * h, crop = unique[p * perPage + k]!;
      for (let y = 0; y < h; y++) data.set(crop.subarray(y * w * 4, (y + 1) * w * 4), ((cy + y) * pw + cx) * 4);
      cells.push([p, cx, cy]);
    }
    const file = `${id}-${p}.png`, buf = encodePng({ width: pw, height: ph, data });
    writeFileSync(join(dir, file), buf);
    texels += pw * ph; rgbaBytes += buf.length;
    pages.push(file);
  }
  return { frameWidth: w, frameHeight: h, rootX: RX - u.x0, rootY: RY - u.y0, pages, frames: index.map((i) => cells[i]!), unique: unique.length, texels, rgbaBytes, crop: { x0: u.x0, y0: u.y0 } };
}

const sharp = createRequire(resolve("../../apps/client/package.json"))("sharp");
/** copy-jacket-rig.mjs step 4: 8-bit palette PNG in place; returns its bytes. */
async function quantise(file: string): Promise<number> {
  const buf: Buffer = await sharp(file).png({ palette: true, colours: 256, quality: 100, dither: 1, effort: 10, compressionLevel: 9 }).toBuffer();
  writeFileSync(file, buf);
  return buf.length;
}
/** The full-size frame i of a packed (8-bit) clip, read back from its page. */
async function unpack(dir: string, p: Packed, i: number, cache: Map<string, RgbaImage>): Promise<RgbaImage> {
  const [page, cx, cy] = p.frames[i]!;
  const file = join(dir, p.pages[page]!);
  if (!cache.has(file)) {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    cache.set(file, { width: info.width, height: info.height, data: new Uint8Array(data) });
  }
  const pg = cache.get(file)!, out = new Uint8Array(RW * RH * 4);
  for (let y = 0; y < p.frameHeight - 1; y++) out.set(pg.data.subarray(((cy + y) * pg.width + cx) * 4, ((cy + y) * pg.width + cx + p.frameWidth - 1) * 4), ((p.crop.y0 + y) * RW + p.crop.x0) * 4);
  return { width: RW, height: RH, data: out };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT).filter((f) => f.endsWith(".png") && !f.startsWith("diag-"))) rmSync(join(OUT, f));
  if (BODY_OUT) mkdirSync(BODY_OUT, { recursive: true });
  const fullDir = join(tmp, "full"), bodyDir = BODY_OUT ?? join(tmp, "body");
  mkdirSync(fullDir, { recursive: true }); mkdirSync(bodyDir, { recursive: true });
  const manifest: Record<string, unknown> = { format: "garment-layers@1", item: NAME, outfit: OUTFIT, body: BODY, bodyMode: BODY_MODE, scale: SCALE, fps: 30, drawOver: "body sheets (same clip ids); align by rootX/rootY", clips: {} };
  const report: Record<string, unknown> = { item: NAME, scale: SCALE, bodyMode: BODY_MODE, clips: {} };
  const bodyClips: Record<string, unknown> = {};
  const tot = { layer: { rgba: 0, q: 0, texels: 0 }, body: { rgba: 0, q: 0, texels: 0 }, full: { rgba: 0, q: 0, texels: 0 }, gatherLayer: { rgba: 0, q: 0, texels: 0 } };
  for (const c of RUN) {
    const t0 = Date.now();
    const F = await render(OUTFIT, c), B = await render(BODY, c, true);
    let unrep = 0, rgbaErr = { max: 0, over1: 0 }, worst = 0, worstN = -1;
    const L = F.map((f, i) => { const d = derive(f, B[i]!); unrep += d.unrepresentable; return d.L; });
    L.forEach((l, i) => { const e = compositeError(l, B[i]!, F[i]!); if (e.over1 > worstN) { worstN = e.over1; worst = i; } rgbaErr = { max: Math.max(rgbaErr.max, e.max), over1: rgbaErr.over1 + e.over1 }; });
    if (DIAG) {
      // frame 0: F, B, L and the error mask (red = composite error > 1) at x3 in a row, for the review
      const w = worst, im = [F[w]!, B[w]!, L[w]!], W = RW * 4, data = new Uint8Array(W * RH * 4);
      im.forEach((x, k) => { for (let y = 0; y < RH; y++) data.set(x.data.subarray(y * RW * 4, (y + 1) * RW * 4), (y * W + k * RW) * 4); });
      for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
        const one = (img: RgbaImage) => ({ width: 1, height: 1, data: img.data.subarray((y * RW + x) * 4, (y * RW + x) * 4 + 4) });
        const e = compositeError(one(L[w]!), one(B[w]!), one(F[w]!)).max;
        const o = (y * W + 3 * RW + x) * 4;
        if (e > 1) data.set([255, 0, 0, 255], o); else if (F[w]!.data[(y * RW + x) * 4 + 3]! > 0) data.set([90, 90, 90, 255], o);
      }
      writeFileSync(join(OUT, `diag-${c.id}-f${w}-full-body-layer-err.png`), encodePng({ width: W, height: RH, data }));
    }
    const pl = pack(c.id, L, OUT), pb = pack(c.id, B, bodyDir), pf = pack(c.id, F, fullDir);
    const q = { layer: 0, body: 0, full: 0 };
    for (const f of pl.pages) q.layer += await quantise(join(OUT, f));
    for (const f of pb.pages) q.body += await quantise(join(bodyDir, f));
    for (const f of pf.pages) q.full += await quantise(join(fullDir, f));
    // 8-bit check: q(L) over q(B) vs F, next to q(F) vs F (what the 8-bit full-outfit sheet already loses)
    const cache = new Map<string, RgbaImage>(), clear: RgbaImage = { width: RW, height: RH, data: new Uint8Array(RW * RH * 4) };
    let q8 = { max: 0, over1: 0 }, f8 = { max: 0, over1: 0 };
    for (let i = 0; i < F.length; i++) {
      const e = compositeError(await unpack(OUT, pl, i, cache), await unpack(bodyDir, pb, i, cache), F[i]!);
      const g = compositeError(await unpack(fullDir, pf, i, cache), clear, F[i]!);
      q8 = { max: Math.max(q8.max, e.max), over1: q8.over1 + e.over1 }; f8 = { max: Math.max(f8.max, g.max), over1: f8.over1 + g.over1 };
    }
    const { crop: _c, unique, texels, rgbaBytes, ...m } = pl;
    (manifest.clips as Record<string, unknown>)[c.id] = { rig: c.rig, clip: c.clip, flip: c.flip, ...m };
    const { crop: _bc, unique: _bu, texels: _bt, rgbaBytes: _br, ...bm } = pb;
    bodyClips[c.id] = { rig: c.rig, clip: c.clip, flip: c.flip, ...bm };
    const mb = (b: number) => Number((b / 1048576).toFixed(3));
    (report.clips as Record<string, unknown>)[c.id] = {
      frames: F.length, unique: { layer: unique, body: pb.unique, full: pf.unique },
      frame: { layer: `${pl.frameWidth}x${pl.frameHeight}`, body: `${pb.frameWidth}x${pb.frameHeight}` },
      pngMB8bit: { layer: mb(q.layer), body: mb(q.body), full: mb(q.full) },
      gpuMB: { layer: mb(texels * 4), body: mb(pb.texels * 4), full: mb(pf.texels * 4) },
      composite: { unrepresentablePx: unrep, rgba: rgbaErr, eightBit: q8, fullSheet8bitBaseline: f8 },
      seconds: Math.round((Date.now() - t0) / 1000)
    };
    const k = c.gather ? "gatherLayer" : "layer";
    tot[k].rgba += rgbaBytes; tot[k].q += q.layer; tot[k].texels += texels;
    tot.body.rgba += pb.rgbaBytes; tot.body.q += q.body; tot.body.texels += pb.texels;
    tot.full.rgba += pf.rgbaBytes; tot.full.q += q.full; tot.full.texels += pf.texels;
    console.log(`${c.id}: ${F.length} f, layer ${unique} unique ${pl.frameWidth}x${pl.frameHeight} ${mb(q.layer)} MB 8-bit / ${mb(texels * 4)} MB GPU; unrepresentable ${unrep} px; rgba composite max ${rgbaErr.max} (${rgbaErr.over1} px > 1); 8-bit max ${q8.max} (baseline full 8-bit ${f8.max})`);
  }
  const mb = (b: number) => Number((b / 1048576).toFixed(2));
  report.totals = Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, { pngMB_rgba: mb(v.rgba), pngMB_8bit: mb(v.q), gpuMB_rgba8: mb(v.texels * 4), gpuMB_withMips: mb(v.texels * 4 * 4 / 3) }]));
  report.note = "layer / gatherLayer = this item's garment layers; body = the shared bare-stock sheets (paid once); full = the same clips as full-outfit sheets (the per-outfit alternative). 8-bit = sharp palette PNG (download); the GPU holds RGBA8.";
  writeFileSync(join(OUT, `${NAME}-layers.json`), `${JSON.stringify(manifest)}\n`);
  writeFileSync(join(OUT, "layers-report.json"), `${JSON.stringify(report, null, 1)}\n`);
  if (BODY_OUT) writeFileSync(join(BODY_OUT, "body-sheets.json"), `${JSON.stringify({ format: "body-sheets@1", scale: SCALE, fps: 30, clips: bodyClips })}\n`);
  console.log(JSON.stringify(report.totals));
  rmSync(tmp, { recursive: true, force: true });
}
main().catch((e) => { console.error(e); rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
