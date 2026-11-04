import { describe, expect, it } from "vitest";

import {
  InMemoryPartyAuthority,
  PartyAuthorityError,
  type PartyAuthority
} from "./PartyAuthority.js";

describe("InMemoryPartyAuthority", () => {
  it("creates leader-only parties with stable structural query access", () => {
    const mutable = new InMemoryPartyAuthority();
    const authority: PartyAuthority = mutable;

    expect(mutable.createParty("party-1", "player-c", "create-1")).toMatchObject({
      partyId: "party-1",
      leaderPlayerId: "player-c",
      memberPlayerIds: ["player-c"],
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 1
    });
    expect(authority.partyForPlayer("player-c")?.memberPlayerIds).toEqual(["player-c"]);
    expect(authority.sameParty("player-c", "unregistered-player")).toBe(false);
    expect(authority.partyForPlayer("unregistered-player")).toBeNull();
  });

  it("records invitations without enrolling targets and enrolls only on target acceptance", () => {
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots([
      party("party-a", "leader-a"),
      party("party-b", "leader-b")
    ]);

    authority.inviteMember("target", "leader-b", "invite-b");
    authority.inviteMember("target", "leader-a", "invite-a");

    expect(authority.partyForPlayer("target")).toBeNull();
    expect(authority.invitesForPlayer("target").map((invite) => invite.partyId))
      .toEqual(["party-a", "party-b"]);
    expect(authority.outgoingInvitesForParty("party-a")).toMatchObject([{
      targetPlayerId: "target"
    }]);

    expect(authority.acceptInvite("party-b", "target", "accept-b")).toMatchObject({
      partyId: "party-b",
      leaderPlayerId: "leader-b",
      memberPlayerIds: ["leader-b", "target"],
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 2
    });
    expect(authority.invitesForPlayer("target")).toEqual([]);
    expect(authority.partyForPlayer("target")?.partyId).toBe("party-b");
  });

  it("forwards a member's invitation to their leader and atomically merges a two-player party into three", () => {
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots([
      party("party-three", "leader-three", "member-a", "member-b"),
      party("party-two", "leader-two", "member-c")
    ]);

    const invite = authority.inviteMember("member-c", "leader-three", "invite-merge");
    expect(() => authority.acceptInvite(invite.invitationId, "member-c", "member-c-accept"))
      .toThrowError(expect.objectContaining({ code: "PARTY_TARGET_NOT_LEADER" }));

    const forwarded = authority.forwardInvite(invite.invitationId, "member-c", "forward-merge");
    expect(forwarded.targetPlayerId).toBe("leader-two");
    expect(authority.invitesForPlayer("member-c")).toEqual([]);
    expect(authority.invitesForPlayer("leader-two")).toEqual([
      expect.objectContaining({ invitationId: invite.invitationId })
    ]);

    const merged = authority.acceptInvite(invite.invitationId, "leader-two", "accept-merge");
    expect(merged).toMatchObject({
      partyId: "party-three",
      leaderPlayerId: "leader-three",
      memberPlayerIds: ["leader-three", "leader-two", "member-a", "member-b", "member-c"],
      revision: 2
    });
    expect(authority.party("party-two")).toBeNull();
    expect(authority.partyForPlayer("member-c")?.partyId).toBe("party-three");
  });

  it("reports no space before inviting or accepting a merge that would exceed five members", () => {
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots([
      party("party-three", "leader-three", "member-a", "member-b"),
      party("party-too-large", "leader-large", "member-c", "member-d")
    ]);
    expect(() => authority.inviteMember("member-c", "leader-three", "invite-no-space"))
      .toThrowError(expect.objectContaining({
        code: "PARTY_FULL",
        message: "No space. The combined party would exceed five members."
      }));

    authority.replacePartySnapshot(
      "party-too-large",
      party("party-too-large", "leader-large", "member-c")
    );
    const invite = authority.inviteMember("leader-large", "leader-three", "invite-fits-now");
    authority.replacePartySnapshot(
      "party-three",
      party("party-three", "leader-three", "member-a", "member-b", "member-extra")
    );
    expect(() => authority.acceptInvite(invite.invitationId, "leader-large", "accept-no-space"))
      .toThrowError(expect.objectContaining({
        code: "PARTY_FULL",
        message: "No space. The combined party would exceed five members."
      }));
    expect(authority.partyForPlayer("leader-large")?.partyId).toBe("party-too-large");
  });

  it("enforces party capacity when inviting and when a pending invite is accepted", () => {
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots([party("party-a", "leader", "member-a", "member-b", "member-c")]);
    authority.inviteMember("target", "leader", "invite");
    authority.replacePartySnapshot("party-a", party(
      "party-a",
      "leader",
      "member-a",
      "member-b",
      "member-c",
      "member-d"
    ));

    expect(() => authority.inviteMember("another", "leader", "invite-full")).toThrowError(
      expect.objectContaining({ code: "PARTY_FULL", message: "Your party is full." })
    );
    expect(() => authority.acceptInvite("party-a", "target", "accept-full")).toThrowError(
      expect.objectContaining({ code: "PARTY_FULL", message: "The party is full." })
    );
  });

  it("blocks invitations and acceptance while the canonical pair is enemies", () => {
    const enemyPairs = new Set(["leader\u001ftarget"]);
    const authority = new InMemoryPartyAuthority((left, right) =>
      enemyPairs.has([left, right].sort().join("\u001f"))
    );
    authority.loadSnapshots([party("party-a", "leader")]);
    expect(() => authority.inviteMember("target", "leader", "invite-enemy")).toThrowError(
      expect.objectContaining({
        code: "PARTY_TARGET_ENEMY",
        message: "You cannot invite an enemy to your party."
      })
    );

    enemyPairs.clear();
    authority.inviteMember("target", "leader", "invite-neutral");
    enemyPairs.add("leader\u001ftarget");
    expect(() => authority.acceptInvite("party-a", "target", "accept-enemy")).toThrowError(
      expect.objectContaining({ code: "PARTY_TARGET_ENEMY" })
    );
  });

  it("preserves bilateral block enforcement for party invitations", () => {
    const authority = new InMemoryPartyAuthority(
      () => false,
      (left, right) => [left, right].sort().join(":") === "leader:target"
    );
    authority.loadSnapshots([party("party-a", "leader")]);
    expect(() => authority.inviteMember("target", "leader", "invite-blocked")).toThrowError(
      expect.objectContaining({
        code: "PARTY_TARGET_BLOCKED",
        message: "Party invitation is unavailable."
      })
    );
  });

  it("supports target decline and rejects expired acceptance", () => {
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots([party("party-a", "leader-a")]);
    authority.inviteMember("target", "leader-a", "invite-a");
    expect(authority.declineInvite("party-a", "target", "decline-a")).toBe(true);
    expect(authority.partyForPlayer("target")).toBeNull();

    authority.loadInvites([{
      partyId: "party-a",
      leaderPlayerId: "leader-a",
      inviterPlayerId: "leader-a",
      targetPlayerId: "target",
      expiresAt: new Date(Date.now() - 1).toISOString()
    }]);
    expect(authority.invitesForPlayer("target")).toEqual([]);
    expect(() => authority.acceptInvite("party-a", "target", "accept-expired")).toThrowError(
      expect.objectContaining({ code: "PARTY_INVITE_EXPIRED" })
    );
    expect(authority.inboxInvitesForPlayer("target")).toEqual([
      expect.objectContaining({ partyId: "party-a", status: "expired" })
    ]);
  });

  it("retains distinct terminal receipts and safely replays accept and decline", () => {
    const acceptedAuthority = new InMemoryPartyAuthority();
    acceptedAuthority.loadSnapshots([party("party-a", "leader-a")]);
    const acceptedInvite = acceptedAuthority.inviteMember("accepted-target", "leader-a", "invite-a");
    const accepted = acceptedAuthority.acceptInvite(
      acceptedInvite.invitationId,
      "accepted-target",
      "accept-a"
    );
    expect(acceptedAuthority.acceptInvite(
      acceptedInvite.invitationId,
      "accepted-target",
      "accept-a"
    )).toEqual(accepted);
    expect(acceptedAuthority.inboxInvitesForPlayer("accepted-target")).toEqual([
      expect.objectContaining({
        invitationId: acceptedInvite.invitationId,
        status: "accepted"
      })
    ]);

    const declinedAuthority = new InMemoryPartyAuthority();
    declinedAuthority.loadSnapshots([party("party-a", "leader-a")]);
    const first = declinedAuthority.inviteMember("target", "leader-a", "invite-1");
    expect(declinedAuthority.declineInvite(first.invitationId, "target", "decline-1")).toBe(true);
    expect(declinedAuthority.declineInvite(first.invitationId, "target", "decline-1")).toBe(true);
    const second = declinedAuthority.inviteMember("target", "leader-a", "invite-2");
    expect(second.invitationId).not.toBe(first.invitationId);
    expect(declinedAuthority.inboxInvitesForPlayer("target")).toEqual(expect.arrayContaining([
      expect.objectContaining({ invitationId: first.invitationId, status: "declined" }),
      expect.objectContaining({ invitationId: second.invitationId, status: "pending" })
    ]));
  });

  it("clears stale invitations when a target creates a leader-only party", () => {
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots([party("party-a", "leader-a")]);
    authority.inviteMember("target", "leader-a", "invite-a");

    authority.createParty("party-target", "target", "create-target");

    expect(authority.invitesForPlayer("target")).toEqual([]);
    expect(authority.partyForPlayer("target")?.memberPlayerIds).toEqual(["target"]);
  });

  it("applies leadership, removal, and stable leader succession rules", () => {
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots([party("party-1", "player-z", "player-c", "player-a")]);

    expect(() => authority.removePartyMember("player-c", "player-a", "remove-denied"))
      .toThrowError(expect.objectContaining({ code: "PARTY_NOT_LEADER" }));
    expect(authority.changePartyLeader("player-c", "player-z", "leader-1").revision).toBe(2);
    expect(authority.removePartyMember("player-z", "player-c", "remove-1")).toMatchObject({
      partyId: "party-1",
      leaderPlayerId: "player-c",
      memberPlayerIds: ["player-a", "player-c"],
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 3
    });
    expect(authority.leaveParty("player-c", "leave-1")).toMatchObject({
      partyId: "party-1",
      leaderPlayerId: "player-a",
      memberPlayerIds: ["player-a"],
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 4
    });
    expect(authority.leaveParty("player-a", "leave-2")).toBeNull();
    expect(authority.party("party-1")).toBeNull();
  });

  it("keeps party travel opt-in, leader-controlled, and safe across leadership changes", () => {
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots([party("party-1", "leader", "member")]);

    expect(() => authority.setTravelAllowed("member", "allow-denied", true)).toThrowError(
      expect.objectContaining({ code: "PARTY_NOT_LEADER" })
    );
    expect(authority.setTravelAllowed("leader", "allow", true)).toMatchObject({
      allowTravel: true,
      autoFollowPlayerIds: []
    });
    expect(authority.setAutoFollow("member", "follow", true)).toMatchObject({
      allowTravel: true,
      autoFollowPlayerIds: ["member"]
    });
    expect(authority.changePartyLeader("member", "leader", "change")).toMatchObject({
      leaderPlayerId: "member",
      allowTravel: false,
      autoFollowPlayerIds: ["member"]
    });
    expect(authority.leaveParty("member", "leave")).toMatchObject({
      leaderPlayerId: "leader",
      allowTravel: false,
      autoFollowPlayerIds: []
    });
  });

  it("reserves request IDs before current-state authorization and detects payload conflicts", () => {
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots([party("party-1", "leader", "member-a", "member-b")]);

    authority.changePartyLeader("member-a", "leader", "change-1");
    expect(() => authority.changePartyLeader("member-a", "leader", "change-1")).toThrowError(
      expect.objectContaining({ code: "PARTY_REQUEST_DUPLICATE" })
    );
    expect(() => authority.changePartyLeader("member-b", "leader", "change-1")).toThrowError(
      expect.objectContaining({ code: "PARTY_OPERATION_CONFLICT" })
    );

    authority.leaveParty("member-b", "leave-1");
    expect(() => authority.leaveParty("member-b", "leave-1")).toThrowError(
      expect.objectContaining({ code: "PARTY_REQUEST_DUPLICATE" })
    );
    expect(() => authority.leaveParty("member-b", "leave-new")).toThrowError(
      expect.objectContaining({ code: "PARTY_NOT_FOUND" })
    );
  });

  it("keeps one authoritative party per player and failed mutations atomic", () => {
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots([party("party-1", "player-a", "player-b")]);

    expect(() => authority.createParty("party-2", "player-b", "create-conflict"))
      .toThrowError(PartyAuthorityError);
    expect(authority.party("party-2")).toBeNull();
    expect(authority.partyForPlayer("player-b")?.partyId).toBe("party-1");
    expect(() => authority.createParty("party-2", "player-c", "create-2")).not.toThrow();
  });

  it("atomically hydrates durable snapshots without inferring membership", () => {
    const authority = new InMemoryPartyAuthority();
    authority.createParty("old-party", "old-player", "create-old");
    authority.loadSnapshots([party("durable-party", "player-z", "player-a", 17)]);

    expect(authority.partyForPlayer("old-player")).toBeNull();
    expect(authority.partyForPlayer("player-a")).toMatchObject({
      partyId: "durable-party",
      leaderPlayerId: "player-z",
      memberPlayerIds: ["player-a", "player-z"],
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 17
    });
    expect(authority.partyForPlayer("same-kingdom-only")).toBeNull();

    expect(() => authority.loadSnapshots([{
      partyId: "invalid-party",
      leaderPlayerId: "missing-leader",
      memberPlayerIds: ["player-a"],
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 1
    }])).toThrowError(expect.objectContaining({ code: "PARTY_LEADER_NOT_MEMBER" }));
    expect(authority.partyForPlayer("player-a")?.partyId).toBe("durable-party");
  });

  it("replaces affected party and invite scopes without disturbing 10,000 cached parties", () => {
    const authority = new InMemoryPartyAuthority();
    authority.loadSnapshots(Array.from({ length: 10_000 }, (_, index) =>
      party(`party-${index}`, `leader-${index}`)
    ));
    authority.loadInvites([{
      partyId: "party-9999",
      leaderPlayerId: "leader-9999",
      inviterPlayerId: "leader-9999",
      targetPlayerId: "target",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }]);

    authority.replacePartySnapshot("party-9999", {
      ...party("party-9999", "leader-9999", "member-9999"),
      allowTravel: true,
      revision: 2
    });
    authority.replaceInvitesForPlayer("target", []);

    expect(authority.partyForPlayer("member-9999")).toMatchObject({
      partyId: "party-9999",
      allowTravel: true,
      revision: 2
    });
    expect(authority.partyForPlayer("leader-0")?.partyId).toBe("party-0");
    expect(authority.invitesForPlayer("target")).toEqual([]);
  });

  it("atomically creates a solo party and invitation with retry-safe identity", () => {
    const authority = new InMemoryPartyAuthority();

    const first = authority.inviteToParty("target", "solo", "atomic-invite");
    const replay = authority.inviteToParty("target", "solo", "atomic-invite");

    expect(replay).toEqual(first);
    expect(authority.partyForPlayer("solo")).toMatchObject({
      leaderPlayerId: "solo",
      memberPlayerIds: ["solo"],
      membershipRevision: 1,
      memberSlots: [{ playerId: "solo", slotIndex: 0 }]
    });
    expect(authority.partyForPlayer("target")).toBeNull();
  });

  it("keeps member slots stable and only advances membership revision for roster changes", () => {
    const authority = new InMemoryPartyAuthority();
    authority.createParty("party-slots", "leader", "create");
    authority.inviteMember("member-b", "leader", "invite-b");
    authority.acceptInvite("party-slots", "member-b", "accept-b");
    authority.inviteMember("member-c", "leader", "invite-c");
    authority.acceptInvite("party-slots", "member-c", "accept-c");
    const before = authority.partyForPlayer("leader")!;

    authority.setTravelAllowed("leader", "travel", true);
    expect(authority.partyForPlayer("leader")?.membershipRevision).toBe(before.membershipRevision);

    authority.removePartyMember("member-b", "leader", "remove-b");
    authority.inviteMember("member-d", "leader", "invite-d");
    const joined = authority.acceptInvite("party-slots", "member-d", "accept-d");

    expect(joined.memberSlots).toEqual([
      { playerId: "leader", slotIndex: 0 },
      { playerId: "member-d", slotIndex: 1 },
      { playerId: "member-c", slotIndex: 2 }
    ]);
    expect(joined.membershipRevision).toBe((before.membershipRevision ?? 0) + 2);
  });
});

function party(
  partyId: string,
  leaderPlayerId: string,
  ...membersAndRevision: Array<string | number>
) {
  const revision = typeof membersAndRevision.at(-1) === "number"
    ? membersAndRevision.pop() as number
    : 1;
  const memberPlayerIds = [
    leaderPlayerId,
    ...membersAndRevision.filter((member): member is string => typeof member === "string")
  ];
  return { partyId, leaderPlayerId, memberPlayerIds, allowTravel: false, autoFollowPlayerIds: [], revision };
}
