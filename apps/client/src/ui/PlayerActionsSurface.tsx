import type { SocialPlayerSummary } from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import { ProfileApiClient } from "../profiles/profileClient.js";
import {
  partyInviteAvailability,
  type PartyInviteContext
} from "../party/partyInviteEligibility.js";
import { GameActionPrompt, type GamePromptAction } from "./GameActionPrompt.js";

export type PlayerActionsTarget = {
  playerId: string;
  displayName: string;
  anchorRect: { left: number; right: number; top: number; bottom: number } | null;
};

type PlayerActionsSurfaceProps = {
  target: PlayerActionsTarget | null;
  ownPlayerId: string;
  layout: "desktop" | "phone";
  serverHttpBase: string;
  csrfToken: string;
  partyInviteContext: PartyInviteContext;
  refreshToken: number;
  travelInviteFeedback?: Readonly<{
    targetPlayerId: string;
    revision: number;
  }> | null;
  travelInvitePending?: boolean;
  travelInviteCooldownUntil?: number | null;
  travelInviteServerOffsetMs?: number;
  /** The strike-block rule between the viewer and this player (can attack: yes/no and why), already formatted. */
  pvpStatusLabel?: string | null;
  onMessage(playerId: string, displayName: string, online?: boolean): void;
  onSendTravelInvite(playerId: string): boolean;
  onViewProfile(playerId: string): void;
  onInviteParty(playerId: string): boolean;
  onSendGift?(playerId: string, displayName: string): void;
  onClose(): void;
};

export function PlayerActionsSurface({
  target,
  ownPlayerId,
  layout,
  serverHttpBase,
  csrfToken,
  partyInviteContext,
  refreshToken,
  travelInviteFeedback = null,
  travelInvitePending = false,
  travelInviteCooldownUntil = null,
  travelInviteServerOffsetMs = 0,
  pvpStatusLabel = null,
  onMessage,
  onSendTravelInvite,
  onViewProfile,
  onInviteParty,
  onSendGift,
  onClose
}: PlayerActionsSurfaceProps): React.JSX.Element | null {
  const api = useMemo(
    () => new ProfileApiClient(serverHttpBase, csrfToken),
    [csrfToken, serverHttpBase]
  );
  const [summary, setSummary] = useState<SocialPlayerSummary | null>(null);
  const [busyAction, setBusyAction] = useState<"party" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [travelInviteSent, setTravelInviteSent] = useState(false);
  const [travelInviteClock, setTravelInviteClock] = useState(() => Date.now());
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setSummary(null);
    setError(null);
    setBusyAction(null);
    setTravelInviteSent(false);
    if (!target || target.playerId === ownPlayerId) return;
    void api.getSocialPlayer(target.playerId).then((next) => {
      if (generation === requestGeneration.current) setSummary(next);
    }).catch((reason: unknown) => {
      if (generation === requestGeneration.current) {
        setError(reason instanceof Error ? reason.message : "Player actions unavailable");
      }
    });
    return () => { requestGeneration.current += 1; };
  }, [api, ownPlayerId, refreshToken, target]);

  useEffect(() => {
    if (!target || travelInviteFeedback?.targetPlayerId !== target.playerId) return;
    setTravelInviteSent(true);
    const timer = window.setTimeout(() => setTravelInviteSent(false), 1_000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [target, travelInviteFeedback]);

  useEffect(() => {
    setTravelInviteClock(Date.now());
    if (
      travelInviteCooldownUntil === null ||
      travelInviteCooldownUntil <= Date.now() + travelInviteServerOffsetMs
    ) return;
    const timer = window.setInterval(() => setTravelInviteClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [travelInviteCooldownUntil, travelInviteServerOffsetMs]);

  if (!target) return null;
  const self = target.playerId === ownPlayerId;
  const displayName = summary?.displayName ?? target.displayName;
  const relationshipUnavailable = !summary ||
    summary.relationship.friendship === "blocked_by_viewer" ||
    summary.relationship.friendship === "unavailable";
  const partyInvite = summary
    ? partyInviteAvailability(partyInviteContext, target.playerId, summary.relationship)
    : { available: false, reason: null };
  const travelInviteCooldownSeconds = travelInviteCooldownUntil === null
    ? 0
    : Math.max(0, Math.ceil(
      (travelInviteCooldownUntil - (travelInviteClock + travelInviteServerOffsetMs)) / 1_000
    ));
  const actions: GamePromptAction[] = [];
  if (!self) {
    actions.push({
      key: "message",
      label: "Send Message",
      enabled: !relationshipUnavailable,
      onSelect: () => onMessage(target.playerId, displayName, summary?.presence === "online")
    }, {
      key: "travel-invite",
      label: travelInviteCooldownSeconds > 0
        ? `Travel Invite in ${travelInviteCooldownSeconds}s`
        : "Travel Invite",
      enabled: !relationshipUnavailable && travelInviteCooldownSeconds === 0,
      busy: travelInvitePending,
      onSelect: () => {
        setError(null);
        if (!onSendTravelInvite(target.playerId)) {
          setError("Cannot send a Travel Invite while disconnected.");
        }
      }
    });
  }
  if (!self && onSendGift && !relationshipUnavailable) {
    actions.push({
      key: "gift",
      label: "Send Gift",
      onSelect: () => onSendGift(target.playerId, displayName)
    });
  }
  actions.push({
    key: "profile",
    label: "View Profile",
    onSelect: () => onViewProfile(target.playerId)
  });
  if (!self) {
    actions.push({
      key: "party-invite",
      label: "Invite to Party",
      enabled: partyInvite.available && !relationshipUnavailable && busyAction === null,
      busy: busyAction === "party",
      disabledReason: partyInvite.reason,
      onSelect: () => {
        setBusyAction("party");
        if (!onInviteParty(target.playerId)) {
          setError("Could not send the party invitation.");
          setBusyAction(null);
          return;
        }
        onClose();
      }
    });
  }

  return (
    <div
      className={`player-actions-scrim player-actions-scrim-${layout}`}
      onPointerDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        className="player-actions-prompt-stack"
        data-travel-invite-sent={travelInviteSent ? "true" : "false"}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {travelInviteSent ? <div className="player-actions-success" role="status">Invite Sent</div> : null}
        <GameActionPrompt
          title={displayName}
          category="PLAYER"
          detail={[
            !self && summary && summary.presence !== "hidden"
              ? summary.presence === "online"
                ? "Online"
                : summary.presence === "recently_active"
                  ? "Recently Active"
                  : "Offline"
              : null,
            self ? null : pvpStatusLabel
          ].filter(Boolean).join(" · ") || null}
          message={error ? { text: error, tone: "error" } : null}
          actions={actions}
          ariaLabel={`Actions for ${displayName}`}
          elevated
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
