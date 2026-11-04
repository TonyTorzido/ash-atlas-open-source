import type {
  PartyInviteSnapshot,
  PartyOutgoingInviteSnapshot,
  PartySnapshot,
  ServerMessage
} from "@ash-atlas/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { PartyInviteContext } from "../../party/partyInviteEligibility.js";
import type { ProfileApiClient } from "../../profiles/profileClient.js";
import { PartyCombatStore } from "../../party/partyCombatStore.js";

type PartyServerMessage = Extract<ServerMessage, {
  type:
    | "PARTY_SNAPSHOT"
    | "PARTY_COMBAT_SNAPSHOT"
    | "PARTY_COMBAT_DELTA"
    | "PARTY_READY_CHECK_SNAPSHOT";
}>;

export function isPartyServerMessage(message: ServerMessage): message is PartyServerMessage {
  return message.type === "PARTY_SNAPSHOT" ||
    message.type === "PARTY_COMBAT_SNAPSHOT" ||
    message.type === "PARTY_COMBAT_DELTA" ||
    message.type === "PARTY_READY_CHECK_SNAPSHOT";
}

export interface PartyFeatureOptions {
  connectionStatus: "offline" | "connecting" | "online";
  ownPlayerId: string;
  profileApi: ProfileApiClient;
  combatStore?: PartyCombatStore;
  requestCombatSnapshot?(): void;
}

export function usePartyFeature({
  connectionStatus,
  ownPlayerId,
  profileApi,
  combatStore,
  requestCombatSnapshot
}: PartyFeatureOptions) {
  const [fallbackCombatStore] = useState(() => new PartyCombatStore());
  const activeCombatStore = combatStore ?? fallbackCombatStore;
  const [party, setParty] = useState<PartySnapshot | null>(null);
  const [invites, setInvites] = useState<PartyInviteSnapshot[]>([]);
  const [inboxInvites, setInboxInvites] = useState<PartyInviteSnapshot[]>([]);
  const [outgoingInvites, setOutgoingInvites] = useState<PartyOutgoingInviteSnapshot[]>([]);
  const [playerNames, setPlayerNames] = useState<Readonly<Record<string, string>>>({});
  const [inviteClock, setInviteClock] = useState(() => Date.now());

  useEffect(() => {
    activeCombatStore.setResyncRequester(requestCombatSnapshot ?? null);
    return () => activeCombatStore.setResyncRequester(null);
  }, [activeCombatStore, requestCombatSnapshot]);

  useEffect(() => {
    if (connectionStatus === "offline") activeCombatStore.clear();
  }, [activeCombatStore, connectionStatus]);

  const identityPlayerIds = useMemo(() => [...new Set([
    ...(party?.memberPlayerIds ?? []),
    ...inboxInvites.flatMap((invite) => [
      invite.leaderPlayerId,
      invite.inviterPlayerId,
      invite.targetPlayerId
    ])
  ])].filter((playerId) => playerId !== ownPlayerId).sort(), [inboxInvites, ownPlayerId, party]);

  useEffect(() => {
    if (connectionStatus !== "online" || identityPlayerIds.length === 0) return;
    let cancelled = false;
    void Promise.all(identityPlayerIds.map(async (playerId) => {
      try {
        const profile = await profileApi.getSocialPlayer(playerId);
        return [playerId, profile.displayName] as const;
      } catch {
        return null;
      }
    })).then((resolvedPlayers) => {
      if (cancelled) return;
      setPlayerNames((currentNames) => {
        const nextNames = { ...currentNames };
        for (const resolvedPlayer of resolvedPlayers) {
          if (resolvedPlayer) nextNames[resolvedPlayer[0]] = resolvedPlayer[1];
        }
        return nextNames;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [connectionStatus, identityPlayerIds, profileApi]);

  useEffect(() => {
    const nextExpiry = outgoingInvites
      .map((invite) => Date.parse(invite.expiresAt))
      .filter((expiresAt) => expiresAt > inviteClock)
      .sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => setInviteClock(Date.now()),
      Math.max(0, nextExpiry - Date.now()) + 20
    );
    return () => window.clearTimeout(timer);
  }, [inviteClock, outgoingInvites]);

  const inviteContext = useMemo((): PartyInviteContext => ({
    connected: connectionStatus === "online",
    inviterPlayerId: ownPlayerId,
    party,
    outgoingInvites,
    now: inviteClock
  }), [connectionStatus, inviteClock, outgoingInvites, ownPlayerId, party]);

  const handleServerMessage = useCallback((message: PartyServerMessage): void => {
    if (message.type === "PARTY_COMBAT_SNAPSHOT") {
      activeCombatStore.applySnapshot(message);
      return;
    }
    if (message.type === "PARTY_COMBAT_DELTA") {
      activeCombatStore.applyDelta(message);
      return;
    }
    if (message.type === "PARTY_READY_CHECK_SNAPSHOT") {
      activeCombatStore.applyReadyCheck(message.readyCheck);
      return;
    }
    setParty(message.party);
    setInvites(message.invites);
    setInboxInvites(message.inboxInvites ?? message.invites);
    setOutgoingInvites(message.outgoingInvites);
    setInviteClock(Date.now());
    activeCombatStore.reconcileParty(message.party);
  }, [activeCombatStore]);

  const resetForWelcome = useCallback((): void => {
    setParty(null);
    setInvites([]);
    setInboxInvites([]);
    setOutgoingInvites([]);
    activeCombatStore.clear();
  }, [activeCombatStore]);

  return {
    view: { party, invites, inboxInvites, outgoingInvites, playerNames, inviteClock, inviteContext },
    handleServerMessage,
    resetForWelcome
  } as const;
}

export type PartyFeature = ReturnType<typeof usePartyFeature>;
export type { PartyServerMessage };
