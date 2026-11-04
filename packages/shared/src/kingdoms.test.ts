import { describe, expect, it } from "vitest";

import {
  KINGDOM_ADVANCEMENT_PROJECTS,
  KINGDOM_FOUNDING_BASE_REQUIREMENTS,
  KINGDOM_FOUNDING_CHANNEL_DURATION_MS,
  KINGDOM_LEVELS,
  KINGDOM_PERMISSIONS,
  canModerateKingdomRole,
  foundKingdomInputSchema,
  hasKingdomPermission,
  kingdomChatInputSchema,
  kingdomDonationInputSchema,
  kingdomFlagConversionInputSchema,
  kingdomFlagRemovalInputSchema,
  kingdomLevelForXp,
  unicodeLength
} from "./kingdoms.js";
import { KINGDOM_PERK_IDS, KINGDOM_PERK_LEVELS, KINGDOM_PERKS, kingdomPerksForLevel } from "./kingdomPerks.js";
import { parseClientMessage } from "./protocol.js";

describe("Kingdom foundation contracts", () => {
  it("keeps founding materials and the cancellable build channel centralized", () => {
    expect(KINGDOM_FOUNDING_BASE_REQUIREMENTS.cost).toEqual([
      { resourceType: "refined_oil", quantity: 1_150 },
      { resourceType: "wood", quantity: 450 },
      { resourceType: "stone", quantity: 550 },
      { resourceType: "iron", quantity: 425 }
    ]);
    expect(KINGDOM_FOUNDING_CHANNEL_DURATION_MS).toBe(15_000);
  });

  it("keeps nine centralized monotonic level definitions", () => {
    expect(KINGDOM_LEVELS).toHaveLength(9);
    for (let index = 1; index < KINGDOM_LEVELS.length; index += 1) {
      expect(KINGDOM_LEVELS[index]!.requiredLifetimeXp)
        .toBeGreaterThan(KINGDOM_LEVELS[index - 1]!.requiredLifetimeXp);
      expect(KINGDOM_LEVELS[index]!.memberCapacity)
        .toBeGreaterThanOrEqual(KINGDOM_LEVELS[index - 1]!.memberCapacity);
    }
    expect(KINGDOM_LEVELS.every((level) => !("territoryRadiusM" in level))).toBe(true);
    expect(kingdomLevelForXp(0).level).toBe(1);
    expect(kingdomLevelForXp(280_999).level).toBe(3);
    expect(kingdomLevelForXp(281_000).level).toBe(4);
    expect(kingdomLevelForXp(Number.MAX_SAFE_INTEGER).level).toBe(9);
  });

  it("offers four perks on each of levels 2-8 and none yet on 9", () => {
    for (const level of KINGDOM_PERK_LEVELS) {
      expect(kingdomPerksForLevel(level)).toHaveLength(level <= 8 ? 4 : 0);
    }
    expect(KINGDOM_PERK_IDS).toHaveLength(28);
    expect(KINGDOM_PERKS.boundary_writ).toMatchObject({ level: 2, attackBonus: 2, defenseBonus: 2 });
    expect(KINGDOM_PERK_IDS.filter((id) => KINGDOM_PERKS[id].activated))
      .toEqual(["the_spearhead", "the_watchfires", "caravan_guild"]);
    expect(KINGDOM_ADVANCEMENT_PROJECTS[6].baseConstructionSeconds).toBe(2 * KINGDOM_ADVANCEMENT_PROJECTS[5].baseConstructionSeconds);
  });

  it("centralizes fixed-cost next-level advancement projects", () => {
    expect(KINGDOM_ADVANCEMENT_PROJECTS[2]).toMatchObject({
      displayName: "Raise the Standard",
      baseConstructionSeconds: 600,
      cost: [
        { resourceType: "wood", quantity: 150 },
        { resourceType: "stone", quantity: 100 },
        { resourceType: "leather", quantity: 50 }
      ]
    });
    expect(KINGDOM_ADVANCEMENT_PROJECTS[5]).toMatchObject({
      displayName: "Crown the Realm",
      baseConstructionSeconds: 3_600
    });
  });

  it("centralizes role authority without giving officers leader-only powers", () => {
    for (const permission of KINGDOM_PERMISSIONS) {
      expect(hasKingdomPermission("leader", permission)).toBe(true);
    }
    expect(hasKingdomPermission("officer", "invite_members")).toBe(true);
    expect(hasKingdomPermission("officer", "transfer_leadership")).toBe(false);
    expect(hasKingdomPermission("member", "remove_members")).toBe(false);
    expect(hasKingdomPermission("member", "contribute_kingdom_flags")).toBe(true);
    expect(hasKingdomPermission("member", "manage_kingdom_flags")).toBe(false);
    expect(hasKingdomPermission("officer", "manage_kingdom_flags")).toBe(true);
    expect(hasKingdomPermission("officer", "release_kingdom_flags")).toBe(true);
    expect(hasKingdomPermission("officer", "destroy_kingdom_flags")).toBe(false);
    expect(hasKingdomPermission("leader", "destroy_kingdom_flags")).toBe(true);
  });

  it("centralizes the moderation hierarchy", () => {
    expect(canModerateKingdomRole("leader", "officer", false)).toBe(true);
    expect(canModerateKingdomRole("officer", "member", false)).toBe(true);
    expect(canModerateKingdomRole("officer", "officer", false)).toBe(false);
    expect(canModerateKingdomRole("leader", "member", true)).toBe(false);
  });

  it("counts Unicode code points consistently", () => {
    expect(unicodeLength("A😀𐐷")).toBe(3);
    expect(() => kingdomChatInputSchema.parse({
      type: "KINGDOM_CHAT_SEND", requestId: "emoji", content: "😀".repeat(501)
    })).toThrow();
  });

  it("founding identity has no client coordinate or authority fields", () => {
    const valid = {
      requestId: "found-1",
      displayName: "Silver March",
      description: "A social kingdom",
      emblemKey: "silver-tree"
    };
    expect(foundKingdomInputSchema.parse(valid)).toEqual(valid);
    expect(() => foundKingdomInputSchema.parse({ ...valid, lat: 1, lon: 2 })).toThrow();
    expect(() => foundKingdomInputSchema.parse({ ...valid, freeConstruction: true })).toThrow();
    expect(() => foundKingdomInputSchema.parse({ ...valid, terrainClass: "mountain" })).toThrow();
  });

  it("validates donations and strict chat messages", () => {
    expect(kingdomDonationInputSchema.parse({ requestId: "d1", resourceType: "wood", quantity: 2 }))
      .toMatchObject({ quantity: 2 });
    expect(() => kingdomDonationInputSchema.parse({ requestId: "d1", resourceType: "gold", quantity: 2 }))
      .toThrow();
    expect(kingdomChatInputSchema.parse({ type: "KINGDOM_CHAT_SEND", requestId: "c1", content: "hello" }))
      .toMatchObject({ content: "hello" });
    expect(parseClientMessage(JSON.stringify({
      type: "REQUEST_KINGDOM_STATE",
      requestId: "state-1"
    }))).toMatchObject({ type: "REQUEST_KINGDOM_STATE" });
  });

  it("keeps Kingdom Flag mutation authority inputs free of Kingdom ids and geometry", () => {
    const flagId = "00000000-0000-4000-8000-000000000012";
    expect(kingdomFlagConversionInputSchema.parse({ requestId: "convert-1", flagId }))
      .toEqual({ requestId: "convert-1", flagId });
    expect(kingdomFlagRemovalInputSchema.parse({
      requestId: "remove-1", flagId, expectedNetworkRevision: "42"
    })).toMatchObject({ expectedNetworkRevision: "42" });
    expect(() => kingdomFlagConversionInputSchema.parse({
      requestId: "forged", flagId, kingdomId: "00000000-0000-4000-8000-000000000099"
    })).toThrow();
    expect(() => kingdomFlagRemovalInputSchema.parse({
      requestId: "stale", flagId, expectedNetworkRevision: "not-a-revision"
    })).toThrow();
  });
});
