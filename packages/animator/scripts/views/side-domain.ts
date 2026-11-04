/*
 * Atlas Animator: original implementation.
 *
 * Multi-view phase 2c, step 2 (packages/animator/README.md): the turned-side garment domain of a
 * front domain, derived from the side body with the front's own rules, never warped from the front art.
 *   npx tsx scripts/views/side-domain.ts <side rig.anim.json> <front rig.anim.json> <front domain.json> <out dir> [--name jacketb]
 * The side body is three separate skin meshes (far arm under the torso sheet, the torso sheet, the near arm over
 * it), so the side garment is three separable pieces, one domain each (same margin, stroke, template, core and
 * offset rules as the front; each piece is built on its own mesh and drawn in that mesh's layer, so the
 * overlaps are the body's own: near sleeve over the torso piece, the torso piece over the far sleeve):
 *   <name>-torso.domain.json      torso mesh: neckline (collar) + hem
 *   <name>-near.domain.json       near arm mesh (upper arm + forearm): cuff on the forearm
 *   <name>-far.domain.json        far arm mesh: cuff on the forearm
 * Landmarks, all measured on the front and re-applied on the side body:
 *   hem       the front hem cut's mean position along the chest bone, as a fraction of the bone's length; the side
 *             hem crosses the side torso sheet perpendicular to the side chest bone at the same fraction;
 *   collar    the front neckline's end and centre fractions along the chest bone; the side neckline runs across the
 *             neck column from the back edge (at the end fraction) to the throat (at the centre fraction);
 *   cuffs     the front cuff cut's offset from the bare wrist dip (tools/cuffGap.ts wristDip, along the hand bone),
 *             re-applied from each side arm's own wrist dip, across the hand bone's axis.
 * Each cut's ends are found on the mesh boundary of its groups by bisection (0.25 px), points every few px.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { Skeleton } from "../../src/core/skeleton.js";
import { AnimationState, AnimationStateData } from "../../src/core/animationState.js";
import { armRaiseClip, diagClip, envelopePoses, flexClip, loadBodyParts, sidesFromLimits, sweepClip } from "../../src/cli/garmentImport.js";
import { atlasPackSchema } from "../../src/core/atlasPack.js";
import { readPng } from "../../src/tools/png.js";
import { texturesFromAtlas } from "../../src/tools/validate.js";
import { materialAt, materialRest, skinData, type GarmentCut, type GarmentDomain, type MaterialPoint, type SkinData } from "../../src/tools/garmentSurface.js";
import { armDipIds, sleevedArms, wristDip, type CuffGapArm } from "../../src/tools/cuffGap.js";
import type { RgbaImage } from "../../src/tools/image.js";

type Pt = [number, number];
const [sidePath, frontPath, frontDomainPath, outDir] = process.argv.slice(2) as [string, string, string, string];
const nameIdx = process.argv.indexOf("--name");
const NAME = nameIdx > 0 ? (process.argv[nameIdx + 1] as string) : "jacketb";
const bodyIdx = process.argv.indexOf("--body");
const BODY = bodyIdx > 0 ? (process.argv[bodyIdx + 1] as string) : "fixtures/canonical/body-side/body-side.body.json";
if (!outDir) throw new Error("usage: side-domain.ts <side rig> <front rig> <front domain> <out dir> [--name n]");

interface Rig { raw: any; sk: Skeleton; tex: Map<string, RgbaImage>; ox: number; oy: number }
function loadRig(path: string): Rig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const atlasPath = path.replace(/\.anim\.json$/, ".atlas.json");
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
  const pages = new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(atlasPath), p.file))] as [string, RgbaImage]));
  const sk = new Skeleton(loadAnimDocument(raw));
  sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  return { raw, sk, tex: texturesFromAtlas(pack, pages), ox: raw.canvas.originX, oy: raw.canvas.originY };
}
/** Canvas point -> bone-local (u along the bone, v across). */
const toLocal = (r: Rig, bone: string, p: Pt): Pt => { const o = { x: 0, y: 0 }; r.sk.getBone(bone).worldToLocal(p[0] - r.ox, p[1] - r.oy, o); return [o.x, o.y]; };
const toCanvas = (r: Rig, bone: string, u: number, v: number): Pt => { const o = { x: 0, y: 0 }; r.sk.getBone(bone).localToWorld(u, v, o); return [o.x + r.ox, o.y + r.oy]; };
const boneLen = (r: Rig, bone: string) => (r.raw.bones as any[]).find((b) => b.name === bone).length as number;

const front = loadRig(frontPath);
const side = loadRig(sidePath);
const fdom = JSON.parse(readFileSync(frontDomainPath, "utf8")) as GarmentDomain;
const fsd = skinData(front.raw, fdom.skin);
const restPts = (c: GarmentCut) => c.points.map((mp) => materialRest(fsd, mp));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const CHEST = "chest";

// --- front landmarks
const fHem = fdom.cuts.find((c) => c.kind === "hem") as GarmentCut;
const fNeck = fdom.cuts.find((c) => c.kind === "neckline") as GarmentCut;
const hemFrac = mean(restPts(fHem).map((p) => toLocal(front, CHEST, p)[0])) / boneLen(front, CHEST);
const neckU = restPts(fNeck).map((p) => toLocal(front, CHEST, p)[0]);
const neckEndFrac = Math.max(neckU[0] as number, neckU[neckU.length - 1] as number) / boneLen(front, CHEST);
const neckMidFrac = Math.min(...neckU) / boneLen(front, CHEST);
const bareWin = (r: Rig) => ({ width: r.raw.canvas.width + 400, height: r.raw.canvas.height + 400, left: -r.ox - 200, top: -r.oy - 200 });
const dipOf = (r: Rig, arm: CuffGapArm) => wristDip(r.sk, armDipIds(r.sk, r.tex, arm, bareWin(r)), arm).uDip;
const fArms = sleevedArms(front.raw, fdom.cuts.filter((c) => c.kind === "cuff").flatMap((c) => c.groups));
const cuffOffsets = fArms.map((arm) => {
  const cut = fdom.cuts.find((c) => c.kind === "cuff" && c.groups.includes(arm.limbSlot)) as GarmentCut;
  return mean(restPts(cut).map((p) => toLocal(front, arm.handBone, p)[0])) - dipOf(front, arm);
});
const cuffOffset = mean(cuffOffsets);

// --- the importer's pose envelope on the bare side body (the --body arm clips, then the walk and idle clips): each
// arm's wrist dip moves as the forearm mesh bends, and the cuff gate reads the dip of every pose, so a cuff placed
// at the rest dip leaves the wrist above a more distal dip bare (the far wrist: -36 at rest, -27 in a raise)
const bodyParts = loadBodyParts(BODY);
const nearPart = bodyParts.parts.find((p) => p.kind === "arm" && p.depth === "near");
const farPart = nearPart && bodyParts.parts.find((p) => p.name === nearPart.partner);
if (!nearPart || !farPart) throw new Error(`${BODY}: no near arm part with a partner`);
const envDoc = structuredClone(side.raw);
{
  const arm: [string, string] = [nearPart.chain[0] as string, farPart.chain[0] as string];
  const elbow: [string, string] = [nearPart.chain[1] as string, farPart.chain[1] as string];
  const sides = sidesFromLimits(envDoc, [arm[0], arm[1], elbow[0], elbow[1]]);
  envDoc.animations.arm_raise = armRaiseClip(arm, elbow, 100, 58, 68, sides);
  envDoc.animations.flex = flexClip(arm, elbow, 58, 68, sides);
  envDoc.animations.diag = diagClip(arm, elbow, sides);
  envDoc.animations.sweep = sweepClip(arm, elbow, sides);
}
const envLoaded = loadAnimDocument(envDoc);
const envSk = new Skeleton(envLoaded);
envSk.setActiveSkins([Object.keys(envDoc.skins)[0] as string]);
const envState = new AnimationStateData(envLoaded);
const envPoses = envelopePoses(envDoc);
function envelopeDips(arm: CuffGapArm): number[] {
  return envPoses.map((pose) => {
    envSk.setToSetupPose();
    const st = new AnimationState(envState);
    st.setAnimation(0, pose.clip, { loop: false });
    st.update(pose.t);
    st.apply(envSk);
    envSk.updateWorldTransform("none");
    return wristDip(envSk, armDipIds(envSk, side.tex, arm, bareWin(side)), arm).uDip;
  });
}

// --- side cuts
/** A cut along canvas segment a->b clipped to the groups' material: ends bisected onto the boundary. */
function cutAlong(sd: SkinData, groups: string[], a: Pt, b: Pt, n: number): MaterialPoint[] {
  const at = (t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const inside = (t: number) => materialAt(sd, at(t), groups) !== null;
  const N = 400;
  let t0 = -1;
  let t1 = -1;
  for (let i = 0; i <= N; i++) if (inside(i / N)) { if (t0 < 0) t0 = i / N; t1 = i / N; }
  if (t0 < 0) throw new Error(`cut misses ${groups.join(",")}`);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bis = (tin: number, tout: number) => { while (Math.abs(tout - tin) * len > 0.25) { const m = (tin + tout) / 2; if (inside(m)) tin = m; else tout = m; } return tin; };
  const s0 = t0 > 0 ? bis(t0, t0 - 1 / N) : 0;
  const s1 = t1 < 1 ? bis(t1, t1 + 1 / N) : 1;
  const pts: MaterialPoint[] = [];
  for (let i = 0; i < n; i++) {
    let p = at(s0 + ((s1 - s0) * i) / (n - 1));
    // each end moves to the nearer vertex of the boundary edge it leaves through a cut that leaves the body beside a
    // boundary corner keeps that corner's short boundary edge piece in the outline, a hook at the corner
    if (i === 0 || i === n - 1) { const v = boundaryVertexNear(sd, groups, p); if (v) p = v; }
    const mp = materialAt(sd, p, groups);
    if (mp) pts.push(mp);
  }
  return pts;
}
/** The bisected end lies within SNAP_PX of the boundary edge it leaves through. */
const SNAP_PX = 1;
/** The nearer endpoint of the boundary edge (of the groups' triangles) closest to p, when within SNAP_PX. */
function boundaryVertexNear(sd: SkinData, groups: string[], p: Pt): Pt | null {
  let best: Pt | null = null;
  let bd = SNAP_PX;
  for (let t = 0; t < sd.nT; t++) {
    if (!groups.includes(sd.groupOf[t] as string)) continue;
    for (let k = 0; k < 3; k++) {
      const a = sd.T[t * 3 + k] as number;
      const b = sd.T[t * 3 + ((k + 1) % 3)] as number;
      if (!sd.boundary.has(a < b ? a * 1048576 + b : b * 1048576 + a)) continue;
      const pa = sd.P[a] as Pt;
      const pb = sd.P[b] as Pt;
      const ex = pb[0] - pa[0];
      const ey = pb[1] - pa[1];
      const l2 = ex * ex + ey * ey || 1;
      const u = Math.max(0, Math.min(1, ((p[0] - pa[0]) * ex + (p[1] - pa[1]) * ey) / l2));
      const d = Math.hypot(pa[0] + ex * u - p[0], pa[1] + ey * u - p[1]);
      if (d < bd) { bd = d; best = u < 0.5 ? pa : pb; }
    }
  }
  return best;
}
/**
 * The cut's ends carried out to the body edge as the covered side reads it (garmentSurface coveredTest: the segment
 * from a point to its group's seed crosses the cut an odd number of times): where the edge bulges past a cut end
 * (the back of the neck widens under the head), material beyond the end, on the uncovered side, still sees the
 * seed past the end and counts as covered. Each end moves to the material point of that side with the widest seed
 * angle past it (within TIGHT_R px), the cut is redrawn through it, until no such point is left.
 */
const TIGHT_R = 20;
function tightCut(sd: SkinData, groups: string[], a: Pt, b: Pt, n: number, seedPt: Pt): MaterialPoint[] {
  let ends: [Pt, Pt] = [a, b];
  let pts = cutAlong(sd, groups, a, b, n);
  for (let iter = 0; iter < 4; iter++) {
    const rest = pts.map((mp) => materialRest(sd, mp));
    const e: [Pt, Pt] = [rest[0] as Pt, rest[rest.length - 1] as Pt];
    let moved = false;
    for (const k of [0, 1] as const) {
      const end = e[k];
      const other = e[1 - k] as Pt;
      const ang = (q: Pt) => { const u: Pt = [end[0] - seedPt[0], end[1] - seedPt[1]]; const v: Pt = [q[0] - seedPt[0], q[1] - seedPt[1]]; return Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]); };
      const sgn = -Math.sign(ang(other));
      const side = (q: Pt) => (other[0] - end[0]) * (q[1] - end[1]) - (other[1] - end[1]) * (q[0] - end[0]);
      const seedSide = Math.sign(side(seedPt));
      let best: Pt | null = null;
      // past the end by at least 0.25 px at the end's distance from the seed
      let bestA = 0.25 / Math.hypot(end[0] - seedPt[0], end[1] - seedPt[1]);
      for (let y = end[1] - TIGHT_R; y <= end[1] + TIGHT_R; y += 0.5) for (let x = end[0] - TIGHT_R; x <= end[0] + TIGHT_R; x += 0.5) {
        const q: Pt = [x, y];
        if (Math.hypot(x - end[0], y - end[1]) > TIGHT_R || Math.sign(side(q)) === seedSide || materialAt(sd, q, groups) === null) continue;
        const aq = sgn * ang(q);
        if (aq > bestA) { bestA = aq; best = q; }
      }
      if (!best) continue;
      const d = Math.hypot(best[0] - other[0], best[1] - other[1]);
      const dir: Pt = [(best[0] - other[0]) / d, (best[1] - other[1]) / d];
      const far: Pt = [best[0] + dir[0] * 4, best[1] + dir[1] * 4];
      const near: Pt = [other[0] - dir[0] * 4, other[1] - dir[1] * 4];
      ends = k === 0 ? [far, near] : [near, far];
      moved = true;
      break;
    }
    if (!moved) return pts;
    pts = cutAlong(sd, groups, ends[0], ends[1], n);
  }
  throw new Error(`tightCut: ${groups.join(",")} cut ends did not settle`);
}
const torsoSd = skinData(side.raw, { slot: "torso", attachment: "skin" });
const sideChest = boneLen(side, CHEST);
const hemC = toCanvas(side, CHEST, hemFrac * sideChest, 0);
const hemA = toCanvas(side, CHEST, hemFrac * sideChest, -400);
const hemB = toCanvas(side, CHEST, hemFrac * sideChest, 400);
// the neck column: back edge (screen right, the turned figure faces left) at the end fraction, throat at the centre fraction
const neckA = toCanvas(side, CHEST, neckEndFrac * sideChest, 0);
const neckB = toCanvas(side, CHEST, neckMidFrac * sideChest, 0);
const neckDir: Pt = [neckB[0] - neckA[0], neckB[1] - neckA[1]];
// a line through both landmark rows, spanning the neck column (canvas x from the back edge to the throat)
const neckLine = (): [Pt, Pt] => {
  const yBack = neckA[1];
  const yThroat = neckB[1];
  return [[neckA[0] + 200, yBack], [neckA[0] - 200, yThroat]];
};
void neckDir;
const [nlA, nlB] = neckLine();
const pieces: { key: string; skin: { slot: string; attachment: string }; groups: string[]; cuts: GarmentCut[]; seeds: { group: string; point: MaterialPoint }[] }[] = [];
const sdOf = (slot: string, attachment: string) => skinData(side.raw, { slot, attachment });
const seed = (sd: SkinData, group: string, bone: string): { group: string; point: MaterialPoint } => {
  // the bone's midpoint, else the nearest point on the bone's medial band that lies on the group's material
  for (const dv of [0, 6, -6, 12, -12, 20, -20, 30, -30]) for (const f of [0.5, 0.6, 0.4, 0.7, 0.3, 0.8]) {
    const mp = materialAt(sd, toCanvas(side, bone, boneLen(side, bone) * f, dv), [group]);
    if (mp) return { group, point: mp };
  }
  throw new Error(`no seed on ${group}`);
};
const torsoSeed = seed(torsoSd, "torso", CHEST);
pieces.push({
  key: "torso",
  skin: { slot: "torso", attachment: "skin" },
  groups: ["torso"],
  cuts: [
    { name: "hem", kind: "hem", groups: ["torso"], points: cutAlong(torsoSd, ["torso"], hemA, hemB, 40) },
    { name: "neckline", kind: "neckline", groups: ["torso"], points: tightCut(torsoSd, ["torso"], nlA, nlB, 19, materialRest(torsoSd, torsoSeed.point)), endsAbove: "head", drop: fNeck.drop ?? 0 }
  ],
  seeds: [torsoSeed]
});
const sideArms: Record<string, CuffGapArm> = {};
const cuffInfo: Record<string, unknown> = {};
for (const [key, slot] of [["near", "upper_arm_r"], ["far", "upper_arm_l"]] as const) {
  const att = Object.keys(side.raw.skins[Object.keys(side.raw.skins)[0] as string].attachments[slot])[0] as string;
  const sd = sdOf(slot, att);
  const groups = Object.keys(sd.skin.groups) as string[];
  const fore = groups.find((g) => g !== slot) as string;
  const arm = sleevedArms(side.raw, [fore])[0] as CuffGapArm;
  sideArms[key] = arm;
  const restDip = dipOf(side, arm);
  const dip = Math.max(restDip, ...envelopeDips(arm));
  const u = dip + cuffOffset;
  const cut = cutAlong(sd, [fore], toCanvas(side, arm.handBone, u, -200), toCanvas(side, arm.handBone, u, 200), 16);
  cuffInfo[key] = { arm, uDipRest: restDip, uDip: dip, uCut: Number(u.toFixed(2)) };
  pieces.push({ key, skin: { slot, attachment: att }, groups, cuts: [{ name: `cuff_${fore}`, kind: "cuff", groups: [fore], points: cut }], seeds: groups.map((g) => seed(sd, g, (side.raw.slots as any[]).find((s) => s.name === g).bone)) });
}
mkdirSync(outDir, { recursive: true });
const source = { derivedBy: "scripts/views/side-domain.ts", frontDomain: frontDomainPath.replace(/\\/g, "/"), hemFrac: Number(hemFrac.toFixed(4)), neckEndFrac: Number(neckEndFrac.toFixed(4)), neckMidFrac: Number(neckMidFrac.toFixed(4)), cuffOffsetFromDip: Number(cuffOffset.toFixed(2)), frontCuffOffsets: cuffOffsets.map((x) => Number(x.toFixed(2))), cuffs: cuffInfo, hemCentre: hemC.map((x) => Number(x.toFixed(1))) };
for (const p of pieces) {
  const dom: GarmentDomain = { format: "atlas-garment-domain/1", name: `${NAME}${p.key === "torso" ? "" : `_${p.key}`}`, skin: p.skin, groups: p.groups, cuts: p.cuts, seeds: p.seeds, gaps: [], margin: fdom.margin, ...(fdom.stroke ? { stroke: fdom.stroke } : {}), ...(fdom.template ? { template: fdom.template } : {}), source: { ...source, piece: p.key } };
  const out = join(outDir, `${NAME}-${p.key}.domain.json`);
  writeFileSync(out, `${JSON.stringify(dom, null, 1)}\n`);
  const sd = skinData(side.raw, p.skin);
  process.stdout.write(`${out}: ${p.cuts.map((c) => { const r = c.points.map((mp) => materialRest(sd, mp)); return `${c.name} ${c.points.length} pts ${r[0]?.map(Math.round)} -> ${r[r.length - 1]?.map(Math.round)}`; }).join("; ")}\n`);
}
// the structure map's landmarks (scripts/views/structure_map.py side): rest cut polylines, each cuff's elbow-ward
// unit vector (minus the hand bone's axis), the pieces in draw order
const landmarks = { format: "atlas-side-landmarks/1", order: ["far", "torso", "near"], cuts: {} as Record<string, number[][]>, elbowward: {} as Record<string, number[]> };
for (const p of pieces) {
  const sd = skinData(side.raw, p.skin);
  for (const c of p.cuts) landmarks.cuts[`${p.key}:${c.kind}`] = c.points.map((mp) => materialRest(sd, mp).map((x) => Number(x.toFixed(2))));
}
for (const [key, arm] of Object.entries(sideArms)) {
  const a = toCanvas(side, arm.handBone, 0, 0);
  const b = toCanvas(side, arm.handBone, -1, 0);
  landmarks.elbowward[key] = [b[0] - a[0], b[1] - a[1]].map((x) => Number(x.toFixed(4)));
}
writeFileSync(join(outDir, `${NAME}-side.landmarks.json`), `${JSON.stringify(landmarks, null, 1)}\n`);
process.stdout.write(`${JSON.stringify(source)}\n`);
