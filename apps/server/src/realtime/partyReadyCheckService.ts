import type {
  PartyReadyCheckResponse,
  PartyReadyCheckSnapshot,
  ServerMessage
} from "@ash-atlas/shared";

import {
  PartyAuthorityError,
  type PartyAuthority,
  type PartySnapshot
} from "../game/party/PartyAuthority.js";

type ReadyCheckConnectionPort = {
  send(playerId: string, message: ServerMessage, mode?: "critical" | "replaceable"): unknown;
};

type ActiveReadyCheck = {
  readyCheckId: string;
  partyId: string;
  membershipRevision: number;
  startedByPlayerId: string;
  startedAt: number;
  expiresAt: number;
  status: PartyReadyCheckSnapshot["status"];
  responses: Map<string, PartyReadyCheckResponse>;
  timeout: NodeJS.Timeout | null;
  cleanup: NodeJS.Timeout | null;
};

const READY_CHECK_DURATION_MS = 30_000;
const READY_CHECK_RESULT_RETENTION_MS = 5_000;

export class PartyReadyCheckService {
  private readonly checks = new Map<string, ActiveReadyCheck>();

  constructor(
    private readonly parties: PartyAuthority,
    private readonly connections: ReadyCheckConnectionPort
  ) {}

  start(actorPlayerId: string, requestId: string): PartyReadyCheckSnapshot {
    const party = this.requireParty(actorPlayerId);
    if (party.leaderPlayerId !== actorPlayerId) {
      throw new PartyAuthorityError("PARTY_NOT_LEADER", "Only the party leader can start a ready check");
    }
    const current = this.checks.get(party.partyId);
    if (current?.status === "pending") {
      throw new PartyAuthorityError("PARTY_UNAVAILABLE", "A ready check is already active");
    }
    this.dispose(current);
    const startedAt = Date.now();
    const check: ActiveReadyCheck = {
      readyCheckId: crypto.randomUUID(),
      partyId: party.partyId,
      membershipRevision: membershipRevisionOf(party),
      startedByPlayerId: actorPlayerId,
      startedAt,
      expiresAt: startedAt + READY_CHECK_DURATION_MS,
      status: "pending",
      responses: new Map(
        party.memberPlayerIds.map((playerId) => [
          playerId,
          playerId === actorPlayerId ? "ready" : "pending"
        ])
      ),
      timeout: null,
      cleanup: null
    };
    check.timeout = setTimeout(() => this.expire(check.partyId, check.readyCheckId), READY_CHECK_DURATION_MS);
    check.timeout.unref();
    this.checks.set(party.partyId, check);
    this.publish(check, actorPlayerId, requestId);
    return snapshot(check);
  }

  respond(
    actorPlayerId: string,
    readyCheckId: string,
    response: Exclude<PartyReadyCheckResponse, "pending">,
    requestId: string
  ): PartyReadyCheckSnapshot {
    const party = this.requireParty(actorPlayerId);
    const check = this.requirePending(party.partyId, readyCheckId);
    this.assertCurrentMembership(check, party);
    if (!check.responses.has(actorPlayerId)) {
      throw new PartyAuthorityError("PARTY_MEMBER_NOT_FOUND", "Player is not part of this ready check");
    }
    check.responses.set(actorPlayerId, response);
    if ([...check.responses.values()].every((value) => value !== "pending")) {
      check.status = "complete";
      this.finish(check);
    }
    this.publish(check, actorPlayerId, requestId);
    return snapshot(check);
  }

  cancel(actorPlayerId: string, readyCheckId: string, requestId: string): PartyReadyCheckSnapshot {
    const party = this.requireParty(actorPlayerId);
    if (party.leaderPlayerId !== actorPlayerId) {
      throw new PartyAuthorityError("PARTY_NOT_LEADER", "Only the party leader can cancel a ready check");
    }
    const check = this.requirePending(party.partyId, readyCheckId);
    check.status = "cancelled";
    this.finish(check);
    this.publish(check, actorPlayerId, requestId);
    return snapshot(check);
  }

  sendForPlayer(playerId: string): void {
    const party = this.parties.partyForPlayer(playerId);
    const check = party ? this.checks.get(party.partyId) : undefined;
    this.connections.send(playerId, {
      type: "PARTY_READY_CHECK_SNAPSHOT",
      readyCheck: check ? snapshot(check) : null
    });
  }

  reconcileMembership(playerIds: Iterable<string>): void {
    const partyIds = new Set<string>();
    for (const playerId of playerIds) {
      const partyId = this.parties.partyForPlayer(playerId)?.partyId;
      if (partyId) partyIds.add(partyId);
    }
    for (const check of this.checks.values()) partyIds.add(check.partyId);
    for (const partyId of partyIds) {
      const check = this.checks.get(partyId);
      if (!check || check.status !== "pending") continue;
      const party = this.partyByMember(check.startedByPlayerId);
      if (
        !party ||
        party.partyId !== check.partyId ||
        membershipRevisionOf(party) !== check.membershipRevision
      ) {
        check.status = "cancelled";
        this.finish(check);
        this.publish(check);
      }
    }
  }

  close(): void {
    for (const check of this.checks.values()) this.dispose(check);
    this.checks.clear();
  }

  private expire(partyId: string, readyCheckId: string): void {
    const check = this.checks.get(partyId);
    if (!check || check.readyCheckId !== readyCheckId || check.status !== "pending") return;
    for (const [playerId, response] of check.responses) {
      if (response === "pending") check.responses.set(playerId, "not_ready");
    }
    check.status = "complete";
    this.finish(check);
    this.publish(check);
  }

  private finish(check: ActiveReadyCheck): void {
    if (check.timeout) clearTimeout(check.timeout);
    check.timeout = null;
    if (check.cleanup) clearTimeout(check.cleanup);
    check.cleanup = setTimeout(() => {
      if (this.checks.get(check.partyId) !== check) return;
      this.checks.delete(check.partyId);
      for (const playerId of check.responses.keys()) {
        this.connections.send(playerId, {
          type: "PARTY_READY_CHECK_SNAPSHOT",
          readyCheck: null
        });
      }
    }, READY_CHECK_RESULT_RETENTION_MS);
    check.cleanup.unref();
  }

  private publish(
    check: ActiveReadyCheck,
    requesterPlayerId?: string,
    requestId?: string
  ): void {
    const readyCheck = snapshot(check);
    for (const playerId of check.responses.keys()) {
      this.connections.send(playerId, playerId === requesterPlayerId && requestId
        ? { type: "PARTY_READY_CHECK_SNAPSHOT", requestId, readyCheck }
        : { type: "PARTY_READY_CHECK_SNAPSHOT", readyCheck });
    }
  }

  private requireParty(playerId: string): PartySnapshot {
    const party = this.parties.partyForPlayer(playerId);
    if (!party) {
      throw new PartyAuthorityError("PARTY_NOT_FOUND", "Player does not belong to a party");
    }
    return party;
  }

  private partyByMember(playerId: string): PartySnapshot | null {
    return this.parties.partyForPlayer(playerId);
  }

  private requirePending(partyId: string, readyCheckId: string): ActiveReadyCheck {
    const check = this.checks.get(partyId);
    if (!check || check.readyCheckId !== readyCheckId || check.status !== "pending") {
      throw new PartyAuthorityError("PARTY_UNAVAILABLE", "Ready check is no longer active");
    }
    return check;
  }

  private assertCurrentMembership(check: ActiveReadyCheck, party: PartySnapshot): void {
    if (membershipRevisionOf(party) !== check.membershipRevision) {
      check.status = "cancelled";
      this.finish(check);
      this.publish(check);
      throw new PartyAuthorityError("PARTY_UNAVAILABLE", "Party membership changed during the ready check");
    }
  }

  private dispose(check: ActiveReadyCheck | undefined): void {
    if (!check) return;
    if (check.timeout) clearTimeout(check.timeout);
    if (check.cleanup) clearTimeout(check.cleanup);
  }
}

function membershipRevisionOf(party: PartySnapshot): number {
  return party.membershipRevision ?? party.revision;
}

function snapshot(check: ActiveReadyCheck): PartyReadyCheckSnapshot {
  return {
    readyCheckId: check.readyCheckId,
    partyId: check.partyId,
    membershipRevision: check.membershipRevision,
    startedByPlayerId: check.startedByPlayerId,
    startedAt: check.startedAt,
    expiresAt: check.expiresAt,
    status: check.status,
    responses: [...check.responses]
      .map(([playerId, response]) => ({ playerId, response }))
      .sort((left, right) => left.playerId.localeCompare(right.playerId))
  };
}
