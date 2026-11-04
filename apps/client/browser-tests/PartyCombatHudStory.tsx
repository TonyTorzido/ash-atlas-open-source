import type {
  PartyCombatMemberSnapshot,
  PartyReadyCheckSnapshot,
  PartySnapshot
} from "@ash-atlas/shared";
import { useMemo, useState } from "react";

import { PartyCombatStore } from "../src/party/partyCombatStore.js";
import { PartyCombatHud } from "../src/ui/PartyCombatHud.js";

const party: PartySnapshot = {
  partyId: "party:00000000-0000-4000-8000-000000000001",
  leaderPlayerId: "self",
  memberPlayerIds: ["ally-1", "ally-2", "ally-3", "ally-4", "self"],
  memberSlots: [
    { playerId: "self", slotIndex: 0 },
    { playerId: "ally-1", slotIndex: 1 },
    { playerId: "ally-2", slotIndex: 2 },
    { playerId: "ally-3", slotIndex: 3 },
    { playerId: "ally-4", slotIndex: 4 }
  ],
  membershipRevision: 5,
  allowTravel: false,
  autoFollowPlayerIds: [],
  revision: 5
};

type PartyCombatHudStoryProps = {
  otherMemberCount?: 1 | 2 | 3 | 4;
  follower?: boolean;
};

export function PartyCombatHudStory({
  otherMemberCount = 4,
  follower = false
}: PartyCombatHudStoryProps = {}): React.JSX.Element {
  const storyParty = useMemo(
    () => createParty(otherMemberCount, follower),
    [follower, otherMemberCount]
  );
  const [store] = useState(() => createStore(storyParty));
  const [selectedPlayerId, setSelectedPlayerId] = useState(
    otherMemberCount === 1 ? "ally-1" : "ally-2"
  );

  return (
    <main className="party-hud-browser-story">
      <style>{`
        body { background: radial-gradient(circle at center, #34412d, #121a15 60%, #090b09); }
        .party-hud-browser-story { min-height: 100vh; color: #e7dcc2; }
        .party-hud-browser-story .chat-top-bar { display: block; padding: 10px; }
        .party-hud-browser-story .combat-kit-hotbar { display: grid; }
        .party-hud-browser-story .combat-kit-button { display: grid; place-items: center; }
        .party-hud-browser-story .phone-bottom-bar { color: #d9bb80; }
      `}</style>
      <div className="chat-top-bar" data-testid="chat-bar">Party chat</div>
      <div className="combat-kit-hotbar" data-testid="combat-kit">
        {Array.from({ length: 6 }, (_, index) => (
          <button className="combat-kit-button" type="button" key={index}>
            <span>{index + 1}</span>
          </button>
        ))}
      </div>
      <div className="warrior-combat-controls" aria-label="Ability rails">
        <div className="warrior-reset-slots" data-testid="left-ability-rail">
          <button className="warrior-quick-slot" type="button"><span className="ability-icon">R</span></button>
          <button className="warrior-quick-slot" type="button"><span className="ability-icon">G</span></button>
        </div>
        <div className="warrior-normal-slots" data-testid="right-ability-rail">
          <button className="warrior-quick-slot" type="button"><span className="ability-icon">1</span></button>
          <button className="warrior-quick-slot" type="button"><span className="ability-icon">2</span></button>
        </div>
      </div>
      <div className="legacy-controls-left">
        <button
          className="legacy-control-button legacy-flag-button"
          data-testid="flag-control"
          type="button"
          aria-label="Place flag"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V3M7 4h10l-2 4 2 4H7" /></svg>
        </button>
        <button
          className="legacy-control-button legacy-recenter-button"
          data-testid="recenter-control"
          type="button"
          aria-label="Recenter map"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" /></svg>
        </button>
      </div>
      <div className="legacy-controls-right">
        <button
          className="legacy-control-button legacy-heal-button"
          data-testid="resin-control"
          type="button"
          aria-label="Heal with resin"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12Z" /></svg>
        </button>
      </div>
      <div className="phone-bottom-bar" data-testid="bottom-dock">Bottom dock</div>
      <PartyCombatHud
        store={store}
        party={storyParty}
        ownPlayerId="self"
        selectedPlayerId={selectedPlayerId}
        hidden={false}
        connected
        onSetTravelAllowed={() => true}
        onSetAutoFollow={() => true}
        onTravelToLeader={() => true}
        onSelectPlayer={(playerId) => setSelectedPlayerId(playerId ?? "self")}
        onRespondReadyCheck={() => true}
      />
    </main>
  );
}

function createParty(otherMemberCount: number, follower: boolean): PartySnapshot {
  const memberPlayerIds = [
    ...party.memberPlayerIds.filter((playerId) => playerId.startsWith("ally-")).slice(0, otherMemberCount),
    "self"
  ];
  return {
    ...party,
    leaderPlayerId: follower ? "ally-1" : "self",
    memberPlayerIds,
    memberSlots: party.memberSlots?.filter(({ playerId }) => memberPlayerIds.includes(playerId)),
    membershipRevision: otherMemberCount + 1,
    revision: otherMemberCount + 1
  };
}

function createStore(storyParty: PartySnapshot): PartyCombatStore {
  const activePlayerIds = new Set(storyParty.memberPlayerIds);
  const membershipRevision = storyParty.membershipRevision ?? 0;
  const members: PartyCombatMemberSnapshot[] = [
    member("self", 0, "Ashwarden", "druid", 100, 100, 0),
    member("ally-1", 1, "Stoneheart", "warrior", 72, 100, 15),
    member("ally-2", 2, "Brightshield", "knight", 31, 100, 48),
    member("ally-3", 3, "Trailseeker", "hunter", 84, 100, 121),
    {
      ...member("ally-4", 4, "Far Voyager", "warrior", 0, 100, 0),
      lifeState: "defeated",
      presence: "offline",
      worldRelation: "different_area",
      distanceMeters: undefined
    }
  ];
  const store = new PartyCombatStore();
  store.applySnapshot({
    type: "PARTY_COMBAT_SNAPSHOT",
    partyId: storyParty.partyId,
    membershipRevision,
    sequence: 1,
    serverTime: 1,
    members: members.filter((candidate) => activePlayerIds.has(candidate.playerId))
  });
  store.applyReadyCheck({
    ...readyCheck,
    membershipRevision,
    responses: readyCheck.responses.filter(({ playerId }) => activePlayerIds.has(playerId))
  });
  return store;
}

function member(
  playerId: string,
  slotIndex: number,
  displayName: string,
  classId: PartyCombatMemberSnapshot["classId"],
  currentHealth: number,
  maxHealth: number,
  distanceMeters: number
): PartyCombatMemberSnapshot {
  return {
    playerId,
    slotIndex,
    displayName,
    classId,
    role: classId === "warrior" ? "tank" : "damage",
    currentHealth,
    maxHealth,
    lifeState: "alive",
    presence: "online",
    worldRelation: "same_layer",
    distanceMeters,
    priorityEffects: playerId === "ally-2"
      ? [
          { id: "guard", label: "Guard", tone: "beneficial" },
          { id: "bleed", label: "Bleed", tone: "harmful" }
        ]
      : undefined
  };
}

const readyCheck: PartyReadyCheckSnapshot = {
  readyCheckId: "ready-1",
  partyId: party.partyId,
  membershipRevision: 5,
  startedByPlayerId: "self",
  startedAt: 1,
  expiresAt: 31_000,
  status: "pending",
  responses: [
    { playerId: "self", response: "ready" },
    { playerId: "ally-1", response: "ready" },
    { playerId: "ally-2", response: "pending" },
    { playerId: "ally-3", response: "not_ready" },
    { playerId: "ally-4", response: "pending" }
  ]
};
