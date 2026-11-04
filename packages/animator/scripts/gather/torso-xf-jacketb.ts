// Jacket B torso transforms (2026-10-20, back sword: packages/animator/README.md "Sheathed on the back").
// Plays the body clips the client ships (scripts/copy-jacket-rig.mjs CLIPS) through the AnimationState like the
// render and the sword_walk grip export (gather-clips-jacketb.ts), and writes the chest bone's per-frame transform
// relative to its setup pose:
//   npx tsx scripts/gather/torso-xf-jacketb.ts <out json>      (run from packages/animator; needs rigs/jacketb)
//   clips[id] = [[a, b, c, d, tx, ty], ...]: D_f = W_f * W_setup^-1, canvas px from the skeleton origin, y down.
// A point placed on the setup pose's torso (canvas px) is at D_f(point) on frame f, so the client attaches the back
// sword with one fixed offset per view and it rides the walk bob and the idle breath (rotation and chest scale too).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnimationState, AnimationStateData } from "../../src/core/animationState.js";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { Skeleton } from "../../src/core/skeleton.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const IN = "rigs/jacketb";
const OUT = process.argv[2];
if (!OUT) throw new Error("usage: torso-xf-jacketb.ts <out json>");
const F = 1 / 30;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
// Mirrors scripts/copy-jacket-rig.mjs CLIPS (same rig, clip and frame count per sheet).
const CLIPS = [
  { id: "idle", rig: "front-turn00-faceA", clip: "idle_weight_shift", frames: 96 },
  { id: "walkL", rig: "front-turn15-faceA", clip: "walk_in_place", frames: 28 },
  { id: "walkR", rig: "front-turn15-faceA-mirin", clip: "walk_in_place", frames: 28 },
  { id: "standL", rig: "front-turn15-faceA", clip: "idle_weight_shift", frames: 96 },
  { id: "standR", rig: "front-turn15-faceA-mirin", clip: "idle_weight_shift", frames: 96 }
];

type M = { a: number; b: number; c: number; d: number; x: number; y: number };
const world = (sk: Skeleton): M => { const w = sk.findBone("chest")!.world as any; return { a: w.a, b: w.b, c: w.c, d: w.d, x: w.x, y: w.y }; };
const mul = (p: M, q: M): M => ({
  a: p.a * q.a + p.b * q.c, b: p.a * q.b + p.b * q.d, c: p.c * q.a + p.d * q.c, d: p.c * q.b + p.d * q.d,
  x: p.a * q.x + p.b * q.y + p.x, y: p.c * q.x + p.d * q.y + p.y
});
const inv = (m: M): M => {
  const det = m.a * m.d - m.b * m.c;
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det;
  return { a, b, c, d, x: -(a * m.x + b * m.y), y: -(c * m.x + d * m.y) };
};

const out: Record<string, number[][]> = {};
const setupChest: Record<string, number[]> = {};
for (const c of CLIPS) {
  const doc = JSON.parse(readFileSync(join(IN, `${c.rig}.anim.json`), "utf8"));
  const data = loadAnimDocument(doc);
  const sk = new Skeleton(data);
  sk.setActiveSkins([Object.keys(doc.skins)[0] as string]);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  const rest = inv(world(sk));
  setupChest[c.rig] = [r4(world(sk).x), r4(world(sk).y)];
  const st = new AnimationState(new AnimationStateData(data));
  st.setAnimation(0, c.clip, { loop: true });
  const rows: number[][] = [];
  for (let f = 0; f < c.frames; f++) {
    if (f > 0) st.update(F);
    else st.update(1e-4);
    sk.setToSetupPose();
    st.apply(sk);
    sk.updateWorldTransform("none");
    const m = mul(world(sk), rest);
    rows.push([r4(m.a), r4(m.b), r4(m.c), r4(m.d), r4(m.x), r4(m.y)]);
  }
  out[c.id] = rows;
  const ty = rows.map((r) => r[5]!);
  console.log(`${c.id}: ${c.frames} f, chest dy ${Math.min(...ty).toFixed(1)}..${Math.max(...ty).toFixed(1)} px`);
}
writeFileSync(OUT, `${JSON.stringify({ format: "jacket-torso@1", bone: "chest", setupChest, clips: out })}\n`);
