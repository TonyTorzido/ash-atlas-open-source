import { distanceMeters } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { REVENANT_METAL_FORMATION, attackApproachPosition, formationSlotPosition, undeadRoam } from "./revenantMetalFormation.js";

const OWNER = { lat: 35.0844, lon: -106.6504 };
const MAX_UNDEAD = 5; // 4 skeletons + the Lich

describe("Revenant Metal formation slots", () => {
  it("gives every undead its own slot, at least the minimum spacing apart, at any heading", () => {
    for (const heading of [0, 45, 90, 180, 270, 333]) {
      const slots = Array.from({ length: MAX_UNDEAD + 2 }, (_, index) => formationSlotPosition(OWNER, heading, index));
      for (let a = 0; a < slots.length; a += 1) {
        for (let b = a + 1; b < slots.length; b += 1) {
          expect(distanceMeters(slots[a]!, slots[b]!)).toBeGreaterThanOrEqual(REVENANT_METAL_FORMATION.minSpacingM);
        }
      }
    }
  });

  it("keeps slots off the player, behind and beside, with slot 0 the nearest", () => {
    const distances = Array.from({ length: MAX_UNDEAD }, (_, index) => distanceMeters(OWNER, formationSlotPosition(OWNER, 90, index)));
    expect(Math.min(...distances)).toBeGreaterThanOrEqual(89);
    expect(Math.max(...distances)).toBeLessThanOrEqual(171);
    // Two rows: about 90 m and about 170 m out.
    expect(distances.slice(0, 3).every((d) => Math.abs(d - 90) < 1)).toBe(true);
    expect(distances.slice(3).every((d) => Math.abs(d - 170) < 1)).toBe(true);
    expect(distances[0]).toBeCloseTo(Math.min(...distances), 3);
    // Heading east: slot 0 is due west of the owner (behind).
    const behind = formationSlotPosition(OWNER, 90, 0);
    expect(behind.lon).toBeLessThan(OWNER.lon);
    expect(Math.abs(behind.lat - OWNER.lat)).toBeLessThan(1e-6);
  });

  it("is stable per index and re-packs when one dies", () => {
    const before = [0, 1, 2, 3].map((index) => formationSlotPosition(OWNER, 30, index));
    expect([0, 1, 2, 3].map((index) => formationSlotPosition(OWNER, 30, index))).toEqual(before);
    // Index 2 dies: the old index 3 undead now takes slot 2, everyone below keeps theirs.
    const survivors = [0, 1, 3];
    const repacked = survivors.map((_, index) => formationSlotPosition(OWNER, 30, index));
    expect(repacked[0]).toEqual(before[0]);
    expect(repacked[1]).toEqual(before[1]);
    expect(repacked[2]).toEqual(before[2]);
  });
});

describe("Revenant Metal attack spread", () => {
  it("rings the target at distinct angles inside attack range, never closer than the attack spacing", () => {
    const target = { lat: OWNER.lat + 0.002, lon: OWNER.lon };
    const range = 100;
    const spots = Array.from({ length: MAX_UNDEAD }, (_, index) => attackApproachPosition(target, 200, range, index));
    for (const spot of spots) expect(distanceMeters(spot, target)).toBeLessThanOrEqual(range);
    for (let a = 0; a < spots.length; a += 1) {
      for (let b = a + 1; b < spots.length; b += 1) {
        expect(distanceMeters(spots[a]!, spots[b]!)).toBeGreaterThanOrEqual(REVENANT_METAL_FORMATION.attackSpacingM);
      }
    }
  });
});

describe("Revenant Metal relaxed roam area", () => {
  it("roams a loose area around its own slot, with a dead zone smaller than the slot distance", () => {
    for (let index = 0; index < MAX_UNDEAD; index += 1) {
      const slotDistance = distanceMeters(OWNER, formationSlotPosition(OWNER, 0, index));
      const { profile, deadZoneM } = undeadRoam(index);
      expect(profile.roamMinM).toBeLessThan(slotDistance);
      expect(profile.roamMaxM).toBeGreaterThan(slotDistance);
      expect(profile.driftAtM).toBeGreaterThan(profile.roamMaxM);
      expect(profile.jogAtM).toBeGreaterThan(profile.driftAtM);
      expect(deadZoneM).toBeGreaterThan(0);
      expect(deadZoneM).toBeLessThan(profile.roamMinM);
    }
  });

  it("keeps the roam sectors of neighbouring slots apart", () => {
    // The widest sector spread must stay inside the 60 degree gap between same-row slots.
    expect(undeadRoam(0).profile.behindSpreadDeg).toBeLessThan(40);
  });
});
