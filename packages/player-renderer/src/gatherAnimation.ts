import { CanvasSource, Rectangle, Texture } from "pixi.js";

export type GatherKind = "chop" | "mine" | "fish";
/**
 * Every action a player can be shown working on: tool gathering, bare-hand
 * picking of plants, berries, herbs and the like ("harvest"), or building a
 * flag ("flag").
 */
export type GatherActionKind = GatherKind | "harvest" | "flag";
export type GatherSide = "left" | "right";
/** Presentation phase of a fishing action (mapped from the encounter phase by the caller). */
export type GatherFishPhase = "ready" | "wait" | "bite" | "fight";

/**
 * One gathering action shown on a player. `tool` is a loaded texture, an
 * appearance asset key (loaded through the renderer's texture loader), or null
 * for bare hands. `side` is the screen side of the worked object.
 */
export type GatheringAction = Readonly<{
  kind: GatherActionKind;
  tool: Texture | string | null;
  side: GatherSide;
  startedAtMs: number;
  /** Fishing only; defaults to "wait" (line already in the water). */
  fishPhase?: GatherFishPhase;
  /** prefers-reduced-motion: a gentle, minimal version of the same action. */
  reducedMotion?: boolean;
}>;

/**
 * Which motion program plays: tool actions, the two bare-hand variants, and
 * flag building (its own program and bending-arm rig in flagBuildAnimation.ts).
 */
export type GatherProgramId = "chop" | "mine" | "fish" | "chop_hand" | "mine_hand" | "harvest" | "flag";

/** Segment easings, applied to the segment that ends at a key. */
export const EASE = { linear: 0, inOut: 1, in: 2, out: 3 } as const;
type Ease = (typeof EASE)[keyof typeof EASE];
/** [time 0..1 within the cycle, value, easing of the segment ending here]. */
export type Key = readonly [number, number, Ease?];
export type Track = readonly Key[];

export type GatherProgram = Readonly<{
  cycleMs: number;
  /** Cycle fraction of the impact (particles); null = no impact. */
  impactAt: number | null;
  /**
   * Primary upper arm direction, degrees from straight down toward the
   * target side (the rest pose is REST_ARM_DEGREES).
   */
  arm: Track;
  /** Elbow bend of the primary arm in degrees (0 = straight, folds up and in). Absent = 0. */
  bend?: Track;
  /** Tool direction (grip to head), degrees from straight down toward the target side. */
  tool: Track;
  /** Off-hand upper arm (degrees from down toward its own side); absent = stays at rest. */
  offArm?: Track;
  offBend?: Track;
  /** Whole-body lean in degrees, positive toward the target (pivots at the feet). */
  lean: Track;
  /** Positive squashes (shorter, wider), negative stretches. Fraction of height. */
  squash: Track;
  /** Body rise in layer units. */
  lift: Track;
  /** Reduced-motion hold pose the motion is compressed toward. */
  hold: GatherHold;
}>;

export type GatherHold = Readonly<{ arm: number; tool: number; bend?: number; offArm?: number; offBend?: number }>;

/**
 * Every gathering tunable. Geometry is in visualRoot layer units (one unit is
 * about 1.3 screen px at the default body scale), right side; the left side is
 * mirrored. The arm geometry matches the shared template body canvas.
 */
export const GATHER_TUNING = {
  /** Blend into / out of an action so nothing pops. */
  easeMs: 150,
  /** Blend between fishing phases. */
  fishPhaseBlendMs: 220,
  /** Frame gaps longer than this (tab switch, hitch) are clamped. */
  maxFrameMs: 100,
  /** Motion kept under prefers-reduced-motion (fraction around the hold pose). */
  reducedMotionAmount: 0.3,
  reducedBodyAmount: 0.2,
  reducedCadence: 1.5,
  arm: {
    /**
     * Arm geometry in template body canvas pixels (all body PNGs share the
     * 1086 x 1448 canvas), mapped through the live body placement; right arm.
     * The left arm is the mirror image about the canvas centre.
     */
    templateWidth: 1086,
    templateHeight: 1448,
    /** Shoulder joint the arm piece rotates about. */
    shoulderU: 684,
    shoulderV: 742,
    /** Fist centre at rest (the tool grip and hand impact point). */
    fistU: 745,
    fistV: 940,
    /**
     * Region cut out of every arm-covering layer and moved as the arm (sleeves,
     * pauldrons, bracers and gloves follow the skin). Flat u,v list. The torso
     * seam (vertices 5..16, 0) runs down the middle of the outline the torso
     * and arm share at the shoulder, then through the gap between torso and
     * arm below the armpit (measured on the template body, cloth, leather,
     * chainmail and breastplate), so no arm skin is left on the torso and no
     * torso is carried by the arm. The outer side reaches far past the body
     * (up to 940) so arm armour that sticks out is carried whole. Everything
     * above the shoulder stays pinned (see the arm rig).
     */
    polygon: [
      655, 650,
      800, 560,
      900, 640,
      940, 900,
      900, 1045,
      688, 1045,
      684, 1000,
      683, 970,
      676, 940,
      676, 910,
      669, 880,
      659, 845,
      655, 822,
      648, 800,
      645, 760,
      646, 730,
      652, 700
    ] as readonly number[],
    /**
     * Polygon vertex indices of the seam part that runs along the outline the
     * torso and arm share (outlined on both sides after the cut). Below the
     * armpit the cut runs through empty space and needs no outline.
     */
    seam: [11, 12, 13, 14, 15, 16, 0] as readonly number[],
    /** Outline drawn on both sides of the seam, layer units (about the art's line). */
    outlineUnits: 0.32,
    outlineColor: "#3a1000",
    /**
     * Shoulder cap: while an arm is turned, the arm's own shoulder (the rest
     * art on the root side of the shoulder joint, closed below with a
     * half-disc of this radius in template pixels) stays drawn in
     * front of the torso, so the shoulder keeps its full width and the turned
     * arm comes out from under it. 30 px is the arm's half-width at the joint.
     */
    capRadius: 16,
    /** Cut textures are rebuilt at this fraction of the source resolution. */
    textureResolution: 0.5
  },
  /**
   * Held-tool art (1024 px canvas, handle vertical, business end up). Axes and
   * pickaxes share one template (grip on the handle); the fishing pole is a
   * long rod held near its butt, so it has its own grip and a larger scale.
   * Grip/head/tip are normalized texture points; scale is layer units per
   * texture pixel.
   */
  tool: {
    /** Tool direction while easing in from rest (held upright). */
    restDegrees: 165
  },
  tools: {
    chop: { gripX: 0.496, gripY: 0.648, headX: 0.66, headY: 0.25, tipX: 0.5, tipY: 0.14, scale: 0.034 },
    mine: { gripX: 0.496, gripY: 0.648, headX: 0.74, headY: 0.29, tipX: 0.5, tipY: 0.14, scale: 0.034 },
    fish: { gripX: 0.4966, gripY: 0.5098, headX: 0.4966, headY: 0.03, tipX: 0.4966, tipY: 0.03, scale: 0.05 }
  },
  particles: {
    poolSize: 10,
    /** Bare-hand chips start this far (arm lengths) past the fist centre, along the forearm. */
    knuckleReach: 0.32,
    lifeMs: 420,
    gravity: 0.00009,
    chop: { count: 5, colors: [0xb98245, 0x8a5a2b, 0xd9a866], speed: 0.03, size: 1.3 },
    mine: { count: 6, colors: [0x9b9b9b, 0x6e6e6e, 0xffd36b], speed: 0.036, size: 1.1 },
    chop_hand: { count: 3, colors: [0x6aa84f, 0x8a5a2b], speed: 0.022, size: 1.1 },
    mine_hand: { count: 4, colors: [0x9b9b9b, 0x7d7368], speed: 0.024, size: 1.1 },
    /** Harvest pluck: leaves and a berry popping off the plant (no tool, bare hand). */
    harvest: { count: 5, colors: [0x8fc46a, 0xb3263a, 0x4f8f3a, 0xd8e86a, 0x6aa84f], speed: 0.02, size: 1.6 },
    /**
     * Harvest pieces start this far (arm lengths) past the fist centre along
     * the forearm: at the plant the hand has just let go of, clear of the fist.
     */
    harvestReach: 0.5
  },
  fish: {
    castMs: 900,
    /** Cast fraction at which the line leaves the rod (the forward flick). */
    lineAt: 0.5,
    /**
     * Arm poses: upper arm degrees out from straight down, elbow bend
     * degrees. Waiting: 40 out, bent 45 (rod held up and out); ready: 25
     * out, bent 50. The off arm hangs at rest.
     */
    holdArm: 40,
    holdBend: 45,
    readyArm: 25,
    readyBend: 50,
    holdTool: 130,
    bobHz: 0.45,
    bobDegrees: 3,
    biteHz: 7,
    biteDegrees: 6,
    /**
     * Fighting: upper arm 30 out with the elbow pulled in to 85, tugging with
     * the jitter; the off arm braces out (28 out, bent 35).
     */
    fightArm: 30,
    fightArmJitter: 2,
    fightBend: 85,
    fightBendJitter: 8,
    fightOffArm: 28,
    fightOffBend: 35,
    fightTool: 150,
    fightHz: 9,
    fightDegrees: 7,
    fightLean: -4
  }
} as const;

/** Rest arm direction (degrees from down toward the outside) of the template body. */
export const REST_ARM_DEGREES = Math.atan2(
  GATHER_TUNING.arm.fistU - GATHER_TUNING.arm.shoulderU,
  GATHER_TUNING.arm.fistV - GATHER_TUNING.arm.shoulderV
) * 180 / Math.PI;
const REST = REST_ARM_DEGREES;

export const GATHER_PROGRAMS: Readonly<Record<Exclude<GatherProgramId, "fish" | "flag">, GatherProgram>> & {
  fish_cast: GatherProgram;
} = {
  // Arm keys are upper-arm direction (degrees out from straight down) and
  // elbow bend, kept inside the arm rig limits so every frame reads as the
  // chunky chibi arm. Chop: hold (30 out, bent 55) with the axe level; wind
  // up with the upper arm out (66) and the elbow cocked (100) so the fist is
  // up by the head; a fast swing that snaps the elbow straight into the tree
  // side, a short follow-through, then the recoil eases the elbow back. The
  // off arm counter-swings a little from its rest pose. One swing per second.
  chop: {
    cycleMs: 1000,
    impactAt: 0.555,
    arm: [[0, 30], [0.38, 62, EASE.inOut], [0.44, 66], [0.54, 58, EASE.in], [0.555, 56, EASE.out], [0.6, 52, EASE.out], [0.7, 50, EASE.inOut], [1, 30, EASE.inOut]],
    bend: [[0, 55], [0.38, 95, EASE.inOut], [0.44, 100], [0.54, 14, EASE.in], [0.555, 6, EASE.out], [0.6, 4, EASE.out], [0.7, 30, EASE.inOut], [1, 55, EASE.inOut]],
    offArm: [[0, REST], [0.38, 26, EASE.inOut], [0.44, 28], [0.555, 12, EASE.in], [0.7, REST, EASE.out], [1, REST, EASE.inOut]],
    offBend: [[0, 0], [0.38, 20, EASE.inOut], [0.44, 22], [0.555, 8, EASE.in], [0.7, 4, EASE.out], [1, 0, EASE.inOut]],
    tool: [[0, 98], [0.38, 188, EASE.inOut], [0.44, 197], [0.54, 102, EASE.in], [0.555, 96, EASE.out], [0.6, 92, EASE.out], [0.7, 104, EASE.inOut], [1, 98, EASE.inOut]],
    lean: [[0, 0], [0.38, -3, EASE.inOut], [0.44, -3.5], [0.555, 5, EASE.in], [0.66, 3.5, EASE.out], [1, 0, EASE.inOut]],
    squash: [[0, 0], [0.38, -0.03, EASE.inOut], [0.54, 0, EASE.in], [0.575, 0.08, EASE.out], [0.75, 0, EASE.inOut], [1, 0]],
    lift: [[0, 0], [0.4, 0.6, EASE.inOut], [0.555, -0.3, EASE.in], [0.75, 0, EASE.inOut], [1, 0]],
    hold: { arm: 40, tool: 104, bend: 40, offArm: REST, offBend: 0 }
  },
  // Higher raise with the elbow cocked, a heavier downward strike that locks
  // the elbow straight into the rock, a short push through and a bounce back.
  // The off arm counter-swings. Slower than the chop.
  mine: {
    cycleMs: 1300,
    impactAt: 0.64,
    arm: [[0, 25], [0.45, 66, EASE.inOut], [0.53, 70], [0.63, 46, EASE.in], [0.645, 42, EASE.out], [0.68, 40, EASE.out], [0.76, 45, EASE.inOut], [1, 25, EASE.inOut]],
    bend: [[0, 45], [0.45, 95, EASE.inOut], [0.53, 100], [0.63, 10, EASE.in], [0.645, 4, EASE.out], [0.68, 2, EASE.out], [0.76, 30, EASE.inOut], [1, 45, EASE.inOut]],
    offArm: [[0, REST], [0.45, 28, EASE.inOut], [0.53, 30], [0.64, 10, EASE.in], [0.78, REST, EASE.out], [1, REST, EASE.inOut]],
    offBend: [[0, 0], [0.45, 22, EASE.inOut], [0.53, 24], [0.64, 6, EASE.in], [0.78, 4, EASE.out], [1, 0, EASE.inOut]],
    tool: [[0, 80], [0.45, 192, EASE.inOut], [0.53, 201], [0.63, 46, EASE.in], [0.645, 40, EASE.out], [0.68, 38, EASE.out], [0.76, 52, EASE.inOut], [1, 80, EASE.inOut]],
    lean: [[0, 0], [0.45, -3, EASE.inOut], [0.53, -3.5], [0.64, 6, EASE.in], [0.76, 4, EASE.out], [1, 0, EASE.inOut]],
    squash: [[0, 0], [0.45, -0.04, EASE.inOut], [0.53, -0.05], [0.63, 0, EASE.in], [0.665, 0.13, EASE.out], [0.82, 0.01, EASE.inOut], [1, 0]],
    lift: [[0, 0], [0.45, 1, EASE.inOut], [0.53, 1.2], [0.64, -0.5, EASE.in], [0.78, 0, EASE.inOut], [1, 0]],
    hold: { arm: 35, tool: 64, bend: 35, offArm: REST, offBend: 0 }
  },
  // Rod back with the elbow cocked, a quick forward flick that snaps the
  // elbow straight, then the elbow softens into the hold. The off arm
  // counter-swings.
  fish_cast: {
    cycleMs: GATHER_TUNING.fish.castMs,
    impactAt: null,
    arm: [[0, 25], [0.36, 62, EASE.inOut], [0.52, 56, EASE.in], [0.7, 46, EASE.out], [1, 40, EASE.inOut]],
    bend: [[0, 50], [0.36, 95, EASE.inOut], [0.52, 10, EASE.in], [0.7, 28, EASE.out], [1, 45, EASE.inOut]],
    offArm: [[0, REST], [0.36, 26, EASE.inOut], [0.52, 12, EASE.in], [1, REST, EASE.inOut]],
    offBend: [[0, 0], [0.36, 18, EASE.inOut], [0.52, 6, EASE.in], [1, 0, EASE.inOut]],
    tool: [[0, 120], [0.36, 190, EASE.inOut], [0.52, 108, EASE.in], [0.7, 126, EASE.out], [1, 130, EASE.inOut]],
    lean: [[0, 0], [0.36, -3, EASE.inOut], [0.52, 4, EASE.in], [1, 1, EASE.inOut]],
    squash: [[0, 0], [0.36, -0.03, EASE.inOut], [0.52, 0, EASE.in], [0.58, 0.05, EASE.out], [0.85, 0, EASE.inOut], [1, 0]],
    lift: [[0, 0], [0.36, 0.5, EASE.inOut], [0.6, 0, EASE.inOut], [1, 0]],
    hold: { arm: 40, tool: 130, bend: 45, offArm: REST, offBend: 0 }
  },
  // Bare-hand chop: a straight punch into the trunk. Between punches both
  // arms stay near the rest art. Cock-back: the upper arm tucks in, the
  // forearm cocks out at the side and the body leans away; a fast extension
  // drives the fist out to a straight horizontal punch at shoulder height,
  // leaning in, a short hold with a small squash, then back to near rest.
  chop_hand: {
    cycleMs: 900,
    impactAt: 0.6,
    arm: [[0, 22], [0.3, 8, EASE.inOut], [0.42, 2, EASE.out], [0.5, 40, EASE.in], [0.56, 70], [0.6, 84, EASE.out], [0.68, 84], [0.84, 40, EASE.inOut], [1, 22, EASE.inOut]],
    bend: [[0, 20], [0.3, 75, EASE.inOut], [0.42, 85, EASE.out], [0.5, 60, EASE.in], [0.56, 25], [0.6, 0, EASE.out], [0.68, 0], [0.84, 25, EASE.inOut], [1, 20, EASE.inOut]],
    offArm: [[0, 20], [0.42, 30, EASE.inOut], [0.6, 14, EASE.in], [0.75, 18, EASE.out], [1, 20, EASE.inOut]],
    offBend: [[0, 15], [0.42, 30, EASE.inOut], [0.6, 10, EASE.in], [0.75, 15, EASE.out], [1, 15, EASE.inOut]],
    tool: [[0, 70], [1, 70]],
    lean: [[0, 0], [0.42, -4, EASE.inOut], [0.6, 5, EASE.in], [0.68, 5], [0.85, 1, EASE.out], [1, 0, EASE.inOut]],
    squash: [[0, 0], [0.42, -0.02, EASE.inOut], [0.6, 0, EASE.in], [0.63, 0.06, EASE.out], [0.82, 0, EASE.inOut], [1, 0]],
    lift: [[0, 0], [0.42, 0.4, EASE.inOut], [0.6, -0.2, EASE.in], [0.85, 0, EASE.inOut], [1, 0]],
    hold: { arm: 22, tool: 70, bend: 20, offArm: 20, offBend: 15 }
  },
  // Bare-hand mine: a hammer punch onto the rock. From near rest the arm
  // swings up nearly straight to a raised fist beside the head while the body
  // rises high and leans back; it slams down to a straight arm pointing down
  // at the rock top with a deep crouch, a brief hold, a recoil, then back to
  // near rest. The off arm stays low and swings out a little for balance.
  mine_hand: {
    cycleMs: 900,
    impactAt: 0.66,
    arm: [[0, 22], [0.45, 128, EASE.inOut], [0.55, 133], [0.6, 110, EASE.in], [0.66, 40, EASE.in], [0.72, 38, EASE.out], [0.85, 30, EASE.inOut], [1, 22, EASE.inOut]],
    bend: [[0, 20], [0.3, 25, EASE.in], [0.45, 15, EASE.out], [0.55, 18], [0.6, 10, EASE.in], [0.66, 0, EASE.in], [0.72, 0], [0.85, 15, EASE.inOut], [1, 20, EASE.inOut]],
    offArm: [[0, 20], [0.45, 26, EASE.inOut], [0.55, 28], [0.66, 12, EASE.in], [0.8, 18, EASE.out], [1, 20, EASE.inOut]],
    offBend: [[0, 15], [0.45, 25, EASE.inOut], [0.55, 28], [0.66, 10, EASE.in], [0.8, 15, EASE.out], [1, 15, EASE.inOut]],
    tool: [[0, 40], [1, 40]],
    lean: [[0, 0], [0.45, -4.5, EASE.inOut], [0.55, -5], [0.66, 6, EASE.in], [0.8, 4, EASE.out], [1, 0, EASE.inOut]],
    squash: [[0, 0], [0.45, -0.06, EASE.inOut], [0.55, -0.07], [0.66, 0, EASE.in], [0.69, 0.2, EASE.out], [0.86, 0.01, EASE.inOut], [1, 0]],
    lift: [[0, 0], [0.45, 2.2, EASE.inOut], [0.55, 2.5], [0.66, -0.8, EASE.in], [0.82, 0, EASE.inOut], [1, 0]],
    hold: { arm: 22, tool: 40, bend: 20, offArm: 20, offBend: 15 }
  },
  // Harvest (berries, plants, herbs): picking, not punching. From the pouch
  // pose (fist low at the hip) the arm reaches slowly down and out to the
  // plant, nearly straight, while the body leans in and crouches; a short
  // grab (the arm pushes in a touch, then pauses); the pluck is a quick tug
  // that snaps the elbow up and back with the body leaning away (the beat:
  // leaves and a berry pop off the plant); then the hand lowers back to the
  // hip with a small dip as it drops the pick in. The off arm stays low by
  // the hip (a pouch hand), giving a little with the tug.
  harvest: {
    cycleMs: 1100,
    impactAt: 0.43,
    arm: [[0, 20], [0.3, 68, EASE.inOut], [0.36, 71, EASE.out], [0.41, 70], [0.47, 36, EASE.in], [0.53, 32, EASE.out], [0.8, 19, EASE.inOut], [1, 20, EASE.inOut]],
    bend: [[0, 22], [0.3, 10, EASE.inOut], [0.36, 5, EASE.out], [0.41, 9], [0.47, 52, EASE.in], [0.53, 58, EASE.out], [0.8, 20, EASE.inOut], [1, 22, EASE.inOut]],
    offArm: [[0, 21], [0.3, 24, EASE.inOut], [0.41, 24], [0.47, 18, EASE.in], [0.6, 20, EASE.out], [1, 21, EASE.inOut]],
    offBend: [[0, 24], [0.3, 16, EASE.inOut], [0.41, 16], [0.47, 30, EASE.in], [0.6, 26, EASE.out], [1, 24, EASE.inOut]],
    tool: [[0, 70], [1, 70]],
    lean: [[0, 0], [0.3, 8, EASE.inOut], [0.41, 8.5], [0.47, -2, EASE.in], [0.6, 0, EASE.out], [1, 0, EASE.inOut]],
    squash: [[0, 0], [0.3, 0.05, EASE.inOut], [0.41, 0.06], [0.47, -0.03, EASE.in], [0.56, 0.01, EASE.out], [0.8, 0.02, EASE.inOut], [1, 0, EASE.inOut]],
    lift: [[0, 0], [0.3, -0.4, EASE.inOut], [0.41, -0.4], [0.47, 0.5, EASE.in], [0.6, 0, EASE.out], [1, 0]],
    hold: { arm: 40, tool: 70, bend: 25, offArm: 21, offBend: 22 }
  }
};

// ---------------------------------------------------------------------------
// Action-combat swings: one-shot programs (not cycles) on the same arm rig. Each
// starts and ends exactly at the rest pose (arm REST, no bend, tool restDegrees),
// so nothing pops when it begins or ends. `tool` is the weapon direction in the
// gather convention; the held weapon is turned by its difference from the rest
// direction. Playback samples t = elapsedMs / cycleMs once and never loops.

export type SwingVariant = "swing" | "finisher" | "shot";

const TOOL_REST = GATHER_TUNING.tool.restDegrees;

/**
 * ms after the press at which the blade crosses the target: the predicted hit effects (flash, spark, hitstop,
 * number, kick) are scheduled here so impact and picture land on the same frame. Matches the 0.3 and 0.27 keys
 * of the two programs below (swing 350 ms x 0.3, finisher 440 ms x 0.27). A shot has its own flight time.
 */
export const SWING_CONTACT_MS: Readonly<Record<SwingVariant, number>> = { swing: 105, finisher: 119, shot: 0 };

export const SWING_PROGRAMS: Readonly<Record<SwingVariant, GatherProgram>> = {
  // About 350 ms: a quick windup raise (elbow cocked, weapon back, peak 49 ms), a
  // fast strike that crosses the target at SWING_CONTACT_MS.swing (105 ms), a
  // follow-through, then back to rest.
  swing: {
    cycleMs: 350,
    impactAt: null,
    arm: [[0, REST], [0.14, 62, EASE.out], [0.3, 58, EASE.in], [0.6, 48, EASE.out], [1, REST, EASE.inOut]],
    bend: [[0, 0], [0.14, 92, EASE.out], [0.3, 8, EASE.in], [0.6, 24, EASE.out], [1, 0, EASE.inOut]],
    tool: [[0, TOOL_REST], [0.14, 190, EASE.out], [0.3, 96, EASE.in], [0.6, 80, EASE.out], [1, TOOL_REST, EASE.inOut]],
    offArm: [[0, REST], [0.14, 26, EASE.out], [0.3, 12, EASE.in], [1, REST, EASE.inOut]],
    offBend: [[0, 0], [0.14, 18, EASE.out], [0.3, 6, EASE.in], [1, 0, EASE.inOut]],
    lean: [[0, 0], [0.14, -2.5, EASE.out], [0.3, 4.5, EASE.in], [1, 0, EASE.inOut]],
    squash: [[0, 0], [0.14, -0.02, EASE.out], [0.31, 0.04, EASE.in], [1, 0, EASE.inOut]],
    lift: [[0, 0], [0.14, 0.4, EASE.out], [0.3, -0.2, EASE.in], [1, 0, EASE.inOut]],
    hold: { arm: 40, tool: 104, bend: 30, offArm: REST, offBend: 0 }
  },
  // Combo finisher, about 440 ms: a higher, further-back windup (peak 70 ms) and a
  // bigger arc that crosses at SWING_CONTACT_MS.finisher (119 ms), through a low
  // follow-through, with a heavier lean.
  finisher: {
    cycleMs: 440,
    impactAt: null,
    arm: [[0, REST], [0.16, 76, EASE.out], [0.27, 64, EASE.in], [0.6, 40, EASE.out], [1, REST, EASE.inOut]],
    bend: [[0, 0], [0.16, 108, EASE.out], [0.27, 4, EASE.in], [0.6, 30, EASE.out], [1, 0, EASE.inOut]],
    tool: [[0, TOOL_REST], [0.16, 208, EASE.out], [0.27, 84, EASE.in], [0.6, 50, EASE.out], [1, TOOL_REST, EASE.inOut]],
    offArm: [[0, REST], [0.16, 30, EASE.out], [0.27, 10, EASE.in], [1, REST, EASE.inOut]],
    offBend: [[0, 0], [0.16, 24, EASE.out], [0.27, 6, EASE.in], [1, 0, EASE.inOut]],
    lean: [[0, 0], [0.16, -4.5, EASE.out], [0.27, 7, EASE.in], [0.6, 4, EASE.out], [1, 0, EASE.inOut]],
    squash: [[0, 0], [0.16, -0.035, EASE.out], [0.28, 0.07, EASE.in], [1, 0, EASE.inOut]],
    lift: [[0, 0], [0.16, 0.8, EASE.out], [0.27, -0.4, EASE.in], [1, 0, EASE.inOut]],
    hold: { arm: 45, tool: 90, bend: 40, offArm: REST, offBend: 0 }
  },
  // Ranged, about 400 ms: the weapon arm reaches out toward the aim, the off arm
  // draws back with the elbow folded, then lets go (a snap) and both settle.
  shot: {
    cycleMs: 400,
    impactAt: null,
    arm: [[0, REST], [0.3, 74, EASE.out], [0.62, 76, EASE.linear], [0.8, 68, EASE.out], [1, REST, EASE.inOut]],
    bend: [[0, 0], [0.3, 6, EASE.out], [0.62, 6, EASE.linear], [0.8, 10, EASE.out], [1, 0, EASE.inOut]],
    tool: [[0, TOOL_REST], [0.3, 150, EASE.out], [0.62, 148, EASE.linear], [0.8, 152, EASE.out], [1, TOOL_REST, EASE.inOut]],
    offArm: [[0, REST], [0.3, 46, EASE.out], [0.62, 52, EASE.linear], [0.7, 28, EASE.in], [1, REST, EASE.inOut]],
    offBend: [[0, 0], [0.3, 100, EASE.out], [0.62, 112, EASE.linear], [0.7, 30, EASE.in], [1, 0, EASE.inOut]],
    lean: [[0, 0], [0.3, -2, EASE.out], [0.62, -3, EASE.linear], [0.72, 2.5, EASE.in], [1, 0, EASE.inOut]],
    squash: [[0, 0], [0.62, 0.01, EASE.linear], [0.74, 0.03, EASE.in], [1, 0, EASE.inOut]],
    lift: [[0, 0], [0.3, 0.2, EASE.out], [0.7, -0.1, EASE.in], [1, 0, EASE.inOut]],
    hold: { arm: 60, tool: 150, bend: 8, offArm: REST, offBend: 0 }
  }
};

/** Samples a swing at elapsedMs since its start into out; holds the end (rest) pose after. No allocation. */
export function sampleSwing(variant: SwingVariant, elapsedMs: number, out: GatherPose): GatherPose {
  const program = SWING_PROGRAMS[variant];
  const t = elapsedMs <= 0 ? 0 : elapsedMs >= program.cycleMs ? 1 : elapsedMs / program.cycleMs;
  return sampleProgramAt(program, t, out);
}

export function gatherProgramId(kind: GatherActionKind, hasTool: boolean): GatherProgramId {
  if (kind === "fish" || kind === "flag" || kind === "harvest") return kind;
  if (hasTool) return kind;
  return kind === "chop" ? "chop_hand" : "mine_hand";
}

/** Mutable pose sample; one per renderer, reused every frame. */
export type GatherPose = {
  /** Upper arm direction (degrees out from straight down). */
  arm: number;
  /** Elbow bend in degrees. */
  bend: number;
  tool: number;
  /** Off-hand upper arm direction; NaN = at rest. */
  offArm: number;
  offBend: number;
  lean: number;
  squash: number;
  lift: number;
};

export function createGatherPose(): GatherPose {
  return { arm: 0, bend: 0, tool: 0, offArm: Number.NaN, offBend: 0, lean: 0, squash: 0, lift: 0 };
}

function applyEase(t: number, ease: Ease | undefined): number {
  switch (ease) {
    case EASE.inOut: return t * t * (3 - 2 * t);
    case EASE.in: return t * t * t;
    case EASE.out: {
      const u = 1 - t;
      return 1 - u * u * u;
    }
    default: return t;
  }
}

/** Value of a key track at cycle fraction t (0..1). No allocation. */
export function sampleTrack(track: Track, t: number): number {
  const first = track[0]!;
  if (t <= first[0]) return first[1];
  for (let index = 1; index < track.length; index += 1) {
    const key = track[index]!;
    if (t <= key[0]) {
      const previous = track[index - 1]!;
      const span = key[0] - previous[0];
      const local = span > 0 ? (t - previous[0]) / span : 1;
      return previous[1] + (key[1] - previous[1]) * applyEase(local, key[2]);
    }
  }
  return track[track.length - 1]![1];
}

/** Samples a cyclic program at elapsedMs into out. */
export function sampleProgram(
  program: GatherProgram,
  elapsedMs: number,
  cadence: number,
  out: GatherPose
): GatherPose {
  const cycleMs = program.cycleMs * cadence;
  const t = cycleMs > 0 ? ((elapsedMs % cycleMs) + cycleMs) % cycleMs / cycleMs : 0;
  return sampleProgramAt(program, t, out);
}

export function sampleProgramAt(program: GatherProgram, t: number, out: GatherPose): GatherPose {
  out.arm = sampleTrack(program.arm, t);
  out.bend = program.bend ? sampleTrack(program.bend, t) : 0;
  out.tool = sampleTrack(program.tool, t);
  out.offArm = program.offArm ? sampleTrack(program.offArm, t) : Number.NaN;
  out.offBend = program.offBend ? sampleTrack(program.offBend, t) : 0;
  out.lean = sampleTrack(program.lean, t);
  out.squash = sampleTrack(program.squash, t);
  out.lift = sampleTrack(program.lift, t);
  return out;
}

/** Number of impacts whose time lies in (fromMs, toMs]. */
export function impactsBetween(
  program: Pick<GatherProgram, "cycleMs" | "impactAt">,
  cadence: number,
  fromMs: number,
  toMs: number
): number {
  if (program.impactAt === null || !(toMs > fromMs)) return 0;
  const cycleMs = program.cycleMs * cadence;
  const impactMs = program.impactAt * cycleMs;
  const before = Math.floor((fromMs - impactMs) / cycleMs);
  const after = Math.floor((toMs - impactMs) / cycleMs);
  return Math.max(0, after - before);
}

/** One fishing phase pose at elapsed ms since the phase timeline origin. */
export function sampleFishPhase(
  phase: GatherFishPhase,
  sinceCastMs: number,
  nowMs: number,
  out: GatherPose
): GatherPose {
  const f = GATHER_TUNING.fish;
  out.offArm = REST_ARM_DEGREES;
  out.bend = f.holdBend;
  out.offBend = 0;
  if (phase === "ready") {
    out.arm = f.readyArm;
    out.bend = f.readyBend;
    out.tool = 120;
    out.lean = 0;
    out.squash = 0;
    out.lift = 0.15 * Math.sin(nowMs * 0.0021);
    return out;
  }
  if (sinceCastMs < f.castMs && phase === "wait") {
    return sampleProgramAt(GATHER_PROGRAMS.fish_cast, sinceCastMs / f.castMs, out);
  }
  const seconds = nowMs / 1000;
  const bob = Math.sin(seconds * Math.PI * 2 * f.bobHz);
  out.lift = 0.15 * Math.sin(seconds * 2.1);
  out.squash = 0;
  if (phase === "fight") {
    const jitter = Math.sin(seconds * Math.PI * 2 * f.fightHz) *
      (0.65 + 0.35 * Math.sin(seconds * Math.PI * 2 * 1.7));
    out.arm = f.fightArm + jitter * f.fightArmJitter;
    out.bend = f.fightBend + jitter * f.fightBendJitter;
    out.offArm = f.fightOffArm - jitter * 2;
    out.offBend = f.fightOffBend;
    out.tool = f.fightTool + jitter * f.fightDegrees;
    out.lean = f.fightLean + jitter * 0.8;
    out.squash = 0.015 * jitter;
    return out;
  }
  out.arm = f.holdArm + bob * 1.5;
  out.bend = f.holdBend - bob * 1.5;
  out.tool = f.holdTool + Math.sin(seconds * Math.PI * 2 * f.bobHz + 0.6) * f.bobDegrees;
  out.lean = 1;
  if (phase === "bite") {
    const twitch = Math.sin(seconds * Math.PI * 2 * f.biteHz) *
      (0.6 + 0.4 * Math.sin(seconds * Math.PI * 2 * 1.3));
    out.tool += twitch * f.biteDegrees;
    out.arm += twitch * 2;
    out.bend += Math.abs(twitch) * 6;
  }
  return out;
}

export function lerpPose(from: GatherPose, to: GatherPose, amount: number, out: GatherPose): GatherPose {
  out.arm = from.arm + (to.arm - from.arm) * amount;
  out.bend = from.bend + (to.bend - from.bend) * amount;
  out.offBend = from.offBend + (to.offBend - from.offBend) * amount;
  out.tool = from.tool + (to.tool - from.tool) * amount;
  out.offArm = Number.isNaN(from.offArm) || Number.isNaN(to.offArm)
    ? (amount < 0.5 ? from.offArm : to.offArm)
    : from.offArm + (to.offArm - from.offArm) * amount;
  out.lean = from.lean + (to.lean - from.lean) * amount;
  out.squash = from.squash + (to.squash - from.squash) * amount;
  out.lift = from.lift + (to.lift - from.lift) * amount;
  return out;
}

/** Compresses a pose toward the hold pose for prefers-reduced-motion. */
export function reducePose(pose: GatherPose, hold: GatherHold): GatherPose {
  const keep = GATHER_TUNING.reducedMotionAmount;
  const body = GATHER_TUNING.reducedBodyAmount;
  pose.arm = hold.arm + (pose.arm - hold.arm) * keep;
  const bend = hold.bend ?? 0;
  pose.bend = bend + (pose.bend - bend) * keep;
  pose.tool = hold.tool + (pose.tool - hold.tool) * keep;
  const offArm = hold.offArm ?? hold.arm;
  if (!Number.isNaN(pose.offArm)) pose.offArm = offArm + (pose.offArm - offArm) * keep;
  const offBend = hold.offBend ?? 0;
  pose.offBend = offBend + (pose.offBend - offBend) * keep;
  pose.lean *= body;
  pose.squash *= body;
  pose.lift *= body;
  return pose;
}

const DEG = Math.PI / 180;

/** Pixi rotation of a tool sprite whose texture "up" should point at toolDegrees. */
export function toolRotation(toolDegrees: number, sign: number): number {
  return sign * (Math.PI - toolDegrees * DEG);
}

export type MutablePoint = { x: number; y: number };

/** Arm geometry in visualRoot layer units for the current body placement. */
export type ArmGeometry = {
  /** Mirror axis of the body (layer x of the canvas centre). */
  centerX: number;
  shoulderX: number;
  shoulderY: number;
  fistX: number;
  fistY: number;
  /** Right-arm polygon, flat x,y list. */
  polygon: number[];
};

/** Maps the template arm geometry through a body sprite placement. */
export function armGeometryForBody(
  placement: ArmCutPlacement,
  textureWidth: number,
  textureHeight: number,
  out: ArmGeometry
): ArmGeometry {
  const a = GATHER_TUNING.arm;
  const su = textureWidth / a.templateWidth;
  const sv = textureHeight / a.templateHeight;
  const c = Math.cos(placement.rotation);
  const s = Math.sin(placement.rotation);
  const point: MutablePoint = { x: 0, y: 0 };
  const map = (u: number, v: number): MutablePoint => {
    const lx = (u * su - placement.pivotX) * placement.scaleX;
    const ly = (v * sv - placement.pivotY) * placement.scaleY;
    point.x = placement.x + c * lx - s * ly;
    point.y = placement.y + s * lx + c * ly;
    return point;
  };
  out.centerX = map(a.templateWidth / 2, a.templateHeight / 2).x;
  map(a.shoulderU, a.shoulderV);
  out.shoulderX = point.x;
  out.shoulderY = point.y;
  map(a.fistU, a.fistV);
  out.fistX = point.x;
  out.fistY = point.y;
  out.polygon.length = a.polygon.length;
  for (let index = 0; index < a.polygon.length; index += 2) {
    map(a.polygon[index]!, a.polygon[index + 1]!);
    out.polygon[index] = point.x;
    out.polygon[index + 1] = point.y;
  }
  return out;
}

/** Geometry for a nominal body placement, used until a real body is measured. */
export function createArmGeometry(): ArmGeometry {
  const a = GATHER_TUNING.arm;
  const scale = 0.0479;
  return armGeometryForBody(
    { x: 0, y: 32, scaleX: scale, scaleY: scale, rotation: 0, pivotX: a.templateWidth / 2, pivotY: a.templateHeight },
    a.templateWidth,
    a.templateHeight,
    { centerX: 0, shoulderX: 0, shoulderY: 0, fistX: 0, fistY: 0, polygon: [] }
  );
}

/** Layer x of a right-arm point mirrored for the given side. */
export function sideX(geometry: ArmGeometry, x: number, sign: number): number {
  return sign > 0 ? x : 2 * geometry.centerX - x;
}

// ---------------------------------------------------------------------------
// Arm cut-outs: each arm-covering layer sprite is split once (per texture and
// sides) into an armless texture and an arm piece per side that the arm rig
// bends (armRig.ts). Built lazily on the first gather, cached and shared
// across players.

export type ArmCutPlacement = Readonly<{
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  /** Local origin offset in texture points (anchor * size, or a mesh pivot). */
  pivotX: number;
  pivotY: number;
}>;

export type ArmCut = Readonly<{
  armless: Texture;
  /** One piece per requested side, same order as the request. */
  pieces: readonly Texture[];
  /**
   * Per side, the outline along the torso seam on the armless art only
   * (trimmed like the pieces); shown once the arm moves off the seam.
   */
  seams?: readonly Texture[];
  /**
   * Per side, the outline along the cut edge of the arm piece only, same
   * frame as the piece; shown once the arm moves off the seam.
   */
  pieceSeams?: readonly Texture[];
  /** Per side, the shoulder cap (same frame as the armless texture's trim of the piece). */
  caps?: readonly Texture[];
}>;

/** Produces (or reuses) the cut textures; null when the texture cannot be cut. */
export type ArmCutter = (
  texture: Texture,
  placement: ArmCutPlacement,
  signs: readonly number[],
  geometry: ArmGeometry
) => ArmCut | null;

/** Releases one use of a cut previously returned by the same cutter. */
export type ArmCutRelease = (cut: ArmCut) => void;

/** Maps the layer-space arm polygon of one side into a sprite's texture points. */
export function armPolygonInTexture(
  geometry: ArmGeometry,
  placement: ArmCutPlacement,
  sign: number,
  out: number[]
): number[] {
  const polygon = geometry.polygon;
  const c = Math.cos(-placement.rotation);
  const s = Math.sin(-placement.rotation);
  out.length = polygon.length;
  for (let index = 0; index < polygon.length; index += 2) {
    const lx = sideX(geometry, polygon[index]!, sign) - placement.x;
    const ly = polygon[index + 1]! - placement.y;
    const rx = c * lx - s * ly;
    const ry = s * lx + c * ly;
    out[index] = placement.pivotX + rx / (placement.scaleX || 1);
    out[index + 1] = placement.pivotY + ry / (placement.scaleY || 1);
  }
  return out;
}

type CanvasLike = HTMLCanvasElement | OffscreenCanvas;
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createCanvas(width: number, height: number): CanvasLike | null {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  return null;
}

function tracePolygon(context: Context2D, points: readonly number[], scale: number, ox: number, oy: number): void {
  context.beginPath();
  for (let index = 0; index < points.length; index += 2) {
    const x = (points[index]! - ox) * scale;
    const y = (points[index + 1]! - oy) * scale;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
}

/** Strokes the seam path with the current composite mode (no colour change). */
function strokeSeamPath(
  context: Context2D,
  points: readonly number[],
  scale: number,
  ox: number,
  oy: number,
  width: number
): void {
  const seam = GATHER_TUNING.arm.seam;
  context.lineWidth = width;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.strokeStyle = "#000";
  context.beginPath();
  for (let index = 0; index < seam.length; index += 1) {
    const vertex = seam[index]! * 2;
    const x = (points[vertex]! - ox) * scale;
    const y = (points[vertex + 1]! - oy) * scale;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
}

function strokeSeam(
  context: Context2D,
  points: readonly number[],
  scale: number,
  ox: number,
  oy: number,
  width: number
): void {
  const seam = GATHER_TUNING.arm.seam;
  context.save();
  context.globalCompositeOperation = "source-atop";
  context.strokeStyle = GATHER_TUNING.arm.outlineColor;
  context.lineWidth = width;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  for (let index = 0; index < seam.length; index += 1) {
    const vertex = seam[index]! * 2;
    const x = (points[vertex]! - ox) * scale;
    const y = (points[vertex + 1]! - oy) * scale;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
  context.restore();
}

type DrawableSource = CanvasImageSource & { width: number; height: number };

function drawableResource(texture: Texture): DrawableSource | null {
  const resource = (texture.source as { resource?: unknown }).resource;
  if (!resource || typeof resource !== "object") return null;
  const candidate = resource as Partial<DrawableSource>;
  if (typeof candidate.width !== "number" || typeof candidate.height !== "number") return null;
  if (candidate.width <= 0 || candidate.height <= 0) return null;
  const isImage = (typeof ImageBitmap !== "undefined" && resource instanceof ImageBitmap) ||
    (typeof HTMLImageElement !== "undefined" && resource instanceof HTMLImageElement) ||
    (typeof HTMLCanvasElement !== "undefined" && resource instanceof HTMLCanvasElement) ||
    (typeof OffscreenCanvas !== "undefined" && resource instanceof OffscreenCanvas);
  return isImage ? candidate as DrawableSource : null;
}

function canvasTexture(canvas: CanvasLike, width: number, height: number, resolution: number, layout?: {
  orig: Rectangle;
  trim: Rectangle;
}): Texture {
  // The source spans whole canvas pixels; the frame is the exact point size,
  // so UVs (and mesh vertices built for the original size) line up exactly.
  const source = new CanvasSource({
    resource: canvas,
    width: canvas.width / resolution,
    height: canvas.height / resolution,
    resolution
  });
  return new Texture({
    source,
    frame: new Rectangle(0, 0, width, height),
    ...(layout ?? {})
  });
}

/**
 * Crops a cut piece to its visible pixels plus a transparent border (so mesh
 * samples past the edge stay clear). Offsets and sizes in texture points.
 */
function tightenCanvas(
  canvas: CanvasLike,
  context: Context2D,
  resolution: number
): { canvas: CanvasLike; x: number; y: number; width: number; height: number } {
  const whole = { canvas, x: 0, y: 0, width: canvas.width / resolution, height: canvas.height / resolution };
  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return whole;
  }
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    const row = y * canvas.width * 4;
    for (let x = 0; x < canvas.width; x += 1) {
      if (data[row + x * 4 + 3]! <= 2) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const margin = 2;
  if (maxX < 0) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  const width = maxX - minX + 1 + margin * 2;
  const height = maxY - minY + 1 + margin * 2;
  const tight = createCanvas(width, height);
  const tightContext = tight?.getContext("2d") as Context2D | null | undefined;
  if (!tight || !tightContext) return whole;
  tightContext.drawImage(canvas, margin - minX, margin - minY);
  return {
    canvas: tight,
    x: (minX - margin) / resolution,
    y: (minY - margin) / resolution,
    width: width / resolution,
    height: height / resolution
  };
}

/** Splits a texture with canvas 2D. Pure DOM work; returns null when it cannot draw. */
export function cutArmTexturesWithCanvas(
  texture: Texture,
  placement: ArmCutPlacement,
  signs: readonly number[],
  geometry: ArmGeometry
): ArmCut | null {
  const resource = drawableResource(texture);
  if (!resource) return null;
  const frame = texture.frame;
  const width = texture.width;
  const height = texture.height;
  if (!(width > 0 && height > 0)) return null;
  const pixelsPerPoint = texture.source.resolution || 1;
  const resolution = GATHER_TUNING.arm.textureResolution;
  const outline = GATHER_TUNING.arm.outlineUnits * 2 /
    Math.max(1e-6, (Math.abs(placement.scaleX) + Math.abs(placement.scaleY)) / 2);
  const armless = createCanvas(width * resolution, height * resolution);
  const armlessContext = armless?.getContext("2d") as Context2D | null | undefined;
  if (!armless || !armlessContext) return null;
  armlessContext.drawImage(
    resource,
    frame.x * pixelsPerPoint,
    frame.y * pixelsPerPoint,
    frame.width * pixelsPerPoint,
    frame.height * pixelsPerPoint,
    0,
    0,
    width * resolution,
    height * resolution
  );
  const pieces: Texture[] = [];
  const pieceSeams: Texture[] = [];
  const caps: Texture[] = [];
  const polygon: number[] = [];
  const templateLength = Math.hypot(GATHER_TUNING.arm.fistU - GATHER_TUNING.arm.shoulderU, GATHER_TUNING.arm.fistV - GATHER_TUNING.arm.shoulderV);
  const layerLength = Math.hypot(geometry.fistX - geometry.shoulderX, geometry.fistY - geometry.shoulderY);
  const capRadius = GATHER_TUNING.arm.capRadius * layerLength / templateLength /
    Math.max(1e-6, (Math.abs(placement.scaleX) + Math.abs(placement.scaleY)) / 2);
  const toTexture = (x: number, y: number, out: MutablePoint): MutablePoint => {
    const lx = x - placement.x;
    const ly = y - placement.y;
    const c = Math.cos(-placement.rotation);
    const s = Math.sin(-placement.rotation);
    out.x = placement.pivotX + (c * lx - s * ly) / (placement.scaleX || 1);
    out.y = placement.pivotY + (s * lx + c * ly) / (placement.scaleY || 1);
    return out;
  };
  const jointPoint: MutablePoint = { x: 0, y: 0 };
  const fistPoint: MutablePoint = { x: 0, y: 0 };
  for (const sign of signs) {
    armPolygonInTexture(geometry, placement, sign, polygon);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < polygon.length; index += 2) {
      minX = Math.min(minX, polygon[index]!);
      maxX = Math.max(maxX, polygon[index]!);
      minY = Math.min(minY, polygon[index + 1]!);
      maxY = Math.max(maxY, polygon[index + 1]!);
    }
    minX = Math.max(0, Math.floor(minX - outline));
    minY = Math.max(0, Math.floor(minY - outline));
    maxX = Math.min(width, Math.ceil(maxX + outline));
    maxY = Math.min(height, Math.ceil(maxY + outline));
    const pieceWidth = Math.max(1, maxX - minX);
    const pieceHeight = Math.max(1, maxY - minY);
    const piece = createCanvas(pieceWidth * resolution, pieceHeight * resolution);
    const pieceContext = piece?.getContext("2d") as Context2D | null | undefined;
    if (!piece || !pieceContext) return null;
    pieceContext.drawImage(armless, -minX * resolution, -minY * resolution);
    pieceContext.globalCompositeOperation = "destination-in";
    tracePolygon(pieceContext, polygon, resolution, minX, minY);
    pieceContext.fill();
    pieceContext.globalCompositeOperation = "source-over";
    const tight = tightenCanvas(piece, pieceContext, resolution);
    const layout = {
      orig: new Rectangle(0, 0, width, height),
      trim: new Rectangle(minX + tight.x, minY + tight.y, tight.width, tight.height)
    };
    pieces.push(canvasTexture(tight.canvas, tight.width, tight.height, resolution, layout));
    // The cut edge's outline on the piece, apart so it can fade in as the arm leaves.
    const edge = createCanvas(tight.canvas.width, tight.canvas.height);
    const edgeContext = edge?.getContext("2d") as Context2D | null | undefined;
    if (!edge || !edgeContext) return null;
    edgeContext.drawImage(tight.canvas, 0, 0);
    const edgeX = minX + tight.x;
    const edgeY = minY + tight.y;
    strokeSeam(edgeContext, polygon, resolution, edgeX, edgeY, outline * resolution);
    edgeContext.globalCompositeOperation = "destination-in";
    strokeSeamPath(edgeContext, polygon, resolution, edgeX, edgeY, outline * resolution);
    pieceSeams.push(canvasTexture(edge, tight.width, tight.height, resolution, {
      orig: new Rectangle(0, 0, width, height),
      trim: new Rectangle(edgeX, edgeY, tight.width, tight.height)
    }));
    // Shoulder cap: the piece on the root side of the joint row, closed below
    // with a half-disc round the joint (no line: it sits on the arm's root).
    toTexture(sideX(geometry, geometry.shoulderX, sign), geometry.shoulderY, jointPoint);
    toTexture(sideX(geometry, geometry.fistX, sign), geometry.fistY, fistPoint);
    const cap = createCanvas(tight.canvas.width, tight.canvas.height);
    const capContext = cap?.getContext("2d") as Context2D | null | undefined;
    const capMask = createCanvas(tight.canvas.width, tight.canvas.height);
    const maskContext = capMask?.getContext("2d") as Context2D | null | undefined;
    if (!cap || !capContext || !capMask || !maskContext) return null;
    const jx = (jointPoint.x - edgeX) * resolution;
    const jy = (jointPoint.y - edgeY) * resolution;
    let ax = fistPoint.x - jointPoint.x;
    let ay = fistPoint.y - jointPoint.y;
    const axisLength = Math.hypot(ax, ay) || 1;
    ax /= axisLength;
    ay /= axisLength;
    const far = (tight.canvas.width + tight.canvas.height) * 2;
    const r = capRadius * resolution;
    maskContext.fillStyle = "#000";
    maskContext.beginPath();
    maskContext.moveTo(jx - ay * far, jy + ax * far);
    maskContext.lineTo(jx + ay * far, jy - ax * far);
    maskContext.lineTo(jx + ay * far - ax * far, jy - ax * far - ay * far);
    maskContext.lineTo(jx - ay * far - ax * far, jy + ax * far - ay * far);
    maskContext.closePath();
    maskContext.fill();
    maskContext.beginPath();
    maskContext.arc(jx, jy, r, 0, Math.PI * 2);
    maskContext.fill();
    capContext.drawImage(tight.canvas, 0, 0);
    capContext.globalCompositeOperation = "destination-in";
    capContext.drawImage(capMask, 0, 0);
    caps.push(canvasTexture(cap, tight.width, tight.height, resolution, {
      orig: new Rectangle(0, 0, width, height),
      trim: new Rectangle(edgeX, edgeY, tight.width, tight.height)
    }));
  }
  // Remove every requested arm from the armless copy only after all pieces were cut.
  const bounds: number[][] = [];
  for (const sign of signs) {
    armPolygonInTexture(geometry, placement, sign, polygon);
    armlessContext.save();
    armlessContext.globalCompositeOperation = "destination-out";
    tracePolygon(armlessContext, polygon, resolution, 0, 0);
    armlessContext.fill();
    armlessContext.restore();
    bounds.push(polygon.slice());
  }
  // The seam outline over the torso, kept apart so it can fade in as the arm leaves.
  const seams: Texture[] = [];
  for (const points of bounds) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const vertex of GATHER_TUNING.arm.seam) {
      minX = Math.min(minX, points[vertex * 2]!);
      maxX = Math.max(maxX, points[vertex * 2]!);
      minY = Math.min(minY, points[vertex * 2 + 1]!);
      maxY = Math.max(maxY, points[vertex * 2 + 1]!);
    }
    minX = Math.max(0, Math.floor(minX - outline));
    minY = Math.max(0, Math.floor(minY - outline));
    maxX = Math.min(width, Math.ceil(maxX + outline));
    maxY = Math.min(height, Math.ceil(maxY + outline));
    const seamWidth = Math.max(1, maxX - minX);
    const seamHeight = Math.max(1, maxY - minY);
    const seam = createCanvas(seamWidth * resolution, seamHeight * resolution);
    const seamContext = seam?.getContext("2d") as Context2D | null | undefined;
    if (!seam || !seamContext) return null;
    seamContext.drawImage(armless, -minX * resolution, -minY * resolution);
    strokeSeam(seamContext, points, resolution, minX, minY, outline * resolution);
    seamContext.globalCompositeOperation = "destination-in";
    strokeSeamPath(seamContext, points, resolution, minX, minY, outline * resolution);
    seams.push(canvasTexture(seam, seamWidth, seamHeight, resolution, {
      orig: new Rectangle(0, 0, width, height),
      trim: new Rectangle(minX, minY, seamWidth, seamHeight)
    }));
  }
  return { armless: canvasTexture(armless, width, height, resolution), pieces, seams, pieceSeams, caps };
}

type CacheEntry = { cut: ArmCut; reversed: ArmCut | null; uses: number; idleSince: number };

/** The same cut with its per-side arrays in the opposite side order (shares every texture). */
function reversedCut(cut: ArmCut): ArmCut {
  const flip = <T>(list: readonly T[] | undefined): T[] | undefined => list ? [...list].reverse() : undefined;
  const pieceSeams = flip(cut.pieceSeams);
  const seams = flip(cut.seams);
  const caps = flip(cut.caps);
  return {
    armless: cut.armless,
    pieces: flip(cut.pieces)!,
    ...(seams ? { seams } : {}),
    ...(pieceSeams ? { pieceSeams } : {}),
    ...(caps ? { caps } : {})
  };
}

/**
 * Caching cutter: the same texture, placement and sides share one cut across
 * players. Unused cuts are kept (most recent first) up to idleLimit. Each
 * side is cut independently of the others, so the same two sides in either
 * order share one cut (a right-side action, a left-side action and the
 * local player's pre-cut all hit the same entry).
 */
export function createCachedArmCutter(
  cut: ArmCutter = cutArmTexturesWithCanvas,
  idleLimit = 16
): { cutter: ArmCutter; release: ArmCutRelease; size(): number } {
  const entries = new Map<string, CacheEntry>();
  const byCut = new Map<ArmCut, string>();
  let clock = 0;
  const evict = (): void => {
    let idle = 0;
    for (const entry of entries.values()) if (entry.uses === 0) idle += 1;
    while (idle > idleLimit) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, entry] of entries) {
        if (entry.uses === 0 && entry.idleSince < oldest) {
          oldest = entry.idleSince;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      const entry = entries.get(oldestKey)!;
      entries.delete(oldestKey);
      byCut.delete(entry.cut);
      if (entry.reversed) byCut.delete(entry.reversed);
      entry.cut.armless.destroy(true);
      for (const piece of entry.cut.pieces) piece.destroy(true);
      for (const seam of entry.cut.seams ?? []) seam.destroy(true);
      for (const seam of entry.cut.pieceSeams ?? []) seam.destroy(true);
      for (const cap of entry.cut.caps ?? []) cap.destroy(true);
      idle -= 1;
    }
  };
  return {
    cutter(texture, placement, signs, geometry) {
      const reverse = signs.length === 2 && signs[0]! < signs[1]!;
      const canonical = reverse ? [signs[1]!, signs[0]!] : signs;
      const key = [
        texture.uid,
        placement.x, placement.y, placement.scaleX, placement.scaleY,
        placement.rotation, placement.pivotX, placement.pivotY,
        canonical.join(","),
        geometry.centerX, geometry.polygon.join(",")
      ].join("|");
      let entry = entries.get(key);
      if (entry) {
        entry.uses += 1;
      } else {
        const made = cut(texture, placement, canonical, geometry);
        if (!made) return null;
        entry = { cut: made, reversed: null, uses: 1, idleSince: 0 };
        entries.set(key, entry);
        byCut.set(made, key);
      }
      if (!reverse) return entry.cut;
      if (!entry.reversed) {
        entry.reversed = reversedCut(entry.cut);
        byCut.set(entry.reversed, key);
      }
      return entry.reversed;
    },
    release(made) {
      const key = byCut.get(made);
      const entry = key === undefined ? undefined : entries.get(key);
      if (!entry) return;
      entry.uses = Math.max(0, entry.uses - 1);
      if (entry.uses === 0) {
        entry.idleSince = ++clock;
        evict();
      }
    },
    size: () => entries.size
  };
}

const sharedCutter = createCachedArmCutter();
export const defaultArmCutter: ArmCutter = sharedCutter.cutter;
export const defaultArmCutRelease: ArmCutRelease = sharedCutter.release;

// ---------------------------------------------------------------------------
// Side selection with hysteresis (screen x of the worked object vs the player).

/**
 * Picks the hand for a target at targetScreenX. Keeps the previous side until
 * the target is clearly (more than hysteresisPx) on the other side.
 */
export function gatherSideForTarget(
  playerScreenX: number,
  targetScreenX: number,
  previous: GatherSide | null,
  hysteresisPx = 6
): GatherSide {
  const dx = targetScreenX - playerScreenX;
  if (previous === "right" && dx > -hysteresisPx) return "right";
  if (previous === "left" && dx < hysteresisPx) return "left";
  return dx >= 0 ? "right" : "left";
}

/** Fishing encounter phase (shared FishingEncounterPhase) to presentation phase; null = not fishing. */
export function gatherFishPhaseForEncounter(
  phase: string,
  hasCastPoint: boolean
): GatherFishPhase | null {
  switch (phase) {
    case "cast": return hasCastPoint ? "wait" : "ready";
    case "bite": return "bite";
    case "hooked":
    case "fighting": return "fight";
    default: return null;
  }
}
