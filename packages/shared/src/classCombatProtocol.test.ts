import { describe, expect, it } from "vitest";

import { universalTauntRadiusM } from "./combat.js";
import { clientMessageSchema } from "./protocol.js";

const requestId = "00000000-0000-4000-8000-000000000001";

describe("simplified class combat protocol", () => {
  it("accepts only intent for normal, reset, and universal Taunt actions", () => {
    expect(clientMessageSchema.parse({
      type: "USE_NORMAL_ABILITY",
      requestId,
      abilityId: "warrior_cleave"
    })).toMatchObject({ type: "USE_NORMAL_ABILITY" });
    expect(clientMessageSchema.parse({
      type: "USE_RESET_ABILITY",
      requestId,
      abilityId: "warrior_punishing_strike"
    })).toMatchObject({ type: "USE_RESET_ABILITY" });
    expect(clientMessageSchema.parse({
      type: "USE_UNIVERSAL_TAUNT",
      requestId
    })).toMatchObject({ type: "USE_UNIVERSAL_TAUNT" });

    for (const forged of [
      { type: "USE_UNIVERSAL_TAUNT", requestId, playerId: "victim" },
      { type: "USE_UNIVERSAL_TAUNT", requestId, targetIds: ["mob-1"] },
      { type: "USE_UNIVERSAL_TAUNT", requestId, radiusM: 10_000 },
      { type: "USE_RESET_ABILITY", requestId, abilityId: "warrior_punishing_strike", resetWindowAt: 123 },
      { type: "USE_NORMAL_ABILITY", requestId, abilityId: "warrior_cleave", rage: 100 }
    ]) expect(clientMessageSchema.safeParse(forged).success).toBe(false);
  });

  it("accepts dedicated ultimate intent and strict drag coordinates", () => {
    expect(clientMessageSchema.parse({
      type: "USE_ULTIMATE_ABILITY", requestId, abilityId: "ranger_v2_black_rain",
      targetPosition: { lat: 35.1, lon: -106.6 }
    })).toMatchObject({ type: "USE_ULTIMATE_ABILITY" });
    expect(clientMessageSchema.parse({
      type: "USE_NORMAL_ABILITY", requestId, abilityId: "ninja_v2_shadowstep",
      targetPosition: { lat: 35.1, lon: -106.6 }
    })).toMatchObject({ type: "USE_NORMAL_ABILITY" });
    for (const invalidPosition of [
      { lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: 0, lon: 0, altitude: 1 }
    ]) expect(clientMessageSchema.safeParse({
      type: "USE_ULTIMATE_ABILITY", requestId, abilityId: "ranger_v2_black_rain",
      targetPosition: invalidPosition
    }).success).toBe(false);
  });

  it("derives universal Taunt range as half the authoritative active-circle radius", () => {
    expect(universalTauntRadiusM(150)).toBe(75);
    expect(universalTauntRadiusM(321.5)).toBe(160.75);
  });

  it("removes the old learning and generic ability-queue commands", () => {
    for (const obsolete of [
      { type: "LEARN_CLASS_TECHNIQUE", requestId, techniqueId: "warrior_second_wind" },
      { type: "QUEUE_CLASS_ABILITY", requestId, abilityId: "warrior_second_wind", targetEntityId: "mob-1" },
      { type: "CANCEL_CLASS_ABILITY", requestId }
    ]) expect(clientMessageSchema.safeParse(obsolete).success).toBe(false);
  });

  it("keeps development progression and subclass mutations self-only and strict", () => {
    expect(clientMessageSchema.safeParse({
      type: "ADJUST_OWN_DEV_PROGRESSION",
      operationId: requestId,
      progressionType: "warrior_level",
      targetRank: 0
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "SET_OWN_DEV_SUBCLASS_UNLOCK",
      operationId: requestId,
      subclassId: "reaver",
      unlocked: true,
      playerId: "victim"
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "ADJUST_OWN_DEV_PROGRESSION",
      operationId: requestId,
      progressionType: "reaver_mastery",
      targetRank: 1
    }).success).toBe(false);
  });
});
