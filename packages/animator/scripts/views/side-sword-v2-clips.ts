// PROTOTYPE (side sword round 2, 2026-10-18): two more side-view swings on the turned-side rig's near hand, same timing
// as side_sword_slash (contact f3 = 100 ms with `hit`, 2-frame hitstop, 60 px lunge, lean, step, squash), each with a
// 2-frame anticipation and the thin swipe trail. Run from packages/animator after scripts/views/side-sword-clips.ts
// (which writes fixtures/garments/sword-side.held.json and the art):
//   npx tsx scripts/views/side-sword-v2-clips.ts
// Writes fixtures/clips-proto/side-sword-slash-a.json (A: raised in front, chop down forward) and
// side-sword-slash-b.json (B: horizontal chest-height slash). Prints each key's arm / head overlap (canvas px of the
// near arm drawn under the head: the head is the last slot, so an arm on the head would vanish behind it).
//
// Conventions as scripts/views/side-sword-clips.ts: facing screen-left (-x); `arm` = the near upper arm's world angle
// in degrees forward of straight down (limit ~ -81..94), `fold` = elbow fold 0..70 (forward), `blade` = the blade's
// canvas direction (y down: 180 forward, -90 up, 0 back, 90 down); grip keys turn the blade in the fist.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { Skeleton } from "../../src/core/skeleton.js";
import { AnimationState, AnimationStateData } from "../../src/core/animationState.js";
import { atlasPackSchema } from "../../src/core/atlasPack.js";
import { readPng } from "../../src/tools/png.js";
import { texturesFromAtlas } from "../../src/tools/validate.js";
import { softRender } from "../../src/tools/softRender.js";

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
const EASE_IN: Curve = [0.5, 0, 0.9, 0.6];

const RIG = "../../docs/plans/atlas-animator-demos/views/body-side/rig/body-side-legs.anim.json";
const HELD = "fixtures/garments/sword-side.held.json";
const rigDoc = JSON.parse(readFileSync(RIG, "utf8"));
const ox = rigDoc.canvas.originX as number;
const oy = rigDoc.canvas.originY as number;
const W = rigDoc.canvas.width as number;
const H = rigDoc.canvas.height as number;
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(RIG.replace(/\.anim\.json$/, ".atlas.json"), "utf8")));
const tex = texturesFromAtlas(pack, new Map(pack.pages.map((pg) => [pg.file, readPng(`${RIG.replace(/[^/]+$/, "")}${pg.file}`)])));

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
const ARM_SLOTS = new Set(["upper_arm_r", "upper_arm_r_cap_front_fade", "forearm_r", "hand_r"]);

/** Near-arm px under the head, and the fist's opaque centre (canvas px). */
function probe(p: Pose) {
  const sk = posed(p);
  const opt = { width: W, height: H, left: -ox, top: -oy };
  const arm = softRender(sk, tex, { ...opt, slotFilter: (s) => ARM_SLOTS.has(s.data.name) }).image.data;
  const head = softRender(sk, tex, { ...opt, slotFilter: (s) => s.data.name === "head" }).image.data;
  const fist = softRender(sk, tex, { ...opt, slotFilter: (s) => s.data.name === "hand_r" }).image.data;
  let overlap = 0, fx = 0, fy = 0, n = 0;
  for (let i = 0; i < W * H; i++) {
    if ((arm[i * 4 + 3] as number) >= 128 && (head[i * 4 + 3] as number) >= 128) overlap++;
    if ((fist[i * 4 + 3] as number) >= 128) { fx += i % W; fy += Math.floor(i / W); n++; }
  }
  return { overlap, fist: [Math.round(fx / n), Math.round(fy / n)] };
}

function pose(o: { arm: number; fold: number; offArm?: number; offFold?: number; body: Pose }): Pose {
  const p: Pose = { ...o.body, ua: 0, fa: o.fold, uaF: o.offArm ?? 0, faF: o.offFold ?? 0 };
  for (let i = 0; i < 3; i++) p.ua = (p.ua as number) + wrap(90 + o.arm - angOf(posed(p), "upper_arm_r"));
  for (const k of Object.keys(p)) p[k] = r3(p[k] as number);
  return p;
}
// the idle carry of side_sword_ready (scripts/views/side-sword-clips.ts)
const READY = pose({ arm: 20, fold: 20, offArm: 2, offFold: 6, body: {} });
const gripAngle = JSON.parse(readFileSync(HELD, "utf8")).grip.angle as number;
const gripFor = (p: Pose, blade: number) => r3(wrap(blade - angOf(posed(p), "hand_r") - gripAngle));

const LUNGE = -60; // toward the facing: 60 canvas px = 14 live display px at 0.2356
const CONTACT_BODY: Pose = { rx: LUNGE, chest: -8, neck: -3, head: -4, csx: 0.975, csy: 1.02, thF: 8, ftF: -4, thN: -6, shN: -6 };
// [frame, arm, fold, blade, off arm, body, curve into the next key]
type K = [number, number, number, number, number, Pose, Curve];

function build(name: string, keys: K[], about: string, trail: { from: number; to: number }, drawPhases: { from: number; to: number; order: "back" | "front" | "hand" }[]) {
  const slashKeys: Key[] = [{ f: 0, p: READY, curve: "linear" }];
  const grip: { time: number; value: number; curve: Curve }[] = [{ time: 0, value: 0, curve: "linear" }];
  let prevG = 0;
  const table: unknown[] = [];
  for (const [f, arm, fold, blade, off, body, curve] of keys) {
    const p = pose({ arm, fold, offArm: off, offFold: off > 0 ? 10 : 4, body });
    slashKeys.push({ f, p, curve });
    const g = r3(prevG + wrap(gripFor(p, blade) - prevG));
    grip.push({ time: r6(f * F), value: g, curve });
    prevG = g;
    const pr = probe(p);
    table.push({ f, arm, fold, blade, grip: g, headOverlap: pr.overlap, fist: pr.fist });
  }
  slashKeys.push({ f: 21, p: READY });
  grip.push({ time: r6(21 * F), value: 0, curve: "linear" });
  const out = {
    name, about,
    clip: clipFrom(slashKeys, 21, true), grip, hit: { time: r6(3 * F), holdFrames: 2 },
    drawPhases: drawPhases.map((d) => ({ from: r6(d.from * F), to: d.to >= 21 ? r6(21 * F) + 1e-6 : r6(d.to * F), order: d.order })),
    smears: [{ name: "swipe_b", from: r6(trail.from * F), to: r6(trail.to * F), show: r6(2.5 * F), hide: r6(3.5 * F), style: "swipe", widthPx: 22 }]
  };
  writeFileSync(`fixtures/clips-proto/${name.replace(/^side_sword_/, "side-sword-").replace(/_/g, "-")}.json`, `${JSON.stringify(out, null, 1)}\n`);
  console.log(name);
  console.log(JSON.stringify(table).replace(/\},\{/g, "},\n{"));
}

const FOLLOW_A: K[] = [
  [5, 46, 4, 160, -22, CONTACT_BODY, EASE_OUT], // hitstop end
  [8, 30, 4, 140, -26, { ...CONTACT_BODY, rx: LUNGE * 1.05, chest: -9, csx: 1, csy: 1 }, EASE_IO],
  [12, 14, 14, 200, -10, { rx: LUNGE * 0.5, chest: -4, neck: -1, head: -2, thF: 4, thN: -3 }, EASE_IO]
];
mkdirSync("fixtures/clips-proto", { recursive: true });

// A: raised in front. f1-f2 the fist rises forward to chin height in front of the face (the head tips back to look up
// at it, giving the jaw clearance), the blade high, angled back over the front of the head; f2-f3 over the top; f3 the
// chop lands forward-down (as side_sword_slash).
build("side_sword_slash_a", [
  [1, 62, 34, -86, 12, { rx: 6, chest: 3, neck: 3, head: 5, thF: -3, shF: -5, thN: 2, shN: -6 }, EASE_OUT],
  [2, 92, 26, -70, 18, { rx: 12, chest: 6, neck: 7, head: 12, thF: -5, shF: -8, thN: 4, shN: -10 }, EASE_IN],
  [3, 46, 4, 160, -22, CONTACT_BODY, "linear"],
  ...FOLLOW_A
], "PROTOTYPE side-view overhead chop, raised in front (scripts/views/side-sword-v2-clips.ts), turned-side rig, near hand, facing screen-left; 30 fps, 21 frames (0.7 s), from and back to side_sword_ready. f1-f2 anticipation (2 frames): the fist rises forward to chin height in front of the face, the head tips back, the blade high and angled back over the front of the head, body drawn back 12 px and leaning back, weight on the back leg; f2-f3 the blade over the top (no key between); f3 contact (100 ms): arm straight forward-down, blade 20 deg below horizontal, 60 px lunge, lean in, front foot stepped, squash 0.975 x 1.02, `hit`, held to f5 (2-frame hitstop); f8 follow-through low and forward; f12 recover; f21 ready. Item in front of everything f0.5-3.5, otherwise under the holding arm. Thin swipe trail along the tip path f2-f3, shown f2.5-f3.5.",
{ from: 2, to: 3 }, [{ from: 0, to: 0.5, order: "hand" }, { from: 0.5, to: 3.5, order: "front" }, { from: 3.5, to: 21, order: "hand" }]);

// B: horizontal slash at chest height. f1-f2 the fist draws back to the hip, the blade back and level at the hip; the
// swing comes round through the viewer (not drawn between frames) and the trail is only its last part, f2.85-f3,
// rising to level in front of the chest; f3 contact: forearm up-forward, blade level forward at chest height; f5-f8 the
// follow-through carries the blade across to the far side, behind the body (draw order back), fist at the chest front.
build("side_sword_slash_b", [
  [1, 0, 40, -60, 14, { rx: 6, chest: 3, neck: 1, head: 1, thF: -3, shF: -5, thN: 2, shN: -6 }, "linear"], // the grip turns ~80 deg a frame f0-f2: linear keeps it under 2700 deg/s
  [2, -30, 60, 10, 22, { rx: 12, chest: 5, neck: 2, head: 2, thF: -5, shF: -8, thN: 4, shN: -10 }, EASE_IN],
  [3, 70, 40, 172, -22, { ...CONTACT_BODY, neck: 0, head: 2 }, "linear"],
  [5, 70, 40, 172, -22, { ...CONTACT_BODY, neck: 0, head: 2 }, "linear"], // hitstop end (linear: the grip turns 162 deg to f8)
  [8, 40, 55, 10, -26, { ...CONTACT_BODY, rx: LUNGE * 1.05, chest: -9, neck: 0, head: 2, csx: 1, csy: 1 }, EASE_IO],
  [12, 16, 30, 230, -10, { rx: LUNGE * 0.5, chest: -4, neck: -1, head: -2, thF: 4, thN: -3 }, EASE_IO]
], "PROTOTYPE side-view horizontal slash (scripts/views/side-sword-v2-clips.ts), turned-side rig, near hand, facing screen-left; 30 fps, 21 frames (0.7 s), from and back to side_sword_ready. f1-f2 anticipation (2 frames): the fist draws back to the hip, the blade back and level at hip height, body drawn back 12 px, leaning back, weight on the back leg; f2-f3 the blade comes round (through the viewer: linear, under, never drawn); f3 contact (100 ms): forearm up-forward at chest height, the blade level toward the facing, 60 px lunge, lean in, front foot stepped, squash 0.975 x 1.02, `hit`, held to f5 (2-frame hitstop); f8 follow-through across: the blade carried round to the far side, behind the body, fist at the chest front; f12 recover; f21 ready. Item in front of everything f0.5-3.5 (the crescent passes in front of the chest), behind the body f5.5-10.5, otherwise under the holding arm. Thin swipe trail along the tip path f2.85-f3 (the last of the swing, rising to level in front of the chest), shown f2.5-f3.5.",
{ from: 2.85, to: 3 }, [{ from: 0, to: 0.5, order: "hand" }, { from: 0.5, to: 3.5, order: "front" }, { from: 3.5, to: 5.5, order: "hand" }, { from: 5.5, to: 10.5, order: "back" }, { from: 10.5, to: 21, order: "hand" }]);
