import {
  PET_SPECIES_DEFINITIONS,
  PROFILE_BIOGRAPHY_MAX_CHARACTERS,
  PROFILE_TITLES,
  TRAVEL_INVITE_PAIR_COOLDOWN_MS,
  type PetSpeciesId,
  type PublicProfile,
  type PlayerPresenceState,
  type ProfileTitle,
  type RecentPlayerEntry,
  type RecentPlayersResponse,
  type SocialAction,
  type SocialListKind,
  type SocialListResponse,
  type TravelInboxEntry
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ProfileApiClient } from "../profiles/profileClient.js";
import type { CommunityReportCategory } from "../community/communitySafetyClient.js";
import {
  partyInviteAvailability,
  type PartyInviteContext
} from "../party/partyInviteEligibility.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { CommunityReportPrompt } from "./CommunityReportPrompt.js";
import { GameAppSectionHeader, GameAppShell, GameAppTabs } from "./GameAppShell.js";
import { StatGlyph } from "./MenuDestinationGlyph.js";
import { RigPortrait } from "./RigPortrait.js";
import { fetchViewerWars, isAtWarWith } from "../features/wars/warRelation.js";
import type { OrganizationWar } from "./OrganizationWarsSection.js";
import { ThemedSelect } from "./ThemedSelect.js";
import { GameActionPrompt, type GamePromptAction } from "./GameActionPrompt.js";
import { PlayerTapMenu, playerRelation, type PlayerRelationContext } from "./PlayerTapMenu.js";

type SocialProfileOverlayProps = {
  playerId: string | null;
  ownPlayerId: string;
  expanded: boolean;
  available: boolean;
  serverHttpBase: string;
  csrfToken: string;
  refreshToken: number;
  pendingIncomingFriendRequestCount?: number;
  onExpand(): void;
  onOpenPlayer(playerId: string): void;
  onMessagePlayer?(playerId: string, displayName: string, online: boolean): void;
  onSendGift?(playerId: string, displayName: string): void;
  onReportPlayer?(
    playerId: string,
    category: CommunityReportCategory,
    explanation: string | null
  ): void | Promise<void>;
  onOpenPlayerActions?(
    player: Pick<RecentPlayerEntry, "playerId" | "displayName">,
    anchorRect: { left: number; right: number; top: number; bottom: number }
  ): void;
  onRelationshipMutated?(playerId: string, action: SocialAction): void;
  partyInviteContext?: PartyInviteContext;
  onInviteParty?(playerId: string): boolean;
  onSendTravelInvite?(playerId: string): boolean;
  outgoingTravelInvite?: TravelInboxEntry | null;
  travelInboxServerOffsetMs?: number;
  kingdomInviteEligibility?: { allowed: boolean; reason: string | null } | undefined;
  onInviteToKingdom?(playerId: string): Promise<void>;
  onOpenKingdom?(kingdomId: string): void;
  /** Opens the viewer's own achievements view from their profile. */
  onOpenAchievements?(): void;
  closeLabel?: string;
  layout?: "desktop" | "phone";
  /** Tap-menu context: relationship inputs, PvP status, attack and usable skills. */
  tapRelationContext?: PlayerRelationContext;
  tapPvpStatusLabel?: string | null;
  tapAttackBlocked?: boolean;
  tapAttackOneSwing?: boolean;
  tapSkillActions?: readonly GamePromptAction[];
  tapSelfActions?: readonly GamePromptAction[];
  onAttackPlayer?(playerId: string): void;
  onClose(): void;
};

export type ProfileSection = "friends" | "requests" | "recent" | "enemies" | "blocked";
export type RequestListKind = "incoming_requests" | "outgoing_requests";

export function SocialProfileOverlay({
  playerId,
  ownPlayerId,
  expanded,
  available,
  serverHttpBase,
  csrfToken,
  refreshToken,
  onExpand,
  onOpenPlayer,
  onMessagePlayer,
  onSendGift,
  onReportPlayer,
  onRelationshipMutated,
  partyInviteContext,
  onInviteParty,
  onSendTravelInvite,
  outgoingTravelInvite,
  travelInboxServerOffsetMs = 0,
  kingdomInviteEligibility,
  onInviteToKingdom,
  onOpenKingdom,
  onOpenAchievements,
  closeLabel = "Close profile",
  layout = "desktop",
  tapRelationContext,
  tapPvpStatusLabel = null,
  tapAttackBlocked = false,
  tapAttackOneSwing = false,
  tapSkillActions = [],
  tapSelfActions = [],
  onAttackPlayer,
  onClose
}: SocialProfileOverlayProps): React.JSX.Element | null {
  const api = useMemo(
    () => new ProfileApiClient(serverHttpBase, csrfToken),
    [csrfToken, serverHttpBase]
  );
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<SocialAction | "profile" | "kingdom_invite" | "party_invite" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [returnPlayerId, setReturnPlayerId] = useState<string | null>(null);
  const [confirmEnemy, setConfirmEnemy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState<ProfileTitle | "">("");
  const [biography, setBiography] = useState("");
  const [travelInviteClock, setTravelInviteClock] = useState(() => Date.now());
  const [viewerWars, setViewerWars] = useState<readonly OrganizationWar[]>([]);
  const activePlayerIdRef = useRef(playerId);
  const previousPlayerIdRef = useRef(playerId);
  const pendingProfileNavigationRef = useRef<string | null>(null);
  const availableRef = useRef(available);
  const profileRequestRef = useRef(0);
  const operationRef = useRef<object | null>(null);
  activePlayerIdRef.current = playerId;
  availableRef.current = available;

  useEffect(() => {
    const requestNumber = ++profileRequestRef.current;
    const requestedPlayerId = playerId;
    const targetChanged = previousPlayerIdRef.current !== playerId;
    previousPlayerIdRef.current = playerId;
    const expectedProfileNavigation = pendingProfileNavigationRef.current === playerId;
    pendingProfileNavigationRef.current = null;
    if (targetChanged && !expectedProfileNavigation) setReturnPlayerId(null);
    setProfile(null);
    setError(null);
    if (targetChanged || !available) {
      setProfileMenuOpen(false);
      setConfirmEnemy(false);
      setEditing(false);
      setTitle("");
      setBiography("");
      operationRef.current = null;
      setBusyAction(null);
    }
    if (!playerId || !available) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void api.getProfile(playerId).then((next) => {
      if (
        requestNumber !== profileRequestRef.current ||
        requestedPlayerId !== activePlayerIdRef.current ||
        next.playerId !== requestedPlayerId ||
        !availableRef.current
      ) return;
      setProfile(next);
      setTitle(next.title ?? "");
      setBiography(next.biography ?? "");
    }).catch((reason: unknown) => {
      if (
        requestNumber === profileRequestRef.current &&
        requestedPlayerId === activePlayerIdRef.current &&
        availableRef.current
      ) setError(reason instanceof Error ? reason.message : "Profile unavailable");
    }).finally(() => {
      if (
        requestNumber === profileRequestRef.current &&
        requestedPlayerId === activePlayerIdRef.current
      ) setLoading(false);
    });
    return () => { profileRequestRef.current += 1; };
  }, [api, available, playerId, refreshToken]);

  // Wars feed the tap menu's enemy rule; only the compact menu needs them.
  useEffect(() => {
    if (!playerId || expanded || playerId === ownPlayerId) return;
    let cancelled = false;
    void fetchViewerWars(serverHttpBase, csrfToken).then((wars) => { if (!cancelled) setViewerWars(wars); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [csrfToken, expanded, ownPlayerId, playerId, serverHttpBase]);

  const travelInviteCooldownUntil = outgoingTravelInvite &&
    outgoingTravelInvite.perspective === "sender" &&
    outgoingTravelInvite.counterpartPlayerId === playerId
    ? Date.parse(outgoingTravelInvite.createdAt) + TRAVEL_INVITE_PAIR_COOLDOWN_MS
    : 0;
  useEffect(() => {
    setTravelInviteClock(Date.now());
    if (travelInviteCooldownUntil <= Date.now() + travelInboxServerOffsetMs) return;
    const timer = window.setInterval(() => setTravelInviteClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [travelInboxServerOffsetMs, travelInviteCooldownUntil]);

  const actionableProfile =
    profile?.playerId === playerId && available && !loading ? profile : null;
  const travelInviteCooldownSeconds = Math.max(0, Math.ceil(
    (travelInviteCooldownUntil - (travelInviteClock + travelInboxServerOffsetMs)) / 1_000
  ));
  const closeProfile = (): void => {
    if (!returnPlayerId) {
      onClose();
      return;
    }
    pendingProfileNavigationRef.current = returnPlayerId;
    const targetPlayerId = returnPlayerId;
    setReturnPlayerId(null);
    onOpenPlayer(targetPlayerId);
  };

  if (!playerId) return null;
  if (!available) {
    const unavailable = <div className="profile-unavailable">
      <strong>Player unavailable</strong>
      <p>This player is no longer nearby or visible.</p>
    </div>;
    if (layout === "phone") {
      return <GameAppShell
        open
        title="Profile"
        subtitle="Unavailable"
        closeLabel={closeLabel}
        layout="phone"
        menuId="contacts"
        className="profile-ledger-shell"
        {...(returnPlayerId || closeLabel === "Back" ? { phoneBackLabel: "Back", phoneShowReturnToGame: false } : {})}
        onClose={closeProfile}
      >{unavailable}</GameAppShell>;
    }
    return <GameActionPrompt
      compact
      dismissOnOutsideClick
      elevated
      title="Player unavailable"
      ariaLabel="Selected player unavailable"
      actions={[]}
      cancelLabel="Close"
      onCancel={onClose}
    />;
  }
  if (!expanded) {
    if (layout !== "phone") {
      const tapProfile = actionableProfile;
      return <PlayerTapMenu
        profile={tapProfile}
        loadingLabel={error ?? "Loading player..."}
        relation={tapProfile ? playerRelation(tapProfile, { ...tapRelationContext, atWar: isAtWarWith(viewerWars, tapProfile) }) : "neutral"}
        pvpStatusLabel={tapPvpStatusLabel}
        attackBlocked={tapAttackBlocked}
        attackOneSwing={tapAttackOneSwing}
        skillActions={tapSkillActions}
        selfActions={tapSelfActions}
        onAttack={(targetPlayerId) => onAttackPlayer?.(targetPlayerId)}
        onViewProfile={onExpand}
        onClose={closeProfile}
      />;
    }
    return <GameAppShell
      open
      title="Profile"
      closeLabel={closeLabel}
      layout="phone"
      menuId="contacts"
      className="profile-ledger-shell"
      {...(returnPlayerId || closeLabel === "Back" ? { phoneBackLabel: "Back", phoneShowReturnToGame: false } : {})}
      onClose={closeProfile}
    ><aside className="selected-player-card" aria-label="Selected player card" aria-busy={loading} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      {actionableProfile ? <CompactProfile profile={actionableProfile} onExpand={onExpand} selfActions={tapSelfActions} {...(onMessagePlayer ? { onMessagePlayer } : {})} {...(onOpenKingdom ? { onOpenKingdom } : {})} /> : (
        <div className="profile-loading game-app-state game-app-state-loading">{error ?? "Loading player..."}</div>
      )}
    </aside></GameAppShell>;
  }

  const mutate = async (targetPlayerId: string, action: SocialAction): Promise<void> => {
    const currentProfile = profile;
    if (
      operationRef.current ||
      loading ||
      !availableRef.current ||
      activePlayerIdRef.current !== targetPlayerId ||
      currentProfile?.playerId !== targetPlayerId
    ) return;
    const operation = {};
    operationRef.current = operation;
    setBusyAction(action);
    setError(null);
    try {
      const next = await api.mutate(targetPlayerId, action);
      onRelationshipMutated?.(targetPlayerId, action);
      if (
        operationRef.current === operation &&
        activePlayerIdRef.current === targetPlayerId &&
        availableRef.current &&
        next.playerId === targetPlayerId
      ) setProfile(next);
    } catch (reason) {
      if (
        operationRef.current === operation &&
        activePlayerIdRef.current === targetPlayerId
      ) setError(reason instanceof Error ? reason.message : "Social action failed");
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        setBusyAction(null);
        setConfirmEnemy(false);
      }
    }
  };

  const saveProfile = async (): Promise<void> => {
    const targetPlayerId = playerId;
    if (
      targetPlayerId !== ownPlayerId ||
      operationRef.current ||
      loading ||
      !availableRef.current ||
      profile?.playerId !== targetPlayerId
    ) return;
    const operation = {};
    operationRef.current = operation;
    setBusyAction("profile");
    setError(null);
    try {
      const next = await api.updateProfile({ title: title || null, biography });
      if (
        operationRef.current === operation &&
        activePlayerIdRef.current === targetPlayerId &&
        next.playerId === targetPlayerId
      ) {
        setProfile(next);
        setTitle(next.title ?? "");
        setBiography(next.biography ?? "");
        setEditing(false);
      }
    } catch (reason) {
      if (operationRef.current === operation) {
        setError(reason instanceof Error ? reason.message : "Profile update failed");
      }
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        setBusyAction(null);
      }
    }
  };

  const inviteToKingdom = async (targetPlayerId: string): Promise<void> => {
    if (!onInviteToKingdom || operationRef.current || !kingdomInviteEligibility?.allowed) return;
    const operation = {};
    operationRef.current = operation;
    setBusyAction("kingdom_invite");
    setError(null);
    try {
      await onInviteToKingdom(targetPlayerId);
    } catch (reason) {
      if (operationRef.current === operation) {
        setError(reason instanceof Error ? reason.message : "Kingdom invitation failed");
      }
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        setBusyAction(null);
      }
    }
  };

  return <>
    <GameAppShell
      open
      title="Profile"
      closeLabel={closeLabel}
      layout={layout}
      menuId="contacts"
        className="profile-ledger-shell"
      {...(returnPlayerId || closeLabel === "Back" ? { phoneBackLabel: "Back", phoneShowReturnToGame: false } : {})}
      onClose={closeProfile}
    >
      <div className="profile-ledger" aria-busy={loading || busyAction !== null}>
        {actionableProfile ? <>
          <section className="profile-hero" aria-label={`${actionableProfile.displayName} profile`}>
            <div className="profile-character-pane">
              <RigPortrait
                appearance={actionableProfile.appearance ?? null}
                animate
                className="profile-character-preview"
                ariaLabel={`${actionableProfile.displayName} character appearance`}
              />
            </div>
            <div className="profile-identity-pane">
              <ProfileHeader
                profile={actionableProfile}
                action={actionableProfile.isSelf ? <button
                  type="button"
                  className="profile-edit-button game-app-button game-app-button-compact"
                  aria-pressed={editing}
                  onClick={() => setEditing((value) => !value)}
                >{editing ? "Stop Editing" : "Edit Profile"}</button> : null}
              />
              <ProfileSummary profile={actionableProfile} />
              <ProfileSlots profile={actionableProfile} {...(onOpenKingdom ? { onOpenKingdom } : {})} />
            </div>
          </section>
          {actionableProfile.isSelf && editing ? null : <ProfileBiography biography={actionableProfile.biography} />}
          {actionableProfile.isSelf && editing ? <section className="profile-record" aria-label="Edit profile">
            <ProfileEditor
              title={title}
              biography={biography}
              busy={busyAction !== null}
              saving={busyAction === "profile"}
              onTitleChange={setTitle}
              onBiographyChange={setBiography}
              onCancel={() => setEditing(false)}
              onSave={() => void saveProfile()}
            />
          </section> : null}
          <ProfileStats profile={actionableProfile} />
          <ProfileWeeklyPlacements profile={actionableProfile} />
          <ProfileRecentAchievements
            profile={actionableProfile}
            {...(actionableProfile.isSelf && onOpenAchievements ? { onOpen: onOpenAchievements } : {})}
          />
          {error ? <div className="profile-error" role="alert">{error}</div> : null}
          {!actionableProfile.isSelf ? <ProfileActions
            profile={actionableProfile}
            busy={busyAction !== null}
            menuOpen={profileMenuOpen}
            travelInviteCooldownSeconds={travelInviteCooldownSeconds}
            {...(kingdomInviteEligibility ? { kingdomInviteEligibility } : {})}
            onMenuOpenChange={setProfileMenuOpen}
            onMutate={(action) => mutate(actionableProfile.playerId, action)}
            onConfirmEnemy={() => setConfirmEnemy(true)}
            onInviteToKingdom={() => void inviteToKingdom(actionableProfile.playerId)}
            {...(onMessagePlayer ? { onMessagePlayer } : {})}
            {...(onSendGift ? { onSendGift } : {})}
            {...(onReportPlayer ? { onReportPlayer } : {})}
            {...(partyInviteContext && onInviteParty ? {
              partyInviteContext,
              onInviteParty: (targetPlayerId: string) => {
                setError(null);
                const invited = onInviteParty(targetPlayerId);
                if (!invited) setError("Could not send the party invitation.");
                return invited;
              }
            } : {})}
            {...(onSendTravelInvite ? {
              onSendTravelInvite: (targetPlayerId: string) => {
                setError(null);
                const invited = onSendTravelInvite(targetPlayerId);
                if (!invited) setError("Cannot send a Travel Invite while disconnected.");
                return invited;
              }
            } : {})}
          /> : null}
          <ProfilePlayerConnections
            key={actionableProfile.playerId}
            api={api}
            profile={actionableProfile}
            onOpenPlayer={(targetPlayerId) => {
              if (targetPlayerId === actionableProfile.playerId) return;
              pendingProfileNavigationRef.current = targetPlayerId;
              setReturnPlayerId(actionableProfile.playerId);
              onOpenPlayer(targetPlayerId);
            }}
          />
        </> : <div className="profile-loading game-app-state game-app-state-loading">{error ?? "Loading profile..."}</div>}
      </div>
    </GameAppShell>
    {confirmEnemy && actionableProfile ? <ConfirmDialog
      title="Replace friendship?"
      message={`Declaring ${actionableProfile.displayName} an enemy will remove your friendship.`}
      confirmLabel="Declare Enemy"
      busy={busyAction !== null}
      onCancel={() => setConfirmEnemy(false)}
      onConfirm={() => void mutate(actionableProfile.playerId, "mark_enemy")}
    /> : null}
  </>;
}

function ProfileEditor({
  title,
  biography,
  busy,
  saving,
  onTitleChange,
  onBiographyChange,
  onCancel,
  onSave
}: {
  title: ProfileTitle | "";
  biography: string;
  busy: boolean;
  saving: boolean;
  onTitleChange(value: ProfileTitle | ""): void;
  onBiographyChange(value: string): void;
  onCancel(): void;
  onSave(): void;
}): React.JSX.Element {
  return <section className="profile-editor" aria-label="Edit profile">
    <GameAppSectionHeader className="profile-section-heading" title="Edit Profile" />
    <div className="profile-editor-field">
      <ThemedSelect
        label="Unlocked title"
        value={title}
        options={[
          { value: "", label: "No title" },
          ...PROFILE_TITLES.map((unlockedTitle) => ({ value: unlockedTitle, label: unlockedTitle }))
        ]}
        onChange={onTitleChange}
      />
    </div>
    <label>
      <span>Status <small>{unicodeLength(biography)}/{PROFILE_BIOGRAPHY_MAX_CHARACTERS}</small></span>
      <textarea value={biography} onChange={(event) => onBiographyChange(limitUnicode(event.currentTarget.value, PROFILE_BIOGRAPHY_MAX_CHARACTERS))} />
    </label>
    <div className="profile-editor-actions">
      <button type="button" className="secondary game-app-button" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="button" className="primary game-app-button game-app-button-primary" disabled={busy} onClick={onSave}>{saving ? "Saving..." : "Save Profile"}</button>
    </div>
  </section>;
}

export function ProfileConnections({
  activeSection,
  requestListKind,
  pendingIncomingFriendRequestCount,
  socialList,
  recentPlayers,
  loading,
  busyPlayerId,
  onSectionChange,
  onRequestListKindChange,
  onOpenPlayer,
  onMutate,
  onMessagePlayer,
  onSendGift,
  onOpenPlayerActions,
  partyInviteContext,
  onInviteParty
}: {
  activeSection: ProfileSection;
  requestListKind: RequestListKind;
  pendingIncomingFriendRequestCount: number;
  socialList: SocialListResponse | null;
  recentPlayers: RecentPlayersResponse | null;
  loading: boolean;
  busyPlayerId: string | null;
  onSectionChange(section: ProfileSection): void;
  onRequestListKindChange(kind: RequestListKind): void;
  onOpenPlayer(playerId: string): void;
  onMutate(playerId: string, action: SocialAction): Promise<void>;
  onMessagePlayer?(playerId: string, displayName: string, online: boolean): void;
  onSendGift?(playerId: string, displayName: string): void;
  onOpenPlayerActions?(
    player: Pick<RecentPlayerEntry, "playerId" | "displayName">,
    anchorRect: { left: number; right: number; top: number; bottom: number }
  ): void;
  partyInviteContext?: PartyInviteContext;
  onInviteParty?(playerId: string): boolean;
}): React.JSX.Element {
  const requestBadge = pendingIncomingFriendRequestCount > 0
    ? String(Math.min(99, pendingIncomingFriendRequestCount)) + (pendingIncomingFriendRequestCount > 99 ? "+" : "")
    : undefined;
  return <section className="profile-connections" aria-label="Contacts">
    <div className="profile-connections-bar">
      <GameAppTabs
        ariaLabel="Connection lists"
        variant="housed"
        activeTab={activeSection}
        tabs={[
          { id: "friends", label: "Friends" },
          {
            id: "requests",
            label: "Requests",
            ...(requestBadge ? {
              badge: requestBadge,
              ariaLabel: `Requests, ${pendingIncomingFriendRequestCount} pending`
            } : {})
          },
          { id: "recent", label: "Recent" },
          { id: "enemies", label: "Enemies" }
        ]}
        onChange={(id) => onSectionChange(id as ProfileSection)}
      />
      <button
        type="button"
        className="secondary game-app-button game-app-button-compact profile-connections-manage"
        aria-pressed={activeSection === "blocked"}
        onClick={() => onSectionChange(activeSection === "blocked" ? "friends" : "blocked")}
      >Manage</button>
    </div>
    {activeSection === "requests" ? <div className="profile-request-switch" role="group" aria-label="Request direction">
      <button type="button" className="game-app-button game-app-button-compact" aria-pressed={requestListKind === "incoming_requests"} onClick={() => onRequestListKindChange("incoming_requests")}>Incoming</button>
      <button type="button" className="game-app-button game-app-button-compact" aria-pressed={requestListKind === "outgoing_requests"} onClick={() => onRequestListKindChange("outgoing_requests")}>Sent</button>
    </div> : null}
    <div className="profile-connections-panel" aria-live="polite">
      {activeSection === "recent" ? <RecentPlayersList
        list={recentPlayers}
        loading={loading}
        onOpenPlayer={onOpenPlayer}
        {...(partyInviteContext && onInviteParty ? { partyInviteContext, onInviteParty } : {})}
        {...(onOpenPlayerActions ? { onOpenPlayerActions } : {})}
      /> : <SocialList
        list={socialList}
        kind={activeSection === "requests" ? requestListKind : activeSection as SocialListKind}
        loading={loading}
        busyPlayerId={busyPlayerId}
        onOpenPlayer={onOpenPlayer}
        onMutate={onMutate}
        {...(onMessagePlayer ? { onMessagePlayer } : {})}
        {...(onSendGift ? { onSendGift } : {})}
        {...(onOpenPlayerActions ? { onOpenPlayerActions } : {})}
        {...(partyInviteContext && onInviteParty ? { partyInviteContext, onInviteParty } : {})}
      />}
    </div>
  </section>;
}

function ProfileActions({
  profile,
  busy,
  menuOpen,
  travelInviteCooldownSeconds,
  kingdomInviteEligibility,
  onMenuOpenChange,
  onMutate,
  onConfirmEnemy,
  onInviteToKingdom,
  onMessagePlayer,
  onSendGift,
  onReportPlayer,
  partyInviteContext,
  onInviteParty,
  onSendTravelInvite
}: {
  profile: PublicProfile;
  busy: boolean;
  menuOpen: boolean;
  travelInviteCooldownSeconds: number;
  kingdomInviteEligibility?: { allowed: boolean; reason: string | null };
  onMenuOpenChange(open: boolean): void;
  onMutate(action: SocialAction): Promise<void>;
  onConfirmEnemy(): void;
  onInviteToKingdom(): void;
  onMessagePlayer?(playerId: string, displayName: string, online: boolean): void;
  onSendGift?(playerId: string, displayName: string): void;
  onReportPlayer?(
    playerId: string,
    category: CommunityReportCategory,
    explanation: string | null
  ): void | Promise<void>;
  partyInviteContext?: PartyInviteContext;
  onInviteParty?(playerId: string): boolean;
  onSendTravelInvite?(playerId: string): boolean;
}): React.JSX.Element {
  const canDirectlyInteract = profile.relationship.friendship !== "blocked_by_viewer" &&
    profile.relationship.friendship !== "unavailable";
  const [reporting, setReporting] = useState(false);
  const incomingRequest = profile.relationship.friendship === "incoming_request" && !profile.relationship.enemyMarkedByViewer;
  const partyAvailability = onInviteParty && partyInviteContext
    ? partyInviteAvailability(partyInviteContext, profile.playerId, profile.relationship)
    : null;
  const closeThen = (run: () => void) => () => {
    onMenuOpenChange(false);
    run();
  };
  return <section className="profile-action-section" aria-label="Player actions">
    {incomingRequest ? <div className="profile-friend-request" role="group" aria-label={`Friend request from ${profile.displayName}`}>
      <p className="profile-friend-request-title"><StatGlyph icon="contacts" /><span>Friend request from <strong>{profile.displayName}</strong></span></p>
      <div className="profile-friend-request-actions">
        <button type="button" className="primary game-app-button game-app-button-primary" disabled={busy} onClick={() => void onMutate("accept_friend_request")}>Accept Friend</button>
        <button type="button" className="secondary game-app-button" disabled={busy} onClick={() => void onMutate("decline_friend_request")}>Decline</button>
      </div>
    </div> : null}
    <div className="profile-actions">
      {onMessagePlayer && canDirectlyInteract ? <button
        type="button"
        /* One brass action per screen: a pending friend request takes it, Message steps back. */
        className={incomingRequest ? "secondary game-app-button" : "primary game-app-button game-app-button-primary"}
        disabled={busy}
        onClick={() => onMessagePlayer(profile.playerId, profile.displayName, profile.presence === "online")}
      >Message</button> : null}
      <div
        className="profile-overflow"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) onMenuOpenChange(false);
        }}
      >
        <button
          type="button"
          className="secondary game-app-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => onMenuOpenChange(!menuOpen)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onMenuOpenChange(false);
          }}
        >More</button>
        {menuOpen ? <div className="profile-overflow-menu" role="menu">
          {onSendGift && canDirectlyInteract && !profile.isSelf ? <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={closeThen(() => onSendGift(profile.playerId, profile.displayName))}
          >Send Gift</button> : null}
          {partyAvailability && onInviteParty ? <button
            type="button"
            role="menuitem"
            disabled={busy || !partyAvailability.available}
            title={partyAvailability.reason ?? undefined}
            onClick={closeThen(() => { onInviteParty(profile.playerId); })}
          >Invite to Party</button> : null}
          {relationshipMenuItems(profile.relationship).map((item) => <button
            key={item.action}
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={closeThen(() => void onMutate(item.action))}
          >{item.label}</button>)}
          {onSendTravelInvite ? <button
            type="button"
            role="menuitem"
            title={travelInviteCooldownSeconds > 0
              ? `You can send a fresh invite in ${travelInviteCooldownSeconds} seconds.`
              : undefined}
            disabled={busy || travelInviteCooldownSeconds > 0}
            onClick={() => {
              onMenuOpenChange(false);
              onSendTravelInvite(profile.playerId);
            }}
          >{travelInviteCooldownSeconds > 0
            ? `Travel Invite in ${travelInviteCooldownSeconds}s`
            : "Send Travel Invite"}</button> : null}
          {kingdomInviteEligibility ? <button
            type="button"
            role="menuitem"
            title={profile.kingdom ? "This player already belongs to a Kingdom." : kingdomInviteEligibility.reason ?? undefined}
            disabled={busy || !mayInviteProfileToKingdom(profile, kingdomInviteEligibility)}
            onClick={() => {
              onMenuOpenChange(false);
              onInviteToKingdom();
            }}
          >Invite to Kingdom</button> : null}
          {!profile.relationship.enemyMarkedByViewer && canDirectlyInteract ? <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={busy}
            onClick={() => {
              onMenuOpenChange(false);
              if (profile.relationship.friendship === "friends") onConfirmEnemy();
              else void onMutate("mark_enemy");
            }}
          >Declare Enemy</button> : null}
          <button type="button" role="menuitem" onClick={() => {
            onMenuOpenChange(false);
            void navigator.clipboard?.writeText(profile.displayName);
          }}>Copy Player Name</button>
          {onReportPlayer ? <button
            type="button"
            role="menuitem"
            onClick={() => {
              onMenuOpenChange(false);
              setReporting(true);
            }}
          >Report Player</button> : null}
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={busy}
            onClick={() => {
              onMenuOpenChange(false);
              void onMutate(profile.relationship.friendship === "blocked_by_viewer" ? "unblock" : "block");
            }}
          >{profile.relationship.friendship === "blocked_by_viewer" ? "Unblock Player" : "Block Player"}</button>
        </div> : null}
      </div>
    </div>
    {reporting && onReportPlayer ? <CommunityReportPrompt
      targetLabel={`player ${profile.displayName}`}
      onSubmit={(category, explanation) => onReportPlayer(profile.playerId, category, explanation)}
      onCancel={() => setReporting(false)}
    /> : null}
  </section>;
}

export function mayInviteProfileToKingdom(
  profile: Pick<PublicProfile, "isSelf" | "kingdom">,
  eligibility: { allowed: boolean }
): boolean {
  return eligibility.allowed && !profile.isSelf && profile.kingdom === null;
}

export function CompactProfile({ profile, onExpand, onMessagePlayer, onOpenKingdom, selfActions = [] }: { profile: PublicProfile; selfActions?: readonly GamePromptAction[]; onExpand(): void; onMessagePlayer?(playerId: string, displayName: string, online: boolean): void; onOpenKingdom?(kingdomId: string): void }) {
  return <>
    <div className="selected-player-name">{profile.displayName}</div>
    <div className="selected-player-level">{["Level " + profile.level, profile.class?.name].filter(Boolean).join(" - ")}</div>
    <div className="selected-player-meta"><span>Kingdom</span><strong>{profile.kingdom?.name ?? "None"}{profile.kingdom?.memberRole ? ` · ${profile.kingdom.memberRole}` : ""}</strong></div>
    {profile.kingdom && onOpenKingdom ? <button type="button" className="profile-kingdom-link game-app-button game-app-button-compact" onClick={() => onOpenKingdom(profile.kingdom!.id)}>Open Kingdom</button> : null}
    <div className="selected-player-meta"><span>Home</span><strong>{profile.settlement?.name ?? "None"}</strong></div>
    {profile.settlement?.joinedAt ? <div className="selected-player-meta"><span>Joined</span><strong>{new Date(profile.settlement.joinedAt).toLocaleDateString()}</strong></div> : null}
    <div className="selected-player-actions">
      {profile.isSelf ? selfActions.map((action) => <button key={action.key} type="button" className="profile-primary game-app-button game-app-button-primary game-app-button-compact" onClick={action.onSelect}>{action.label}</button>) : null}
      <button type="button" className="profile-primary game-app-button game-app-button-primary game-app-button-compact" onClick={onExpand}>View Profile</button>
      {!profile.isSelf && onMessagePlayer && profile.relationship.friendship !== "blocked_by_viewer" && profile.relationship.friendship !== "unavailable" ? <button type="button" className="profile-primary game-app-button game-app-button-primary game-app-button-compact" onClick={() => onMessagePlayer(profile.playerId, profile.displayName, profile.presence === "online")}>Message</button> : null}
    </div>
  </>;
}

export function ProfileHeader({ profile, action }: { profile: PublicProfile; action?: ReactNode }) {
  return <header className="profile-header">
    <div>
      <span className="profile-eyebrow">{profile.title ?? "Adventurer"}</span>
      <h2><PresenceDot presence={profile.presence} />{profile.displayName}</h2>
    </div>
    {action}
  </header>;
}

export function ProfileSummary({ profile }: { profile: PublicProfile }) {
  return <p className="profile-summary" aria-label="Character summary">
    {profile.class ? `${profile.class.name} · ` : ""}Level {profile.level}{profile.legendRank ? ` · ${profile.legendRank}` : ""}{profile.folios ? ` · ${profile.folios.toLocaleString()} Folios` : ""}
  </p>;
}

/** Icon slots: Kingdom, City, Playing Since, and Last Seen (friends and self only). */
export function ProfileSlots({ profile, onOpenKingdom, now = Date.now() }: { profile: PublicProfile; onOpenKingdom?(kingdomId: string): void; now?: number }) {
  const kingdomLabel = profile.kingdom
    ? `${profile.kingdom.emblemKey ? `${profile.kingdom.emblemKey} · ` : ""}${profile.kingdom.name}${profile.kingdom.memberRole ? ` (${profile.kingdom.memberRole})` : ""}`
    : "None";
  const joinedCity = profile.settlement?.joinedAt ? `Joined city ${new Date(profile.settlement.joinedAt).toLocaleDateString()}` : undefined;
  const since = new Date(profile.playingSince ?? profile.createdAt);
  const lastSeen = profile.presence === "hidden"
    ? null
    : profile.presence === "online"
      ? "Online"
      : profile.lastSeenAt ? formatLastSeen(profile.lastSeenAt, now) : null;
  return <dl className="profile-slots profile-standing" aria-label="Standing">
    <div className={`profile-slot profile-slot--kingdom${profile.kingdom && onOpenKingdom ? " has-link" : ""}`}>
      <StatGlyph icon="kingdom" /><dt>Kingdom</dt>
      <dd>{kingdomLabel}{profile.kingdom && onOpenKingdom ? <button type="button" className="profile-inline-link" onClick={() => onOpenKingdom(profile.kingdom!.id)}>Open</button> : null}</dd>
    </div>
    <div className="profile-slot profile-slot--city" {...(joinedCity ? { title: joinedCity } : {})}>
      <StatGlyph icon="city" /><dt>City</dt><dd>{profile.settlement?.name ?? "None"}</dd>
    </div>
    <div className="profile-slot profile-slot--since" title={`Playing since ${since.toLocaleDateString()}`}>
      <StatGlyph icon="achievements" /><dt>Playing Since</dt><dd>{since.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</dd>
    </div>
    {lastSeen ? <div className="profile-slot profile-slot--seen">
      <StatGlyph icon="contacts" /><dt>Last Seen</dt><dd>{lastSeen}</dd>
    </div> : null}
  </dl>;
}

type ProfileConnectionTab = "friends" | "enemies" | "recent";

/** The viewed player's Friends and Enemies (plus Recent on your own profile). */
export function ProfilePlayerConnections({ api, profile, onOpenPlayer }: {
  api: Pick<ProfileApiClient, "listForPlayer" | "list" | "listRecent">;
  profile: PublicProfile;
  onOpenPlayer(playerId: string): void;
}) {
  const [tab, setTab] = useState<ProfileConnectionTab>("friends");
  const [list, setList] = useState<SocialListResponse | null>(null);
  const [recent, setRecent] = useState<RecentPlayersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setFailed(false);
    const request = tab === "recent"
      ? api.listRecent().then((next) => { if (current) setRecent(next); })
      : (profile.isSelf ? api.list(tab, 0, 50) : api.listForPlayer(profile.playerId, tab))
        .then((next) => { if (current) setList(next); });
    request.catch(() => { if (current) setFailed(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, profile.isSelf, profile.playerId, tab]);
  const tabs: Array<{ id: ProfileConnectionTab; label: string }> = [
    { id: "friends", label: "Friends" },
    { id: "enemies", label: "Enemies" },
    ...(profile.isSelf ? [{ id: "recent" as const, label: "Recent" }] : [])
  ];
  const entries = tab === "recent" ? null : list?.kind === tab ? list.entries : null;
  return <section className="profile-player-connections" aria-label={`${profile.displayName} connections`}>
    <GameAppTabs
      ariaLabel="Profile connections"
      variant="housed"
      activeTab={tab}
      tabs={tabs}
      onChange={(id) => setTab(id as ProfileConnectionTab)}
    />
    <div className="profile-player-connections-scroll">
      {tab === "recent"
        ? <RecentPlayersList list={recent} loading={loading} onOpenPlayer={onOpenPlayer} />
        : loading
          ? <div className="profile-loading game-app-state game-app-state-loading">Loading...</div>
          : failed
            ? <div className="profile-empty game-app-state game-app-state-empty">Unavailable.</div>
            : !entries || entries.length === 0
              ? <div className="profile-empty game-app-state game-app-state-empty">{tab === "friends" ? "No friends yet." : "No enemies."}</div>
              : <div className="social-list">
                  {entries.map((entry) => <div key={entry.playerId} className="social-list-row">
                    <button type="button" className="social-list-profile" onClick={() => onOpenPlayer(entry.playerId)}>
                      <span><strong><PresenceDot presence={entry.presence} />{entry.displayName}</strong><small>Level {entry.level}{entry.class ? ` · ${entry.class.name}` : ""}</small></span>
                    </button>
                  </div>)}
                </div>}
    </div>
  </section>;
}

/** The status line (stored as the profile biography). Hidden when empty. */
export function ProfileBiography({ biography }: { biography: string | null }) {
  if (!biography) return null;
  return <p className="profile-status" aria-label="Status">{biography}</p>;
}

export function ProfileStats({ profile }: { profile: PublicProfile }) {
  const stats = profile.stats;
  if (!stats) return null;
  const tiles: Array<{ key: string; value: string; label: string; title?: string }> = [
    { key: "gold", value: formatProfileCount(stats.gold), label: "Gold" },
    { key: "flags", value: formatProfileCount(stats.flags), label: "Flags" },
    { key: "oil-wells", value: formatProfileCount(stats.oilWells), label: "Oil Wells" },
    { key: "achievements", value: formatProfileCount(stats.achievements), label: "Achievements" },
    { key: "creatures", value: formatProfileCount(stats.creaturesHunted), label: "Creatures Hunted" },
    { key: "city-coins", value: formatProfileCount(stats.cityCoinsGiven), label: "City Coins", title: "City Coins given to cities" },
    { key: "kills", value: formatProfileCount(stats.kills), label: "Kills" },
    { key: "deaths", value: formatProfileCount(stats.deaths), label: "Deaths" },
    { key: "pvp-kills", value: formatProfileCount(stats.pvpKills), label: "PvP Kills" },
    ...(profile.pet ? [{
      key: "pet",
      value: `Lv ${profile.pet.level}`,
      label: profile.pet.name,
      title: `${PET_SPECIES_DEFINITIONS[profile.pet.species as PetSpeciesId]?.displayName ?? "Pet"} · ${profile.pet.name}`
    }] : [])
  ];
  return <dl className="profile-stats" aria-label="Stats">
    {tiles.map((tile) => <div key={tile.key} className={`profile-stat profile-stat--${tile.key}`} {...(tile.title ? { title: tile.title } : {})}>
      <dt>{tile.label}</dt>
      <dd>{tile.value}</dd>
    </div>)}
  </dl>;
}

export function ProfileWeeklyPlacements({ profile }: { profile: PublicProfile }) {
  const placements = profile.weeklyPlacements ?? [];
  const current = placements.filter((placement) => placement.week === "current");
  const previous = placements.filter((placement) => placement.week === "previous");
  if (current.length === 0 && previous.length === 0) return null;
  return <section className="profile-weekly" aria-label="Weekly rankings">
    {current.length > 0 ? <div className="profile-weekly-current">
      <span className="profile-weekly-label">This week</span>
      {current.map((placement) => <span key={placement.category} className="profile-chip profile-chip--rank">
        <strong>#{placement.rank}</strong> {placement.label}
      </span>)}
    </div> : null}
    {previous.length > 0 ? <p className="profile-weekly-previous">
      Last week: {previous.map((placement) => `#${placement.rank} ${placement.label}`).join(" · ")}
    </p> : null}
  </section>;
}

export function ProfileRecentAchievements({ profile, onOpen }: { profile: PublicProfile; onOpen?(): void }) {
  const achievements = profile.recentAchievements ?? [];
  if (achievements.length === 0) return null;
  return <section className="profile-achievements" aria-label="Recent achievements">
    {achievements.map((achievement) => {
      const content = <>
        <StatGlyph icon="achievements" />
        <span className="profile-achievement-name">{achievement.name}</span>
        <small>{new Date(achievement.unlockedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small>
      </>;
      return onOpen
        ? <button key={achievement.id} type="button" className="profile-achievement" onClick={onOpen}>{content}</button>
        : <div key={achievement.id} className="profile-achievement">{content}</div>;
    })}
  </section>;
}

/** Compact "3 min ago" style text for a friend's last-seen time. */
export function formatLastSeen(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently";
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export function formatProfileCount(value: number): string {
  return value >= 100_000
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
    : value.toLocaleString("en-US");
}

function relationshipMenuItems(relationship: PublicProfile["relationship"]): Array<{ action: SocialAction; label: string }> {
  if (relationship.enemyMarkedByViewer) {
    switch (relationship.neutralityRequest ?? "none") {
      case "outgoing": return [{ action: "cancel_neutrality", label: "Cancel Neutrality Request" }];
      case "incoming": return [
        { action: "accept_neutrality", label: "Accept Neutrality" },
        { action: "reject_neutrality", label: "Reject Neutrality" }
      ];
      case "none": return [{ action: "request_neutrality", label: "Request Neutrality" }];
    }
  }
  switch (relationship.friendship) {
    case "none": return [{ action: "send_friend_request", label: "Add Friend" }];
    case "outgoing_request": return [{ action: "cancel_friend_request", label: "Cancel Friend Request" }];
    case "friends": return [{ action: "remove_friend", label: "Remove Friend" }];
    case "incoming_request":
    case "blocked_by_viewer":
    case "unavailable":
      return [];
  }
}

export function FriendActions({ profile, busy, mutate }: { profile: PublicProfile; busy: boolean; mutate(action: SocialAction): Promise<void> }) {
  return <FriendRelationshipActions relationship={profile.relationship} busy={busy} mutate={mutate} />;
}

export function FriendRelationshipActions({ relationship, busy, mutate }: { relationship: PublicProfile["relationship"]; busy: boolean; mutate(action: SocialAction): Promise<void> }) {
  if (relationship.enemyMarkedByViewer) {
    switch (relationship.neutralityRequest ?? "none") {
      case "outgoing": return <><span className="profile-action-status" role="status">Neutrality Requested</span><button type="button" className="secondary game-app-button" disabled={busy} onClick={() => void mutate("cancel_neutrality")}>Cancel</button></>;
      case "incoming": return <><button type="button" className="primary game-app-button game-app-button-primary" disabled={busy} onClick={() => void mutate("accept_neutrality")}>Accept Neutrality</button><button type="button" className="secondary game-app-button" disabled={busy} onClick={() => void mutate("reject_neutrality")}>Reject</button></>;
      case "none": return <button type="button" className="secondary game-app-button" disabled={busy} onClick={() => void mutate("request_neutrality")}>Request Neutrality</button>;
    }
  }
  switch (relationship.friendship) {
    case "none": return <button type="button" className="primary game-app-button game-app-button-primary" disabled={busy} onClick={() => void mutate("send_friend_request")}>Add Friend</button>;
    case "outgoing_request": return <><span className="profile-action-status" role="status">Friend request sent</span><button type="button" className="secondary game-app-button" disabled={busy} onClick={() => void mutate("cancel_friend_request")}>Cancel Request</button></>;
    case "incoming_request": return <><button type="button" className="primary game-app-button game-app-button-primary" disabled={busy} onClick={() => void mutate("accept_friend_request")}>Accept Friend</button><button type="button" className="secondary game-app-button" disabled={busy} onClick={() => void mutate("decline_friend_request")}>Decline</button></>;
    case "friends": return <><span className="profile-action-status" role="status">Friends</span><button type="button" className="secondary game-app-button" disabled={busy} onClick={() => void mutate("remove_friend")}>Remove Friend</button></>;
    case "blocked_by_viewer": return <button type="button" className="secondary game-app-button" disabled={busy} onClick={() => void mutate("unblock")}>Unblock</button>;
    case "unavailable": return <div className="profile-unavailable-note">Relationship actions unavailable.</div>;
  }
}

export function SocialList({ list, kind, loading, busyPlayerId, onOpenPlayer, onMutate, onMessagePlayer, onSendGift, onOpenPlayerActions, partyInviteContext, onInviteParty }: {
  list: SocialListResponse | null;
  kind: SocialListKind;
  loading: boolean;
  busyPlayerId: string | null;
  onOpenPlayer(playerId: string): void;
  onMutate(playerId: string, action: SocialAction): Promise<void>;
  onMessagePlayer?(playerId: string, displayName: string, online: boolean): void;
  onSendGift?(playerId: string, displayName: string): void;
  onOpenPlayerActions?(
    player: Pick<RecentPlayerEntry, "playerId" | "displayName">,
    anchorRect: { left: number; right: number; top: number; bottom: number }
  ): void;
  partyInviteContext?: PartyInviteContext;
  onInviteParty?(playerId: string): boolean;
}) {
  if (loading) return <div className="profile-loading game-app-state game-app-state-loading">Loading list...</div>;
  if (!list || list.entries.length === 0) return <div className="profile-empty game-app-state game-app-state-empty">{emptyListLabel(kind)}</div>;
  return <div className="social-list">
    {list.entries.map((entry) => {
      const busy = busyPlayerId === entry.playerId;
      return <div key={entry.playerId} className="social-list-row">
        <button type="button" className="social-list-profile" onClick={() => onOpenPlayer(entry.playerId)}>
          <span><strong><PresenceDot presence={entry.presence} />{entry.displayName}</strong><small>Level {entry.level}{entry.class ? ` · ${entry.class.name}` : ""}</small></span>
        </button>
        <div className="social-list-actions">
          {kind === "friends" && onMessagePlayer ? <button type="button" className="social-list-action game-app-button game-app-button-compact" disabled={busy} onClick={() => onMessagePlayer(entry.playerId, entry.displayName, entry.presence === "online")}>Message</button> : null}
          {kind === "incoming_requests" ? <>
            <button type="button" className="social-list-action primary game-app-button game-app-button-primary game-app-button-compact" disabled={busy} onClick={() => void onMutate(entry.playerId, "accept_friend_request")} aria-label={`Accept friend request from ${entry.displayName}`}>Accept Friend</button>
            <button type="button" className="social-list-action game-app-button game-app-button-compact" disabled={busy} onClick={() => void onMutate(entry.playerId, "decline_friend_request")} aria-label={`Decline friend request from ${entry.displayName}`}>Decline</button>
          </> : null}
          {kind === "outgoing_requests" ? <button type="button" className="social-list-action game-app-button game-app-button-compact" disabled={busy} onClick={() => void onMutate(entry.playerId, "cancel_friend_request")}>Cancel Request</button> : null}
          {kind === "enemies" ? <FriendRelationshipActions relationship={entry.relationship} busy={busy} mutate={(action) => onMutate(entry.playerId, action)} /> : null}
          {kind === "blocked" ? <button type="button" className="social-list-action game-app-button game-app-button-compact" disabled={busy} onClick={() => void onMutate(entry.playerId, "unblock")}>Unblock</button> : null}
          {kind === "friends" && onOpenPlayerActions ? <button
            type="button"
            className="social-list-action game-app-button game-app-button-compact"
            aria-label={`More actions for ${entry.displayName}`}
            onClick={(event) => openRowActions(event.currentTarget, entry, onOpenPlayerActions)}
          >More</button> : null}
        </div>
      </div>;
    })}
  </div>;
}

export function RecentPlayersList({ list, loading, onOpenPlayer, onOpenPlayerActions, partyInviteContext, onInviteParty }: {
  list: RecentPlayersResponse | null;
  loading: boolean;
  onOpenPlayer(playerId: string): void;
  onOpenPlayerActions?(
    player: Pick<RecentPlayerEntry, "playerId" | "displayName">,
    anchorRect: { left: number; right: number; top: number; bottom: number }
  ): void;
  partyInviteContext?: PartyInviteContext;
  onInviteParty?(playerId: string): boolean;
}) {
  if (loading) return <div className="profile-loading game-app-state game-app-state-loading">Loading recent players...</div>;
  if (!list || list.entries.length === 0) return <div className="profile-empty game-app-state game-app-state-empty">Players you encounter nearby will appear here.</div>;
  return <div className="social-list recent-players-list" aria-label="Recent Players">
    {list.entries.map((entry) => <div key={entry.playerId} className="social-list-row recent-player-row">
      <button type="button" className="social-list-profile" onClick={() => onOpenPlayer(entry.playerId)}>
        <span className="recent-player-copy"><strong><PresenceDot presence={entry.presence} />{entry.displayName}</strong><small>{interactionLabel(entry.interactionType)} · {formatRelativeInteractionTime(entry.interactionAt)}</small></span>
      </button>
      <div className="social-list-actions">
        {onOpenPlayerActions ? <button type="button" className="social-list-action game-app-button game-app-button-compact" onClick={(event) => openRowActions(event.currentTarget, entry, onOpenPlayerActions)}>More</button> : null}
      </div>
    </div>)}
  </div>;
}

function PartyInviteButton({ targetPlayerId, relationship, context, busy = false, className = "social-list-action game-app-button game-app-button-compact", label = "Invite to Party", onInvite }: {
  targetPlayerId: string;
  relationship: PublicProfile["relationship"];
  context: PartyInviteContext;
  busy?: boolean;
  className?: string;
  label?: string;
  onInvite(): void;
}) {
  const availability = partyInviteAvailability(context, targetPlayerId, relationship);
  return <button type="button" className={className} disabled={busy || !availability.available} title={availability.reason ?? undefined} aria-label="Invite to Party" onClick={onInvite}>{label}</button>;
}

function openRowActions(
  button: HTMLButtonElement,
  player: Pick<RecentPlayerEntry, "playerId" | "displayName">,
  onOpenPlayerActions: NonNullable<SocialProfileOverlayProps["onOpenPlayerActions"]>
): void {
  const rect = button.getBoundingClientRect();
  onOpenPlayerActions(player, { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
}

function emptyListLabel(kind: SocialListKind): string {
  switch (kind) {
    case "friends": return "No friends yet.";
    case "incoming_requests": return "No incoming requests.";
    case "outgoing_requests": return "No sent requests.";
    case "enemies": return "No enemies recorded.";
    case "blocked": return "No blocked players.";
  }
}

export function formatRelativeInteractionTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Recently";
  const elapsedMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days > 30) return "30+ days ago";
  return `${days} days ago`;
}

function interactionLabel(type: RecentPlayerEntry["interactionType"]): string {
  switch (type) {
    case "nearby": return "Nearby";
    case "local_chat": return "Local chat";
    case "party": return "Party";
    case "trade": return "Trade";
  }
}

function PresenceDot({ presence }: { presence: PlayerPresenceState }) {
  if (presence === "hidden") return null;
  return <span className={`social-dot social-dot-${presenceClass(presence)}`} role="img" aria-label={presenceLabel(presence)} />;
}

function presenceLabel(presence: Exclude<PlayerPresenceState, "hidden">): string {
  switch (presence) {
    case "online": return "Online";
    case "recently_active": return "Active recently";
    case "offline": return "Offline";
  }
}

function presenceClass(presence: Exclude<PlayerPresenceState, "hidden">): string {
  return presence === "recently_active" ? "recently-active" : presence;
}

function unicodeLength(value: string): number { return Array.from(value).length; }
function limitUnicode(value: string, maximum: number): string { return Array.from(value).slice(0, maximum).join(""); }
