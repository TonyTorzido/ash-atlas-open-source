import { describe, expect, it, vi } from "vitest";

import { ChatBlockFilter } from "./chatBlockFilter.js";

type MockListEntry = {
  playerId: string;
  displayName: string;
  level: number;
  portrait: { kind: "player_sprite"; displayColor: string | null };
  title: string | null;
  online: boolean;
  class: unknown;
  kingdom: unknown;
  settlement: unknown;
  relationship: {
    friendship: "none" | "outgoing_request" | "incoming_request" | "friends" | "blocked_by_viewer" | "unavailable";
    enemyMarkedByViewer: boolean;
  };
};

function blockedList(playerIds: string[]): { kind: string; entries: MockListEntry[]; offset: number; limit: number; hasMore: boolean } {
  return {
    kind: "blocked",
    entries: playerIds.map((playerId) => ({
      playerId,
      displayName: `Player ${playerId}`,
      level: 1,
      portrait: { kind: "player_sprite" as const, displayColor: null },
      title: null,
      online: false,
      class: null,
      kingdom: null,
      settlement: null,
      relationship: { friendship: "none" as const, enemyMarkedByViewer: false }
    })),
    offset: 0,
    limit: 50,
    hasMore: false
  };
}

function blockFilterWithList(listFn: () => Promise<unknown>) {
  return new ChatBlockFilter({
    serverHttpBase: "http://localhost",
    csrfToken: "token",
    createProfileApi: () => ({ list: listFn }) as unknown as ReturnType<NonNullable<ChatBlockFilter["deps"]["createProfileApi"]>>
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ChatBlockFilter", () => {
  it("returns a stable snapshot and does not publish for an unchanged player token", async () => {
    const load = deferred<unknown>();
    const filter = blockFilterWithList(() => load.promise);
    const listener = vi.fn();
    filter.subscribe(listener);

    const initial = filter.getSnapshot();
    expect(filter.getSnapshot()).toBe(initial);

    filter.setPlayer("player-1", 1);
    const loading = filter.getSnapshot();
    expect(loading).not.toBe(initial);
    expect(filter.getSnapshot()).toBe(loading);
    const notifications = listener.mock.calls.length;

    filter.setPlayer("player-1", 1);
    expect(filter.getSnapshot()).toBe(loading);
    expect(listener).toHaveBeenCalledTimes(notifications);

    load.resolve(blockedList([]));
    await flushPromises();
    const completed = filter.getSnapshot();
    const completedNotifications = listener.mock.calls.length;
    filter.setPlayer("player-1", 1);
    expect(filter.getSnapshot()).toBe(completed);
    expect(listener).toHaveBeenCalledTimes(completedNotifications);
    filter.destroy();
  });

  it("B1: initial failure then automatic success restores readiness", async () => {
    vi.useFakeTimers();
    let callNumber = 0;

    const filter = blockFilterWithList(async () => {
      const n = callNumber;
      callNumber += 1;
      if (n === 0) throw new Error("network error");
      return blockedList(["blocked-a"]);
    });

    filter.setPlayer("player-1", 5);
    await vi.runAllTimersAsync();

    const snap = filter.getSnapshot();
    expect(snap.hasValidData).toBe(true);
    expect(snap.loadedRefreshToken).toBe(5);
    expect(snap.hiddenSenderIds.has("blocked-a")).toBe(true);
    expect(snap.initialLoadError).toBe(false);
    expect(snap.loading).toBe(false);

    vi.useRealTimers();
  });

  it("B2: automatic retries are bounded", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const filter = blockFilterWithList(async () => {
      callCount += 1;
      throw new Error("always fail");
    });

    filter.setPlayer("player-1", 1);
    await vi.runAllTimersAsync();

    expect(callCount).toBe(4);
    const snap = filter.getSnapshot();
    expect(snap.initialLoadError).toBe(true);
    expect(snap.hasValidData).toBe(false);
    expect(snap.loading).toBe(false);

    vi.useRealTimers();
  });

  it("automatic retry attempts preserve snapshot identity and do not notify", async () => {
    vi.useFakeTimers();
    const retry = deferred<unknown>();
    let callCount = 0;
    const filter = blockFilterWithList(() => {
      callCount += 1;
      return callCount === 1 ? Promise.reject(new Error("retry")) : retry.promise;
    });
    const listener = vi.fn();
    filter.subscribe(listener);

    filter.setPlayer("player-1", 1);
    await vi.advanceTimersByTimeAsync(0);
    const waitingForRetry = filter.getSnapshot();
    expect(waitingForRetry.loading).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(callCount).toBe(2);
    expect(filter.getSnapshot()).toBe(waitingForRetry);
    expect(listener).toHaveBeenCalledTimes(1);

    retry.resolve(blockedList(["current"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(filter.getSnapshot()).not.toBe(waitingForRetry);
    expect(filter.getSnapshot().hasValidData).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    filter.destroy();
    vi.useRealTimers();
  });

  it("B3: manual retry really restores readiness", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const filter = blockFilterWithList(async () => {
      callCount += 1;
      if (callCount <= 4) throw new Error("fail");
      return blockedList(["unblocked"]);
    });

    filter.setPlayer("player-1", 5);
    await vi.runAllTimersAsync();

    expect(filter.getSnapshot().initialLoadError).toBe(true);
    expect(filter.getSnapshot().hasValidData).toBe(false);

    filter.retry();
    await vi.runAllTimersAsync();

    const snap = filter.getSnapshot();
    expect(snap.hasValidData).toBe(true);
    expect(snap.loadedRefreshToken).toBe(5);
    expect(snap.hiddenSenderIds.has("unblocked")).toBe(true);
    expect(snap.initialLoadError).toBe(false);

    vi.useRealTimers();
  });

  it("B4: last valid set remains active after refresh failure", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const filter = blockFilterWithList(async () => {
      callCount += 1;
      if (callCount === 1) return blockedList(["blocked-x"]);
      throw new Error("refresh failed");
    });

    filter.setPlayer("player-1", 1);
    await vi.runAllTimersAsync();

    expect(filter.getSnapshot().hasValidData).toBe(true);
    expect(filter.getSnapshot().hiddenSenderIds.has("blocked-x")).toBe(true);

    filter.setPlayer("player-1", 2);
    await vi.runAllTimersAsync();

    const snap = filter.getSnapshot();
    expect(snap.hasValidData).toBe(true);
    expect(snap.hiddenSenderIds.has("blocked-x")).toBe(true);
    expect(snap.refreshError).toBe(true);
    expect(snap.initialLoadError).toBe(false);
    expect(snap.loading).toBe(false);

    vi.useRealTimers();
  });

  it("B5: refresh retry success replaces old block data", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const filter = blockFilterWithList(async () => {
      callCount += 1;
      if (callCount === 1) return blockedList(["old-blocked"]);
      if (callCount === 2) throw new Error("first refresh fail");
      return blockedList(["new-blocked"]);
    });

    filter.setPlayer("player-1", 1);
    await vi.runAllTimersAsync();

    expect(filter.getSnapshot().hiddenSenderIds.has("old-blocked")).toBe(true);

    filter.setPlayer("player-1", 3);
    await vi.runAllTimersAsync();

    const snap = filter.getSnapshot();
    expect(snap.hiddenSenderIds.has("new-blocked")).toBe(true);
    expect(snap.hiddenSenderIds.has("old-blocked")).toBe(false);
    expect(snap.loadedRefreshToken).toBe(3);
    expect(snap.refreshError).toBe(false);

    vi.useRealTimers();
  });

  it("B6: delayed account A completion cannot affect account B", async () => {
    const initialPlayerA = deferred<unknown>();
    const refreshingPlayerA = deferred<unknown>();
    const playerB = deferred<unknown>();
    const requests = [initialPlayerA, refreshingPlayerA, playerB];
    let callCount = 0;
    const filter = blockFilterWithList(() => requests[callCount++]!.promise);

    filter.setPlayer("A", 1);
    initialPlayerA.resolve(blockedList(["blocked-for-A"]));
    await flushPromises();
    expect(callCount).toBe(1);
    expect(filter.getSnapshot().hiddenSenderIds.has("blocked-for-A")).toBe(true);

    filter.setPlayer("A", 2);
    expect(callCount).toBe(2);
    filter.setPlayer("B", 1);
    expect(callCount).toBe(3);

    const snapAfterSwitch = filter.getSnapshot();
    expect(snapAfterSwitch.hasValidData).toBe(false);
    expect(snapAfterSwitch.hiddenSenderIds.has("blocked-for-A")).toBe(false);

    refreshingPlayerA.resolve(blockedList(["late-blocked-for-A"]));
    await flushPromises();
    expect(filter.getSnapshot().hasValidData).toBe(false);
    expect(filter.getSnapshot().hiddenSenderIds.has("blocked-for-A")).toBe(false);
    expect(filter.getSnapshot().hiddenSenderIds.has("late-blocked-for-A")).toBe(false);

    playerB.resolve(blockedList(["blocked-for-B"]));
    await flushPromises();
    const finalSnapshot = filter.getSnapshot();
    expect(finalSnapshot.hasValidData).toBe(true);
    expect(finalSnapshot.hiddenSenderIds.has("blocked-for-A")).toBe(false);
    expect(finalSnapshot.hiddenSenderIds.has("blocked-for-B")).toBe(true);
  });

  it("B7: unmount cancels retries", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const filter = blockFilterWithList(async () => {
      callCount += 1;
      throw new Error("fail");
    });

    filter.setPlayer("player-1", 1);

    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBeLessThanOrEqual(1);

    filter.destroy();

    await vi.advanceTimersByTimeAsync(10000);
    const callsAfterDestroy = callCount;
    expect(callsAfterDestroy).toBeLessThanOrEqual(1);

    vi.useRealTimers();
  });

  it("reversible cleanup invalidates in-flight work and permits reactivation", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const requests = [first, second];
    let callCount = 0;
    const filter = blockFilterWithList(() => requests[callCount++]!.promise);

    filter.setPlayer("player-1", 1);
    filter.deactivate();
    expect(filter.getSnapshot().loading).toBe(false);
    first.resolve(blockedList(["stale"]));
    await flushPromises();
    expect(filter.getSnapshot().hiddenSenderIds.has("stale")).toBe(false);

    filter.activate();
    expect(callCount).toBe(2);
    expect(filter.getSnapshot().loading).toBe(true);
    second.resolve(blockedList(["current"]));
    await flushPromises();
    expect(filter.getSnapshot().hasValidData).toBe(true);
    expect(filter.getSnapshot().hiddenSenderIds.has("current")).toBe(true);
  });

  it("deactivation cancels an old retry timer before reactivation", async () => {
    vi.useFakeTimers();
    const replacement = deferred<unknown>();
    let callCount = 0;
    const filter = blockFilterWithList(() => {
      callCount += 1;
      return callCount === 1 ? Promise.reject(new Error("retry")) : replacement.promise;
    });

    filter.setPlayer("player-1", 1);
    await vi.advanceTimersByTimeAsync(0);
    filter.deactivate();
    filter.activate();
    expect(callCount).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callCount).toBe(2);

    replacement.resolve(blockedList(["current"]));
    await vi.advanceTimersByTimeAsync(0);
    filter.destroy();
    vi.useRealTimers();
  });

  it("destroy permanently invalidates an in-flight success and clears listeners", async () => {
    const load = deferred<unknown>();
    const filter = blockFilterWithList(() => load.promise);
    const listener = vi.fn();
    filter.subscribe(listener);
    filter.setPlayer("player-1", 1);
    const beforeDestroy = filter.getSnapshot();
    const notifications = listener.mock.calls.length;

    filter.destroy();
    const afterDestroy = filter.getSnapshot();
    expect(afterDestroy).not.toBe(beforeDestroy);
    expect(afterDestroy.loading).toBe(false);
    load.resolve(blockedList(["late"]));
    await flushPromises();

    expect(filter.getSnapshot()).toBe(afterDestroy);
    expect(filter.getSnapshot().hiddenSenderIds.has("late")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(notifications);
    filter.activate();
    filter.setPlayer("player-2", 2);
    filter.retry();
    expect(filter.getSnapshot()).toBe(afterDestroy);
  });

  it("B8: stale response cannot win", async () => {
    const resolves: Array<(val: unknown) => void> = [];

    const filter = blockFilterWithList(() => {
      return new Promise<unknown>((resolve) => {
        resolves.push(resolve);
      });
    });

    filter.setPlayer("player-1", 1);
    filter.retry();

    expect(resolves).toHaveLength(2);
    resolves[0]!(blockedList(["stale"]));
    resolves[1]!(blockedList(["current"]));
    await flushPromises();

    const snap = filter.getSnapshot();
    expect(snap.hasValidData).toBe(true);
    expect(snap.hiddenSenderIds.has("stale")).toBe(false);
    expect(snap.hiddenSenderIds.has("current")).toBe(true);
  });

  it.each(["old-first", "new-first"] as const)(
    "same-player refresh token supersedes an in-flight request (%s)",
    async (completionOrder) => {
      const token5 = deferred<unknown>();
      const token6 = deferred<unknown>();
      const requests = [token5, token6];
      let callCount = 0;
      const filter = blockFilterWithList(() => requests[callCount++]!.promise);

      filter.setPlayer("A", 5);
      filter.setPlayer("A", 6);
      expect(callCount).toBe(2);

      if (completionOrder === "old-first") {
        token5.resolve(blockedList(["stale"]));
        await flushPromises();
        expect(filter.getSnapshot().hiddenSenderIds.has("stale")).toBe(false);
        token6.resolve(blockedList(["current"]));
      } else {
        token6.resolve(blockedList(["current"]));
        await flushPromises();
        token5.resolve(blockedList(["stale"]));
      }
      await flushPromises();

      const snapshot = filter.getSnapshot();
      expect(snapshot.hasValidData).toBe(true);
      expect(snapshot.loadedRefreshToken).toBe(6);
      expect(snapshot.hiddenSenderIds.has("current")).toBe(true);
      expect(snapshot.hiddenSenderIds.has("stale")).toBe(false);
    }
  );

  it("preserves last valid data while a newer token loads", async () => {
    const current = deferred<unknown>();
    const next = deferred<unknown>();
    let callCount = 0;
    const filter = blockFilterWithList(() => (callCount++ === 0 ? current.promise : next.promise));

    filter.setPlayer("A", 5);
    current.resolve(blockedList(["existing"]));
    await flushPromises();
    filter.setPlayer("A", 6);

    const loading = filter.getSnapshot();
    expect(loading.hasValidData).toBe(true);
    expect(loading.hiddenSenderIds.has("existing")).toBe(true);
    expect(loading.loading).toBe(true);

    next.resolve(blockedList(["current"]));
    await flushPromises();

    const finalSnapshot = filter.getSnapshot();
    expect(finalSnapshot.hasValidData).toBe(true);
    expect(finalSnapshot.loadedRefreshToken).toBe(6);
    expect(finalSnapshot.loading).toBe(false);
    expect(finalSnapshot.hiddenSenderIds.has("existing")).toBe(false);
    expect(finalSnapshot.hiddenSenderIds.has("current")).toBe(true);
    expect(finalSnapshot.refreshError).toBe(false);
  });
});
