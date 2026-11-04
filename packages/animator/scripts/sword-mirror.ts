// Weapon-hand swap test: the sword clips and the held spec mirrored onto the screen-RIGHT hand (hand_r) of the same
// bilateral rig (mirror line = the canvas origin x, 542). Owner direction 2026-10-17: the cross-body chop lands on the
// side opposite the sword hand, so the sword hand is picked from where the target is; this proves the clips mirror.
// Run from packages/animator: npx tsx scripts/sword-mirror.ts <held.png>
// Writes fixtures/held-mirror/{sword-r.held.json, held-r.png, sword-*.json}; then
//   npx tsx src/cli/heldImport.ts <body rig> fixtures/held-mirror/held-r.png <out> --held fixtures/held-mirror/sword-r.held.json --clips <the three>
// Mirror rule (as tools/mirrorRig.ts): bone names swap _l <-> _r, every rotation delta negates (left-arm inward
// elbow folds are negative, right-arm ones positive, so inward stays inward), pelvis x translate negates; the grip
// angle negates (135 -> -135), and so do the clips' grip keys and grip.at / the art reflect about x = 542.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readPng, writePng } from "../src/tools/png.js";
import { mirrorImage } from "../src/tools/hardPlate.js";

const AXIS = 542;
const OUT = "fixtures/held-mirror";
const swap = (n: string) => (n.endsWith("_l") ? `${n.slice(0, -2)}_r` : n.endsWith("_r") ? `${n.slice(0, -2)}_l` : n);
mkdirSync(OUT, { recursive: true });

const spec = JSON.parse(readFileSync("fixtures/garments/sword.held.json", "utf8"));
spec.hand = { bone: "hand_r", fistSlot: "hand_r" };
spec.grip = { ...spec.grip, at: [2 * AXIS - spec.grip.at[0], spec.grip.at[1]], angle: -spec.grip.angle };
spec.source = { note: `Mirror of sword.held.json onto hand_r (scripts/sword-mirror.ts): grip.at and the art reflected about x = ${AXIS}, grip angle negated.` };
writeFileSync(`${OUT}/sword-r.held.json`, `${JSON.stringify(spec, null, 1)}\n`);

const art = process.argv[2];
if (!art) throw new Error("usage: sword-mirror.ts <held.png>");
writePng(`${OUT}/held-r.png`, mirrorImage(readPng(art), AXIS));

for (const f of ["sword-ready", "sword-slash"]) {
  const c = JSON.parse(readFileSync(`fixtures/clips/${f}.json`, "utf8"));
  const bones: Record<string, any> = {};
  for (const [name, tl] of Object.entries(c.clip.bones as Record<string, any>)) {
    const out: Record<string, any> = {};
    if (tl.rotate) out.rotate = tl.rotate.map((k: any) => ({ ...k, value: -k.value }));
    if (tl.translate) out.translate = tl.translate.map((k: any) => ({ ...k, x: -k.x }));
    if (tl.scale) out.scale = tl.scale; // the chest breath scale is symmetric
    bones[swap(name)] = out;
  }
  c.clip.bones = bones;
  // grip keys turn the item in the fist; mirrored, the turn goes the other way round
  if (c.grip) c.grip = c.grip.map((k: any) => ({ ...k, value: -k.value }));
  c.about = `Mirror of ${f}.json onto the screen-right hand (scripts/sword-mirror.ts). ${c.about}`;
  writeFileSync(`${OUT}/${f}.json`, `${JSON.stringify(c, null, 1)}\n`);
}
console.log("wrote mirror fixtures");
