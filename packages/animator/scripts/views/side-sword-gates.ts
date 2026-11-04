/*
 * PROTOTYPE (side sword go/no-go): the turned-side rig's full-body gates (cli/fullBody.ts: near arm, far arm; plus the
 * painted-reveal gates of scripts/views/side-validate.ts) on EVERY 30 fps frame of the held clips of a dressed rig,
 * instead of their swept poses (tools/surface/fullBodyGates.ts `frames`). Run from packages/animator:
 *   npx tsx scripts/views/side-sword-gates.ts <dressed rig.anim.json> <out.json> <clip> [<clip> ...]
 * The parts are rebuilt from fixtures/canonical/body-side/body-side.body.json for their limits and distortion
 * allowances (as cli/fullBody.ts). Exit 1 on a failed gate.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { Skeleton } from "../../src/core/skeleton.js";
import { AnimationState, AnimationStateData } from "../../src/core/animationState.js";
import { atlasPackSchema } from "../../src/core/atlasPack.js";
import { readPng } from "../../src/tools/png.js";
import { texturesFromAtlas } from "../../src/tools/validate.js";
import { loadFullBody, partSlots } from "../../src/tools/surface/fullBody.js";
import { farArmGates, farRevealGates, nearArmGates, type FramePose, type GatePart } from "../../src/tools/surface/fullBodyGates.js";
import { buildRig } from "../../src/tools/surface/output.js";
import { validationCompanion } from "../../src/tools/surface/validationCompanion.js";
import { DEFAULT_ALLOWANCE, type DistortionAllowance } from "../../src/tools/validateGeometry.js";
import type { GateResult } from "../../src/tools/surface/armLayerGates.js";

const BODY = "fixtures/canonical/body-side/body-side.body.json";
const SLOTS_OF = "../../docs/plans/atlas-animator-demos/views/body-side/session10/fullbody-gates.json";
const [rigPath, outPath, ...clips] = process.argv.slice(2) as [string, string, ...string[]];
if (!rigPath || !outPath || !clips.length) throw new Error("usage: side-sword-gates.ts <dressed rig> <out.json> <clip> [<clip> ...]");

const raw = JSON.parse(readFileSync(rigPath, "utf8"));
const atlasPath = rigPath.replace(/\.anim\.json$/, ".atlas.json");
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
const textures = texturesFromAtlas(pack, new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(atlasPath), p.file))])));
const doc = loadAnimDocument(raw, { source: resolve(rigPath) });

// every frame of every clip, with its sampled local rotation offsets
const sk = new Skeleton(doc);
sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
const data = new AnimationStateData(doc);
const frames: FramePose[] = [];
for (const c of clips) {
  const n = Math.round(raw.animations[c].duration * 30);
  for (let f = 0; f <= n; f++) {
    sk.setToSetupPose();
    const st = new AnimationState(data);
    st.setAnimation(0, c, { loop: false });
    st.update(f / 30);
    st.apply(sk);
    const offsets: Record<string, number> = {};
    for (const b of sk.bones) { const d = b.pose.rotation - b.data.rotation; if (Math.abs(d) > 1e-9) offsets[b.data.name] = d; }
    frames.push({ name: `${c} f${f}`, rotate: {}, clip: { name: c, time: f / 30 }, offsets });
  }
}

const body = loadFullBody(resolve(BODY));
const gateParts = new Map<string, GatePart>();
for (const part of body.parts) {
  const rig = buildRig(part.preset, part.dir);
  const companion = validationCompanion(rig);
  const armSheet = `${part.preset.skin.slot}/${part.preset.skin.attachment}`;
  const regionOf = new Map<number, string>();
  for (const [region, ids] of Object.entries(companion.regions[armSheet]?.triangles ?? {})) for (const t of ids as number[]) regionOf.set(t, region);
  const allowanceOf = (key: string, t: number): DistortionAllowance => (key === armSheet ? (companion.allowances[regionOf.get(t) ?? "default"] ?? companion.allowances.default ?? DEFAULT_ALLOWANCE) : (companion.allowances.default ?? DEFAULT_ALLOWANCE)) as DistortionAllowance;
  gateParts.set(part.spec.name, { spec: part.spec, preset: part.preset, limits: [...rig.limits, ...rig.clipLimits], allowanceOf, gameScale: companion.gameScale });
}
const slotsOf = JSON.parse(readFileSync(SLOTS_OF, "utf8")).slotsOf as Record<string, string[]>;
const armSlots = (name: string) => {
  const part = body.parts.find((p) => p.spec.name === name);
  const off = new Set([...(part?.preset.assembly?.sheets ?? []).map((s) => s.slot), ...(part?.preset.regions ?? []).filter((r) => !part?.preset.chain.bones.includes(r.bone)).map((r) => r.slot)]);
  return (slotsOf[name] ?? []).filter((s) => !off.has(s));
};
const arms = body.parts.filter((p) => p.spec.kind === "arm");
const farArms = arms.filter((p) => p.spec.depth === "far");
const carrier = body.parts.find((p) => p.preset.assembly);
const clearance = Math.min(...(carrier?.preset.assembly?.connections ?? []).map((x) => x.clearance));
const sheet = carrier?.preset.assembly?.sheets[0] as { slot: string; attachment: string };
const results: GateResult[] = [];
for (const near of arms.filter((p) => p.spec.depth === "near")) {
  const far = farArms.find((f) => f.spec.name === near.spec.partner || f.spec.partner === near.spec.name) ?? farArms[0] ?? null;
  results.push(...nearArmGates(doc, textures, gateParts.get(near.spec.name) as GatePart, far ? (gateParts.get(far.spec.name) as GatePart) : null, far ? armSlots(far.spec.name) : [], armSlots(near.spec.name), frames, (raw.slots as { name: string }[]).filter((x) => x.name.endsWith("_fist")).map((x) => x.name)));
}
for (const far of farArms) results.push(...farArmGates(doc, gateParts.get(far.spec.name) as GatePart, `${sheet.slot}/${sheet.attachment}`, clearance, frames));
const slotNames = new Set((raw.slots as { name: string }[]).map((s) => s.name));
const revealParts = body.parts.map((p) => ({ spec: p.spec, preset: p.preset, slots: partSlots(p.preset).filter((s) => slotNames.has(s) && s !== sheet.slot) }));
results.push(...farRevealGates(doc, textures, revealParts, `${sheet.slot}/${sheet.attachment}`, frames));
// the legs: every clip frame inside the leg bones' limits too
for (const leg of body.parts.filter((p) => p.spec.kind === "leg")) {
  const bad: string[] = [];
  for (const f of frames) for (const b of leg.preset.bones) { const v = f.offsets[b.name] ?? 0; if (b.limits && (v < b.limits[0] - 1e-6 || v > b.limits[1] + 1e-6)) bad.push(`${f.name}: ${b.name} ${v.toFixed(3)}`); }
  results.push({ gate: `${leg.spec.name}: clip frames inside the leg bone limits`, ok: bad.length === 0, measured: frames.length, detail: bad.length ? bad.slice(0, 12).join("; ") : `${frames.length} frames` });
}
const failures = results.filter((r) => !r.ok).map((r) => `${r.gate}: ${r.detail}`);
writeFileSync(outPath, `${JSON.stringify({ rig: rigPath, clips, frames: frames.length, gates: results.map((r) => ({ gate: r.gate, ok: r.ok, measured: r.measured, detail: r.detail })), failures }, null, 1)}\n`);
for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"} ${r.gate}: ${r.detail.slice(0, 400)}\n`);
process.stdout.write(`${results.length - failures.length}/${results.length} pass over ${frames.length} frames\n`);
if (failures.length) process.exitCode = 1;
