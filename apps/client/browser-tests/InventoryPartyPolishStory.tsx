import { emptyInventoryTotals } from "@ash-atlas/shared";
import { useState } from "react";
import { KitchenPrompt } from "../src/ui/KitchenPrompt.js";
import { MobilePartyApp } from "../src/ui/MobilePartyApp.js";

const ignore = (): void => {};
const accepted = (): boolean => true;

export function PartyPolishStory({ layout = "phone" }: { layout?: "phone" | "desktop" }): React.JSX.Element {
  const [created, setCreated] = useState(false);
  return <MobilePartyApp layout={layout} open ownPlayerId="self" ownPlayerName="Atlas" connected
    party={created ? { partyId: "party", leaderPlayerId: "self", memberPlayerIds: ["self", "ally"], allowTravel: true, autoFollowPlayerIds: [], revision: 1 } : null}
    invites={[]} outgoingInvites={[]} playerNames={{ ally: "Ariadne the Far Traveler" }} visiblePlayers={[]}
    onBack={ignore} onCreate={() => { setCreated(true); return true; }} onInvite={accepted}
    onAccept={accepted} onForward={accepted} onDecline={accepted} onCancelInvite={accepted}
    onRemove={accepted} onLeave={accepted} onDisband={accepted} onChangeLeader={accepted}
    onSetTravelAllowed={accepted} onSetAutoFollow={accepted} onTravelToLeader={accepted}
    onMessage={ignore} onViewProfile={ignore} />;
}

export function KitchenPolishStory({ layout = "phone" }: { layout?: "phone" | "desktop" }): React.JSX.Element {
  return <KitchenPrompt layout={layout} busy={false} feedback={null} onClose={ignore} onCollect={ignore} onStart={accepted}
    inventory={{ playerId: "self", revision: 1, items: [], totals: { ...emptyInventoryTotals(), deer_meat: 30, freshwater_fish: 30 } }}
    state={{ kitchen: { kitchenId: "kitchen", manorId: "manor", ownerPlayerId: "self", ownerUsername: "Atlas", regionCode: "test", lat: 0, lon: 0, builtAt: "2026-01-01T00:00:00.000Z", placementRevision: 1 }, jobs: [], queueCapacity: 5, occupiedSlots: 0, serverTime: 1800000000000 }} />;
}
