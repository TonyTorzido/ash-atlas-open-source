import { describe, expect, it } from "vitest";

import { OverworldBossParticipantLeaseCoordinator } from "./overworldBossParticipantLeases.js";

describe("OverworldBossParticipantLeaseCoordinator", () => {
  it("excludes cross-boss rosters atomically", () => {
    const leases = new OverworldBossParticipantLeaseCoordinator();
    expect(leases.acquire("xoral:1", ["a", "b"])).toBe(true);
    expect(leases.acquire("future-boss:1", ["c", "b", "d"])).toBe(false);
    expect(leases.isReserved("a")).toBe(true);
    expect(leases.isReserved("b")).toBe(true);
    expect(leases.isReserved("c")).toBe(false);
    expect(leases.isReserved("d")).toBe(false);
  });

  it("releases only participants owned by the exact lease", () => {
    const leases = new OverworldBossParticipantLeaseCoordinator();
    expect(leases.acquire("xoral:1", ["a", "b"])).toBe(true);
    expect(leases.releaseParticipant("other:1", "a")).toBe(false);
    expect(leases.release("other:1")).toBe(false);
    expect(leases.isReserved("a")).toBe(true);

    expect(leases.releaseParticipant("xoral:1", "a")).toBe(true);
    expect(leases.isReserved("a")).toBe(false);
    expect(leases.isReserved("b")).toBe(true);
    expect(leases.release("xoral:1")).toBe(true);
    expect(leases.isReserved("b")).toBe(false);
  });

  it("begins synchronously, blocks acquisition, and serializes roster mutations FIFO", async () => {
    const leases = new OverworldBossParticipantLeaseCoordinator();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = leases.runRosterMutation(async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first:end");
    });
    const second = leases.runRosterMutation(() => {
      order.push("second");
    });

    expect(order).toEqual(["first:start"]);
    expect(leases.acquire("xoral:1", ["a"])).toBe(false);

    releaseFirst();
    await first;
    await second;
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(leases.acquire("xoral:1", ["a"])).toBe(true);
  });

  it("advances the roster mutation queue after rejection", async () => {
    const leases = new OverworldBossParticipantLeaseCoordinator();
    let rejectFirst!: (error: Error) => void;
    const first = leases.runRosterMutation(() => new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    }));
    let secondRan = false;
    const second = leases.runRosterMutation(() => {
      secondRan = true;
    });

    rejectFirst(new Error("mutation failed"));
    await expect(first).rejects.toThrow("mutation failed");
    await second;

    expect(secondRan).toBe(true);
    expect(leases.acquire("xoral:1", ["a"])).toBe(true);
  });
});
