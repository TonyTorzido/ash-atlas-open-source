import { Container, Graphics } from "pixi.js";
import { isWorldZoneLandCode, worldZoneFromCode, type MobSpawnSiteBiome } from "@ash-atlas/shared";

import type { WorldZoneLookup } from "./worldZoneLookup.js";

/**
 * Mob attack telegraphs as a painted ground decal in the art's own style: a hand-inked outline,
 * a pale cream stamp, a fill that grows out from the caster and warms toward the strike, a few
 * restrained ground marks (cracks, claw gouges, chevrons) and dust clouds at the impact.
 *
 * Shapes arrive already projected to screen pixels, so drawing is plain Graphics paths. Nothing
 * here allocates: shapes are traced straight into the Graphics, and the marks come from a seeded
 * generator re-run every frame, so they hold still without being stored.
 */

/** Screen-space telegraph; one instance is reused for every cast. */
export type TelegraphScreenShape = {
  kind: "circle" | "cone" | "line";
  /** Circle centre, or cone / lane origin. */
  ox: number;
  oy: number;
  /** Circle radius. */
  radius: number;
  /** Cone range or lane length. */
  reach: number;
  /** Cone half angle (radians). */
  halfAngle: number;
  /** Lane half width. */
  halfWidth: number;
  /** Facing (radians, screen). */
  dir: number;
};

export function createTelegraphScreenShape(): TelegraphScreenShape {
  return { kind: "circle", ox: 0, oy: 0, radius: 0, reach: 0, halfAngle: 0, halfWidth: 0, dir: 0 };
}

export type TelegraphMarks = "cracks" | "gouges" | "talons" | "chevrons" | "none";

/** Ground marks for an ability id (`<archetype>_<kind>`); unknown casts get the plain stamp. */
export function telegraphMarksForAbility(abilityId: string, kind: TelegraphScreenShape["kind"]): TelegraphMarks {
  if (abilityId.endsWith("_slam")) return "cracks";
  if (abilityId.endsWith("_maul")) return "gouges";
  if (abilityId.endsWith("_swoop")) return "talons";
  // The archetype flank lunge (pack_lunge) is a lane like the charge.
  if (abilityId.endsWith("_charge") || abilityId.endsWith("_lunge") || kind === "line") return "chevrons";
  return "none";
}

/**
 * Fill ramp (start of the warning -> mid -> strike), the mark tint and the impact dust tint.
 * The ink outline and cream stamp never change, so the shape reads the same everywhere.
 */
export type TelegraphPalette = Readonly<{ start: number; mid: number; end: number; mark: number; dust: number }>;

/** Dungeons, interiors, water and unknown ground. */
export const TELEGRAPH_DEFAULT_PALETTE: TelegraphPalette = {
  start: 0xf0a33a, mid: 0xe2702a, end: 0xc9381f, mark: 0x5a1e12, dust: 0xf1e6cf
};

/**
 * One ramp per land biome. Each ends dark and saturated enough to read as danger on that
 * biome's ground, and stays clear of the ground's own hue.
 */
export const TELEGRAPH_BIOME_PALETTES: Readonly<Record<MobSpawnSiteBiome, TelegraphPalette>> = {
  frostwood: { start: 0x7cc4e8, mid: 0x3b8fd0, end: 0x1f5fa8, mark: 0x163a66, dust: 0xe8f4fb },
  tundra: { start: 0x93c3de, mid: 0x4d8fc0, end: 0x285b94, mark: 0x1a365a, dust: 0xe6eef4 },
  frozen_waste: { start: 0xa2d6ee, mid: 0x4fa2d4, end: 0x1f6cae, mark: 0x143e66, dust: 0xf2f9fd },
  pinewild: { start: 0x72b58f, mid: 0x2f8a62, end: 0x1b5c43, mark: 0x123a2b, dust: 0xe4efe2 },
  greenwood: { start: 0xa6d03c, mid: 0x5fa22a, end: 0x356c18, mark: 0x26420f, dust: 0xeef0d8 },
  jungle: { start: 0x5cc78d, mid: 0x1f9a66, end: 0x0d6748, mark: 0x08402c, dust: 0xe2f2e6 },
  plains: { start: 0xf5c53a, mid: 0xe39a1e, end: 0xb8661a, mark: 0x5c3510, dust: 0xf7edd0 },
  savanna: { start: 0xf7a23c, mid: 0xe26e24, end: 0xb04318, mark: 0x582a0e, dust: 0xf5e8cc },
  steppe: { start: 0xeeb04a, mid: 0xd38228, end: 0xa0521a, mark: 0x463014, dust: 0xf1e8d2 },
  badlands: { start: 0xf4864a, mid: 0xd65226, end: 0x9c2e16, mark: 0x4e1a0c, dust: 0xf4e1d2 },
  scrubland: { start: 0xeba25e, mid: 0xcf6f36, end: 0x97401f, mark: 0x4a2614, dust: 0xf3e6d6 },
  highmeadow: { start: 0xc9a0dc, mid: 0x9a5fbf, end: 0x663794, mark: 0x3a1d58, dust: 0xf1e8f6 },
  marsh: { start: 0x7cc2a6, mid: 0x3d8e78, end: 0x225c52, mark: 0x123a34, dust: 0xe4efe6 }
};

export function telegraphPaletteForBiome(biome: string | null | undefined): TelegraphPalette {
  return (biome && (TELEGRAPH_BIOME_PALETTES as Readonly<Record<string, TelegraphPalette>>)[biome]) || TELEGRAPH_DEFAULT_PALETTE;
}

/**
 * Palette for the land cell under a telegraph, from the world zone lookup the client already
 * loads for biome tree art. Water, unknown cells and a missing lookup get the default red.
 */
export function telegraphPaletteAt(lookup: WorldZoneLookup | null, lat: number, lon: number): TelegraphPalette {
  if (!lookup) return TELEGRAPH_DEFAULT_PALETTE;
  const code = lookup.codeAt(lat, lon);
  if (!isWorldZoneLandCode(code)) return TELEGRAPH_DEFAULT_PALETTE;
  return telegraphPaletteForBiome(worldZoneFromCode(code, lat).biome);
}

/** Visual tuning, screen px. */
export const TELEGRAPH_DECAL = {
  ink: 0x2e1f16,
  cream: 0xfff3d6,
  front: 0xffe2a0,
  outlineWidth: 3.5,
  innerLineWidth: 1.5,
  innerInset: 4,
  stampAlpha: 0.4,
  growAlpha: 0.62,
  wobble: 0.012,
  impactMs: 260
} as const;

const TAU = Math.PI * 2;

export function mixColor(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * k);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * k);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * k);
  return (r << 16) | (g << 8) | bl;
}

function rampColor(palette: TelegraphPalette, t: number): number {
  return t < 0.5 ? mixColor(palette.start, palette.mid, t / 0.5) : mixColor(palette.mid, palette.end, (t - 0.5) / 0.4);
}

// Seeded generator for the marks (mulberry32); re-seeded per cast per frame, so no storage.
let rngState = 0;
function seedRandom(seed: number): void { rngState = seed | 0; }
function random(): number {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Stable numeric seed for a cast id. */
export function telegraphSeed(castInstanceId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < castInstanceId.length; index += 1) {
    hash = Math.imul(hash ^ castInstanceId.charCodeAt(index), 16777619);
  }
  return hash | 0;
}

/** Point along the shape's local axes (u forward, n to the side). */
function localX(s: TelegraphScreenShape, u: number, n: number): number { return s.ox + Math.cos(s.dir) * u - Math.sin(s.dir) * n; }
function localY(s: TelegraphScreenShape, u: number, n: number): number { return s.oy + Math.sin(s.dir) * u + Math.cos(s.dir) * n; }

/**
 * Traces the closed outline with its reach scaled by `extent` and pulled in by `inset` px. The
 * slight hand-drawn wobble is a fixed function of angle and seed, so it never crawls.
 */
function traceShape(g: Graphics, s: TelegraphScreenShape, extent: number, inset: number, wobblePhase: number): void {
  const wobble = TELEGRAPH_DECAL.wobble;
  if (s.kind === "circle") {
    const r = Math.max(0, s.radius * extent - inset);
    const steps = 48;
    for (let index = 0; index < steps; index += 1) {
      const a = index / steps * TAU;
      const w = 1 + wobble * (0.6 * Math.sin(3 * a + wobblePhase) + 0.4 * Math.sin(7 * a + wobblePhase * 1.7));
      const x = s.ox + Math.cos(a) * r * w;
      const y = s.oy + Math.sin(a) * r * w;
      if (index === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    return;
  }
  if (s.kind === "cone") {
    const r = Math.max(0, s.reach * extent - inset);
    const apex = inset * 1.4;
    const trim = inset > 0 ? Math.min(s.halfAngle * 0.5, inset / Math.max(1, r)) : 0;
    g.moveTo(s.ox + Math.cos(s.dir) * apex, s.oy + Math.sin(s.dir) * apex);
    const steps = 24;
    for (let index = 0; index <= steps; index += 1) {
      const a = s.dir - s.halfAngle + trim + (s.halfAngle - trim) * 2 * index / steps;
      const w = 1 + wobble * Math.sin(5 * a + wobblePhase);
      g.lineTo(s.ox + Math.cos(a) * r * w, s.oy + Math.sin(a) * r * w);
    }
    g.closePath();
    return;
  }
  // Lane: square at the caster, rounded front corners.
  const hw = Math.max(0, s.halfWidth - inset);
  const length = Math.max(0, s.reach * extent - inset);
  const corner = Math.min(hw * 0.3, length / 2, hw);
  g.moveTo(localX(s, 0, -hw), localY(s, 0, -hw));
  for (let index = 0; index <= 5; index += 1) {
    const a = -Math.PI / 2 + index / 5 * Math.PI / 2;
    const u = length - corner + Math.cos(a) * corner, n = -hw + corner + Math.sin(a) * corner;
    g.lineTo(localX(s, u, n), localY(s, u, n));
  }
  for (let index = 0; index <= 5; index += 1) {
    const a = index / 5 * Math.PI / 2;
    const u = length - corner + Math.cos(a) * corner, n = hw - corner + Math.sin(a) * corner;
    g.lineTo(localX(s, u, n), localY(s, u, n));
  }
  g.lineTo(localX(s, 0, hw), localY(s, 0, hw));
  g.closePath();
}

/** Size of the shape in px, used to scale marks and dust with zoom. */
function shapeScale(s: TelegraphScreenShape): number {
  return s.kind === "circle" ? s.radius : s.kind === "cone" ? s.reach * 0.75 : Math.min(s.reach, s.halfWidth * 2.2);
}

function drawCracks(g: Graphics, s: TelegraphScreenShape, grow: number, color: number, opacity: number): void {
  const count = 6;
  const r = s.radius;
  const width = Math.max(1.2, Math.min(3, r * 0.016));
  // Two passes over the same seeded cracks: the full crack, then a thicker root (a taper).
  for (let pass = 0; pass < 2; pass += 1) {
    seedRandom(rngState0);
    for (let index = 0; index < count; index += 1) {
      let a = index / count * TAU + random() * 0.5;
      const length = r * (0.42 + random() * 0.3) * grow;
      const segments = pass === 0 ? 4 : 2;
      let x = s.ox, y = s.oy;
      g.moveTo(x, y);
      for (let k = 0; k < 4; k += 1) {
        const turn = (random() - 0.5) * 0.7;
        if (k >= segments) continue;
        a += turn;
        x += Math.cos(a) * length / 4;
        y += Math.sin(a) * length / 4;
        g.lineTo(x, y);
      }
    }
    g.stroke({ width: pass === 0 ? width : width * 1.8, color, alpha: 0.6 * opacity, cap: "round", join: "round" });
  }
}

function drawGouges(g: Graphics, s: TelegraphScreenShape, progress: number, impact: boolean, count: number, color: number, opacity: number): void {
  let any = false;
  for (let index = 0; index < count; index += 1) {
    const appear = impact ? 1 : Math.min(1, Math.max(0, (progress - (0.2 + index * 0.25)) / 0.12));
    if (appear <= 0) continue;
    any = true;
    const rho = s.reach * (count === 3 ? 0.5 + index * 0.16 : 0.55 + index * 0.2);
    const span = s.halfAngle * 0.7 * appear;
    const thick = Math.max(2, s.reach * (count === 3 ? 0.028 : 0.022));
    const steps = 12;
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps, a = s.dir - span + t * span * 2, w = Math.sin(t * Math.PI) * thick;
      const x = s.ox + Math.cos(a) * (rho + w / 2), y = s.oy + Math.sin(a) * (rho + w / 2);
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    for (let k = steps; k >= 0; k -= 1) {
      const t = k / steps, a = s.dir - span + t * span * 2, w = Math.sin(t * Math.PI) * thick;
      g.lineTo(s.ox + Math.cos(a) * (rho - w / 2), s.oy + Math.sin(a) * (rho - w / 2));
    }
    g.closePath();
  }
  if (any) g.fill({ color, alpha: 0.62 * opacity });
}

function traceChevron(g: Graphics, s: TelegraphScreenShape, u: number, size: number): void {
  const hw = s.halfWidth * 0.5, d = size, th = size * 0.6;
  g.moveTo(localX(s, u + d, 0), localY(s, u + d, 0));
  g.lineTo(localX(s, u - d + th * 0.2, -hw), localY(s, u - d + th * 0.2, -hw));
  g.lineTo(localX(s, u - d - th, -hw), localY(s, u - d - th, -hw));
  g.lineTo(localX(s, u + d - th * 1.2, 0), localY(s, u + d - th * 1.2, 0));
  g.lineTo(localX(s, u - d - th, hw), localY(s, u - d - th, hw));
  g.lineTo(localX(s, u - d + th * 0.2, hw), localY(s, u - d + th * 0.2, hw));
  g.closePath();
}

function drawChevrons(g: Graphics, s: TelegraphScreenShape, progress: number, impact: boolean, color: number, opacity: number): void {
  const count = 4;
  const size = Math.max(5, s.halfWidth * 0.22);
  for (let lit = 0; lit < 2; lit += 1) {
    let any = false;
    for (let index = 0; index < count; index += 1) {
      const isLit = impact || progress >= (index + 0.7) / count;
      if (isLit !== (lit === 1)) continue;
      any = true;
      traceChevron(g, s, s.reach * (0.22 + index * 0.2), size);
    }
    if (!any) continue;
    g.fill({ color: TELEGRAPH_DECAL.cream, alpha: (lit ? 0.95 : 0.3) * opacity })
      .stroke({ width: 2, color: lit ? color : TELEGRAPH_DECAL.ink, alpha: (lit ? 0.9 : 0.35) * opacity, join: "round" });
  }
}

const PUFF_LOBES = [-0.55, 0.15, 0.62, 0.5, 0.2, 0.58, 0, -0.25, 0.8] as const;

function tracePuffs(g: Graphics, s: TelegraphScreenShape, pad: number, size: number, spread: number): void {
  seedRandom(rngState0 ^ 0x5bd1e995);
  const count = s.kind === "circle" ? 7 : 5;
  for (let index = 0; index < count; index += 1) {
    let x: number, y: number;
    const jitter = random();
    if (s.kind === "circle") {
      const a = index / count * TAU + jitter * 0.3;
      x = s.ox + Math.cos(a) * s.radius * spread; y = s.oy + Math.sin(a) * s.radius * spread;
    } else if (s.kind === "cone") {
      const a = s.dir - s.halfAngle + (index + 0.5) / count * s.halfAngle * 2;
      x = s.ox + Math.cos(a) * s.reach * 0.94 * spread; y = s.oy + Math.sin(a) * s.reach * 0.94 * spread;
    } else {
      const u = s.reach * (0.12 + index / count * 0.85), n = (jitter - 0.5) * s.halfWidth * 1.4;
      x = localX(s, u, n); y = localY(s, u, n);
    }
    const r = size * (0.85 + 0.3 * random());
    for (let lobe = 0; lobe < 9; lobe += 3) {
      g.circle(x + PUFF_LOBES[lobe]! * r, y + PUFF_LOBES[lobe + 1]! * r, r * PUFF_LOBES[lobe + 2]! + pad);
    }
  }
}

let rngState0 = 0;

type StaticKey = {
  kind: TelegraphScreenShape["kind"] | "";
  radius: number;
  reach: number;
  halfAngle: number;
  halfWidth: number;
  seed: number;
  alpha: number;
  impacting: boolean;
  color: number;
};

function emptyKey(): StaticKey {
  return { kind: "", radius: -1, reach: -1, halfAngle: -1, halfWidth: -1, seed: 0, alpha: -1, impacting: false, color: -1 };
}

function sameKey(a: StaticKey, b: StaticKey): boolean {
  return a.kind === b.kind && a.radius === b.radius && a.reach === b.reach && a.halfAngle === b.halfAngle &&
    a.halfWidth === b.halfWidth && a.seed === b.seed && a.alpha === b.alpha && a.impacting === b.impacting &&
    a.color === b.color;
}

function copyKey(into: StaticKey, from: StaticKey): void {
  into.kind = from.kind; into.radius = from.radius; into.reach = from.reach; into.halfAngle = from.halfAngle;
  into.halfWidth = from.halfWidth; into.seed = from.seed; into.alpha = from.alpha;
  into.impacting = from.impacting; into.color = from.color;
}

/**
 * Signature moves (Mob AI Phase 2, `MOB_SIGNATURE_ABILITY_IDS`) draw a heavier hand-inked outline: this many times
 * the normal width, plus a faint second ink line just outside, so a signature never reads like a basic strike.
 */
export const TELEGRAPH_SIGNATURE_OUTLINE_SCALE = 1.8;

/**
 * One cast's decal. The stamp, tint, outline and inner line are tessellated once per shape size and
 * fade level, in the shape's local frame, and placed by the root's position and rotation, so a
 * telegraph that only advances in time (or whose camera pans) is not re-tessellated. The tint colour,
 * tint opacity and inner-line pulse animate through Graphics tint/alpha. Only the growing fill with its
 * front line, the ground marks and the impact dust are redrawn each frame.
 */
export class TelegraphDecalView {
  readonly root = new Container();
  private readonly base = new Graphics();
  private readonly tint = new Graphics();
  private readonly mid = new Graphics();
  private readonly outline = new Graphics();
  private readonly inner = new Graphics();
  private readonly top = new Graphics();
  private readonly local = createTelegraphScreenShape();
  private readonly want = emptyKey();
  private readonly baseKey = emptyKey();
  private readonly tintKey = emptyKey();
  private readonly outlineKey = emptyKey();
  private readonly innerKey = emptyKey();
  private midDrawn = false;
  private topDrawn = false;
  private outlineSignature = false;

  constructor() {
    this.root.addChild(this.base, this.tint, this.mid, this.outline, this.inner, this.top);
    this.tint.tint = 0xffffff;
  }

  /** Updates the decal; returns false (and hides it) when it is too faint to draw. */
  update(
    s: TelegraphScreenShape,
    progress: number,
    impact: number,
    seed: number,
    marks: TelegraphMarks,
    palette: TelegraphPalette,
    opacity: number,
    reducedMotion: boolean,
    nowMs: number,
    signature = false
  ): boolean {
    const { ink, cream, front, outlineWidth, innerLineWidth, innerInset, stampAlpha, growAlpha } = TELEGRAPH_DECAL;
    const impacting = impact >= 0;
    const fade = impacting ? 1 - impact * impact : 1;
    const alpha = opacity * fade;
    if (alpha <= 0.01) {
      this.root.visible = false;
      return false;
    }
    this.root.visible = true;
    this.root.position.set(s.ox, s.oy);
    this.root.rotation = s.dir;
    const local = this.local;
    local.kind = s.kind; local.radius = s.radius; local.reach = s.reach; local.halfAngle = s.halfAngle;
    local.halfWidth = s.halfWidth; local.ox = 0; local.oy = 0; local.dir = 0;
    rngState0 = seed;
    const phase = ((seed >>> 0) % 628) / 100;
    const color = impacting ? palette.end : rampColor(palette, progress);
    const want = this.want;
    want.kind = s.kind; want.radius = s.radius; want.reach = s.reach; want.halfAngle = s.halfAngle;
    want.halfWidth = s.halfWidth; want.seed = seed; want.alpha = alpha; want.impacting = impacting;
    want.color = impacting ? color : 0;

    // Stamped decal: a faint ink shadow and the cream stamp (tinted at impact).
    if (!sameKey(this.baseKey, want)) {
      copyKey(this.baseKey, want);
      this.base.clear();
      traceShape(this.base, local, 1, -1.5, phase);
      this.base.fill({ color: ink, alpha: 0.1 * alpha });
      traceShape(this.base, local, 1, 0, phase);
      this.base.fill({ color: impacting ? color : cream, alpha: (impacting ? 0.6 : stampAlpha) * alpha });
    }
    // Biome tint deepening with time: geometry fixed, colour and opacity animated.
    this.tint.visible = !impacting;
    if (!impacting) {
      want.color = 0;
      if (!sameKey(this.tintKey, want)) {
        copyKey(this.tintKey, want);
        this.tint.clear();
        traceShape(this.tint, local, 1, 0, phase);
        this.tint.fill({ color: 0xffffff, alpha });
      }
      this.tint.tint = color;
      this.tint.alpha = 0.08 + 0.12 * progress;
    }
    // Per-frame layer: growing fill with its front line, then ground marks.
    if (this.midDrawn) {
      this.mid.clear();
      this.midDrawn = false;
    }
    const mid = this.mid;
    if (!impacting && progress > 0.02) {
      traceShape(mid, local, progress, 0, phase);
      mid.fill({ color, alpha: growAlpha * alpha }).stroke({ width: 2, color: front, alpha: 0.85 * alpha, join: "round" });
      this.midDrawn = true;
    }
    const markGrow = impacting ? 1 : Math.min(1, progress * 1.12);
    const markColor = mixColor(ink, palette.mark, 0.35);
    if (marks === "cracks" && s.kind === "circle" && markGrow > 0.04) {
      drawCracks(mid, local, markGrow, markColor, alpha);
      this.midDrawn = true;
    } else if ((marks === "gouges" || marks === "talons") && s.kind === "cone") {
      drawGouges(mid, local, progress, impacting, marks === "gouges" ? 3 : 2, markColor, alpha);
      this.midDrawn = true;
    } else if (marks === "chevrons" && s.kind === "line") {
      drawChevrons(mid, local, progress, impacting, palette.end, alpha);
      this.midDrawn = true;
    }
    // Hand-inked outline.
    want.color = 0;
    if (!sameKey(this.outlineKey, want) || this.outlineSignature !== signature) {
      copyKey(this.outlineKey, want);
      this.outlineSignature = signature;
      this.outline.clear();
      if (signature) {
        traceShape(this.outline, local, 1, -outlineWidth * 1.4, phase);
        this.outline.stroke({ width: outlineWidth * 0.8, color: ink, alpha: 0.45 * alpha, join: "round" });
      }
      traceShape(this.outline, local, 1, 0, phase);
      this.outline.stroke({
        width: signature ? outlineWidth * TELEGRAPH_SIGNATURE_OUTLINE_SCALE : outlineWidth, color: ink, alpha: 0.92 * alpha, join: "round"
      });
    }
    // Cream line just inside; it quickens near the strike, animated through the layer's alpha.
    if (!sameKey(this.innerKey, want)) {
      copyKey(this.innerKey, want);
      this.inner.clear();
      traceShape(this.inner, local, 1, innerInset, phase);
      this.inner.stroke({ width: innerLineWidth, color: impacting ? cream : front, alpha: 0.75 * alpha, join: "round" });
    }
    this.inner.alpha = reducedMotion || impacting
      ? 1
      : 0.75 + 0.25 * Math.cos(nowMs / 1000 * TAU * (1.5 + 5 * progress));
    // Dust clouds kicked up round the rim: one ink silhouette, then the tinted cream fill.
    if (this.topDrawn) {
      this.top.clear();
      this.topDrawn = false;
    }
    if (impacting) {
      const size = Math.max(5, shapeScale(s) * 0.075) * (reducedMotion ? 1 : 0.8 + 0.4 * impact);
      const spread = reducedMotion ? 1 : 0.96 + 0.08 * impact;
      tracePuffs(this.top, local, 1.5, size, spread);
      this.top.fill({ color: ink, alpha: 0.9 * alpha });
      tracePuffs(this.top, local, 0, size, spread);
      this.top.fill({ color: mixColor(palette.dust, cream, 0.3), alpha });
      this.topDrawn = true;
    }
    return true;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
