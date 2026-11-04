import { useState } from "react";

import "../src/styles.css";
import {
  PlayerActionsSurface,
  type PlayerActionsTarget
} from "../src/ui/PlayerActionsSurface.js";

const FIRST = "00000000-0000-4000-8000-000000000002";
const SECOND = "00000000-0000-4000-8000-000000000003";

export function PlayerProfileNavigationStory(): React.JSX.Element {
  const [target, setTarget] = useState<PlayerActionsTarget | null>(null);
  const [profilePlayerId, setProfilePlayerId] = useState<string | null>(null);
  const open = (playerId: string): void => setTarget({
    playerId,
    displayName: "Twin Name",
    anchorRect: { left: 20, right: 100, top: 60, bottom: 80 }
  });
  return (
    <main>
      <button type="button" onClick={() => open(FIRST)}>Open Realm General Player One</button>
      <button type="button" onClick={() => open(SECOND)}>Open Realm General Player Two</button>
      <output data-testid="profile-player-id">{profilePlayerId ?? "none"}</output>
      <PlayerActionsSurface
        target={target}
        ownPlayerId="00000000-0000-4000-8000-000000000001"
        layout="desktop"
        serverHttpBase="http://profile.test"
        csrfToken="csrf"
        partyInviteContext={{
          connected: true,
          inviterPlayerId: "00000000-0000-4000-8000-000000000001",
          party: null,
          outgoingInvites: [],
          now: Date.now()
        }}
        refreshToken={0}
        onMessage={() => undefined}
        onSendTravelInvite={() => false}
        onViewProfile={(playerId) => {
          setTarget(null);
          setProfilePlayerId(playerId);
        }}
        onInviteParty={() => false}
        onClose={() => setTarget(null)}
      />
    </main>
  );
}
