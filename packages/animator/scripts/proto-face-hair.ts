// PROTOTYPE ONLY (sword chop round, 2026-10-17): puts the live game's face and hair art on a rig as rigid regions on
// the head bone, so attacks are judged on a full character instead of a faceless mannequin. Not part of any template.
// The live player-appearance PNGs share the 1086 x 1448 template canvas with the rig, so each layer is cropped to its
// opaque box and placed at that canvas box, upright at setup like the head region.
//   npx tsx scripts/proto-face-hair.ts <rig.anim.json> <out dir> [game repo]
// Writes <out dir>/<stem>-face.anim.json + atlas. Layers (live defaults): eyes brown-eyes, hair
// soldier-crop-hair (the hair the live reference render uses).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { atlasPackSchema } from "../src/core/atlasPack.js";
import { loadAnimDocument } from "../src/core/formatLoader.js";
import { Skeleton } from "../src/core/skeleton.js";
import { opaqueOutline } from "../src/tools/bodyContours.js";
import { createImage, type RgbaImage } from "../src/tools/image.js";
import { readPng } from "../src/tools/png.js";
import { writeAtlas } from "../src/tools/surface/output.js";
import { texturesFromAtlas } from "../src/tools/validate.js";

const [rigPath, outDir, gameArg] = process.argv.slice(2) as [string, string, string?];
const GAME = resolve(gameArg ?? "C:/Users/dev/Documents/game");
const ART = join(GAME, "packages/player-renderer/src/assets/player-appearance");
// [slot, files, canvas dy]: the live renderer moves the face layers by its face anchor (catalog body pose), not by the
// shared canvas; the dy values place them as the live reference render shows them on this head (measured on
// live-reference/keys key0: eyes 161 canvas px above the tank collar, hair top 522 above it)
const LAYERS: [string, string[], number][] = [
  ["proto_face", ["eyes/browneyes.png"], -74],
  ["proto_hair", ["hair/soldiercrophairmale.png"], -138]
];

const doc = JSON.parse(readFileSync(rigPath, "utf8"));
const stem = basename(rigPath).replace(/\.anim\.json$/, "");
const atlasPath = rigPath.replace(/\.anim\.json$/, ".atlas.json");
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
const tex = texturesFromAtlas(pack, new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(atlasPath), p.file))] as [string, RgbaImage])));
const { width: W, height: H, originX: ox, originY: oy } = doc.canvas;
const sk = new Skeleton(loadAnimDocument(doc));
sk.setToSetupPose();
sk.updateWorldTransform("none");
const head = sk.findBone("head")!;

const skin = doc.skins[Object.keys(doc.skins)[0] as string];
const headAt = doc.slots.findIndex((s: { name: string }) => s.name === "head");
let insert = headAt + 1;
for (const [slot, files, dy] of LAYERS) {
  // composite the layer's canvases, crop to the opaque box
  const canvas = createImage(W, H);
  for (const f of files) {
    const im = readPng(join(ART, f));
    if (im.width !== W || im.height !== H) throw new Error(`${f} is ${im.width}x${im.height}, the rig canvas is ${W}x${H}`);
    for (let i = 0; i < W * H; i++) {
      const a = (im.data[i * 4 + 3] as number) / 255;
      if (!a) continue;
      for (let c = 0; c < 3; c++) canvas.data[i * 4 + c] = Math.round((im.data[i * 4 + c] as number) * a + (canvas.data[i * 4 + c] as number) * (1 - a));
      canvas.data[i * 4 + 3] = Math.round(255 * (a + ((canvas.data[i * 4 + 3] as number) / 255) * (1 - a)));
    }
  }
  let [x0, y0, x1, y1] = [W, H, 0, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((canvas.data[(y * W + x) * 4 + 3] as number) > 0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
  const crop = createImage(x1 - x0, y1 - y0);
  for (let y = y0; y < y1; y++) crop.data.set(canvas.data.subarray((y * W + x0) * 4, (y * W + x1) * 4), ((y - y0) * crop.width) * 4);
  const path = `proto/${slot}`;
  tex.set(path, crop);
  const o = { x: 0, y: 0 };
  head.worldToLocal((x0 + x1) / 2 - ox, (y0 + y1) / 2 + dy - oy, o);
  const opaque = opaqueOutline(crop);
  skin.attachments[slot] = { [slot]: { type: "region", path, x: +o.x.toFixed(4), y: +o.y.toFixed(4), rotation: skin.attachments.head.head.rotation, width: crop.width, height: crop.height, ...(opaque ? { opaque } : {}) } };
  doc.slots.splice(insert++, 0, { name: slot, bone: "head", attachment: slot });
}
// dark shorts (prototype stand-in for the live black pants): every shorts texture recoloured to a dark charcoal,
// keeping the art's shading (luminance scaled into a dark band)
for (const att of Object.values((skin.attachments.shorts ?? {}) as Record<string, { path?: string }>)) {
  const t = att.path ? tex.get(att.path) : undefined;
  if (!t) continue;
  const d = createImage(t.width, t.height);
  d.data.set(t.data);
  for (let i = 0; i < t.width * t.height; i++) {
    const l = 0.3 * (t.data[i * 4] as number) + 0.59 * (t.data[i * 4 + 1] as number) + 0.11 * (t.data[i * 4 + 2] as number);
    const v = Math.round(30 + (l / 255) * 42);
    d.data[i * 4] = v; d.data[i * 4 + 1] = v; d.data[i * 4 + 2] = v + 3;
  }
  tex.set(att.path as string, d);
}
doc.name = `${doc.name}-face`;
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${stem}-face.anim.json`), `${JSON.stringify(doc, null, 1)}\n`);
writeAtlas(tex, outDir, `${stem}-face`);
console.log("wrote", join(outDir, `${stem}-face.anim.json`));
