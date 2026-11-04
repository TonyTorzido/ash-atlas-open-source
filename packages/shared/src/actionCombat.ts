import type { WeaponCategory } from "./classContracts.js";
import { longitudeDeltaDegrees } from "./geo.js";

/**
 * Action combat (swing-to-hit melee + one ranged shot): the one place every constant lives,
 * like dash.ts. The server resolves hits with these; the client predicts with the same numbers.
 *
 * Directions on the wire are WORLD-space unit vectors (dirX = east, dirY = north), the same
 * convention as DASH. Hit tests run in a local metric frame centred on the attacker
 * (x = metres east, y = metres north), built with `toLocalMeters`.
 *
 * Tick counts assume the 20 Hz server tick (50 ms).
 */

/**
 * Swing arc length, measured from the attacker's centre to the target's hurt circle edge (hitGeometry.ts). It was
 * 130 m against a flat 20 m body (150 m centre to centre); mob hurt circles are art-derived (about 40 m for a wolf),
 * so the arc is 20 m shorter to keep that 150 m connect distance on a typical mob (docs/plans/hurt-circles.md).
 */
export const SWING_RANGE_M = 110;
/** Half of the 120 degree swing arc. */
export const SWING_HALF_ANGLE_DEG = 60;
/** Targets whose centre is within this distance are hit regardless of angle. */
export const SWING_POINT_BLANK_M = 25;
/**
 * The old flat mob body radius. Hit tests no longer use it: a mob's hurt circle is mobHurtRadiusM (hitGeometry.ts).
 * Kept only as the fallback radius for a candidate whose art is unknown.
 */
export const SWING_TARGET_RADIUS_M = 20;
/** Cleave cap: at most this many targets per swing, nearest first (edge distance). 1 = single target; raise it to bring cleave back. */
export const SWING_MAX_TARGETS = 1;
/**
 * Recovery per combo step of the DEFAULT attack profile: 700/700/900 ms at 20 Hz (a full combo is 2.3 s, about 0.76
 * base hits per second). Swings read their cadence from attackProfiles.ts; this, SWING_COMBO_RESET_MS,
 * SWING_DAMAGE_FACTORS and SWING_KNOCKBACK_M stay as the default profile's values (a test pins them equal).
 */
export const SWING_RECOVERY_TICKS = [14, 14, 18] as const;
/** Idle longer than this since the last swing and the combo restarts at step 0. Must stay above the longest recovery (900 ms) plus slack. */
export const SWING_COMBO_RESET_MS = 1300;
/** A press up to this many ticks early is buffered (one slot); earlier is rejected as too_soon. */
export const SWING_BUFFER_EARLY_TICKS = 5;
/** Damage factor per combo step, applied to the basic-attack damage. The single DPS lever. */
export const SWING_DAMAGE_FACTORS = [0.5, 0.5, 0.75] as const;
/** Hitstun on a non-boss mob that survives a swing (200 ms). */
export const SWING_HITSTUN_TICKS = 4;
/** Knockback distance per combo step. Off (0) for now; it returns later as a perk. A 0 m push is skipped, not applied. */
export const SWING_KNOCKBACK_M = [0, 0, 0] as const;
/** The server clamps the client's lag hint to this before rewinding mob positions. */
export const SWING_LAG_COMP_MAX_MS = 250;
/** Largest lag hint the SWING schema accepts at all (the server still clamps to SWING_LAG_COMP_MAX_MS). */
export const SWING_LAG_HINT_MAX_MS = 1_000;
/** Position history ring length (400 ms at 20 Hz), covering the lag compensation cap. */
export const POSITION_HISTORY_TICKS = 8;
/**
 * Hitscan shot reach along the aim line, to the target's hurt circle edge. Was 300 m against a flat 20 m body;
 * 280 m keeps the 320 m connect distance on a typical mob (about 40 m hurt circle).
 */
export const SHOT_RANGE_M = 280;
/**
 * Width of the arrow itself (a 5 m radius projectile swept along the aim line), before the target's hurt circle.
 * Was a 30 m corridor against a flat 20 m body; the art-derived hurt circle now supplies the width.
 */
export const SHOT_WIDTH_M = 18;
/** Recovery after a shot (1000 ms at 20 Hz, about 0.75 shots per second). */
export const SHOT_RECOVERY_TICKS = 20;
/** Damage factor of a shot (no combo: every shot uses this one factor). */
export const SHOT_DAMAGE_FACTOR = 0.75;
/**
 * Arcane blast (staff and wand, docs/plans/class-roster-v2.md 6.6): a hitscan bolt on the bow's shot path with its own
 * numbers. Arcane blast reach (300 m, 50 m wide); 1.1 s recovery (22 ticks) at factor 0.75 = 0.68 basic hits
 * per second, 91 % of the bow's 0.75 (the roster draft puts the staff a little under the bow). Single target: the
 * Mage kit adds area splash later.
 */
export const ARCANE_BLAST_RANGE_M = 300;
export const ARCANE_BLAST_WIDTH_M = 50;
export const ARCANE_BLAST_RECOVERY_TICKS = 22;
export const ARCANE_BLAST_DAMAGE_FACTOR = 0.75;
/**
 * Holy arc (the Cleric's scepter, docs/plans/class-roster-v2.md 5): a hitscan bolt on the bow's shot path that heals
 * the eligible allies it passes through and stops on, and damages, the first enemy. 300 m range, a 50 m wide bolt,
 * 1.0 s recovery (20 ticks) at factor 0.56 = 0.56 basic hits per second, 75 % of the bow's 0.75 (the roster
 * puts the Cleric at 70-80 % of the Ranger so solo farming still works).
 */
export const HOLY_ARC_RANGE_M = 300;
export const HOLY_ARC_WIDTH_M = 50;
export const HOLY_ARC_RECOVERY_TICKS = 20;
export const HOLY_ARC_DAMAGE_FACTOR = 0.56;
/**
 * Heal per ally the arc passes through, as a factor on the arc's base damage (the caster's basic attack x
 * HOLY_ARC_DAMAGE_FACTOR, before the target's armour): 1.5x, so 10 basic attack heals 8 per press.
 */
export const HOLY_ARC_HEAL_FACTOR = 1.5;
/**
 * A Cleric gets kill credit (a party-style contribution) on a mob that an ally they healed was fighting when the mob
 * dies within this long of the heal.
 */
export const HOLY_ARC_XP_CREDIT_WINDOW_MS = 10_000;

/** Shot rules of one ranged attack kind: the hitscan corridor, the recovery gate and the damage factor. */
export type ShotProfile = Readonly<{
  id: "arrow" | "arcane_blast" | "holy_arc";
  /** Reach along the aim line, to the target's hurt circle edge. */
  rangeM: number;
  /** Projectile width before the target's hurt circle. */
  widthM: number;
  /** Press-to-next-press gate in 50 ms server ticks. */
  recoveryTicks: number;
  /** Factor on the basic-attack damage. */
  damageFactor: number;
}>;

/** The bow (any ranged_weapon without its own profile): exactly the SHOT_* rules above. */
export const BOW_SHOT_PROFILE: ShotProfile = Object.freeze({
  id: "arrow",
  rangeM: SHOT_RANGE_M,
  widthM: SHOT_WIDTH_M,
  recoveryTicks: SHOT_RECOVERY_TICKS,
  damageFactor: SHOT_DAMAGE_FACTOR
});

export const ARCANE_BLAST_SHOT_PROFILE: ShotProfile = Object.freeze({
  id: "arcane_blast",
  rangeM: ARCANE_BLAST_RANGE_M,
  widthM: ARCANE_BLAST_WIDTH_M,
  recoveryTicks: ARCANE_BLAST_RECOVERY_TICKS,
  damageFactor: ARCANE_BLAST_DAMAGE_FACTOR
});

export const HOLY_ARC_SHOT_PROFILE: ShotProfile = Object.freeze({
  id: "holy_arc",
  rangeM: HOLY_ARC_RANGE_M,
  widthM: HOLY_ARC_WIDTH_M,
  recoveryTicks: HOLY_ARC_RECOVERY_TICKS,
  damageFactor: HOLY_ARC_DAMAGE_FACTOR
});

/** Weapon families that cast the arcane blast instead of swinging (staff) or shooting arrows (wand). */
const ARCANE_BLAST_WEAPON_FAMILIES: ReadonlySet<WeaponCategory> = new Set<WeaponCategory>(["staff", "wand"]);

/** Server feature switches that change which weapons shoot. */
export type ShotProfileFlags = Readonly<{
  /** CLERIC_ARC_ENABLED: the scepter casts the holy arc. Off (default): the scepter swings like any melee weapon. */
  holyArc?: boolean;
}>;

/**
 * The one resolver for "does this readied weapon shoot, and with which rules": the staff and wand cast the arcane
 * blast, the scepter casts the holy arc (only with `flags.holyArc`), any other ranged weapon shoots the bow's arrow,
 * and everything else swings (null). Server and client both call this (the client from the appearance's equipment
 * definition and the server's WELCOME flags).
 */
export function shotProfileForWeapon(
  weaponFamily: WeaponCategory | null | undefined,
  rangedWeapon: boolean,
  flags: ShotProfileFlags = {}
): ShotProfile | null {
  if (weaponFamily && ARCANE_BLAST_WEAPON_FAMILIES.has(weaponFamily)) return ARCANE_BLAST_SHOT_PROFILE;
  if (weaponFamily === "scepter" && flags.holyArc === true) return HOLY_ARC_SHOT_PROFILE;
  return rangedWeapon ? BOW_SHOT_PROFILE : null;
}

/** Longest shot range of any profile (spatial query bounds). */
export const SHOT_RANGE_MAX_M = Math.max(SHOT_RANGE_M, ARCANE_BLAST_RANGE_M, HOLY_ARC_RANGE_M);

/** One body on a holy arc's line: its distance along the aim line and whether the arc heals it or stops on it. */
export type HolyArcLineEntry = Readonly<{ id: string; alongM: number; role: "ally" | "enemy" }>;

/** What one holy arc does: the allies it heals (nearest first), the enemy it stops on, and how far it flew. */
export type HolyArcPath = { healIds: string[]; enemyId: string | null; reachM: number };

/**
 * Walks a holy arc's line in order: every ally strictly before the first enemy is healed, the first enemy takes the
 * hit and stops the arc, and with no enemy the arc heals along its full `rangeM`. Ties keep the earlier entry.
 * The caller has already filtered entries to the corridor (eligible allies only, never the caster).
 */
export function resolveHolyArcPath(entries: readonly HolyArcLineEntry[], rangeM: number): HolyArcPath {
  let enemy: HolyArcLineEntry | null = null;
  for (const entry of entries) {
    if (entry.role === "enemy" && (enemy === null || entry.alongM < enemy.alongM)) enemy = entry;
  }
  const healIds = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.role === "ally" && (enemy === null || entry.alongM < enemy.alongM))
    .sort((left, right) => left.entry.alongM - right.entry.alongM || left.index - right.index)
    .map(({ entry }) => entry.id);
  return { healIds, enemyId: enemy?.id ?? null, reachM: enemy ? enemy.alongM : rangeM };
}

/** Health one holy arc restores to each ally it passes through, from the caster's basic attack damage. */
export function holyArcHealAmount(basicAttackDamage: number): number {
  if (!Number.isFinite(basicAttackDamage) || basicAttackDamage <= 0) return 0;
  return Math.max(1, Math.round(basicAttackDamage * HOLY_ARC_DAMAGE_FACTOR * HOLY_ARC_HEAL_FACTOR));
}
/** Melee windup applied to all melee mobs while action combat is on. */
export const MOB_MELEE_WINDUP_MS = 450;
/** Mobs whose attack range is at most this wind up their basic strike (ranged and caster mobs do not). */
export const MOB_MELEE_WINDUP_MAX_RANGE_M = 100;
/** Full width of the melee windup cone. */
export const MOB_MELEE_WINDUP_ANGLE_DEG = 90;
/** Slack past the telegraphed range a target may stand and still be struck (the mob's attack hold buffer). */
export const MOB_MELEE_WINDUP_RANGE_SLACK_M = 5;
/** Inside this distance of the mob the strike lands whatever the angle. */
export const MOB_MELEE_WINDUP_POINT_BLANK_M = 15;
/** Telegraph ability id and DODGE innate id of the melee windup. */
export const MOB_MELEE_WINDUP_ID = "melee_windup";

/** Number of steps in the default swing combo (a profile may define 1 .. ATTACK_COMBO_MAX_LENGTH). */
export const SWING_COMBO_LENGTH = SWING_DAMAGE_FACTORS.length;
/** A combo step index on the wire: 0 .. ATTACK_COMBO_MAX_LENGTH - 1 (attackProfiles.ts). */
export type SwingComboIndex = 0 | 1 | 2 | 3 | 4 | 5;

/** Why the server refused a SWING (SWING_RESULT.rejected). */
export const SWING_REJECT_REASONS = ["too_soon", "dashing", "unavailable", "disabled"] as const;
export type SwingRejectReason = (typeof SWING_REJECT_REASONS)[number];

/**
 * `abilityId` carried by the SWING combat event for the default profile. A profile whose data differs from the
 * default adds "@<profile id>" to the swing ids (attackProfiles.ts swingEventAbilityId).
 */
export const SWING_EVENT_ABILITY_IDS = ["swing_0", "swing_1", "swing_2", "shot"] as const;
export type SwingEventAbilityId = (typeof SWING_EVENT_ABILITY_IDS)[number];

const EARTH_RADIUS_M = 6_371_008.8; // same sphere as geo.ts
const METERS_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180;
const SWING_HALF_ANGLE_COS = Math.cos((SWING_HALF_ANGLE_DEG * Math.PI) / 180);
const SWING_HALF_ANGLE_SIN = Math.sin((SWING_HALF_ANGLE_DEG * Math.PI) / 180);
// Tiny epsilon so a centre exactly on the cone edge counts despite float rounding.
const WINDUP_HALF_ANGLE_COS = Math.cos((MOB_MELEE_WINDUP_ANGLE_DEG / 2) * Math.PI / 180) - 1e-9;

/** Mutable output point for `toLocalMeters` (reuse one per caller; nothing is allocated). */
export type LocalMetersOut = { x: number; y: number };

/**
 * Local metric frame around (lat0, lon0): x = metres east, y = metres north.
 * east = dLon * cos(lat0) * R * rad, north = dLat * R * rad. Pass `cosLat0 = Math.cos(lat0 rad)`,
 * computed once per swing. Longitude deltas take the short way across the antimeridian.
 * Accurate to well under a metre at swing/shot ranges.
 */
export function toLocalMeters(
  lat0: number,
  lon0: number,
  cosLat0: number,
  lat: number,
  lon: number,
  out: LocalMetersOut
): void {
  out.x = longitudeDeltaDegrees(lon0, lon) * cosLat0 * METERS_PER_DEGREE;
  out.y = (lat - lat0) * METERS_PER_DEGREE;
}

/** Inverse of toLocalMeters: the point `x` m east and `y` m north of (lat0, lon0). */
export function fromLocalMeters(lat0: number, lon0: number, cosLat0: number, x: number, y: number): { lat: number; lon: number } {
  let lon = lon0 + x / (Math.max(1e-9, cosLat0) * METERS_PER_DEGREE);
  if (lon > 180) lon -= 360;
  else if (lon < -180) lon += 360;
  return { lat: lat0 + y / METERS_PER_DEGREE, lon };
}

/**
 * Does a target circle at local (x, y) with radius `targetRadiusM` touch the swing arc aimed
 * along (dirX, dirY)? The arc is SWING_RANGE_M long (to the target's edge) and
 * 2 x SWING_HALF_ANGLE_DEG wide; a centre within SWING_POINT_BLANK_M always counts.
 * The direction is normalised here, so a near-unit wire vector is fine.
 */
export function swingArcContains(
  dirX: number,
  dirY: number,
  x: number,
  y: number,
  targetRadiusM: number
): boolean {
  const dirLength = Math.hypot(dirX, dirY);
  if (!(dirLength > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const distanceM = Math.hypot(x, y);
  if (distanceM <= SWING_POINT_BLANK_M) return true;
  const radius = Math.max(0, targetRadiusM);
  if (distanceM - radius > SWING_RANGE_M) return false;
  const ux = dirX / dirLength;
  const uy = dirY / dirLength;
  const along = ux * x + uy * y;
  const across = Math.abs(ux * y - uy * x);
  // Centre inside the wedge: cos(angle) >= cos(half angle).
  if (along >= distanceM * SWING_HALF_ANGLE_COS) return true;
  // Otherwise test the circle against the nearer edge ray (rotated by the half angle toward it).
  const projectionOnEdge = along * SWING_HALF_ANGLE_COS + across * SWING_HALF_ANGLE_SIN;
  if (projectionOnEdge < 0) return distanceM <= radius;
  const distanceToEdge = across * SWING_HALF_ANGLE_COS - along * SWING_HALF_ANGLE_SIN;
  return distanceToEdge <= radius;
}

/**
 * Hitscan shot along (dirX, dirY): returns the target's distance along the aim line (>= 0) when
 * its circle touches the profile's corridor (`widthM` wide, `rangeM` long; the bow's SHOT_WIDTH_M x
 * SHOT_RANGE_M by default), otherwise null.
 * Targets behind the shooter are never hit. Callers pick the smallest result (first on the line).
 */
export function shotLineContains(
  dirX: number,
  dirY: number,
  x: number,
  y: number,
  targetRadiusM: number,
  profile: ShotProfile = BOW_SHOT_PROFILE
): number | null {
  const dirLength = Math.hypot(dirX, dirY);
  if (!(dirLength > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const ux = dirX / dirLength;
  const uy = dirY / dirLength;
  const along = ux * x + uy * y;
  if (along < 0) return null;
  const radius = Math.max(0, targetRadiusM);
  if (along - radius > profile.rangeM) return null;
  const across = Math.abs(ux * y - uy * x);
  if (across > profile.widthM / 2 + radius) return null;
  return along;
}

/**
 * Is a target centre at local (x, y) (metres east, north of the mob) still inside the melee windup
 * cone facing `facingDegrees` (compass bearing, 0 = north, clockwise)? The cone reaches `rangeM`
 * plus MOB_MELEE_WINDUP_RANGE_SLACK_M and is MOB_MELEE_WINDUP_ANGLE_DEG wide; a centre within
 * MOB_MELEE_WINDUP_POINT_BLANK_M always counts.
 */
export function meleeWindupConeContains(
  facingDegrees: number,
  rangeM: number,
  x: number,
  y: number,
  /** Distance past `rangeM` a target centre may be and still be struck (managed melee: the target body radius). */
  slackM: number = MOB_MELEE_WINDUP_RANGE_SLACK_M
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(facingDegrees)) return false;
  const distanceM = Math.hypot(x, y);
  if (distanceM <= MOB_MELEE_WINDUP_POINT_BLANK_M) return true;
  if (distanceM > rangeM + slackM) return false;
  const facing = (facingDegrees * Math.PI) / 180;
  const along = Math.sin(facing) * x + Math.cos(facing) * y;
  return along >= distanceM * WINDUP_HALF_ANGLE_COS;
}
