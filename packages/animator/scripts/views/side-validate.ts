/*
 * Atlas Animator multi-view, phase 2b: the combined validator (legsBody's, tears on) over a built rig, issues listed.
 *   npx tsx scripts/views/side-validate.ts <rig.anim.json> [--body <body.json>]   (atlas next to it)
 * With --body, the far parts' painted-reveal gates (tools/surface/fullBodyGates.ts) run on the painted rig and a failed
 * one counts as an error (`paintedReveal`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readPng } from "../../src/tools/png.js";
import { atlasPackSchema } from "../../src/core/atlasPack.js";
import { texturesFromAtlas, validateRig } from "../../src/tools/validate.js";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { loadFullBody, partSlots } from "../../src/tools/surface/fullBody.js";
import { farRevealGates } from "../../src/tools/surface/fullBodyGates.js";

const [rig] = process.argv.slice(2) as [string];
const raw = JSON.parse(readFileSync(rig, "utf8"));
const atlasPath = rig.replace(/(\.bare)?\.anim\.json$/, ".atlas.json");
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
const pages = new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(atlasPath), p.file))]));
const textures = texturesFromAtlas(pack, pages);
const v = validateRig(raw, { textures, tears: true });
const errs = v.issues.filter((i) => i.severity === "error");
const bi = process.argv.indexOf("--body");
if (bi > 0) {
  const body = loadFullBody(process.argv[bi + 1] as string);
  const sheet = body.parts.find((p) => p.preset.assembly)?.preset.assembly?.sheets[0];
  const slotNames = new Set((raw.slots as { name: string }[]).map((s) => s.name));
  const parts = body.parts.map((p) => ({ spec: p.spec, preset: p.preset, slots: partSlots(p.preset).filter((s) => slotNames.has(s) && s !== sheet?.slot) }));
  for (const g of farRevealGates(loadAnimDocument(raw), textures, parts, `${sheet?.slot}/${sheet?.attachment}`)) {
    console.log(`${g.ok ? "PASS" : "FAIL"} ${g.gate}: ${g.detail}`);
    if (!g.ok) errs.push({ check: "paintedReveal", severity: "error", message: `${g.gate}: ${g.detail}` } as (typeof errs)[number]);
  }
}
console.log(`errors ${errs.length}`);
for (const i of errs) console.log(`${i.check}: ${i.message}`);
