/*
 * Atlas Animator, the long-cuff
 * variant. The approved jacket with longer sleeves: each forearm cuff cut moves down the forearm (along
 * the forearm bone at rest) to just above the fist, keeping its approved orientation (parallel to the
 * fist plate's top edge, which rides the same bone), and the approved art follows with a
 * deterministic edit (no new art): the sleeve's cuff zone (the fabric rows just above the cream band,
 * the band, the ink below it) moves by the same whole-pixel vector and the opened rows repeat the
 * sleeve row above the zone along the forearm direction (the fabric continues straight down the arm).
 *
 * Writes the domain (committed) and the edited art (ART_DROPS, outside the repo):
 *   npx tsx scripts/kungfu-longcuff.ts [--dy 15]
 * Inputs: the committed body rig, fixtures/garments/kungfu-jacket-shortcuff.domain.json (the short-cuff jacket) and the v3 art.
 * Output: fixtures/garments/kungfu-jacket.domain.json, the DEFAULT jacket since approved the long cuff (2026-10-16).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAnimDocument } from "../src/core/formatLoader.js";
import { Skeleton } from "../src/core/skeleton.js";
import { materialAt, materialRest, skinData, type GarmentDomain } from "../src/tools/garmentSurface.js";
import { readPng, writePng } from "../src/tools/png.js";
import type { RgbaImage } from "../src/tools/image.js";

type Pt = [number, number];
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ART_DROPS = process.env.ART_DROPS ?? "C:/Users/dev/Documents/art-drops";
const RIG = join(HERE, "../fixtures/test-rigs/body/template7-shoulder-legs.anim.json");
const BASE_DOMAIN = join(HERE, "fixtures/garments/kungfu-jacket-shortcuff.domain.json");
const OUT_DOMAIN = join(HERE, "fixtures/garments/kungfu-jacket.domain.json");
const ART_IN = "swag-kungfu-01/v3/output/kungfu-jacket-a.png";
const ART_OUT = "swag-kungfu-01/v3-longcuff/kungfu-jacket-a-longcuff.png";
/** Rows of sleeve fabric kept above the band's ink line inside the moved zone (no band edge is repeated). */
const ZONE_ABOVE_BAND = 4;

const argv = process.argv.slice(2);
const dyArg = argv.indexOf("--dy");
const DY = dyArg >= 0 ? Number(argv[dyArg + 1]) : 15;

const raw = JSON.parse(readFileSync(RIG, "utf8"));
const base: GarmentDomain = JSON.parse(readFileSync(BASE_DOMAIN, "utf8"));
const art = readPng(join(ART_DROPS, ART_IN));
const W = art.width;
const H = art.height;

// forearm direction at rest (canvas, y down): elbow -> wrist
const sk = new Skeleton(loadAnimDocument({ ...raw, animations: {} }));
sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
sk.setToSetupPose();
sk.updateWorldTransform("none");
const forearmDir = (bone: string): Pt => {
  const w = sk.getBone(bone).world;
  return [w.a, w.c];
};
const SIDES: Record<string, string> = { cuff_forearm: "forearm_l", cuff_forearm_r: "forearm_r" };

const sd = skinData(raw, base.skin);
const moves: { cut: string; v: Pt; from: Pt[]; to: Pt[] }[] = [];
const cuts = base.cuts.map((c) => {
  const bone = SIDES[c.name];
  if (c.kind !== "cuff" || !bone) return c;
  const u = forearmDir(bone);
  // a whole-pixel vector along the forearm (the art moves by exactly this)
  const v: Pt = [Math.round((DY * u[0]) / u[1]), DY];
  const from = c.points.map((mp) => materialRest(sd, mp));
  const pts = from.map((p) => [p[0] + v[0], p[1] + v[1]] as Pt);
  const inside = (q: Pt) => materialAt(sd, q, c.groups) !== null;
  // ends walked along the cut to the groups' boundary (as moveCutsDomain does)
  const edge = (end: Pt, inner: Pt): Pt => {
    const l = Math.hypot(end[0] - inner[0], end[1] - inner[1]) || 1;
    const d: Pt = [(end[0] - inner[0]) / l, (end[1] - inner[1]) / l];
    const at = (s: number): Pt => [end[0] + d[0] * s, end[1] + d[1] * s];
    if (inside(end)) { let s = 0; while (s < 80 && inside(at(s + 0.25))) s += 0.25; return at(s); }
    for (let s = 0.25; s < 80; s += 0.25) if (inside(at(-s))) return at(-s);
    throw new Error(`${c.name}: end ${end.map((x) => x.toFixed(1))} finds no body material`);
  };
  const n = pts.length;
  pts[0] = edge(pts[0] as Pt, pts[Math.min(3, n - 1)] as Pt);
  pts[n - 1] = edge(pts[n - 1] as Pt, pts[Math.max(0, n - 4)] as Pt);
  const points = pts.map((p) => {
    const mp = materialAt(sd, p, c.groups);
    if (!mp) throw new Error(`${c.name}: point ${p.map((x) => x.toFixed(1))} leaves ${c.groups.join(",")}`);
    return mp;
  });
  moves.push({ cut: c.name, v, from, to: pts });
  return { ...c, points };
});

// --- the art edit, one sleeve per moved cuff
const at = (x: number, y: number) => (y * W + x) * 4;
const isCream = (o: number) => (art.data[o + 3] as number) >= 128 && (art.data[o] as number) > 200 && (art.data[o + 1] as number) > 180 && (art.data[o + 2] as number) > 140;
const out: RgbaImage = { width: W, height: H, data: new Uint8Array(art.data) };
const edits: Record<string, unknown>[] = [];
for (const m of moves) {
  const xs = m.from.map((p) => p[0]);
  const xa = Math.floor(Math.min(...xs));
  const xb = Math.ceil(Math.max(...xs));
  const cutY = Math.round(m.from.reduce((s, p) => s + p[1], 0) / m.from.length);
  // the cream band: topmost cream row within 30 px above the cut, in the middle half of the sleeve
  let bandTop = -1;
  const mx0 = Math.round(xa + (xb - xa) * 0.25);
  const mx1 = Math.round(xa + (xb - xa) * 0.75);
  for (let y = cutY - 30; y <= cutY && bandTop < 0; y++) {
    let n = 0;
    for (let x = mx0; x <= mx1; x++) if (isCream(at(x, y))) n++;
    if (n > (mx1 - mx0) * 0.6) bandTop = y;
  }
  if (bandTop < 0) throw new Error(`${m.cut}: no cream band above the cut`);
  // the band's upper ink line (outline-coloured rows right above the cream), then ZONE_ABOVE_BAND fabric rows
  const isInk = (o: number) => (art.data[o + 3] as number) >= 128 && (art.data[o] as number) - (art.data[o + 2] as number) > 25 && (art.data[o] as number) < 120;
  let inkTop = bandTop;
  for (;;) {
    let n = 0;
    for (let x = mx0; x <= mx1; x++) if (isInk(at(x, inkTop - 1))) n++;
    if (n > (mx1 - mx0) * 0.6) inkTop--; else break;
  }
  const g = inkTop - ZONE_ABOVE_BAND;
  // the sleeve below row g: the painted component reached from the sleeve middle of row g (rows >= g only);
  // sleeve and torso are apart there (the underarm wedge), checked below
  const inZone = new Uint8Array(W * H);
  const stack: number[] = [];
  const seedX = Math.round((xa + xb) / 2);
  if ((art.data[at(seedX, g) + 3] as number) === 0) throw new Error(`${m.cut}: seed off the art`);
  stack.push(g * W + seedX);
  inZone[g * W + seedX] = 1;
  let minX = W;
  let maxX = 0;
  let maxY = 0;
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % W;
    const y = (i - x) / W;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= W || ny < g || ny >= H) continue;
      const k = ny * W + nx;
      if (inZone[k] || (art.data[k * 4 + 3] as number) === 0) continue;
      inZone[k] = 1;
      stack.push(k);
    }
  }
  if (maxX - minX > (xb - xa) + 40) throw new Error(`${m.cut}: the sleeve zone joins the torso (x ${minX}-${maxX})`);
  const [vx, vy] = m.v;
  // clear the old zone, then write the moved zone and the repeated band between
  for (let y = g; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (inZone[y * W + x]) out.data.fill(0, at(x, y), at(x, y) + 4);
  for (let y = g; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if (!inZone[y * W + x]) continue;
    const tx = x + vx;
    const ty = y + vy;
    out.data.set(art.data.subarray(at(x, y), at(x, y) + 4), at(tx, ty));
  }
  // opened rows g .. g+vy-1: the sleeve row g-1, followed along the forearm (shear vx/vy per row); its
  // fabric texels become the row's median fabric (a fold-shading mark crossing that row is not smeared)
  const fab: number[][] = [[], [], []];
  for (let x = minX; x <= maxX; x++) {
    const o = at(x, g - 1);
    if (!inZone[g * W + x] || (art.data[o + 3] as number) < 250 || isInk(o)) continue;
    for (let k = 0; k < 3; k++) (fab[k] as number[]).push(art.data[o + k] as number);
  }
  const fabric = fab.map((c) => c.sort((p, q) => p - q)[c.length >> 1] as number);
  for (let y = g; y < g + vy; y++) {
    const sx = Math.round(((y - g + 1) * vx) / vy);
    for (let x = minX - 2; x <= maxX + 2; x++) {
      const src = at(x, g - 1);
      // only the sleeve's own columns of row g-1 (the zone's top row tells which)
      if (!inZone[g * W + x]) continue;
      if ((art.data[src + 3] as number) >= 250 && !isInk(src)) out.data.set([...fabric, 255], at(x + sx, y));
      else out.data.set(art.data.subarray(src, src + 4), at(x + sx, y));
    }
  }
  edits.push({ cut: m.cut, v: m.v, bandTop, inkTop, zoneTop: g, fabric, zone: [minX, g, maxX, maxY] });
}
mkdirSync(dirname(join(ART_DROPS, ART_OUT)), { recursive: true });
writePng(join(ART_DROPS, ART_OUT), out);

const domain = {
  ...base,
  cuts,
  source: {
    ...(base.source ?? {}),
    art: `ART_DROPS/${ART_OUT}`,
    longCuff: {
      from: "fixtures/garments/kungfu-jacket-shortcuff.domain.json",
      dy: DY,
      rule: "scripts/kungfu-longcuff.ts: cuff cuts moved by a whole-pixel vector along the rest forearm, ends re-walked to the forearm boundary; the art's cuff zone moved by the same vector, the sleeve row above it repeated along the forearm",
      edits
    }
  }
};
writeFileSync(OUT_DOMAIN, `${JSON.stringify(domain, null, 1)}\n`);
for (const m of moves) process.stdout.write(`${m.cut}: v ${m.v.join(",")}; rest y ${(m.from[0] as Pt)[1].toFixed(1)} -> ${m.to.map((p) => p[1].toFixed(1)).join(" ")}\n`);
process.stdout.write(`${JSON.stringify(edits)}\n-> ${OUT_DOMAIN}\n-> ${join(ART_DROPS, ART_OUT)}\n`);
