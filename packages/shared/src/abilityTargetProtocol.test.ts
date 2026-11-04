import { describe, expect, it } from "vitest";

import {
  clientMessageSchema,
  useNormalAbilityMessageSchema,
  useResetAbilityMessageSchema
} from "./protocol.js";

const requestId = "00000000-0000-4000-8000-000000000001";

describe("explicit ability target protocol", () => {
  it("keeps legacy hostile-focus ability messages valid", () => {
    expect(useNormalAbilityMessageSchema.parse({
      type: "USE_NORMAL_ABILITY",
      requestId,
      abilityId: "warrior_cleave"
    })).toEqual({
      type: "USE_NORMAL_ABILITY",
      requestId,
      abilityId: "warrior_cleave"
    });
  });

  it("accepts explicit friendly and self targeting on either ability channel", () => {
    expect(clientMessageSchema.parse({
      type: "USE_NORMAL_ABILITY",
      requestId,
      abilityId: "v3_druid_replenish",
      targetEntityId: "player-ally",
      targetMode: "friendly"
    })).toMatchObject({ targetEntityId: "player-ally", targetMode: "friendly" });
    expect(useResetAbilityMessageSchema.parse({
      type: "USE_RESET_ABILITY",
      requestId,
      abilityId: "warrior_v2_iron_reversal",
      targetMode: "self"
    })).toMatchObject({ targetMode: "self" });
  });

  it("rejects unknown target modes, empty target IDs, and extra authority claims", () => {
    expect(useNormalAbilityMessageSchema.safeParse({
      type: "USE_NORMAL_ABILITY",
      requestId,
      abilityId: "v3_druid_replenish",
      targetMode: "kingdom_member"
    }).success).toBe(false);
    expect(useNormalAbilityMessageSchema.safeParse({
      type: "USE_NORMAL_ABILITY",
      requestId,
      abilityId: "v3_druid_replenish",
      targetEntityId: ""
    }).success).toBe(false);
    expect(useNormalAbilityMessageSchema.safeParse({
      type: "USE_NORMAL_ABILITY",
      requestId,
      abilityId: "v3_druid_replenish",
      targetMode: "friendly",
      partyId: "client-selected-party"
    }).success).toBe(false);
  });
});
