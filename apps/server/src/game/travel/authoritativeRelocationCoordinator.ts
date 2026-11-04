export type AuthoritativeRelocationPhaseOneResult<
  Player,
  FailureReason,
  PopulationHandle
> =
  | Readonly<{
      success: true;
      player: Player;
      phase2: () => Promise<void>;
      populationRelocation: PopulationHandle | null;
    }>
  | Readonly<{
      success: false;
      reason: FailureReason;
    }>;

export type AuthoritativeRelocationResult<
  Player,
  FailureReason,
  PopulationHandle
> =
  | Readonly<{
      success: true;
      committed: true;
      player: Player;
      destinationIdentity: string | null;
      relocationRevision: number;
      publicationResult: "published";
      populationHandle: PopulationHandle | null;
      phaseTwo: "started";
      rollbackState: "not-required";
    }>
  | Readonly<{
      success: false;
      committed: false;
      reason: FailureReason;
      rollbackState: "not-applied-or-restored";
    }>;

export type AuthoritativeRelocationTransitionPhase =
  | "phase-one-running"
  | "committed"
  | "waiting-visible-population";

export type AuthoritativeRelocationPreparationResult<FailureReason> =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; reason: FailureReason }>;

export async function coordinateAuthoritativeRelocation<
  Player,
  FailureReason,
  PopulationHandle
>(input: Readonly<{
  playerId: string;
  requestId: string;
  destinationIdentity: string | null;
  unavailableReason: FailureReason;
  transitionPendingReason: FailureReason;
  unexpectedFailureReason: FailureReason;
  preCommitTimeoutReason: FailureReason;
  preCommitTimeoutMs: number;
  preparationTimeoutReason?: FailureReason;
  preparationTimeoutMs?: number;
  postCommitVisibilityTimeoutMs?: number;
  waitForVisibleBeforeRelease?: boolean;
  available: boolean;
  beginTransition: () => symbol | null;
  endTransition: (
    transition: symbol,
    outcome: "committed" | "failed",
    reason?: string
  ) => void;
  runExclusive: (
    operation: () => Promise<AuthoritativeRelocationPhaseOneResult<
      Player,
      FailureReason,
      PopulationHandle
    >>
  ) => Promise<AuthoritativeRelocationPhaseOneResult<
    Player,
    FailureReason,
    PopulationHandle
  >>;
  applyPhaseOne: (signal: AbortSignal) => Promise<AuthoritativeRelocationPhaseOneResult<
    Player,
    FailureReason,
    PopulationHandle
  >>;
  prepareBeforeExclusive?: (
    signal: AbortSignal
  ) => Promise<AuthoritativeRelocationPreparationResult<FailureReason>>;
  markTransitionPhase: (
    transition: symbol,
    phase: AuthoritativeRelocationTransitionPhase
  ) => void;
  registerPreCommitAbort: (
    transition: symbol,
    abort: () => void
  ) => void;
  relocationRevision: (player: Player) => number;
  armCommittedWatchdog: (transition: symbol, relocationRevision: number) => void;
  waitForVisibleReady: (
    transition: symbol,
    relocation: PopulationHandle | null
  ) => Promise<string>;
  onVisibilitySettled?: (
    status: string
  ) => boolean | void | Promise<boolean | void>;
  onExclusiveFailure: (error: unknown) => void;
  onPreCommitTimeout: (transition: symbol) => void;
  onPreparationTimeout?: () => void;
  onPreparationFailure?: (error: unknown) => void;
  onVisibilityFailure: (error: unknown) => void;
}>): Promise<AuthoritativeRelocationResult<Player, FailureReason, PopulationHandle>> {
  if (!input.available) {
    return failed(input.unavailableReason);
  }
  let releaseOutcome: "committed" | "failed" = "failed";
  let releaseReason = "phase-one-failed";
  let phaseTwo: (() => Promise<void>) | null = null;
  let observeVisiblePopulation: (() => Promise<void>) | null = null;
  let result: AuthoritativeRelocationResult<Player, FailureReason, PopulationHandle>;
  const abortController = new AbortController();
  let preparationFailure: FailureReason | null = null;
  if (input.prepareBeforeExclusive) {
    const preparationOutcome = await settleBeforeDeadline(
      input.prepareBeforeExclusive(abortController.signal),
      input.preparationTimeoutMs ?? input.preCommitTimeoutMs
    );
    if (preparationOutcome.status === "timed-out") {
      abortController.abort(new Error(
        "authoritative relocation population preparation deadline exceeded"
      ));
      input.onPreparationTimeout?.();
      preparationFailure =
        input.preparationTimeoutReason ?? input.preCommitTimeoutReason;
    } else if (preparationOutcome.status === "rejected") {
      input.onPreparationFailure?.(preparationOutcome.error);
      preparationFailure =
        input.preparationTimeoutReason ?? input.unexpectedFailureReason;
    } else if (!preparationOutcome.value.success) {
      preparationFailure = preparationOutcome.value.reason;
    }
  }
  if (preparationFailure !== null) return failed(preparationFailure);
  // Destination preparation can generate, materialize, and activate actors.
  // It intentionally happens before the WorldRuntime command-blocking lock.
  const transition = input.beginTransition();
  if (!transition) return failed(input.transitionPendingReason);
  input.registerPreCommitAbort(transition, () => {
    abortController.abort(new Error("authoritative relocation transition was released"));
  });
  try {
    {
      input.markTransitionPhase(transition, "phase-one-running");
      const phaseOneOperation =
        input.runExclusive(() => input.applyPhaseOne(abortController.signal));
      const phaseOneOutcome = await settleBeforeDeadline(
        phaseOneOperation,
        input.preCommitTimeoutMs
      );
      if (phaseOneOutcome.status === "timed-out") {
        abortController.abort(new Error(
          "authoritative relocation pre-commit deadline exceeded"
        ));
        releaseReason = "phase-one-timeout";
        input.onPreCommitTimeout(transition);
        // The travel persistence path has its own database statement deadline.
        // Keep authority fenced until its abort rollback settles so a late
        // persistence completion cannot overwrite newer accepted state.
        const abortSettlement = await settleBeforeDeadline(
          phaseOneOperation,
          input.preCommitTimeoutMs
        );
        if (abortSettlement.status === "timed-out") {
          releaseReason = "phase-one-abandoned-hard-deadline";
        }
        result = failed(input.preCommitTimeoutReason);
      } else {
        let phaseOne: AuthoritativeRelocationPhaseOneResult<
          Player,
          FailureReason,
          PopulationHandle
        >;
        if (phaseOneOutcome.status === "rejected") {
          input.onExclusiveFailure(phaseOneOutcome.error);
          phaseOne = { success: false, reason: input.unexpectedFailureReason };
        } else {
          phaseOne = phaseOneOutcome.value;
        }
        if (!phaseOne.success) {
          result = failed(phaseOne.reason);
        } else {
          const relocationRevision = input.relocationRevision(phaseOne.player);
          input.markTransitionPhase(transition, "committed");
          input.armCommittedWatchdog(transition, relocationRevision);
          input.markTransitionPhase(transition, "waiting-visible-population");
          releaseOutcome = "committed";
          releaseReason = "authoritative-relocation-committed";
          phaseTwo = phaseOne.phase2;
          const observeVisibility = async (): Promise<void> => {
            const visibilityOutcome = await settleBeforeDeadline(
              input.waitForVisibleReady(
                transition,
                phaseOne.populationRelocation
              ),
              input.postCommitVisibilityTimeoutMs ?? input.preCommitTimeoutMs
            );
            if (visibilityOutcome.status === "timed-out") {
              releaseReason = "post-commit-visibility-timeout";
              input.onVisibilityFailure(
                new Error(
                  "population visibility exceeded the post-commit deadline"
                )
              );
              return;
            }
            if (visibilityOutcome.status === "rejected") {
              releaseReason = "post-commit-visibility-failed";
              input.onVisibilityFailure(visibilityOutcome.error);
              return;
            }
            const visibleStatus = visibilityOutcome.value;
            const visibilityPublicationCurrent =
              await input.onVisibilitySettled?.(visibleStatus);
            if (visibilityPublicationCurrent === false) {
              releaseReason = "post-commit-visibility-publication-stale";
              return;
            }
            const terminalReady =
              visibleStatus === "ready"
              || visibleStatus === "degraded"
              || visibleStatus === "unavailable";
            const legacyBackgroundStatus =
              !input.waitForVisibleBeforeRelease
              && (
                visibleStatus === "preparing"
                || visibleStatus === "retrying-after-backpressure"
              );
            if (!terminalReady && !legacyBackgroundStatus) {
              releaseReason = `post-commit-visibility-${visibleStatus}`;
              input.onVisibilityFailure(
                new Error(`population visibility completed with ${visibleStatus}`)
              );
            }
          };
          if (input.waitForVisibleBeforeRelease) {
            releaseReason = "authoritative-relocation-visible-ready";
            await observeVisibility();
          } else {
            observeVisiblePopulation = observeVisibility;
          }
          result = {
            success: true,
            committed: true,
            player: phaseOne.player,
            destinationIdentity: input.destinationIdentity,
            relocationRevision,
            publicationResult: "published",
            populationHandle: phaseOne.populationRelocation,
            phaseTwo: "started",
            rollbackState: "not-required"
          };
        }
      }
    }
  } finally {
    input.endTransition(transition, releaseOutcome, releaseReason);
  }

  if (phaseTwo) void phaseTwo();
  if (observeVisiblePopulation) void observeVisiblePopulation();
  return result!;
}

function failed<FailureReason>(reason: FailureReason) {
  return {
    success: false as const,
    committed: false as const,
    reason,
    rollbackState: "not-applied-or-restored" as const
  };
}

async function settleBeforeDeadline<Value>(
  operation: Promise<Value>,
  timeoutMs: number
): Promise<
  | Readonly<{ status: "resolved"; value: Value }>
  | Readonly<{ status: "rejected"; error: unknown }>
  | Readonly<{ status: "timed-out" }>
> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation.then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error })
      ),
      new Promise<Readonly<{ status: "timed-out" }>>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "timed-out" }),
          Math.max(0, timeoutMs)
        );
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
