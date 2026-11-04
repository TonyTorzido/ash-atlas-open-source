import { describe, expect, it, vi } from "vitest";

import { coordinateAuthoritativeRelocation } from "./authoritativeRelocationCoordinator.js";

describe("authoritative relocation coordinator", () => {
  it.each(["ready", "degraded"] as const)("accepts %s presentation readiness", async (presentationStatus) => {
    const order: string[] = [];
    const transition = Symbol("travel");
    const phase2 = vi.fn(async () => {
      order.push("phase2");
    });
    const result = await coordinateAuthoritativeRelocation({
      playerId: "player",
      requestId: "request",
      destinationIdentity: "flag:1",
      unavailableReason: "unavailable",
      transitionPendingReason: "pending",
      unexpectedFailureReason: "failed",
      preCommitTimeoutReason: "timed-out",
      preCommitTimeoutMs: 1_000,
      preparationTimeoutReason: "preparation-timed-out",
      preparationTimeoutMs: 2_000,
      postCommitVisibilityTimeoutMs: 2_000,
      waitForVisibleBeforeRelease: true,
      available: true,
      beginTransition: () => transition,
      endTransition: (_transition, outcome) => order.push(`end:${outcome}`),
      prepareBeforeExclusive: async () => {
        order.push("preparation");
        return { success: true as const };
      },
      runExclusive: async (operation) => {
        order.push("fence");
        return operation();
      },
      applyPhaseOne: async () => {
        order.push("phase1");
        return {
          success: true as const,
          player: { relocationRevision: 4 },
          phase2,
          populationRelocation: { id: "population" }
        };
      },
      markTransitionPhase: vi.fn(),
      registerPreCommitAbort: vi.fn(),
      relocationRevision: (player) => player.relocationRevision,
      armCommittedWatchdog: () => order.push("watchdog"),
      waitForVisibleReady: async () => {
        order.push("visible");
        return presentationStatus;
      },
      onExclusiveFailure: vi.fn(),
      onPreCommitTimeout: vi.fn(),
      onVisibilityFailure: vi.fn()
    });

    await vi.waitFor(() => expect(phase2).toHaveBeenCalledOnce());
    expect(order).toEqual([
      "preparation",
      "fence",
      "phase1",
      "watchdog",
      "visible",
      "end:committed",
      "phase2"
    ]);
    expect(result).toMatchObject({
      success: true,
      committed: true,
      destinationIdentity: "flag:1",
      relocationRevision: 4,
      publicationResult: "published"
    });
  });

  it("publishes committed phase two when only the ready handoff is no longer current", async () => {
    const phase2 = vi.fn(async () => {});
    const endTransition = vi.fn();
    const result = await coordinateAuthoritativeRelocation({
      playerId: "player",
      requestId: "stale-publication",
      destinationIdentity: "flag:1",
      unavailableReason: "unavailable",
      transitionPendingReason: "pending",
      unexpectedFailureReason: "failed",
      preCommitTimeoutReason: "timed-out",
      preCommitTimeoutMs: 1_000,
      waitForVisibleBeforeRelease: true,
      available: true,
      beginTransition: () => Symbol("travel"),
      endTransition,
      runExclusive: (operation) => operation(),
      applyPhaseOne: async () => ({
        success: true as const,
        player: { relocationRevision: 4 },
        phase2,
        populationRelocation: { id: "population" }
      }),
      markTransitionPhase: vi.fn(),
      registerPreCommitAbort: vi.fn(),
      relocationRevision: (player) => player.relocationRevision,
      armCommittedWatchdog: vi.fn(),
      waitForVisibleReady: async () => "ready",
      onVisibilitySettled: async () => false,
      onExclusiveFailure: vi.fn(),
      onPreCommitTimeout: vi.fn(),
      onVisibilityFailure: vi.fn()
    });

    expect(result).toMatchObject({
      success: true,
      committed: true,
      relocationRevision: 4
    });
    expect(phase2).toHaveBeenCalledOnce();
    expect(endTransition).toHaveBeenCalledWith(
      expect.any(Symbol),
      "committed",
      "post-commit-visibility-publication-stale"
    );
  });

  it("times out preparation without entering the exclusive phase", async () => {
    vi.useFakeTimers();
    try {
      const runExclusive = vi.fn();
      const applyPhaseOne = vi.fn();
      const endTransition = vi.fn();
      const resultPromise = coordinateAuthoritativeRelocation({
        playerId: "player",
        requestId: "preparation-timeout",
        destinationIdentity: "flag:1",
        unavailableReason: "unavailable",
        transitionPendingReason: "pending",
        unexpectedFailureReason: "failed",
        preCommitTimeoutReason: "phase-one-timed-out",
        preCommitTimeoutMs: 1_000,
        preparationTimeoutReason: "preparation-timed-out",
        preparationTimeoutMs: 500,
        postCommitVisibilityTimeoutMs: 2_000,
        available: true,
        beginTransition: () => Symbol("travel"),
        endTransition,
        prepareBeforeExclusive: () => new Promise(() => {}),
        runExclusive,
        applyPhaseOne,
        markTransitionPhase: vi.fn(),
        registerPreCommitAbort: vi.fn(),
        relocationRevision: () => 0,
        armCommittedWatchdog: vi.fn(),
        waitForVisibleReady: vi.fn(),
        onExclusiveFailure: vi.fn(),
        onPreCommitTimeout: vi.fn(),
        onPreparationTimeout: vi.fn(),
        onVisibilityFailure: vi.fn()
      });

      await vi.advanceTimersByTimeAsync(500);
      await expect(resultPromise).resolves.toMatchObject({
        success: false,
        reason: "preparation-timed-out"
      });
      expect(runExclusive).not.toHaveBeenCalled();
      expect(applyPhaseOne).not.toHaveBeenCalled();
      // Preparation is intentionally outside the command-blocking transition.
      expect(endTransition).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a failed transition without starting readiness or phase two", async () => {
    const endTransition = vi.fn();
    const waitForVisibleReady = vi.fn();
    const result = await coordinateAuthoritativeRelocation({
      playerId: "player",
      requestId: "request",
      destinationIdentity: null,
      unavailableReason: "unavailable",
      transitionPendingReason: "pending",
      unexpectedFailureReason: "failed",
      preCommitTimeoutReason: "timed-out",
      preCommitTimeoutMs: 1_000,
      available: true,
      beginTransition: () => Symbol("travel"),
      endTransition,
      runExclusive: (operation) => operation(),
      applyPhaseOne: async () => ({ success: false as const, reason: "denied" }),
      markTransitionPhase: vi.fn(),
      registerPreCommitAbort: vi.fn(),
      relocationRevision: () => 0,
      armCommittedWatchdog: vi.fn(),
      waitForVisibleReady,
      onExclusiveFailure: vi.fn(),
      onPreCommitTimeout: vi.fn(),
      onVisibilityFailure: vi.fn()
    });

    expect(result).toMatchObject({ success: false, reason: "denied" });
    expect(endTransition).toHaveBeenCalledWith(
      expect.any(Symbol),
      "failed",
      "phase-one-failed"
    );
    expect(waitForVisibleReady).not.toHaveBeenCalled();
  });

  it("does not retain the committed transition when visible population never settles", async () => {
    const endTransition = vi.fn();
    const phase2 = vi.fn(async () => {});
    const result = await coordinateAuthoritativeRelocation({
      playerId: "player",
      requestId: "population-failed",
      destinationIdentity: "flag:1",
      unavailableReason: "unavailable",
      transitionPendingReason: "pending",
      unexpectedFailureReason: "failed",
      preCommitTimeoutReason: "timed-out",
      preCommitTimeoutMs: 1_000,
      available: true,
      beginTransition: () => Symbol("travel"),
      endTransition,
      runExclusive: (operation) => operation(),
      applyPhaseOne: async () => ({
        success: true as const,
        player: { relocationRevision: 4 },
        phase2,
        populationRelocation: { id: "population" }
      }),
      markTransitionPhase: vi.fn(),
      registerPreCommitAbort: vi.fn(),
      relocationRevision: (player) => player.relocationRevision,
      armCommittedWatchdog: vi.fn(),
      waitForVisibleReady: () => new Promise(() => {}),
      onExclusiveFailure: vi.fn(),
      onPreCommitTimeout: vi.fn(),
      onVisibilityFailure: vi.fn()
    });

    expect(result).toMatchObject({
      success: true,
      committed: true,
      relocationRevision: 4
    });
    expect(endTransition).toHaveBeenCalledWith(
      expect.any(Symbol),
      "committed",
      "authoritative-relocation-committed"
    );
    expect(phase2).toHaveBeenCalledOnce();
  });

  it("releases once after a phase-one exception", async () => {
    const endTransition = vi.fn();
    const failure = new Error("database unavailable");
    const onExclusiveFailure = vi.fn();

    const result = await coordinateAuthoritativeRelocation({
      playerId: "player",
      requestId: "exception",
      destinationIdentity: null,
      unavailableReason: "unavailable",
      transitionPendingReason: "pending",
      unexpectedFailureReason: "failed",
      preCommitTimeoutReason: "timed-out",
      preCommitTimeoutMs: 1_000,
      available: true,
      beginTransition: () => Symbol("travel"),
      endTransition,
      runExclusive: async () => {
        throw failure;
      },
      applyPhaseOne: async () => ({ success: false as const, reason: "denied" }),
      markTransitionPhase: vi.fn(),
      registerPreCommitAbort: vi.fn(),
      relocationRevision: () => 0,
      armCommittedWatchdog: vi.fn(),
      waitForVisibleReady: vi.fn(),
      onExclusiveFailure,
      onPreCommitTimeout: vi.fn(),
      onVisibilityFailure: vi.fn()
    });

    expect(result).toMatchObject({ success: false, reason: "failed" });
    expect(onExclusiveFailure).toHaveBeenCalledWith(failure);
    expect(endTransition).toHaveBeenCalledOnce();
    expect(endTransition).toHaveBeenCalledWith(
      expect.any(Symbol),
      "failed",
      "phase-one-failed"
    );
  });

  it("aborts and force-releases a stalled phase one at the pre-commit deadline", async () => {
    vi.useFakeTimers();
    try {
      const endTransition = vi.fn();
      const onPreCommitTimeout = vi.fn();
      const observedSignals: AbortSignal[] = [];
      const resultPromise = coordinateAuthoritativeRelocation({
        playerId: "player",
        requestId: "timeout",
        destinationIdentity: null,
        unavailableReason: "unavailable",
        transitionPendingReason: "pending",
        unexpectedFailureReason: "failed",
        preCommitTimeoutReason: "timed-out",
        preCommitTimeoutMs: 500,
        available: true,
        beginTransition: () => Symbol("travel"),
        endTransition,
        runExclusive: (operation) => operation(),
        applyPhaseOne: (signal) => {
          observedSignals.push(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true
            });
          });
        },
        markTransitionPhase: vi.fn(),
        registerPreCommitAbort: vi.fn(),
        relocationRevision: () => 0,
        armCommittedWatchdog: vi.fn(),
        waitForVisibleReady: vi.fn(),
        onExclusiveFailure: vi.fn(),
        onPreCommitTimeout,
        onVisibilityFailure: vi.fn()
      });

      await vi.advanceTimersByTimeAsync(500);
      await expect(resultPromise).resolves.toMatchObject({
        success: false,
        reason: "timed-out"
      });
      expect(observedSignals[0]?.aborted).toBe(true);
      expect(onPreCommitTimeout).toHaveBeenCalledOnce();
      expect(endTransition).toHaveBeenCalledOnce();
      expect(endTransition).toHaveBeenCalledWith(
        expect.any(Symbol),
        "failed",
        "phase-one-timeout"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-releases an abandoned pre-commit lookup after the hard abort deadline", async () => {
    vi.useFakeTimers();
    try {
      const endTransition = vi.fn();
      const resultPromise = coordinateAuthoritativeRelocation({
        playerId: "player",
        requestId: "abandoned",
        destinationIdentity: null,
        unavailableReason: "unavailable",
        transitionPendingReason: "pending",
        unexpectedFailureReason: "failed",
        preCommitTimeoutReason: "timed-out",
        preCommitTimeoutMs: 500,
        available: true,
        beginTransition: () => Symbol("travel"),
        endTransition,
        runExclusive: (operation) => operation(),
        applyPhaseOne: () => new Promise(() => {}),
        markTransitionPhase: vi.fn(),
        registerPreCommitAbort: vi.fn(),
        relocationRevision: () => 0,
        armCommittedWatchdog: vi.fn(),
        waitForVisibleReady: vi.fn(),
        onExclusiveFailure: vi.fn(),
        onPreCommitTimeout: vi.fn(),
        onVisibilityFailure: vi.fn()
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(resultPromise).resolves.toMatchObject({
        success: false,
        reason: "timed-out"
      });
      expect(endTransition).toHaveBeenCalledWith(
        expect.any(Symbol),
        "failed",
        "phase-one-abandoned-hard-deadline"
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
