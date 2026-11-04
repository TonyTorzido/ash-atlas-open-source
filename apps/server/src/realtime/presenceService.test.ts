import { describe, expect, it, vi } from "vitest";

import {
  PRESENCE_OFFLINE_THRESHOLD_MS,
  PRESENCE_ONLINE_THRESHOLD_MS,
  PresenceService,
  statusAt
} from "./presenceService.js";

describe("PresenceService", () => {
  it("uses the exact online and recently-active thresholds", () => {
    expect(statusAt(0, PRESENCE_ONLINE_THRESHOLD_MS - 1)).toBe("online");
    expect(statusAt(0, PRESENCE_ONLINE_THRESHOLD_MS)).toBe("recently_active");
    expect(statusAt(0, PRESENCE_OFFLINE_THRESHOLD_MS - 1)).toBe("recently_active");
    expect(statusAt(0, PRESENCE_OFFLINE_THRESHOLD_MS)).toBe("offline");
  });

  it("counts one authoritative player per account and ignores unauthenticated activity", () => {
    let now = 1_000;
    const transitions = vi.fn();
    const service = new PresenceService({
      now: () => now,
      onTransition: transitions
    });

    service.recordAuthoritativeLogin("", "account-a", "Nobody");
    service.recordAuthoritativeLogin("player-a", null, "Player A");
    service.recordAuthoritativeLogin("player-a", "account-a", "Player A");
    service.recordAuthoritativeActivity("player-a", "account-a");
    expect(service.aggregateSnapshot().count).toBe(1);

    service.recordAuthoritativeLogin("player-b", "account-a", "Player B");
    expect(service.aggregateSnapshot()).toMatchObject({
      count: 1,
      players: [{ playerId: "player-b", displayName: "Player B" }]
    });
    expect(service.statusFor("player-a")).toBe("offline");
    expect(transitions).toHaveBeenCalledWith("player-a", "offline");

    now += PRESENCE_ONLINE_THRESHOLD_MS;
    expect(service.statusFor("player-b")).toBe("recently_active");
    expect(service.aggregateSnapshot().count).toBe(0);
  });

  it("orders newest gameplay logins first without reordering ordinary activity", () => {
    let now = 1_000;
    const service = new PresenceService({ now: () => now });

    service.recordAuthoritativeLogin("player-a", "account-a", "Alpha");
    now += 1;
    service.recordAuthoritativeLogin("player-b", "account-b", "Beta");
    expect(service.aggregateSnapshot().players.map(({ playerId }) => playerId)).toEqual([
      "player-b",
      "player-a"
    ]);

    now += 1;
    service.recordAuthoritativeActivity("player-a", "account-a");
    expect(service.aggregateSnapshot().players.map(({ playerId }) => playerId)).toEqual([
      "player-b",
      "player-a"
    ]);

    now += 1;
    service.recordAuthoritativeLogin("player-a", "account-a", "Alpha Renamed");
    expect(service.aggregateSnapshot().players).toEqual([
      { playerId: "player-a", displayName: "Alpha Renamed" },
      { playerId: "player-b", displayName: "Beta" }
    ]);
  });

  it("coalesces aggregate broadcasts while emitting individual transitions", async () => {
    let now = 0;
    const aggregates = vi.fn();
    const transitions = vi.fn();
    const service = new PresenceService({
      now: () => now,
      onAggregate: aggregates,
      onTransition: transitions
    });
    service.recordAuthoritativeLogin("player-a", "account-a", "Player A");
    service.recordAuthoritativeLogin("player-b", "account-b", "Player B");

    await service.sweep();
    expect(aggregates).toHaveBeenCalledTimes(1);
    expect(aggregates).toHaveBeenLastCalledWith(expect.objectContaining({ count: 2 }));

    now = PRESENCE_ONLINE_THRESHOLD_MS;
    await service.sweep();
    expect(aggregates).toHaveBeenCalledTimes(2);
    expect(aggregates).toHaveBeenLastCalledWith(expect.objectContaining({ count: 0 }));
    expect(transitions).toHaveBeenCalledWith("player-a", "recently_active");

    now = PRESENCE_OFFLINE_THRESHOLD_MS;
    await service.sweep();
    expect(aggregates).toHaveBeenCalledTimes(2);
    expect(service.metricsSnapshot()).toMatchObject({
      uniquePlayersOnline: 0,
      recentlyActivePlayers: 0,
      offlineTransitions: 2,
      presenceRecordsHeld: 0
    });
  });

  it("broadcasts roster reorder and identity changes even when the count is unchanged", async () => {
    let now = 0;
    const aggregates = vi.fn();
    const service = new PresenceService({ now: () => now, onAggregate: aggregates });
    service.recordAuthoritativeLogin("player-a", "account-a", "Alpha");
    now += 1;
    service.recordAuthoritativeLogin("player-b", "account-b", "Beta");
    await service.sweep();
    const initialRevision = service.aggregateSnapshot().revision;

    now += 1;
    service.recordAuthoritativeActivity("player-a", "account-a");
    await service.sweep();
    expect(aggregates).toHaveBeenCalledTimes(1);

    now += 1;
    service.recordAuthoritativeLogin("player-a", "account-a", "Alpha II");
    await service.sweep();
    expect(aggregates).toHaveBeenCalledTimes(2);
    expect(aggregates).toHaveBeenLastCalledWith(expect.objectContaining({
      count: 2,
      revision: initialRevision + 1,
      players: [
        { playerId: "player-a", displayName: "Alpha II" },
        { playerId: "player-b", displayName: "Beta" }
      ]
    }));
  });
});
