/*
 * Atlas Animator multi-view: the turned side head (scripts/views/side_head.py polish -> layers/head.turned.png, face and
 * hair drawn turned with the body) replaces the shared front head that stood in on the side rig. The `head` slot's
 * region keeps its slot, bone, draw order and rotation (rigid on the head bone); its texture becomes the turned art
 * cropped to its opaque box and placed at that canvas box at the setup pose (as scripts/proto-face-hair.ts places
 * layers). Rewrites the rig in place (anim, bare anim when present, atlas).
 *   npx tsx scripts/views/side-head-turned.ts <rig.anim.json> <head canvas png>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atlasPackSchema } from "../../src/core/atlasPack.js";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { Skeleton } from "../../src/core/skeleton.js";
import { opaqueOutline } from "../../src/tools/bodyContours.js";
import { createImage, type RgbaImage } from "../../src/tools/image.js";
import { readPng } from "../../src/tools/png.js";
import { writeAtlas } from "../../src/tools/surface/output.js";
import { texturesFromAtlas } from "../../src/tools/validate.js";

const [rigPath, artPath] = process.argv.slice(2) as [string, string];
if (!rigPath || !artPath) throw new Error("usage: side-head-turned.ts <rig.anim.json> <head canvas png>");
const atlasPath = rigPath.replace(/\.anim\.json$/, ".atlas.json");
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
const tex = texturesFromAtlas(pack, new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(atlasPath), p.file))] as [string, RgbaImage])));
const doc = JSON.parse(readFileSync(rigPath, "utf8"));
const { width: W, height: H, originX: ox, originY: oy } = doc.canvas;
const art = readPng(artPath);
if (art.width !== W || art.height !== H) throw new Error(`${artPath} is ${art.width}x${art.height}, the rig canvas is ${W}x${H}`);

let [x0, y0, x1, y1] = [W, H, 0, 0];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((art.data[(y * W + x) * 4 + 3] as number) > 0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
const crop = createImage(x1 - x0, y1 - y0);
for (let y = y0; y < y1; y++) crop.data.set(art.data.subarray((y * W + x0) * 4, (y * W + x1) * 4), (y - y0) * crop.width * 4);

function swap(path: string) {
  const d = JSON.parse(readFileSync(path, "utf8"));
  const sk = new Skeleton(loadAnimDocument(d));
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  const head = sk.findBone("head");
  if (!head) throw new Error(`${path}: no head bone`);
  const skin = d.skins[Object.keys(d.skins)[0] as string];
  const att = skin.attachments.head?.head;
  if (!att || att.type !== "region") throw new Error(`${path}: no head region on the head slot`);
  const o = { x: 0, y: 0 };
  head.worldToLocal((x0 + x1) / 2 - ox, (y0 + y1) / 2 - oy, o);
  const opaque = opaqueOutline(crop);
  skin.attachments.head.head = { type: "region", path: att.path, x: +o.x.toFixed(4), y: +o.y.toFixed(4), rotation: att.rotation, width: crop.width, height: crop.height, ...(opaque ? { opaque } : {}) };
  writeFileSync(path, `${JSON.stringify(d)}\n`);
  return att.path as string;
}
const texPath = swap(rigPath);
const bare = rigPath.replace(/\.anim\.json$/, ".bare.anim.json");
if (existsSync(bare)) swap(bare);
tex.set(texPath, crop);
writeAtlas(tex, dirname(atlasPath), basename(atlasPath).replace(/\.atlas\.json$/, ""));
console.log(JSON.stringify({ rig: rigPath, texture: texPath, box: [x0, y0, x1, y1], size: [crop.width, crop.height] }));
