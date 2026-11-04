import {
  PLAYER_ATTACK_ACTION_WINDOW_MS,
  type CombatEntitySnapshot,
  type CombatEvent,
  type WeaponCategory
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  ATTACK_STRIKE_APPROACH_DURATION_MS,
  ATTACK_STRIKE_DISTANCE_PX,
  ATTACK_STRIKE_HOLD_DURATION_MS,
  ATTACK_STRIKE_MAX_ROTATION_DEGREES,
  ATTACK_STRIKE_RETURN_DURATION_MS,
  ATTACK_JIGGLE_DURATION_MS,
  attackDirectionFromPoints,
  attackJiggleRotationRadians,
  attackStrikeMotion,
  attackStrikeProgress,
  PlayerAppearancePoseController
} from "./playerAppearancePose.js";

describe("authoritative player appearance combat poses", () => {
  it.each<WeaponCategory>(["sword", "bow"])(
    "uses the same Idle, Ready, and Action transitions for %s combat",
    (weaponCategory) => {
      const controller = new PlayerAppearancePoseController();
      const ready = player("local", true, weaponCategory);
      expect(controller.poseFor("local", player("local", false, weaponCategory), 0))
        .toBe("idle");
      expect(controller.poseFor("local", ready, 0)).toBe("combat_ready");

      controller.observeAuthoritativeEvents([attack("hit-1", "local", 8)], 100);
      expect(controller.poseFor("local", ready, 100)).toBe("attack_action");
      expect(controller.poseFor(
        "local",
        ready,
        100 + PLAYER_ATTACK_ACTION_WINDOW_MS
      )).toBe("combat_ready");
      expect(controller.poseFor(
        "local",
        player("local", false, weaponCategory),
        100 + PLAYER_ATTACK_ACTION_WINDOW_MS
      )).toBe("idle");
    }
  );

  it("rejects stale and duplicate authoritative attack events", () => {
    const controller = new PlayerAppearancePoseController();
    const ready = player("local", true, "sword");
    controller.observeAuthoritativeEvents([attack("new", "local", 10)], 1_000);
    controller.observeAuthoritativeEvents([attack("stale", "local", 9)], 1_100);
    controller.observeAuthoritativeEvents([attack("new", "local", 10)], 1_150);
    expect(controller.poseFor(
      "local",
      ready,
      1_000 + PLAYER_ATTACK_ACTION_WINDOW_MS - 1
    )).toBe("attack_action");
    expect(controller.poseFor(
      "local",
      ready,
      1_000 + PLAYER_ATTACK_ACTION_WINDOW_MS
    )).toBe("combat_ready");
  });

  it("restarts the strike envelope for a newer authoritative attack", () => {
    const controller = new PlayerAppearancePoseController();
    const ready = player("mob", true, "sword");

    controller.observeAuthoritativeEvents([attack("hit-1", "mob", 8)], 100);
    expect(controller.attackStrikeMotionFor("mob", 235, { x: 1, y: 0 }).offsetX)
      .toBeCloseTo(ATTACK_STRIKE_DISTANCE_PX);

    controller.observeAuthoritativeEvents([attack("hit-2", "mob", 9)], 420);
    expect(controller.attackStrikeMotionFor("mob", 420, { x: 1, y: 0 }).offsetX)
      .toBe(0);
    expect(controller.attackStrikeMotionFor(
      "mob",
      420 + ATTACK_STRIKE_APPROACH_DURATION_MS,
      { x: 1, y: 0 }
    ).offsetX).toBeCloseTo(ATTACK_STRIKE_DISTANCE_PX);
    expect(controller.attackStrikeMotionFor(
      "mob",
      420 + ATTACK_STRIKE_APPROACH_DURATION_MS + ATTACK_STRIKE_HOLD_DURATION_MS,
      { x: 1, y: 0 }
    ).offsetX).toBeCloseTo(ATTACK_STRIKE_DISTANCE_PX);
    expect(controller.attackStrikeMotionFor(
      "mob",
      420 + ATTACK_JIGGLE_DURATION_MS,
      { x: 1, y: 0 }
    )).toEqual({ offsetX: 0, offsetY: 0, rotationRadians: 0 });
    expect(controller.poseFor(
      "mob",
      ready,
      420 + PLAYER_ATTACK_ACTION_WINDOW_MS - 1
    )).toBe("attack_action");
    expect(controller.poseFor(
      "mob",
      ready,
      420 + PLAYER_ATTACK_ACTION_WINDOW_MS
    )).toBe("combat_ready");
  });

  it("applies one nearby-player attack event only to its authoritative source", () => {
    const controller = new PlayerAppearancePoseController();
    const local = player("local", true, "sword");
    const remote = player("remote", true, "bow");
    controller.observeAuthoritativeEvents([attack("remote-hit", "remote", 4)], 50);
    expect(controller.poseFor("remote", remote, 50)).toBe("attack_action");
    expect(controller.poseFor("local", local, 50)).toBe("combat_ready");
  });

  it("keeps authoritative Downed pose ahead of attack animation state", () => {
    const controller = new PlayerAppearancePoseController();
    const downed = { ...player("local", true, "sword"), lifeState: "downed" as const, downedUntil: 10_000 };
    controller.observeAuthoritativeEvents([attack("hit-before-downed", "local", 8)], 100);
    expect(controller.poseFor("local", downed, 100)).toBe("downed");
  });

  it("starts one decisive attack strike only for an authoritative hit and cleans it up", () => {
    const controller = new PlayerAppearancePoseController();
    const ready = player("mob", true, "sword");

    expect(controller.attackJiggleRadians("mob", 100)).toBe(0);
    controller.observeAuthoritativeEvents([attack("hit-1", "mob", 8)], 100);
    expect(controller.attackJiggleRadians("mob", 100)).toBe(0);
    const approachSamples = [30, 75, 100, 134].map((elapsedMs) =>
      controller.attackJiggleRadians("mob", 100 + elapsedMs)
    );
    expect(approachSamples.every((sample) => sample === 0)).toBe(true);
    const peakRadians = 0;
    expect(controller.attackJiggleRadians(
      "mob",
      100 + ATTACK_STRIKE_APPROACH_DURATION_MS
    )).toBeCloseTo(peakRadians);
    expect([
      ATTACK_STRIKE_APPROACH_DURATION_MS,
      ATTACK_STRIKE_APPROACH_DURATION_MS + ATTACK_STRIKE_HOLD_DURATION_MS
    ].map((elapsedMs) => controller.attackJiggleRadians("mob", 100 + elapsedMs)))
      .toEqual([peakRadians, peakRadians]);
    const recoverySamples = [
      ATTACK_STRIKE_APPROACH_DURATION_MS + ATTACK_STRIKE_HOLD_DURATION_MS,
      ATTACK_STRIKE_APPROACH_DURATION_MS + ATTACK_STRIKE_HOLD_DURATION_MS + 70,
      ATTACK_STRIKE_APPROACH_DURATION_MS + ATTACK_STRIKE_HOLD_DURATION_MS +
        ATTACK_STRIKE_RETURN_DURATION_MS / 2,
      ATTACK_STRIKE_APPROACH_DURATION_MS + ATTACK_STRIKE_HOLD_DURATION_MS + 240,
      ATTACK_JIGGLE_DURATION_MS - 1
    ].map((elapsedMs) => controller.attackJiggleRadians("mob", 100 + elapsedMs));
    expect(recoverySamples.every((sample) => sample === 0)).toBe(true);
    expect(controller.attackJiggleRadians("mob", 100 + ATTACK_JIGGLE_DURATION_MS)).toBe(0);
    expect(controller.attackJiggleRadians(
      "mob",
      100 + ATTACK_STRIKE_APPROACH_DURATION_MS,
      true
    )).toBe(0);
    expect(controller.poseFor(
      "mob",
      ready,
      100 + PLAYER_ATTACK_ACTION_WINDOW_MS
    )).toBe("combat_ready");
  });

  it("keeps the shared strike envelope directional, bounded, and motion-safe", () => {
    const peakMs = ATTACK_STRIKE_APPROACH_DURATION_MS;
    const holdEndMs = peakMs + ATTACK_STRIKE_HOLD_DURATION_MS;
    expect(attackStrikeProgress(peakMs)).toBe(1);
    expect(attackStrikeProgress(holdEndMs)).toBe(1);
    expect(attackStrikeProgress(holdEndMs + 1))
      .toBeLessThan(attackStrikeProgress(holdEndMs));
    expect(attackJiggleRotationRadians(peakMs))
      .toBeCloseTo(-ATTACK_STRIKE_MAX_ROTATION_DEGREES * Math.PI / 180);
    expect(attackJiggleRotationRadians(holdEndMs + 1)).toBe(0);
    expect(attackJiggleRotationRadians(Number.NaN)).toBe(0);
    expect(attackJiggleRotationRadians(100, true)).toBe(0);
  });

  it("uses a smooth monotonic strike envelope with zero-slope joins and endpoints", () => {
    const peakMs = ATTACK_STRIKE_APPROACH_DURATION_MS;
    const holdEndMs = peakMs + ATTACK_STRIKE_HOLD_DURATION_MS;
    const approach = [0, 30, 75, 100, 134, peakMs]
      .map((elapsedMs) => attackStrikeProgress(elapsedMs));
    const hold = [peakMs, peakMs + 1, holdEndMs - 1, holdEndMs]
      .map((elapsedMs) => attackStrikeProgress(elapsedMs));
    const recovery = [holdEndMs, 181, 225, 315, 449, ATTACK_JIGGLE_DURATION_MS]
      .map((elapsedMs) => attackStrikeProgress(elapsedMs));

    expect(approach[0]).toBe(0);
    expect(approach.at(-1)).toBe(1);
    expect(approach.slice(1).every((sample, index) => sample > approach[index]!)).toBe(true);
    expect(hold.every((sample) => sample === 1)).toBe(true);
    expect(recovery[0]).toBe(1);
    expect(recovery.at(-1)).toBe(0);
    expect(recovery.slice(1).every((sample, index) => sample < recovery[index]!)).toBe(true);
    expect(attackStrikeProgress(peakMs - 1)).toBeCloseTo(1, 3);
    expect(attackStrikeProgress(peakMs + 1)).toBeCloseTo(1, 3);
    expect(attackStrikeProgress(holdEndMs - 1)).toBe(1);
    expect(attackStrikeProgress(holdEndMs + 1)).toBeCloseTo(1, 3);
    expect(attackStrikeProgress(ATTACK_JIGGLE_DURATION_MS - 1)).toBeLessThan(0.001);
    expect(attackStrikeProgress(ATTACK_JIGGLE_DURATION_MS + 1)).toBe(0);
    expect(attackStrikeProgress(peakMs, true)).toBe(0);
    expect(attackStrikeProgress(ATTACK_JIGGLE_DURATION_MS - 1, true)).toBe(0);
  });

  it("lunges toward a known target and removes all motion for reduced motion", () => {
    expect(attackDirectionFromPoints({ x: 0, y: 0 }, { x: 3, y: 4 }))
      .toEqual({ x: 0.6, y: 0.8 });
    expect(attackDirectionFromPoints({ x: 10, y: 10 }, { x: 10, y: 10 })).toBeNull();

    const strike = attackStrikeMotion(
      ATTACK_STRIKE_APPROACH_DURATION_MS,
      { x: 1, y: 0 }
    );
    expect(strike.offsetX).toBeCloseTo(ATTACK_STRIKE_DISTANCE_PX);
    expect(strike.offsetY).toBe(0);
    expect(strike.rotationRadians).toBe(0);
    expect(attackStrikeMotion(
      ATTACK_STRIKE_APPROACH_DURATION_MS,
      { x: 1, y: 0 },
      true
    )).toEqual({ offsetX: 0, offsetY: 0, rotationRadians: 0 });
  });
});

function attack(
  eventId: string,
  sourceEntityId: string,
  tick: number
): CombatEvent {
  return {
    eventId,
    type: "ATTACK_LANDED",
    tick,
    sourceEntityId,
    targetEntityId: "mob"
  };
}

function player(
  entityId: string,
  engaged: boolean,
  activeWeaponCategory: WeaponCategory
): CombatEntitySnapshot {
  return {
    entityId,
    kind: "player",
    archetypeKey: null,
    name: entityId,
    level: 1,
    regionCode: "NM",
    zoneId: "world:NM",
    lat: 35,
    lon: -106,
    maxHealth: 100,
    currentHealth: 100,
    lifeState: "alive",
    activityState: engaged ? "attacking" : "idle",
    targetEntityId: engaged ? "mob" : null,
    revision: 1,
    weaponCombat: {
      activeWeaponSlot: activeWeaponCategory === "bow" ? "secondary" : "melee",
      activeWeaponInstanceId: "weapon",
      activeWeaponCategory,
      switchPolicy: activeWeaponCategory === "bow"
        ? "ranged_priority"
        : "melee_priority",
      switchingToSlot: null,
      switchStartedAtTick: null,
      switchCompletesAtTick: null
    }
  };
}

describe("arm swing playback requests", () => {
  it("starts on the press, on the aim side, with a new seq per swing", () => {
    const poses = new PlayerAppearancePoseController();
    expect(poses.swingPlaybackFor("p1")).toBeNull();
    poses.beginLocalSwing("p1", 1000, { x: -0.8, y: -0.6 });
    const first = poses.swingPlaybackFor("p1")!;
    expect(first).toMatchObject({ variant: "swing", side: "left", startedAtMs: 1000, cancelled: false });
    poses.beginLocalSwing("p1", 1300, { x: 0.9, y: 0.1 }, "finisher");
    const second = poses.swingPlaybackFor("p1")!;
    expect(second).toMatchObject({ variant: "finisher", side: "right", startedAtMs: 1300 });
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  it("a dash cancels the playback request of that swing only", () => {
    const poses = new PlayerAppearancePoseController();
    poses.beginLocalSwing("p1", 0, { x: 1, y: 0 });
    const seq = poses.swingPlaybackFor("p1")!.seq;
    poses.cancelLocalSwing("p1");
    expect(poses.swingPlaybackFor("p1")).toMatchObject({ seq, cancelled: true });
    poses.beginLocalSwing("p1", 50, { x: 1, y: 0 });
    expect(poses.swingPlaybackFor("p1")).toMatchObject({ cancelled: false });
  });
});
