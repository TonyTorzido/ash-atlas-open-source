import type { CombatEntitySnapshot, ServerMessage } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { InMemoryPartyAuthority } from "../game/party/PartyAuthority.js";
import { PartyCombatPublisher } from "./partyCombatPublisher.js";

describe("PartyCombatPublisher", () => {
  it("keeps the authoritative roster while publishing only dirty member fields", () => {
    const parties = new InMemoryPartyAuthority();
    parties.loadSnapshots([{
      partyId: "party:00000000-0000-4000-8000-000000000001",
      leaderPlayerId: "self",
      memberPlayerIds: ["ally", "self"],
      memberSlots: [
        { playerId: "self", slotIndex: 0 },
        { playerId: "ally", slotIndex: 1 }
      ],
      membershipRevision: 7,
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 9
    }]);
    const sent: Array<{
      playerId: string;
      message: ServerMessage;
      mode?: "critical" | "replaceable";
    }> = [];
    const entities = new Map<string, CombatEntitySnapshot>([
      ["self", entity("self", 100, 0)],
      ["ally", {
        ...entity("ally", 80, 0.0001),
        ward: 8,
        lifeState: "downed",
        downedUntil: 110_000
      }]
    ]);
    const visiblePlayers = new Set(["self", "ally"]);
    const connections = {
      activePlayerIds: () => ["self"],
      activeConnectionIdForPlayer: (playerId: string) => playerId === "self" ? "connection" : null,
      hasPlayerPresence: vi.fn(() => false),
      send: (playerId: string, message: ServerMessage, mode?: "critical" | "replaceable") => {
        sent.push({ playerId, message, ...(mode ? { mode } : {}) });
      }
    };
    const gameState = {
      getPlayer: (playerId: string) => ({
        playerId,
        username: playerId === "self" ? "Self" : "Ally",
        online: playerId === "self"
      }),
      getAuthoritativeTravelAnchor: (playerId: string) => ({
        scopeId: "world" as const,
        layerId: `player_anchor:${playerId}`,
        center: { lat: 0, lon: 0 },
        relocationRevision: 0,
        layerGeneration: 0,
        sourceType: "player_anchor" as const,
        sourceId: playerId
      })
    };
    const publisher = new PartyCombatPublisher(
      parties,
      connections,
      gameState as never,
      {
        entity: (playerId: string) => entities.get(playerId) ?? null,
        isPlayerVisibleToPlayer: (_viewerPlayerId: string, targetPlayerId: string) =>
          visiblePlayers.has(targetPlayerId)
      }
    );

    publisher.sendSnapshot("self");
    expect(sent[0]).toMatchObject({
      playerId: "self",
      mode: "critical",
      message: {
        type: "PARTY_COMBAT_SNAPSHOT",
        membershipRevision: 7,
        members: [
          { playerId: "self", slotIndex: 0, presence: "online" },
          { playerId: "ally", slotIndex: 1, presence: "offline", currentHealth: 80,
            ward: 8, lifeState: "downed", downedUntil: 110_000 }
        ]
      }
    });

    entities.delete("ally");
    visiblePlayers.delete("ally");
    publisher.flush();
    expect(sent[1]).toMatchObject({
      mode: "critical",
      message: {
        type: "PARTY_COMBAT_SNAPSHOT",
        members: [
          { playerId: "self" },
          { playerId: "ally", lifeState: "downed", downedUntil: 110_000 }
        ]
      }
    });

    entities.set("ally", { ...entity("ally", 42, 0.0001), ward: 0, downedUntil: null });
    visiblePlayers.add("ally");
    publisher.flush();
    expect(sent[2]).toMatchObject({
      mode: "critical",
      message: {
        type: "PARTY_COMBAT_SNAPSHOT",
        sequence: 3,
        members: [
          { playerId: "self" },
          { playerId: "ally", currentHealth: 42, ward: 0,
            lifeState: "alive", downedUntil: null }
        ]
      }
    });

    entities.set("ally", { ...entity("ally", 40, 0.0001), ward: 0, downedUntil: null });
    publisher.flush();
    expect(sent[3]).toMatchObject({
      message: {
        type: "PARTY_COMBAT_DELTA",
        sequence: 4,
        members: [{ playerId: "ally", currentHealth: 40 }]
      }
    });
    expect(sent[3]?.mode).toBeUndefined();
    const delta = sent[3]!.message;
    expect(delta.type).toBe("PARTY_COMBAT_DELTA");
    if (delta.type !== "PARTY_COMBAT_DELTA") throw new Error("Expected party combat delta");
    expect(delta.members).toHaveLength(1);

    entities.set("ally", {
      ...entity("ally", 40, 0.0001),
      regionCode: "us-nv",
      zoneId: "world:us-nv"
    });
    visiblePlayers.delete("ally");
    publisher.flush();
    expect(sent[4]).toMatchObject({
      mode: "critical",
      message: {
        type: "PARTY_COMBAT_SNAPSHOT",
        sequence: 5,
        members: [
          { playerId: "self", worldRelation: "same_layer" },
          { playerId: "ally", worldRelation: "different_area" }
        ]
      }
    });
  });
});

describe("PartyCombatPublisher class labels", () => {
  it("shows the active class, never a hidden old class from the legacy class profile", () => {
    const parties = new InMemoryPartyAuthority();
    parties.loadSnapshots([{
      partyId: "party:00000000-0000-4000-8000-000000000002",
      leaderPlayerId: "self",
      memberPlayerIds: ["ally", "self"],
      memberSlots: [{ playerId: "self", slotIndex: 0 }, { playerId: "ally", slotIndex: 1 }],
      membershipRevision: 1,
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 1
    }]);
    const sent: ServerMessage[] = [];
    // Both still carry a legacy Ninja class profile; only "self" has an active class (Warrior).
    const legacyNinja = (id: string): CombatEntitySnapshot => ({ ...entity(id, 100, 0), classCombat: { activeClassId: "ninja" } as never });
    const activeClass = new Map([["self", "warrior" as const], ["ally", null]]);
    const publisher = new PartyCombatPublisher(
      parties,
      {
        activePlayerIds: () => ["self"],
        activeConnectionIdForPlayer: (playerId: string) => playerId === "self" ? "connection" : null,
        hasPlayerPresence: () => false,
        send: (_playerId: string, message: ServerMessage) => { sent.push(message); }
      },
      { getPlayer: (playerId: string) => ({ playerId, username: playerId, online: true }) } as never,
      {
        entity: legacyNinja,
        isPlayerVisibleToPlayer: () => true,
        playerActiveSpecializationId: (playerId: string) => activeClass.get(playerId) ?? null
      }
    );
    publisher.sendSnapshot("self");
    expect(sent[0]).toMatchObject({
      type: "PARTY_COMBAT_SNAPSHOT",
      members: [
        { playerId: "self", classId: "warrior", role: "tank" },
        { playerId: "ally", classId: null, role: null }
      ]
    });
  });
});

function entity(
  entityId: string,
  currentHealth: number,
  lon: number
): CombatEntitySnapshot {
  return {
    entityId,
    kind: "player",
    archetypeKey: null,
    name: entityId,
    level: 1,
    regionCode: "us-co",
    zoneId: "world:us-co",
    lat: 0,
    lon,
    maxHealth: 100,
    currentHealth,
    lifeState: "alive",
    activityState: "idle",
    targetEntityId: null,
    revision: currentHealth,
    pveCombat: null,
    classCombat: null
  };
}
