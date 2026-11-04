import { describe, expect, it } from "vitest";

import {
  clientMessageSchema,
  partyCombatDeltaSchema,
  partyCombatSnapshotSchema,
  partyReadyCheckSnapshotSchema,
  partyServerMessageSchema,
  partySnapshotSchema
} from "./protocol.js";
import { parseChatChannelKey } from "./chat.js";

const requestId = "00000000-0000-4000-8000-000000000001";

describe("party protocol", () => {
  it.each([
    { type: "CREATE_PARTY", requestId },
    { type: "INVITE_TO_PARTY", requestId, targetPlayerId: "player-b" },
    { type: "DISBAND_PARTY", requestId },
    { type: "REQUEST_PARTY_COMBAT_SNAPSHOT", requestId },
    { type: "START_PARTY_READY_CHECK", requestId },
    {
      type: "RESPOND_PARTY_READY_CHECK",
      requestId,
      readyCheckId: requestId,
      response: "ready"
    },
    { type: "CANCEL_PARTY_READY_CHECK", requestId, readyCheckId: requestId },
    { type: "ADD_PARTY_MEMBER", requestId, targetPlayerId: "player-b" },
    { type: "REMOVE_PARTY_MEMBER", requestId, targetPlayerId: "player-b" },
    { type: "LEAVE_PARTY", requestId },
    { type: "CHANGE_PARTY_LEADER", requestId, targetPlayerId: "player-b" },
    { type: "SET_PARTY_TRAVEL_ALLOWED", requestId, allowed: true },
    { type: "SET_PARTY_AUTO_FOLLOW", requestId, enabled: true },
    { type: "TRAVEL_TO_PARTY_LEADER", requestId },
    { type: "ACCEPT_PARTY_INVITE", requestId, partyId: "party:one" },
    { type: "FORWARD_PARTY_INVITE", requestId, invitationId: requestId },
    { type: "DECLINE_PARTY_INVITE", requestId, partyId: "party:one" },
    { type: "CANCEL_PARTY_INVITE", requestId, invitationId: "00000000-0000-4000-8000-000000000001" }
  ])("accepts strict authenticated $type intent", (message) => {
    expect(clientMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects client-selected party identity and leadership claims", () => {
    expect(clientMessageSchema.safeParse({
      type: "CREATE_PARTY",
      requestId,
      partyId: "client-party"
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "ADD_PARTY_MEMBER",
      requestId,
      targetPlayerId: "player-b",
      leaderPlayerId: "player-a"
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "TRAVEL_TO_PARTY_LEADER",
      requestId,
      expectedTollGold: "7"
    }).success).toBe(false);
  });

  it("validates authoritative ordered snapshots and nullable membership responses", () => {
    const party = {
      partyId: "party:one",
      leaderPlayerId: "player-a",
      memberPlayerIds: ["player-a", "player-b"],
      allowTravel: true,
      autoFollowPlayerIds: ["player-b"],
      revision: 2
    };
    expect(partySnapshotSchema.parse(party)).toEqual(party);
    expect(partyServerMessageSchema.parse({
      type: "PARTY_SNAPSHOT",
      requestId,
      party,
      invites: [],
      outgoingInvites: []
    })).toMatchObject({ party, invites: [], outgoingInvites: [] });
    expect(partyServerMessageSchema.parse({
      type: "PARTY_SNAPSHOT",
      party: null,
      invites: [],
      outgoingInvites: []
    })).toEqual({ type: "PARTY_SNAPSHOT", party: null, invites: [], inboxInvites: [], outgoingInvites: [] });
  });

  it("requires stably sorted authoritative invitation snapshots", () => {
    const invite = (partyId: string, invitationId: string) => ({
      invitationId,
      partyId,
      leaderPlayerId: `leader:${partyId}`,
      inviterPlayerId: `leader:${partyId}`,
      targetPlayerId: "player-a",
      perspective: "incoming" as const,
      status: "pending" as const,
      createdAt: "2026-07-11T11:00:00.000Z",
      expiresAt: "2026-07-11T12:00:00.000Z",
      respondedAt: null,
      updatedAt: "2026-07-11T11:00:00.000Z"
    });
    expect(partyServerMessageSchema.parse({
      type: "PARTY_SNAPSHOT",
      party: null,
      invites: [
        invite("party:a", "00000000-0000-4000-8000-000000000001"),
        invite("party:b", "00000000-0000-4000-8000-000000000002")
      ],
      outgoingInvites: []
    }).invites).toHaveLength(2);
    expect(partyServerMessageSchema.safeParse({
      type: "PARTY_SNAPSHOT",
      party: null,
      invites: [
        invite("party:b", "00000000-0000-4000-8000-000000000002"),
        invite("party:a", "00000000-0000-4000-8000-000000000001")
      ],
      outgoingInvites: []
    }).success).toBe(false);
    expect(partyServerMessageSchema.safeParse({
      type: "PARTY_SNAPSHOT",
      party: null,
      outgoingInvites: []
    }).success).toBe(false);
  });

  it("rejects unordered, duplicate, and leaderless authoritative snapshots", () => {
    expect(partySnapshotSchema.safeParse({
      partyId: "party:one",
      leaderPlayerId: "player-a",
      memberPlayerIds: ["player-b", "player-a"],
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 1
    }).success).toBe(false);
    expect(partySnapshotSchema.safeParse({
      partyId: "party:one",
      leaderPlayerId: "player-a",
      memberPlayerIds: ["player-b", "player-b"],
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 1
    }).success).toBe(false);
    expect(partySnapshotSchema.safeParse({
      partyId: "party:one",
      leaderPlayerId: "player-a",
      memberPlayerIds: ["player-a", "player-b"],
      allowTravel: true,
      autoFollowPlayerIds: ["not-a-member"],
      revision: 1
    }).success).toBe(false);
  });

  it("validates stable party slots independently of the sorted legacy member list", () => {
    const party = {
      partyId: "party:one",
      leaderPlayerId: "player-b",
      memberPlayerIds: ["player-a", "player-b"],
      memberSlots: [
        { playerId: "player-b", slotIndex: 0 },
        { playerId: "player-a", slotIndex: 1 }
      ],
      membershipRevision: 2,
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 3
    };
    expect(partySnapshotSchema.parse(party)).toEqual(party);
    expect(partySnapshotSchema.safeParse({
      ...party,
      memberSlots: [
        { playerId: "player-b", slotIndex: 0 },
        { playerId: "player-a", slotIndex: 0 }
      ]
    }).success).toBe(false);
  });

  it("validates full and dirty-field party combat projections", () => {
    const member = {
      playerId: "player-a",
      slotIndex: 0,
      displayName: "Ariadne",
      classId: "druid" as const,
      role: "healer" as const,
      currentHealth: 70,
      maxHealth: 100,
      ward: 8,
      downedUntil: null,
      lifeState: "alive" as const,
      presence: "online" as const,
      worldRelation: "same_layer" as const,
      distanceMeters: 12
    };
    expect(partyCombatSnapshotSchema.parse({
      type: "PARTY_COMBAT_SNAPSHOT",
      partyId: `party:${requestId}`,
      membershipRevision: 2,
      sequence: 1,
      serverTime: 10,
      members: [member]
    }).members[0]).toEqual(member);
    expect(partyCombatDeltaSchema.parse({
      type: "PARTY_COMBAT_DELTA",
      partyId: `party:${requestId}`,
      membershipRevision: 2,
      sequence: 2,
      serverTime: 11,
      members: [{ playerId: "player-a", currentHealth: 60 }]
    }).members[0]).toEqual({ playerId: "player-a", currentHealth: 60 });
    expect(partyCombatDeltaSchema.parse({
      type: "PARTY_COMBAT_DELTA",
      partyId: `party:${requestId}`,
      membershipRevision: 2,
      sequence: 3,
      serverTime: 12,
      members: [{ playerId: "player-a", ward: 4, downedUntil: 22_000 }]
    }).members[0]).toEqual({ playerId: "player-a", ward: 4, downedUntil: 22_000 });
    expect(partyCombatDeltaSchema.safeParse({
      type: "PARTY_COMBAT_DELTA",
      partyId: `party:${requestId}`,
      membershipRevision: 2,
      sequence: 2,
      serverTime: 11,
      members: [{ playerId: "player-a" }]
    }).success).toBe(false);
  });

  it("validates ready-check rosters and parses party-scoped chat keys", () => {
    const readyCheck = {
      readyCheckId: requestId,
      partyId: `party:${requestId}`,
      membershipRevision: 3,
      startedByPlayerId: "player-a",
      startedAt: 10,
      expiresAt: 30_010,
      status: "pending" as const,
      responses: [
        { playerId: "player-a", response: "ready" as const },
        { playerId: "player-b", response: "pending" as const }
      ]
    };
    expect(partyReadyCheckSnapshotSchema.parse(readyCheck)).toEqual(readyCheck);
    expect(parseChatChannelKey(`party:${requestId}`)).toEqual({
      key: `party:${requestId}`,
      category: "party",
      type: "party",
      scopeId: requestId
    });
  });
});
