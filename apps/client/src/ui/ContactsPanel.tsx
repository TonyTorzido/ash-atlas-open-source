import type {
  RecentPlayerEntry,
  RecentPlayersResponse,
  SocialAction,
  SocialListKind,
  SocialListResponse
} from "@ash-atlas/shared";
import { useEffect, useMemo, useState } from "react";

import { ProfileApiClient } from "../profiles/profileClient.js";
import type { PartyInviteContext } from "../party/partyInviteEligibility.js";
import {
  ProfileConnections,
  type ProfileSection,
  type RequestListKind
} from "./SocialProfileOverlay.js";
import { GameAppShell } from "./GameAppShell.js";

export type ContactsPanelProps = Readonly<{
  open: boolean;
  ownPlayerId: string;
  serverHttpBase: string;
  csrfToken: string;
  refreshToken: number;
  pendingIncomingFriendRequestCount?: number;
  partyInviteContext?: PartyInviteContext;
  onOpenPlayer(playerId: string): void;
  onMessagePlayer?(playerId: string, displayName: string, online: boolean): void;
  onSendGift?(playerId: string, displayName: string): void;
  onOpenPlayerActions?(
    player: Pick<RecentPlayerEntry, "playerId" | "displayName">,
    anchorRect: { left: number; right: number; top: number; bottom: number }
  ): void;
  onInviteParty?(playerId: string): boolean;
  onRelationshipMutated?(playerId: string, action: SocialAction): void;
  layout?: "desktop" | "phone";
  onClose(): void;
}>;

export function ContactsPanel({
  open,
  serverHttpBase,
  csrfToken,
  refreshToken,
  pendingIncomingFriendRequestCount = 0,
  partyInviteContext,
  onOpenPlayer,
  onMessagePlayer,
  onSendGift,
  onOpenPlayerActions,
  onInviteParty,
  onRelationshipMutated,
  layout = "desktop",
  onClose
}: ContactsPanelProps): React.JSX.Element | null {
  const api = useMemo(
    () => new ProfileApiClient(serverHttpBase, csrfToken),
    [csrfToken, serverHttpBase]
  );
  const [activeSection, setActiveSection] = useState<ProfileSection>("friends");
  const [requestListKind, setRequestListKind] = useState<RequestListKind>("incoming_requests");
  const [socialList, setSocialList] = useState<SocialListResponse | null>(null);
  const [recentPlayers, setRecentPlayers] = useState<RecentPlayersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPlayerId, setBusyPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listRefreshToken, setListRefreshToken] = useState(0);

  const activeListKind: SocialListKind | null = activeSection === "recent"
    ? null
    : activeSection === "requests"
      ? requestListKind
      : activeSection;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const request = activeListKind ? api.list(activeListKind) : api.listRecent();
    void request.then((list) => {
      if (cancelled) return;
      if (activeListKind) {
        setSocialList(list as SocialListResponse);
        setRecentPlayers(null);
      } else {
        setRecentPlayers(list as RecentPlayersResponse);
        setSocialList(null);
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Contacts unavailable");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [activeListKind, api, listRefreshToken, open, refreshToken]);

  const mutate = async (targetPlayerId: string, action: SocialAction): Promise<void> => {
    if (busyPlayerId) return;
    setBusyPlayerId(targetPlayerId);
    setError(null);
    try {
      await api.mutate(targetPlayerId, action);
      onRelationshipMutated?.(targetPlayerId, action);
      setListRefreshToken((value) => value + 1);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Social action failed");
    } finally {
      setBusyPlayerId(null);
    }
  };

  return <GameAppShell
    open={open}
    menuId="contacts"
    title="Contacts"
    headerStatus={{ value: pendingIncomingFriendRequestCount, label: "Requests" }}
    closeLabel="Close Contacts"
    className="contacts-ledger-shell"
    layout={layout}
    phoneBackLabel="Back to Game Menu"
    onClose={onClose}
  >
    {error ? <p className="profile-error" role="alert">{error}</p> : null}
    <ProfileConnections
      activeSection={activeSection}
      requestListKind={requestListKind}
      pendingIncomingFriendRequestCount={pendingIncomingFriendRequestCount}
      socialList={socialList}
      recentPlayers={recentPlayers}
      loading={loading}
      busyPlayerId={busyPlayerId}
      onSectionChange={setActiveSection}
      onRequestListKindChange={setRequestListKind}
      onOpenPlayer={onOpenPlayer}
      onMutate={mutate}
      {...(onMessagePlayer ? { onMessagePlayer } : {})}
      {...(onSendGift ? { onSendGift } : {})}
      {...(onOpenPlayerActions ? { onOpenPlayerActions } : {})}
      {...(partyInviteContext && onInviteParty ? { partyInviteContext, onInviteParty } : {})}
    />
  </GameAppShell>;
}
