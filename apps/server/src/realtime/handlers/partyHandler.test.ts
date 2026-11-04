import { describe, expect, it, vi } from "vitest";

import { OverworldBossParticipantLeaseCoordinator } from "../../game/overworldBossParticipantLeases.js";
import { PartyRealtimeState } from "../partyRealtimeState.js";
import { createPartyHandler } from "./partyHandler.js";

const party = {
  partyId: "party:1",
  leaderPlayerId: "leader",
  memberPlayerIds: ["leader", "target", "reserved"],
  allowTravel: false,
  autoFollowPlayerIds: [],
  revision: 1
} as const;

describe("party handler overworld boss roster guard", () => {
  it.each([
    {
      description: "remove member",
      method: "removePartyMember",
      message: {
        type: "REMOVE_PARTY_MEMBER",
        requestId: "remove",
        targetPlayerId: "target"
      }
    },
    {
      description: "leave party",
      method: "leaveParty",
      message: { type: "LEAVE_PARTY", requestId: "leave" }
    },
    {
      description: "disband party",
      method: "disbandParty",
      message: { type: "DISBAND_PARTY", requestId: "disband" }
    }
  ] as const)("rejects $description when any current member has a boss lease", async ({
    method,
    message
  }) => {
    const leases = new OverworldBossParticipantLeaseCoordinator();
    expect(leases.acquire("boss:1", ["reserved"])).toBe(true);
    const mutation = vi.fn();
    const errors: unknown[] = [];
    const authority = {
      partyForPlayer: (playerId: string) => party.memberPlayerIds.includes(
        playerId as (typeof party.memberPlayerIds)[number]
      ) ? party : null,
      [method]: mutation
    };
    const handler = createPartyHandler({
      state: { playerId: "leader" },
      socket: {},
      registry: { send: vi.fn() },
      partyAuthority: authority,
      overworldBossParticipantLeases: leases,
      partyRealtimeState: {
        runMutation: async (_playerId: string, operation: () => Promise<unknown>) => operation()
      },
      enforcePartyManorAccess: vi.fn(),
      safeSendServerMessage: (_socket: unknown, serverMessage: unknown) => {
        errors.push(serverMessage);
        return true;
      }
    } as never);

    await handler(message as never);

    expect(mutation).not.toHaveBeenCalled();
    expect(errors).toContainEqual(expect.objectContaining({
      type: "ERROR",
      requestId: message.requestId,
      code: "PARTY_REQUEST_REJECTED",
      message: "The party roster and leader are frozen during an overworld boss event"
    }));
  });

  it("rejects a second concurrent roster request from the same actor without queueing it", async () => {
    const leases = new OverworldBossParticipantLeaseCoordinator();
    let finishFirst!: () => void;
    const firstMutation = new Promise<void>((resolve) => { finishFirst = resolve; });
    const removePartyMember = vi.fn(() => firstMutation);
    const errors: unknown[] = [];
    const authority = {
      partyForPlayer: (playerId: string) => party.memberPlayerIds.includes(
        playerId as (typeof party.memberPlayerIds)[number]
      ) ? party : null,
      invitesForPlayer: () => [],
      inboxInvitesForPlayer: () => [],
      outgoingInvitesForParty: () => [],
      removePartyMember
    };
    const handler = createPartyHandler({
      state: { playerId: "leader" },
      socket: {},
      registry: { send: vi.fn() },
      partyAuthority: authority,
      overworldBossParticipantLeases: leases,
      partyRealtimeState: new PartyRealtimeState(),
      enforcePartyManorAccess: vi.fn(),
      safeSendServerMessage: (_socket: unknown, serverMessage: unknown) => {
        errors.push(serverMessage);
        return true;
      }
    } as never);

    const first = handler({
      type: "REMOVE_PARTY_MEMBER",
      requestId: "first",
      targetPlayerId: "target"
    } as never);
    await handler({
      type: "REMOVE_PARTY_MEMBER",
      requestId: "second",
      targetPlayerId: "target"
    } as never);

    expect(removePartyMember).toHaveBeenCalledOnce();
    expect(errors).toContainEqual(expect.objectContaining({
      type: "ERROR",
      requestId: "second",
      code: "PARTY_UNAVAILABLE",
      message: "Another party request is still pending"
    }));

    finishFirst();
    await first;
    expect(removePartyMember).toHaveBeenCalledOnce();
  });
});
