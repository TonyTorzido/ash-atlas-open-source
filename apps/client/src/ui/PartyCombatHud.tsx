import {
  FRIENDLY_TARGET_RANGE_M,
  type PartyInviteSnapshot,
  type PartySnapshot
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { useUiPresentation } from "../uiEnvironment.js";
import {
  type PartyCombatStore,
  usePartyCombatMember,
  usePartyCombatRoster
} from "../party/partyCombatStore.js";
import { PartyGlyphPaths } from "./PartyGlyph.js";

type Props = {
  store: PartyCombatStore;
  party: PartySnapshot | null;
  ownPlayerId: string;
  selectedPlayerId: string;
  hidden: boolean;
  connected: boolean;
  synchronizedNow?(): number;
  onSetTravelAllowed(allowed: boolean): boolean;
  onSetAutoFollow(enabled: boolean): boolean;
  onTravelToLeader(): boolean;
  onSelectPlayer(playerId: string | null): void;
  onRespondReadyCheck(readyCheckId: string, response: "ready" | "not_ready"): boolean;
};

export function PartyCombatHud({
  store,
  party,
  ownPlayerId,
  selectedPlayerId,
  hidden,
  connected,
  synchronizedNow = Date.now,
  onSetTravelAllowed,
  onSetAutoFollow,
  onTravelToLeader,
  onSelectPlayer,
  onRespondReadyCheck
}: Props): React.JSX.Element {
  const roster = usePartyCombatRoster(store);
  const storageKey = `ash-atlas:party-hud-collapsed:${ownPlayerId}`;
  const [collapsed, setCollapsed] = useState(() => readCollapsedPreference(storageKey));
  const [serverNow, setServerNow] = useState(() => synchronizedNow());
  useEffect(() => {
    const update = (): void => setServerNow(synchronizedNow());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [synchronizedNow]);
  const [pendingSetting, setPendingSetting] = useState<{
    kind: "travel" | "auto";
    expected: boolean;
  } | null>(null);
  const pendingSettingRef = useRef(false);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, collapsed ? "1" : "0");
    } catch {
      // A denied storage write must not make the combat HUD unusable.
    }
  }, [collapsed, storageKey]);
  useEffect(() => {
    if (!pendingSetting) {
      pendingSettingRef.current = false;
      return;
    }
    const authoritativeValue = pendingSetting.kind === "travel"
      ? party?.allowTravel
      : party?.autoFollowPlayerIds.includes(ownPlayerId);
    if (authoritativeValue === pendingSetting.expected) {
      pendingSettingRef.current = false;
      setPendingSetting(null);
      return;
    }
    const timer = window.setTimeout(() => {
      pendingSettingRef.current = false;
      setPendingSetting(null);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [ownPlayerId, party, pendingSetting]);
  const memberIds = useMemo(() => {
    const ids = roster.memberPlayerIds.filter((playerId) => playerId !== ownPlayerId);
    const leaderPlayerId = party?.leaderPlayerId;
    if (!leaderPlayerId || leaderPlayerId === ownPlayerId || !ids.includes(leaderPlayerId)) {
      return ids.slice(0, 4);
    }
    return [leaderPlayerId, ...ids.filter((playerId) => playerId !== leaderPlayerId)].slice(0, 4);
  }, [ownPlayerId, party?.leaderPlayerId, roster.memberPlayerIds]);
  const totalMemberCount = roster.memberPlayerIds.length;
  const readyCheck = roster.readyCheck;
  const ownReadyResponse = readyCheck?.responses.find(
    ({ playerId }) => playerId === ownPlayerId
  )?.response;
  const readyCount = readyCheck?.responses.filter(({ response }) => response === "ready").length ?? 0;
  const isLeader = party?.leaderPlayerId === ownPlayerId;
  const autoFollowEnabled = party?.autoFollowPlayerIds.includes(ownPlayerId) ?? false;
  const settingKind = isLeader ? "travel" : "auto";
  const settingChecked = isLeader ? party?.allowTravel ?? false : autoFollowEnabled;

  return (
    <aside
      className={`party-combat-hud${collapsed ? " is-collapsed" : ""}`}
      aria-label="Party combat status"
      aria-hidden={hidden}
      hidden={hidden}
      inert={hidden}
    >
      <button
        type="button"
        className={`party-hud-launcher legacy-control-button${collapsed ? "" : " is-panel-open"}`}
        aria-label={collapsed
          ? `Expand party HUD, ${memberIds.length} other ${memberIds.length === 1 ? "member" : "members"}`
          : "Collapse party HUD"}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((current) => !current)}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <PartyGlyphPaths />
        </svg>
        {collapsed && totalMemberCount > 1 ? (
          <span className="party-hud-launcher-count" aria-hidden="true">{totalMemberCount}</span>
        ) : null}
      </button>
      <div className="party-hud-panel" aria-hidden={collapsed} inert={collapsed}>
        <header className="party-combat-hud-header">
          <span className="party-hud-title">
            <strong>Party</strong>
            <small aria-label={`${totalMemberCount} of 5 party members`}>{totalMemberCount}/5</small>
            {roster.stale ? <i>Syncing…</i> : null}
          </span>
          <label className="party-hud-switch">
            <span>{isLeader ? "ALLOW JUMP" : "AUTO"}</span>
            <input
              type="checkbox"
              role="switch"
              aria-label={isLeader
                ? "Allow party members to jump to you"
                : "Automatically jump to the party leader"}
              checked={settingChecked}
              disabled={!connected || pendingSetting !== null}
              onChange={(event) => {
                if (pendingSettingRef.current) return;
                const expected = event.currentTarget.checked;
                const sent = isLeader
                  ? onSetTravelAllowed(expected)
                  : onSetAutoFollow(expected);
                if (sent) {
                  pendingSettingRef.current = true;
                  setPendingSetting({ kind: settingKind, expected });
                }
              }}
            />
          </label>
        </header>
        <div className="party-combat-roster" data-member-count={memberIds.length}>
          {memberIds.map((playerId) => (
            <PartyCombatMemberRow
              key={playerId}
              store={store}
              playerId={playerId}
              ownPlayerId={ownPlayerId}
              leaderPlayerId={party?.leaderPlayerId ?? null}
              selected={selectedPlayerId === playerId}
              connected={connected}
              travelAllowed={party?.allowTravel ?? false}
              hidden={hidden}
              readyResponse={readyCheck?.responses.find(
                (response) => response.playerId === playerId
              )?.response ?? null}
              serverNow={serverNow}
              onSelect={onSelectPlayer}
              onTravelToLeader={onTravelToLeader}
            />
          ))}
        </div>
        {readyCheck ? (
          <section className={`party-ready-check is-${readyCheck.status}`} aria-live="polite">
            <strong>{readyCheck.status === "pending" ? "Ready check" : `Ready check ${readyCheck.status}`}</strong>
            <span>{readyCount}/{readyCheck.responses.length} ready</span>
            {readyCheck.status === "pending" && ownReadyResponse === "pending" ? (
              <div>
                <button
                  type="button"
                  disabled={!connected}
                  onClick={() => onRespondReadyCheck(readyCheck.readyCheckId, "ready")}
                >
                  Ready
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!connected}
                  onClick={() => onRespondReadyCheck(readyCheck.readyCheckId, "not_ready")}
                >
                  Not Ready
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function PartyCombatMemberRow({
  store,
  playerId,
  ownPlayerId,
  leaderPlayerId,
  selected,
  connected,
  travelAllowed,
  hidden,
  readyResponse,
  serverNow,
  onSelect,
  onTravelToLeader
}: {
  store: PartyCombatStore;
  playerId: string;
  ownPlayerId: string;
  leaderPlayerId: string | null;
  selected: boolean;
  connected: boolean;
  travelAllowed: boolean;
  hidden: boolean;
  readyResponse: "pending" | "ready" | "not_ready" | null;
  serverNow: number;
  onSelect(playerId: string | null): void;
  onTravelToLeader(): boolean;
}): React.JSX.Element | null {
  const member = usePartyCombatMember(store, playerId);
  const pointerStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const lastLeaderTap = useRef<{ at: number; x: number; y: number } | null>(null);
  const travelPendingUntil = useRef(0);
  useEffect(() => {
    if (!hidden && connected && travelAllowed) return;
    pointerStart.current = null;
    lastLeaderTap.current = null;
    travelPendingUntil.current = 0;
  }, [connected, hidden, travelAllowed]);
  if (!member) return null;
  const healthPercent = Math.max(
    0,
    Math.min(100, Math.round((member.currentHealth / member.maxHealth) * 100))
  );
  const ward = Math.max(0, member.ward ?? 0);
  const wardPercent = Math.min(100, ward / member.maxHealth * 100);
  const wardLeftPercent = Math.min(healthPercent, Math.max(0, 100 - wardPercent));
  const outOfRange = member.worldRelation === "same_layer"
    && member.distanceMeters !== undefined
    && member.distanceMeters > FRIENDLY_TARGET_RANGE_M;
  const abnormalStateLabels = [
    member.presence === "offline"
      ? "Offline"
      : member.presence === "reconnecting"
        ? "Reconnecting"
        : null,
    member.lifeState === "downed"
      ? `Downed${member.downedUntil ? ` · ${formatRemaining(member.downedUntil, serverNow)}` : ""}`
      : member.lifeState === "defeated"
      ? "Dead"
      : member.lifeState === "respawning"
        ? "Respawning"
        : null,
    member.worldRelation === "different_area"
      ? "Away"
      : outOfRange
        ? "Out"
        : null
  ].filter((label): label is string => label !== null);
  const stateLabel = abnormalStateLabels.slice(0, 2).join(" · ");
  const classLabel = member.classId
    ? member.classId.charAt(0).toUpperCase() + member.classId.slice(1)
    : "Adventurer";
  const roleLabel = member.role ? titleCase(member.role) : "No role";
  const distanceLabel = member.worldRelation === "different_area"
    ? "different area"
    : member.distanceMeters === undefined
      ? "distance unknown"
      : `${Math.round(member.distanceMeters)} meters away`;
  const readyDetail = readyResponse
    ? `, ready check ${readyLabel(readyResponse, member.presence)}`
    : "";
  const accessibleLabel = `Target ${member.displayName}, ${classLabel}, ${roleLabel}, ${healthPercent}% health${ward > 0 ? `, ${ward} Ward` : ""}, ${distanceLabel}${stateLabel ? `, ${stateLabel}` : ""}${readyDetail}`;
  const leaderJumpHint = useUiPresentation() === "desktop" ? "Double-click the leader to jump" : "Double-tap the leader to jump";
  const canDoubleTapTravel = playerId === leaderPlayerId
    && playerId !== ownPlayerId
    && connected
    && travelAllowed;
  const handleLeaderPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!canDoubleTapTravel) {
      pointerStart.current = null;
      lastLeaderTap.current = null;
      return;
    }
    const point = pointerPoint(event);
    pointerStart.current = point;
  };
  const handleLeaderPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const start = pointerStart.current;
    pointerStart.current = null;
    const point = pointerPoint(event);
    if (!canDoubleTapTravel || !start || start.pointerId !== point.pointerId) return;
    if (distance(start.x, start.y, point.x, point.y) > 10) {
      lastLeaderTap.current = null;
      return;
    }
    const now = Date.now();
    const previous = lastLeaderTap.current;
    if (
      previous
      && now - previous.at >= 0
      && now - previous.at <= 325
      && distance(previous.x, previous.y, point.x, point.y) <= 12
    ) {
      lastLeaderTap.current = null;
      if (now < travelPendingUntil.current) return;
      if (onTravelToLeader()) {
        travelPendingUntil.current = now + 5_000;
        window.setTimeout(() => {
          travelPendingUntil.current = 0;
        }, 5_000);
      }
      return;
    }
    lastLeaderTap.current = { at: now, x: point.x, y: point.y };
  };
  return (
    <button
      type="button"
      className={[
        "party-combat-member",
        selected ? "is-selected" : "",
        `is-${member.presence}`,
        healthPercent <= 35 ? "is-low-health" : "",
        member.lifeState === "defeated" ? "is-dead" : "",
        member.lifeState === "downed" ? "is-downed" : "",
        member.worldRelation === "different_area" ? "is-away" : "",
        outOfRange ? "is-out-of-range" : "",
        canDoubleTapTravel ? "can-jump" : ""
      ].filter(Boolean).join(" ")}
      aria-pressed={selected}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      onPointerDown={playerId === leaderPlayerId ? handleLeaderPointerDown : undefined}
      onPointerUp={playerId === leaderPlayerId ? handleLeaderPointerUp : undefined}
      onPointerCancel={() => {
        pointerStart.current = null;
        lastLeaderTap.current = null;
      }}
      onClick={() => {
        onSelect(selected ? null : playerId);
      }}
    >
      <span className={`party-class-sigil class-${member.classId ?? "none"}`} aria-hidden="true">
        {classLabel.charAt(0)}
      </span>
      <span className="party-member-copy">
        <span className="party-member-name">
          <strong>
            {member.displayName}{playerId === ownPlayerId ? " (You)" : ""}
          </strong>
          {playerId === leaderPlayerId ? <b title="Party leader">L</b> : null}
          {canDoubleTapTravel ? (
            <i
              className="party-leader-travel-icon"
              title={leaderJumpHint}
              aria-label={leaderJumpHint}
            >
              ↗
            </i>
          ) : null}
          {stateLabel ? <small>{stateLabel}</small> : null}
        </span>
        <span className="party-health-track" aria-hidden="true">
          <i style={{ width: `${healthPercent}%` }} />
          {ward > 0 ? <b className="party-ward-fill" style={{ left: `${wardLeftPercent}%`, width: `${wardPercent}%` }} /> : null}
        </span>
      </span>
      {member.priorityEffects?.length ? (
        <span className="party-priority-effects" aria-label="Priority effects">
          {member.priorityEffects.slice(0, 2).map((effect) => (
            <i key={effect.id} className={`is-${effect.tone}`} title={effect.label}>
              {effect.label.charAt(0)}
            </i>
          ))}
        </span>
      ) : null}
    </button>
  );
}

function formatRemaining(endsAt: number, serverNow: number): string {
  return `${Math.max(0, Math.ceil((endsAt - serverNow) / 1_000))}s`;
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

function pointerPoint(event: ReactPointerEvent<HTMLElement>): {
  pointerId: number;
  x: number;
  y: number;
} {
  return {
    pointerId: Number.isFinite(event.pointerId) ? event.pointerId : 0,
    x: Number.isFinite(event.clientX) ? event.clientX : 0,
    y: Number.isFinite(event.clientY) ? event.clientY : 0
  };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function readyLabel(
  response: "pending" | "ready" | "not_ready",
  presence: "online" | "reconnecting" | "offline"
): string {
  if (presence !== "online" && response === "pending") return "Not Ready";
  return response === "not_ready" ? "Not Ready" : titleCase(response);
}

function readCollapsedPreference(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}

export function PartyInviteBanner({
  invites,
  hidden,
  playerNames,
  connected,
  forwardToLeader = false,
  onAccept,
  onForward,
  onDecline
}: {
  invites: readonly PartyInviteSnapshot[];
  hidden: boolean;
  playerNames: Readonly<Record<string, string>>;
  connected: boolean;
  forwardToLeader?: boolean;
  onAccept(invitationId: string): boolean;
  onForward?(invitationId: string): boolean;
  onDecline(invitationId: string): boolean;
}): React.JSX.Element | null {
  const [pendingAction, setPendingAction] = useState<{
    invitationId: string;
    kind: "accept" | "forward" | "decline";
  } | null>(null);
  const pending = invites.filter(({ status, perspective }) =>
    status === "pending" && perspective === "incoming"
  );
  const invite = pending[0];
  useEffect(() => {
    if (!pendingAction) return;
    if (!pending.some(({ invitationId }) => invitationId === pendingAction.invitationId)) {
      setPendingAction(null);
      return;
    }
    const timer = window.setTimeout(() => setPendingAction(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [invites, pendingAction]);
  if (!invite || hidden) return null;
  const inviterName = playerNames[invite.inviterPlayerId] ?? "another player";
  const leaderName = playerNames[invite.leaderPlayerId] ?? "another player";
  return (
    <aside className="party-invite-banner" role="status" aria-label="Party invitation">
      <span>
        <strong>Party invite</strong>
        <small>
          From {inviterName}
          {invite.leaderPlayerId !== invite.inviterPlayerId ? ` · led by ${leaderName}` : ""}
          {pending.length > 1 ? ` · +${pending.length - 1} more` : ""}
        </small>
      </span>
      <button
        type="button"
        disabled={!connected || pendingAction !== null}
        onClick={() => {
          const sent = forwardToLeader
            ? onForward?.(invite.invitationId) ?? false
            : onAccept(invite.invitationId);
          if (sent) {
            setPendingAction({
              invitationId: invite.invitationId,
              kind: forwardToLeader ? "forward" : "accept"
            });
          }
        }}
      >
        {pendingAction?.kind === "accept"
          ? "Accepting…"
          : pendingAction?.kind === "forward"
            ? "Sending…"
            : forwardToLeader
              ? "Send to Leader"
              : "Accept"}
      </button>
      <button
        type="button"
        className="secondary"
        disabled={!connected || pendingAction !== null}
        onClick={() => {
          if (onDecline(invite.invitationId)) {
            setPendingAction({ invitationId: invite.invitationId, kind: "decline" });
          }
        }}
      >
        {pendingAction?.kind === "decline" ? "Declining…" : "Decline"}
      </button>
    </aside>
  );
}
