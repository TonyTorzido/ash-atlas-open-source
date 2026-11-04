// PROTOTYPE (side sword go/no-go, 2026-10-18): the live sword on the turned-side rig's near hand (hand_r, the arm drawn
// in front) and a side-view overhead chop. Run from packages/animator:
//   npx tsx scripts/views/side-sword-clips.ts
// Writes:
// - fixtures/garments/sword-side.held.json: sword-live.held.json moved onto hand_r, grip.at on the side near fist's
//   opaque centre, grip.angle solved so the idle blade points 45 deg up and forward (screen-left, the facing);
// - docs/plans/atlas-animator-demos/views/side-sword/art/sword-side-held.png: the live sword art moved (translated
//   only) so its grip lands on grip.at;
// - fixtures/clips-proto/side-sword-ready.json, side-sword-slash.json (thin trail), side-sword-slash-notrail.json.
//
// The side rig faces screen-left (-x). World angles: canvas degrees, y down (90 = down, 180 = forward). A local +rotate
// on the arm bones turns them forward (toward the facing); near arm limits: upper arm -70..105 from setup (setup hangs
// 11 deg back), elbow fold 0..70 toward the toes, hand -30..30 (unused: the wrist is turned with grip keys only).
// The chibi head reaches the near shoulder, so the fist can never go above or behind it; the windup cocks the blade
// back over the shoulder under the chin with the fist in front of the jaw (item drawn in front of the head there).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { Skeleton } from "../../src/core/skeleton.js";
import { AnimationState, AnimationStateData } from "../../src/core/animationState.js";
import { atlasPackSchema } from "../../src/core/atlasPack.js";
import { readPng, writePng } from "../../src/tools/png.js";
import { texturesFromAtlas } from "../../src/tools/validate.js";
import { softRender } from "../../src/tools/softRender.js";
import { createImage } from "../../src/tools/image.js";

type Pose = Record<string, number>;
const BONE: Record<string, [string, "rotate" | "tx" | "ty" | "sx" | "sy"]> = {
  rx: ["root", "tx"], ry: ["root", "ty"], px: ["pelvis", "tx"], py: ["pelvis", "ty"],
  csx: ["chest", "sx"], csy: ["chest", "sy"], chest: ["chest", "rotate"], neck: ["neck", "rotate"], head: ["head", "rotate"],
  clav: ["clavicle_r", "rotate"], ua: ["upper_arm_r", "rotate"], fa: ["forearm_r", "rotate"],
  uaF: ["upper_arm_l", "rotate"], faF: ["forearm_l", "rotate"],
  thN: ["thigh_r", "rotate"], shN: ["shin_r", "rotate"], ftN: ["foot_r", "rotate"],
  thF: ["thigh_l", "rotate"], shF: ["shin_l", "rotate"], ftF: ["foot_l", "rotate"]
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

const RIG = "../../docs/plans/atlas-animator-demos/views/body-side/rig/body-side-legs.anim.json";
const LIVE_HELD = "fixtures/garments/sword-live.held.json";
const LIVE_ART = "../../docs/plans/atlas-animator-demos/attacks/sword-chop/art/sword-live-held.png";
const HELD = "fixtures/garments/sword-side.held.json";
const ART_DIR = "../../docs/plans/atlas-animator-demos/views/side-sword/art";
const ART = `${ART_DIR}/sword-side-held.png`;
const rigDoc = JSON.parse(readFileSync(RIG, "utf8"));
const ox = rigDoc.canvas.originX as number;
const oy = rigDoc.canvas.originY as number;

function posed(p: Pose) {
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
const angOf = (sk: Skeleton, n: string) => { const w = sk.findBone(n)!.world; return (Math.atan2(w.c, w.a) * 180) / Math.PI; };
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

// --- the held spec on the near fist: grip.at = the fist's opaque centre at the setup pose
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(RIG.replace(/\.anim\.json$/, ".atlas.json"), "utf8")));
const pages = new Map(pack.pages.map((pg) => [pg.file, readPng(`${RIG.replace(/[^/]+$/, "")}${pg.file}`)]));
const tex = texturesFromAtlas(pack, pages);
const sk0 = posed({});
const W = rigDoc.canvas.width as number;
const H = rigDoc.canvas.height as number;
const fistImg = softRender(sk0, tex, { width: W, height: H, left: -ox, top: -oy, slotFilter: (s) => s.data.name === "hand_r" }).image;
let sx = 0, sy = 0, n = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((fistImg.data[(y * W + x) * 4 + 3] as number) >= 128) { sx += x + 0.5; sy += y + 0.5; n++; }
const at: [number, number] = [Math.round(sx / n), Math.round(sy / n)];
const live = JSON.parse(readFileSync(LIVE_HELD, "utf8"));
const [dx, dy] = [at[0] - live.grip.at[0], at[1] - live.grip.at[1]];
const liveArt = readPng(LIVE_ART);
const art = createImage(liveArt.width, liveArt.height);
for (let y = 0; y < liveArt.height; y++) for (let x = 0; x < liveArt.width; x++) {
  const tx = x + dx, ty = y + dy;
  if (tx < 0 || ty < 0 || tx >= art.width || ty >= art.height) continue;
  art.data.set(liveArt.data.subarray((y * liveArt.width + x) * 4, (y * liveArt.width + x) * 4 + 4), (ty * art.width + tx) * 4);
}
mkdirSync(ART_DIR, { recursive: true });
writePng(ART, art);

// --- poses. arm: upper arm world angle as degrees forward of straight down; fold: elbow fold (local, 0..70)
/** Canvas direction of the blade (degrees, y down): 180 = forward (screen-left), -90 = up, 0 = back. */
function pose(o: { arm: number; fold: number; offArm?: number; offFold?: number; body: Pose }): Pose {
  const p: Pose = { ...o.body, ua: 0, fa: o.fold, uaF: o.offArm ?? 0, faF: o.offFold ?? 0 };
  for (let i = 0; i < 3; i++) p.ua = (p.ua as number) + wrap(90 + o.arm - angOf(posed(p), "upper_arm_r"));
  for (const k of Object.keys(p)) p[k] = r3(p[k] as number);
  return p;
}
const READY_ALPHA = -135; // 45 deg up and forward
const READY = pose({ arm: 20, fold: 20, offArm: 2, offFold: 6, body: {} }); // far arm as the rig's own idle (2, 6)
const READY_IN: Pose = { ...READY, py: -1, chest: 0.6, head: -0.5, csx: 1.01, csy: 1.012 };
const gripAngle = r3(wrap(READY_ALPHA - angOf(posed(READY), "hand_r")));
const gripFor = (p: Pose, blade: number) => r3(wrap(blade - angOf(posed(p), "hand_r") - gripAngle));

const spec = structuredClone(live);
spec.hand = { bone: "hand_r", fistSlot: "hand_r" };
spec.grip = { ...spec.grip, at, angle: gripAngle };
spec.drawBefore = "hand_r";
spec.source = { note: `PROTOTYPE (side sword go/no-go, scripts/views/side-sword-clips.ts): sword-live.held.json (the LIVE sword sprite at the live weapon/body size) on the turned-side rig's near hand hand_r. grip.at = the side near fist's opaque centre at setup; the art is the live art translated by (${dx}, ${dy}) only. grip.angle solved for the idle carry: blade 45 deg up and forward (toward the facing, screen-left).` };
writeFileSync(HELD, `${JSON.stringify(spec, null, 1)}\n`);

// lunge toward the facing (screen-left = -x): 60 canvas px = 14 live display px at 0.2356
const LUNGE = -60;
// [frame, arm (deg forward of down), fold, blade canvas dir, off arm, body, curve]
const KEYS: [number, number, number, number, number, Pose, Curve][] = [
  // anticipation: fist up in front of the jaw, blade cocked back over the shoulder; body draws back, leans back,
  // weight back (front foot lifts in, back knee gives)
  [1, 78, 58, -12, 18, { rx: 12, chest: 6, neck: 2, head: 3, thF: -5, shF: -8, thN: 4, shN: -10 }, "linear"],
  // strike 1: the blade over the top, the arm coming down
  [2, 74, 30, -104, 6, { rx: LUNGE * 0.5, chest: -1, neck: -1, head: -1, thF: 3, thN: -2 }, "linear"],
  // contact: arm straight forward-down, the blade 20 deg below horizontal, cocked ~25 deg off the forearm line (a
  // handle along the forearm pushes the pommel out of the fist: handleInFist); lunge, lean in, front foot stepped, tiny squash; hit
  [3, 46, 4, 160, -22, { rx: LUNGE, chest: -8, neck: -3, head: -4, csx: 0.975, csy: 1.02, thF: 8, ftF: -4, thN: -6, shN: -6 }, "linear"],
  [5, 46, 4, 160, -22, { rx: LUNGE, chest: -8, neck: -3, head: -4, csx: 0.975, csy: 1.02, thF: 8, ftF: -4, thN: -6, shN: -6 }, EASE_OUT], // hitstop end
  // follow-through: blade low and forward
  [8, 30, 4, 140, -26, { rx: LUNGE * 1.05, chest: -9, neck: -3, head: -4, thF: 8, ftF: -4, thN: -6, shN: -6 }, EASE_IO],
  // recover toward the carry
  [12, 14, 14, 200, -10, { rx: LUNGE * 0.5, chest: -4, neck: -1, head: -2, thF: 4, thN: -3 }, EASE_IO]
];
const slashKeys: Key[] = [{ f: 0, p: READY, curve: "linear" }];
const grip: { time: number; value: number; curve: Curve }[] = [{ time: 0, value: 0, curve: "linear" }];
const table: unknown[] = [];
let prevG = 0;
for (const [f, arm, fold, blade, off, body, curve] of KEYS) {
  const p = pose({ arm, fold, offArm: off, offFold: off > 0 ? 10 : 4, body });
  slashKeys.push({ f, p, curve });
  // grip keys continue the previous key (unwrapped), so the blade turns the short way the clip means
  const g0 = gripFor(p, blade);
  const g = r3(prevG + wrap(g0 - prevG));
  grip.push({ time: r6(f * F), value: g, curve });
  prevG = g;
  table.push({ f, arm, fold, blade, grip: g, ua: p.ua, fa: p.fa });
}
slashKeys.push({ f: 21, p: READY });
grip.push({ time: r6(21 * F), value: 0, curve: "linear" });

const about = "PROTOTYPE side-view overhead chop (scripts/views/side-sword-clips.ts) on the turned-side rig, near hand, facing screen-left; 30 fps, 21 frames (0.7 s), from and back to side_sword_ready. f1 anticipation: fist up in front of the jaw, blade cocked back over the shoulder, body drawn back 12 px and leaning back, weight on the back foot; f2-3 strike (2 frames): the blade goes over the top and down in front; f3 contact (100 ms, the live 105 ms frame): arm straight forward-down, blade continuing it, 60 px lunge toward the facing (14 live display px), lean in, front foot stepped, squash 0.975 x 1.02, `hit`, held to f5 (2-frame hitstop, 67 ms); f8 follow-through low and forward; f12 recover; f21 ready. Item in front of everything f0.5-3.5 (the blade passes in front of the head), otherwise under the holding arm only.";
const drawPhases = [
  { from: 0, to: r6(0.5 * F), order: "hand" },
  { from: r6(0.5 * F), to: r6(3.5 * F), order: "front" },
  { from: r6(3.5 * F), to: r6(21 * F) + 1e-6, order: "hand" }
];
const base = { clip: clipFrom(slashKeys, 21, true), grip, hit: { time: r6(3 * F), holdFrames: 2 }, drawPhases };
mkdirSync("fixtures/clips-proto", { recursive: true });
writeFileSync("fixtures/clips-proto/side-sword-slash.json", `${JSON.stringify({ name: "side_sword_slash", about: `${about} Thin swipe trail along the tip path f1.8-f3, shown f2.5-f3.5.`, ...base, smears: [{ name: "swipe_b", from: r6(1.8 * F), to: r6(3 * F), show: r6(2.5 * F), hide: r6(3.5 * F), style: "swipe", widthPx: 22 }] }, null, 1)}\n`);
writeFileSync("fixtures/clips-proto/side-sword-slash-notrail.json", `${JSON.stringify({ name: "side_sword_slash_notrail", about: `${about} No trail.`, ...base }, null, 1)}\n`);
writeFileSync("fixtures/clips-proto/side-sword-ready.json", `${JSON.stringify({
  name: "side_sword_ready",
  about: "PROTOTYPE side idle carry with the live sword (scripts/views/side-sword-clips.ts): 2.0 s breath loop, the near arm hanging 4 deg forward with a 12 deg elbow fold, the blade 45 deg up and forward (toward the facing), under the holding arm only (grip constant, no grip keys). f0 is the slash's start and end pose.",
  clip: clipFrom([{ f: 0, p: READY, curve: EASE_IO }, { f: 30, p: READY_IN, curve: EASE_IO }, { f: 60, p: READY }], 60, true),
  drawPhases: [{ from: 0, to: 2.000001, order: "hand" }]
}, null, 1)}\n`);
console.log(JSON.stringify({ at, shift: [dx, dy], gripAngle }));
console.log(JSON.stringify(table, null, 0).replace(/\},\{/g, "},\n{"));
