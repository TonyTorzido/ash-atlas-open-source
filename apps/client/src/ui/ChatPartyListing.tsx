import {
  CHAT_PARTY_LISTING_DUNGEON_IDS,
  CHAT_PARTY_LISTING_TARGET_SIZE,
  SPECIALIZATION_DEFINITIONS,
  chatPartyListingDungeonName,
  chatPartyListingExpired,
  chatPartyListingRequiredLevel,
  type ChatPartyJoinRequest,
  type ChatPartyListing,
  type ChatPartyListingDungeonId,
  type ChatPartyListingInput,
  type ChatPartyListingKind,
  type ChatPartyListingState,
  type SpecializationId
} from "@ash-atlas/shared";
import { useState } from "react";

import { classIconProps } from "./ClassIcons.js";
import { GameActionPrompt, GamePromptButton } from "./GameActionPrompt.js";
import { ProgressionIcon } from "./ProgressionIcon.js";

/** Entrance art for the party-finder dungeons that have it; the rest show their initial. */
const DUNGEON_ART: Partial<Record<ChatPartyListingDungeonId, string>> = {
  fangrock_cavern: "/assets/dungeons/shared/orc-cave-entrance.png",
  the_eyrie: "/assets/dungeons/the_eyrie/entrance.png",
  blightwood_grove: "/assets/dungeons/blightwood_grove/entrance.png",
  still_hand_monastery: "/assets/dungeons/still_hand_monastery/entrance.png",
  drowned_city: "/assets/dungeons/drowned_city/entrance.png",
  golem_forge: "/assets/dungeons/golem_forge/entrance.png"
};

export type ChatPartyRole = "none" | "leader" | "member";

function DungeonArt({ dungeonId }: Readonly<{ dungeonId: ChatPartyListingDungeonId }>): React.JSX.Element {
  const src = DUNGEON_ART[dungeonId];
  const name = chatPartyListingDungeonName(dungeonId);
  return src
    ? <img className="chat-party-listing-art" src={src} alt="" loading="lazy" draggable={false} />
    : <span className="chat-party-listing-art chat-party-listing-art-empty" aria-hidden="true">{name.replace(/^The /u, "").charAt(0)}</span>;
}

function className(classId: SpecializationId | null | undefined): string | null {
  return classId ? SPECIALIZATION_DEFINITIONS[classId]?.displayName ?? null : null;
}

function ClassLine({ classId, level }: Readonly<{ classId: SpecializationId | null | undefined; level: number | undefined }>): React.JSX.Element {
  const name = className(classId);
  return (
    <span className="chat-party-listing-class">
      {classId ? <ProgressionIcon alt="" size={18} {...classIconProps(classId)} /> : null}
      {[name, level ? `Level ${level}` : null].filter(Boolean).join(" · ")}
    </span>
  );
}

/** Hunting card: "Have [Dungeon]" with Join, or "Looking for [Dungeon]" with Invite. */
export function ChatPartyListingCard({
  listing,
  state,
  createdAt,
  own,
  confirmed,
  ownLevel,
  partyRole,
  onJoin,
  onInvite,
  onClose
}: Readonly<{
  listing: ChatPartyListing;
  state: ChatPartyListingState | undefined;
  createdAt: string;
  own: boolean;
  confirmed: boolean;
  ownLevel: number | null;
  partyRole: ChatPartyRole;
  onJoin?: (() => void) | undefined;
  onInvite?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}>): React.JSX.Element {
  const dungeon = chatPartyListingDungeonName(listing.dungeonId);
  const status = state?.status ?? (chatPartyListingExpired(createdAt) || listing.cancelled ? "closed" : "open");
  const requiredLevel = chatPartyListingRequiredLevel(listing.dungeonId);
  const underLevel = ownLevel !== null && ownLevel < requiredLevel;
  const leader = listing.kind === "leader";
  const memberCount = Math.max(1, state?.memberCount ?? 1);
  let action: React.ReactNode = null;
  if (status !== "open") {
    action = <span className="chat-party-listing-status">{status === "full" ? "Party full" : "Closed"}</span>;
  } else if (!confirmed) {
    action = null;
  } else if (own) {
    action = onClose
      ? <button type="button" className="game-app-button game-app-button-compact chat-trade-listing-message" onClick={onClose}>Close</button>
      : null;
  } else if (leader && onJoin) {
    action = (
      <span className="chat-party-listing-action">
        <button
          type="button"
          className="game-app-button game-app-button-compact chat-trade-listing-message"
          disabled={underLevel}
          onClick={onJoin}
        >
          Join
        </button>
        {underLevel ? <small>Requires level {requiredLevel}</small> : null}
      </span>
    );
  } else if (!leader && onInvite && partyRole !== "member") {
    action = <button type="button" className="game-app-button game-app-button-compact chat-trade-listing-message" onClick={onInvite}>Invite</button>;
  }
  return (
    <div className={`chat-trade-listing chat-party-listing chat-party-listing-${listing.kind}${status === "open" ? "" : " chat-party-listing-inactive"}`}>
      <DungeonArt dungeonId={listing.dungeonId} />
      <div className="chat-trade-listing-text">
        <strong>{leader ? `Have ${dungeon}` : `Looking for ${dungeon}`}</strong>
        {leader ? (
          <span>
            <b className="chat-trade-listing-kind">LFG</b>
            {` Looking for party (${Math.min(memberCount, CHAT_PARTY_LISTING_TARGET_SIZE)}/${CHAT_PARTY_LISTING_TARGET_SIZE})`}
          </span>
        ) : (
          <ClassLine classId={listing.classId} level={listing.level} />
        )}
      </div>
      {action}
    </div>
  );
}

/** Leader view, at the end of Party chat: who asked to join, View profile, Accept / Decline. */
export function ChatPartyJoinRequestCard({ request, busy, onView, onAccept, onDecline }: Readonly<{
  request: ChatPartyJoinRequest;
  busy: boolean;
  onView(): void;
  onAccept(): void;
  onDecline(): void;
}>): React.JSX.Element {
  return (
    <div className="chat-party-request" role="group" aria-label={`${request.requesterName} asks to join`}>
      <div className="chat-trade-listing chat-party-listing chat-party-listing-request">
        <DungeonArt dungeonId={request.dungeonId} />
        <div className="chat-trade-listing-text">
          <strong>{request.requesterName} asks to join</strong>
          <ClassLine classId={request.classId} level={request.level} />
          <span className="chat-party-request-dungeon">{chatPartyListingDungeonName(request.dungeonId)}</span>
        </div>
        <button type="button" className="game-app-button game-app-button-compact chat-trade-listing-message" onClick={onView}>View</button>
      </div>
      <div className="chat-party-request-actions">
        <GamePromptButton tone="secondary" disabled={busy} onClick={onDecline}>Decline</GamePromptButton>
        <GamePromptButton tone="primary" disabled={busy} onClick={onAccept}>Accept</GamePromptButton>
      </div>
    </div>
  );
}

/** Composer flow: Have a party / Looking for a party → dungeon → post. */
export function ChatPartyListingComposer({ ownLevel, onPost, onClose }: Readonly<{
  ownLevel: number | null;
  onPost(listing: ChatPartyListingInput): boolean;
  onClose(): void;
}>): React.JSX.Element {
  const [kind, setKind] = useState<ChatPartyListingKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (kind === null) {
    return <GameActionPrompt
      modal
      movable={false}
      elevated
      title="Party Finder"
      ariaLabel="Post a party card"
      actions={[
        { key: "seeker", label: "Find a Party", tone: "secondary", onSelect: () => setKind("seeker") },
        { key: "leader", label: "Have a Party", onSelect: () => setKind("leader") }
      ]}
      onCancel={onClose}
    />;
  }
  return <GameActionPrompt
    modal
    movable={false}
    elevated
    title="Choose Dungeon"
    category={kind === "leader" ? "Looking for party" : "Looking for a group"}
    ariaLabel="Choose a dungeon"
    message={error ? { text: error, tone: "error" } : null}
    content={<div className="gift-compose trade-listing-compose">
      <div className="gift-compose-picker chat-party-dungeon-picker">
        {CHAT_PARTY_LISTING_DUNGEON_IDS.map((dungeonId) => {
          const required = chatPartyListingRequiredLevel(dungeonId);
          const locked = kind === "seeker" && ownLevel !== null && ownLevel < required;
          return <button type="button" key={dungeonId} className="gift-compose-pick" disabled={locked}
            onClick={() => {
              if (onPost({ kind, dungeonId })) onClose();
              else setError("You are offline. Reconnect to post this card.");
            }}>
            <DungeonArt dungeonId={dungeonId} />
            <span><strong>{chatPartyListingDungeonName(dungeonId)}</strong>
              <small>{required > 1 ? `Level ${required}+` : "Any level"}</small></span>
          </button>;
        })}
      </div>
    </div>}
    actions={[]}
    cancelLabel="Back"
    onCancel={() => { setKind(null); setError(null); }}
  />;
}
