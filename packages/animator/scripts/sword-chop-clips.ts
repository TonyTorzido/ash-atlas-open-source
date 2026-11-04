// PROTOTYPE (sword chop round, 2026-10-17): the overhead chop on the FULL character (arm-layer upper body on the legs
// body, docs/plans/atlas-animator-demos/attacks/sword-chop/body), with the live sword art (fixtures/garments/
// sword-live.held.json). Writes fixtures/clips-proto/sword-ready-full.json (the idle), sword-chop-overhead.json (thin
// swipe trail) and sword-chop-overhead-notrail.json (the same motion, no trail). Run from packages/animator:
//   npx tsx scripts/sword-chop-clips.ts
// Values are offsets from the setup pose (degrees; root / pelvis translate in canvas px, y down).
//
// The chop, within the rig's limits (upper arm raise at most ~128 deg from down; an elbow fold above ~10 deg only
// with the upper arm raised, clips elbow polygon):
// - f0 ready: the idle carry (arm 23 deg out, straight; blade 25 deg off vertical, out);
// - f1 anticipation (35 ms): the sword arm straight and raised high out to the side (126 deg from down), the blade
//   turned in the fist to stand up and back over the head; the whole body draws back away from the target and leans
//   away;
// - f2-f3 strike (2 frames): the arm swings down and across in front of the body, straight, pivoting at the shoulder;
//   f3 contact (105 ms in live time): the fist in front of the body's centreline, the blade pointing down and a
//   little toward the target; the body lunges toward the target (screen-left, -x), leans into the hit, squashes;
//   `hit` event, 2-frame hitstop (live 60 ms);
// - f8 follow-through, f12 recover, f21 back to the ready idle.
// Stiff arms: the elbow fold is held at a small constant (ELBOW) through the whole attack, so the forearm never bends
// on the mesh hinge mid-swing; the arm pivots at the shoulder only.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadAnimDocument } from "../src/core/formatLoader.js";
import { Skeleton } from "../src/core/skeleton.js";
import { AnimationState, AnimationStateData } from "../src/core/animationState.js";

type Pose = Record<string, number>;
const BONE: Record<string, [string, "rotate" | "tx" | "ty" | "sx" | "sy"]> = {
  rx: ["root", "tx"], ry: ["root", "ty"],
  px: ["pelvis", "tx"], py: ["pelvis", "ty"], csx: ["chest", "sx"], csy: ["chest", "sy"], chest: ["chest", "rotate"], neck: ["neck", "rotate"], head: ["head", "rotate"],
  clav: ["clavicle_l", "rotate"], ua: ["upper_arm_l", "rotate"], fa: ["forearm_l", "rotate"], hand: ["hand_l", "rotate"],
  claR: ["clavicle_r", "rotate"], uaR: ["upper_arm_r", "rotate"], faR: ["forearm_r", "rotate"], handR: ["hand_r", "rotate"]
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

const RIG = "../../docs/plans/atlas-animator-demos/attacks/sword-chop/body/rig/template7-armlayer-legs-face.anim.json";
const HELD = "fixtures/garments/sword-live.held.json";
const rigDoc = JSON.parse(readFileSync(RIG, "utf8"));
const held = JSON.parse(readFileSync(HELD, "utf8"));
let GRIP_ANGLE: number = held.grip.angle;
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
const gripFor = (p: Pose, alpha: number) => r3(wrap(bladeCanvas(alpha) - (worldAngles(p).hand_l as number) - GRIP_ANGLE));

// 27 (not the upper-body 23): on the legs body the torso bottom stroke is dropped (the torso flows into the hips), so
// at 23 the forearm outline ends open in the skin at the waist (arm-layer open-ends gate)
const READY_ARM = 27;
const READY_ALPHA = 25;
const ELBOW = 8; // the constant small elbow fold through the attack (stiff arm)
const READY = pose({ armL: READY_ARM, foldL: 0, armR: READY_ARM, foldR: 0, body: {} });
const READY_IN: Pose = { ...READY, py: -1, chest: -0.5, head: -0.5, csx: 1.012, csy: 1.01 };

const gripNeeded = r3(wrap(bladeCanvas(READY_ALPHA) - (worldAngles(READY).hand_l as number)));
if (Math.abs(wrap(gripNeeded - GRIP_ANGLE)) > 0.01) {
  held.grip.angle = gripNeeded;
  writeFileSync(HELD, `${JSON.stringify(held, null, 1)}\n`);
  console.log(`sword-live.held.json grip.angle ${GRIP_ANGLE} -> ${gripNeeded}`);
  GRIP_ANGLE = gripNeeded;
}

// lunge toward the target (screen-left = -x): LUNGE canvas px = 14 live display px at the live 0.2356 px per canvas px
const LUNGE = -60;
// [frame, sword arm from down (out +), blade alpha (from up, out +), off arm, body]
// alpha null = the wrist stays locked (the grip key of the previous key): from the windup to the follow-through the
// sword turns only with the stiff arm, so the blade ends at contact pointing down (about 172 deg from up, out)
const KEYS: [number, number, number | null, number, Pose, Curve][] = [
  [1, 126, 12, 34, { rx: 10, px: 3, py: -3, chest: 3, head: -1.2 }, "linear"], // anticipation: raised, blade straight up beside the head (drawn in front: behind the body the hair hides it)
  [2, 62, null, 30, { rx: LUNGE * 0.55, px: -2, py: 0, chest: -2.5, head: 1 }, "linear"], // strike 1: down past the shoulder
  [3, -34, null, 30, { rx: LUNGE, px: -6, py: 5, chest: -6, head: 2.4, csx: 1.035, csy: 0.955 }, "linear"], // contact, hit, squash
  [5, -34, null, 30, { rx: LUNGE, px: -6, py: 5, chest: -6, head: 2.4, csx: 1.035, csy: 0.955 }, EASE_OUT], // hitstop end
  [8, -40, null, 32, { rx: LUNGE * 1.05, px: -5, py: 4, chest: -5, head: 2 }, EASE_IO], // follow-through
  [10, 32, 108, 31, { rx: LUNGE * 0.5, px: -2, py: 1, chest: -2, head: 0.8 }, EASE_IO], // recover: the sword arm swings back out fast (an arm between ~15 and 26 deg out leaves the forearm line open at the waist on this body)
  [12, 30, 100, 31, { rx: LUNGE * 0.5, px: -2, py: 1, chest: -2, head: 0.8 }, EASE_IO] // recover
];
const chopKeys: Key[] = [{ f: 0, p: READY, curve: "linear" }];
const grip: { time: number; value: number; curve: Curve }[] = [{ time: 0, value: 0, curve: "linear" }];
const table: unknown[] = [];
for (const [f, arm, alpha, off, body, curve] of KEYS) {
  const p = pose({ armL: arm, foldL: ELBOW, armR: off, foldR: 6, body });
  chopKeys.push({ f, p, curve });
  const g = alpha === null ? (grip[grip.length - 1] as { value: number }).value : gripFor(p, alpha);
  grip.push({ time: r6(f * F), value: g, curve });
  table.push({ f, arm, alpha, grip: g, ua: p.ua, fa: p.fa });
}
chopKeys.push({ f: 21, p: READY });
grip.push({ time: r6(21 * F), value: 0, curve: "linear" });

const about = "PROTOTYPE overhead chop on the full character (scripts/sword-chop-clips.ts): front view, 30 fps, 21 frames (0.7 s), from and back to sword_ready. f1 anticipation: straight sword arm raised high out to the side, blade straight up beside the head (item in front for f0.5-1.5), body drawn back; f2-3 strike (2 frames): the straight arm swings down and across in front of the body (shoulder pivot only, elbow fold held at 8 deg); f3 contact: fist in front of the centreline, blade pointing down and a little toward the target, 60 px lunge toward the target (screen-left), lean into the hit, squash 1.035 x 0.955, `hit`, held to f5 (2-frame hitstop); f8 follow-through; f12 recover; f21 ready.";
const drawPhases = [
  { from: 0, to: r6(0.5 * F), order: "back", arm: "front" },
  { from: r6(0.5 * F), to: r6(1.5 * F), order: "front", arm: "front" },
  { from: r6(1.5 * F), to: r6(13.5 * F), order: "hand", arm: "front" },
  { from: r6(13.5 * F), to: r6(21 * F) + 1e-6, order: "back" } // recovery: arms apart, no arm-front switch
];
const base = { clip: clipFrom(chopKeys, 21, true), grip, hit: { time: r6(3 * F), holdFrames: 2 }, drawPhases };
mkdirSync("fixtures/clips-proto", { recursive: true });
writeFileSync("fixtures/clips-proto/sword-chop-overhead.json", `${JSON.stringify({ name: "sword_chop_overhead", about: `${about} Thin swipe trail along the tip path of the last strike frame (f2.2-f3), shown f2.5-f3.5.`, ...base, smears: [{ name: "swipe_b", from: r6(2.2 * F), to: r6(3 * F), show: r6(2.5 * F), hide: r6(3.5 * F), style: "swipe", widthPx: 22 }] }, null, 1)}\n`);
writeFileSync("fixtures/clips-proto/sword-chop-overhead-notrail.json", `${JSON.stringify({ name: "sword_chop_overhead_notrail", about: `${about} No trail.`, ...base }, null, 1)}\n`);
writeFileSync("fixtures/clips-proto/sword-ready-full.json", `${JSON.stringify({
  name: "sword_ready",
  about: "PROTOTYPE idle on the full character with the live sword: 2.0 s breath loop, the sword arm hanging straight 27 deg out, the blade 25 deg off vertical, out, above the fist (grip constant, no grip keys). f0 is the chop's start and end pose.",
  clip: clipFrom([{ f: 0, p: READY, curve: EASE_IO }, { f: 30, p: READY_IN, curve: EASE_IO }, { f: 60, p: READY }], 60, true),
  drawPhases: [{ from: 0, to: 2.000001, order: "back" }]
}, null, 1)}\n`);
console.log(JSON.stringify(table, null, 0).replace(/\},\{/g, "},\n{"));
