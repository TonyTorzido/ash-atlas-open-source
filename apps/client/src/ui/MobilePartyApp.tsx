import type {
  FlagAccessPlayerSearchResult,
  PartyCombatMemberSnapshot,
  PartyInviteSnapshot,
  PartyOutgoingInviteSnapshot,
  PartySnapshot,
  PlayerSnapshot,
  RecentPlayerEntry,
  SocialListEntry,
  ViewerRelationship
} from "@ash-atlas/shared";
import { PARTY_MEMBER_CAPACITY } from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { searchFlagAccessPlayers } from "../flags/flagAccess.js";
import { partyInviteAvailability, type PartyInviteContext } from "../party/partyInviteEligibility.js";
import { PartyCombatStore, usePartyCombatMember, usePartyCombatRoster } from "../party/partyCombatStore.js";
import type { ProfileApiClient } from "../profiles/profileClient.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import { GameAppButton, GameAppEmptyState, GameAppShell, GameAppState, GameAppTabs } from "./GameAppShell.js";
import { PhoneMenuFooterButtons } from "./PhoneMenuDestinationShell.js";

type ConfirmedAction =
  | { kind: "leave" }
  | { kind: "disband" }
  | { kind: "remove"; playerId: string; label: string }
  | { kind: "leader"; playerId: string; label: string };

type Props = {
  layout?: "desktop" | "phone";
  open: boolean;
  ownPlayerId: string;
  ownPlayerName: string;
  party: PartySnapshot | null;
  invites: readonly PartyInviteSnapshot[];
  outgoingInvites: readonly PartyOutgoingInviteSnapshot[];
  inviteContext?: PartyInviteContext;
  playerNames: Readonly<Record<string, string>>;
  visiblePlayers: readonly PlayerSnapshot[];
  connected: boolean;
  combatStore?: PartyCombatStore;
  profileApi?: ProfileApiClient;
  serverHttpBase?: string;
  onBack(): void;
  onCreate(): boolean;
  onInvite(playerId: string): boolean;
  onAccept(invitationId: string): boolean;
  onForward(invitationId: string): boolean;
  onDecline(invitationId: string): boolean;
  onCancelInvite(invitationId: string): boolean;
  onRemove(playerId: string): boolean;
  onLeave(): boolean;
  onDisband?(): boolean;
  onChangeLeader(playerId: string): boolean;
  onSetTravelAllowed(allowed: boolean): boolean;
  onSetAutoFollow(enabled: boolean): boolean;
  onTravelToLeader(): boolean;
  onStartReadyCheck?(): boolean;
  onCancelReadyCheck?(readyCheckId: string): boolean;
  onOpenMessages?(): void;
  onMessage(playerId: string, displayName: string): void;
  onViewProfile(playerId: string): void;
};

export function MobilePartyApp(props: Props): React.JSX.Element | null {
  const {
    layout = "phone",
    open, ownPlayerId, ownPlayerName, party, invites, outgoingInvites, inviteContext,
    playerNames, visiblePlayers, connected, combatStore, profileApi, serverHttpBase,
    onBack, onCreate, onInvite, onCancelInvite,
    onRemove, onLeave, onDisband, onChangeLeader, onSetTravelAllowed,
    onSetAutoFollow, onTravelToLeader, onStartReadyCheck, onCancelReadyCheck,
    onOpenMessages, onMessage, onViewProfile
  } = props;
  const [fallbackCombatStore] = useState(() => new PartyCombatStore());
  const activeCombatStore = combatStore ?? fallbackCombatStore;
  const combatRoster = usePartyCombatRoster(activeCombatStore);
  const [confirm, setConfirm] = useState<ConfirmedAction | null>(null);
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [recruitmentOpen, setRecruitmentOpen] = useState(false);
  const [recruitmentTab, setRecruitmentTab] = useState<"nearby" | "friends" | "recent" | "search">("nearby");
  const [friends, setFriends] = useState<SocialListEntry[]>([]);
  const [recent, setRecent] = useState<RecentPlayerEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FlagAccessPlayerSearchResult[]>([]);

  useEffect(() => {
    if (!open || !profileApi || recruitmentTab === "nearby" || recruitmentTab === "search") return;
    let cancelled = false;
    const request = recruitmentTab === "friends"
      ? profileApi.list("friends", 0, 25).then(({ entries }) => entries)
      : profileApi.listRecent(25).then(({ entries }) => entries);
    void request.then((entries) => {
      if (cancelled) return;
      if (recruitmentTab === "friends") setFriends(entries as SocialListEntry[]);
      else setRecent(entries as RecentPlayerEntry[]);
    }).catch(() => {
      if (!cancelled) setFeedback("Could not load recruitment suggestions.");
    });
    return () => { cancelled = true; };
  }, [open, profileApi, recruitmentTab]);

  useEffect(() => {
    if (!open || !serverHttpBase || recruitmentTab !== "search" || searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchFlagAccessPlayers(serverHttpBase, searchQuery.trim(), controller.signal)
        .then(setSearchResults)
        .catch(() => {
          if (!controller.signal.aborted) setFeedback("Player search is unavailable.");
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, recruitmentTab, searchQuery, serverHttpBase]);

  const candidates: Array<{ playerId: string; displayName: string; relationship: ViewerRelationship }> = (
    recruitmentTab === "nearby"
      ? visiblePlayers.filter((player) => player.online).map((player) => ({
          playerId: player.playerId,
          displayName: player.username,
          relationship: NEUTRAL_RELATIONSHIP
        }))
      : recruitmentTab === "friends"
        ? friends
        : recruitmentTab === "recent"
          ? recent
          : searchResults.map((player) => ({
              playerId: player.playerId,
              displayName: player.playerName,
              relationship: NEUTRAL_RELATIONSHIP
            }))
  ).filter((player) => player.playerId !== ownPlayerId);
  const isLeader = party?.leaderPlayerId === ownPlayerId;
  const memberCount = party?.memberPlayerIds.length ?? 0;
  const pendingInvites = invites.filter((invite) => invite.status === "pending");
  const playerName = (id: string): string => {
    if (id === ownPlayerId) return ownPlayerName || "You";
    return visiblePlayers.find((player) => player.playerId === id)?.username ?? playerNames[id] ?? "Unknown player";
  };
  const run = (action: () => boolean, failure: string): void => {
    setFeedback(action() ? null : failure);
  };

  const recruitmentPanel = <div className="phone-party-recruitment">
    <GameAppTabs
      variant="subtabs"
      ariaLabel="Party recruitment sources"
      activeTab={recruitmentTab}
      onChange={(tab) => setRecruitmentTab(tab as typeof recruitmentTab)}
      tabs={(["nearby", "friends", "recent", "search"] as const).map((tab) => ({
        id: tab,
        label: tab.charAt(0).toUpperCase() + tab.slice(1)
      }))}
    />
    {recruitmentTab === "search" ? <label>
      <span>Player name</span>
      <input value={searchQuery} placeholder="Search players" onChange={(event) => setSearchQuery(event.currentTarget.value)} />
    </label> : null}
    <div className="phone-party-candidate-list">
      {candidates.length === 0 ? <small>No eligible players found.</small> : candidates.map((candidate) => {
        const availability = partyInviteAvailability(inviteContext ?? {
          connected, inviterPlayerId: ownPlayerId, party, outgoingInvites, now: Date.now()
        }, candidate.playerId, candidate.relationship);
        return <GameAppButton
          type="button"
          key={candidate.playerId}
          className="phone-party-candidate"
          disabled={!availability.available}
          onClick={() => run(() => onInvite(candidate.playerId), `Could not invite ${candidate.displayName}.`)}
        >
          <span><strong>{candidate.displayName}</strong><small>{availability.reason ?? "Invite to party"}</small></span>
          <b>{availability.available ? "Invite" : "Unavailable"}</b>
        </GameAppButton>;
      })}
    </div>
  </div>;

  const confirmAction = (): void => {
    if (!confirm) return;
    if (confirm.kind === "leave") run(onLeave, "Could not leave the party.");
    else if (confirm.kind === "disband") run(() => onDisband?.() ?? false, "Could not disband the party.");
    else if (confirm.kind === "remove") run(() => onRemove(confirm.playerId), `Could not kick ${confirm.label} from the party.`);
    else run(() => onChangeLeader(confirm.playerId), `Could not make ${confirm.label} the leader.`);
    setConfirm(null);
  };

  return <>
    <GameAppShell
      open={open}
      title="Party"
      menuId="party"
      subtitle={party ? (isLeader ? "You lead this party" : `Led by ${playerName(party.leaderPlayerId)}`) : "Not in a party"}
      headerStatus={{ value: `${memberCount} / ${PARTY_MEMBER_CAPACITY}`, label: "Members" }}
      className="phone-party-layer"
      layout={layout}
      closeLabel="Close Party"
      closeDisabled={confirm !== null}
      showDesktopClose={false}
      onClose={onBack}
      footer={layout === "desktop" ? <PhoneMenuFooterButtons onBack={onBack} navigationDisabled={confirm !== null} /> : undefined}
    >
      <div className="phone-party-command-layout" inert={confirm ? true : undefined}>
        <main className="phone-party-command-main">
          <section className="phone-party-roster" aria-labelledby="party-roster-title">
            <header><h2 id="party-roster-title">Your party</h2><b className="game-app-count" aria-label={`${memberCount} of ${PARTY_MEMBER_CAPACITY} members`}>{memberCount} / {PARTY_MEMBER_CAPACITY}</b></header>
            <div className="phone-party-roster-list">
              {(party?.memberPlayerIds ?? []).map((memberId, slotIndex) => {
                const label = playerName(memberId);
                return <PartyMemberCommandRow
                  key={memberId}
                  store={activeCombatStore}
                  slotIndex={slotIndex}
                  playerId={memberId}
                  label={label}
                  ownPlayerId={ownPlayerId}
                  leader={memberId === party?.leaderPlayerId}
                  follows={party?.autoFollowPlayerIds.includes(memberId) ?? false}
                  expanded={activeMemberId === memberId}
                  connected={connected}
                  canManage={isLeader && memberId !== ownPlayerId}
                  onToggle={() => setActiveMemberId((current) => current === memberId ? null : memberId)}
                  onViewProfile={() => onViewProfile(memberId)}
                  onMessage={memberId === ownPlayerId ? undefined : () => onMessage(memberId, label)}
                  onMakeLeader={() => setConfirm({ kind: "leader", playerId: memberId, label })}
                  onRemove={() => setConfirm({ kind: "remove", playerId: memberId, label })}
                />;
              })}
            </div>
            <PartyRosterSummary memberCount={memberCount} hasParty={Boolean(party)} />
          </section>
          {party ? <ReadyCheckPanel
            readyCheck={combatRoster.readyCheck}
            isLeader={isLeader}
            connected={connected}
            onStart={() => run(() => onStartReadyCheck?.() ?? false, "Could not start the Ready Check.")}
            onCancel={() => run(() => onCancelReadyCheck?.(combatRoster.readyCheck!.readyCheckId) ?? false, "Could not cancel the Ready Check.")}
          /> : null}
        </main>

        <aside className="phone-party-command-rail" aria-label="Party commands">
          <section className="phone-party-command-section" aria-labelledby="party-invitations-title">
            <header><h2 id="party-invitations-title">Invitations</h2><b className="game-app-count">{outgoingInvites.length + pendingInvites.length}</b></header>
            {pendingInvites.length > 0 ? <GameAppButton
              type="button"
              variant="quiet" className="secondary phone-party-requests-link"
              onClick={onOpenMessages}
              disabled={!onOpenMessages}
            >View Requests in Messages{` (${pendingInvites.length})`}</GameAppButton> : null}
            {outgoingInvites.map((invite) => <div key={invite.targetPlayerId} className="game-app-row phone-party-outgoing-row">
              <span><strong>{playerName(invite.targetPlayerId)}</strong><small>{formatInviteExpiry(invite.expiresAt)}</small></span>
              <GameAppButton type="button" variant="quiet" className="secondary game-app-button-compact" disabled={!connected || !invite.invitationId} onClick={() => invite.invitationId
                ? run(() => onCancelInvite(invite.invitationId!), "Could not cancel the invitation.")
                : undefined}>Cancel</GameAppButton>
            </div>)}
            {pendingInvites.length === 0 && outgoingInvites.length === 0 ? <GameAppEmptyState>No pending invitations.</GameAppEmptyState> : null}
            {(!party || isLeader) && memberCount < PARTY_MEMBER_CAPACITY ? <GameAppButton
              type="button"
              variant="primary" className="phone-party-primary-action"
              disabled={!connected}
              aria-expanded={recruitmentOpen}
              onClick={() => setRecruitmentOpen((current) => !current)}
            >Invite Players</GameAppButton> : null}
            {recruitmentOpen ? recruitmentPanel : null}
            {!party ? <GameAppButton variant="quiet" className="phone-party-create" disabled={!connected} onClick={() => run(onCreate, "Could not create a party.")}>Create Party</GameAppButton> : null}
          </section>

          {party ? <section className="phone-party-command-section" aria-labelledby="party-settings-title">
            <header><h2 id="party-settings-title">Party Settings</h2></header>
            {isLeader ? <label className="phone-party-toggle">
              <span><strong>Allow Party Travel</strong><small>Members can travel to your destination.</small></span>
              <input type="checkbox" checked={party.allowTravel} disabled={!connected} onChange={(event) => run(() => onSetTravelAllowed(event.currentTarget.checked), "Could not update Party Travel.")} />
            </label> : <>
              <GameAppButton type="button" disabled={!connected || !party.allowTravel} onClick={() => run(onTravelToLeader, "Could not travel to the party leader.")}>Travel to Leader</GameAppButton>
              <label className="phone-party-toggle">
                <span><strong>Auto-Follow</strong><small>Follow future party travel.</small></span>
                <input type="checkbox" checked={party.autoFollowPlayerIds.includes(ownPlayerId)} disabled={!connected} onChange={(event) => run(() => onSetAutoFollow(event.currentTarget.checked), "Could not update Auto-Follow.")} />
              </label>
            </>}
          </section> : null}

          {party ? <section className="phone-party-command-section phone-party-command-danger" aria-labelledby="party-controls-title">
            <header><h2 id="party-controls-title">{isLeader ? "Leader Actions" : "Party Actions"}</h2></header>
            <GameAppButton type="button" variant="destructive" className="danger" disabled={!connected} onClick={() => setConfirm({ kind: "leave" })}>Leave Party</GameAppButton>
            {isLeader ? <GameAppButton type="button" variant="destructive" className="danger" disabled={!connected} onClick={() => setConfirm({ kind: "disband" })}>Disband Party</GameAppButton> : null}
          </section> : null}
        </aside>
      </div>
      {feedback ? <div className="phone-party-feedback" role="alert">{feedback}</div> : null}
      {confirm ? <div className="phone-party-confirmation-layer" role="presentation">
        <GameConfirmationPrompt
          title={confirm.kind === "leave" ? "Leave party?" : confirm.kind === "disband" ? "Disband party?" : confirm.kind === "remove" ? `Kick ${confirm.label}?` : "Transfer leadership?"}
          detail={confirm.kind === "leave"
            ? "You will leave the current party."
            : confirm.kind === "disband"
              ? "Every member will be removed and the party chat will close."
              : confirm.kind === "remove"
                ? `${confirm.label} will be removed from the party. They can be invited again.`
                : `${confirm.label} will become the party leader.`}
          confirmLabel={confirm.kind === "leave" ? "Leave Party" : confirm.kind === "disband" ? "Disband Party" : confirm.kind === "remove" ? "Kick from Party" : "Transfer"}
          destructive={confirm.kind !== "leader"}
          onCancel={() => setConfirm(null)}
          onConfirm={confirmAction}
        />
      </div> : null}
    </GameAppShell>
  </>;
}

/** Shared live roster example: unoccupied capacity is a summary, never placeholder rows. */
export function PartyRosterSummary({ memberCount, hasParty }: { memberCount: number; hasParty: boolean }): React.JSX.Element {
  return <div className="phone-party-roster-summary">
    {!hasParty ? <GameAppState title="Adventure together">Invite adventurers to travel and fight alongside you.</GameAppState> : null}
    <p>{memberCount < PARTY_MEMBER_CAPACITY ? `${PARTY_MEMBER_CAPACITY - memberCount} open ${PARTY_MEMBER_CAPACITY - memberCount === 1 ? "place" : "places"}` : "Party full"}<span>Up to {PARTY_MEMBER_CAPACITY} adventurers</span></p>
  </div>;
}

function PartyMemberCommandRow({
  store, slotIndex, playerId, label, ownPlayerId, leader, follows, expanded,
  connected, canManage, onToggle, onViewProfile, onMessage, onMakeLeader, onRemove
}: {
  store: PartyCombatStore;
  slotIndex: number;
  playerId: string;
  label: string;
  ownPlayerId: string;
  leader: boolean;
  follows: boolean;
  expanded: boolean;
  connected: boolean;
  canManage: boolean;
  onToggle(): void;
  onViewProfile(): void;
  onMessage?: (() => void) | undefined;
  onMakeLeader(): void;
  onRemove(): void;
}): React.JSX.Element {
  const member = usePartyCombatMember(store, playerId);
  const initials = label.split(/\s+/).map((part) => part.charAt(0)).join("").slice(0, 2).toUpperCase() || "?";
  const healthMax = Math.max(1, member?.maxHealth ?? 1);
  const healthCurrent = Math.max(0, Math.min(member?.currentHealth ?? 0, healthMax));
  return <article className={`phone-party-member-command${expanded ? " expanded" : ""}`}>
    <GameAppButton type="button" className="phone-party-member-command-main" aria-expanded={expanded} aria-label={`${label} actions`} onClick={onToggle}>
      <b className="phone-party-slot-number">{slotIndex + 1}</b>
      <span className="phone-party-avatar" aria-hidden="true">{initials}</span>
      <span className="phone-party-member-identity">
        <span><strong>{label}</strong>{leader ? <b>Leader</b> : null}{playerId === ownPlayerId ? <b>You</b> : null}</span>
        <small>{memberIdentity(member)}</small>
      </span>
      <span className="phone-party-vitals">
        {member ? <>
          <progress max={healthMax} value={healthCurrent} aria-label={`${label} health`} />
          <small>{healthCurrent} / {healthMax} HP · {memberStatus(member)}{follows ? " · Auto-Follow" : ""}</small>
        </> : <small>Combat status unavailable{leader ? " · Party Leader" : ""}</small>}
      </span>
      <span className="phone-party-more">{canManage ? "Manage" : playerId === ownPlayerId ? "Profile" : "More"}</span>
    </GameAppButton>
    {expanded ? <div className="phone-party-member-command-actions" aria-label={`Actions for ${label}`}>
      <GameAppButton type="button" variant="quiet" className="secondary" onClick={onViewProfile}>View Profile</GameAppButton>
      {onMessage ? <GameAppButton type="button" variant="quiet" className="secondary" onClick={onMessage}>Message</GameAppButton> : null}
      {canManage ? <>
        <GameAppButton type="button" variant="quiet" className="secondary" disabled={!connected} onClick={onMakeLeader}>Make Leader</GameAppButton>
        <GameAppButton type="button" variant="destructive" className="danger" disabled={!connected} onClick={onRemove}>Kick from Party</GameAppButton>
      </> : null}
    </div> : null}
  </article>;
}

function ReadyCheckPanel({
  readyCheck, isLeader, connected, onStart, onCancel
}: {
  readyCheck: ReturnType<typeof usePartyCombatRoster>["readyCheck"];
  isLeader: boolean;
  connected: boolean;
  onStart(): void;
  onCancel(): void;
}): React.JSX.Element {
  return <section className="phone-party-ready" aria-labelledby="party-ready-title">
    <div><span>Dungeon entry</span><h2 id="party-ready-title">Ready Check</h2><small>{readyCheck
      ? `${readyCheck.responses.filter(({ response }) => response === "ready").length}/${readyCheck.responses.length} ready · ${readyCheck.status}`
      : isLeader ? "Confirm the whole party before entering." : "The leader starts the check."}</small></div>
    {readyCheck && isLeader && readyCheck.status === "pending" ? <GameAppButton type="button" variant="quiet" className="secondary" disabled={!connected} onClick={onCancel}>Cancel Check</GameAppButton>
      : isLeader && !readyCheck ? <GameAppButton type="button" disabled={!connected} onClick={onStart}>Start Ready Check</GameAppButton> : null}
  </section>;
}

const NEUTRAL_RELATIONSHIP = {
  friendship: "none",
  enemyMarkedByViewer: false
} satisfies ViewerRelationship;

function memberIdentity(member: PartyCombatMemberSnapshot | null): string {
  const classLabel = member?.classId ? titleCase(member.classId.replaceAll("_", " ")) : "Adventurer";
  const roleLabel = member?.role ? titleCase(member.role) : "Flexible role";
  return `${classLabel} · ${roleLabel}`;
}

function memberStatus(member: PartyCombatMemberSnapshot): string {
  if (member.presence === "reconnecting") return "Reconnecting";
  if (member.presence === "offline") return "Offline";
  return member.worldRelation === "same_layer" ? "Same area" : "Away";
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatInviteExpiry(expiresAt: string): string {
  const remainingMs = Math.max(0, Date.parse(expiresAt) - Date.now());
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `Expires in ${remainingMinutes} min`;
}
