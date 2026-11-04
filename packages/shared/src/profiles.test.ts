import { describe, expect, it } from "vitest";

import {
  publicProfileSchema,
  recentPlayersQuerySchema,
  recentPlayersResponseSchema,
  socialInboxResponseSchema,
  socialListQuerySchema,
  socialMutationRequestSchema
} from "./profiles.js";

describe("profile protocol schemas", () => {
  it("validates stable social inbox identities and authoritative pending counts", () => {
    expect(socialInboxResponseSchema.parse({
      entries: [{
        id: "00000000-0000-4000-8000-000000000001",
        kind: "friend_request",
        actorPlayerId: "stable-player-id",
        actorDisplayName: "Current Name",
        state: "pending",
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z"
      }],
      pendingIncomingFriendRequestCount: 1
    }).pendingIncomingFriendRequestCount).toBe(1);
  });

  it("rejects forged acting identity and unsupported profile fields", () => {
    expect(socialMutationRequestSchema.safeParse({
      targetPlayerId: "00000000-0000-4000-8000-000000000001",
      action: "block",
      actingPlayerId: "forged"
    }).success).toBe(false);
  });

  it("rejects unsupported social actions and invalid pagination", () => {
    expect(socialMutationRequestSchema.safeParse({
      targetPlayerId: "00000000-0000-4000-8000-000000000001",
      action: "follow"
    }).success).toBe(false);
    expect(socialMutationRequestSchema.safeParse({
      targetPlayerId: "00000000-0000-4000-8000-000000000001",
      action: "unmark_enemy"
    }).success).toBe(false);
    for (const action of [
      "request_neutrality",
      "accept_neutrality",
      "reject_neutrality",
      "cancel_neutrality"
    ]) {
      expect(socialMutationRequestSchema.safeParse({
        targetPlayerId: "00000000-0000-4000-8000-000000000001",
        action
      }).success).toBe(true);
    }
    expect(socialListQuerySchema.safeParse({ limit: 51, offset: 0 }).success).toBe(false);
    expect(socialListQuerySchema.parse({})).toEqual({ limit: 25, offset: 0 });
  });

  it("shapes nullable future memberships without private account fields", () => {
    const parsed = publicProfileSchema.parse({
      playerId: "player-1",
      displayName: "Atlas",
      level: 4,
      portrait: { kind: "player_sprite", displayColor: null },
      title: null,
      biography: null,
      presence: "hidden",
      class: null,
      kingdom: null,
      settlement: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isSelf: false,
      relationship: { friendship: "none", enemyMarkedByViewer: false },
      futureAdditiveField: "ignored"
    });
    expect(parsed.class).toBeNull();
    expect(parsed).not.toHaveProperty("email");
    expect(parsed).not.toHaveProperty("lastSeenAt");
    expect(parsed).not.toHaveProperty("futureAdditiveField");
  });

  it("bounds Recent Players and excludes tracking fields from its strict response", () => {
    expect(recentPlayersQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(recentPlayersQuerySchema.safeParse({ limit: 31 }).success).toBe(false);
    const entry = {
      playerId: "player-2",
      displayName: "Nearby Player",
      portrait: { kind: "player_sprite", displayColor: null },
      presence: "hidden",
      relationship: { friendship: "none", enemyMarkedByViewer: false },
      interactionType: "nearby",
      interactionAt: new Date(0).toISOString()
    };
    expect(recentPlayersResponseSchema.parse({ entries: [entry] })).toEqual({ entries: [entry] });
    expect(recentPlayersResponseSchema.safeParse({
      entries: [{ ...entry, lat: 35, lon: -106, location: "hidden" }]
    }).success).toBe(false);
  });
});
