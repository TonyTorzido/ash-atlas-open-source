import { destinationPoint, type LatLon } from "@ash-atlas/shared";

import type { RoamProfile } from "./companionFollow.js";

/**
 * Revenant Metal undead formation (pure math, no state). Index 0 is the slot nearest the owner (the
 * Lich takes it when one is present); skeletons follow in summon order, so when one dies the
 * later ones shift up a slot. Distances are in metres at game scale (melee range is 100 m); the
 * undead sit about as far out as a live pet and amble around their slot rather than hold it.
 */
export const REVENANT_METAL_FORMATION = Object.freeze({
  /** No two undead stand closer than this, in a formation or around a target. */
  minSpacingM: 60,
  /** Attackers ring a target at least this far apart (the pre-relaxed spacing; the ring is tight). */
  attackSpacingM: 30,
  /** An undead within this fraction of its slot distance from the slot stands still (the dead zone). */
  deadZoneFraction: 0.4,
  /** Pace while ambling, as a fraction of the owner's walking speed; it only goes full speed when far behind. */
  amblePaceFraction: 0.6,
  /** Fraction of the attack range at which attackers ring a target. */
  attackRingFraction: 0.85
});

/**
 * Slots behind and beside the owner. `bearingOffsetDeg` is measured from straight behind the
 * owner (positive = clockwise, toward the owner's left-behind side). Two rows: three on the near
 * row (90 m), the rest on a far row (170 m). Every pair is at least 60 m apart.
 */
const SLOT_OFFSETS: readonly Readonly<{ distanceM: number; bearingOffsetDeg: number }>[] = Object.freeze([
  { distanceM: 90, bearingOffsetDeg: 0 },
  { distanceM: 90, bearingOffsetDeg: 60 },
  { distanceM: 90, bearingOffsetDeg: -60 },
  { distanceM: 170, bearingOffsetDeg: 30 },
  { distanceM: 170, bearingOffsetDeg: -30 },
  { distanceM: 170, bearingOffsetDeg: 90 },
  { distanceM: 170, bearingOffsetDeg: -90 }
]);

function slotSpec(index: number): Readonly<{ distanceM: number; bearingOffsetDeg: number }> {
  const slot = SLOT_OFFSETS[Math.min(index, SLOT_OFFSETS.length - 1)]!;
  // Past the table (never at the 5-skeleton + Lich cap) keep stepping outward so slots stay apart.
  const extraRows = Math.max(0, index - (SLOT_OFFSETS.length - 1));
  return { distanceM: slot.distanceM + extraRows * (REVENANT_METAL_FORMATION.minSpacingM + 5), bearingOffsetDeg: slot.bearingOffsetDeg };
}

/** Where slot `index` stands for an owner moving along `headingDeg` (compass degrees). */
export function formationSlotPosition(owner: LatLon, headingDeg: number, index: number): LatLon {
  const slot = slotSpec(index);
  return destinationPoint(owner, slot.distanceM, headingDeg + 180 + slot.bearingOffsetDeg);
}

/**
 * The loose area an undead roams in (the pet roam logic, centred on the owner): a sector around
 * its slot's bearing and distance. Beyond `driftAtM` it heads back; `jogAtM` re-aims nearer.
 */
export function undeadRoam(index: number): Readonly<{ profile: RoamProfile; bearingOffsetDeg: number; deadZoneM: number }> {
  const slot = slotSpec(index);
  const roamMaxM = slot.distanceM * 1.2;
  return {
    profile: {
      roamMinM: slot.distanceM * 0.85, roamMaxM, driftAtM: roamMaxM * 1.2, jogAtM: roamMaxM * 1.6,
      pauseMinMs: 5_000, pauseMaxMs: 14_000, behindSpreadDeg: 24, settleNearOwnerM: 0
    },
    bearingOffsetDeg: slot.bearingOffsetDeg,
    deadZoneM: slot.distanceM * REVENANT_METAL_FORMATION.deadZoneFraction
  };
}

/** Bearing offsets (degrees) around the target; index 0 is the owner's side. 40 deg apart at ~85 m is ~58 m (spacing is attackSpacingM). */
const APPROACH_OFFSETS_DEG: readonly number[] = Object.freeze([0, 40, -40, 80, -80, 120, -120, 160]);

/**
 * Where attacker `index` stands to hit `target`: on a ring inside attack range, at its own angle,
 * starting on the side the owner is on, so attackers spread out instead of piling on one point.
 */
export function attackApproachPosition(
  target: LatLon,
  bearingTargetToOwnerDeg: number,
  attackRangeM: number,
  index: number
): LatLon {
  const offset = APPROACH_OFFSETS_DEG[index % APPROACH_OFFSETS_DEG.length]!;
  const ringM = Math.max(1, attackRangeM * REVENANT_METAL_FORMATION.attackRingFraction);
  return destinationPoint(target, ringM, bearingTargetToOwnerDeg + offset);
}
