import type { ClientMessage } from "@ash-atlas/shared";
import { requestIdCrypto as crypto } from "../../requestId.js";
import type { ClientCommandPort } from "../clientCommandPort.js";
import { wasClientMessageSent } from "../clientCommandPort.js";

export class PartyClient {
  constructor(private readonly port: ClientCommandPort) {}

  setPartyTravelAllowed(allowed: boolean): boolean {
    return this.send({
      type: "SET_PARTY_TRAVEL_ALLOWED",
      requestId: crypto.randomUUID(),
      allowed
    });
  }

  createParty(): boolean {
      return this.send({ type: "CREATE_PARTY", requestId: crypto.randomUUID() });
    }

  invitePartyMember(targetPlayerId: string): boolean {
      return this.send({
        type: "ADD_PARTY_MEMBER",
        requestId: crypto.randomUUID(),
        targetPlayerId
      });
    }

  inviteToParty(targetPlayerId: string): boolean {
      return this.send({
        type: "INVITE_TO_PARTY",
        requestId: crypto.randomUUID(),
        targetPlayerId
      });
    }

  acceptPartyInvite(invitationId: string): boolean {
      return this.acceptPartyInviteRequest(invitationId) !== null;
    }

  acceptPartyInviteRequest(invitationId: string, requestId = crypto.randomUUID()): string | null {
      return this.send({
        type: "ACCEPT_PARTY_INVITE",
        requestId,
        invitationId
      }) ? requestId : null;
  }

  forwardPartyInvite(invitationId: string): boolean {
      return this.forwardPartyInviteRequest(invitationId) !== null;
    }

  forwardPartyInviteRequest(invitationId: string, requestId = crypto.randomUUID()): string | null {
      return this.send({
        type: "FORWARD_PARTY_INVITE",
        requestId,
        invitationId
      }) ? requestId : null;
    }

  declinePartyInvite(invitationId: string): boolean {
      return this.declinePartyInviteRequest(invitationId) !== null;
    }

  declinePartyInviteRequest(invitationId: string, requestId = crypto.randomUUID()): string | null {
      return this.send({
        type: "DECLINE_PARTY_INVITE",
        requestId,
        invitationId
      }) ? requestId : null;
    }

  cancelPartyInvite(invitationId: string): boolean {
      return this.cancelPartyInviteRequest(invitationId) !== null;
    }

  cancelPartyInviteRequest(invitationId: string, requestId = crypto.randomUUID()): string | null {
      return this.send({
        type: "CANCEL_PARTY_INVITE",
        requestId,
        invitationId
      }) ? requestId : null;
    }

  setPartyAutoFollow(enabled: boolean): boolean {
      return this.send({ type: "SET_PARTY_AUTO_FOLLOW", requestId: crypto.randomUUID(), enabled });
    }

  removePartyMember(targetPlayerId: string): boolean {
      return this.send({
        type: "REMOVE_PARTY_MEMBER",
        requestId: crypto.randomUUID(),
        targetPlayerId
      });
    }

  leaveParty(): boolean {
      return this.send({ type: "LEAVE_PARTY", requestId: crypto.randomUUID() });
    }

  disbandParty(): boolean {
      return this.send({ type: "DISBAND_PARTY", requestId: crypto.randomUUID() });
    }

  changePartyLeader(targetPlayerId: string): boolean {
      return this.send({
        type: "CHANGE_PARTY_LEADER",
        requestId: crypto.randomUUID(),
        targetPlayerId
      });
    }

  requestPartyCombatSnapshot(): boolean {
      return this.send({
        type: "REQUEST_PARTY_COMBAT_SNAPSHOT",
        requestId: crypto.randomUUID()
      });
    }

  startPartyReadyCheck(): boolean {
      return this.send({
        type: "START_PARTY_READY_CHECK",
        requestId: crypto.randomUUID()
      });
    }

  respondPartyReadyCheck(
      readyCheckId: string,
      response: "ready" | "not_ready"
    ): boolean {
      return this.send({
        type: "RESPOND_PARTY_READY_CHECK",
        requestId: crypto.randomUUID(),
        readyCheckId,
        response
      });
    }

  cancelPartyReadyCheck(readyCheckId: string): boolean {
      return this.send({
        type: "CANCEL_PARTY_READY_CHECK",
        requestId: crypto.randomUUID(),
        readyCheckId
      });
    }

  joinPartyListing(messageId: string): boolean {
    return this.send({ type: "JOIN_PARTY_LISTING", requestId: crypto.randomUUID(), messageId });
  }

  cancelPartyListing(messageId: string): boolean {
    return this.send({ type: "CANCEL_PARTY_LISTING", requestId: crypto.randomUUID(), messageId });
  }

  respondPartyJoinRequest(joinRequestId: string, response: "accept" | "decline"): boolean {
    return this.send({ type: "RESPOND_PARTY_JOIN_REQUEST", requestId: crypto.randomUUID(), joinRequestId, response });
  }

  private send(message: ClientMessage): boolean {
    return wasClientMessageSent(this.port.send(message));
  }
}
