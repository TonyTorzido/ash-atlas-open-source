import { FLAG_UPGRADE_INTERACTION_RADIUS_M } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FLAG_HARDENING_DURATION_MS,
  FLAG_TOWER_UPGRADE_DURATION_MS,
  FlagHardeningCoordinator
} from "./flagHardeningCoordinator.js";

function harness() {
  let now = 1_000;
  const flag = { id: "flag-1", name: "Home", lat: 40, lon: -105, ownerId: "player-1", controlType: "personal", anchorKind: "flag", reinforcementLevel: 0, upgradeTier: "base" };
  const result = { flag: { ...flag, reinforcementLevel: 1, upgradeTier: "stone" }, inventory: { playerId: "player-1", stacks: [], revision: 2 }, replayed: false };
  const flags = { getFlag: vi.fn(async () => flag), upgradeFlagTier: vi.fn(async () => result) };
  const player: {
    position: { lat: number; lon: number };
    target: { lat: number; lon: number } | null;
  } = { position: { lat: 40, lon: -105 }, target: null };
  const hooks = { sendStarted: vi.fn(), sendCancelled: vi.fn(), completed: vi.fn(), failed: vi.fn() };
  const coordinator = new FlagHardeningCoordinator(flags as never, { info: vi.fn(), warn: vi.fn() }, hooks, () => now);
  const start = (flagId = "flag-1", requestId = "request-1", targetTier: "stone" | "tower" = "stone") =>
    coordinator.start("player-1", flagId, requestId, targetTier, () => player);
  return { coordinator, flags, hooks, player, start, setNow: (value: number) => { now = value; } };
}

describe("FlagHardeningCoordinator", () => {
  afterEach(() => vi.useRealTimers());

  it("rechecks wall clock and commits only after exactly 15 seconds", async () => {
    vi.useFakeTimers();
    const test = harness();
    expect((await test.start())?.durationMs).toBe(FLAG_HARDENING_DURATION_MS);
    test.setNow(15_999);
    await vi.advanceTimersByTimeAsync(FLAG_HARDENING_DURATION_MS);
    expect(test.flags.upgradeFlagTier).not.toHaveBeenCalled();
    test.setNow(16_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.flags.upgradeFlagTier).toHaveBeenCalledOnce();
  });

  it("enforces one active harden and refreshes completed replays without a second debit", async () => {
    vi.useFakeTimers();
    const test = harness();
    const first = await test.start();
    expect(await test.start()).toBe(first);
    await expect(test.start("flag-2", "request-2")).rejects.toThrow("already being hardened");
    test.setNow(16_000);
    await vi.advanceTimersByTimeAsync(FLAG_HARDENING_DURATION_MS);
    test.flags.upgradeFlagTier.mockResolvedValueOnce({
      flag: { ...await test.flags.getFlag(), reinforcementLevel: 1, upgradeTier: "stone" },
      inventory: { playerId: "player-1", stacks: [], revision: 9 },
      replayed: true
    } as never);
    await test.start();
    expect(test.flags.upgradeFlagTier).toHaveBeenCalledTimes(2);
    expect(test.hooks.completed).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      replayed: true,
      inventory: expect.objectContaining({ revision: 9 })
    }));
    await expect(test.start("flag-2", "request-1"))
      .rejects.toThrow("different intent");
  });

  it("keeps a successful commit completed when publication fails", async () => {
    vi.useFakeTimers();
    const test = harness();
    test.hooks.completed.mockRejectedValue(new Error("socket unavailable"));
    await test.start();
    test.setNow(16_000);
    await vi.advanceTimersByTimeAsync(FLAG_HARDENING_DURATION_MS);
    expect(test.flags.upgradeFlagTier).toHaveBeenCalledOnce();
    expect(test.hooks.sendCancelled).not.toHaveBeenCalled();
    expect(test.hooks.failed).not.toHaveBeenCalled();
    expect(test.coordinator.activeForPlayer("player-1")).toBeNull();

    await test.start();
    expect(test.flags.upgradeFlagTier).toHaveBeenCalledTimes(2);
    expect(test.hooks.sendCancelled).not.toHaveBeenCalled();
    expect(test.hooks.failed).not.toHaveBeenCalled();
  });

  it("cancels without commit and emits cancellation plus failure on final rejection", async () => {
    vi.useFakeTimers();
    const cancelled = harness();
    await cancelled.start();
    expect(cancelled.coordinator.cancelPlayer("player-1", "movement")).toBe(true);
    await vi.advanceTimersByTimeAsync(FLAG_HARDENING_DURATION_MS);
    expect(cancelled.flags.upgradeFlagTier).not.toHaveBeenCalled();
    const failed = harness();
    failed.flags.upgradeFlagTier.mockRejectedValueOnce(new Error("stone missing"));
    await failed.start("flag-1", "request-2");
    failed.setNow(16_000);
    await vi.advanceTimersByTimeAsync(FLAG_HARDENING_DURATION_MS);
    expect(failed.hooks.sendCancelled).toHaveBeenCalledWith(expect.anything(), "revalidation-failed");
    expect(failed.hooks.failed).toHaveBeenCalledOnce();
  });

  it("uses the exact tower duration and enforces stationary 50m start authority", async () => {
    vi.useFakeTimers();
    const tower = harness();
    tower.flags.getFlag.mockResolvedValue({
      ...await tower.flags.getFlag(), reinforcementLevel: 1, upgradeTier: "stone"
    });
    expect((await tower.start("flag-1", "tower-1", "tower"))?.durationMs)
      .toBe(FLAG_TOWER_UPGRADE_DURATION_MS);
    tower.coordinator.cancelPlayer("player-1", "movement");
    tower.player.position = { lat: 40.001, lon: -105 };
    await expect(tower.start("flag-1", "tower-2", "tower"))
      .rejects.toThrow(`within ${FLAG_UPGRADE_INTERACTION_RADIUS_M}m`);
    tower.player.position = { lat: 40, lon: -105 };
    tower.player.target = { lat: 40.0001, lon: -105 };
    await expect(tower.start("flag-1", "tower-3", "tower")).rejects.toThrow("Stop moving");
  });
});
