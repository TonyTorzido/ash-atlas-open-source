/*
 * Atlas Animator multi-view, phase 2b evidence (docs/plans/atlas-animator-views.md): attaches the shared head to a view
 * rig. The head, face and hair regions of a source rig (the front rig with its prototype face) are copied onto the view
 * rig's `head` bone with the same bone-local placement, drawn last (over the body), textures from the source atlas.
 * Until a turned head is drawn, the front head stands in on the side rig (design decision, session 4).
 *   npx tsx scripts/views/side-head.ts <view rig.anim.json> <head source rig.anim.json> <out dir>
 * Writes <out dir>/<view stem>-head.anim.json + atlas.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atlasPackSchema } from "../../src/core/atlasPack.js";
import { readPng } from "../../src/tools/png.js";
import { writeAtlas } from "../../src/tools/surface/output.js";
import { texturesFromAtlas } from "../../src/tools/validate.js";
import type { RgbaImage } from "../../src/tools/image.js";

const [viewPath, srcPath, outDir] = process.argv.slice(2) as [string, string, string];
const load = (p: string) => {
  const doc = JSON.parse(readFileSync(p, "utf8"));
  const atlas = p.replace(/(\.bare)?\.anim\.json$/, ".atlas.json");
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlas, "utf8")));
  const tex = texturesFromAtlas(pack, new Map(pack.pages.map((pg) => [pg.file, readPng(join(dirname(atlas), pg.file))] as [string, RgbaImage])));
  return { doc, tex };
};
const view = load(viewPath);
const src = load(srcPath);
if (!view.doc.bones.some((b: { name: string }) => b.name === "head")) throw new Error("view rig has no head bone");
const srcSkin = src.doc.skins[Object.keys(src.doc.skins)[0] as string];
const viewSkin = view.doc.skins[Object.keys(view.doc.skins)[0] as string];
const headSlots = (src.doc.slots as { name: string; bone: string }[]).filter((s) => s.bone === "head");
if (!headSlots.length) throw new Error("head source rig has no slots on the head bone");
for (const s of headSlots) {
  if ((view.doc.slots as { name: string }[]).some((v) => v.name === s.name)) throw new Error(`view rig already has slot '${s.name}'`);
  view.doc.slots.push(structuredClone(s));
  viewSkin.attachments[s.name] = structuredClone(srcSkin.attachments[s.name]);
  for (const att of Object.values(viewSkin.attachments[s.name] as Record<string, { path?: string }>)) {
    if (!att.path) continue;
    const t = src.tex.get(att.path);
    if (!t) throw new Error(`no texture '${att.path}' in the head source atlas`);
    view.tex.set(att.path, t);
  }
}
const stem = basename(viewPath).replace(/\.anim\.json$/, "");
view.doc.name = `${view.doc.name}-head`;
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${stem}-head.anim.json`), `${JSON.stringify(view.doc)}\n`);
writeAtlas(view.tex, outDir, `${stem}-head`);
console.log("wrote", join(outDir, `${stem}-head.anim.json`), headSlots.map((s) => s.name).join(", "));
