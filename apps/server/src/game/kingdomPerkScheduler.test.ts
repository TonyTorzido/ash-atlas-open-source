import { describe, expect, it, vi } from "vitest";

import { refreshDueKingdomPerks } from "./kingdomPerkScheduler.js";

describe("connected Kingdom perk qualification", () => {
  it("activates exactly at the boundary, only once, and treats rejoin as a new membership", async () => {
    let deadlines = [{
      playerId: "player-1",
      membershipId: "membership-1",
      qualifiedAt: new Date(10_000)
    }];
    const kingdoms = { connectedQualificationDeadlines: vi.fn(async () => deadlines) };
    const refresh = vi.fn(async () => undefined);
    const activated = new Set<string>();

    await expect(refreshDueKingdomPerks(kingdoms, ["player-1"], activated, refresh, 9_999))
      .resolves.toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    await expect(refreshDueKingdomPerks(kingdoms, ["player-1"], activated, refresh, 10_000))
      .resolves.toEqual(["player-1"]);
    expect(refresh).toHaveBeenCalledOnce();
    await refreshDueKingdomPerks(kingdoms, ["player-1"], activated, refresh, 20_000);
    expect(refresh).toHaveBeenCalledOnce();

    deadlines = [];
    await refreshDueKingdomPerks(kingdoms, ["player-1"], activated, refresh, 20_000);
    expect(activated).not.toContain("membership-1");
    deadlines = [{
      playerId: "player-1",
      membershipId: "membership-2",
      qualifiedAt: new Date(30_000)
    }];
    await refreshDueKingdomPerks(kingdoms, ["player-1"], activated, refresh, 29_999);
    expect(refresh).toHaveBeenCalledOnce();
    await refreshDueKingdomPerks(kingdoms, ["player-1"], activated, refresh, 30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not activate a membership removed before qualification", async () => {
    const refresh = vi.fn(async () => undefined);
    await refreshDueKingdomPerks(
      { connectedQualificationDeadlines: async () => [] },
      ["player-1"],
      new Set(),
      refresh,
      10_000
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("isolates one failed player refresh without retrying successful memberships", async () => {
    const deadlines = [
      { playerId: "player-good", membershipId: "membership-good", qualifiedAt: new Date(1) },
      { playerId: "player-bad", membershipId: "membership-bad", qualifiedAt: new Date(1) }
    ];
    const activated = new Set<string>();
    const refresh = vi.fn(async ([playerId]: string[]) => {
      if (playerId === "player-bad") throw new Error("injected refresh failure");
    });
    await expect(refreshDueKingdomPerks(
      { connectedQualificationDeadlines: async () => deadlines },
      deadlines.map(({ playerId }) => playerId),
      activated,
      refresh,
      1
    )).resolves.toEqual(["player-good"]);
    expect(activated).toEqual(new Set(["membership-good"]));
    await refreshDueKingdomPerks(
      { connectedQualificationDeadlines: async () => deadlines },
      deadlines.map(({ playerId }) => playerId),
      activated,
      refresh,
      2
    );
    expect(refresh.mock.calls.filter(([ids]) => ids[0] === "player-good")).toHaveLength(1);
    expect(refresh.mock.calls.filter(([ids]) => ids[0] === "player-bad")).toHaveLength(2);
  });
});
