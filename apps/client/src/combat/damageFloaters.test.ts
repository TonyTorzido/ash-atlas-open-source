import { describe, expect, it } from "vitest";

import type { CombatEvent } from "@ash-atlas/shared";
import {
  DAMAGE_FLOATER_LIFETIME_MS,
  combatEventsForAcceptedDelta,
  damageFloaterPresentation,
  DamageFloaterState,
  floatingFeedbackFamily,
  floatingFeedbackLabel,
  FloatingFeedbackState,
  rewardHudPresentation,
  rewardHudScreenPosition,
  MAX_ACTIVE_DAMAGE_FLOATERS,
  MAX_SEEN_DAMAGE_EVENT_IDS,
  FLOATING_FEEDBACK_VISIBLE_MS,
  REWARD_HUD_VISIBLE_MS
} from "./damageFloaters.js";

describe("DamageFloaterState", () => {
  it("does not forward events from ignored or gap-rejected deltas", () => {
    const events = [damage("one", "mob", 12)];
    expect(combatEventsForAcceptedDelta("ignored", events)).toEqual([]);
    expect(combatEventsForAcceptedDelta("gap", events)).toEqual([]);
    expect(combatEventsForAcceptedDelta("applied", events)).toBe(events);
  });

  it("accepts authoritative damage and healing once while ignoring duplicate and zero events", () => {
    const state = new DamageFloaterState();
    expect(state.enqueue([damage("one", "mob", 12)], 100)).toBe(1);
    expect(state.enqueue([
      damage("one", "mob", 12),
      damage("zero", "mob", 0),
      { ...damage("heal", "mob", 5), type: "HEAL" }
    ], 110)).toBe(1);
    expect(state.floaters()).toHaveLength(2);
  });

  it("stacks rapid hits with deterministic offsets", () => {
    const state = new DamageFloaterState();
    state.enqueue([damage("a", "mob", 3), damage("b", "mob", 4), damage("c", "mob", 5)], 0);
    expect(state.floaters().map((entry) => [entry.xOffsetPx, entry.startYOffsetPx])).toEqual([
      [-16, -12], [-16, -36], [-16, -60]
    ]);
  });

  it("honors authoritative same-tick packet presentation delays without delaying combat state", () => {
    const state = new FloatingFeedbackState();
    state.enqueueCombat([
      { ...damage("packet-1", "mob", 3), packetIndex: 1, packetCount: 3, presentationDelayMs: 0 },
      { ...damage("packet-2", "mob", 3), packetIndex: 2, packetCount: 3, presentationDelayMs: 100 },
      { ...damage("packet-3", "mob", 3), packetIndex: 3, packetCount: 3, presentationDelayMs: 200 }
    ], "player", 1_000);
    const floaters = state.floaters();
    expect(floaters.map(({ createdAtMs }) => createdAtMs)).toEqual([1_000, 1_100, 1_200]);
    expect(floaters.map((floater) => damageFloaterPresentation(floater, 1_000, false).alpha)).toEqual([1, 0, 0]);
    expect(floaters.map((floater) => damageFloaterPresentation(floater, 1_100, false).alpha)).toEqual([1, 1, 0]);
    expect(floaters.map((floater) => damageFloaterPresentation(floater, 1_200, false).alpha)).toEqual([1, 1, 1]);
  });

  it("stacks and deduplicates simultaneous authoritative feedback kinds", () => {
    const state = new FloatingFeedbackState();
    expect(state.enqueue([
      { eventId: "gold-1", targetEntityId: "player", kind: "gold", amount: 5 },
      { eventId: "xp-1", targetEntityId: "player", kind: "character_xp", amount: 20 },
      { eventId: "profession-1", targetEntityId: "player", kind: "profession_xp", amount: 125 }
    ], 0)).toBe(3);
    expect(state.enqueue([
      { eventId: "xp-1", targetEntityId: "player", kind: "character_xp", amount: 20 }
    ], 20)).toBe(0);
    expect(state.floaters().map(({ feedbackLane, startYOffsetPx }) => ({
      feedbackLane,
      startYOffsetPx
    }))).toEqual([
      { feedbackLane: 0, startYOffsetPx: -12 },
      { feedbackLane: 1, startYOffsetPx: -36 },
      { feedbackLane: 2, startYOffsetPx: -60 }
    ]);
    state.prune(REWARD_HUD_VISIBLE_MS - 1);
    expect(state.floaters()).toHaveLength(3);
    state.prune(REWARD_HUD_VISIBLE_MS);
    expect(state.floaters()).toHaveLength(0);
  });

  it("reuses a free lane without moving surviving feedback", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([
      { eventId: "gold-1", targetEntityId: "player", kind: "gold", amount: 5 }
    ], 0);
    state.enqueue([
      { eventId: "xp-1", targetEntityId: "player", kind: "character_xp", amount: 20 }
    ], 1_000);
    state.prune(REWARD_HUD_VISIBLE_MS);
    state.enqueue([
      { eventId: "resource-1", targetEntityId: "player", kind: "resource", amount: 1 }
    ], REWARD_HUD_VISIBLE_MS);

    expect(state.floaters().map(({ eventId, feedbackLane, startYOffsetPx }) => ({
      eventId,
      feedbackLane,
      startYOffsetPx
    }))).toEqual([
      { eventId: "xp-1", feedbackLane: 1, startYOffsetPx: -36 },
      { eventId: "resource-1", feedbackLane: 0, startYOffsetPx: -12 }
    ]);
  });

  it("bounds burst lanes and never moves an active XP popup vertically", () => {
    const state = new FloatingFeedbackState();
    state.enqueue(Array.from({ length: 10 }, (_, index) => ({
      eventId: `older-${index}`,
      targetEntityId: "player",
      kind: "damage_taken" as const,
      amount: index + 1
    })), 0);
    state.enqueue([{
      eventId: "warrior-xp",
      targetEntityId: "player",
      kind: "class_xp",
      amount: 4,
      label: "+4 Warrior XP"
    }], 1_000);

    const warriorXp = state.floaters().at(-1)!;
    expect(warriorXp).toMatchObject({
      feedbackLane: 0,
      startYOffsetPx: -12
    });
    expect(Math.max(...state.floaters().map(({ feedbackLane }) => feedbackLane))).toBe(4);
    const beforePrune = damageFloaterPresentation(
      warriorXp,
      FLOATING_FEEDBACK_VISIBLE_MS,
      false
    );
    state.prune(FLOATING_FEEDBACK_VISIBLE_MS);
    expect(state.floaters()).toHaveLength(1);
    const survivingWarriorXp = state.floaters()[0]!;
    expect(survivingWarriorXp).toMatchObject({
      eventId: "warrior-xp",
      feedbackLane: 0,
      startYOffsetPx: -12
    });
    const afterPrune = damageFloaterPresentation(
      survivingWarriorXp,
      FLOATING_FEEDBACK_VISIBLE_MS,
      false
    );
    expect(afterPrune.yOffsetPx).toBeCloseTo(beforePrune.yOffsetPx);
  });

  it("keeps reward ordering independent from damage, healing, and costs", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([
      { eventId: "damage-1", targetEntityId: "player", kind: "damage_taken", amount: 4 },
      { eventId: "heal-1", targetEntityId: "player", kind: "healing", amount: 3 },
      { eventId: "spent-1", targetEntityId: "player", kind: "resource_spent", amount: 1 },
      { eventId: "gold-1", targetEntityId: "player", kind: "gold", amount: 5 }
    ], 0);

    expect(state.floaters().map(({ kind, feedbackLane, startYOffsetPx }) => ({
      kind,
      feedbackLane,
      startYOffsetPx
    }))).toEqual([
      { kind: "damage_taken", feedbackLane: 0, startYOffsetPx: -12 },
      { kind: "healing", feedbackLane: 1, startYOffsetPx: -36 },
      { kind: "resource_spent", feedbackLane: 2, startYOffsetPx: -60 },
      { kind: "gold", feedbackLane: 0, startYOffsetPx: -12 }
    ]);
    expect(state.floaters()[1]).toMatchObject({
      xOffsetPx: -16,
      horizontalTravelPx: 32,
      risePx: 26,
      expiresAtMs: FLOATING_FEEDBACK_VISIBLE_MS
    });
    expect(state.floaters()[3]).toMatchObject({
      kind: "gold",
      expiresAtMs: REWARD_HUD_VISIBLE_MS
    });
  });

  it("orders mob rewards as items, Gold, character XP, then class XP", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([
      { eventId: "item-1", targetEntityId: "player", kind: "resource", amount: 2 },
      { eventId: "item-2", targetEntityId: "player", kind: "resource", amount: 1 },
      { eventId: "gold-1", targetEntityId: "player", kind: "gold", amount: 10 },
      { eventId: "xp-1", targetEntityId: "player", kind: "character_xp", amount: 24 },
      { eventId: "class-1", targetEntityId: "player", kind: "class_xp", amount: 4 }
    ], 0);

    expect(state.floaters().map(({ kind, feedbackLane }) => ({ kind, feedbackLane }))).toEqual([
      { kind: "resource", feedbackLane: 0 },
      { kind: "resource", feedbackLane: 1 },
      { kind: "gold", feedbackLane: 2 },
      { kind: "character_xp", feedbackLane: 3 },
      { kind: "class_xp", feedbackLane: 4 }
    ]);
  });

  it("uses an awarded class label when supplied and a neutral fallback otherwise", () => {
    expect(floatingFeedbackLabel({
      eventId: "druid-xp",
      targetEntityId: "player",
      kind: "class_xp",
      amount: 476,
      label: "+476 Druid XP"
    })).toBe("+476 Druid XP");
    expect(floatingFeedbackLabel({
      eventId: "class-xp",
      targetEntityId: "player",
      kind: "class_xp",
      amount: 12
    })).toBe("+12 Class XP");
  });

  it("separates authoritative Opening Strike damage and execution feedback", () => {
    const state = new FloatingFeedbackState();
    state.enqueueCombat([
      { ...damage("damage", "mob", 110), sourceEntityId: "player", professionBonusAmount: 10 },
      { ...damage("opening", "mob", 10), type: "PROFESSION_OPENING_STRIKE", sourceEntityId: "player" },
      { ...damage("execute", "mob", 20), type: "PROFESSION_EXECUTED", sourceEntityId: "player" }
    ], "player", 0);
    expect(state.floaters().map(({ amount, label }) => [amount, label])).toEqual([
      [100, undefined], [10, "OPENING STRIKE +10"], [20, "EXECUTED"]
    ]);
  });

  it("explains a Gloom-blocked heal to the affected local player", () => {
    const state = new FloatingFeedbackState();
    expect(state.enqueueCombat([{
      eventId: "gloom-blocked-1",
      type: "HEAL_BLOCKED",
      tick: 1,
      sourceEntityId: "player",
      targetEntityId: "player",
      amount: 0,
      currentHealth: 50,
      harmfulStatusId: "gloom"
    }], "player", 0)).toBe(1);
    expect(state.floaters()[0]).toMatchObject({
      kind: "healing_blocked",
      label: "HEALING BLOCKED — WITHERED"
    });
  });

  it("maps every authoritative class innate trigger once", () => {
    const state = new FloatingFeedbackState();
    const feedback = ["FOCUS", "DODGE", "INVISIBLE"] as const;
    const events = feedback.map((innateFeedback, index): CombatEvent => ({
      eventId: `innate-${index}`,
      type: "CLASS_INNATE_TRIGGERED",
      tick: 4,
      sourceEntityId: "player",
      targetEntityId: index === 1 ? null : "player",
      innateFeedback
    }));
    expect(state.enqueueCombat(events, "player", 0)).toBe(3);
    expect(state.floaters().map(({ kind, label }) => [kind, label])).toEqual([
      ["class_innate", "FOCUS"],
      ["class_innate", "DODGE"],
      ["class_innate", "INVISIBLE"]
    ]);
    expect(state.enqueueCombat(events, "player", 1)).toBe(0);
  });

  it("times concurrent and later feedback independently without resetting existing entries", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([
      { eventId: "damage-1", targetEntityId: "mob", kind: "damage_dealt", amount: 5 },
      { eventId: "gold-1", targetEntityId: "player", kind: "gold", amount: 9 }
    ], 100);
    state.enqueue([
      { eventId: "class-xp-1", targetEntityId: "player", kind: "class_xp", amount: 12 }
    ], 1_100);

    expect(state.floaters().map(({ expiresAtMs }) => expiresAtMs)).toEqual([1_750, 2_300, 3_300]);
    state.prune(1_750);
    expect(state.floaters().map(({ eventId }) => eventId)).toEqual(["gold-1", "class-xp-1"]);
    state.prune(2_300);
    expect(state.floaters().map(({ eventId }) => eventId)).toEqual(["class-xp-1"]);
    state.prune(3_300);
    expect(state.floaters()).toHaveLength(0);
  });

  it("presents resin cost with its icon on the local player for the shared feedback lifetime", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([{
      eventId: "resin-spent:effect-1",
      targetEntityId: "player-1",
      kind: "resin_spent",
      amount: 1,
      icon: "balsam_resin"
    }], 100);

    const floater = state.floaters()[0]!;
    expect(floater).toMatchObject({
      targetEntityId: "player-1",
      kind: "resin_spent",
      icon: "balsam_resin",
      expiresAtMs: 100 + FLOATING_FEEDBACK_VISIBLE_MS
    });
    expect(floatingFeedbackLabel(floater)).toBe("-1");
    state.prune(100 + FLOATING_FEEDBACK_VISIBLE_MS);
    expect(state.floaters()).toHaveLength(0);
  });

  it("keeps animated and reduced-motion feedback visible until its early fade completes", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([
      { eventId: "resource-1", targetEntityId: "player", kind: "resource", amount: 1 }
    ], 0);
    const floater = state.floaters()[0]!;

    expect(rewardHudPresentation(floater, REWARD_HUD_VISIBLE_MS - 1, false).alpha).toBeGreaterThan(0);
    expect(rewardHudPresentation(floater, REWARD_HUD_VISIBLE_MS - 1, true).alpha).toBeGreaterThan(0);
    expect(floater.expiresAtMs).toBe(REWARD_HUD_VISIBLE_MS);
  });

  it("keeps incoming damage right of the head drifting outward (outgoing crosses left to right)", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([
      { eventId: "taken", targetEntityId: "player", kind: "damage_taken", amount: 1 },
      { eventId: "dealt", targetEntityId: "mob", kind: "damage_dealt", amount: 1 }
    ], 0);
    const [taken, dealt] = state.floaters();
    expect(damageFloaterPresentation(taken!, 0, false).xOffsetPx).toBe(30);
    expect(damageFloaterPresentation(taken!, FLOATING_FEEDBACK_VISIBLE_MS, false).xOffsetPx).toBe(46);
    expect(damageFloaterPresentation(dealt!, 0, false).xOffsetPx).toBe(-16);
    expect(damageFloaterPresentation(dealt!, FLOATING_FEEDBACK_VISIBLE_MS, false).xOffsetPx).toBe(16);
  });

  it("pops damage numbers in big and settles them, bigger for a finisher; DODGE pops straight up and leaves quickly", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([
      { eventId: "dealt", targetEntityId: "mob", kind: "damage_dealt", amount: 3 },
      { eventId: "big", targetEntityId: "mob2", kind: "damage_dealt", amount: 9, emphasis: "big" },
      { eventId: "dodge", targetEntityId: "player", kind: "class_innate", amount: 1, label: "DODGE" }
    ], 0);
    const [dealt, big, dodge] = state.floaters();
    expect(damageFloaterPresentation(dealt!, 0, false).scale).toBeGreaterThan(1.5);
    expect(damageFloaterPresentation(dealt!, 400, false).scale).toBe(1);
    expect(damageFloaterPresentation(big!, 0, false).scale).toBeGreaterThan(damageFloaterPresentation(dealt!, 0, false).scale);
    expect(damageFloaterPresentation(big!, 400, false).scale).toBeGreaterThan(1);
    expect(dodge!.expiresAtMs).toBeLessThan(dealt!.expiresAtMs);
    expect(damageFloaterPresentation(dodge!, 300, false).xOffsetPx).toBe(0);
    expect(damageFloaterPresentation(dodge!, 300, false).alpha).toBe(1);
    expect(damageFloaterPresentation(dodge!, dodge!.expiresAtMs - 1, false).alpha).toBeLessThan(0.05);
  });

  it("moves action feedback left to right through a jump arc before fading", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([
      { eventId: "damage-1", targetEntityId: "mob", kind: "damage_dealt", amount: 1 }
    ], 0);
    const floater = state.floaters()[0]!;
    const start = damageFloaterPresentation(floater, 0, false);
    const midpoint = damageFloaterPresentation(floater, DAMAGE_FLOATER_LIFETIME_MS / 2, false);
    const fadeStart = damageFloaterPresentation(
      floater,
      DAMAGE_FLOATER_LIFETIME_MS * 0.5,
      false
    );
    const fadeMidpoint = damageFloaterPresentation(
      floater,
      DAMAGE_FLOATER_LIFETIME_MS * 0.625,
      false
    );
    const finish = damageFloaterPresentation(floater, FLOATING_FEEDBACK_VISIBLE_MS, false);

    expect(start.xOffsetPx).toBe(-16);
    expect(midpoint.xOffsetPx).toBeGreaterThan(start.xOffsetPx);
    expect(finish.xOffsetPx).toBe(16);
    expect(midpoint.yOffsetPx).toBeLessThan(start.yOffsetPx);
    expect(midpoint.yOffsetPx).toBeLessThan(finish.yOffsetPx);
    expect(finish.yOffsetPx).toBeLessThan(start.yOffsetPx);
    expect(fadeStart.alpha).toBe(1);
    expect(fadeMidpoint.alpha).toBeCloseTo(0.5);
    expect(finish.alpha).toBe(0);
  });

  it("keeps the vertical path continuous through the top of the arc", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([{
      eventId: "damage-1",
      targetEntityId: "player",
      kind: "damage_taken",
      amount: 4
    }], 0);
    const floater = state.floaters()[0]!;
    const yPositions = Array.from({ length: 20 }, (_, index) =>
      damageFloaterPresentation(floater, 1_000 + index * 16, false).yOffsetPx
    );
    const frameDeltas = yPositions.slice(1).map((value, index) =>
      Math.abs(value - yPositions[index]!)
    );

    expect(Math.max(...frameDeltas)).toBeLessThan(1);
    expect(yPositions.indexOf(Math.min(...yPositions))).toBeGreaterThan(0);
    expect(yPositions.indexOf(Math.min(...yPositions))).toBeLessThan(yPositions.length - 1);
  });

  it("uses a quick overshoot, rebound, and smaller second bounce for non-damage action feedback", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([
      { eventId: "heal-1", targetEntityId: "player", kind: "healing", amount: 5 }
    ], 0);
    const floater = state.floaters()[0]!;

    expect(damageFloaterPresentation(floater, 0, false).scale).toBeCloseTo(0.78);
    expect(damageFloaterPresentation(
      floater,
      DAMAGE_FLOATER_LIFETIME_MS * 0.08,
      false
    ).scale).toBeCloseTo(1.18);
    expect(damageFloaterPresentation(
      floater,
      DAMAGE_FLOATER_LIFETIME_MS * 0.16,
      false
    ).scale).toBeCloseTo(0.96);
    expect(damageFloaterPresentation(
      floater,
      DAMAGE_FLOATER_LIFETIME_MS * 0.24,
      false
    ).scale).toBeCloseTo(1.05);
    expect(damageFloaterPresentation(
      floater,
      DAMAGE_FLOATER_LIFETIME_MS * 0.32,
      false
    ).scale).toBe(1);
  });

  it("settles reward HUD feedback subtly and suppresses motion when requested", () => {
    const state = new FloatingFeedbackState();
    state.enqueue([
      { eventId: "gold-1", targetEntityId: "player", kind: "gold", amount: 5 }
    ], 0);
    const floater = state.floaters()[0]!;
    const start = rewardHudPresentation(floater, 0, false);
    const settled = rewardHudPresentation(floater, REWARD_HUD_VISIBLE_MS * 0.1, false);
    const reducedStart = rewardHudPresentation(floater, 0, true);
    const nearFinish = rewardHudPresentation(
      floater,
      REWARD_HUD_VISIBLE_MS - 1,
      true
    );

    expect(start).toMatchObject({ xOffsetPx: -6, yOffsetPx: 4, scale: 0.92 });
    expect(settled).toMatchObject({ xOffsetPx: 0, yOffsetPx: 0, scale: 1 });
    expect(reducedStart).toMatchObject({ xOffsetPx: 0, yOffsetPx: 0, scale: 1 });
    expect(nearFinish.alpha).toBeGreaterThan(0);
    expect(nearFinish.alpha).toBeLessThan(settled.alpha);
  });

  it("classifies rewards separately from combat and action feedback", () => {
    expect(floatingFeedbackFamily("resource")).toBe("reward");
    expect(floatingFeedbackFamily("gold")).toBe("reward");
    expect(floatingFeedbackFamily("character_xp")).toBe("reward");
    expect(floatingFeedbackFamily("class_xp")).toBe("reward");
    expect(floatingFeedbackFamily("profession_xp")).toBe("reward");
    expect(floatingFeedbackFamily("damage_dealt")).toBe("action");
    expect(floatingFeedbackFamily("healing")).toBe("action");
    expect(floatingFeedbackFamily("resin_spent")).toBe("action");
  });

  it("centers the reward HUD on phones and keeps desktop rows inside the right edge", () => {
    expect(rewardHudScreenPosition({
      feedbackLane: 0,
      viewportWidth: 390,
      contentWidth: 170,
      firstRowBaselinePx: 76,
      phone: true
    })).toEqual({ x: 195, y: 76 });
    expect(rewardHudScreenPosition({
      feedbackLane: 4,
      viewportWidth: 390,
      contentWidth: 170,
      firstRowBaselinePx: 76,
      phone: true
    })).toEqual({ x: 195, y: 188 });
    expect(rewardHudScreenPosition({
      feedbackLane: 2,
      viewportWidth: 1_280,
      contentWidth: 180,
      firstRowBaselinePx: 158,
      phone: false
    })).toEqual({ x: 1_172, y: 214 });
  });

  it("expires floaters and removes disappeared targets", () => {
    const state = new DamageFloaterState();
    state.enqueue([damage("a", "mob", 3), damage("b", "player", 4)], 0);
    state.removeTargets(["player"]);
    expect(state.floaters().map((entry) => entry.targetEntityId)).toEqual(["mob"]);
    state.prune(FLOATING_FEEDBACK_VISIBLE_MS);
    expect(state.floaters()).toHaveLength(0);
  });

  it("bounds active floaters and remembered event IDs", () => {
    const state = new DamageFloaterState();
    const events = Array.from({ length: MAX_SEEN_DAMAGE_EVENT_IDS + 40 }, (_, index) =>
      damage(`event-${index}`, `target-${index}`, 1)
    );
    state.enqueue(events, 0);
    expect(state.floaters()).toHaveLength(MAX_ACTIVE_DAMAGE_FLOATERS);
    expect(state.seenEventCount()).toBe(MAX_SEEN_DAMAGE_EVENT_IDS);
  });
});

function damage(eventId: string, targetEntityId: string, amount: number): CombatEvent {
  return {
    eventId,
    type: "DAMAGE",
    tick: 1,
    sourceEntityId: "source",
    targetEntityId,
    amount,
    currentHealth: 10
  };
}
