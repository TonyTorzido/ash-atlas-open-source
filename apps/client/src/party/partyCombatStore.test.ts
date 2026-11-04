import { describe, expect, it, vi } from "vitest";

import { PartyCombatStore } from "./partyCombatStore.js";

describe("PartyCombatStore", () => {
  it("applies ordered deltas without invalidating stable roster identity", () => {
    const store = new PartyCombatStore();
    store.applySnapshot(snapshot(4));
    const roster = store.getSnapshot();
    const member = store.getMemberSnapshot("ally");
    const rosterListener = vi.fn();
    const allyListener = vi.fn();
    store.subscribe(rosterListener);
    store.subscribeMember("ally", allyListener);

    expect(store.applyDelta({
      type: "PARTY_COMBAT_DELTA",
      partyId: "party:00000000-0000-4000-8000-000000000001",
      membershipRevision: 4,
      sequence: 2,
      serverTime: 2,
      members: [{ playerId: "ally", currentHealth: 42 }]
    })).toBe("applied");

    expect(store.getSnapshot()).toBe(roster);
    expect(store.getMemberSnapshot("ally")).not.toBe(member);
    expect(store.getMemberSnapshot("ally")?.currentHealth).toBe(42);
    expect(rosterListener).not.toHaveBeenCalled();
    expect(allyListener).toHaveBeenCalledOnce();
  });

  it("keeps the last roster and requests one resync on sequence gaps", () => {
    const store = new PartyCombatStore();
    const requestResync = vi.fn();
    store.setResyncRequester(requestResync);
    store.applySnapshot(snapshot(4));

    expect(store.applyDelta({
      type: "PARTY_COMBAT_DELTA",
      partyId: "party:00000000-0000-4000-8000-000000000001",
      membershipRevision: 4,
      sequence: 4,
      serverTime: 4,
      members: [{ playerId: "ally", currentHealth: 1 }]
    })).toBe("gap");
    expect(store.getSnapshot().stale).toBe(true);
    expect(store.getMemberSnapshot("ally")?.currentHealth).toBe(80);
    expect(requestResync).toHaveBeenCalledOnce();

    store.applyDelta({
      type: "PARTY_COMBAT_DELTA",
      partyId: "party:00000000-0000-4000-8000-000000000001",
      membershipRevision: 4,
      sequence: 5,
      serverTime: 5,
      members: [{ playerId: "ally", currentHealth: 2 }]
    });
    expect(requestResync).toHaveBeenCalledOnce();
  });

  it("retains the last projection during membership resync and clears only when party ends", () => {
    const store = new PartyCombatStore();
    store.applySnapshot(snapshot(4));
    store.reconcileParty({
      partyId: "party:00000000-0000-4000-8000-000000000001",
      leaderPlayerId: "self",
      memberPlayerIds: ["ally", "self"],
      memberSlots: [
        { playerId: "self", slotIndex: 0 },
        { playerId: "ally", slotIndex: 1 }
      ],
      membershipRevision: 5,
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 8
    });
    expect(store.getSnapshot()).toMatchObject({ stale: true, memberPlayerIds: ["self", "ally"] });

    store.reconcileParty(null);
    expect(store.getSnapshot()).toMatchObject({ partyId: null, memberPlayerIds: [] });
  });
});

function snapshot(membershipRevision: number) {
  return {
    type: "PARTY_COMBAT_SNAPSHOT" as const,
    partyId: "party:00000000-0000-4000-8000-000000000001",
    membershipRevision,
    sequence: 1,
    serverTime: 1,
    members: [
      {
        playerId: "self",
        slotIndex: 0,
        displayName: "Self",
        classId: "druid" as const,
        role: "healer" as const,
        currentHealth: 100,
        maxHealth: 100,
        lifeState: "alive" as const,
        presence: "online" as const,
        worldRelation: "same_layer" as const,
        distanceMeters: 0
      },
      {
        playerId: "ally",
        slotIndex: 1,
        displayName: "Ally",
        classId: "warrior" as const,
        role: "damage" as const,
        currentHealth: 80,
        maxHealth: 100,
        lifeState: "alive" as const,
        presence: "online" as const,
        worldRelation: "same_layer" as const,
        distanceMeters: 12
      }
    ]
  };
}
