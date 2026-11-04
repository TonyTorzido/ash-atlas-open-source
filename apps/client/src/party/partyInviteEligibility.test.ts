import { describe, expect, it } from "vitest";

import {
  partyInviteAvailability,
  type PartyInviteContext
} from "./partyInviteEligibility.js";

const INVITER_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-07-18T00:00:00.000Z");

describe("partyInviteAvailability", () => {
  it.each([
    ["no permission", context({
      party: party({ leaderPlayerId: "00000000-0000-4000-8000-000000000099" })
    }), "You do not have permission to invite party members."],
    ["already a member", context({
      party: party({ memberPlayerIds: [INVITER_ID, TARGET_ID] })
    }), "This player is already in your party."],
    ["full party", context({
      party: party({
        memberPlayerIds: [
          INVITER_ID,
          "00000000-0000-4000-8000-000000000003",
          "00000000-0000-4000-8000-000000000004",
          "00000000-0000-4000-8000-000000000005",
          "00000000-0000-4000-8000-000000000006"
        ]
      })
    }), "Your party is full."],
    ["pending invite", context({
      outgoingInvites: [{
        targetPlayerId: TARGET_ID,
        expiresAt: "2026-07-18T00:01:00.000Z"
      }]
    }), "Party invitation already pending."]
  ])("explains %s", (_label, inviteContext, reason) => {
    expect(partyInviteAvailability(inviteContext, TARGET_ID, relationship())).toEqual({
      available: false,
      reason
    });
  });

  it("allows an atomic create-and-invite while solo", () => {
    expect(partyInviteAvailability(
      context({ party: null }),
      TARGET_ID,
      relationship()
    )).toEqual({ available: true, reason: null });
  });

  it("blocks enemies and account blocks without leaking which account blocked", () => {
    expect(partyInviteAvailability(context(), TARGET_ID, relationship({
      enemyMarkedByViewer: true
    })).reason).toBe("You cannot invite an enemy to your party.");
    expect(partyInviteAvailability(context(), TARGET_ID, relationship({
      friendship: "unavailable"
    })).reason).toBe("Party invitation is unavailable.");
  });

  it("becomes available when the canonical relationship returns to neutral", () => {
    expect(partyInviteAvailability(context(), TARGET_ID, relationship({
      enemyMarkedByViewer: true
    })).available).toBe(false);
    expect(partyInviteAvailability(context(), TARGET_ID, relationship({
      enemyMarkedByViewer: false
    }))).toEqual({ available: true, reason: null });
  });

  it("allows eligible stable player IDs and re-enables expired invites", () => {
    const inviteContext = context({
      outgoingInvites: [{
        targetPlayerId: TARGET_ID,
        expiresAt: "2026-07-17T23:59:59.000Z"
      }]
    });
    expect(partyInviteAvailability(inviteContext, TARGET_ID, relationship())).toEqual({
      available: true,
      reason: null
    });
  });
});

function context(overrides: Partial<PartyInviteContext> = {}): PartyInviteContext {
  return {
    connected: true,
    inviterPlayerId: INVITER_ID,
    party: party(),
    outgoingInvites: [],
    now: NOW,
    ...overrides
  };
}

function party(overrides: Partial<NonNullable<PartyInviteContext["party"]>> = {}) {
  return {
    partyId: "party-1",
    leaderPlayerId: INVITER_ID,
    memberPlayerIds: [INVITER_ID],
    allowTravel: false,
    autoFollowPlayerIds: [],
    revision: 1,
    ...overrides
  };
}

function relationship(overrides: {
  friendship?: "none" | "unavailable";
  enemyMarkedByViewer?: boolean;
} = {}) {
  return {
    friendship: overrides.friendship ?? "none",
    enemyMarkedByViewer: overrides.enemyMarkedByViewer ?? false
  };
}
