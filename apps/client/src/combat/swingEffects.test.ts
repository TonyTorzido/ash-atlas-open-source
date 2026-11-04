import { describe, expect, it } from "vitest";

import { ARCANE_BLAST_SHOT_PROFILE, SWING_MAX_TARGETS } from "@ash-atlas/shared";

import { SwingClientState } from "./swing.js";
import { clientShotProfile, isBoltShot, setClericArcEnabled } from "./clericArc.js";
import {
  ARCANE_BLAST_BURST_MS,
  ARCANE_BLAST_TINT,
  ARC_FADE_MS,
  ARC_POOL_SIZE,
  SPARK_POOL_SIZE,
  SwingEffectsState,
  nudgeMagnitudePx,
  SHOT_FLIGHT_MS,
  BOLT_MIN_FLIGHT_MS,
  BOLT_SPEED_M_PER_S,
  boltFlightMs,
  SHOT_LINGER_MS,
  SHOT_POOL_SIZE,
  predictShotHit,
  predictSwingHits,
  shotFlightProgress,
  HOLY_ARC_TINT,
  HOLY_HEAL_BURST_MS,
  shotLifetimeMs,
} from "./swingEffects.js";
import { HITSTOP_CATCHUP_MS, HIT_TUNING, pushDurationMs } from "./hitFeedback.js";

describe("swing effect pools", () => {
  it("never exceed their caps and reuse the oldest slot", () => {
    const fx = new SwingEffectsState();
    for (let index = 0; index < 100; index += 1) {
      fx.spawnArc(index, 0, 0, 0, index % 3 === 2);
      fx.spawnSpark(index, 0, 0, `mob-${index}`);
    }
    expect(fx.arcs).toHaveLength(ARC_POOL_SIZE);
    expect(fx.sparks).toHaveLength(SPARK_POOL_SIZE);
    expect(fx.activeArcCount(99)).toBeLessThanOrEqual(ARC_POOL_SIZE);
    expect(fx.activeSparkCount(99)).toBeLessThanOrEqual(SPARK_POOL_SIZE);
    // The newest spawn survives; the oldest was recycled.
    expect(fx.arcs.some((arc) => arc.startMs === 99)).toBe(true);
    expect(fx.arcs.some((arc) => arc.startMs === 0)).toBe(false);
  });

  it("retire finished slots on prune", () => {
    const fx = new SwingEffectsState();
    fx.spawnArc(0, 0, 0, 0, false);
    expect(fx.hasActive(10)).toBe(true);
    fx.prune(ARC_FADE_MS + 1);
    expect(fx.hasActive(ARC_FADE_MS + 1)).toBe(false);
  });
});

describe("predicted hit reconciliation", () => {
  it("cancels a predicted miss on the result and keeps the confirmed hit", () => {
    const swing = new SwingClientState();
    const fx = new SwingEffectsState();
    const pending = swing.started({ requestId: "r1", seq: swing.nextSeq(), pressedAtMs: 1000, dirX: 1, dirY: 0 });
    for (const id of ["near", "far"]) {
      pending.predictedHitIds.add(id);
      fx.addPredictedHit(id, "me", 1000, 1, 0);
      fx.spawnSpark(1000, 0, 0, id);
    }
    const resolution = swing.result(
      { requestId: "r1", seq: 0, comboIndex: 0, nextSwingAt: 2_000, hits: [{ entityId: "near" }] },
      1080,
      2_000
    )!;
    expect(resolution.confirmedHitIds).toEqual(["near"]);
    expect(resolution.missedPredictedIds).toEqual(["far"]);
    for (const id of resolution.missedPredictedIds) fx.cancelPredictedHit(id);
    expect(Number.isNaN(fx.hitElapsedMs("far", 1090))).toBe(true);
    expect(fx.nudge("far", 1090, { x: 0, y: 0 })).toBe(false);
    expect(fx.hitstopLagMs("far", 1010)).toBe(0);
    expect(fx.sparks.filter((spark) => spark.active).map((spark) => spark.entityId)).toEqual(["near"]);
    expect(fx.hitElapsedMs("near", 1090)).toBe(90);
  });

  it("predicts only mobs in the arc, nearest SWING_MAX_TARGETS first, against the given (rendered) positions", () => {
    const origin = { lat: 35, lon: -106 };
    const metersToLat = 1 / 111_195;
    const mobs = [
      { id: "ahead-far", lat: origin.lat + 90 * metersToLat, lon: origin.lon },
      { id: "ahead-near", lat: origin.lat + 40 * metersToLat, lon: origin.lon },
      { id: "behind", lat: origin.lat - 60 * metersToLat, lon: origin.lon },
      { id: "out-of-range", lat: origin.lat + 300 * metersToLat, lon: origin.lon },
      { id: "a", lat: origin.lat + 50 * metersToLat, lon: origin.lon },
      { id: "b", lat: origin.lat + 60 * metersToLat, lon: origin.lon },
      { id: "c", lat: origin.lat + 70 * metersToLat, lon: origin.lon }
    ];
    // Facing north.
    expect(predictSwingHits(origin, 0, 1, mobs)).toEqual(["ahead-near", "a", "b", "c", "ahead-far"].slice(0, SWING_MAX_TARGETS));
  });
});

describe("hitstop", () => {
  it("freezes animation sampling for the hold, catches up after it, and never runs backwards", () => {
    const fx = new SwingEffectsState();
    const hold = HIT_TUNING.swing.holdMs;
    fx.addPredictedHit("mob", "me", 1000, 1, 0);
    expect(fx.sampleNowMs("mob", 999)).toBe(999);
    expect(fx.sampleNowMs("mob", 1000)).toBe(1000);
    expect(fx.sampleNowMs("mob", 1016)).toBe(1000);
    expect(fx.sampleNowMs("me", 1000 + hold - 1)).toBe(1000);
    expect(fx.isHeld("mob", 1000 + hold - 1)).toBe(true);
    expect(fx.isHeld("mob", 1000 + hold)).toBe(false);
    expect(fx.hitstopLagMs("mob", 1020)).toBe(20);
    expect(fx.sampleNowMs("other", 1010)).toBe(1010);
    let previous = -Infinity;
    for (let now = 990; now < 1000 + hold + HITSTOP_CATCHUP_MS + 40; now += 4) {
      const sampled = fx.sampleNowMs("me", now);
      expect(sampled).toBeGreaterThanOrEqual(previous);
      previous = sampled;
    }
    expect(fx.sampleNowMs("mob", 1000 + hold + HITSTOP_CATCHUP_MS)).toBe(1000 + hold + HITSTOP_CATCHUP_MS);
  });

  it("holds the combo finisher longer and the local player's incoming hit shorter", () => {
    const fx = new SwingEffectsState();
    fx.addPredictedHit("mob", "me", 0, 1, 0, "finisher");
    expect(fx.isHeld("mob", HIT_TUNING.swing.holdMs + 5)).toBe(true);
    expect(fx.isHeld("me", HIT_TUNING.finisher.holdMs)).toBe(false);
    fx.addIncomingHit("me", "wolf", 1000, 0, 1);
    expect(fx.isHeld("wolf", 1000 + HIT_TUNING.incoming.holdMs - 1)).toBe(true);
    expect(fx.isHeld("me", 1000 + HIT_TUNING.incoming.holdMs)).toBe(false);
    expect(HIT_TUNING.finisher.holdMs).toBeGreaterThan(HIT_TUNING.swing.holdMs);
    expect(HIT_TUNING.incoming.holdMs).toBeLessThan(HIT_TUNING.swing.holdMs);
  });

  it("holds a slash arc with its swinger, then plays it fast to end on time", () => {
    const fx = new SwingEffectsState();
    const hold = HIT_TUNING.swing.holdMs;
    fx.spawnArc(0, 0, 0, 0, false, "me");
    fx.addPredictedHit("mob", "me", 0, 1, 0);
    const arc = fx.arcs.find((slot) => slot.active)!;
    expect(fx.arcElapsedMs(arc, 40)).toBe(0);
    expect(fx.arcElapsedMs(arc, hold + HITSTOP_CATCHUP_MS / 2)).toBeLessThan(hold + HITSTOP_CATCHUP_MS / 2);
    fx.prune(ARC_FADE_MS - 1);
    expect(fx.activeArcCount(ARC_FADE_MS - 1)).toBe(1);
    fx.prune(ARC_FADE_MS);
    expect(fx.activeArcCount(ARC_FADE_MS)).toBe(0);
  });
});

describe("hit push", () => {
  it("jumps part way on impact, eases out after the hold, then eases back to nothing", () => {
    const hold = HIT_TUNING.swing.holdMs;
    const push = HIT_TUNING.swing.pushPx;
    expect(nudgeMagnitudePx(0)).toBeGreaterThan(0);
    expect(nudgeMagnitudePx(0)).toBeLessThan(push);
    expect(nudgeMagnitudePx(hold - 1)).toBe(nudgeMagnitudePx(0));
    let peak = 0;
    for (let elapsed = 0; elapsed < pushDurationMs(hold); elapsed += 5) peak = Math.max(peak, nudgeMagnitudePx(elapsed));
    expect(peak).toBeCloseTo(push, 0);
    expect(nudgeMagnitudePx(pushDurationMs(hold))).toBe(0);
    expect(nudgeMagnitudePx(-5)).toBe(0);
    expect(nudgeMagnitudePx(hold + 60, "finisher")).toBeGreaterThan(nudgeMagnitudePx(hold + 60, "swing"));
  });

  it("pushes along the swing direction and stops", () => {
    const fx = new SwingEffectsState();
    fx.addPredictedHit("mob", "me", 0, 0, -1);
    const out = { x: 0, y: 0 };
    const hold = HIT_TUNING.swing.holdMs;
    expect(fx.nudge("mob", hold + 45, out)).toBe(true);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(-HIT_TUNING.swing.pushPx);
    expect(fx.nudge("mob", pushDurationMs(hold), out)).toBe(false);
  });
});

describe("aim indicator", () => {
  it("sets, keeps the layer active and clears", () => {
    const fx = new SwingEffectsState();
    expect(fx.hasActive(0)).toBe(false);
    fx.setAimIndicator(35, -106, 90);
    expect(fx.aimIndicator).toMatchObject({ active: true, bearingDeg: 90 });
    expect(fx.hasActive(10_000)).toBe(true);
    fx.clearAimIndicator();
    expect(fx.hasActive(10_000)).toBe(false);
  });
});

describe("ranged shot prediction and projectiles", () => {
  const origin = { lat: 0, lon: 0 };
  const metersToLon = (m: number) => m / 111_320;
  const mob = (id: string, eastM: number, northM: number) => ({ id, lat: northM / 111_320, lon: metersToLon(eastM) });

  it("hits only the first mob on the line, farther than the melee arc", () => {
    const hit = predictShotHit(origin, 1, 0, [mob("far", 200, 0), mob("near", 150, 5), mob("side", 100, 60), mob("behind", -50, 0)]);
    expect(hit?.id).toBe("near");
    expect(hit!.distanceM).toBeGreaterThan(149);
    expect(hit!.distanceM).toBeLessThan(151);
  });

  it("misses past the range, outside the corridor and behind", () => {
    expect(predictShotHit(origin, 1, 0, [mob("too-far", 400, 0), mob("wide", 100, 60), mob("behind", -20, 0)])).toBeNull();
    expect(predictShotHit(origin, 0, 1, [])).toBeNull();
  });

  it("flies for the flight time then lingers, pooled", () => {
    const fx = new SwingEffectsState();
    for (let index = 0; index < 50; index += 1) fx.spawnShot(index, 0, 0, 90, 100, "", "bow", {} as never);
    expect(fx.shots).toHaveLength(SHOT_POOL_SIZE);
    expect(fx.activeShotCount(49)).toBeLessThanOrEqual(SHOT_POOL_SIZE);
    expect(shotFlightProgress(0)).toBe(0);
    expect(shotFlightProgress(SHOT_FLIGHT_MS / 2)).toBeCloseTo(0.5);
    expect(shotFlightProgress(SHOT_FLIGHT_MS * 3)).toBe(1);
    fx.prune(49 + SHOT_FLIGHT_MS + SHOT_LINGER_MS + 1);
    expect(fx.hasActive(49 + SHOT_FLIGHT_MS + SHOT_LINGER_MS + 1)).toBe(false);
  });

  it("predicts with the arcane blast's own corridor", () => {
    // 5.5 m off the line: outside the arrow's 5 m half width, inside the 6 m arcane bolt.
    const offLine = [{ ...mob("caster-target", 150, 5.5), radiusM: 0 }];
    expect(predictShotHit(origin, 1, 0, offLine)).toBeNull();
    expect(predictShotHit(origin, 1, 0, offLine, ARCANE_BLAST_SHOT_PROFILE)?.id).toBe("caster-target");
  });

  it("an arcane blast is a procedural slot (no sprite) that lives through its impact burst", () => {
    const fx = new SwingEffectsState();
    fx.spawnArcaneBlast(0, 0, 0, 90, 200, "wolf");
    const slot = fx.shots.find((shot) => shot.active)!;
    expect(slot).toMatchObject({ kind: "arcane", tint: ARCANE_BLAST_TINT, transform: null, distanceM: 200, targetId: "wolf" });
    fx.spawnArcaneBlast(1, 0, 0, 90, 200, "", 0x33ccff);
    expect(fx.shots.find((shot) => shot.startMs === 1)!.tint).toBe(0x33ccff);
    // Still drawn past an arrow's linger (the burst is longer), gone after it.
    const arrowEnd = SHOT_FLIGHT_MS + SHOT_LINGER_MS;
    expect(fx.activeShotCount(arrowEnd + 1)).toBe(2);
    const boltEnd = boltFlightMs(200) + ARCANE_BLAST_BURST_MS;
    expect(fx.activeShotCount(boltEnd - 1)).toBe(2);
    fx.prune(boltEnd + 1);
    expect(fx.activeShotCount(boltEnd + 1)).toBe(0);
    // A spawnShot reusing the slot is an arrow again.
    fx.spawnShot(500, 0, 0, 90, 100, "", "bow", {} as never);
    expect(fx.shots.find((shot) => shot.startMs === 500)!.kind).toBe("arrow");
  });

  it("bolts fly at a constant speed (min 120 ms), arrows keep the fixed flight", () => {
    expect(BOLT_SPEED_M_PER_S).toBe(600);
    expect(boltFlightMs(280)).toBeCloseTo(280 / 600 * 1_000, 6);
    expect(boltFlightMs(120)).toBeCloseTo(200, 6);
    expect(boltFlightMs(30)).toBe(BOLT_MIN_FLIGHT_MS);
    expect(boltFlightMs(0)).toBe(BOLT_MIN_FLIGHT_MS);
    const fx = new SwingEffectsState();
    fx.spawnArcaneBlast(0, 0, 0, 90, 280, "");
    fx.spawnShot(1, 0, 0, 90, 280, "", "bow", {} as never);
    expect(fx.shots.find((shot) => shot.startMs === 0)!.flightMs).toBeCloseTo(466.67, 1);
    expect(fx.shots.find((shot) => shot.startMs === 1)!.flightMs).toBe(SHOT_FLIGHT_MS);
    // Progress follows the slot's own flight time.
    const flightMs = boltFlightMs(280);
    expect(shotFlightProgress(flightMs / 2, flightMs)).toBeCloseTo(0.5);
    expect(shotFlightProgress(flightMs * 2, flightMs)).toBe(1);
  });

  it("a server-refuted predicted hit clears the shot's target", () => {
    const fx = new SwingEffectsState();
    fx.spawnShot(0, 0, 0, 90, 100, "dummy", "bow", {} as never);
    fx.cancelPredictedHit("dummy");
    expect(fx.shots.find((shot) => shot.active)?.targetId).toBe("");
  });
});

describe("holy arc presentation", () => {
  it("a heal burst is a pooled slot on the healed ally that lives HOLY_HEAL_BURST_MS", () => {
    const fx = new SwingEffectsState();
    fx.spawnHealBurst(1_000, "ally");
    const slot = fx.shots.find((shot) => shot.active)!;
    expect(slot).toMatchObject({ kind: "heal", targetId: "ally", tint: HOLY_ARC_TINT });
    expect(shotLifetimeMs(slot)).toBe(HOLY_HEAL_BURST_MS);
    fx.prune(1_000 + HOLY_HEAL_BURST_MS - 1);
    expect(fx.activeShotCount(1_000 + HOLY_HEAL_BURST_MS - 1)).toBe(1);
    fx.prune(1_000 + HOLY_HEAL_BURST_MS);
    expect(fx.activeShotCount(1_000 + HOLY_HEAL_BURST_MS)).toBe(0);
  });

  it("the scepter shoots the holy arc only while the server flag is on", () => {
    const scepter = {
      activeHand: "melee", slots: { melee: { equipmentDefinitionId: "training_scepter" } }
    } as never;
    setClericArcEnabled(false);
    expect(clientShotProfile(scepter)).toBeNull();
    setClericArcEnabled(true);
    expect(clientShotProfile(scepter)?.id).toBe("holy_arc");
    expect(isBoltShot(clientShotProfile(scepter))).toBe(true);
    setClericArcEnabled(false);
  });
});
