// PROTOTYPE (turned-front round 2, 2026-10-19): the chop toward the facing side on the 15-deg turned ARM-LAYER body
// (separate arm meshes, upper-arm raise to ~128 deg; views/turned-front/round2/rig/armlayer-turn15-face-shift, made by
// turnfront.py + turnfront_face.py from attacks/sword-chop/body/rig/template7-armlayer-legs). The live sword in the
// FAR hand (hand_l, the facing side). Writes fixtures/garments/sword-turnfront-r2.held.json (sword-live spec, grip.at =
// the front chop's grip point moved with the turned left hand, grip.angle solved for the ready blade), fixtures/clips-proto/turnfront-r2-ready.json
// and turnfront-r2-chop.json. Run from packages/animator:
//   npx tsx scripts/views/turnfront-round2-sword-clips.ts [<rig.anim.json>]
// then the held import (round2/README.md). The clip builder and the arm solver are the front chop's
// (scripts/sword-chop-clips.ts) verbatim, plus thigh channels for the step.
// Stiff arm: the elbow fold is held at ELBOW (8 deg, the front chop's constant) through the whole attack, so the
// forearm never bends on the mesh hinge mid-swing and the arm pivots at the shoulder only. The wrist turns the blade
// (grip keys): overhead and back in the raise, forward and down at contact.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { Skeleton } from "../../src/core/skeleton.js";
import { AnimationState, AnimationStateData } from "../../src/core/animationState.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Pose = Record<string, number>;
const BONE: Record<string, [string, "rotate" | "tx" | "ty" | "sx" | "sy"]> = {
  rx: ["root", "tx"], ry: ["root", "ty"],
  px: ["pelvis", "tx"], py: ["pelvis", "ty"], csx: ["chest", "sx"], csy: ["chest", "sy"], chest: ["chest", "rotate"], neck: ["neck", "rotate"], head: ["head", "rotate"],
  clav: ["clavicle_l", "rotate"], ua: ["upper_arm_l", "rotate"], fa: ["forearm_l", "rotate"], hand: ["hand_l", "rotate"],
  claR: ["clavicle_r", "rotate"], uaR: ["upper_arm_r", "rotate"], faR: ["forearm_r", "rotate"], handR: ["hand_r", "rotate"],
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
const RIG = process.argv[2] ?? "../../docs/plans/atlas-animator-demos/views/turned-front/round2/rig/armlayer-turn15-face-shift.anim.json";
const rigDoc = JSON.parse(readFileSync(RIG, "utf8"));
const held = JSON.parse(readFileSync("fixtures/garments/sword-live.held.json", "utf8"));
function worldAngles(p: Pose): Record<string, number> {
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
  const out: Record<string, number> = {};
  for (const n of ["upper_arm_l", "forearm_l", "hand_l", "upper_arm_r", "forearm_r"]) {
    const w = sk.findBone(n)!.world;
    out[n] = (Math.atan2(w.c, w.a) * 180) / Math.PI;
  }
  return out;
}
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const DEG = Math.PI / 180;
/** Canvas direction (degrees, y down) of the blade at `alpha` deg from straight up toward the outside (screen-left). */
const bladeCanvas = (alpha: number) => (Math.atan2(-Math.cos(alpha * DEG), -Math.sin(alpha * DEG)) * 180) / Math.PI;

/** Sword upper arm `armL` deg from straight down toward the outside (negative = across the body), inward fold `foldL`. */
function pose(o: { armL: number; foldL: number; armR: number; foldR: number; body: Pose }): Pose {
  const p: Pose = { ...o.body, ua: 0, fa: -Math.max(0, o.foldL - 3.9), hand: 0, uaR: 0, faR: Math.max(0, o.foldR - 3.9), handR: 0 };
  for (let i = 0; i < 3; i++) {
    const w = worldAngles(p);
    p.ua = (p.ua as number) + wrap(90 + o.armL - (w.upper_arm_l as number));
    p.uaR = (p.uaR as number) + wrap(90 - o.armR - (w.upper_arm_r as number));
  }
  for (const k of Object.keys(p)) p[k] = r3(p[k] as number);
  if (Math.abs((p.fa as number) + 8) < 0.5) p.fa = -8.6;
  if (Math.abs((p.faR as number) - 8) < 0.5) p.faR = 8.6;
  return p;
}

// the grip: the front chop's grip point (sword-live.held.json, on the untouched arm-layer body; its handle passes the
// handle-in-fist gate there) carried by the left hand's setup move on the turned rig (the hand only translates)
const FRONT = "../../docs/plans/atlas-animator-demos/attacks/sword-chop/body/rig/template7-armlayer-legs.anim.json";
function handAt(doc: any): [number, number] {
  const sk = new Skeleton(loadAnimDocument(structuredClone(doc)));
  sk.setActiveSkins([Object.keys(doc.skins)[0] as string]);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  const w = sk.findBone("hand_l")!.world;
  return [w.x, w.y];
}
const [fx, fy] = handAt(JSON.parse(readFileSync(FRONT, "utf8")));
const [tx, ty] = handAt(rigDoc);
const gx = r3(held.grip.at[0] + tx - fx);
const gy = r3(held.grip.at[1] + ty - fy);

// near (off) arm kept >= 30 deg out from contact on: at 27-28 with its fold the forearm_r line ends open at the waist
const READY_ARM = 27; // the front chop's ready carry (an arm at ~15-26 deg leaves the forearm line open at the waist)
const READY_ALPHA = 25;
const ELBOW = 8; // the front chop's constant
const READY = pose({ armL: READY_ARM, foldL: 0, armR: READY_ARM, foldR: 0, body: {} });
const READY_IN: Pose = { ...READY, py: -1, chest: -0.5, head: -0.5, csx: 1.012, csy: 1.01 };
const GRIP_ANGLE = r3(wrap(bladeCanvas(READY_ALPHA) - (worldAngles(READY).hand_l as number)));
const gripRel = (p: Pose, alpha: number) => r3(wrap(bladeCanvas(alpha) - (worldAngles(p).hand_l as number) - GRIP_ANGLE));
const spec = {
  ...held,
  name: "sword",
  grip: { ...held.grip, at: [gx, gy], angle: GRIP_ANGLE },
  source: { note: `PROTOTYPE (turned-front round 2, 2026-10-19): fixtures/garments/sword-live.held.json (live sprite, same art and size) on ${RIG.split("/").pop()}: grip.at = the front chop's grip point moved with the left hand, grip.angle solved by scripts/views/turnfront-round2-sword-clips.ts so the ready blade is ${READY_ALPHA} deg off vertical, out.` }
};

const LUNGE = -50; // canvas px toward the target (screen-left)
// [frame, sword arm from down (out +), blade alpha (from up, out +; negative = back over the head), near arm, body]
const KEYS: [number, number, number, number, Pose, Curve][] = [
  // anticipation: the straight sword arm raised high on the facing side (134 deg from down, the fist above the shoulder line; 138 fails the wrist-join and line-end gates, and a blade laid further back than -45 opens the wrist stroke), the
  // blade laid back OVER the head; the body draws back and away, weight on the back (near) leg (head held level: a
  // head tilt away at this raise is outside the rig's hand-to-head lean limit)
  [3, 134, -45, 34, { rx: 12, px: 4, py: -4, chest: 6, head: 0, thL: -4, thR: 4 }, EASE_OUT],
  // strike: the arm swings down on the facing side, the wrist whips the blade forward past vertical
  [5, 78, 70, 30, { rx: LUNGE * 0.6, px: -3, py: 1, chest: -3, head: 1, thL: 3, thR: -2 }, "linear"],
  // contact (hit): the arm forward-low toward the target, blade down and forward; lunge, lean in, pelvis drops, squash;
  // the front (far) leg steps out
  [6, 40, 128, 32, { rx: LUNGE, px: -8, py: 7, chest: -8, head: 3, csx: 1.03, csy: 0.96, thL: 7, thR: -5 }, "linear"],
  [8, 40, 128, 32, { rx: LUNGE, px: -8, py: 7, chest: -8, head: 3, csx: 1.03, csy: 0.96, thL: 7, thR: -5 }, EASE_OUT], // hitstop
  [12, 30, 150, 32, { rx: LUNGE * 1.05, px: -6, py: 5, chest: -6, head: 2, thL: 6, thR: -4 }, EASE_IO], // follow-through
  [16, 32, 35, 31, { rx: LUNGE * 0.4, px: -2, py: 1, chest: -2, head: 0.5, thL: 2, thR: -1 }, EASE_IO] // recover: blade back up
];
const chopKeys: Key[] = [{ f: 0, p: READY, curve: "linear" }];
const grip: { time: number; value: number; curve: Curve }[] = [{ time: 0, value: 0, curve: "linear" }];
const table: unknown[] = [];
for (const [f, arm, alpha, off, body, curve] of KEYS) {
  const p = pose({ armL: arm, foldL: ELBOW, armR: off, foldR: 6, body });
  chopKeys.push({ f, p, curve });
  const g = gripRel(p, alpha);
  grip.push({ time: r6(f * F), value: g, curve });
  table.push({ f, arm, alpha, grip: g, ua: p.ua, fa: p.fa });
}
const END = 24;
chopKeys.push({ f: END, p: READY });
grip.push({ time: r6(END * F), value: 0, curve: "linear" });

const about = `PROTOTYPE chop toward the facing side on the 15-deg turned arm-layer body (scripts/views/turnfront-round2-sword-clips.ts): 30 fps, ${END} frames, from and back to the ready idle. Stiff arm (elbow fold held at ${ELBOW} deg). f0 ready; f3 anticipation (arm 134 deg up on the facing side, blade back over the head, body drawn back 12 px, leaning away); f5 strike (arm 78, blade whipped forward); f6 contact, hit, held to f8 (arm 40 forward-low, blade down and forward, ${-LUNGE} px lunge, lean in 8 deg, pelvis drops 7 px, squash, front leg steps); f12 follow-through; f16 recover; f${END} ready.`;
const drawPhases = [
  { from: 0, to: r6(1.5 * F), order: "back" },
  { from: r6(1.5 * F), to: r6(4.5 * F), order: "front", arm: "front" }, // the blade over the head: in front of the hair
  { from: r6(4.5 * F), to: r6(14.5 * F), order: "hand", arm: "front" },
  { from: r6(14.5 * F), to: r6(END * F) + 1e-6, order: "back" }
];
const base = { clip: clipFrom(chopKeys, END, true), grip, hit: { time: r6(6 * F), holdFrames: 2 }, drawPhases };
mkdirSync("fixtures/clips-proto", { recursive: true });
writeFileSync("fixtures/garments/sword-turnfront-r2.held.json", `${JSON.stringify(spec, null, 1)}\n`);
writeFileSync("fixtures/clips-proto/turnfront-r2-chop.json", `${JSON.stringify({ name: "turn_r2_chop", about: `${about} Thin swipe trail on the strike (f4.2-f6), shown f4.5-f6.5.`, ...base, smears: [{ name: "swipe_t", from: r6(4.2 * F), to: r6(6 * F), show: r6(4.5 * F), hide: r6(6.5 * F), style: "swipe", widthPx: 22 }] }, null, 1)}\n`);
writeFileSync("fixtures/clips-proto/turnfront-r2-ready.json", `${JSON.stringify({
  name: "turn_r2_ready",
  about: "PROTOTYPE idle on the turned arm-layer body with the live sword: 2.0 s breath loop, the far (facing-side) arm 27 deg out, blade 25 deg off vertical, out.",
  clip: clipFrom([{ f: 0, p: READY, curve: EASE_IO }, { f: 30, p: READY_IN, curve: EASE_IO }, { f: 60, p: READY }], 60, true),
  drawPhases: [{ from: 0, to: 2.000001, order: "back" }]
}, null, 1)}\n`);
console.log(`grip.at ${gx},${gy} angle ${GRIP_ANGLE}`);
console.log(JSON.stringify(table).replace(/\},\{/g, "},\n{"));
