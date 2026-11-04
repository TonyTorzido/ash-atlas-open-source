// Jacket B gathering + flag-building clips (2026-10-20, docs/plans/player-gather-anims.md).
// Authors the body clips on the Jacket B turned rigs (rigs/jacketb, as copied by scripts/copy-jacket-rig.mjs) and the
// per-frame held-item transform (tools are NOT baked into the sheets; the client draws the in-game tool sprite there).
//   npx tsx scripts/gather/gather-clips-jacketb.ts [<out dir>] [gather|sword]      (run from packages/animator)
// Writes <out>/<rig>.anim.json (the rig + gather_* animations) for both turned rigs and <out>/gather-clips.json:
//   clips[id] = { anim, frames, loop, fps, contact, item, hold, keep, xf: [[gripX, gripY, itemDeg, order, planted], ...] }
//   grip in canvas px from the skeleton origin (y down); itemDeg = canvas direction (atan2, y down) from the grip to
//   the item's head (the tool head / the flag top); order 0 = behind the body, 1 = in front; planted 1 = the flag
//   stays where it is (let go).
// The `sword-combo` set (2026-10-20, docs/plans/player-sword-combo.md, retired: no longer shipped) writes the
// sword_1..3 rig combo clips the same way to <out>/sword-combo-clips.json, with a 6th xf column: the blade's on-screen
// length factor (foreshortening as it sweeps around the body in depth; the client scales the art along its up axis).
// The `sword` set (2026-10-20, docs/plans/player-sword-keyposes/README.md, Phase 2) writes sword_walk: the live
// walk_in_place with the sword arm (upper_arm_l / forearm_l / hand_l) held at the drawn ready pose's angle, and the
// per-frame grip (same 6 xf columns; itemDeg = the ready pose's blade angle turned with the fist). The swings
// themselves are drawn key poses (scripts/pack-sword-keyposes.py), not rig clips.
// Conventions (both rigs share the skeleton; the R rig is drawn image-flipped like the walk): the far arm (hand_l)
// is on the facing side and does the work. arm = upper arm degrees from straight down toward the facing side,
// fold = elbow fold, alpha = item direction degrees from straight up toward the facing side (negative = back over
// the head). Body: rx root x (negative = toward the facing side), px/py pelvis (py + = down), chest/head rotate
// (negative = lean toward the facing side), csx/csy chest scale, thL/thR thighs.
// Pose keys follow the Spine curve convention (a key's curve shapes the segment that starts at it); every frame is
// then keyed so the clip and the exported item transform interpolate identically. Every clip ships all 30 fps poses
// (hold 1; 2026-10-20 owner: the 15 fps holds read "very stuttery").
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnimationState, AnimationStateData } from "../../src/core/animationState.js";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { Skeleton } from "../../src/core/skeleton.js";
import { SWORD_WALK, swordWalkFrom } from "./sword-walk.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Curve = "linear" | [number, number, number, number];
type P = { arm: number; fold: number; alpha: number; armR: number; foldR: number; order?: 0 | 1; planted?: 0 | 1 } & Partial<Record<Body, number>>;
type Body = "rx" | "px" | "py" | "chest" | "head" | "csx" | "csy" | "thL" | "thR" | "len";
type K = [number, P, Curve?];
type ClipSpec = { id: string; frames: number; loop: boolean; contact: number | null; item: "axe" | "pick" | "pole" | "flag" | "sword" | null; hold: number; keep: number[]; keys: K[] };

const IN = "rigs/jacketb";
const OUT = process.argv[2] ?? "rigs/jacketb-gather";
const SET: "gather" | "sword" | "sword-combo" = process.argv[3] === "sword" ? "sword" : process.argv[3] === "sword-combo" ? "sword-combo" : "gather";
const RIGS = ["front-turn15-faceA", "front-turn15-faceA-mirin"];
const F = 1 / 30;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const OUT_E: Curve = [0.2, 0.7, 0.4, 1]; // fast start, soft landing (strikes)
const IN_E: Curve = [0.5, 0, 0.9, 0.6]; // slow start, accelerating (the last part of a wind-up into the strike)
const IO: Curve = [0.45, 0, 0.55, 1];

const REST = { arm: 29, fold: 4, armR: 29, foldR: 4 };
const CLIPS: ClipSpec[] = [
  {
    // 1000 ms, impact 0.555 -> contact f16. Over the shoulder (axe head back behind the head), strike down and out
    // into the trunk at the side, 2-frame hitstop, recoil bounce, recover.
    id: "chop", frames: 30, loop: true, contact: 16, item: "axe", hold: 1, keep: [],
    keys: [
      [0, { arm: 40, fold: 22, alpha: 58, armR: 27, foldR: 10 }, IO],
      // wind-up behind the shoulder: the axe head drawn over the hair at the peak (order 1)
      [7, { arm: 124, fold: 12, alpha: -14, armR: 34, foldR: 22, rx: 14, px: 5, py: -4, chest: 7, head: -1, csx: 0.99, csy: 1.02, thL: -4, thR: 4, order: 1 }, IO],
      [12, { arm: 132, fold: 8, alpha: -22, armR: 35, foldR: 24, rx: 16, px: 6, py: -5, chest: 8, head: -1.5, csx: 0.99, csy: 1.02, thL: -5, thR: 5 }, IN_E],
      [14, { arm: 104, fold: 8, alpha: 40, armR: 31, foldR: 14, rx: -6, px: -2, py: 1, chest: -3, head: 1, thL: 2, thR: -2 }, "linear"],
      // contact: a level strike at chest/waist height into the trunk, stepping and leaning in
      [16, { arm: 70, fold: 6, alpha: 94, armR: 30, foldR: 10, rx: -32, px: -9, py: 7, chest: -10, head: 4, csx: 1.03, csy: 0.96, thL: 8, thR: -5 }, "linear"],
      [17, { arm: 69, fold: 6, alpha: 95, armR: 30, foldR: 10, rx: -33, px: -9, py: 7, chest: -10, head: 4, csx: 1.03, csy: 0.96, thL: 8, thR: -5 }, OUT_E],
      [20, { arm: 74, fold: 10, alpha: 78, armR: 30, foldR: 12, rx: -22, px: -5, py: 3, chest: -6, head: 2, thL: 5, thR: -3 }, IO],
      [25, { arm: 46, fold: 18, alpha: 60, armR: 28, foldR: 11, rx: -6, px: -1, py: 0, chest: -1, thL: 1, thR: -1 }, IO],
      [30, { arm: 40, fold: 22, alpha: 58, armR: 27, foldR: 10 }]
    ]
  },
  {
    // 1300 ms, impact 0.64 -> contact f24. Higher, slower raise (rise on the toes, stretch), the pick laid far back;
    // a heavy strike down to rock height with a deep squash; bounce; recover.
    id: "mine", frames: 39, loop: true, contact: 24, item: "pick", hold: 1, keep: [],
    keys: [
      [0, { arm: 28, fold: 26, alpha: 34, armR: 27, foldR: 10 }, IO],
      [14, { arm: 130, fold: 8, alpha: -26, armR: 35, foldR: 24, rx: 12, px: 5, py: -7, chest: 7, head: -2, csx: 0.98, csy: 1.03, thL: -5, thR: 5 }, IO],
      [19, { arm: 134, fold: 6, alpha: -34, armR: 36, foldR: 26, rx: 14, px: 6, py: -8, chest: 8, head: -2, csx: 0.98, csy: 1.03, thL: -5, thR: 5 }, IN_E],
      [22, { arm: 82, fold: 6, alpha: 70, armR: 31, foldR: 14, rx: -6, px: -2, py: 2, chest: -3, head: 1, thL: 2, thR: -2 }, "linear"],
      [24, { arm: 30, fold: 4, alpha: 146, armR: 31, foldR: 10, rx: -30, px: -10, py: 12, chest: -10, head: 5, csx: 1.05, csy: 0.94, thL: 7, thR: -5 }, "linear"],
      [25, { arm: 30, fold: 4, alpha: 148, armR: 31, foldR: 10, rx: -31, px: -10, py: 12, chest: -10, head: 5, csx: 1.05, csy: 0.94, thL: 7, thR: -5 }, OUT_E],
      [28, { arm: 40, fold: 8, alpha: 124, armR: 30, foldR: 12, rx: -15, px: -5, py: 5, chest: -5, head: 2, thL: 4, thR: -3 }, IO],
      [33, { arm: 31, fold: 20, alpha: 62, armR: 28, foldR: 11, rx: -4, px: -1, py: 1, chest: -1, thL: 1, thR: -1 }, IO],
      [39, { arm: 28, fold: 26, alpha: 34, armR: 27, foldR: 10 }]
    ]
  },
  {
    // 1100 ms, impact 0.43 -> the pluck lands f14. Lean in and crouch, reach down and out to the plant, grab, a quick
    // tug that snaps the hand up to the chest (lean away), then drop the pick in the pouch at the hip. Bare hands.
    id: "harvest", frames: 33, loop: true, contact: 14, item: null, hold: 1, keep: [],
    keys: [
      [0, { ...REST, arm: 24, fold: 14, armR: 24, foldR: 18 }, IO],
      [9, { arm: 60, fold: 4, alpha: 0, armR: 22, foldR: 34, rx: -14, px: -4, py: 10, chest: -9, head: 4, csx: 1.02, csy: 0.98, thL: 6, thR: -4 }, IO],
      [13, { arm: 64, fold: 6, alpha: 0, armR: 22, foldR: 36, rx: -16, px: -5, py: 11, chest: -9.5, head: 4.5, csx: 1.02, csy: 0.98, thL: 6, thR: -4 }, IN_E],
      [14, { arm: 42, fold: 58, alpha: 0, armR: 24, foldR: 30, rx: -8, px: -2, py: 3, chest: 2, head: -1, csx: 0.99, csy: 1.02, thL: 2, thR: -1 }, OUT_E],
      [17, { arm: 36, fold: 64, alpha: 0, armR: 25, foldR: 28, rx: -5, px: -1, py: 1, chest: 3, head: -1.5, thL: 1, thR: -1 }, IO],
      [24, { arm: 18, fold: 30, alpha: 0, armR: 24, foldR: 22, rx: -2, py: 3, chest: 0, head: 0 }, IO],
      [33, { ...REST, arm: 24, fold: 14, armR: 24, foldR: 18 }]
    ]
  },
  {
    // 900 ms one-shot cast (line leaves at 0.5 = f13): rod back over the head, flick forward, settle into the hold.
    id: "fish_cast", frames: 27, loop: false, contact: null, item: "pole", hold: 1, keep: [],
    keys: [
      [0, { arm: 30, fold: 40, alpha: 40, armR: 27, foldR: 10 }, IO],
      [9, { arm: 118, fold: 10, alpha: -24, armR: 33, foldR: 22, rx: 8, px: 3, py: -3, chest: 5, head: -1, thL: -3, thR: 3 }, IN_E],
      [13, { arm: 72, fold: 8, alpha: 72, armR: 30, foldR: 12, rx: -8, px: -3, py: 3, chest: -5, head: 2, csx: 1.02, csy: 0.98, thL: 3, thR: -2 }, OUT_E],
      [17, { arm: 54, fold: 16, alpha: 64, armR: 29, foldR: 10, rx: -8, px: -2, py: 2, chest: -4, head: 1.5, thL: 2, thR: -2 }, IO],
      [27, { arm: 46, fold: 30, alpha: 58, armR: 28, foldR: 10, rx: -4, px: -1, py: 1, chest: -2, head: 1 }]
    ]
  },
  {
    // Waiting on the line (ready / wait / bite / fight: the client adds the rod twitch): 2 s breath.
    id: "fish_hold", frames: 60, loop: true, contact: null, item: "pole", hold: 1, keep: [],
    keys: [
      [0, { arm: 46, fold: 30, alpha: 58, armR: 28, foldR: 10, rx: -4, px: -1, py: 1, chest: -2, head: 1 }, IO],
      [30, { arm: 48, fold: 27, alpha: 56, armR: 29, foldR: 12, rx: -4, px: -1, py: 0, chest: -1, head: 0.5, csx: 1.012, csy: 1.01 }, IO],
      [60, { arm: 46, fold: 30, alpha: 58, armR: 28, foldR: 10, rx: -4, px: -1, py: 1, chest: -2, head: 1 }]
    ]
  },
  {
    // Flag building loop (1100 ms, impact 0.555 -> f18): crouched, the flag held slanted at the side, never set down;
    // it is lifted and its butt knocked into the ground (digging the footing), the near hand braced on the knee.
    id: "flag_work", frames: 33, loop: true, contact: 18, item: "flag", hold: 1, keep: [],
    keys: [
      [0, { arm: 34, fold: 30, alpha: 26, armR: 26, foldR: 26, rx: -6, px: -2, py: 9, chest: -5, head: 2, thL: 4, thR: -3 }, IO],
      [12, { arm: 50, fold: 52, alpha: 20, armR: 28, foldR: 30, rx: -2, px: 0, py: 4, chest: 0, head: 0, csx: 0.99, csy: 1.01, thL: 2, thR: -2 }, IO],
      [15, { arm: 52, fold: 56, alpha: 18, armR: 28, foldR: 31, rx: -1, px: 0, py: 3, chest: 1, head: -0.5, csx: 0.99, csy: 1.01, thL: 2, thR: -2 }, IN_E],
      [18, { arm: 32, fold: 20, alpha: 30, armR: 25, foldR: 24, rx: -8, px: -3, py: 12, chest: -7, head: 3, csx: 1.03, csy: 0.96, thL: 5, thR: -4 }, OUT_E],
      [19, { arm: 32, fold: 21, alpha: 30, armR: 25, foldR: 24, rx: -8, px: -3, py: 12, chest: -7, head: 3, csx: 1.03, csy: 0.96, thL: 5, thR: -4 }, IO],
      [25, { arm: 33, fold: 26, alpha: 28, armR: 26, foldR: 25, rx: -7, px: -2, py: 10, chest: -6, head: 2, thL: 4, thR: -3 }, IO],
      [33, { arm: 34, fold: 30, alpha: 26, armR: 26, foldR: 26, rx: -6, px: -2, py: 9, chest: -5, head: 2, thL: 4, thR: -3 }]
    ]
  },
  {
    // The last 1 s of the build (one-shot): rise, lift the flag upright, ram it in (f17), let go (it stays planted),
    // straighten up beside it.
    id: "flag_plant", frames: 30, loop: false, contact: 17, item: "flag", hold: 1, keep: [],
    keys: [
      [0, { arm: 34, fold: 30, alpha: 26, armR: 26, foldR: 26, rx: -6, px: -2, py: 9, chest: -5, head: 2, thL: 4, thR: -3 }, IO],
      // rise and lift the flag high, upright, its butt well off the ground
      [9, { arm: 112, fold: 14, alpha: 0, armR: 34, foldR: 22, rx: 2, px: 2, py: -8, chest: 5, head: -1.5, csx: 0.98, csy: 1.03, thL: -3, thR: 3 }, IO],
      [13, { arm: 116, fold: 12, alpha: 0, armR: 35, foldR: 24, rx: 3, px: 2, py: -9, chest: 6, head: -2, csx: 0.98, csy: 1.03, thL: -3, thR: 3 }, IN_E],
      // drive it down into the ground with a dip
      [17, { arm: 40, fold: 6, alpha: 0, armR: 28, foldR: 14, rx: -8, px: -4, py: 15, chest: -8, head: 4, csx: 1.05, csy: 0.94, thL: 6, thR: -5 }, OUT_E],
      [19, { arm: 40, fold: 6, alpha: 0, armR: 28, foldR: 14, rx: -8, px: -4, py: 13, chest: -7, head: 3, csx: 1.04, csy: 0.95, thL: 6, thR: -5, planted: 1 }, IO],
      // let go and straighten up beside it
      [26, { ...REST, arm: 24, fold: 8, alpha: 0, rx: 4, px: 1, py: 0, chest: 1, head: -0.5, planted: 1 }, IO],
      [30, { ...REST, alpha: 0, rx: 4, planted: 1 }]
    ]
  }
];

// Sword combo (action combat, docs/plans/player-sword-combo.md): one clip per combo step, played from the press.
// The blade crosses the target SWING_CONTACT_MS after the press (swing 105 ms, finisher 119 ms: both in f3 =
// 100-133 ms); the recovery lasts the step's server recovery (700 / 700 / 900 ms = 21 / 21 / 27 frames) and ends on
// the turned standing pose, so a chained step starts where the last ended and an unchained one hands over to the
// stand. Hitstop is the client's (the attacker's sample clock holds 60 / 90 ms on the contact frame), not baked.
// alpha 90 = the blade level toward the target; len < 1 = the blade foreshortened (pointing toward/away from the
// viewer while it sweeps around the body).
// Rest/guard: the stand's arm with the blade held low toward the target, so a recovery settles down into it (not up
// through level, which read as an extra swing).
const SWORD_REST = { arm: 29, fold: 4, alpha: 128, armR: 29, foldR: 4 };
const SWORD_CLIPS: ClipSpec[] = [
  {
    // 1: diagonal downward slash from over the shoulder. Snap the blade up behind the shoulder (body coils back),
    // cut down across the front, contact at chest height on the way down, follow through low, recover.
    id: "sword_1", frames: 21, loop: false, contact: 3, item: "sword", hold: 1, keep: [],
    keys: [
      [0, { ...SWORD_REST }, OUT_E],
      [1, { arm: 128, fold: 22, alpha: -26, armR: 36, foldR: 24, rx: 14, px: 5, py: -4, chest: 8, head: -1.5, csx: 0.99, csy: 1.02, thL: -5, thR: 5 }, IN_E],
      [2, { arm: 114, fold: 8, alpha: 30, armR: 33, foldR: 18, rx: -6, px: -2, py: 1, chest: -2, head: 1, thL: 2, thR: -2, order: 1 }, "linear"],
      [3, { arm: 84, fold: 6, alpha: 108, armR: 30, foldR: 12, rx: -30, px: -9, py: 6, chest: -10, head: 4, csx: 1.03, csy: 0.96, thL: 11, thR: -7, order: 1 }, "linear"],
      [4, { arm: 72, fold: 6, alpha: 122, armR: 30, foldR: 12, rx: -30, px: -9, py: 7, chest: -10, head: 4, csx: 1.03, csy: 0.96, thL: 8, thR: -5, order: 1 }, OUT_E],
      [8, { arm: 44, fold: 10, alpha: 152, armR: 31, foldR: 14, rx: -24, px: -7, py: 6, chest: -8, head: 3, csx: 1.01, csy: 0.99, thL: 8, thR: -5, order: 1 }, IO],
      [13, { arm: 36, fold: 14, alpha: 140, armR: 30, foldR: 10, rx: -10, px: -3, py: 2, chest: -3, head: 1, thL: 2, thR: -2, order: 1 }, IO],
      [21, { ...SWORD_REST, order: 1 }]
    ]
  },
  {
    // 2: horizontal backhand return. The blade drawn back level behind the body (coil away), then swept around the
    // front at chest height: foreshortened as it comes round toward the viewer, full length level at the target on
    // contact, foreshortened again as it wraps away past the far side and rises; recover.
    id: "sword_2", frames: 21, loop: false, contact: 3, item: "sword", hold: 1, keep: [],
    keys: [
      [0, { ...SWORD_REST }, OUT_E],
      [1, { arm: 62, fold: 52, alpha: -78, len: 1, armR: 34, foldR: 22, rx: 12, px: 4, py: 1, chest: 7, head: -1.5, csx: 0.99, csy: 1.01, thL: -4, thR: 4, order: 1 }, IN_E],
      [2, { arm: 74, fold: 26, alpha: 104, len: 0.42, armR: 32, foldR: 16, rx: -6, px: -2, py: 2, chest: -2, head: 1, thL: 2, thR: -2, order: 1 }, "linear"],
      [3, { arm: 90, fold: 4, alpha: 92, len: 1, armR: 29, foldR: 10, rx: -28, px: -8, py: 4, chest: -9, head: 3.5, csx: 1.03, csy: 0.97, thL: 10, thR: -6, order: 1 }, "linear"],
      [4, { arm: 94, fold: 6, alpha: 86, len: 0.94, armR: 29, foldR: 10, rx: -30, px: -8, py: 4, chest: -9.5, head: 3.5, csx: 1.03, csy: 0.97, thL: 10, thR: -6, order: 1 }, OUT_E],
      [8, { arm: 104, fold: 30, alpha: 52, len: 0.5, armR: 28, foldR: 8, rx: -20, px: -6, py: 2, chest: -6, head: 2, thL: 5, thR: -3, order: 0 }, IO],
      [13, { arm: 52, fold: 22, alpha: 62, len: 0.9, armR: 29, foldR: 8, rx: -8, px: -2, py: 1, chest: -2, head: 1, thL: 2, thR: -1, order: 1 }, IO],
      [21, { ...SWORD_REST, len: 1, order: 1 }]
    ]
  },
  {
    // 3: finisher, an overhead chop with a step and lean. Rise high on the toes with the blade laid back over the
    // head, then chop straight down with a long step and a deep squash; the blade drives on down past the target and
    // stays low (heavy), then recover.
    id: "sword_3", frames: 27, loop: false, contact: 3, item: "sword", hold: 1, keep: [],
    keys: [
      [0, { ...SWORD_REST }, OUT_E],
      [1, { arm: 134, fold: 8, alpha: -44, armR: 37, foldR: 26, rx: 16, px: 6, py: -8, chest: 9, head: -2, csx: 0.98, csy: 1.04, thL: -5, thR: 5, order: 1 }, IN_E],
      [2, { arm: 124, fold: 6, alpha: 12, armR: 34, foldR: 20, rx: 2, px: 1, py: -4, chest: 3, head: 0, csx: 0.99, csy: 1.02, thL: -1, thR: 1, order: 1 }, "linear"],
      [3, { arm: 92, fold: 4, alpha: 128, armR: 31, foldR: 12, rx: -46, px: -13, py: 11, chest: -15, head: 6, csx: 1.05, csy: 0.94, thL: 18, thR: -12, order: 1 }, "linear"],
      [4, { arm: 66, fold: 4, alpha: 150, armR: 31, foldR: 12, rx: -48, px: -14, py: 14, chest: -16, head: 6, csx: 1.07, csy: 0.92, thL: 18, thR: -12, order: 1 }, OUT_E],
      [7, { arm: 48, fold: 6, alpha: 160, armR: 31, foldR: 14, rx: -48, px: -14, py: 15, chest: -16, head: 6, csx: 1.06, csy: 0.93, thL: 18, thR: -12, order: 1 }, IO],
      [12, { arm: 44, fold: 10, alpha: 156, armR: 30, foldR: 14, rx: -40, px: -12, py: 11, chest: -12, head: 4.5, csx: 1.03, csy: 0.96, thL: 14, thR: -9, order: 1 }, IO],
      [19, { arm: 34, fold: 12, alpha: 136, armR: 30, foldR: 10, rx: -12, px: -4, py: 3, chest: -4, head: 1.5, thL: 3, thR: -2, order: 1 }, IO],
      [27, { ...SWORD_REST, order: 1 }]
    ]
  }
];
const ACTIVE = SET === "sword-combo" ? SWORD_CLIPS : SET === "sword" ? [] : CLIPS;
// Sword walk (Phase 2 key poses): SWORD_WALK / swordWalkFrom in ./sword-walk.ts (shared with the stock-armour layers).

// ---------------------------------------------------------------------------------------------------------------

function bezier(c: Curve, x: number): number {
  if (c === "linear") return x;
  const [x1, y1, x2, y2] = c;
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (bx(m) < x) lo = m; else hi = m; }
  const t = (lo + hi) / 2;
  return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
}
const CH: (keyof P)[] = ["arm", "fold", "alpha", "armR", "foldR", "rx", "px", "py", "chest", "head", "csx", "csy", "thL", "thR", "len"];
const DEFAULT: Record<string, number> = { csx: 1, csy: 1, len: 1 };
/** Per-frame channel values from the keys (frames 0..n). Order and planted are stepped. */
function sampleKeys(spec: ClipSpec): P[] {
  const out: P[] = [];
  for (let f = 0; f <= spec.frames; f++) {
    let i = spec.keys.findIndex((k, j) => j + 1 < spec.keys.length && f >= k[0] && f < spec.keys[j + 1]![0]);
    if (i < 0) i = spec.keys.length - 1;
    const [f0, a, curve] = spec.keys[i]!;
    const b = spec.keys[Math.min(i + 1, spec.keys.length - 1)]![1];
    const f1 = spec.keys[Math.min(i + 1, spec.keys.length - 1)]![0];
    const u = f1 > f0 ? bezier(curve ?? "linear", (f - f0) / (f1 - f0)) : 0;
    const p: any = { order: a.order ?? 0, planted: a.planted ?? 0 };
    for (const ch of CH) {
      const va = (a as any)[ch] ?? DEFAULT[ch] ?? 0, vb = (b as any)[ch] ?? DEFAULT[ch] ?? 0;
      p[ch] = va + (vb - va) * u;
    }
    out.push(p);
  }
  return out;
}

const docs = RIGS.map((rig) => JSON.parse(readFileSync(join(IN, `${rig}.anim.json`), "utf8")));
const base = docs[0];
function skeletonFor(doc: any): Skeleton {
  const sk = new Skeleton(loadAnimDocument(doc));
  sk.setActiveSkins([Object.keys(doc.skins)[0] as string]);
  sk.setToSetupPose();
  return sk;
}
const wdeg = (sk: Skeleton, n: string) => { const w = sk.findBone(n)!.world; return (Math.atan2(w.c, w.a) * 180) / Math.PI; };
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
/** Local bone channels for a pose (arm angles solved in world space with the body applied). */
function solve(p: P): Record<string, number> {
  const local: Record<string, number> = {
    rx: p.rx ?? 0, px: p.px ?? 0, py: p.py ?? 0, chest: p.chest ?? 0, head: p.head ?? 0, csx: p.csx ?? 1, csy: p.csy ?? 1,
    thL: p.thL ?? 0, thR: p.thR ?? 0, ua: 0, uaR: 0,
    fa: -Math.max(0, p.fold - 3.9), faR: Math.max(0, p.foldR - 3.9)
  };
  const sk = skeletonFor(structuredClone(base));
  for (let it = 0; it < 3; it++) {
    applyLocal(sk, local);
    sk.updateWorldTransform("none");
    local.ua! += wrap(90 + p.arm - wdeg(sk, "upper_arm_l"));
    local.uaR! += wrap(90 - p.armR - wdeg(sk, "upper_arm_r"));
  }
  return local;
}
function applyLocal(sk: Skeleton, l: Record<string, number>): void {
  sk.setToSetupPose();
  const set = (n: string, f: (pose: any, data: any) => void) => { const b = sk.findBone(n)! as any; f(b.pose, b.data); };
  set("root", (p, d) => { p.x = d.x + l.rx!; });
  set("pelvis", (p, d) => { p.x = d.x + l.px!; p.y = d.y + l.py!; });
  set("chest", (p, d) => { p.rotation = d.rotation + l.chest!; p.scaleX = d.scaleX * l.csx!; p.scaleY = d.scaleY * l.csy!; });
  set("head", (p, d) => { p.rotation = d.rotation + l.head!; });
  set("upper_arm_l", (p, d) => { p.rotation = d.rotation + l.ua!; });
  set("forearm_l", (p, d) => { p.rotation = d.rotation + l.fa!; });
  set("upper_arm_r", (p, d) => { p.rotation = d.rotation + l.uaR!; });
  set("forearm_r", (p, d) => { p.rotation = d.rotation + l.faR!; });
  set("thigh_l", (p, d) => { p.rotation = d.rotation + l.thL!; });
  set("thigh_r", (p, d) => { p.rotation = d.rotation + l.thR!; });
}
const TIMELINE: [string, string, string, (l: Record<string, number>) => any][] = [
  ["root", "translate", "rx", (l) => ({ x: r4(l.rx!), y: 0 })],
  ["pelvis", "translate", "px", (l) => ({ x: r4(l.px!), y: r4(l.py!) })],
  ["chest", "rotate", "chest", (l) => ({ value: r4(l.chest!) })],
  ["chest", "scale", "csx", (l) => ({ x: r4(l.csx!), y: r4(l.csy!) })],
  ["head", "rotate", "head", (l) => ({ value: r4(l.head!) })],
  ["upper_arm_l", "rotate", "ua", (l) => ({ value: r4(l.ua!) })],
  ["forearm_l", "rotate", "fa", (l) => ({ value: r4(l.fa!) })],
  ["upper_arm_r", "rotate", "uaR", (l) => ({ value: r4(l.uaR!) })],
  ["forearm_r", "rotate", "faR", (l) => ({ value: r4(l.faR!) })],
  ["thigh_l", "rotate", "thL", (l) => ({ value: r4(l.thL!) })],
  ["thigh_r", "rotate", "thR", (l) => ({ value: r4(l.thR!) })]
];

/** Fist centre on the hand bone (bone-local px): where the item's grip sits. */
const GRIP_LOCAL: [number, number] = [22, 0];
const animations: Record<string, any> = {};
const manifest: Record<string, any> = {};
for (const spec of ACTIVE) {
  const frames = sampleKeys(spec);
  const locals = frames.map(solve);
  const bones: Record<string, any> = {};
  for (const [bone, tl, , value] of TIMELINE) {
    bones[bone] ??= {};
    bones[bone][tl] = locals.map((l, f) => ({ time: r4(f * F), ...value(l), curve: "linear" }));
  }
  const anim = SET === "gather" ? `gather_${spec.id}` : spec.id;
  animations[anim] = { duration: r4(spec.frames * F), loop: spec.loop, fps: 30, bones };
  // Item transform per frame (through the frames the sheet shows: 0..frames-1; one-shots also their last pose).
  const sk = skeletonFor(structuredClone(base));
  const xf: number[][] = [];
  let plantedAt: number[] | null = null;
  const count = spec.loop ? spec.frames : spec.frames + 1;
  for (let f = 0; f < count; f++) {
    applyLocal(sk, locals[f]!);
    sk.updateWorldTransform("none");
    const w = sk.findBone("hand_l")!.world;
    const gx = w.a * GRIP_LOCAL[0] + w.b * GRIP_LOCAL[1] + w.x;
    const gy = w.c * GRIP_LOCAL[0] + w.d * GRIP_LOCAL[1] + w.y;
    const alpha = frames[f]!.alpha;
    // alpha from up toward the facing side (screen-left on the unflipped rig): canvas direction.
    const deg = (Math.atan2(-Math.cos((alpha * Math.PI) / 180), -Math.sin((alpha * Math.PI) / 180)) * 180) / Math.PI;
    if (frames[f]!.planted) plantedAt ??= [r4(gx), r4(gy), r4(deg)];
    const row = frames[f]!.planted && plantedAt ? [...plantedAt, frames[f]!.order ?? 0, 1] : [r4(gx), r4(gy), r4(deg), frames[f]!.order ?? 0, 0];
    if (SET !== "gather") row.push(r4(frames[f]!.len ?? 1));
    xf.push(row);
  }
  manifest[spec.id] = { anim, frames: spec.frames, loop: spec.loop, fps: 30, contact: spec.contact, item: spec.item, hold: spec.hold, keep: spec.keep, xf };
  console.log(`${anim}: ${spec.frames} f, contact ${spec.contact}, grip f0 ${xf[0]!.slice(0, 3).join(",")}${spec.contact !== null ? ` contact ${xf[spec.contact]!.slice(0, 3).join(",")}` : ""}`);
}
const walkAnims: Record<string, any>[] = RIGS.map(() => ({}));
if (SET === "sword") {
  RIGS.forEach((_, i) => {
    walkAnims[i]!.sword_walk = swordWalkFrom(docs[i].animations.walk_in_place);
  });
  // Grip per frame, played through the AnimationState like the shipped render (the L rig; R is drawn image-flipped).
  const doc = structuredClone(base);
  doc.animations.sword_walk = walkAnims[0]!.sword_walk;
  const data = loadAnimDocument(doc);
  const sk = new Skeleton(data);
  sk.setActiveSkins([Object.keys(doc.skins)[0] as string]);
  sk.setToSetupPose();
  const st = new AnimationState(new AnimationStateData(data));
  st.setAnimation(0, "sword_walk", { loop: true });
  const xf: number[][] = [];
  let hand0 = 0;
  for (let f = 0; f < SWORD_WALK.frames; f++) {
    if (f > 0) st.update(F);
    else st.update(1e-4);
    sk.setToSetupPose();
    st.apply(sk);
    sk.updateWorldTransform("none");
    const w = sk.findBone("hand_l")!.world;
    const hand = wdeg(sk, "hand_l");
    if (f === 0) hand0 = hand;
    xf.push([r4(w.a * GRIP_LOCAL[0] + w.x), r4(w.c * GRIP_LOCAL[0] + w.y), r4(SWORD_WALK.readyDeg + wrap(hand - hand0)), 0, 0, 1]);
  }
  manifest.sword_walk = { anim: "sword_walk", frames: SWORD_WALK.frames, loop: true, fps: 30, contact: null, item: "sword", hold: 1, keep: [], xf };
  console.log(`sword_walk: ${SWORD_WALK.frames} f, grip f0 ${xf[0]!.join(",")} f14 ${xf[14]!.join(",")}`);
}
mkdirSync(OUT, { recursive: true });
RIGS.forEach((rig, i) => {
  const doc = docs[i];
  Object.assign(doc.animations, animations, walkAnims[i]);
  writeFileSync(join(OUT, `${rig}.anim.json`), JSON.stringify(doc));
});
writeFileSync(join(OUT, `${SET}-clips.json`), `${JSON.stringify({ format: `jacket-${SET}-clips@1`, gripLocal: GRIP_LOCAL, clips: manifest })}\n`);
// Sanity: the AnimationState plays the written clip to the same pose the exporter sampled (contact frame of chop).
if (SET === "gather") {
  const doc = JSON.parse(readFileSync(join(OUT, `${RIGS[0]}.anim.json`), "utf8"));
  const data = loadAnimDocument(doc);
  const sk = new Skeleton(data);
  sk.setActiveSkins([Object.keys(doc.skins)[0] as string]);
  sk.setToSetupPose();
  const st = new AnimationState(new AnimationStateData(data));
  st.setAnimation(0, "gather_chop", { loop: true });
  st.update(16 * F + 1e-4);
  st.apply(sk);
  sk.updateWorldTransform("none");
  const w = sk.findBone("hand_l")!.world;
  const e = manifest.chop.xf[16];
  const gx = w.a * GRIP_LOCAL[0] + w.x;
  console.log(`check chop f16 grip: played ${gx.toFixed(1)} vs exported ${e[0]} (y ${(w.c * GRIP_LOCAL[0] + w.y).toFixed(1)} vs ${e[1]})`);
}
