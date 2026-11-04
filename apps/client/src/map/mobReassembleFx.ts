import type { Graphics } from "pixi.js";

import { mobReassemblePhase, type MobActionState } from "./mobActionAnimation.js";

/**
 * Ground effects for the skeleton reassemble, drawn under the sprite at the mob's feet: bones
 * thrown out by the collapse, lying in a heap, then dragged back in by a closing ring of the
 * mob's own magic with wisps rising, and a short burst when it pops back up. Everything is a
 * fixed table sampled by time, so nothing is stored or allocated per frame.
 */

const INK = 0x2e1f16;
const BONE = 0xefe4c8;
/** Default cue (the barrow wight's cloak teal). */
export const REASSEMBLE_CUE_COLOR = 0x7fe3cc;

// Bones: angle (rad), distance (fraction of height), length (fraction), resting rotation (rad).
const BONES = [
  0.2, 0.62, 0.15, 0.4,
  1.0, 0.5, 0.13, 2.1,
  1.75, 0.68, 0.16, 0.9,
  2.5, 0.56, 0.12, 2.6,
  3.3, 0.7, 0.15, 1.3,
  4.05, 0.52, 0.14, 0.2,
  4.8, 0.64, 0.13, 1.9,
  5.6, 0.58, 0.15, 2.9
] as const;
const BONE_COUNT = BONES.length / 4;
/** The fourth bone is a skull. */
const SKULL_INDEX = 3;

const phaseOut = { t: 0 };

function traceBone(g: Graphics, x: number, y: number, length: number, rotation: number, h: number, pad: number, skull: boolean): void {
  if (skull) {
    g.circle(x, y, h * 0.055 + pad);
    g.roundRect(x - h * 0.03 - pad, y + h * 0.02 - pad, h * 0.06 + pad * 2, h * 0.045 + pad * 2, 2);
    return;
  }
  const c = Math.cos(rotation), s = Math.sin(rotation);
  const hx = c * length / 2, hy = s * length / 2;
  const thick = h * 0.016 + pad;
  const nx = -s * thick, ny = c * thick;
  g.moveTo(x - hx + nx, y - hy + ny).lineTo(x + hx + nx, y + hy + ny).lineTo(x + hx - nx, y + hy - ny).lineTo(x - hx - nx, y - hy - ny).closePath();
  const knob = h * 0.022 + pad;
  const kx = -s * h * 0.018, ky = c * h * 0.018;
  g.circle(x - hx + kx, y - hy + ky, knob).circle(x - hx - kx, y - hy - ky, knob)
    .circle(x + hx + kx, y + hy + ky, knob).circle(x + hx - kx, y + hy - ky, knob);
}

/** Bone positions for the current phase; `pass` 0 traces the ink silhouette, 1 the bone fill. */
function traceBones(g: Graphics, x: number, y: number, h: number, scatter: number, arc: number, twist: number, pad: number): void {
  for (let index = 0; index < BONE_COUNT; index += 1) {
    const angle = BONES[index * 4]!, distance = BONES[index * 4 + 1]!, length = BONES[index * 4 + 2]!, rest = BONES[index * 4 + 3]!;
    const bx = x + Math.cos(angle) * distance * h * scatter;
    const by = y + Math.sin(angle) * distance * h * scatter * 0.45 + h * 0.02 - arc * h;
    traceBone(g, bx, by, length * h, rest + twist * (index % 2 === 0 ? 1 : -1), h, pad, index === SKULL_INDEX);
  }
}

export function drawReassembleFx(
  g: Graphics,
  state: Readonly<Pick<MobActionState, "reassembleStartMs" | "reassembleEndMs">>,
  wallNowMs: number,
  x: number,
  y: number,
  heightPx: number,
  cue: number,
  reducedMotion: boolean
): void {
  const phase = mobReassemblePhase(state, wallNowMs, phaseOut);
  if (phase === null) return;
  const t = Math.min(1, Math.max(0, phaseOut.t));
  const h = Math.max(24, heightPx);
  let scatter = 1, arc = 0, twist = 0, bonesAlpha = 1;
  if (phase === "collapse") {
    scatter = reducedMotion ? 1 : 1 - (1 - t) * (1 - t);
    arc = reducedMotion ? 0 : Math.sin(t * Math.PI) * 0.18;
  } else if (phase === "gather") {
    const pull = t * t;
    scatter = 1 - 0.85 * pull;
    twist = reducedMotion ? 0 : 0.6 * pull;
  } else if (phase === "pop") {
    scatter = 0.15;
    bonesAlpha = 1 - t;
  }
  if (phase === "gather") {
    // The cue: a ring of the mob's magic closing in on the heap.
    const radius = h * (0.78 - 0.42 * t);
    g.ellipse(x, y, radius + 3, (radius + 3) * 0.5).stroke({ width: 7, color: cue, alpha: 0.2 });
    g.ellipse(x, y, radius * 0.7, radius * 0.35).fill({ color: cue, alpha: 0.12 + 0.08 * t });
    g.ellipse(x, y, radius, radius * 0.5).stroke({ width: 3.5, color: INK, alpha: 0.75 });
    g.ellipse(x, y, radius, radius * 0.5).stroke({ width: 2, color: cue, alpha: 1 });
  }
  if (bonesAlpha > 0.02) {
    traceBones(g, x, y, h, scatter, arc, twist, 1.6);
    g.fill({ color: INK, alpha: 0.9 * bonesAlpha });
    traceBones(g, x, y, h, scatter, arc, twist, 0);
    g.fill({ color: BONE, alpha: bonesAlpha });
  }
  if (phase === "gather") {
    // Wisps rise off the bones and drift inward.
    const count = 5;
    for (let index = 0; index < count; index += 1) {
      const angle = index / count * Math.PI * 2 + 0.3;
      const distance = h * 0.42 * (1 - t);
      const wx = x + Math.cos(angle) * distance;
      const rise = reducedMotion ? 0.08 : 0.05 + 0.3 * t + (index % 2) * 0.05;
      const wy = y + Math.sin(angle) * distance * 0.45 - rise * h;
      const size = h * (0.1 + (index % 3) * 0.025);
      g.moveTo(wx, wy - size).lineTo(wx + size * 0.28, wy - size * 0.35).lineTo(wx + size * 0.16, wy)
        .lineTo(wx - size * 0.16, wy).lineTo(wx - size * 0.28, wy - size * 0.35).closePath();
    }
    g.fill({ color: cue, alpha: 0.85 }).stroke({ width: 1.5, color: INK, alpha: 0.6, join: "round" });
  } else if (phase === "pop") {
    // Burst of short strokes round the body, fading as it settles.
    const fade = 1 - t;
    const radius = h * (0.42 + 0.12 * t);
    for (let index = 0; index < 10; index += 1) {
      const angle = index / 10 * Math.PI * 2;
      const sx = x + Math.cos(angle) * radius, sy = y - h * 0.4 + Math.sin(angle) * radius * 0.85;
      g.moveTo(sx, sy).lineTo(sx + Math.cos(angle) * h * 0.08, sy + Math.sin(angle) * h * 0.07);
    }
    g.stroke({ width: 4, color: INK, alpha: 0.7 * fade, cap: "round" });
    for (let index = 0; index < 10; index += 1) {
      const angle = index / 10 * Math.PI * 2;
      const sx = x + Math.cos(angle) * radius, sy = y - h * 0.4 + Math.sin(angle) * radius * 0.85;
      g.moveTo(sx, sy).lineTo(sx + Math.cos(angle) * h * 0.08, sy + Math.sin(angle) * h * 0.07);
    }
    g.stroke({ width: 2, color: cue, alpha: fade, cap: "round" });
    g.ellipse(x, y, h * 0.3 * (1 + t), h * 0.15 * (1 + t)).stroke({ width: 2, color: cue, alpha: 0.5 * fade });
  }
}
