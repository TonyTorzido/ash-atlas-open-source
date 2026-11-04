import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEAL_TARGET_SETTINGS,
  HEAL_TARGET_GROUPS,
  healTargetSettingsUpdateSchema,
  holyArcHealsPlayer,
  type HealTargetGroup,
  type HolyArcAllyRelation
} from "./healTargets.js";

const NONE: HolyArcAllyRelation = { party: false, friend: false, kingdom: false, city: false, enemy: false };
const RELATION_BY_GROUP: Record<HealTargetGroup, HolyArcAllyRelation> = {
  party: { ...NONE, party: true },
  friends: { ...NONE, friend: true },
  kingdom: { ...NONE, kingdom: true },
  city: { ...NONE, city: true },
  neutral: NONE
};
const only = (group: HealTargetGroup) =>
  Object.fromEntries(HEAL_TARGET_GROUPS.map((candidate) => [candidate, candidate === group])) as Record<HealTargetGroup, boolean>;

describe("holy arc heal targets", () => {
  it("defaults to party, friends, kingdom and city on, neutral off", () => {
    expect(DEFAULT_HEAL_TARGET_SETTINGS).toEqual({ party: true, friends: true, kingdom: true, city: true, neutral: false });
    expect(holyArcHealsPlayer(NONE, DEFAULT_HEAL_TARGET_SETTINGS)).toBe(false);
    for (const group of ["party", "friends", "kingdom", "city"] as const) {
      expect(holyArcHealsPlayer(RELATION_BY_GROUP[group], DEFAULT_HEAL_TARGET_SETTINGS), group).toBe(true);
    }
  });

  it("each checkbox alone heals exactly its own group", () => {
    for (const ticked of HEAL_TARGET_GROUPS) {
      for (const group of HEAL_TARGET_GROUPS) {
        expect(holyArcHealsPlayer(RELATION_BY_GROUP[group], only(ticked)), `${ticked} ticked, target ${group}`)
          .toBe(ticked === group);
      }
    }
  });

  it("matches any one ticked group of a player in several", () => {
    const kingdomFriend = { ...NONE, friend: true, kingdom: true };
    expect(holyArcHealsPlayer(kingdomFriend, only("kingdom"))).toBe(true);
    expect(holyArcHealsPlayer(kingdomFriend, only("friends"))).toBe(true);
    expect(holyArcHealsPlayer(kingdomFriend, only("city"))).toBe(false);
    // A kingdom member is not neutral, so neutral alone does not heal them.
    expect(holyArcHealsPlayer(kingdomFriend, only("neutral"))).toBe(false);
  });

  it("never heals an enemy, whatever is ticked", () => {
    const all = Object.fromEntries(HEAL_TARGET_GROUPS.map((group) => [group, true])) as Record<HealTargetGroup, boolean>;
    for (const group of HEAL_TARGET_GROUPS) {
      expect(holyArcHealsPlayer({ ...RELATION_BY_GROUP[group], enemy: true }, all), group).toBe(false);
    }
  });

  it("accepts partial updates of known groups only", () => {
    expect(healTargetSettingsUpdateSchema.safeParse({ neutral: true }).success).toBe(true);
    expect(healTargetSettingsUpdateSchema.safeParse({}).success).toBe(false);
    expect(healTargetSettingsUpdateSchema.safeParse({ pets: true }).success).toBe(false);
    expect(healTargetSettingsUpdateSchema.safeParse({ party: "yes" }).success).toBe(false);
  });
});
