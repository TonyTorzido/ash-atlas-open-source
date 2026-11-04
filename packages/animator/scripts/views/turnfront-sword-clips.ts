// PROTOTYPE (turned-front preview, 2026-10-19): a sword chop toward the facing side on the 15-deg turned Jacket B rig
// (docs/plans/atlas-animator-demos/views/turned-front/rig/jacketb-turn15, made by scripts/views/turnfront.py from the
// approved front Jacket B rig). The live sword art (attacks/sword-chop/art/sword-live-held.png) in the FAR hand (hand_l,
// the screen-left arm, on the facing side), so the arm never crosses the chest. Writes
// fixtures/garments/sword-turnfront.held.json (sword-live spec, grip.at = the turned rig's left fist centre, grip.angle
// solved so the ready blade is 45 deg up and out), fixtures/clips-proto/turnfront-sword-ready.json and
// turnfront-sword-chop.json. Run from packages/animator:
//   npx tsx scripts/views/turnfront-sword-clips.ts [<turned rig.anim.json>]
// then the held import (see the turned-front README). Values are offsets from the setup pose (degrees; root / pelvis
// translate in canvas px, y down). Rig limits that shape it (front shoulder-legs rig): upper arm raise <= 105 deg
// from down, elbow fold 0..70, chest lean +-10, thigh -6..8.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { Skeleton } from "../../src/core/skeleton.js";
import { AnimationState, AnimationStateData } from "../../src/core/animationState.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Pose = Record<string, number>;
const BONE: Record<string, [string, "rotate" | "tx" | "ty" | "sx" | "sy"]> = {
  rx: ["root", "tx"], ry: ["root", "ty"],
  px: ["pelvis", "tx"], py: ["pelvis", "ty"], csx: ["chest", "sx"], csy: ["chest", "sy"], chest: ["chest", "rotate"], neck: ["neck", "rotate"], head: ["head", "rotate"],
  ua: ["upper_arm_l", "rotate"], fa: ["forearm_l", "rotate"], uaR: ["upper_arm_r", "rotate"], faR: ["forearm_r", "rotate"],
  thL: ["thigh_l", "rotate"], thR: ["thigh_r", "rotate"]
};
const CH = Object.keys(BONE);
const F = 1 / 30;
const r6 = (t: number) => Math.round(t * 1e6) / 1e6;
const r3 = (t: number) => Math.round(t * 1e3) / 1e3;
type Curve = "linear" | "stepped" | [number, number, number, number];
type Key = { f: number; p: Pose; curve?: Curve };

function clipFrom(keys: Key[], frames: number, loop: boolean) {
  const bones: Record<string, any> = {};
  for (const ch of CH) {
    const [bone, kind] = BONE[ch] as [string, string];
    bones[bone] ??= {};
    const tl = kind === "rotate" ? "rotate" : kind === "sx" || kind === "sy" ? "scale" : "translate";
    bones[bone][tl] ??= new Map<number, any>();
    for (const k of keys) {
      const t = r6(k.f * F);
      const m: Map<number, any> = bones[bone][tl];
      const e = m.get(t) ?? (tl === "rotate" ? { time: t, value: 0 } : tl === "scale" ? { time: t, x: 1, y: 1 } : { time: t, x: 0, y: 0 });
      const v = k.p[ch] ?? (tl === "scale" ? 1 : 0);
      if (kind === "rotate") e.value = v; else if (kind === "tx" || kind === "sx") e.x = v; else e.y = v;
      e.curve = k.curve ?? "linear";
      m.set(t, e);
    }
  }
  for (const [name, b] of Object.entries(bones)) {
    for (const tl of Object.keys(b)) {
      b[tl] = [...(b[tl] as Map<number, any>).values()].sort((x, y) => x.time - y.time);
      const rest = tl === "scale" ? 1 : 0;
      if ((b[tl] as any[]).every((k) => (k.value ?? 0) === 0 && (k.x ?? rest) === rest && (k.y ?? rest) === rest)) delete b[tl];
    }
    if (!Object.keys(b).length) delete bones[name];
  }
  return { duration: r6(frames * F), loop, fps: 30, bones };
}

const EASE_IO: Curve = [0.45, 0, 0.55, 1];
const EASE_OUT: Curve = [0.2, 0.7, 0.4, 1];
const RIG = process.argv[2] ?? "../../docs/plans/atlas-animator-demos/views/turned-front/rig/jacketb-turn15.anim.json";
const rigDoc = JSON.parse(readFileSync(RIG, "utf8"));
const held = JSON.parse(readFileSync("fixtures/garments/sword-live.held.json", "utf8"));

function posed(p: Pose): Skeleton {
  const doc = structuredClone(rigDoc);
  doc.animations = { probe: clipFrom([{ f: 0, p }, { f: 1, p }], 1, false) };
  const loaded = loadAnimDocument(doc);
  const sk = new Skeleton(loaded);
  sk.setActiveSkins([Object.keys(doc.skins)[0] as string]);
  sk.setToSetupPose();
  const st = new AnimationState(new AnimationStateData(loaded));
  st.setAnimation(0, "probe", { loop: false });
  st.update(0);
  st.apply(sk);
  sk.updateWorldTransform("none");
  return sk;
}
const ang = (sk: Skeleton, n: string) => { const w = sk.findBone(n)!.world; return (Math.atan2(w.c, w.a) * 180) / Math.PI; };
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const DEG = Math.PI / 180;
/** Canvas direction (deg, y down) of a blade `alpha` deg from straight up toward the facing side (screen-left). */
const bladeCanvas = (alpha: number) => (Math.atan2(-Math.cos(alpha * DEG), -Math.sin(alpha * DEG)) * 180) / Math.PI;

/** Sword (far, _l) upper arm `armL` deg from straight down toward screen-left, elbow fold `foldL` (bends the forearm
 *  up and inward); near arm `armR` deg out to screen-right, fold `foldR`. */
function pose(o: { armL: number; foldL: number; armR: number; foldR: number; body: Pose }): Pose {
  const p: Pose = { ...o.body, ua: 0, fa: o.foldL, uaR: 0, faR: -o.foldR };
  for (let i = 0; i < 3; i++) {
    const sk = posed(p);
    p.ua = (p.ua as number) + wrap(90 + o.armL - ang(sk, "upper_arm_l"));
    p.uaR = (p.uaR as number) + wrap(90 - o.armR - ang(sk, "upper_arm_r"));
  }
  for (const k of Object.keys(p)) p[k] = r3(p[k] as number);
  return p;
}
const gripRel = (p: Pose, alpha: number, base: number) => r3(wrap(bladeCanvas(alpha) - ang(posed(p), "hand_l") - base));

// the grip: on the turned rig's left fist (the fist region's centre at the setup pose)
const setup = posed({});
const fist = (rigDoc.skins.body.attachments.hand as any).fist;
const hb = setup.findBone("hand_l")!.world;
const gx = hb.a * fist.x + hb.b * fist.y + hb.x + rigDoc.canvas.originX;
const gy = hb.c * fist.x + hb.d * fist.y + hb.y + rigDoc.canvas.originY;

const READY_ALPHA = 45;
const READY = pose({ armL: 28, foldL: 6, armR: 24, foldR: 4, body: {} });
const READY_IN: Pose = { ...READY, py: -1, chest: -0.5, head: -0.5, csx: 1.012, csy: 1.01 };
const GRIP_ANGLE = r3(wrap(bladeCanvas(READY_ALPHA) - ang(posed(READY), "hand_l")));
const spec = {
  ...held,
  name: "sword",
  grip: { ...held.grip, at: [r3(gx), r3(gy)], angle: GRIP_ANGLE },
  source: { note: `PROTOTYPE (turned-front preview, 2026-10-19): fixtures/garments/sword-live.held.json (the live sword sprite, same art and size) moved onto the turned rig ${RIG.split("/").pop()}: grip.at = the left fist region's centre at the setup pose, grip.angle solved by scripts/views/turnfront-sword-clips.ts so the ready blade is ${READY_ALPHA} deg up and out (screen-left).` }
};

const LUNGE = -50; // canvas px toward the target (screen-left)
// [frame, sword arm from down (out +), elbow fold, blade alpha (from up, out +), near arm, body, curve]
const KEYS: [number, number, number, number, number, Pose, Curve][] = [
  // anticipation: the arm raised high on the facing side, elbow bent, blade up and back over the head; the body draws
  // back and away from the target, weight on the back (near) leg
  [3, 100, 40, -20, 34, { rx: 12, px: 4, py: -4, chest: 6, head: -2, thL: -4, thR: 4 }, EASE_OUT],
  // strike: the arm swings down on the facing side, the elbow opens; the blade passes horizontal toward the target
  [5, 62, 14, 95, 30, { rx: LUNGE * 0.6, px: -3, py: 1, chest: -3, head: 1 }, "linear"],
  // contact (hit): the arm low and out, straight; blade down and out toward the target; lunge, lean in, knees bend
  // (pelvis drops), squash; the front (far) leg steps out
  [6, 22, 4, 150, 28, { rx: LUNGE, px: -8, py: 7, chest: -8, head: 3, csx: 1.03, csy: 0.96, thL: 7, thR: -5 }, "linear"],
  [8, 22, 4, 150, 28, { rx: LUNGE, px: -8, py: 7, chest: -8, head: 3, csx: 1.03, csy: 0.96, thL: 7, thR: -5 }, EASE_OUT], // hitstop
  [12, 16, 4, 160, 26, { rx: LUNGE * 1.05, px: -6, py: 5, chest: -6, head: 2, thL: 6, thR: -4 }, EASE_IO], // follow-through
  [16, 26, 8, 80, 25, { rx: LUNGE * 0.4, px: -2, py: 1, chest: -2, head: 0.5, thL: 2, thR: -1 }, EASE_IO] // recover: blade back up
];
const chopKeys: Key[] = [{ f: 0, p: READY, curve: "linear" }];
const grip: { time: number; value: number; curve: Curve }[] = [{ time: 0, value: 0, curve: "linear" }];
const table: unknown[] = [];
for (const [f, arm, fold, alpha, off, body, curve] of KEYS) {
  const p = pose({ armL: arm, foldL: fold, armR: off, foldR: 6, body });
  chopKeys.push({ f, p, curve });
  const g = gripRel(p, alpha, GRIP_ANGLE);
  grip.push({ time: r6(f * F), value: g, curve });
  table.push({ f, arm, fold, alpha, grip: g, ua: p.ua, fa: p.fa });
}
const END = 24;
chopKeys.push({ f: END, p: READY });
grip.push({ time: r6(END * F), value: 0, curve: "linear" });

const about = `PROTOTYPE chop toward the facing side on the 15-deg turned front (scripts/views/turnfront-sword-clips.ts): 30 fps, ${END} frames, from and back to sword_ready. f0 ready (blade 45 deg up and out, far hand); f3 anticipation (arm raised 100 deg on the facing side, elbow bent, blade up and back over the head, body drawn back 12 px and leaning away); f5 strike (blade horizontal toward the target); f6 contact, hit, held to f8: arm low and out, blade down and out, ${-LUNGE} px lunge, lean in 8 deg, pelvis drops 7 px, squash, front leg steps; f12 follow-through; f16 recover; f${END} ready.`;
const drawPhases = [
  { from: 0, to: r6(1.5 * F), order: "back" },
  { from: r6(1.5 * F), to: r6(14.5 * F), order: "front" }, // "hand" needs separate arm slots (arm-layer rig); here the arms are in the torso mesh
  { from: r6(14.5 * F), to: r6(END * F) + 1e-6, order: "back" }
];
const base = { clip: clipFrom(chopKeys, END, true), grip, hit: { time: r6(6 * F), holdFrames: 2 }, drawPhases };
mkdirSync("fixtures/clips-proto", { recursive: true });
writeFileSync("fixtures/garments/sword-turnfront.held.json", `${JSON.stringify(spec, null, 1)}\n`);
writeFileSync("fixtures/clips-proto/turnfront-sword-chop.json", `${JSON.stringify({ name: "turn_sword_chop", about: `${about} Thin swipe trail on the strike (f4.2-f6), shown f4.5-f6.5.`, ...base, smears: [{ name: "swipe_t", from: r6(4.2 * F), to: r6(6 * F), show: r6(4.5 * F), hide: r6(6.5 * F), style: "swipe", widthPx: 22 }] }, null, 1)}\n`);
writeFileSync("fixtures/clips-proto/turnfront-sword-ready.json", `${JSON.stringify({
  name: "turn_sword_ready",
  about: "PROTOTYPE idle on the turned front with the live sword: 2.0 s breath loop, the far (facing-side) arm 28 deg out, blade 45 deg up and out.",
  clip: clipFrom([{ f: 0, p: READY, curve: EASE_IO }, { f: 30, p: READY_IN, curve: EASE_IO }, { f: 60, p: READY }], 60, true),
  drawPhases: [{ from: 0, to: 2.000001, order: "back" }]
}, null, 1)}\n`);
console.log(`grip.at ${r3(gx)},${r3(gy)} angle ${GRIP_ANGLE}`);
console.log(JSON.stringify(table).replace(/\},\{/g, "},\n{"));
