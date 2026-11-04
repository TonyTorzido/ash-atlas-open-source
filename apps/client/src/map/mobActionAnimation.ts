import { EASE, sampleTrack, type Track } from "@ash-atlas/player-renderer";
import type { BossCastSnapshot, CombatEntitySnapshot, MobBuffKind } from "@ash-atlas/shared";

import { telegraphWindow } from "./telegraphWindow.js";

/**
 * Whole-sprite motion programs for overworld mob abilities, in the same keyframe idiom as the
 * player's chop and mine (gatherAnimation.ts): `[t, value, ease]` tracks, anticipation, a snap
 * into the impact, a short hold and a recover. Mobs are single sprites, so a program only moves,
 * leans, squashes, stretches, shrinks, fades and tints the whole sprite, pivoting at the feet.
 *
 * Telegraphed abilities play their wind-up across the server warning window (t 0..1 = warning
 * shown .. strike resolves, so the impact lands on the telegraph's local end), then a `strike`
 * timeline of `strikeMs` after the impact. One-shot cues (howl, enrage) only have `strike`.
 */
export type MobActionTracks = Readonly<{
  /** Along the attack direction, fraction of sprite height (negative pulls back). */
  push?: Track;
  /** Degrees toward the attack direction (negative leans back), pivoting at the feet. */
  lean?: Track;
  /** Positive squashes (shorter, wider), negative stretches tall; same formula as the player. */
  squash?: Track;
  /** Elongates along the attack direction (the dash), fraction. */
  stretch?: Track;
  /** Rise, fraction of sprite height. */
  lift?: Track;
  /** Shake amplitude, fraction of sprite height. */
  tremble?: Track;
  /** Uniform shrink, fraction (0.6 = 40% size). */
  shrink?: Track;
  /** 0 = opaque, 1 = gone. */
  fade?: Track;
  /** Red tint amount 0..1. */
  red?: Track;
}>;

export type MobFxKind = "dust" | "ring" | "puff";

/**
 * Skeleton reassemble (server: first killing blow roots the mob and shows the "reassembling"
 * buff for 2.5 s). It collapses into a heap of bones, lies still, the bones are pulled back
 * together by a ring of its own magic for the last stretch, then it pops back up.
 */
export const MOB_REASSEMBLE_TUNING = {
  /** Fall into the heap. */
  collapseMs: 220,
  /** Gather cue before the buff ends. */
  gatherMs: 850,
  /** Overshoot after the buff ends. */
  popMs: 320,
  /** Lying-down rotation (deg) and the heap's squash. */
  fallDegrees: 80,
  heapScaleX: 0.18,
  heapScaleY: 0.38,
  /** Shift that keeps the lying sprite centred on its spot, fraction of height. */
  heapShift: 0.42,
  /** How far the heap rises by the end of the gather. */
  gatherRise: 0.55,
  heapTint: 0xb8bac0,
  popStretch: 0.15,
  popLift: 0.06
} as const;

export type MobReassemblePhase = "collapse" | "heap" | "gather" | "pop";

export type MobActionProgram = Readonly<{
  windup?: MobActionTracks;
  strikeMs: number;
  strike: MobActionTracks;
  /** Ground effect at the impact, drawn at the telegraph's origin. */
  impactFx: MobFxKind | null;
  /** Small dust scuffs during the wind-up (window fractions). */
  scuffsAt?: readonly number[];
}>;

export type MobActionProgramId = "charge" | "maul" | "slam" | "swoop" | "blink" | "howl" | "enrage";

const { inOut, in: easeIn, out } = EASE;

export const MOB_ACTION_PROGRAMS: Readonly<Record<MobActionProgramId, MobActionProgram>> = {
  // Charge: settle low and pull back from the lane, paw the ground twice, sink lower with a
  // tremble in the last ~250 ms, then a stretched dash along the lane (the server moves the mob
  // to the lane end at the resolve) with dust kicked up behind.
  charge: {
    windup: {
      push: [[0, 0], [0.15, -0.05, inOut], [0.3, -0.03, inOut], [0.38, -0.08, inOut], [0.5, -0.05, inOut], [0.58, -0.1, inOut], [0.72, -0.12, inOut], [1, -0.13, inOut]],
      lift: [[0, 0], [0.3, 0], [0.34, 0.025, out], [0.4, 0, easeIn], [0.5, 0], [0.54, 0.025, out], [0.6, 0, easeIn], [1, 0]],
      squash: [[0, 0], [0.15, 0.05, inOut], [0.3, 0.04, inOut], [0.62, 0.08, inOut], [0.9, 0.12, inOut], [1, 0.12]],
      lean: [[0, 0], [0.15, -3, inOut], [0.6, -5, inOut], [1, -8, inOut]],
      tremble: [[0, 0], [0.83, 0], [0.86, 0.012, out], [1, 0.022, easeIn]]
    },
    scuffsAt: [0.4, 0.6],
    strikeMs: 450,
    strike: {
      push: [[0, -0.13], [0.08, 0.1, easeIn], [0.35, 0.06, out], [1, 0, inOut]],
      stretch: [[0, 0], [0.08, 0.22, easeIn], [0.3, 0.12, out], [0.55, -0.04, inOut], [1, 0, inOut]],
      squash: [[0, 0.12], [0.08, 0, easeIn], [1, 0]],
      lean: [[0, -8], [0.08, 8, easeIn], [0.4, 4, out], [1, 0, inOut]]
    },
    impactFx: "dust"
  },
  // Maul: rear up tall and lean back, hold with a small shake, then slam forward on the impact
  // with a squash, like the chop's wind-up and strike.
  maul: {
    windup: {
      squash: [[0, 0], [0.3, -0.16, inOut], [0.85, -0.18, inOut], [0.92, -0.19, inOut], [1, 0.02, easeIn]],
      lean: [[0, 0], [0.3, -11, inOut], [0.85, -13, inOut], [0.92, -14], [1, 10, easeIn]],
      lift: [[0, 0], [0.3, 0.05, inOut], [0.92, 0.06, inOut], [1, -0.01, easeIn]],
      push: [[0, 0], [0.3, -0.03, inOut], [0.92, -0.04], [1, 0.08, easeIn]],
      tremble: [[0, 0], [0.8, 0], [0.84, 0.008, out], [0.92, 0.01], [0.93, 0]]
    },
    strikeMs: 420,
    strike: {
      squash: [[0, 0.02], [0.08, 0.12, out], [0.45, 0, inOut], [1, 0]],
      lean: [[0, 10], [0.15, 7, out], [1, 0, inOut]],
      lift: [[0, -0.01], [1, 0, inOut]],
      push: [[0, 0.08], [0.12, 0.08], [1, 0, inOut]]
    },
    impactFx: "dust"
  },
  // Slam: a small dip, rise and stretch up, shake at the peak, drop on the impact into a big
  // squash with a ring bursting along the ground.
  slam: {
    windup: {
      lift: [[0, 0], [0.12, -0.01, inOut], [0.45, 0.08, inOut], [0.9, 0.09, inOut], [1, -0.02, easeIn]],
      squash: [[0, 0], [0.12, 0.04, inOut], [0.45, -0.14, inOut], [0.9, -0.16, inOut], [1, 0, easeIn]],
      lean: [[0, 0], [0.45, -3, inOut], [0.9, -4], [1, 2, easeIn]],
      tremble: [[0, 0], [0.5, 0], [0.55, 0.01, out], [0.9, 0.016, inOut], [0.92, 0]]
    },
    strikeMs: 500,
    strike: {
      squash: [[0, 0], [0.06, 0.22, out], [0.3, 0.04, inOut], [0.45, 0.06, inOut], [1, 0, inOut]],
      lift: [[0, -0.02], [0.3, 0, out], [1, 0]],
      lean: [[0, 2], [1, 0, inOut]]
    },
    impactFx: "ring"
  },
  // Swoop: a crouch, lift up and lean back, hover, then dive along the cone on the impact.
  swoop: {
    windup: {
      lift: [[0, 0], [0.1, -0.01, inOut], [0.4, 0.1, out], [0.88, 0.12, inOut], [1, 0.02, easeIn]],
      squash: [[0, 0], [0.1, 0.06, inOut], [0.25, -0.06, out], [0.88, -0.04, inOut], [1, -0.02, easeIn]],
      lean: [[0, 0], [0.4, -8, inOut], [0.88, -10, inOut], [1, 12, easeIn]],
      push: [[0, 0], [0.4, -0.04, inOut], [0.88, -0.06, inOut], [1, 0.14, easeIn]]
    },
    strikeMs: 450,
    strike: {
      push: [[0, 0.14], [0.15, 0.14], [1, 0, inOut]],
      lift: [[0, 0.02], [1, 0, inOut]],
      lean: [[0, 12], [0.2, 8, out], [1, 0, inOut]],
      squash: [[0, -0.02], [0.08, 0.08, out], [0.4, 0, inOut], [1, 0]]
    },
    impactFx: "dust"
  },
  // Blink (smoke): hunch with a jitter, then shrink and fade toward the puff. The server moves the
  // mob on the resolve; it stays hidden while it glides, then pops back in at the puff.
  blink: {
    windup: {
      squash: [[0, 0], [0.2, 0.06, inOut], [0.55, 0.07], [1, -0.05, easeIn]],
      tremble: [[0, 0], [0.2, 0.006, out], [0.55, 0.008], [0.6, 0]],
      shrink: [[0, 0], [0.55, 0], [1, 0.6, easeIn]],
      fade: [[0, 0], [0.6, 0], [1, 1, easeIn]],
      push: [[0, 0], [0.55, 0], [1, 0.12, easeIn]]
    },
    strikeMs: 450,
    strike: {
      fade: [[0, 1], [0.4, 1], [1, 0, out]],
      shrink: [[0, 0.6], [0.4, 0.6], [0.75, -0.06, out], [1, 0, inOut]],
      squash: [[0, 0], [0.4, 0], [0.7, 0.06, out], [1, 0, inOut]],
      push: [[0, 0.12], [0.4, 0]]
    },
    impactFx: "puff"
  },
  // Howl: a short gather, then the head goes up (tall stretch, lean back) and holds a beat.
  howl: {
    strikeMs: 750,
    strike: {
      squash: [[0, 0], [0.15, 0.05, inOut], [0.4, -0.13, out], [0.8, -0.11], [1, 0, inOut]],
      lean: [[0, 0], [0.15, 1, inOut], [0.4, -7, out], [0.8, -6], [1, 0, inOut]],
      lift: [[0, 0], [0.4, 0.03, out], [1, 0, inOut]],
      tremble: [[0, 0], [0.4, 0.006], [0.8, 0.006], [0.85, 0]]
    },
    impactFx: null
  },
  // Enrage: one red pulse with a shake and a small swell.
  enrage: {
    strikeMs: 550,
    strike: {
      tremble: [[0, 0.02], [1, 0, out]],
      squash: [[0, 0], [0.15, -0.06, out], [1, 0, inOut]],
      red: [[0, 0], [0.15, 1, out], [1, 0, inOut]]
    },
    impactFx: null
  }
};

/** Telegraph ability id -> program. Ids are `<archetype>_<kind>` or a technique id (`hog_charge`). */
export function mobActionProgramForAbility(abilityId: string): MobActionProgramId | null {
  if (abilityId.endsWith("_charge")) return "charge";
  if (abilityId.endsWith("_maul")) return "maul";
  if (abilityId.endsWith("_slam")) return "slam";
  if (abilityId.endsWith("_swoop")) return "swoop";
  if (abilityId.endsWith("_smoke")) return "blink";
  // Mob archetypes (docs/plans/mob-ai-phase2.md): the flank lunge reuses the charge pose, the double-strike cones the maul pose.
  if (abilityId.endsWith("_lunge")) return "charge";
  if (abilityId.endsWith("_double_a") || abilityId.endsWith("_double_b")) return "maul";
  // Caster ground blast and the three volley lines use the cast pose (the howl rear-up).
  if (abilityId.endsWith("_blast") || /_volley_[lcr]$/.test(abilityId)) return "howl";
  return null;
}

export const MOB_REACTION_TUNING = {
  /** Motion kept under prefers-reduced-motion; shakes and wobbles are dropped. */
  reducedMotionAmount: 0.25,
  hitFlash: { durationMs: 120, track: [[0, 0.28], [1, 0, out]] as Track },
  /** Porcupine quills: puff up to about 1.1x when hit. */
  quills: { durationMs: 340, scale: 0.1, track: [[0, 0], [0.2, 1, out], [1, 0, inOut]] as Track },
  /** Shelled tortoise / armadillo: curled into a squashed ball with a sheen. */
  shell: { squash: 0.2, blendPerSecond: 12, sheen: 0.14, sheenPulse: 0.08 },
  /** Pounce cats and snakes crouch for the last part of the acquire countdown. */
  pounce: { crouchMs: 900, squash: 0.1, lean: -4, tremble: 0.006 },
  /** Dizzy wobble while a charger is stunned after a missed charge. */
  dizzy: { degrees: 6, periodMs: 520 },
  /** Basic attack lunge squash (the lunge itself is the shared player strike envelope). */
  lungeSquash: 0.05,
  /** Each ends before its program's strike timeline does. */
  fx: { dustMs: 380, scuffMs: 260, ringMs: 440, puffMs: 440 }
} as const;

const SHELL_ARCHETYPES: ReadonlySet<string> = new Set(["spur_thighed_tortoise", "armadillo"]);
const QUILL_ARCHETYPES: ReadonlySet<string> = new Set(["crested_porcupine"]);
const POUNCE_ARCHETYPES: ReadonlySet<string> = new Set(["jaguar", "lioness", "sidewinder"]);
const BUFF_ONSET_PROGRAMS: Partial<Record<MobBuffKind, MobActionProgramId>> = { howl: "howl", enraged: "enrage" };

/** Per-mob animation state; created once per mob, updated in place (no per-frame allocation). */
export type MobActionState = {
  castInstanceId: string | null;
  programId: MobActionProgramId | null;
  /** Wall-clock (Date.now) window of the telegraph; one-shots use start === end. */
  startMs: number;
  endMs: number;
  /** Unit screen direction of the attack. */
  dirX: number;
  dirY: number;
  /** Telegraph origin (fx anchor). */
  anchorLat: number;
  anchorLon: number;
  buffsSeen: number;
  shellWeight: number;
  /** Wall-clock reassemble window (NaN = none); the pop plays after the end. */
  reassembleStartMs: number;
  reassembleEndMs: number;
};

export function createMobActionState(): MobActionState {
  return {
    castInstanceId: null, programId: null, startMs: 0, endMs: 0, dirX: 1, dirY: 0,
    anchorLat: 0, anchorLon: 0, buffsSeen: 0, shellWeight: 0,
    reassembleStartMs: Number.NaN, reassembleEndMs: Number.NaN
  };
}

/** Writes the unit screen direction of the cast into `out.dirX/dirY`; the caller projects. */
export type MobDirectionResolver = (
  cast: BossCastSnapshot,
  mob: Readonly<{ lat: number; lon: number }>,
  out: MobActionState
) => void;

/**
 * Starts a program when the mob shows a new telegraph or a howl/enrage buff begins. Cheap when
 * nothing changed: one pass over a (usually empty) telegraph list and the buff list.
 */
export function observeMobActions(
  state: MobActionState,
  entity: Pick<CombatEntitySnapshot, "entityId" | "lat" | "lon" | "telegraphs" | "mobBuffs">,
  wallNowMs: number,
  resolveDirection: MobDirectionResolver
): void {
  const telegraphs = entity.telegraphs;
  if (telegraphs) {
    for (let index = 0; index < telegraphs.length; index += 1) {
      const cast = telegraphs[index]!;
      if (cast.castInstanceId === state.castInstanceId) continue;
      const programId = mobActionProgramForAbility(cast.abilityId);
      if (!programId || cast.encounterId !== `mob:${entity.entityId}`) continue;
      const window = telegraphWindow(cast, wallNowMs);
      if (window.localEnd <= wallNowMs) continue;
      state.castInstanceId = cast.castInstanceId;
      state.programId = programId;
      state.startMs = window.localStart;
      state.endMs = window.localEnd;
      const origin = cast.geometry.kind === "circle" ? cast.geometry.center : cast.geometry.origin;
      state.anchorLat = origin.lat;
      state.anchorLon = origin.lon;
      resolveDirection(cast, entity, state);
    }
  }
  let seen = 0;
  const buffs = entity.mobBuffs;
  if (buffs) {
    for (let index = 0; index < buffs.length; index += 1) {
      const kind = buffs[index]!.kind;
      if (kind === "reassembling") {
        observeReassemble(state, entity, buffs[index]!.endsAt, wallNowMs);
        continue;
      }
      const programId = BUFF_ONSET_PROGRAMS[kind];
      if (!programId) continue;
      const bit = kind === "howl" ? 1 : 2;
      seen |= bit;
      // Onset only, and never over a telegraphed program.
      if ((state.buffsSeen & bit) === 0 && !telegraphedProgramRunning(state, wallNowMs)) {
        state.castInstanceId = null;
        state.programId = programId;
        state.startMs = wallNowMs;
        state.endMs = wallNowMs;
      }
    }
  }
  state.buffsSeen = seen;
}

function observeReassemble(
  state: MobActionState,
  entity: Pick<CombatEntitySnapshot, "lat" | "lon">,
  endsAt: number,
  wallNowMs: number
): void {
  if (endsAt <= wallNowMs) return;
  const tuning = MOB_REASSEMBLE_TUNING;
  if (!reassembleRunning(state, wallNowMs)) {
    // New onset: the collapse always plays from here; any running ability is cut.
    state.reassembleStartMs = wallNowMs;
    state.programId = null;
    state.castInstanceId = null;
    state.anchorLat = entity.lat;
    state.anchorLon = entity.lon;
  }
  // Leave room for the collapse and the gather even if the buff arrives late.
  state.reassembleEndMs = Math.max(endsAt, state.reassembleStartMs + tuning.collapseMs + tuning.gatherMs);
}

function reassembleRunning(state: MobActionState, wallNowMs: number): boolean {
  return !Number.isNaN(state.reassembleEndMs) && wallNowMs < state.reassembleEndMs + MOB_REASSEMBLE_TUNING.popMs;
}

/**
 * Current reassemble phase and its 0..1 progress (written to `out.t`), or null when none runs.
 */
export function mobReassemblePhase(
  state: Readonly<Pick<MobActionState, "reassembleStartMs" | "reassembleEndMs">>,
  wallNowMs: number,
  out: { t: number }
): MobReassemblePhase | null {
  const start = state.reassembleStartMs, end = state.reassembleEndMs;
  const tuning = MOB_REASSEMBLE_TUNING;
  if (Number.isNaN(end) || wallNowMs < start || wallNowMs >= end + tuning.popMs) return null;
  if (wallNowMs >= end) { out.t = (wallNowMs - end) / tuning.popMs; return "pop"; }
  if (wallNowMs < start + tuning.collapseMs) { out.t = (wallNowMs - start) / tuning.collapseMs; return "collapse"; }
  const gatherStart = end - tuning.gatherMs;
  if (wallNowMs >= gatherStart) { out.t = (wallNowMs - gatherStart) / tuning.gatherMs; return "gather"; }
  out.t = (wallNowMs - start - tuning.collapseMs) / Math.max(1, gatherStart - start - tuning.collapseMs);
  return "heap";
}

const reassembleScratch = { t: 0 };

/** Whole-sprite reassemble pose; false when no reassemble runs. */
function sampleReassemble(state: MobActionState, input: MobMotionInput, out: MobMotionPose): boolean {
  const phase = mobReassemblePhase(state, input.wallNowMs, reassembleScratch);
  if (phase === null) return false;
  const tuning = MOB_REASSEMBLE_TUNING;
  const t = reassembleScratch.t;
  const h = input.heightPx;
  // Heap weight: 1 = lying in the heap.
  let heap = 1, stretch = 0, lift = 0, tremble = 0;
  if (phase === "collapse") heap = 1 - (1 - t) * (1 - t);
  else if (phase === "gather") {
    const eased = t * t * (3 - 2 * t);
    heap = 1 - tuning.gatherRise * eased;
    tremble = 0.008 * t;
  } else if (phase === "pop") {
    heap = 0;
    const bump = Math.sin(Math.min(1, t) * Math.PI);
    stretch = tuning.popStretch * bump;
    lift = tuning.popLift * bump;
  }
  // Fall away from the attack side; reduced motion keeps a squash and the grey, no fall.
  const side = state.dirX >= 0 ? -1 : 1;
  const fall = input.reducedMotion ? 0 : heap;
  out.rotation = side * tuning.fallDegrees * fall * Math.PI / 180;
  out.x = -side * tuning.heapShift * h * fall;
  out.y = -lift * h * (input.reducedMotion ? 0.25 : 1);
  if (tremble > 0 && !input.reducedMotion) {
    out.x += Math.sin(input.wallNowMs * 0.113) * tremble * h;
    out.y += Math.sin(input.wallNowMs * 0.157 + 1.3) * tremble * h * 0.5;
  }
  const squashX = input.reducedMotion ? 0.12 : tuning.heapScaleX;
  const squashY = input.reducedMotion ? 0.45 : tuning.heapScaleY;
  out.scaleX = (1 - squashX * heap) * (1 - stretch * 0.5);
  out.scaleY = (1 - squashY * heap) * (1 + stretch);
  out.alpha = 1;
  out.flash = 0;
  // Grey in the heap; the gather warms it back toward full colour.
  const grey = phase === "pop" ? 0 : phase === "gather" ? 1 - t : phase === "collapse" ? t : 1;
  out.tint = grey > 0 ? mixRgb(0xffffff, MOB_REASSEMBLE_TUNING.heapTint, grey) : 0xffffff;
  return true;
}

function mixRgb(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return (r << 16) | (g << 8) | bl;
}

function telegraphedProgramRunning(state: MobActionState, wallNowMs: number): boolean {
  if (state.programId === null || state.castInstanceId === null) return false;
  return wallNowMs < state.endMs + MOB_ACTION_PROGRAMS[state.programId].strikeMs;
}

/** Output of one frame; reused by the caller. */
export type MobMotionPose = {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
  /** Additive white overlay alpha (shell sheen). */
  flash: number;
  tint: number;
};

export function createMobMotionPose(): MobMotionPose {
  return { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, alpha: 1, flash: 0, tint: 0xffffff };
}

/** Per-frame input; callers keep one and overwrite it (no per-frame allocation). */
export type MobMotionInput = {
  archetypeKey: string | null;
  /** Visual sprite height in screen px (push, lift and shakes scale with it). */
  heightPx: number;
  wallNowMs: number;
  deltaSeconds: number;
  reducedMotion: boolean;
  /** ms since the last hit landed on this mob (NaN = none). */
  hitElapsedMs: number;
  shelled: boolean;
  /** The server has this mob staggered (a missed strike): it wobbles dizzily. */
  staggered: boolean;
  /** ms left on the acquire countdown (NaN = not acquiring). */
  acquireRemainingMs: number;
  /** Screen direction toward the current target (for one-shots and pounce lean); 0,0 = none. */
  targetDirX: number;
  /** Basic attack lunge progress 0..1 (shared player strike envelope). */
  lungeProgress: number;
};

/** Samples every cue for one mob into `out`. Returns false when the mob is at rest (identity pose). */
export function sampleMobMotion(state: MobActionState, input: MobMotionInput, out: MobMotionPose): boolean {
  if (sampleReassemble(state, input, out)) return true;
  const amount = input.reducedMotion ? MOB_REACTION_TUNING.reducedMotionAmount : 1;
  const h = input.heightPx;
  let push = 0, lean = 0, squash = 0, stretch = 0, lift = 0, tremble = 0, shrink = 0, fade = 0, red = 0, flash = 0, pop = 0;
  let dirX = state.dirX, dirY = state.dirY;
  if (state.programId !== null) {
    const program = MOB_ACTION_PROGRAMS[state.programId];
    const now = input.wallNowMs;
    let tracks: MobActionTracks | null = null;
    let t = 0;
    if (program.windup && now < state.endMs) {
      tracks = program.windup;
      const span = state.endMs - state.startMs;
      t = span > 0 ? Math.max(0, (now - state.startMs) / span) : 1;
    } else if (now < state.endMs + program.strikeMs) {
      tracks = program.strike;
      t = Math.max(0, (now - state.endMs) / program.strikeMs);
    } else {
      state.programId = null;
    }
    if (tracks) {
      if (state.castInstanceId === null && input.targetDirX !== 0) {
        dirX = input.targetDirX > 0 ? 1 : -1;
        dirY = 0;
      }
      push = tracks.push ? sampleTrack(tracks.push, t) : 0;
      lean = tracks.lean ? sampleTrack(tracks.lean, t) : 0;
      squash = tracks.squash ? sampleTrack(tracks.squash, t) : 0;
      stretch = tracks.stretch ? sampleTrack(tracks.stretch, t) : 0;
      lift = tracks.lift ? sampleTrack(tracks.lift, t) : 0;
      tremble = tracks.tremble ? sampleTrack(tracks.tremble, t) : 0;
      shrink = tracks.shrink ? sampleTrack(tracks.shrink, t) : 0;
      fade = tracks.fade ? sampleTrack(tracks.fade, t) : 0;
      red = tracks.red ? sampleTrack(tracks.red, t) : 0;
    }
  }
  if (state.programId === null && input.lungeProgress > 0) {
    squash += MOB_REACTION_TUNING.lungeSquash * input.lungeProgress;
  }
  // Shell: blend in and out so the curl never pops.
  const shell = MOB_REACTION_TUNING.shell;
  const shellTarget = input.shelled && input.archetypeKey !== null && SHELL_ARCHETYPES.has(input.archetypeKey) ? 1 : 0;
  state.shellWeight += (shellTarget - state.shellWeight) * Math.min(1, input.deltaSeconds * shell.blendPerSecond);
  if (Math.abs(state.shellWeight - shellTarget) < 0.01) state.shellWeight = shellTarget;
  if (state.shellWeight > 0) {
    squash += shell.squash * state.shellWeight;
    flash += state.shellWeight * (shell.sheen + (input.reducedMotion ? 0 : shell.sheenPulse * Math.sin(input.wallNowMs / 180)));
  }
  // Pounce: crouch for the last part of the acquire countdown.
  const pounce = MOB_REACTION_TUNING.pounce;
  if (
    state.programId === null && input.archetypeKey !== null && POUNCE_ARCHETYPES.has(input.archetypeKey) &&
    input.acquireRemainingMs >= 0 && input.acquireRemainingMs < pounce.crouchMs
  ) {
    const crouch = 1 - input.acquireRemainingMs / pounce.crouchMs;
    const eased = crouch * crouch * (3 - 2 * crouch);
    squash += pounce.squash * eased;
    lean += pounce.lean * eased;
    tremble += pounce.tremble * eased;
    if (input.targetDirX !== 0) {
      dirX = input.targetDirX > 0 ? 1 : -1;
      dirY = 0;
    }
  }
  // Hit: a short, subtle warm-red tint (multiply, no extra sprite); porcupines puff their quills.
  if (input.hitElapsedMs >= 0) {
    const hit = MOB_REACTION_TUNING.hitFlash;
    if (input.hitElapsedMs < hit.durationMs) red = Math.max(red, sampleTrack(hit.track, input.hitElapsedMs / hit.durationMs));
    const quills = MOB_REACTION_TUNING.quills;
    if (input.hitElapsedMs < quills.durationMs && input.archetypeKey !== null && QUILL_ARCHETYPES.has(input.archetypeKey)) {
      pop = quills.scale * sampleTrack(quills.track, input.hitElapsedMs / quills.durationMs);
    }
  }
  let rotation = 0;
  const dizzy = MOB_REACTION_TUNING.dizzy;
  if (
    !input.reducedMotion && input.staggered && state.programId === null
  ) {
    rotation += Math.sin(input.wallNowMs * 2 * Math.PI / dizzy.periodMs) * dizzy.degrees * Math.PI / 180;
  }
  if (input.reducedMotion) tremble = 0;

  const side = dirX >= 0 ? 1 : -1;
  const motion = amount * h;
  out.x = dirX * push * motion;
  out.y = dirY * push * motion - lift * motion;
  if (tremble > 0) {
    out.x += Math.sin(input.wallNowMs * 0.113) * tremble * h;
    out.y += Math.sin(input.wallNowMs * 0.157 + 1.3) * tremble * h * 0.5;
  }
  out.rotation = rotation + side * lean * amount * Math.PI / 180;
  const s = squash * amount;
  const e = stretch * amount;
  const along = dirX * dirX;
  const across = dirY * dirY;
  const size = (1 - shrink) * (1 + pop * amount);
  out.scaleX = (1 + s * 0.5) * (1 + e * along - e * 0.5 * across) * size;
  out.scaleY = (1 - s) * (1 + e * across - e * 0.5 * along) * size;
  out.alpha = 1 - Math.min(1, Math.max(0, fade));
  out.flash = Math.max(0, Math.min(1, flash));
  const fade255 = Math.round(255 - 165 * Math.min(1, red));
  out.tint = red > 0 ? 0xff0000 | (fade255 << 8) | fade255 : 0xffffff;
  return out.x !== 0 || out.y !== 0 || out.rotation !== 0 || out.scaleX !== 1 || out.scaleY !== 1 ||
    out.alpha !== 1 || out.flash !== 0 || out.tint !== 0xffffff;
}

const NO_SCUFFS: readonly number[] = [];

/**
 * Ground effects of the running program, as ages in ms; calls `draw` for each live one. Every
 * effect ends before its program's strike does, and all are derived from time, so nothing is
 * queued or allocated.
 */
export function forEachMobActionFx(
  state: MobActionState,
  wallNowMs: number,
  draw: (kind: MobFxKind | "scuff" | "reassemble", ageMs: number, lifeMs: number) => void
): void {
  if (reassembleRunning(state, wallNowMs)) {
    draw("reassemble", wallNowMs - state.reassembleStartMs, state.reassembleEndMs + MOB_REASSEMBLE_TUNING.popMs - state.reassembleStartMs);
    return;
  }
  if (state.castInstanceId === null || state.programId === null) return;
  const program = MOB_ACTION_PROGRAMS[state.programId];
  const fx = MOB_REACTION_TUNING.fx;
  const span = state.endMs - state.startMs;
  const scuffs = program.scuffsAt ?? NO_SCUFFS;
  for (let index = 0; index < scuffs.length; index += 1) {
    const age = wallNowMs - (state.startMs + scuffs[index]! * span);
    if (age >= 0 && age < fx.scuffMs) draw("scuff", age, fx.scuffMs);
  }
  if (program.impactFx) {
    const life = program.impactFx === "ring" ? fx.ringMs : program.impactFx === "puff" ? fx.puffMs : fx.dustMs;
    const age = wallNowMs - state.endMs;
    if (age >= 0 && age < life) draw(program.impactFx, age, life);
    if (program.impactFx === "ring" && age >= 0 && age < fx.dustMs) draw("dust", age, fx.dustMs);
  }
}
