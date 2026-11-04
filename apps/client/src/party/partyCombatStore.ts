import type {
  PartyCombatDelta,
  PartyCombatMemberSnapshot,
  PartyCombatSnapshot,
  PartyReadyCheckSnapshot,
  PartySnapshot
} from "@ash-atlas/shared";
import { useSyncExternalStore } from "react";

export type PartyCombatRosterState = Readonly<{
  partyId: string | null;
  membershipRevision: number | null;
  memberPlayerIds: readonly string[];
  stale: boolean;
  readyCheck: PartyReadyCheckSnapshot | null;
}>;

export type PartyCombatApplyResult =
  | "applied"
  | "ignored"
  | "gap"
  | "membership-mismatch";

type MutablePartyCombatMember = {
  -readonly [Key in keyof PartyCombatMemberSnapshot]: PartyCombatMemberSnapshot[Key];
};

const EMPTY_ROSTER: PartyCombatRosterState = Object.freeze({
  partyId: null,
  membershipRevision: null,
  memberPlayerIds: Object.freeze([]),
  stale: false,
  readyCheck: null
});

export class PartyCombatStore {
  private roster: PartyCombatRosterState = EMPTY_ROSTER;
  private sequence = 0;
  private readonly members = new Map<string, PartyCombatMemberSnapshot>();
  private readonly listeners = new Set<() => void>();
  private readonly memberListeners = new Map<string, Set<() => void>>();
  private requestResync: (() => void) | null = null;
  private resyncPending = false;

  setResyncRequester(requester: (() => void) | null): void {
    this.requestResync = requester;
  }

  getSnapshot = (): PartyCombatRosterState => this.roster;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getMemberSnapshot = (playerId: string): PartyCombatMemberSnapshot | null =>
    this.members.get(playerId) ?? null;

  subscribeMember(playerId: string, listener: () => void): () => void {
    const listeners = this.memberListeners.get(playerId) ?? new Set<() => void>();
    listeners.add(listener);
    this.memberListeners.set(playerId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.memberListeners.delete(playerId);
    };
  }

  applySnapshot(message: PartyCombatSnapshot): PartyCombatApplyResult {
    const previousIds = this.roster.memberPlayerIds;
    const nextIds = message.members.map(({ playerId }) => playerId);
    const changedIds = new Set([...previousIds, ...nextIds]);
    this.members.clear();
    for (const member of message.members) this.members.set(member.playerId, member);
    this.sequence = message.sequence;
    this.resyncPending = false;
    this.roster = Object.freeze({
      partyId: message.partyId,
      membershipRevision: message.membershipRevision,
      memberPlayerIds: Object.freeze(nextIds),
      stale: false,
      readyCheck: this.roster.readyCheck?.partyId === message.partyId
        ? this.roster.readyCheck
        : null
    });
    this.emitRoster();
    for (const playerId of changedIds) this.emitMember(playerId);
    return "applied";
  }

  applyDelta(message: PartyCombatDelta): PartyCombatApplyResult {
    if (
      this.roster.partyId !== message.partyId ||
      this.roster.membershipRevision !== message.membershipRevision
    ) {
      this.markStaleAndResync();
      return "membership-mismatch";
    }
    if (message.sequence <= this.sequence) return "ignored";
    if (message.sequence !== this.sequence + 1) {
      this.markStaleAndResync();
      return "gap";
    }
    this.sequence = message.sequence;
    for (const delta of message.members) {
      const current = this.members.get(delta.playerId);
      if (!current) {
        this.markStaleAndResync();
        return "membership-mismatch";
      }
      const { distanceMeters, ...fields } = delta;
      const next = { ...current, ...fields } as MutablePartyCombatMember;
      if (distanceMeters === null) delete next.distanceMeters;
      else if (distanceMeters !== undefined) next.distanceMeters = distanceMeters;
      this.members.set(delta.playerId, next);
      this.emitMember(delta.playerId);
    }
    return "applied";
  }

  applyReadyCheck(readyCheck: PartyReadyCheckSnapshot | null): void {
    if (
      readyCheck &&
      this.roster.partyId &&
      readyCheck.partyId !== this.roster.partyId
    ) return;
    if (this.roster.readyCheck === readyCheck) return;
    this.roster = Object.freeze({ ...this.roster, readyCheck });
    this.emitRoster();
  }

  reconcileParty(party: PartySnapshot | null): void {
    if (!party) {
      this.clear();
      return;
    }
    const membershipRevision = party.membershipRevision ?? party.revision;
    if (
      this.roster.partyId === party.partyId &&
      this.roster.membershipRevision === membershipRevision &&
      sameMembers(this.roster.memberPlayerIds, party.memberPlayerIds)
    ) return;
    this.markStaleAndResync();
  }

  clear(): void {
    if (this.roster === EMPTY_ROSTER && this.members.size === 0) return;
    const memberIds = [...this.members.keys()];
    this.members.clear();
    this.sequence = 0;
    this.resyncPending = false;
    this.roster = EMPTY_ROSTER;
    this.emitRoster();
    for (const playerId of memberIds) this.emitMember(playerId);
  }

  private markStaleAndResync(): void {
    if (!this.roster.stale) {
      this.roster = Object.freeze({ ...this.roster, stale: true });
      this.emitRoster();
    }
    if (this.resyncPending) return;
    this.resyncPending = true;
    this.requestResync?.();
  }

  private emitRoster(): void {
    for (const listener of this.listeners) listener();
  }

  private emitMember(playerId: string): void {
    for (const listener of this.memberListeners.get(playerId) ?? []) listener();
  }
}

export function usePartyCombatRoster(store: PartyCombatStore): PartyCombatRosterState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function usePartyCombatMember(
  store: PartyCombatStore,
  playerId: string
): PartyCombatMemberSnapshot | null {
  return useSyncExternalStore(
    (listener) => store.subscribeMember(playerId, listener),
    () => store.getMemberSnapshot(playerId),
    () => store.getMemberSnapshot(playerId)
  );
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((playerId) => set.has(playerId));
}
