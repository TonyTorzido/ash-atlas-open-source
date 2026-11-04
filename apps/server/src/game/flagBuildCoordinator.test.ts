import type {
  FlagSnapshot,
  GameplayAreaContract,
  ResourceVision,
  ResourceVisionStatus
} from "@ash-atlas/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { PreparedCollectibleVision } from "./collectibles.js";
import { FlagBuildCoordinator } from "./flagBuildCoordinator.js";
import type { FlagService, PreparedFlagPlacement } from "./flags.js";
import type { PlayerRecord } from "./state.js";
import { PlayerAuthorityFence } from "./playerAuthorityFence.js";

const PLAYER: PlayerRecord = {
  playerId: "player-1", username: "Ash", displayColor: "#38bdf8", regionCode: "package-a",
  position: { lat: 35, lon: -106 }, anchor: { lat: 35, lon: -106 }, moveLeashRadiusM: 600,
  movementRevision: 4, target: null, online: true, updatedAt: new Date()
};

describe("FlagBuildCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("starts one exact future Resource Vision preparation without delaying construction", async () => {
    const harness = createHarness();
    const session = (await harness.coordinator.start(PLAYER, "request-1"))!;
    if (session.status !== "building") throw new Error("expected active build");

    expect(session.completesAt - session.startedAt).toBe(4_000);
    expect(harness.sendStarted).toHaveBeenCalledOnce();
    expect(harness.prepareResourceVision).toHaveBeenCalledOnce();
    expect(harness.prepareResourceVision).toHaveBeenCalledWith(expect.objectContaining({
      resourceVision: expect.objectContaining({
        flagId: session.preparedFlag.flagId,
        center: {
          lat: session.preparedFlag.lat,
          lon: session.preparedFlag.lon
        },
        movementLeashRadiusM: 600,
        radiusM: 650
      }),
      signal: expect.any(AbortSignal)
    }));
    expect(harness.commitPreparedPlacement).not.toHaveBeenCalled();
    expect(harness.commitResourceVision).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.prepareResourceVision).toHaveBeenCalledOnce();
    expect(harness.commitResourceVision).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_999);
    expect(harness.commitPreparedPlacement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(harness.commitPreparedPlacement).toHaveBeenCalledWith(
      session.preparedFlag,
      true,
      "request-1"
    );
    expect(harness.commitResourceVision).not.toHaveBeenCalled();
    expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ flag: expect.objectContaining({ id: session.preparedFlag.flagId }) })
    }));
  });

  it("commits at the exact authoritative deadline while population remains unresolved", async () => {
    let resolvePopulation!: () => void;
    let populationSettled = false;
    let populationSignal: AbortSignal | undefined;
    const commitTimes: number[] = [];
    const reservePopulation = vi.fn((input: {
      signal: AbortSignal;
    }) => {
      populationSignal = input.signal;
      return new Promise<void>((resolve) => {
        resolvePopulation = () => {
          populationSettled = true;
          resolve();
        };
      });
    });
    const harness = createHarness({
      reservePopulation,
      flagCommit: async (flag) => {
        commitTimes.push(Date.now());
        return flag;
      },
      preparedFlagOverrides: {
        regionCode: "package-future",
        buildDurationMs: 10_000
      }
    });

    const session = (await harness.coordinator.start(PLAYER, "request-population-warm"))!;
    if (session.status !== "building") throw new Error("expected active build");
    expect(harness.sendStarted).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(reservePopulation).toHaveBeenCalledWith(expect.objectContaining({
      buildId: session.buildId,
      playerId: PLAYER.playerId,
      connectionId: "connection-1",
      connectionGeneration: 3,
      area: expect.objectContaining({
        center: {
          lat: session.preparedFlag.lat,
          lon: session.preparedFlag.lon
        }
      }),
      signal: expect.any(AbortSignal)
    }));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(harness.commitPreparedPlacement).not.toHaveBeenCalled();
    expect(harness.completed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(commitTimes).toEqual([session.completesAt]);
    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(harness.completed).toHaveBeenCalledOnce();
    expect(populationSettled).toBe(false);
    expect(populationSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    resolvePopulation();
    await vi.advanceTimersByTimeAsync(0);
    expect(populationSettled).toBe(true);
    expect(commitTimes).toEqual([session.completesAt]);
    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(harness.completed).toHaveBeenCalledOnce();
    expect(harness.sendCancelled).not.toHaveBeenCalled();
  });

  it("retains successful build population preparation through commit", async () => {
    let populationSignal: AbortSignal | undefined;
    const harness = createHarness({
      reservePopulation: ({ signal }) => {
        populationSignal = signal;
        return new Promise<void>(() => undefined);
      },
      preparedFlagOverrides: { buildDurationMs: 10_000 }
    });

    await harness.coordinator.start(PLAYER, "request-retained-population");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(populationSignal?.aborted).toBe(false);
  });

  it("adopts an exact build-scoped reservation without starting duplicate work", async () => {
    const reservePopulation = vi.fn(async () => undefined);
    const releasePopulation = vi.fn(() => true);
    const adoptPopulation = vi.fn(() => "adopted" as const);
    const harness = createHarness({
      reservePopulation,
      releasePopulation,
      adoptPopulation,
      preparedFlagOverrides: { buildDurationMs: 10_000 }
    });

    const session = (await harness.coordinator.start(
      PLAYER,
      "request-reservation"
    ))!;
    if (session.status !== "building") throw new Error("expected active build");
    await Promise.resolve();

    expect(reservePopulation).toHaveBeenCalledOnce();
    expect(reservePopulation).toHaveBeenCalledWith(expect.objectContaining({
      buildId: session.buildId,
      playerId: PLAYER.playerId,
      connectionId: "connection-1",
      connectionGeneration: 3,
      area: {
        center: PLAYER.position,
        certifiedVisibleRadiusM: 650,
        preparedRadiusM: 1_350,
        sourceType: "flag",
        sourceId: session.preparedFlag.flagId,
        generation: 1
      }
    }));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(adoptPopulation).toHaveBeenCalledOnce();
    expect(adoptPopulation).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: expect.stringContaining(
        `flag-build:${PLAYER.playerId}:3:${session.buildId}`
      ),
      adoptedSourceId: expect.stringContaining(
        `flag-post-build:${session.preparedFlag.flagId}:${session.buildId}`
      ),
      area: expect.objectContaining({ preparedRadiusM: 1_350 })
    }));
    expect(releasePopulation).not.toHaveBeenCalled();
    expect(reservePopulation).toHaveBeenCalledOnce();
  });

  it("releases only the cancelled build reservation", async () => {
    const reservePopulation = vi.fn(async () => undefined);
    const releasePopulation = vi.fn(() => true);
    const harness = createHarness({
      reservePopulation,
      releasePopulation
    });
    const session = (await harness.coordinator.start(
      PLAYER,
      "request-cancel-reservation"
    ))!;
    if (session.status !== "building") throw new Error("expected active build");
    await Promise.resolve();

    expect(harness.coordinator.cancelPlayer(
      PLAYER.playerId,
      "combat",
      session.buildId
    )).toBe(true);
    expect(releasePopulation).toHaveBeenCalledOnce();
    expect(releasePopulation).toHaveBeenCalledWith(
      expect.stringContaining(session.buildId)
    );
  });

  it("commits normally when population preparation rejects before the deadline", async () => {
    let rejectPopulation!: (error: Error) => void;
    const harness = createHarness({
      reservePopulation: () => new Promise<void>((_resolve, reject) => {
        rejectPopulation = reject;
      }),
      preparedFlagOverrides: { buildDurationMs: 10_000 }
    });

    await harness.coordinator.start(PLAYER, "request-population-failure");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    rejectPopulation(new Error("cold population failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sendCancelled).not.toHaveBeenCalled();
    expect(harness.commitPreparedPlacement).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(harness.completed).toHaveBeenCalledOnce();
    expect(harness.sendCancelled).not.toHaveBeenCalled();
  });

  it("keeps a committed flag durable when population rejects afterward", async () => {
    let rejectPopulation!: (error: Error) => void;
    const harness = createHarness({
      reservePopulation: () => new Promise<void>((_resolve, reject) => {
        rejectPopulation = reject;
      }),
      preparedFlagOverrides: { buildDurationMs: 10_000 }
    });

    await harness.coordinator.start(PLAYER, "request-population-late-failure");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(harness.completed).toHaveBeenCalledOnce();

    rejectPopulation(new Error("late population failure"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(harness.completed).toHaveBeenCalledOnce();
    expect(harness.sendCancelled).not.toHaveBeenCalled();
    expect(harness.coordinator.cancelPlayer(
      PLAYER.playerId,
      "explicit"
    )).toBe(false);
  });

  it("cleans up a committed session when population never settles", async () => {
    const harness = createHarness({
      reservePopulation: () => new Promise<void>(() => undefined),
      preparedFlagOverrides: { buildDurationMs: 10_000 }
    });

    await harness.coordinator.start(PLAYER, "request-population-never");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(harness.completed).toHaveBeenCalledOnce();
    expect(harness.sendCancelled).not.toHaveBeenCalled();
    expect(harness.coordinator.cancelPlayer(
      PLAYER.playerId,
      "explicit"
    )).toBe(false);
  });

  it("aborts the countdown reservation when the build is canceled", async () => {
    let observedSignal: AbortSignal | undefined;
    const harness = createHarness({
      reservePopulation: ({ signal }) => {
        observedSignal = signal;
        return new Promise<void>(() => undefined);
      }
    });
    const session = (await harness.coordinator.start(PLAYER, "request-population-abort"))!;
    await Promise.resolve();
    expect(observedSignal?.aborted).toBe(false);

    expect(harness.coordinator.cancelPlayer(
      PLAYER.playerId,
      "disconnect",
      session.buildId
    )).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("refreshes placement quotes on world entry and movement settle", async () => {
    let movementListener: () => void = vi.fn();
    const harness = createHarness({
      subscribeMovementSettled: (_playerId, listener) => {
        movementListener = listener;
        return () => { movementListener = vi.fn(); };
      }
    });

    harness.coordinator.connectPlayer(PLAYER.playerId);
    await Promise.resolve();
    expect(harness.createPlacementQuote).toHaveBeenCalledOnce();
    expect(harness.prepareResourceVision).not.toHaveBeenCalled();

    movementListener();
    await Promise.resolve();
    expect(harness.createPlacementQuote).toHaveBeenCalledTimes(2);
    expect(harness.prepareResourceVision).not.toHaveBeenCalled();
  });

  it("does not reserve population when placement validation fails", async () => {
    const reservePopulation = vi.fn();
    const harness = createHarness({
      reservePopulation,
      prepareFlag: async () => {
        throw new Error("placement rejected");
      }
    });

    await expect(harness.coordinator.start(PLAYER, "request-rejected"))
      .rejects.toThrow("placement rejected");
    expect(reservePopulation).not.toHaveBeenCalled();
    expect(harness.sendStarted).not.toHaveBeenCalled();
  });

  it("does not prewarm continuously while movement remains pending", async () => {
    let movementPending = true;
    let movementListener: () => void = vi.fn();
    const harness = createHarness({
      isMovementPending: () => movementPending,
      subscribeMovementSettled: (_playerId, listener) => {
        movementListener = listener;
        return () => { movementListener = vi.fn(); };
      }
    });

    harness.coordinator.connectPlayer(PLAYER.playerId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.createPlacementQuote).not.toHaveBeenCalled();

    movementPending = false;
    movementListener();
    await Promise.resolve();
    expect(harness.createPlacementQuote).toHaveBeenCalledOnce();
  });

  it("prewarms a fresh quote on reconnect and explicit travel completion", async () => {
    const harness = createHarness();

    harness.coordinator.connectPlayer(PLAYER.playerId);
    await Promise.resolve();
    harness.coordinator.connectPlayer(PLAYER.playerId);
    await Promise.resolve();
    harness.coordinator.refreshQuoteForPlayer(PLAYER.playerId, "dev-teleport-completed");
    await Promise.resolve();

    expect(harness.createPlacementQuote).toHaveBeenCalledTimes(3);
  });

  it("suppresses background quote preparation while construction is active", async () => {
    const harness = createHarness();
    await harness.coordinator.start(PLAYER, "request-active");

    harness.coordinator.refreshQuoteForPlayer(PLAYER.playerId, "movement-settled");
    await Promise.resolve();

    expect(harness.createPlacementQuote).not.toHaveBeenCalled();
    expect(harness.notePostBuildQuoteSuppressed).toHaveBeenCalledOnce();
  });

  it("queues while moving and starts the full timer only after the player stops", async () => {
    const movingPlayer: PlayerRecord = {
      ...PLAYER,
      target: { lat: PLAYER.position.lat, lon: PLAYER.position.lon + 0.001 }
    };
    const harness = createHarness({ currentPlayer: () => movingPlayer });
    const queued = (await harness.coordinator.start(movingPlayer, "request-queued"))!;

    expect(queued.status).toBe("queued");
    expect(harness.sendQueued).toHaveBeenCalledWith(expect.objectContaining({
      buildId: queued.buildId,
      requestId: "request-queued"
    }));
    expect(harness.sendStarted).not.toHaveBeenCalled();
    expect(harness.prepareForPlayer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.sendStarted).not.toHaveBeenCalled();
    expect(harness.commitPreparedPlacement).not.toHaveBeenCalled();
    expect(harness.coordinator.cancelPlayer(PLAYER.playerId, "movement")).toBe(false);

    movingPlayer.target = null;
    movingPlayer.movementRevision += 1;
    await vi.advanceTimersByTimeAsync(50);

    const started = harness.coordinator.activeForPlayer(PLAYER.playerId);
    expect(started).toMatchObject({
      status: "building",
      buildId: queued.buildId,
      requestId: queued.requestId
    });
    expect(harness.prepareForPlayer).toHaveBeenCalledOnce();
    expect(harness.sendStarted).toHaveBeenCalledOnce();
    if (!started || started.status !== "building") throw new Error("queued build did not start");
    expect(started.completesAt - started.startedAt).toBe(4_000);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(harness.commitPreparedPlacement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
  });

  it("rejects a queued build when final stopped-position validation fails", async () => {
    const movingPlayer: PlayerRecord = {
      ...PLAYER,
      target: { lat: PLAYER.position.lat, lon: PLAYER.position.lon + 0.001 }
    };
    const harness = createHarness({
      currentPlayer: () => movingPlayer,
      prepareFlag: async () => {
        throw new Error("Cannot build here: inside claimed territory");
      }
    });
    await harness.coordinator.start(movingPlayer, "request-blocked");

    movingPlayer.target = null;
    movingPlayer.movementRevision += 1;
    await vi.advanceTimersByTimeAsync(50);

    expect(harness.queuedRejected).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "request-blocked" }),
      "Cannot build here: inside claimed territory"
    );
    expect(harness.sendStarted).not.toHaveBeenCalled();
    expect(harness.commitPreparedPlacement).not.toHaveBeenCalled();
    expect(harness.coordinator.activeForPlayer(PLAYER.playerId)).toBeNull();
  });

  it("queues when a movement command is accepted but not processed yet", async () => {
    let movementPending = true;
    const player: PlayerRecord = { ...PLAYER };
    const harness = createHarness({
      currentPlayer: () => player,
      isMovementPending: () => movementPending
    });

    const queued = (await harness.coordinator.start(player, "request-same-tick"))!;
    expect(queued.status).toBe("queued");
    expect(harness.sendStarted).not.toHaveBeenCalled();

    movementPending = false;
    player.target = { lat: player.position.lat, lon: player.position.lon + 0.001 };
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.sendStarted).not.toHaveBeenCalled();

    player.target = null;
    player.movementRevision += 1;
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.sendStarted).toHaveBeenCalledOnce();
  });

  it("cancels a build and aborts its unpublished speculative Resource Vision", async () => {
    const harness = createHarness();
    const session = (await harness.coordinator.start(PLAYER, "request-2"))!;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.prepareResourceVision).toHaveBeenCalledOnce();
    expect(harness.coordinator.cancelPlayer(PLAYER.playerId, "explicit", session.buildId)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.commitPreparedPlacement).not.toHaveBeenCalled();
    expect(harness.commitResourceVision).not.toHaveBeenCalled();
    expect(harness.sendCancelled).toHaveBeenCalledWith(expect.objectContaining({ buildId: session.buildId }), "explicit");
  });

  it("rejects a second request while replaying the same active request idempotently", async () => {
    const harness = createHarness();
    const first = (await harness.coordinator.start(PLAYER, "same-request"))!;
    const replay = (await harness.coordinator.start(PLAYER, "same-request"))!;
    expect(replay.buildId).toBe(first.buildId);
    expect(harness.prepareForPlayer).toHaveBeenCalledOnce();
    await expect(harness.coordinator.start(PLAYER, "different-request")).rejects.toThrow(/already/);
  });

  it("discards a preparation callback that resolves after cancellation", async () => {
    let resolvePlan!: (plan: PreparedCollectibleVision) => void;
    const deferred = {
      promise: new Promise<PreparedCollectibleVision>((resolve) => { resolvePlan = resolve; }),
      resolve: (plan: PreparedCollectibleVision) => resolvePlan(plan)
    };
    const harness = createHarness({ prepare: () => deferred.promise });
    const session = (await harness.coordinator.start(PLAYER, "request-late"))!;
    if (session.status !== "building") throw new Error("expected active build");
    await vi.advanceTimersByTimeAsync(1_000);
    harness.coordinator.cancelPlayer(PLAYER.playerId, "movement", session.buildId);
    deferred.resolve(planFor(session.preparedFlag.flagId));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.commitResourceVision).not.toHaveBeenCalled();
    expect(harness.completed).not.toHaveBeenCalled();
  });

  it("finishes the flag at four seconds without awaiting resource preparation", async () => {
    const harness = createHarness({
      prepare: () => new Promise<PreparedCollectibleVision>(() => undefined)
    });
    const session = (await harness.coordinator.start(PLAYER, "request-slow"))!;
    if (session.status !== "building") throw new Error("expected active build");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ flag: expect.any(Object) })
    }));
    expect(harness.commitResourceVision).not.toHaveBeenCalled();
    expect(harness.prepareResourceVision).toHaveBeenCalledOnce();
    expect(harness.resourcesReady).not.toHaveBeenCalled();
  });

  it("keeps an in-flight Resource Vision plan adoptable after the flag commits", async () => {
    let resolvePlan!: (plan: PreparedCollectibleVision) => void;
    let preparationSignal: AbortSignal | undefined;
    const harness = createHarness({
      prepare: (signal) => {
        preparationSignal = signal;
        return new Promise<PreparedCollectibleVision>((resolve) => {
          resolvePlan = resolve;
        });
      }
    });
    const session = (await harness.coordinator.start(
      PLAYER,
      "request-late-resource-adoption"
    ))!;
    if (session.status !== "building") throw new Error("expected active build");

    await vi.advanceTimersByTimeAsync(4_000);

    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(preparationSignal?.aborted).toBe(false);
    const completion = harness.completed.mock.calls[0]?.[0];
    expect(completion?.pendingResourceVisionPlan).toBeInstanceOf(Promise);

    resolvePlan(planFor(session.preparedFlag.flagId));
    await expect(completion!.pendingResourceVisionPlan).resolves.toMatchObject({
      buildId: session.buildId,
      sessionToken: 1,
      flagId: session.preparedFlag.flagId,
      radiusM: 650
    });
  });

  it("passes a completed speculative plan to durable adoption without committing it directly", async () => {
    const harness = createHarness();
    await harness.coordinator.start(PLAYER, "request-resource-retry");
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
    expect(harness.completed).toHaveBeenCalledOnce();
    expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({
      preparedResourceVisionPlan: expect.objectContaining({
        buildId: expect.any(String),
        sessionToken: 1,
        flagId: "11111111-1111-4111-8111-111111111111",
        radiusM: 650,
        plan: expect.any(Object)
      })
    }));
    expect(harness.sendCancelled).not.toHaveBeenCalled();
    expect(harness.commitResourceVision).not.toHaveBeenCalled();
    expect(harness.resourcesReady).not.toHaveBeenCalled();
  });

  it("aborts the countdown-time Resource Vision worker", async () => {
    let observedSignal: AbortSignal | undefined;
    const harness = createHarness({
      prepare: (signal) => new Promise<PreparedCollectibleVision>((_resolve, reject) => {
        observedSignal = signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    });
    const session = (await harness.coordinator.start(PLAYER, "request-abort"))!;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.coordinator.preparationMetrics()).toMatchObject({ active: 1, queued: 0 });

    expect(harness.coordinator.cancelPlayer(PLAYER.playerId, "movement", session.buildId)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(observedSignal?.aborted).toBe(true);
    expect(harness.coordinator.preparationMetrics()).toMatchObject({ active: 0, queued: 0 });
  });

  it("does not consume preparation workers for concurrent builds", async () => {
    const harness = createHarness({
      prepare: (signal) => new Promise<PreparedCollectibleVision>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    });
    const players = [1, 2, 3].map((index) => ({
      ...PLAYER,
      playerId: `queued-player-${index}`,
      username: `Ash ${index}`
    }));
    const sessions = await Promise.all(players.map((player, index) =>
      harness.coordinator.start(player, `queued-request-${index}`)
    ));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.coordinator.preparationMetrics()).toMatchObject({ active: 3, queued: 0 });

    expect(harness.coordinator.cancelPlayer(players[2]!.playerId, "disconnect", sessions[2]!.buildId)).toBe(true);
    expect(harness.coordinator.preparationMetrics()).toMatchObject({ active: 2, queued: 0 });
    harness.coordinator.cancelPlayer(players[0]!.playerId, "disconnect", sessions[0]!.buildId);
    harness.coordinator.cancelPlayer(players[1]!.playerId, "disconnect", sessions[1]!.buildId);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.coordinator.preparationMetrics()).toMatchObject({ active: 0, queued: 0 });
  });

  it("replays a recent completed request without retaining or committing another flag", async () => {
    const harness = createHarness();
    await harness.coordinator.start(PLAYER, "request-replay");
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(harness.coordinator.start(PLAYER, "request-replay")).resolves.toBeNull();
    expect(harness.replayCompleted).toHaveBeenCalledWith({
      playerId: PLAYER.playerId,
      requestId: "request-replay",
      buildId: expect.any(String),
      flagId: "11111111-1111-4111-8111-111111111111"
    });
    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();
  });

  it("lets movement win the shared fence before completion without a partial flag", async () => {
    const harness = createHarness();
    const session = (await harness.coordinator.start(PLAYER, "request-movement-wins"))!;
    let allowMovement!: () => void;
    const movementGate = new Promise<void>((resolve) => { allowMovement = resolve; });
    const movement = harness.authorityFence.run(PLAYER.playerId, async () => {
      await movementGate;
      harness.coordinator.cancelPlayer(PLAYER.playerId, "movement", session.buildId);
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.commitPreparedPlacement).not.toHaveBeenCalled();
    allowMovement();
    await movement;
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.commitPreparedPlacement).not.toHaveBeenCalled();
    expect(harness.sendCancelled).toHaveBeenCalledOnce();
  });

  it("lets completion win the shared fence before later movement proceeds", async () => {
    let finishCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { finishCommit = resolve; });
    const harness = createHarness({ flagCommit: async (flag) => {
      await commitGate;
      return flag;
    } });
    const session = (await harness.coordinator.start(PLAYER, "request-completion-wins"))!;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.commitPreparedPlacement).toHaveBeenCalledOnce();

    let movementRan = false;
    const movement = harness.authorityFence.run(PLAYER.playerId, async () => {
      movementRan = true;
      expect(harness.coordinator.cancelPlayer(PLAYER.playerId, "movement", session.buildId)).toBe(false);
    });
    await Promise.resolve();
    expect(movementRan).toBe(false);
    finishCommit();
    await vi.advanceTimersByTimeAsync(0);
    await movement;
    expect(movementRan).toBe(true);
    expect(harness.completed).toHaveBeenCalledOnce();
    expect(harness.sendCancelled).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  prepare?: (signal?: AbortSignal) => Promise<PreparedCollectibleVision>;
  commit?: (status: ResourceVisionStatus) => Promise<ResourceVisionStatus>;
  flagCommit?: (result: { flag: FlagSnapshot }) => Promise<{ flag: FlagSnapshot }>;
  currentPlayer?: () => PlayerRecord | null;
  isMovementPending?: () => boolean;
  prepareFlag?: () => Promise<PreparedFlagPlacement>;
  preparedFlagOverrides?: Partial<PreparedFlagPlacement>;
  reservePopulation?: (input: {
    sourceId: string;
    authorityToken: string;
    buildId: string;
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    area: GameplayAreaContract;
    signal: AbortSignal;
    expiresAtMs: number;
  }) => void | Promise<void>;
  releasePopulation?: (sourceId: string) => boolean;
  adoptPopulation?: (input: {
    sourceId: string;
    adoptedSourceId: string;
    authorityToken: string;
    buildId: string;
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    area: GameplayAreaContract;
    expiresAtMs: number;
  }) => "adopted" | "missing" | "rejected";
  subscribeMovementSettled?: (playerId: string, listener: () => void) => () => void;
} = {}) {
  const preparedFlag: PreparedFlagPlacement = {
    flagId: "11111111-1111-4111-8111-111111111111", ownerId: PLAYER.playerId,
    ownerUsername: PLAYER.username, ownerColor: "#38bdf8",
    name: "Flag 1", lat: PLAYER.position.lat, lon: PLAYER.position.lon,
    regionCode: PLAYER.regionCode,
    movementLeashRadiusM: PLAYER.moveLeashRadiusM,
    movementRevision: PLAYER.movementRevision,
    relocationRevision: 0,
    builderRank: 0,
    buildDurationMs: 4_000,
    materialAffordable: true,
    admissionTimings: {
      defaultNameMs: 0, territoryAdmissionMs: 0, worldLookupMs: 0,
      builderRankMs: 0, affordabilityMs: 0, totalMs: 0, quoteState: "miss"
    },
    world: { ok: true, packageId: PLAYER.regionCode, elevationM: 1, terrainClass: "flat", biome: "plain", ecoregion: "plain", isLand: true, isSaltwater: false, raw: {} },
    ...options.preparedFlagOverrides,
    anchorKind: options.preparedFlagOverrides?.anchorKind ?? "flag"
  };
  const flag: FlagSnapshot = {
    id: preparedFlag.flagId, controlType: "personal", ownerId: PLAYER.playerId, name: preparedFlag.name,
    lat: preparedFlag.lat, lon: preparedFlag.lon, packageId: PLAYER.regionCode,
    elevationM: 1, terrainClass: "flat", biome: "plain", ecoregion: "plain",
    claimRadiusM: 1_000, cityId: null, createdAt: new Date().toISOString()
  };
  const status: ResourceVisionStatus = {
    flagId: flag.id, layoutVersion: "resource-layout-v2", status: "ready", radiusM: 650, nodeCount: 0, waterHighlightCount: 0,
    requestedAt: new Date().toISOString(), generatedAt: new Date().toISOString(), lastError: null,
    updatedAt: new Date().toISOString()
  };
  const prepareForPlayer = vi.fn(async () => options.prepareFlag
    ? options.prepareFlag()
    : preparedFlag);
  const commitPreparedPlacement = vi.fn(async () => options.flagCommit
    ? options.flagCommit({ flag })
    : ({ flag }));
  const prepareResourceVision = vi.fn(async (input: {
    resourceVision: ResourceVision;
    signal?: AbortSignal;
  }) => options.prepare
    ? options.prepare(input.signal)
    : planFor(preparedFlag.flagId, input.resourceVision));
  const commitResourceVision = vi.fn(async () => options.commit ? options.commit(status) : status);
  const markResourceVisionPending = vi.fn(async () => ({
    ...status,
    status: "pending" as const,
    generatedAt: null
  }));
  const sendQueued = vi.fn(); const sendStarted = vi.fn(); const sendCancelled = vi.fn();
  const queuedRejected = vi.fn(); const committed = vi.fn(); const completed = vi.fn(); const resourcesReady = vi.fn();
  const replayCompleted = vi.fn();
  const createPlacementQuote = vi.fn(async () => ({
    world: preparedFlag.world,
    quote: {
      quoteId: "quote-1",
      position: PLAYER.position,
      movementRevision: PLAYER.movementRevision,
      relocationRevision: PLAYER.relocationRevision ?? 0,
      worldReleaseId: "test",
      materialAffordable: true,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000
    }
  }));
  const notePostBuildQuoteSuppressed = vi.fn();
  const authorityFence = new PlayerAuthorityFence();
  const coordinator = new FlagBuildCoordinator(
    loadConfig({ NODE_ENV: "test", FLAG_BUILD_DURATION_MS: "4000", FLAG_BUILD_PREWARM_DELAY_MS: "1000" }),
    {
      prepareForPlayer,
      commitPreparedPlacement,
      createPlacementQuote,
      notePostBuildQuoteSuppressed
    } as unknown as FlagService,
    { info: vi.fn(), warn: vi.fn() },
    {
      currentPlayer: options.currentPlayer ?? (() => PLAYER), isEligible: () => true,
      isMovementPending: options.isMovementPending ?? (() => false),
      isWorldTransitionPending: () => false,
      subscribeMovementSettled: options.subscribeMovementSettled ?? ((_playerId, listener) => {
        const timer = setTimeout(listener, 50);
        return () => clearTimeout(timer);
      }),
      runAuthorityFence: (playerId, operation) => authorityFence.run(playerId, operation),
      ...(options.reservePopulation
        ? {
            currentConnectionAuthority: () => ({
              connectionId: "connection-1",
              connectionGeneration: 3
            }),
            reservePopulation: options.reservePopulation,
            ...(options.releasePopulation
              ? { releasePopulation: options.releasePopulation }
              : {}),
            ...(options.adoptPopulation
              ? { adoptPopulation: options.adoptPopulation }
              : {})
          }
        : {}),
      replayCompleted, sendQueued, sendStarted, sendCancelled, queuedRejected,
      prepareResourceVision: ({ resourceVision, signal }) =>
        prepareResourceVision({ resourceVision, signal }),
      committed,
      completed
    }
  );
  return {
    coordinator,
    authorityFence,
    replayCompleted,
    prepareForPlayer,
    createPlacementQuote,
    notePostBuildQuoteSuppressed,
    commitPreparedPlacement,
    prepareResourceVision,
    commitResourceVision,
    markResourceVisionPending,
    sendQueued,
    sendStarted,
    sendCancelled,
    queuedRejected,
    committed,
    completed,
    resourcesReady
  };
}

function planFor(
  flagId: string,
  resourceVision: ResourceVision = {
    flagId,
    flagName: "Flag 1",
    center: PLAYER.position,
    movementLeashRadiusM: 600,
    paddingM: 50,
    radiusM: 650
  }
): PreparedCollectibleVision {
  return {
    resourceVision,
    layoutVersion: "resource-layout-v2",
    waterHighlights: [],
    preparedAt: Date.now(),
    commitTimings: null,
    timings: {
      waterHighlightMs: 0,
      totalMs: 0
    }
  };
}
