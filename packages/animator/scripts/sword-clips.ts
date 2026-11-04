// Author of fixtures/clips/sword-ready.json and sword-slash.json, and of the on-hold clips
// fixtures/clips-on-hold/sword-slash-chop.json and sword-slash-2.json (pose table -> atlas-anim clip keys).
// Run from packages/animator: npx tsx scripts/sword-clips.ts
// Values are offsets from the setup pose (degrees; pelvis translate in canvas px, y down).
//
// Round 4 (2026-10-17, owner: "the weapon was ABOVE the player's hand ... it swung down from that position"): the
// idle and the main slash follow the LIVE game's sword (rendered with the real PlayerRenderer in
// docs/plans/atlas-animator-demos/attacks/sword/live-reference/, scripts/live-sword-reference.ts):
// - ready/idle: arm hanging straight, 17 deg out (live REST_ARM_DEGREES), the blade up out of the fist 25 deg off
//   vertical toward the outside (live idle placement rotationDegrees -25), pivoting about the handle in the fist;
//   the sword's constant grip angle (sword.held.json) gives exactly that, so the idle has no grip keys;
// - sword_slash: the live SWING_PROGRAMS.swing sampled every frame. The blade turns about the fist along the live tool
//   curve (blade = 235 - tool, from up toward the outside) by authored GRIP keys; the arm follows the live arm and
//   elbow curves with the elbow folded inward (the rig's elbows never fold outward, so the live outward fold is
//   mirrored about the forearm: same fist place, upper arm and forearm directions swapped, upper arm capped at 128 deg
//   from down); off arm, lean and timing from the same program. 35 ms per frame (contact at 105 ms = f3), a 2-frame
//   hitstop (live 60 ms), follow-through at f8 (live 210 ms + the hitstop), live program end at f12 (arm at rest,
//   blade 70 deg = the live attack_action carry), then back to the idle carry by f21 (0.7 s, the live recovery).
// The round-3 diagonal cross-body chop is on hold in fixtures/clips-on-hold/ (name sword_slash_chop).
import { readFileSync, writeFileSync } from "node:fs";
import { loadAnimDocument } from "../src/core/formatLoader.js";
import { Skeleton } from "../src/core/skeleton.js";
import { AnimationState, AnimationStateData } from "../src/core/animationState.js";

type Pose = Record<string, number>;
const BONE: Record<string, [string, "rotate" | "tx" | "ty" | "sx" | "sy"]> = {
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

const EASE_OUT: Curve = [0.2, 0.7, 0.4, 1];
const EASE_IO: Curve = [0.45, 0, 0.55, 1];
const HOLD: Curve = "linear";

// --- forward kinematics on the arm-layer body rig (the rig the held import dresses)
const RIG = "../../docs/plans/atlas-animator-demos/arm-layer/rig/upper/template7-armlayer-body.anim.json";
const HELD = "fixtures/garments/sword.held.json";
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

/**
 * A pose from live terms: the left (sword) upper arm `armL` deg from straight down toward the outside with an inward
 * elbow fold `foldL`; the right arm likewise (`armR` out to the right, fold `foldR`); body channels as given. The
 * upper-arm offsets are solved so the bones point exactly there (the rig's setup forearm is already folded 3.9 deg
 * inward, so a fold below that keeps the forearm offset at 0, never outward).
 */
function livePose(o: { armL: number; foldL: number; armR: number; foldR: number; body: Pose }): Pose {
  const p: Pose = { ...o.body, ua: 0, fa: -Math.max(0, o.foldL - 3.9), hand: 0, uaR: 0, faR: Math.max(0, o.foldR - 3.9), handR: 0 };
  for (let i = 0; i < 3; i++) {
    const w = worldAngles(p);
    p.ua = (p.ua as number) + wrap(90 + o.armL - (w.upper_arm_l as number));
    p.uaR = (p.uaR as number) + wrap(90 - o.armR - (w.upper_arm_r as number));
  }
  for (const k of Object.keys(p)) p[k] = r3(p[k] as number);
  // keep the forearms off the arm layer's fold-fader midpoint (forearm -8 / +8, 0.5 deg ramps): a keyed frame
  // inside the ramp shows a half-faded crease (faderGate)
  if (Math.abs((p.fa as number) + 8) < 0.5) p.fa = -8.6;
  if (Math.abs((p.faR as number) - 8) < 0.5) p.faR = 8.6;
  return p;
}
/** Grip key (offset from the item's constant grip angle) that points the blade at `alpha` in pose `p`. */
const gripFor = (p: Pose, alpha: number) => r3(wrap(bladeCanvas(alpha) - (worldAngles(p).hand_l as number) - GRIP_ANGLE));

// --- the live swing program (game repo packages/player-renderer/src/gatherAnimation.ts SWING_PROGRAMS.swing, read
// 2026-10-17 at master f5bc50129): [cycle fraction, value, easing of the segment ending there]
const REST = (Math.atan2(745 - 684, 940 - 742) * 180) / Math.PI; // REST_ARM_DEGREES, 17.1
const LIN = 0, IO = 1, IN = 2, OUT = 3;
type Track = [number, number, number?][];
const LIVE: Record<"arm" | "bend" | "tool" | "offArm" | "offBend" | "lean", Track> = {
  arm: [[0, REST], [0.14, 62, OUT], [0.3, 58, IN], [0.6, 48, OUT], [1, REST, IO]],
  bend: [[0, 0], [0.14, 92, OUT], [0.3, 8, IN], [0.6, 24, OUT], [1, 0, IO]],
  tool: [[0, 165], [0.14, 190, OUT], [0.3, 96, IN], [0.6, 80, OUT], [1, 165, IO]],
  offArm: [[0, REST], [0.14, 26, OUT], [0.3, 12, IN], [1, REST, IO]],
  offBend: [[0, 0], [0.14, 18, OUT], [0.3, 6, IN], [1, 0, IO]],
  lean: [[0, 0], [0.14, -2.5, OUT], [0.3, 4.5, IN], [1, 0, IO]]
};
const ease = (t: number, e = LIN) => (e === IO ? t * t * (3 - 2 * t) : e === IN ? t * t * t : e === OUT ? 1 - (1 - t) ** 3 : t);
function sample(track: Track, t: number): number {
  if (t <= track[0]![0]) return track[0]![1];
  for (let i = 1; i < track.length; i++) {
    const [kt, kv, ke] = track[i]!;
    if (t <= kt) {
      const [pt, pv] = track[i - 1]!;
      return pv + (kv - pv) * ease((t - pt) / (kt - pt), ke);
    }
  }
  return track[track.length - 1]![1];
}
const CYCLE_MS = 350;
const MS_PER_FRAME = 35; // contact 105 ms lands on f3; 30 fps playback runs the live program 5% slower
const HIT_F = 3;
const HOLD_FRAMES = 2; // live hitstop 60 ms
const END_F = 12; // live program end (350 ms) after the hitstop
const msAt = (f: number) => (f <= HIT_F ? f * MS_PER_FRAME : f <= HIT_F + HOLD_FRAMES ? HIT_F * MS_PER_FRAME : HIT_F * MS_PER_FRAME + (f - HIT_F - HOLD_FRAMES) * MS_PER_FRAME);

const READY_ALPHA = 25; // live idle: rotationDegrees -25 (the blade 25 deg off vertical, out)
const CARRY_ALPHA = 70; // live attack_action: rotationDegrees -70 (the pose until 700 ms after the press)
// the windup's upper arm is capped below the rig's raise limit (ua <= 105 from setup) with margin
const UPPER_CAP = 128;

function liveFrame(f: number): { p: Pose; alpha: number; live: Record<string, number> } {
  const t = msAt(f) / CYCLE_MS;
  const v = Object.fromEntries(Object.entries(LIVE).map(([k, tr]) => [k, sample(tr, t)])) as Record<keyof typeof LIVE, number>;
  // live folds the elbow outward (forearm further out than the upper arm); the rig folds inward only: swap the
  // two directions (same fist place for equal segments), cap the upper arm
  // the rig's arms cannot hang closer than READY_ARM (23 deg; live rest 17.1) without the forearm outline ending
  // inside the torso (arm-layer open-ends gate): the sword arm is held at least there, the off arm shifted by the
  // difference so its live motion is kept
  const armL = Math.max(v.arm, READY_ARM);
  const upperL = Math.min(Math.max(v.arm + v.bend, READY_ARM), UPPER_CAP);
  const upperR = Math.max(v.offArm + v.offBend + (READY_ARM - REST), READY_ARM + v.offBend); // forearm never closer than READY_ARM
  const lean = v.lean; // + toward the target (screen-left)
  const p = livePose({
    armL: upperL, foldL: upperL - armL, armR: upperR, foldR: v.offBend,
    body: { px: r3(-lean * 0.9), chest: r3(-lean), head: r3(lean * 0.4) }
  });
  const alpha = f === 0 ? READY_ALPHA : 235 - v.tool; // blade from up toward the outside: attack_action base 70 turned by tool - 165
  return { p, alpha, live: { ms: msAt(f), ...v } };
}

// the rig's closest clean arm hang (live REST 17.1; below 23 the forearm outline ends inside the torso: open-ends gate)
const READY_ARM = 23;
// ready: the live rest arm, straight, at READY_ARM out; the right arm the same on its side
const READY = livePose({ armL: READY_ARM, foldL: 0, armR: READY_ARM, foldR: 0, body: {} });
// idle breathing on top (the body idle's breath: chest scale 1.012 x 1.01; the arms do not inherit the chest scale,
// so the held item stays rigid): breath in lifts the shoulders about 1 px, the arms follow
const READY_IN: Pose = { ...READY, py: -1, chest: -0.5, head: -0.5, csx: 1.012, csy: 1.01 };

// the grip constant: the item's grip angle that puts the blade at READY_ALPHA in READY (no idle grip keys)
const gripNeeded = r3(wrap(bladeCanvas(READY_ALPHA) - (worldAngles(READY).hand_l as number)));
if (Math.abs(wrap(gripNeeded - GRIP_ANGLE)) > 0.01) {
  held.grip.angle = gripNeeded;
  writeFileSync(HELD, `${JSON.stringify(held, null, 1)}\n`);
  console.log(`sword.held.json grip.angle ${GRIP_ANGLE} -> ${gripNeeded}`);
  GRIP_ANGLE = gripNeeded;
}

// --- sword_slash (the live swing)
const slashKeys: Key[] = [];
const gripKeys: { time: number; value: number; curve: Curve }[] = [];
const table: unknown[] = [];
for (let f = 0; f <= END_F; f++) {
  const lf = f === 0 ? { p: READY, alpha: READY_ALPHA, live: { ms: 0 } } : liveFrame(f);
  const curve: Curve = f === END_F ? EASE_IO : "linear";
  slashKeys.push({ f, p: lf.p, curve });
  const g = gripFor(lf.p, lf.alpha);
  gripKeys.push({ time: r6(f * F), value: f === 0 ? 0 : g, curve });
  table.push({ f, alpha: r3(lf.alpha), grip: g, ...lf.p, live: lf.live });
}
slashKeys.push({ f: 21, p: READY });
gripKeys.push({ time: r6(21 * F), value: 0, curve: "linear" });
const slashFile = {
  name: "sword_slash",
  about: "One-handed sword slash (Ronin / Paladin), the main attack, matched to the LIVE game's swing (SWING_PROGRAMS.swing, docs/plans/atlas-animator-demos/attacks/sword/live-reference): front view, 30 fps held frames, 21 frames (0.7 s = the live 700 ms swing recovery), from and back to sword_ready. The arm stays out at the side; the blade turns DOWN about the fist along the live tool curve (authored grip keys, every frame f0-f12). f0 ready: blade 25 deg off vertical, out, above the fist; f1 windup peak (live 49 ms): arm raised out, elbow cocked, blade 45 deg up and out; f2-3 strike; f3 contact (105 ms in live time, 100 ms at 30 fps): arm about 58 deg out, near straight, blade 139 deg from up = 49 deg below horizontal, outward, `hit` event, held to f5 (2-frame hitstop = live 60 ms); f8 follow-through (live 210 ms): blade 155 deg, 65 deg below horizontal; f12 live program end: arm at rest, blade 70 deg (the live attack_action carry); f12-21 back up to the idle carry. The holding arm draws in front of the other arm; the item is under the holding arm (fist over the hilt) through the swing, behind the body at rest.",
  clip: clipFrom(slashKeys, 21, true),
  grip: gripKeys,
  hit: { time: r6(HIT_F * F), holdFrames: HOLD_FRAMES },
  drawPhases: [
    { from: 0, to: r6(0.5 * F), order: "back", arm: "front" },
    { from: r6(0.5 * F), to: r6(13.5 * F), order: "hand", arm: "front" },
    { from: r6(13.5 * F), to: r6(21 * F) + 1e-6, order: "back", arm: "front" }
  ],
  smears: [
    { name: "smear1", from: r6(1 * F), to: r6(3 * F), show: r6(1.5 * F), hide: r6(3.5 * F), inner: [0.95, 0.5] }
  ]
};

const readyKeys: Key[] = [
  { f: 0, p: READY, curve: EASE_IO },
  { f: 30, p: READY_IN, curve: EASE_IO },
  { f: 60, p: READY }
];
const readyFile = {
  name: "sword_ready",
  about: "The default idle with the one-handed sword (sword_idle = this clip), matched to the LIVE idle carry: front view, 2.0 s loop at 30 fps held frames; the sword arm hangs straight 17 deg out from the body (live REST_ARM_DEGREES), the blade stands up out of the fist 25 deg off vertical toward the outside (live idle rotationDegrees -25), the hilt through the fist, pommel below it; the item grip constant gives that angle, so no grip keys. Breath in over 1 s (chest scale to 1.012 x 1.01, the body lifts about 1 px) and out over 1 s. f0 is the exact sword_slash start and end pose. Item behind the body.",
  clip: clipFrom(readyKeys, 60, true),
  drawPhases: [{ from: 0, to: 2.000001, order: "back" }]
};

// --- on hold: the round-3 diagonal cross-body chop (owner choice before the live match) and the round-1 rising cut.
// Both were authored for the 135 deg grip; they are kept as written, not re-angled, and are not loaded or rendered.
const CHOP_READY: Pose = { px: 0, py: 0, chest: -1, head: 1, ua: 14, fa: -24, hand: -15, uaR: -6, faR: 12, handR: 0 };
const WIND: Pose = { px: 5, py: -2, chest: 4, head: 1, clav: 2, ua: 100, fa: -50, hand: 30, uaR: -14, faR: 10, handR: 4 };
const MID: Pose = { px: 1, py: 0, chest: 0, head: 0, clav: 1, ua: 20, fa: -18, hand: -10, uaR: -10, faR: 12, handR: 0 };
const CONTACT: Pose = { px: -4, py: 3, chest: -6, head: 2, clav: -3, ua: -52, fa: -22, hand: -30, uaR: -20, faR: 10, handR: -4 };
const FOLLOW: Pose = { px: -5, py: 4, chest: -6, head: 3, clav: -2, ua: -58, fa: -12, hand: -24, uaR: -25, faR: 15, handR: -5 };
const OPEN: Pose = { px: -2, py: 3, chest: -3, head: 1, ua: -25, fa: -10, hand: -30, uaR: -10, faR: 12, handR: -2 };
const chopKeys: Key[] = [
  { f: 0, p: CHOP_READY, curve: "linear" },
  { f: 1, p: WIND, curve: "linear" },
  { f: 2, p: MID, curve: "linear" },
  { f: 3, p: CONTACT, curve: HOLD },
  { f: 5, p: CONTACT, curve: EASE_OUT },
  { f: 8, p: FOLLOW, curve: EASE_IO },
  { f: 12, p: OPEN, curve: EASE_IO },
  { f: 21, p: CHOP_READY }
];
const chopFile = {
  name: "sword_slash_chop",
  about: "ON HOLD (2026-10-17, replaced by the live-matched sword_slash): the round-3 diagonal cross-body chop, authored for the old 135 deg locked grip (no grip keys). f1 windup high and out, f3 contact with the fist just past the centreline and the blade about 43 deg below horizontal, f3-5 hitstop, f8 follow-through low across, f12 open back out, f21 ready. Not loaded by the held import (fixtures/clips-on-hold).",
  clip: clipFrom(chopKeys, 21, true),
  hit: { time: r6(3 * F), holdFrames: 2 },
  drawPhases: [
    { from: 0, to: r6(1.5 * F), order: "back", arm: "front" },
    { from: r6(1.5 * F), to: r6(13.5 * F), order: "hand", arm: "front" },
    { from: r6(13.5 * F), to: r6(21 * F) + 1e-6, order: "back", arm: "front" }
  ],
  smears: [{ name: "smear1", from: r6(1 * F), to: r6(3 * F), show: r6(1.5 * F), hide: r6(3.5 * F), inner: [0.95, 0.5] }]
};
const WIND2: Pose = { px: 6, py: 4, chest: 4, head: -1, ua: -48, fa: -42, hand: 2, uaR: -18, faR: 6, handR: 4 };
const WIND2_HOLD: Pose = { ...WIND2, px: 7, py: 5, chest: 5, ua: -51, fa: -44, hand: 4 };
const CONTACT2: Pose = { px: -3, py: 2, chest: -3, head: 2, ua: 2, fa: -6, hand: -30, uaR: 8, faR: 18, handR: -4 };
const FOLLOW2: Pose = { px: -6, py: -2, chest: -5, head: 3, clav: 3, ua: 95, fa: -12, hand: -19, uaR: 16, faR: 26, handR: -8 };
const FOLLOW2_SETTLE: Pose = { ...FOLLOW2, py: -1, chest: -4.5, clav: 2, ua: 93, fa: -14, hand: -21 };
const slash2Keys: Key[] = [
  { f: 0, p: CHOP_READY, curve: EASE_OUT },
  { f: 2, p: WIND2, curve: HOLD },
  { f: 3, p: WIND2_HOLD, curve: "linear" },
  { f: 4, p: CONTACT2, curve: HOLD },
  { f: 6, p: CONTACT2, curve: EASE_OUT },
  { f: 8, p: FOLLOW2, curve: EASE_IO },
  { f: 10, p: FOLLOW2_SETTLE, curve: EASE_IO },
  { f: 21, p: CHOP_READY }
];
const slash2File = {
  name: "sword_slash_2",
  about: "ON HOLD: the round-1 backhand rising cut, authored for the old 135 deg locked grip (no grip keys). f0-2 anticipation across the body, f3-4 strike out and up, f4 contact (`hit`), f4-6 hitstop, f8 follow-through high, f10 settle, f21 ready.",
  clip: clipFrom(slash2Keys, 21, true),
  hit: { time: r6(4 * F), holdFrames: 2 },
  drawPhases: [
    { from: 0, to: r6(0.5 * F), order: "back", arm: "front" },
    { from: r6(0.5 * F), to: r6(6.5 * F), order: "hand", arm: "front" },
    { from: r6(6.5 * F), to: r6(21 * F) + 1e-6, order: "back", arm: "front" }
  ],
  smears: [
    { name: "smear1", from: r6(3 * F), to: r6(4 * F), show: r6(3.5 * F), hide: r6(4.5 * F), inner: [0.95, 0.5] },
    { name: "smear2", from: r6(6 * F), to: r6(8 * F), show: r6(6.5 * F), hide: r6(7.5 * F), inner: [0.97, 0.7] }
  ]
};

writeFileSync("fixtures/clips/sword-slash.json", `${JSON.stringify(slashFile, null, 1)}\n`);
writeFileSync("fixtures/clips/sword-ready.json", `${JSON.stringify(readyFile, null, 1)}\n`);
// on hold: kept outside fixtures/clips so the held import does not load them
writeFileSync("fixtures/clips-on-hold/sword-slash-chop.json", `${JSON.stringify(chopFile, null, 1)}\n`);
writeFileSync("fixtures/clips-on-hold/sword-slash-2.json", `${JSON.stringify(slash2File, null, 1)}\n`);
if (process.argv.includes("--table")) console.log(JSON.stringify(table, null, 0).replace(/\},\{/g, "},\n{"));
console.log("wrote clips; READY", JSON.stringify(READY));
