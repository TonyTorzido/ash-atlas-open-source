import type { FlagSnapshot, StrategicVisionSnapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  flagClaimIntersectsStrategicVision,
  replaceStrategicFlagSnapshots,
  StrategicVisionLoader
} from "./strategicVisionLoader.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("StrategicVisionLoader", () => {
  it("loads one authenticated snapshot for the authoritative anchor", async () => {
    vi.useFakeTimers();
    const snapshot = strategicSnapshot(35, -106, 3, 8);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const onResult = vi.fn(() => "accepted" as const);
    const loader = new StrategicVisionLoader("http://game.test", onResult, undefined, fetchImpl);

    loader.setAuthority(snapshot.authority);
    loader.setEnabled(true);
    await vi.runAllTimersAsync();

    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://game.test/api/map/strategic-vision");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ credentials: "include" });
    expect(onResult).toHaveBeenCalledWith(snapshot);
    loader.destroy();
  });

  it("does not rebind the browser fetch function to the loader", async () => {
    vi.useFakeTimers();
    const snapshot = strategicSnapshot(35, -106, 3, 8);
    const browserFetch = vi.fn(async () => new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", browserFetch);
    const onResult = vi.fn(() => "accepted" as const);
    const loader = new StrategicVisionLoader("http://game.test", onResult);

    loader.setAuthority(snapshot.authority);
    loader.setEnabled(true);
    await vi.runAllTimersAsync();

    expect(browserFetch.mock.contexts[0]).not.toBe(loader);
    expect(onResult).toHaveBeenCalledWith(snapshot);
    loader.destroy();
  });

  it("discards a response from the previous anchor generation", async () => {
    vi.useFakeTimers();
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    const onResult = vi.fn(() => "accepted" as const);
    const loader = new StrategicVisionLoader("http://game.test", onResult, undefined, fetchImpl);
    const oldSnapshot = strategicSnapshot(35, -106, 3, 8);
    const newSnapshot = strategicSnapshot(36, -105, 4, 9);

    loader.setAuthority(oldSnapshot.authority);
    loader.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    loader.setAuthority(newSnapshot.authority);
    resolveResponse(new Response(JSON.stringify(oldSnapshot), { status: 200 }));
    await Promise.resolve();

    expect(onResult).not.toHaveBeenCalled();
    loader.destroy();
  });

  it("retries when the current client revision rejects a stale snapshot", async () => {
    vi.useFakeTimers();
    const staleSnapshot = strategicSnapshot(35, -106, 3, 8);
    const currentSnapshot = {
      ...staleSnapshot,
      flagSetRevision: staleSnapshot.flagSetRevision + 1
    };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(staleSnapshot), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(currentSnapshot), { status: 200 }));
    const onResult = vi.fn((result: StrategicVisionSnapshot) =>
      result.flagSetRevision < currentSnapshot.flagSetRevision
        ? "retry" as const
        : "accepted" as const
    );
    const onStatus = vi.fn();
    const loader = new StrategicVisionLoader(
      "http://game.test",
      onResult,
      onStatus,
      fetchImpl
    );

    loader.setAuthority(staleSnapshot.authority);
    loader.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalledWith("ready");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenLastCalledWith(currentSnapshot);
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    loader.destroy();
  });

  it("retries when the server responds with a different current authority", async () => {
    vi.useFakeTimers();
    const requested = strategicSnapshot(35, -106, 3, 0);
    const serverCurrent = strategicSnapshot(35, -106, 3, 8);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(serverCurrent), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(requested), { status: 200 }));
    const onResult = vi.fn(() => "accepted" as const);
    const loader = new StrategicVisionLoader(
      "http://game.test",
      onResult,
      undefined,
      fetchImpl
    );

    loader.setAuthority(requested.authority);
    loader.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith(requested);
    loader.destroy();
  });

  it("converges on the latest authority across rapid reordered anchor changes", async () => {
    vi.useFakeTimers();
    const first = strategicSnapshot(35, -106, 3, 8);
    const second = strategicSnapshot(36, -105, 4, 9);
    const latest = strategicSnapshot(37, -104, 5, 10);
    const pending: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((resolve) => {
      pending.push(resolve);
    }));
    const onResult = vi.fn(() => "accepted" as const);
    const loader = new StrategicVisionLoader(
      "http://game.test",
      onResult,
      undefined,
      fetchImpl
    );

    loader.setAuthority(first.authority);
    loader.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    loader.setAuthority(second.authority);
    await vi.advanceTimersByTimeAsync(0);
    loader.setAuthority(latest.authority);
    await vi.advanceTimersByTimeAsync(0);

    pending[1]!(new Response(JSON.stringify(second), { status: 200 }));
    pending[0]!(new Response(JSON.stringify(first), { status: 200 }));
    pending[2]!(new Response(JSON.stringify(latest), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(latest);
    loader.destroy();
  });
});

describe("replaceStrategicFlagSnapshots", () => {
  it("recycles the previous anchor cache while preserving current gameplay flags", () => {
    const current = [flag("old-strategic"), flag("shared"), flag("gameplay")];
    const result = replaceStrategicFlagSnapshots(
      current,
      new Set(["old-strategic", "shared"]),
      [flag("new-strategic")],
      new Set(["shared", "gameplay"]),
      4,
      strategicSnapshot(35, -106, 3, 8).authority
    );
    expect(result.map((entry) => entry.id)).toEqual(["shared", "gameplay", "new-strategic"]);
  });

  it("retains recently visited off-circle flags and evicts the oldest cache entries", () => {
    const current = [
      flag("oldest", 36),
      flag("recent", 36.1),
      flag("current", 35)
    ];
    const result = replaceStrategicFlagSnapshots(
      current,
      new Set(current.map((entry) => entry.id)),
      [flag("new-current", 35)],
      new Set(),
      2,
      strategicSnapshot(35, -106, 3, 8).authority
    );
    expect(result.map((entry) => entry.id)).toEqual(["recent", "new-current"]);
  });

  it("keeps every current-circle flag when it consumes the entire cache budget", () => {
    const incoming = [flag("current-a", 35), flag("current-b", 35.01)];
    const result = replaceStrategicFlagSnapshots(
      [flag("cached", 36)],
      new Set(["cached"]),
      incoming,
      new Set(),
      2,
      strategicSnapshot(35, -106, 3, 8).authority
    );
    expect(result.map((entry) => entry.id)).toEqual(["current-a", "current-b"]);
  });
});

describe("flagClaimIntersectsStrategicVision", () => {
  it("retains a large claim whose center is beyond strategic vision", () => {
    const center = { lat: 35, lon: -106 };
    const outsideCenter = flag("blocking-claim", 35 + 3_500 / 111_195);
    outsideCenter.claimRadiusM = 1_000;

    expect(flagClaimIntersectsStrategicVision(outsideCenter, center)).toBe(true);
  });

  it("excludes a distant claim that cannot intersect strategic vision", () => {
    const center = { lat: 35, lon: -106 };
    const distant = flag("distant", 35 + 3_500 / 111_195);
    distant.claimRadiusM = 100;

    expect(flagClaimIntersectsStrategicVision(distant, center)).toBe(false);
  });
});

function strategicSnapshot(
  lat: number,
  lon: number,
  relocationRevision: number,
  gameplayViewGeneration: number
): StrategicVisionSnapshot {
  return {
    authority: {
      center: { lat, lon },
      radiusM: 10_000,
      relocationRevision,
      gameplayViewGeneration
    },
    flags: [flag("visible")],
    cities: [],
    landmarks: [],
    flagSetRevision: 42,
    complete: true
  };
}

function flag(id: string, lat = 35): FlagSnapshot {
  return {
    controlType: "personal",
    id,
    ownerId: "owner",
    name: id,
    lat,
    lon: -106,
    packageId: null,
    elevationM: null,
    terrainClass: null,
    biome: null,
    ecoregion: null,
    claimRadiusM: 500,
    cityId: null,
    createdAt: new Date(0).toISOString()
  };
}
