import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CityService } from "./cities.js";
import { CityFlagConversionCoordinator } from "./cityFlagConversionCoordinator.js";

describe("CityFlagConversionCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("waits for the authoritative deadline and replays exact start timestamps on reconnect", async () => {
    const harness = createHarness();
    const session = await harness.coordinator.start("player-1", "request-1", "flag-1");

    expect(session).not.toBeNull();
    expect(session!.completesAt - session!.startedAt).toBe(10_000);
    expect(harness.convertCityFlag).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_000);
    harness.coordinator.connectPlayer("player-1");
    expect(harness.sendStarted).toHaveBeenCalledTimes(2);
    expect(harness.sendStarted.mock.calls[1]![0]).toMatchObject({
      conversionId: session!.conversionId,
      startedAt: session!.startedAt,
      completesAt: session!.completesAt
    });

    await vi.advanceTimersByTimeAsync(5_999);
    expect(harness.convertCityFlag).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.convertCityFlag).toHaveBeenCalledOnce();
    expect(harness.convertCityFlag).toHaveBeenCalledWith("player-1", {
      requestId: "request-1",
      flagId: "flag-1"
    }, {});
    expect(harness.completed).toHaveBeenCalledOnce();
    expect(harness.sendError).not.toHaveBeenCalled();
  });

  it("deduplicates the same request and rejects conflicting player or flag work", async () => {
    const harness = createHarness();
    const session = await harness.coordinator.start("player-1", "request-1", "flag-1");
    const duplicate = await harness.coordinator.start("player-1", "request-1", "flag-1");

    expect(duplicate).toBe(session);
    expect(harness.previewCityFlagConversion).toHaveBeenCalledOnce();
    await expect(
      harness.coordinator.start("player-1", "request-2", "flag-2")
    ).rejects.toThrow("already in progress");
    await expect(
      harness.coordinator.start("player-2", "request-3", "flag-1")
    ).rejects.toThrow("already being contributed");

    await vi.advanceTimersByTimeAsync(10_000);
    await harness.coordinator.start("player-1", "request-1", "flag-1");
    expect(harness.convertCityFlag).toHaveBeenCalledOnce();
    expect(harness.replayCompleted).toHaveBeenCalledOnce();
  });

  it("publishes an authoritative error when deadline revalidation fails", async () => {
    const failure = new Error("Flag control changed during confirmation");
    const harness = createHarness({ conversionFailure: failure });
    await harness.coordinator.start("player-1", "request-1", "flag-1");

    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.completed).not.toHaveBeenCalled();
    expect(harness.sendError).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: "player-1",
        requestId: "request-1"
      }),
      failure
    );
    expect(harness.coordinator.activeForPlayer("player-1")).toBeNull();
  });

  it("cancels the active contribution when the player moves", async () => {
    const harness = createHarness();
    const session = await harness.coordinator.start("player-1", "request-1", "flag-1");

    expect(harness.coordinator.cancelPlayer("player-1", "movement")).toBe(true);
    expect(harness.cancelled).toHaveBeenCalledWith(session, "movement");
    expect(harness.coordinator.activeForPlayer("player-1")).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.convertCityFlag).not.toHaveBeenCalled();
    expect(harness.coordinator.cancelPlayer("player-1", "movement")).toBe(false);
  });

  it("does not report a mutation error after a committed conversion publication failure", async () => {
    const harness = createHarness({ publicationFailure: new Error("socket unavailable") });
    await harness.coordinator.start("player-1", "request-1", "flag-1");

    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.convertCityFlag).toHaveBeenCalledOnce();
    expect(harness.completed).toHaveBeenCalledOnce();
    expect(harness.sendError).not.toHaveBeenCalled();
    harness.coordinator.connectPlayer("player-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.replayCompleted).toHaveBeenCalledOnce();
  });

  it("replays a durable duplicate without starting a second timer or preflight", async () => {
    const harness = createHarness({ durableReplay: true });

    const session = await harness.coordinator.start(
      "player-1",
      "request-replay",
      "flag-1"
    );

    expect(session).toBeNull();
    expect(harness.replayCityFlagConversion).toHaveBeenCalledOnce();
    expect(harness.previewCityFlagConversion).not.toHaveBeenCalled();
    expect(harness.sendStarted).not.toHaveBeenCalled();
    expect(harness.convertCityFlag).not.toHaveBeenCalled();
    expect(harness.replayCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        conversionId: "request-replay",
        requestId: "request-replay",
        flagId: "flag-1"
      }),
      expect.objectContaining({ replayed: true })
    );
  });
});

function createHarness(options: {
  conversionFailure?: Error;
  publicationFailure?: Error;
  durableReplay?: boolean;
} = {}) {
  const previewCityFlagConversion = vi.fn(async (
    _playerId: string,
    flagId: string
  ) => ({
    cityId: "city-1",
    cityName: "Albuquerque",
    flagId,
    flagName: "North Gate",
    position: { lat: 35.1, lon: -106.6 }
  }));
  const convertCityFlag = vi.fn(async () => {
    if (options.conversionFailure) throw options.conversionFailure;
    return {
      cityId: "city-1",
      flagId: "flag-1",
      memberCount: 2,
      expansionFlagCount: 6,
      expansionFlagLimit: 11,
      replayed: false
    };
  });
  const replayCityFlagConversion = vi.fn(async () =>
    options.durableReplay
      ? {
          cityId: "city-1",
          flagId: "flag-1",
          memberCount: 2,
          expansionFlagCount: 6,
          expansionFlagLimit: 11,
          replayed: true
        }
      : null
  );
  const sendStarted = vi.fn();
  const sendError = vi.fn();
  const cancelled = vi.fn();
  const completed = vi.fn(async () => {
    if (options.publicationFailure) throw options.publicationFailure;
  });
  const replayCompleted = vi.fn();
  const coordinator = new CityFlagConversionCoordinator(
    10_000,
    {
      previewCityFlagConversion,
      replayCityFlagConversion,
      convertCityFlag
    } as unknown as CityService,
    {
      info: vi.fn(),
      warn: vi.fn()
    },
    {
      sendStarted,
      sendError,
      cancelled,
      completed,
      replayCompleted
    }
  );
  return {
    coordinator,
    previewCityFlagConversion,
    replayCityFlagConversion,
    convertCityFlag,
    sendStarted,
    sendError,
    cancelled,
    completed,
    replayCompleted
  };
}
