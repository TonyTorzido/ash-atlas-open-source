import type { ServerMessage } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryPartyAuthority } from "../game/party/PartyAuthority.js";
import { PartyReadyCheckService } from "./partyReadyCheckService.js";

describe("PartyReadyCheckService", () => {
  afterEach(() => vi.useRealTimers());

  it("publishes responses and completes when every member answers", () => {
    const { service, sent } = setup();
    const started = service.start("leader", "start");
    expect(started.responses).toEqual([
      { playerId: "ally", response: "pending" },
      { playerId: "leader", response: "ready" }
    ]);

    const completed = service.respond("ally", started.readyCheckId, "ready", "respond");
    expect(completed.status).toBe("complete");
    expect(sent.at(-1)?.message).toMatchObject({
      type: "PARTY_READY_CHECK_SNAPSHOT",
      readyCheck: { status: "complete" }
    });
    service.close();
  });

  it("marks pending members not ready at the authoritative deadline", () => {
    vi.useFakeTimers();
    const { service, sent } = setup();
    service.start("leader", "start");

    vi.advanceTimersByTime(30_000);

    expect(sent.at(-1)?.message).toMatchObject({
      type: "PARTY_READY_CHECK_SNAPSHOT",
      readyCheck: {
        status: "complete",
        responses: expect.arrayContaining([{ playerId: "ally", response: "not_ready" }])
      }
    });
    service.close();
  });

  it("cancels an active check when membership revision changes", () => {
    const { parties, service, sent } = setup();
    service.start("leader", "start");
    parties.removePartyMember("ally", "leader", "remove");
    service.reconcileMembership(["leader", "ally"]);

    expect(sent.at(-1)?.message).toMatchObject({
      type: "PARTY_READY_CHECK_SNAPSHOT",
      readyCheck: { status: "cancelled" }
    });
    service.close();
  });
});

function setup() {
  const parties = new InMemoryPartyAuthority();
  parties.loadSnapshots([{
    partyId: "party:00000000-0000-4000-8000-000000000001",
    leaderPlayerId: "leader",
    memberPlayerIds: ["ally", "leader"],
    memberSlots: [
      { playerId: "leader", slotIndex: 0 },
      { playerId: "ally", slotIndex: 1 }
    ],
    membershipRevision: 2,
    allowTravel: false,
    autoFollowPlayerIds: [],
    revision: 2
  }]);
  const sent: Array<{ playerId: string; message: ServerMessage }> = [];
  const service = new PartyReadyCheckService(parties, {
    send(playerId, message) {
      sent.push({ playerId, message });
    }
  });
  return { parties, service, sent };
}
