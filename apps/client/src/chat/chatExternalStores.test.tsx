// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SocialListResponse } from "@ash-atlas/shared";
import { StrictMode, useEffect, useState, useSyncExternalStore } from "react";

import { ChatBlockFilter } from "./chatBlockFilter.js";
import { ChatHistoryRequestTracker } from "./chatHistoryRequestTracker.js";
import { ProfileApiClient } from "../profiles/profileClient.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function blockedList(playerIds: string[]): SocialListResponse {
  return {
    kind: "blocked",
    entries: playerIds.map((playerId) => ({
      playerId,
      displayName: `Player ${playerId}`,
      level: 1,
      portrait: { kind: "player_sprite", displayColor: null },
      title: null,
      presence: "hidden",
      class: null,
      kingdom: null,
      settlement: null,
      relationship: { friendship: "none", enemyMarkedByViewer: false }
    })),
    offset: 0,
    limit: 50,
    hasMore: false
  };
}

describe("chat external stores with React", () => {
  it("reactivates one state-owned block filter through the Strict Mode effect cycle", async () => {
    const requests: Array<ReturnType<typeof deferred<SocialListResponse>>> = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let activeSubscriptions = 0;
    let maximumSubscriptions = 0;
    let subscribeCalls = 0;
    let unsubscribeCalls = 0;
    let currentFilter: ChatBlockFilter | null = null;

    function BlockFilterOwner() {
      const [filter] = useState(() => {
        const created = new ChatBlockFilter({
          serverHttpBase: "http://localhost",
          csrfToken: "token",
          createProfileApi: (base, token) => {
            const api = new ProfileApiClient(base, token);
            api.list = () => {
              const request = deferred<SocialListResponse>();
              requests.push(request);
              return request.promise;
            };
            return api;
          }
        });
        const originalSubscribe = created.subscribe;
        created.subscribe = (listener) => {
          subscribeCalls += 1;
          activeSubscriptions += 1;
          maximumSubscriptions = Math.max(maximumSubscriptions, activeSubscriptions);
          const release = originalSubscribe(listener);
          return () => {
            unsubscribeCalls += 1;
            activeSubscriptions -= 1;
            release();
          };
        };
        return created;
      });
      currentFilter = filter;
      const snapshot = useSyncExternalStore(filter.subscribe, filter.getSnapshot);

      useEffect(() => {
        filter.activate();
        return () => filter.deactivate();
      }, [filter]);

      useEffect(() => {
        filter.setPlayer("A", 5);
      }, [filter]);

      return (
        <span>
          {snapshot.hasValidData
            ? [...snapshot.hiddenSenderIds].join(",")
            : snapshot.loading
              ? "loading"
              : "closed"}
        </span>
      );
    }

    const view = render(
      <StrictMode>
        <BlockFilterOwner />
      </StrictMode>
    );

    expect(requests).toHaveLength(2);
    expect(screen.getByText("loading")).toBeTruthy();
    const stableLoadingSnapshot = currentFilter!.getSnapshot();
    expect(currentFilter!.getSnapshot()).toBe(stableLoadingSnapshot);

    await act(async () => {
      requests[0]!.resolve(blockedList(["stale"]));
      await requests[0]!.promise;
    });
    expect(currentFilter!.getSnapshot().hiddenSenderIds.has("stale")).toBe(false);
    expect(screen.getByText("loading")).toBeTruthy();

    await act(async () => {
      requests[1]!.resolve(blockedList(["current"]));
      await requests[1]!.promise;
    });
    expect(screen.getByText("current")).toBeTruthy();
    expect(currentFilter!.getSnapshot().hasValidData).toBe(true);
    expect(currentFilter!.getSnapshot().hiddenSenderIds.has("stale")).toBe(false);

    view.unmount();
    expect(activeSubscriptions).toBe(0);
    expect(subscribeCalls).toBe(unsubscribeCalls);
    expect(maximumSubscriptions).toBe(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("renders history tracker transitions without uncached-snapshot warnings or loops", () => {
    const tracker = new ChatHistoryRequestTracker();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let renders = 0;
    function Subscriber() {
      const snapshot = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);
      renders += 1;
      return <span>{snapshot.active === null ? "idle" : "active"}</span>;
    }

    const view = render(<Subscriber />);
    expect(screen.getByText("idle")).toBeTruthy();
    const initialRenders = renders;
    act(() => tracker.start({ requestId: "A", channelKey: "public:general", beforeSequence: 50 }));
    expect(screen.getByText("active")).toBeTruthy();
    expect(renders).toBe(initialRenders + 1);
    act(() => {
      tracker.completeResult({ requestId: "A", channelKey: "public:general" });
    });
    expect(screen.getByText("idle")).toBeTruthy();
    expect(renders).toBe(initialRenders + 2);
    view.unmount();

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("renders block-filter readiness once and cleans up its subscription", async () => {
    const load = deferred<SocialListResponse>();
    const filter = new ChatBlockFilter({
      serverHttpBase: "http://localhost",
      csrfToken: "token",
      createProfileApi: (base, token) => {
        const api = new ProfileApiClient(base, token);
        api.list = () => load.promise;
        return api;
      }
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const originalSubscribe = filter.subscribe;
    const unsubscribe = vi.fn();
    const subscribe = vi.spyOn(filter, "subscribe").mockImplementation((listener) => {
      const release = originalSubscribe(listener);
      return () => {
        unsubscribe();
        release();
      };
    });
    let renders = 0;
    function Subscriber() {
      const snapshot = useSyncExternalStore(filter.subscribe, filter.getSnapshot);
      renders += 1;
      return <span>{snapshot.hasValidData ? "ready" : snapshot.loading ? "loading" : "closed"}</span>;
    }

    const view = render(<Subscriber />);
    expect(screen.getByText("closed")).toBeTruthy();
    act(() => filter.setPlayer("A", 1));
    expect(screen.getByText("loading")).toBeTruthy();
    const loadingRenders = renders;
    expect(filter.getSnapshot()).toBe(filter.getSnapshot());
    expect(renders).toBe(loadingRenders);
    await act(async () => {
      load.resolve(blockedList(["blocked"]));
      await load.promise;
    });
    expect(screen.getByText("ready")).toBeTruthy();
    expect(renders).toBe(loadingRenders + 1);
    view.unmount();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    filter.destroy();

    expect(consoleError).not.toHaveBeenCalled();
  });
});
