import { destinationPoint } from "./geo.js";
import type { MobChallengeTier } from "./equipmentBalanceContracts.js";
import type { LatLon } from "./types.js";
import { MOB_MELEE_WINDUP_MAX_RANGE_M } from "./actionCombat.js";
import { RUNTIME_PNG_PRESENTATION_CATALOG } from "./runtimePngPresentation.js";

/**
 * Mob tactics (action combat only): attack tokens, surround slots, separation and per-mob
 * rhythm. The one place every constant lives, like actionCombat.ts and dash.ts. Spec:
 * docs/plans/mob-ai-phase1.md. Nothing here touches the engine; flag off changes nothing.
 *
 * Distances are metres. Angles are compass bearings in degrees (0 = north, 90 = east), the same
 * convention as destinationPoint. Tick counts assume the 20 Hz server tick (50 ms).
 */

/** Melee token points per target player. */
export const MOB_TACTICS_MELEE_TOKENS = 2;
/** Ranged token points per target player (separate pool). */
export const MOB_TACTICS_RANGED_TOKENS = 1;
/** Token points a mob of each challenge tier costs. Bosses are not managed in Phase 1. */
export const MOB_TACTICS_TIER_COST: Readonly<Record<MobChallengeTier, number>> = {
  common: 1,
  uncommon: 1,
  rare: 1,
  epic: 2,
  legendary: 2
};

/** Minimum gap between two strikes landing on the same player. Above DASH_IFRAME_MS (200). */
export const MOB_TACTICS_LANDING_MIN_GAP_MS = 300;
/** A mob that just joined cannot start a windup for this long. */
export const MOB_TACTICS_ARRIVAL_GRACE_MS = 400;
/** Mobs farther than this from the player do not start windups (roughly the screen). */
export const MOB_TACTICS_ATTACK_VIEW_RADIUS_M = 450;

/** Engage ring radius as a share of the mob's attack range (85 m for range 100). */
export const MOB_TACTICS_ENGAGE_RING_FACTOR = 0.85;
/** Wait ring radius as a share of attack range (150 m): one step from the 130 m swing reach. */
export const MOB_TACTICS_WAIT_RING_FACTOR = 1.5;
/** Mobs on the engage ring at once; the rest wait on the wait ring. */
export const MOB_TACTICS_ENGAGE_SEATS = 6;
/** Ranged ring radius as a share of attack range, and its cap. */
export const MOB_TACTICS_RANGED_RING_FACTOR = 0.75;
export const MOB_TACTICS_RANGED_RING_MAX_M = 260;
/** Centre-to-centre spacing between neighbours on a ring (mob diameter 40 + 15 gap). */
export const MOB_TACTICS_SLOT_MIN_SPACING_M = 55;
/** A full ring spills outward by this much per layer. */
export const MOB_TACTICS_LAYER_STEP_M = 60;
/** Slots are re-evaluated every this many ticks (250 ms). */
export const MOB_TACTICS_SLOT_REASSIGN_TICKS = 5;
/** A mob keeps its slot unless the new one is more than this many degrees away. */
export const MOB_TACTICS_SLOT_HYSTERESIS_DEG = 25;
/** Within this distance of its slot a mob counts as arrived. */
export const MOB_TACTICS_SLOT_ARRIVE_M = 10;
/** Waiting mobs circle at this share of their speed. */
export const MOB_TACTICS_STRAFE_SPEED_FACTOR = 0.2;
export const MOB_TACTICS_STRAFE_FLIP_MIN_MS = 1_500;
export const MOB_TACTICS_STRAFE_FLIP_MAX_MS = 3_500;

/** Separation: mobs closer than this push apart (two radii of 20 plus 10). */
export const MOB_TACTICS_SEPARATION_RADIUS_M = 50;
/** Push at full overlap, as a share of one movement step. */
export const MOB_TACTICS_SEPARATION_STRENGTH = 0.6;
/** Total push never exceeds this share of a step, so mobs still make progress. */
export const MOB_TACTICS_SEPARATION_MAX_SHARE = 0.5;

/** Fairness: bonus for mobs in front of the player's heading, and its half angle. */
export const MOB_TACTICS_FRONT_BONUS_MS = 600;
export const MOB_TACTICS_FRONT_HALF_ANGLE_DEG = 60;
/** A mob that has waited this long is served first. */
export const MOB_TACTICS_STARVATION_MS = 4_000;
/** Cap on the waiting-time part of the score. */
export const MOB_TACTICS_WAIT_SCORE_CAP_MS = 4_000;
/**
 * Fail-safe: a token held longer than this is taken back (times MOB_TELEGRAPH_SCALE, so it always covers the scaled
 * windups). Telegraph time: 3000 ms at scale 1 (was 2500 with 750 ms windups), so the longest signature hold (the
 * 1200 + 1000 ms double strike plus its 400 ms recover) still fits with room to spare.
 */
export const MOB_TACTICS_TOKEN_MAX_HOLD_MS = 3_000;
/** A mob hit by the player grabs a token if within this many attack ranges (the wait ring). */
export const MOB_TACTICS_GRAB_MAX_RANGE_FACTOR = MOB_TACTICS_WAIT_RING_FACTOR;
/** A mob not yet planted that is farther than attackRange + this after a player dash gives its token back. */
export const MOB_TACTICS_DASH_OUT_SLACK_M = 50;

/**
 * Reaction time every telegraph is tuned for (docs/plans/telegraph-time.md): see it, decide, then walk or dash.
 * Readable combat at a slower pace; combat feel used 250 ms.
 */
export const MOB_TELEGRAPH_REACTION_MS = 400;

/**
 * Rhythm defaults. Managed melee mobs wind up for MOB_TACTICS_MELEE_WINDUP_MS (telegraph time: WALK out of the
 * 130 m + 20 m body / 90 degree cone from its worst spot, 497 ms, plus 400 ms reaction = 897 ms, raised to 1.1 s for
 * the owner's "more time to react"). The cooldown sits at its floor, so the cycle grows (750 / 250 / 400 = 1400 became
 * 1100 / 250 / 300 = 1650 ms). Action combat without tactics keeps MOB_MELEE_WINDUP_MS.
 */
export const MOB_TACTICS_MELEE_WINDUP_MS = 1_100;
/**
 * Punish window after a strike: a readable 250 ms next to the walkable windup. The token is held windup + recover
 * (1350 ms, was 1000), so a full pack lands about 26 % less per second than combat feel; Phase 3 retunes damage.
 */
export const MOB_TACTICS_RECOVER_MS = 250;
export const MOB_TACTICS_RANGED_RECOVER_MS = 350;
export const MOB_TACTICS_BACKOFF_M = 20;
export const MOB_TACTICS_COOLDOWN_MIN_MS = 300;
export const MOB_TACTICS_COOLDOWN_JITTER_PCT = 10;
/** After a target swap the mob starts over and cannot strike the new target for this long. */
export const MOB_TACTICS_TARGET_SWAP_PENALTY_MS = 300;
/** Single lever for pack pressure, applied through the attack context damage multiplier. */
export const MOB_TACTICS_DAMAGE_FACTOR = 1;

/**
 * Ranged aim windup: a locked line telegraph, then a lane check on release. Telegraph time: 900 ms (was 450). Half the
 * 40 m lane is 160 ms of walking plus 400 ms reaction; the rest is room for a shot aimed from the screen edge.
 */
export const MOB_RANGED_AIM_MS = 900;
export const MOB_RANGED_AIM_WIDTH_M = 40;
/** Telegraph ability id and DODGE innate id of the ranged aim. */
export const MOB_RANGED_AIM_ID = "ranged_aim";

/** Tactics roster per target player; extra mobs spill to outer layers. */
export const MOB_TACTICS_MAX_ROSTER = 16;
/**
 * Seat rotation: an engage-ring occupant keeps its seat over a wait-ring mob unless that mob has
 * waited this much longer, so seats rotate by waiting time without flapping every pass.
 */
export const MOB_TACTICS_SEAT_HOLD_BONUS_MS = 2_500;
/**
 * Fallback body width for art with no catalog hit box: the on-screen footprint of a mob sprite in world metres at the
 * default play zoom (ground zoom 15, about 2.39 m per CSS px). Measured at master scale 1: a wolf drew about 41 px =
 * 98 m wide; scaled by the catalog's world PNG master scale so it shrinks with every sprite. Normal mobs derive their
 * width from the art (mobTacticsSpriteBodyWidthM). Per-archetype overrides for unusually small or large art.
 */
export const MOB_TACTICS_BODY_WIDTH_M = 98 * RUNTIME_PNG_PRESENTATION_CATALOG.masterScale;
/**
 * On-screen footprint of the player sprite at the default play zoom: about 22 px = 53 m wide at master scale 1. The
 * player follows the world PNG master scale too, so this scales with it.
 */
export const MOB_TACTICS_PLAYER_BODY_WIDTH_M = 53 * RUNTIME_PNG_PRESENTATION_CATALOG.masterScale;
/** Extra clearance between the player sprite and an engaged mob (the mob's lunge and the swing arc). */
export const MOB_TACTICS_ENGAGE_CLEARANCE_M = 15;
/**
 * Melee strike reach of a managed melee mob. MOB_TACTICS_MELEE_REACH_M + MOB_TACTICS_MELEE_REACH_SLACK_M = 150 m is the
 * effective centre-to-centre connect distance (owner decision: the same 150 m the player's swing connects at on a
 * typical mob). Seats and engage rings are tuned on that sum. The strike cone is drawn and tested PLAYER_HURT_RADIUS_M
 * short of it against the player's hurt circle (hitGeometry.ts), so it still connects at 150 m. Only under action
 * combat + tactics.
 */
export const MOB_TACTICS_MELEE_REACH_M = 130;
/** Second part of the 150 m effective reach (the old flat 20 m body radius); see MOB_TACTICS_MELEE_REACH_M. */
export const MOB_TACTICS_MELEE_REACH_SLACK_M = 20;
export const MOB_TACTICS_BODY_WIDTH_OVERRIDES: Readonly<Record<string, number>> = {};
/** Visible gap kept between two neighbouring bodies (edge to edge). */
export const MOB_TACTICS_BODY_GAP_M = 20;
/**
 * While a mob is engaged under tactics its slot steps may go this far past its home leash, so a pack can
 * surround the player instead of forming a crescent on its home side. The disengage rule is unchanged: the
 * player beyond leash + range from home sends the mob home.
 */
export const MOB_TACTICS_SLOT_LEASH_MARGIN_M = 400;

/** Metres per CSS pixel at the default play zoom (ground zoom 15, 512 px tiles): 40,075,016.686 / (512 * 2^15). */
export const MOB_TACTICS_METRES_PER_PX_AT_PLAY_ZOOM = 40_075_016.686 / (512 * 2 ** 15);
/** Visible gap kept between packed bodies (waiters on a crowded band): close, but never drawn on top of each other. */
export const MOB_TACTICS_PACKED_GAP_M = 5;

const spriteBodyWidthCache = new Map<string, number>();

/**
 * Body width of a mob sprite at the default play zoom, straight from the runtime art presentation catalog, so a new
 * mob gets its spacing automatically: the drawn frame height at the base zoom (ground zoom 15) times the master
 * scale, times the hit-box width share (rectangle) or the hit circle's diameter, times the horizontal scale, in
 * metres. Art without a catalog entry or hit box falls back to MOB_TACTICS_BODY_WIDTH_M. A wolf comes out at about
 * 76 m at master scale 0.8 (95 m at 1.0, which matched the 98 m measured on screen).
 */
export function mobTacticsSpriteBodyWidthM(spriteKey: string): number {
  const cached = spriteBodyWidthCache.get(spriteKey);
  if (cached !== undefined) return cached;
  const sprites = RUNTIME_PNG_PRESENTATION_CATALOG.sprites as Readonly<Record<string, {
    baseHeightPx: number;
    horizontalScale?: number;
    hitGeometry?: { shape: string; width?: number; radiusPx?: number };
  } | undefined>>;
  const sprite = sprites[spriteKey];
  let widthPx: number | null = null;
  if (sprite?.hitGeometry?.shape === "rectangle" && typeof sprite.hitGeometry.width === "number") {
    widthPx = sprite.hitGeometry.width * sprite.baseHeightPx;
  } else if (sprite?.hitGeometry?.shape === "circle" && typeof sprite.hitGeometry.radiusPx === "number") {
    widthPx = sprite.hitGeometry.radiusPx * 2;
  }
  const width = widthPx !== null && widthPx > 0
    ? widthPx * RUNTIME_PNG_PRESENTATION_CATALOG.masterScale * Math.abs(sprite?.horizontalScale ?? 1) *
      MOB_TACTICS_METRES_PER_PX_AT_PLAY_ZOOM
    : MOB_TACTICS_BODY_WIDTH_M;
  spriteBodyWidthCache.set(spriteKey, width);
  return width;
}

/** Body width for an archetype: an explicit override, else the sprite footprint (sprite key defaults to the archetype). */
export function mobTacticsBodyWidthM(archetypeKey: string | null | undefined, spriteKey?: string | null): number {
  const override = archetypeKey ? MOB_TACTICS_BODY_WIDTH_OVERRIDES[archetypeKey] : undefined;
  if (override !== undefined) return override;
  const key = spriteKey ?? archetypeKey;
  return key ? mobTacticsSpriteBodyWidthM(key) : MOB_TACTICS_BODY_WIDTH_M;
}

/** Engage seats while others wait: 4 evenly spaced engaged mobs leave a gap for one waiter each at the wait band. */
export const MOB_TACTICS_ENGAGE_SEATS_MAX = 4;
/** Wait bands: the first sits one short step outside the 130 m swing reach (decision 5); crowded bands stagger out. */
export const MOB_TACTICS_WAIT_BAND_BASE_M = 160;
export const MOB_TACTICS_WAIT_BAND_STEP_M = 40;
/** Extra reach over the engage ring radius (the 5 m hold slack plus the 10 m slot arrive tolerance). */
export const MOB_TACTICS_REACH_OVER_RING_M = 15;

/**
 * Strike reach for a managed melee mob: always MOB_TACTICS_MELEE_REACH_M (the player's swing reach). The arguments are
 * kept for callers; the engage ring is clamped instead (mobTacticsEngageRadiusM) so every seat is inside the reach.
 */
export function mobTacticsMeleeReachM(_attackRangeM: number, _engageRadiusM: number): number {
  return MOB_TACTICS_MELEE_REACH_M;
}

/**
 * Farthest a melee engage ring may sit: a mob on its seat (within the slot arrive tolerance) still strikes the
 * player's centre, reach + body slack - arrive tolerance (140 m).
 */
export const MOB_TACTICS_MAX_ENGAGE_RADIUS_M = MOB_TACTICS_MELEE_REACH_M + MOB_TACTICS_MELEE_REACH_SLACK_M - MOB_TACTICS_SLOT_ARRIVE_M;

/** Wait band radius (band 0 first), never inside the engage ring plus a packed body. */
export function mobTacticsWaitBandRadiusM(band: number, engageRadiusM: number, bodyWidthM: number): number {
  return Math.max(MOB_TACTICS_WAIT_BAND_BASE_M, engageRadiusM + bodyWidthM / 2 + MOB_TACTICS_PACKED_GAP_M) +
    Math.max(0, band) * MOB_TACTICS_WAIT_BAND_STEP_M;
}

/** Packed centre-to-centre distance (no visual overlap, tighter than the full spacing). */
export function mobTacticsPackedSpacingM(widthAM: number, widthBM: number = widthAM): number {
  return widthAM / 2 + widthBM / 2 + MOB_TACTICS_PACKED_GAP_M;
}

/**
 * Engage ring radius for a melee mob: the player's half-width, the mob's half-width, the gap and a clearance, so an
 * engaged mob never draws on the player (about 110 m for a wolf), and never less than the old 0.85 x range.
 */
export function mobTacticsEngageRadiusM(attackRangeM: number, bodyWidthM: number): number {
  // Big bodies are clamped to MOB_TACTICS_MAX_ENGAGE_RADIUS_M so they can always hit from their seat (they may overlap
  // the player sprite a little, accepted); mob-to-mob spacing is unchanged.
  return Math.min(MOB_TACTICS_MAX_ENGAGE_RADIUS_M, Math.max(
    attackRangeM * MOB_TACTICS_ENGAGE_RING_FACTOR,
    MOB_TACTICS_PLAYER_BODY_WIDTH_M / 2 + bodyWidthM / 2 + MOB_TACTICS_BODY_GAP_M + MOB_TACTICS_ENGAGE_CLEARANCE_M
  ));
}

/** Wait ring radius: one full spacing outside the engage ring, so waiters never draw on engaged mobs either. */
export function mobTacticsWaitRadiusM(engageRadiusM: number, spacingM: number): number {
  return engageRadiusM + spacingM;
}

/** Centre-to-centre spacing for two bodies of these widths (each half-width plus the gap). */
export function mobTacticsSpacingM(widthAM: number, widthBM: number = widthAM): number {
  return widthAM / 2 + widthBM / 2 + MOB_TACTICS_BODY_GAP_M;
}

/** Default ceiling on managed mobs advanced per tick (mirrors maxChasesPerTick). */
export const MOB_TACTICS_MAX_PER_TICK = 2_048;

export type TacticsPhase = "approach" | "wait" | "windup" | "strike" | "recover" | "cooldown";
export type TacticsPool = "melee" | "ranged";
export type TacticsRing = "engage" | "wait" | "outer";

/** Per-mob timing, derived once from the mob's data. */
export type MobRhythm = Readonly<{
  /** Telegraph length: melee windup or ranged aim. */
  windupMs: number;
  /** Punish window after the strike. No attacks. */
  recoverMs: number;
  /** Token-free rest before the mob may ask again (before jitter). */
  cooldownMs: number;
  /** Back-off distance during recover. */
  backoffM: number;
}>;

/** Optional per-archetype overrides. Empty at launch: every mob shares one 1.4 s cycle. */
export const MOB_RHYTHM_OVERRIDES: Readonly<Record<string, Partial<MobRhythm>>> = {};

/** Milliseconds to whole ticks, at least 1 for a positive duration. */
export function tacticsMsToTicks(ms: number, tickRateHz: number): number {
  if (!(ms > 0)) return 0;
  return Math.max(1, Math.ceil((ms * tickRateHz) / 1_000 - 1e-9));
}

/** Melee mobs wind up a cone; anything with a longer reach is ranged. */
export function isTacticsRanged(attackRangeM: number): boolean {
  return attackRangeM > MOB_MELEE_WINDUP_MAX_RANGE_M;
}

export function tacticsPool(attackRangeM: number): TacticsPool {
  return isTacticsRanged(attackRangeM) ? "ranged" : "melee";
}

export function tacticsTokenCost(tier: MobChallengeTier): number {
  return MOB_TACTICS_TIER_COST[tier];
}

/**
 * Windup + recover + cooldown add up to the mob's attack interval (1400 ms for nearly every mob), but the cooldown
 * never drops under MOB_TACTICS_COOLDOWN_MIN_MS: with the telegraph-time windups (1100 + 250) the floor wins and the
 * melee cycle is 1650 ms (ranged 900 + 350 + 300 = 1550). Overrides win.
 */
export function deriveMobRhythm(
  attackIntervalMs: number,
  attackRangeM: number,
  override: Partial<MobRhythm> = {}
): MobRhythm {
  const ranged = isTacticsRanged(attackRangeM);
  const windupMs = override.windupMs ?? (ranged ? MOB_RANGED_AIM_MS : MOB_TACTICS_MELEE_WINDUP_MS);
  const recoverMs = override.recoverMs ?? (ranged ? MOB_TACTICS_RANGED_RECOVER_MS : MOB_TACTICS_RECOVER_MS);
  const cooldownMs = override.cooldownMs ??
    Math.max(MOB_TACTICS_COOLDOWN_MIN_MS, attackIntervalMs - windupMs - recoverMs);
  return { windupMs, recoverMs, cooldownMs, backoffM: override.backoffM ?? MOB_TACTICS_BACKOFF_M };
}

// ---- Telegraph scale (MOB_TELEGRAPH_SCALE server env; docs/plans/telegraph-time.md) ----

/** Live knob range: 1.0 = the tuned defaults above, 3.0 = three times as long. */
export const MOB_TELEGRAPH_SCALE_MIN = 1;
export const MOB_TELEGRAPH_SCALE_MAX = 3;
export const MOB_TELEGRAPH_SCALE_DEFAULT = 1;

/** Clamps a raw scale into [MIN, MAX]; anything that is not a finite number is the default. */
export function clampMobTelegraphScale(raw: number | null | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return MOB_TELEGRAPH_SCALE_DEFAULT;
  return Math.min(MOB_TELEGRAPH_SCALE_MAX, Math.max(MOB_TELEGRAPH_SCALE_MIN, raw));
}

/** A windup or telegraph length times the (clamped) scale, in whole milliseconds. */
export function scaleTelegraphMs(ms: number, scale: number): number {
  return Math.round(ms * clampMobTelegraphScale(scale));
}

/**
 * A rhythm with its windup scaled. Recover and cooldown keep their lengths, so the cycle grows with the windup and
 * every punish window stays as readable.
 */
export function scaleMobRhythm(rhythm: MobRhythm, scale: number): MobRhythm {
  const windupMs = scaleTelegraphMs(rhythm.windupMs, scale);
  return windupMs === rhythm.windupMs ? rhythm : { ...rhythm, windupMs };
}

/** Token fail-safe hold for a scale: MOB_TACTICS_TOKEN_MAX_HOLD_MS grows with the windups it must cover. */
export function mobTacticsTokenMaxHoldMs(scale: number): number {
  return scaleTelegraphMs(MOB_TACTICS_TOKEN_MAX_HOLD_MS, scale);
}

/** Deterministic value in [0, 1) from a string (FNV-1a), for jitter and strafe direction. */
export function tacticsHash01(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

/** Cooldown with deterministic +-jitter per mob and per cycle, so a pack does not move in lockstep. */
export function jitteredCooldownMs(rhythm: MobRhythm, entityId: string, cycle: number): number {
  const unit = tacticsHash01(`${entityId}:${cycle}`) * 2 - 1;
  return Math.round(rhythm.cooldownMs * (1 + (unit * MOB_TACTICS_COOLDOWN_JITTER_PCT) / 100));
}

/** Ring radii for a mob of the given reach. Layer 0 is the base ring; each layer adds a step. */
export function tacticsRingRadiusM(attackRangeM: number, ring: TacticsRing, layer = 0): number {
  const base = ring === "engage"
    ? attackRangeM * MOB_TACTICS_ENGAGE_RING_FACTOR
    : ring === "wait"
      ? attackRangeM * MOB_TACTICS_WAIT_RING_FACTOR
      : Math.min(MOB_TACTICS_RANGED_RING_MAX_M, attackRangeM * MOB_TACTICS_RANGED_RING_FACTOR);
  return base + Math.max(0, layer) * MOB_TACTICS_LAYER_STEP_M;
}

/** Smallest angle between two neighbours on a ring of this radius (degrees), for a centre-to-centre spacing. */
export function minSlotAngleDeg(radiusM: number, spacingM: number = MOB_TACTICS_SLOT_MIN_SPACING_M): number {
  const half = spacingM / 2;
  if (!(radiusM > half)) return 180;
  return (2 * Math.asin(half / radiusM) * 180) / Math.PI;
}

/** How many mobs fit on a ring of this radius. */
export function ringCapacity(radiusM: number, spacingM: number = MOB_TACTICS_SLOT_MIN_SPACING_M): number {
  return Math.max(1, Math.floor(360 / minSlotAngleDeg(radiusM, spacingM) + 1e-9));
}

/** Angle in [0, 360). */
export function normalizeAngleDeg(angleDeg: number): number {
  const wrapped = angleDeg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Signed shortest difference `to - from` in (-180, 180]. */
export function angleDiffDeg(fromDeg: number, toDeg: number): number {
  let diff = normalizeAngleDeg(toDeg - fromDeg);
  if (diff > 180) diff -= 360;
  return diff;
}

/** Point on a ring around `center`: `angleDeg` is the bearing from the centre to the slot. */
export function ringSlotPosition(center: LatLon, radiusM: number, angleDeg: number): LatLon {
  return destinationPoint(center, radiusM, normalizeAngleDeg(angleDeg));
}

/**
 * Half-width (degrees) of the arc of a ring of `ringRadiusM` around the player that lies within
 * `leashM` of a home `homeDistanceM` from the player, centred on the bearing to home. 180 = the
 * whole ring is reachable; 0 = no point of the ring is (steer toward home).
 */
export function reachableArcHalfDeg(ringRadiusM: number, homeDistanceM: number, leashM: number): number {
  if (!(leashM > 0)) return 180;
  if (homeDistanceM + ringRadiusM <= leashM) return 180;
  if (homeDistanceM < 1e-6 || ringRadiusM < 1e-6) return ringRadiusM <= leashM ? 180 : 0;
  const cosine = (ringRadiusM * ringRadiusM + homeDistanceM * homeDistanceM - leashM * leashM) /
    (2 * ringRadiusM * homeDistanceM);
  if (cosine <= -1) return 180;
  if (cosine >= 1) return 0;
  return (Math.acos(cosine) * 180) / Math.PI;
}

/**
 * Does a point at local (x east, y north) from the lane origin lie in the ranged aim lane?
 * The lane runs `lengthM` along `facingDegrees` and is `widthM` wide (half each side).
 */
export function rangedLaneContains(
  facingDegrees: number,
  lengthM: number,
  widthM: number,
  x: number,
  y: number
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(facingDegrees)) return false;
  const facing = (facingDegrees * Math.PI) / 180;
  const along = Math.sin(facing) * x + Math.cos(facing) * y;
  const across = Math.cos(facing) * x - Math.sin(facing) * y;
  return along >= 0 && along <= lengthM && Math.abs(across) <= widthM / 2;
}
