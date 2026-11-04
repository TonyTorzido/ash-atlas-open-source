import { Container, Graphics, Matrix, type Texture } from "pixi.js";

import { RigMesh } from "./armRig.js";
import {
  EASE,
  GATHER_TUNING,
  sampleTrack,
  type MutablePoint,
  type Track
} from "./gatherAnimation.js";

/**
 * "Building a flag": the player lifts the flag pole with the hand on the
 * build side and rams it into the ground, once per cycle.
 *
 * The arms are the shared bendable arm rig (armRig.ts), posed with fist
 * targets: the pole simply sits in the build-side fist.
 *
 * Geometry is in visualRoot layer units unless noted; the flag pole, cloth and
 * dust live in the player's root (they do not squash with the body). The pole
 * is drawn in front of the body, split around the fist so the hand grips it.
 */
export const FLAG_BUILD_TUNING = {
  flag: {
    /**
     * Fallback height of the flag art canvas in layer units when the art does
     * not say (FlagBuildArt.heightUnits). 47 layer units is the stock Soft
     * Flag's on-map size next to a default-scale player, so the held flag
     * matches the flag that appears when the build completes.
     */
    canvasUnits: 47,
    /**
     * The pole is drawn in front of the body with a gap where the fist is, so
     * the fist reads as wrapped around it (layer units above / below the fist centre).
     */
    gripGapAboveUnits: 1.5,
    gripGapBelowUnits: 1.7,
    /** How far the pole base sits below the ground in the neutral hold. */
    restSinkUnits: 0.3,
    clothGridX: 12,
    clothGridY: 4,
    /** Idle cloth ripple: frequency, amplitude (fraction of the cloth span) and waves across. */
    flutterHz: 1.4,
    flutterSpan: 0.045,
    flutterWaves: 1.1,
    /** Impact whip: free end lift (fraction of the span), oscillation and decay. */
    whipSpan: 0.26,
    whipShrink: 0.07,
    whipHz: 3.4,
    whipDecayMs: 150,
    /**
     * Once the base is in the ground it stays planted there and the pole pivots
     * on it as the hand moves; full planting this deep (layer units).
     */
    plantBlendUnits: 0.6,
    /** Dirt patch the pole is driven into. */
    patch: { radiusX: 3.2, radiusY: 1.05, color: 0x3d2a17, alpha: 0.3 }
  },
  effects: {
    puffs: 7,
    puffLifeMs: 560,
    puffColors: [0xd8c49c, 0xbfa77c, 0xcdb68b] as readonly number[],
    puffStartUnits: 1.3,
    puffEndUnits: 3.4,
    puffAlpha: 0.7,
    clods: 3,
    clodLifeMs: 430,
    clodColor: 0x5e4126,
    clodUnits: 0.55,
    /** Layer units per ms squared. */
    gravity: 0.00012,
    ringLifeMs: 300,
    ringStartUnits: 1.2,
    ringEndUnits: 7,
    ringColor: 0xf1e6cc,
    ringAlpha: 0.7
  },
  /** Cloth motion kept under prefers-reduced-motion. */
  reducedCloth: 0.35
} as const;

export type FlagBuildProgram = Readonly<{
  cycleMs: number;
  impactAt: number;
  /**
   * Build-side arm: upper arm turn in degrees away from its rest direction
   * (positive = out to the build side) and elbow bend in degrees.
   */
  arm: Track;
  bend: Track;
  /** Off arm, the same way (positive = out to its own side). */
  offArm: Track;
  offBend: Track;
  /** Pole tilt in degrees while free, positive = top away from the body (planted, it pivots on its base). */
  tilt: Track;
  /** Cloth whip until impact: -1 = free end flipped up, positive = drooping. */
  cloth: Track;
  lean: Track;
  squash: Track;
  lift: Track;
  /** Reduced-motion hold pose the arm motion is compressed toward. */
  hold: Readonly<{ arm: number; bend: number }>;
}>;

// Slow, heavy lift with the body rising and leaning away (upper arm out, elbow
// folding the fist up beside the head), a short hang, a fast ram down into the
// ground with the arm nearly straight (lean in, squash, cloth whips up), then
// the pole stays planted while the body settles. The off arm swings out for
// balance. About one strike per 1.1 s.
export const FLAG_BUILD_PROGRAM: FlagBuildProgram = {
  cycleMs: 1100,
  impactAt: 0.555,
  arm: [[0, 8], [0.4, 40, EASE.inOut], [0.47, 45, EASE.out], [0.555, 4, EASE.in], [0.6, 5, EASE.out], [0.72, 7, EASE.inOut], [1, 8, EASE.inOut]],
  bend: [[0, 45], [0.4, 92, EASE.inOut], [0.47, 100, EASE.out], [0.555, 12, EASE.in], [0.6, 16, EASE.out], [0.72, 32, EASE.inOut], [1, 45, EASE.inOut]],
  offArm: [[0, 0], [0.4, 12, EASE.inOut], [0.47, 14], [0.555, -4, EASE.in], [0.63, 16, EASE.out], [0.85, 3, EASE.inOut], [1, 0, EASE.inOut]],
  offBend: [[0, 0], [0.4, 15, EASE.inOut], [0.47, 18], [0.555, 8, EASE.in], [0.63, 20, EASE.out], [0.85, 4, EASE.inOut], [1, 0, EASE.inOut]],
  tilt: [[0, 0], [0.4, 3, EASE.inOut], [0.47, 3.5], [0.555, -1, EASE.in], [0.75, 0, EASE.inOut], [1, 0]],
  cloth: [[0, 0], [0.4, 0.2, EASE.inOut], [0.47, 0.25], [0.555, -1, EASE.in]],
  lean: [[0, 0], [0.4, -2.5, EASE.inOut], [0.47, -3, EASE.out], [0.555, 4.5, EASE.in], [0.68, 3, EASE.out], [1, 0, EASE.inOut]],
  squash: [[0, 0], [0.4, -0.04, EASE.inOut], [0.47, -0.05], [0.54, 0, EASE.in], [0.575, 0.11, EASE.out], [0.76, 0, EASE.inOut], [1, 0]],
  lift: [[0, 0], [0.4, 0.9, EASE.inOut], [0.47, 1], [0.555, -0.4, EASE.in], [0.76, 0, EASE.inOut], [1, 0]],
  hold: { arm: 8, bend: 45 }
};

/** Mutable pose sample; every field is 0 at rest. */
export type FlagBuildPose = {
  arm: number;
  bend: number;
  offArm: number;
  offBend: number;
  tilt: number;
  cloth: number;
  lean: number;
  squash: number;
  lift: number;
};

export function createFlagBuildPose(): FlagBuildPose {
  return { arm: 0, bend: 0, offArm: 0, offBend: 0, tilt: 0, cloth: 0, lean: 0, squash: 0, lift: 0 };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = (x - edge0) / (edge1 - edge0);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Samples the looping program at elapsedMs. The cloth whip after impact is a
 * damped oscillation of the cycle time, faded out before the cycle ends, so
 * every loop is seamless and nothing needs per-frame state.
 */
export function sampleFlagBuild(elapsedMs: number, cadence: number, out: FlagBuildPose): FlagBuildPose {
  const program = FLAG_BUILD_PROGRAM;
  const cycleMs = program.cycleMs * cadence;
  const t = cycleMs > 0 ? ((elapsedMs % cycleMs) + cycleMs) % cycleMs / cycleMs : 0;
  out.arm = sampleTrack(program.arm, t);
  out.bend = sampleTrack(program.bend, t);
  out.offArm = sampleTrack(program.offArm, t);
  out.offBend = sampleTrack(program.offBend, t);
  out.tilt = sampleTrack(program.tilt, t);
  out.lean = sampleTrack(program.lean, t);
  out.squash = sampleTrack(program.squash, t);
  out.lift = sampleTrack(program.lift, t);
  const sinceImpactMs = (t - program.impactAt) * cycleMs;
  if (sinceImpactMs < 0) {
    out.cloth = sampleTrack(program.cloth, t);
    return out;
  }
  const flag = FLAG_BUILD_TUNING.flag;
  const fade = 1 - smoothstep(0.86, 1, t);
  const seconds = sinceImpactMs / 1000;
  out.cloth = -Math.exp(-sinceImpactMs / flag.whipDecayMs) *
    Math.cos(Math.PI * 2 * flag.whipHz * seconds) * fade;
  return out;
}

/** Compresses the pose for prefers-reduced-motion (same amounts as the gathering actions). */
export function reduceFlagBuildPose(pose: FlagBuildPose): FlagBuildPose {
  const keep = GATHER_TUNING.reducedMotionAmount;
  const body = GATHER_TUNING.reducedBodyAmount;
  const hold = FLAG_BUILD_PROGRAM.hold;
  pose.arm = hold.arm + (pose.arm - hold.arm) * keep;
  pose.bend = hold.bend + (pose.bend - hold.bend) * keep;
  pose.offArm *= keep;
  pose.offBend *= keep;
  pose.tilt *= keep;
  pose.cloth *= keep;
  pose.lean *= body;
  pose.squash *= body;
  pose.lift *= body;
  return pose;
}

/** Blends from rest (all zero) by amount 0..1. */
export function scaleFlagBuildPose(pose: FlagBuildPose, amount: number): FlagBuildPose {
  pose.arm *= amount;
  pose.bend *= amount;
  pose.offArm *= amount;
  pose.offBend *= amount;
  pose.tilt *= amount;
  pose.cloth *= amount;
  pose.lean *= amount;
  pose.squash *= amount;
  pose.lift *= amount;
  return pose;
}

// ---------------------------------------------------------------------------
// Rig: the held flag (pole + rippling cloth), dirt patch and impact dust.
// Created lazily by the renderer on the first flag build.

/**
 * The territory flag art: pole hardware and the tintable cloth share one
 * canvas and one ground anchor (normalized canvas point of the pole base).
 */
export type FlagBuildArt = Readonly<{
  pole: Texture;
  cloth: Texture | null;
  baseX: number;
  baseY: number;
  clothTint: number;
  /**
   * Height of the art canvas in player root units, so the held flag is the
   * same size as the placed flag (the caller knows both map scales).
   * Defaults to FLAG_BUILD_TUNING.flag.canvasUnits layer units.
   */
  heightUnits?: number;
}>;

type Effect = {
  graphic: Graphics;
  kind: "puff" | "clod" | "ring";
  x: number;
  y: number;
  vx: number;
  vy: number;
  ageMs: number;
  lifeMs: number;
};

/** Per-frame inputs for the held flag, all in root units. */
export type FlagPlacement = {
  gripX: number;
  gripY: number;
  groundY: number;
  /** Pole length from the grip down to its base. */
  gripToBase: number;
  /** Root units per layer unit. */
  unitScale: number;
  /** Screen rotation of the pole in radians (positive = clockwise). */
  tilt: number;
  sign: number;
  cloth: number;
  flutter: number;
  nowMs: number;
  alpha: number;
};

/** Pole art placement for one frame: canvas pixels to root units. */
type PoleFrame = {
  baseX: number;
  baseY: number;
  c: number;
  s: number;
  /** Root units per canvas pixel. */
  k: number;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  sign: number;
  alpha: number;
};

/** One pole quad covering canvas rows top..bottom (hidden when empty). */
function placePoleSegment(mesh: RigMesh, top: number, bottom: number, f: PoleFrame): void {
  if (!(bottom > top)) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;
  const positions = mesh.geometry.positions;
  const uvs = mesh.geometry.uvs;
  for (let index = 0; index < 4; index += 1) {
    const cx = index % 2 === 0 ? 0 : f.width;
    const cy = index < 2 ? top : bottom;
    const lx = (cx - f.anchorX) * f.k * f.sign;
    const ly = (cy - f.anchorY) * f.k;
    positions[index * 2] = f.baseX + f.c * lx - f.s * ly;
    positions[index * 2 + 1] = f.baseY + f.s * lx + f.c * ly;
    uvs[index * 2 + 1] = cy / f.height;
  }
  mesh.alpha = f.alpha;
  mesh.commit(true);
}

export class FlagBuildRig {
  /** Behind the body: the dirt patch. */
  private readonly back = new Container();
  /** In front of the whole player: impact effects. */
  private readonly front = new Container();
  /**
   * The held flag, inside visualRoot just below the head layers (in front of
   * the torso and arms, behind the head). Counter-transformed every frame so
   * its children are placed in root units and never squash with the body.
   */
  private readonly held = new Container();
  private readonly heldTransform = new Matrix();
  private readonly visualRoot: Container;
  private readonly patch = new Graphics();
  private art: FlagBuildArt | null = null;
  /** Pole above and below the fist. */
  private poleUpper: RigMesh | null = null;
  private poleLower: RigMesh | null = null;
  private cloth: RigMesh | null = null;
  /** Cloth rest vertices in canvas pixels. */
  private clothRest: Float32Array | null = null;
  private readonly effects: Effect[] = [];
  private effectsLive = 0;
  private baseX = 0;
  private groundY = 0;
  private unitScale = 1;
  private patchX = Number.NaN;
  /** Where the base entered the ground; NaN while the pole is out. */
  private plantX = Number.NaN;
  private readonly poleFrame: PoleFrame = {
    baseX: 0, baseY: 0, c: 1, s: 0, k: 1, anchorX: 0, anchorY: 0, width: 1, height: 1, sign: 1, alpha: 1
  };

  /** headLayer: the first visualRoot layer drawn over the held flag. */
  constructor(root: Container, visualRoot: Container, headLayer: Container) {
    this.visualRoot = visualRoot;
    this.back.label = "flag-build-back";
    this.front.label = "flag-build-front";
    this.held.label = "flag-build-held";
    this.back.eventMode = "none";
    this.front.eventMode = "none";
    this.held.eventMode = "none";
    this.back.visible = false;
    this.held.visible = false;
    const patch = FLAG_BUILD_TUNING.flag.patch;
    this.patch.ellipse(0, 0, patch.radiusX, patch.radiusY).fill({ color: patch.color });
    this.back.addChild(this.patch);
    const index = Math.max(0, root.getChildIndex(visualRoot));
    root.addChildAt(this.back, index);
    root.addChildAt(this.front, index + 2);
    visualRoot.addChildAt(this.held, Math.max(0, visualRoot.getChildIndex(headLayer)));
  }

  get effectsAlive(): boolean {
    return this.effectsLive > 0;
  }

  /** Root-local base of the pole after the last placement (tests and callers). */
  get poleBase(): Readonly<MutablePoint> {
    return { x: this.baseX, y: this.groundY };
  }

  get flagVisible(): boolean {
    return this.held.visible && this.poleUpper !== null;
  }

  setArt(art: FlagBuildArt | null): void {
    const current = this.art;
    if (
      current === art ||
      (current && art &&
        current.pole === art.pole &&
        current.cloth === art.cloth &&
        current.baseX === art.baseX &&
        current.baseY === art.baseY &&
        current.heightUnits === art.heightUnits &&
        current.clothTint === art.clothTint)
    ) {
      return;
    }
    if (current && art && current.pole === art.pole && current.cloth === art.cloth &&
      current.baseX === art.baseX && current.baseY === art.baseY && current.heightUnits === art.heightUnits) {
      this.art = art;
      if (this.cloth) this.cloth.tint = art.clothTint;
      return;
    }
    this.art = art;
    this.poleUpper?.destroy();
    this.poleLower?.destroy();
    this.cloth?.destroy();
    this.poleUpper = null;
    this.poleLower = null;
    this.cloth = null;
    this.clothRest = null;
    if (!art) return;
    this.poleUpper = new RigMesh(art.pole, 2, 2);
    this.poleLower = new RigMesh(art.pole, 2, 2);
    this.held.addChild(this.poleUpper, this.poleLower);
    if (art.cloth) {
      const tuning = FLAG_BUILD_TUNING.flag;
      const cloth = new RigMesh(art.cloth, tuning.clothGridX, tuning.clothGridY);
      cloth.tint = art.clothTint;
      const uvs = cloth.geometry.uvs;
      const rest = new Float32Array(uvs.length);
      for (let index = 0; index < uvs.length; index += 2) {
        rest[index] = uvs[index]! * art.cloth.width;
        rest[index + 1] = uvs[index + 1]! * art.cloth.height;
      }
      this.cloth = cloth;
      this.clothRest = rest;
      this.held.addChild(cloth);
    }
  }

  /** Places the pole in the fist, crops it at the ground and ripples the cloth. */
  placeFlag(p: FlagPlacement): void {
    const art = this.art;
    const upper = this.poleUpper;
    const lower = this.poleLower;
    this.back.visible = p.alpha > 0;
    this.held.visible = p.alpha > 0;
    // Undo the body transform so the flag is placed in root units.
    this.visualRoot.updateLocalTransform();
    this.held.setFromMatrix(this.heldTransform.copyFrom(this.visualRoot.localTransform).invert());
    const tuning = FLAG_BUILD_TUNING.flag;
    // Pole axis points up: (sin, -cos) for a clockwise tilt; the base is below the grip.
    let tilt = p.tilt;
    let c = Math.cos(tilt);
    let s = Math.sin(tilt);
    let baseX = p.gripX - s * p.gripToBase;
    let baseY = p.gripY + c * p.gripToBase;
    const freeDepth = (baseY - p.groundY) / Math.max(0.2, c);
    if (freeDepth > 0) {
      // In the ground: keep the base where it went in and pivot the pole on it.
      if (Number.isNaN(this.plantX)) this.plantX = baseX;
      const planted = smoothstep(0, tuning.plantBlendUnits * p.unitScale, freeDepth);
      const lean = Math.max(-0.5, Math.min(0.5, (p.gripX - this.plantX) / Math.max(1e-6, p.gripToBase)));
      tilt += (Math.asin(lean) - tilt) * planted;
      c = Math.cos(tilt);
      s = Math.sin(tilt);
      baseX = p.gripX - s * p.gripToBase;
      baseY = p.gripY + c * p.gripToBase;
    } else {
      this.plantX = Number.NaN;
    }
    // The dirt patch stays where the pole last went in.
    if (!Number.isNaN(this.plantX)) this.patchX = this.plantX;
    else if (Number.isNaN(this.patchX)) this.patchX = baseX;
    this.patch.position.set(this.patchX, p.groundY);
    this.patch.scale.set(p.unitScale);
    this.patch.alpha = FLAG_BUILD_TUNING.flag.patch.alpha * p.alpha;
    this.baseX = baseX;
    this.groundY = p.groundY;
    this.unitScale = p.unitScale;
    if (!art || !upper || !lower) return;
    const width = art.pole.width;
    const height = art.pole.height || 1;
    const canvasRootUnits = art.heightUnits ?? tuning.canvasUnits * p.unitScale;
    const k = canvasRootUnits / height;
    const anchorX = art.baseX * width;
    const anchorY = art.baseY * height;
    // Crop below the ground (measured along the pole).
    const depth = (baseY - p.groundY) / Math.max(0.2, c);
    const bottom = depth > 0 ? Math.max(0, anchorY - depth / k) : height;
    // Gap behind the fist, in canvas pixels along the pole.
    const gripY = anchorY - p.gripToBase / k;
    const gapTop = Math.max(0, gripY - tuning.gripGapAboveUnits * p.unitScale / k);
    const gapBottom = gripY + tuning.gripGapBelowUnits * p.unitScale / k;
    const frame = this.poleFrame;
    frame.baseX = baseX;
    frame.baseY = baseY;
    frame.c = c;
    frame.s = s;
    frame.k = k;
    frame.anchorX = anchorX;
    frame.anchorY = anchorY;
    frame.width = width;
    frame.height = height;
    frame.sign = p.sign;
    frame.alpha = p.alpha;
    placePoleSegment(upper, 0, Math.min(gapTop, bottom), frame);
    placePoleSegment(lower, gapBottom, bottom, frame);
    const cloth = this.cloth;
    const rest = this.clothRest;
    if (!cloth || !rest || !art.cloth) return;
    const clothWidth = art.cloth.width;
    const clothHeight = art.cloth.height || 1;
    const clothK = canvasRootUnits / clothHeight;
    const clothAnchorX = art.baseX * clothWidth;
    const clothAnchorY = art.baseY * clothHeight;
    const span = Math.max(1, clothWidth - clothAnchorX);
    const phase = Math.PI * 2 * tuning.flutterHz * p.nowMs / 1000;
    const flutter = tuning.flutterSpan * span * p.flutter;
    const whip = p.cloth;
    const clothPositions = cloth.geometry.positions;
    for (let index = 0; index < rest.length; index += 2) {
      const cx = rest[index]!;
      const cy = rest[index + 1]!;
      const along = cx - clothAnchorX;
      const q = along <= 0 ? 0 : Math.min(1, along / span);
      const wave = Math.sin(phase - tuning.flutterWaves * Math.PI * 2 * q + 0.9 * cy / clothHeight);
      const dy = flutter * Math.pow(q, 1.2) * wave +
        tuning.whipSpan * span * whip * q * q;
      const dx = -tuning.whipShrink * span * Math.abs(whip) * q;
      const lx = (along + dx) * clothK * p.sign;
      const ly = (cy + dy - clothAnchorY) * clothK;
      clothPositions[index] = baseX + c * lx - s * ly;
      clothPositions[index + 1] = baseY + s * lx + c * ly;
    }
    cloth.alpha = p.alpha;
    cloth.commit();
  }

  hideFlag(): void {
    this.back.visible = false;
    this.held.visible = false;
    this.patchX = Number.NaN;
    this.plantX = Number.NaN;
  }

  /** Dust puffs both ways along the ground, a few clods and a shock ring at the pole base. */
  /** Dust at the pole base; `at` (root units) overrides where (a sprite-sheet body's flag base). */
  spawnImpact(sign: number, at: Readonly<{ x: number; y: number }> | null = null): void {
    const tuning = FLAG_BUILD_TUNING.effects;
    const unitScale = this.unitScale;
    const x = at ? at.x : Number.isNaN(this.plantX) ? this.baseX : this.plantX;
    const y = at ? at.y : this.groundY;
    this.spawn("ring", x, y, 0, 0, tuning.ringLifeMs, tuning.ringColor);
    for (let index = 0; index < tuning.puffs; index += 1) {
      // Biased away from the body; a couple go back under the player.
      const direction = index < 2 ? -sign : sign;
      const speed = (0.004 + 0.009 * Math.random()) * unitScale;
      this.spawn(
        "puff",
        x + direction * (0.3 + Math.random()) * unitScale,
        y - Math.random() * 0.6 * unitScale,
        direction * speed,
        -(0.0015 + 0.004 * Math.random()) * unitScale,
        tuning.puffLifeMs * (0.7 + 0.4 * Math.random()),
        tuning.puffColors[index % tuning.puffColors.length]!
      );
    }
    for (let index = 0; index < tuning.clods; index += 1) {
      const direction = index === 0 ? -sign : sign;
      this.spawn(
        "clod",
        x,
        y - 0.3 * unitScale,
        direction * (0.006 + 0.01 * Math.random()) * unitScale,
        -(0.02 + 0.015 * Math.random()) * unitScale,
        tuning.clodLifeMs * (0.8 + 0.4 * Math.random()),
        tuning.clodColor
      );
    }
  }

  private spawn(
    kind: Effect["kind"],
    x: number,
    y: number,
    vx: number,
    vy: number,
    lifeMs: number,
    color: number
  ): void {
    let effect = this.effects.find((candidate) => candidate.kind === kind && candidate.ageMs >= candidate.lifeMs);
    if (!effect) {
      const graphic = new Graphics();
      if (kind === "ring") graphic.ellipse(0, 0, 1, 0.38).stroke({ color: 0xffffff, width: 0.24 });
      else if (kind === "puff") graphic.circle(0, 0, 1).fill({ color: 0xffffff });
      else graphic.rect(-0.5, -0.5, 1, 1).fill({ color: 0xffffff });
      this.front.addChild(graphic);
      effect = { graphic, kind, x: 0, y: 0, vx: 0, vy: 0, ageMs: 0, lifeMs: 0 };
      this.effects.push(effect);
    }
    this.effectsLive += 1;
    effect.x = x;
    effect.y = y;
    effect.vx = vx;
    effect.vy = vy;
    effect.ageMs = 0;
    effect.lifeMs = lifeMs;
    effect.graphic.tint = color;
    effect.graphic.rotation = kind === "clod" ? Math.random() * Math.PI : 0;
    effect.graphic.visible = true;
    this.drawEffect(effect);
  }

  updateEffects(dtMs: number): void {
    if (this.effectsLive === 0) return;
    const gravity = FLAG_BUILD_TUNING.effects.gravity * this.unitScale;
    let live = 0;
    for (const effect of this.effects) {
      if (effect.ageMs >= effect.lifeMs) continue;
      effect.ageMs += dtMs;
      if (effect.ageMs >= effect.lifeMs) {
        effect.graphic.visible = false;
        continue;
      }
      if (effect.kind === "clod") {
        effect.vy += gravity * dtMs;
        effect.graphic.rotation += 0.02 * dtMs;
        // Clods stop on the ground.
        if (effect.y >= this.groundY && effect.vy > 0) {
          effect.vy = 0;
          effect.vx *= 0.5;
        }
      } else if (effect.kind === "puff") {
        const drag = Math.exp(-dtMs / 220);
        effect.vx *= drag;
        effect.vy *= drag;
      }
      effect.x += effect.vx * dtMs;
      effect.y += effect.vy * dtMs;
      this.drawEffect(effect);
      live += 1;
    }
    this.effectsLive = live;
  }

  private drawEffect(effect: Effect): void {
    const tuning = FLAG_BUILD_TUNING.effects;
    const life = effect.lifeMs > 0 ? Math.min(1, effect.ageMs / effect.lifeMs) : 1;
    const graphic = effect.graphic;
    graphic.position.set(effect.x, effect.y);
    const units = this.unitScale;
    if (effect.kind === "ring") {
      const eased = 1 - (1 - life) * (1 - life);
      graphic.scale.set((tuning.ringStartUnits + (tuning.ringEndUnits - tuning.ringStartUnits) * eased) * units);
      graphic.alpha = tuning.ringAlpha * (1 - life);
    } else if (effect.kind === "puff") {
      const eased = 1 - (1 - life) * (1 - life);
      const size = (tuning.puffStartUnits + (tuning.puffEndUnits - tuning.puffStartUnits) * eased) * units;
      graphic.scale.set(size, size * 0.8);
      graphic.alpha = tuning.puffAlpha * (1 - life) * (1 - life);
    } else {
      graphic.scale.set(tuning.clodUnits * units);
      graphic.alpha = life < 0.7 ? 1 : 1 - (life - 0.7) / 0.3;
    }
  }

  destroy(): void {
    this.art = null;
    this.poleUpper = null;
    this.poleLower = null;
    this.cloth = null;
    this.clothRest = null;
    this.effects.length = 0;
    this.effectsLive = 0;
    if (!this.back.destroyed) this.back.destroy({ children: true });
    if (!this.front.destroyed) this.front.destroy({ children: true });
    if (!this.held.destroyed) {
      this.held.removeFromParent();
      this.held.destroy({ children: true });
    }
  }
}
