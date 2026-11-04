import {
  FlagPlacementQuoteError,
  type ReadyFlagPlacementQuote
} from "./flagPlacementPreview.js";
import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";

export type FlagBuildIntentState = "idle" | "preparing" | "validating";

export type FlagBuildPlayerState = {
  moving: boolean;
  movementRevision: number;
  relocationRevision: number;
};

type MovementWaiter = {
  generation: number;
  bindingRelocationRevision: number | null;
  minimumStateVersion: number;
  traceId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: FlagPlacementQuoteError) => void;
};

export class FlagBuildIntent {
  private generation = 0;
  private state: FlagBuildIntentState = "idle";
  private playerState: FlagBuildPlayerState | null = null;
  private playerStateVersion = 0;
  private movementWaiter: MovementWaiter | null = null;

  constructor(
    private readonly ensureQuote: () => Promise<ReadyFlagPlacementQuote>,
    private readonly submit: (
      quoteId: string,
      anchorKind: ReadyFlagPlacementQuote["anchorKind"]
    ) => string | null,
    private readonly onState: (state: FlagBuildIntentState) => void,
    private readonly onError: (error: Error) => void,
    private readonly delay: (milliseconds: number) => Promise<void> = wait,
    private readonly movementSafetyTimeoutMs = 8_000,
    private readonly now: () => number = Date.now
  ) {}

  pending(): boolean {
    return this.state !== "idle";
  }

  updatePlayerState(state: FlagBuildPlayerState | null): void {
    this.playerState = state;
    this.playerStateVersion += 1;
    this.resolveMovementWaiter();
  }

  async start(): Promise<string | null> {
    if (this.pending()) return null;
    const generation = ++this.generation;
    const traceId = gameplayLatencyTrace.newTraceId();
    const bindingRelocationRevision = this.playerState?.relocationRevision ?? null;
    const movementDeadlineAt = this.now() + this.movementSafetyTimeoutMs;
    gameplayLatencyTrace.record("build", "build_clicked", {}, { traceId });
    this.setState("preparing");
    try {
      const quote = await this.ensureQuoteWithRetry(
        generation,
        traceId,
        bindingRelocationRevision,
        movementDeadlineAt
      );
      if (generation !== this.generation) return null;
      this.assertBinding(bindingRelocationRevision);
      this.setState("validating");
      const requestId = this.submit(quote.quoteId, quote.anchorKind);
      if (!requestId) {
        throw new FlagPlacementQuoteError(
          "disconnect",
          "Cannot place a flag while disconnected.",
          true
        );
      }
      gameplayLatencyTrace.record("build", "build_intent_sent", {
        requestId,
        quoteId: quote.quoteId
      }, { traceId });
      return requestId;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.setState("idle");
      this.onError(error instanceof Error ? error : new Error("Flag preparation failed."));
      return null;
    }
  }

  private async ensureQuoteWithRetry(
    generation: number,
    traceId: string,
    bindingRelocationRevision: number | null,
    movementDeadlineAt: number
  ): Promise<ReadyFlagPlacementQuote> {
    const maximumAttempts = 3;
    let lastError: unknown;
    let attempt = 1;
    this.assertBinding(bindingRelocationRevision);
    if (this.playerState?.moving) {
      await this.waitForMovementSettlement(
        generation,
        traceId,
        bindingRelocationRevision,
        movementDeadlineAt,
        false
      );
    }
    while (attempt <= maximumAttempts) {
      const playerStateVersionAtRequest = this.playerStateVersion;
      gameplayLatencyTrace.record("build", "build_waiting_for_quote", {
        attempt
      }, { traceId });
      try {
        const quote = await this.ensureQuote();
        this.assertBinding(bindingRelocationRevision);
        if (this.playerState?.moving) {
          await this.waitForMovementSettlement(
            generation,
            traceId,
            bindingRelocationRevision,
            movementDeadlineAt,
            false
          );
          continue;
        }
        if (attempt > 1) {
          gameplayLatencyTrace.record("build", "build_quote_retry_completed", {
            attempt,
            outcome: "QUOTE_READY"
          }, { traceId });
        }
        return quote;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof FlagPlacementQuoteError && error.retryable;
        const movementConvergencePending =
          error instanceof FlagPlacementQuoteError &&
          (error.code === "PLAYER_MOVING" || error.code === "REVISION_STALE");
        if (movementConvergencePending && generation === this.generation) {
          await this.waitForMovementSettlement(
            generation,
            traceId,
            bindingRelocationRevision,
            movementDeadlineAt,
            !this.playerState?.moving &&
              this.playerStateVersion === playerStateVersionAtRequest
          );
          continue;
        }
        if (attempt > 1) {
          gameplayLatencyTrace.record("build", "build_quote_retry_completed", {
            attempt,
            outcome: error instanceof FlagPlacementQuoteError
              ? error.code
              : "UNEXPECTED_ERROR",
            retryable
          }, { traceId });
        }
        if (!retryable || attempt >= maximumAttempts || generation !== this.generation) throw error;
        const retryAfterMs = Math.max(0, Math.min(250, error.retryAfterMs));
        gameplayLatencyTrace.record("build", "build_quote_retry_started", {
          attempt: attempt + 1,
          retryAfterMs,
          code: error.code
        }, { traceId });
        await this.delay(retryAfterMs);
        if (generation !== this.generation) throw error;
        attempt += 1;
      }
    }
    throw lastError;
  }

  complete(): void {
    this.generation += 1;
    this.rejectMovementWaiter(new FlagPlacementQuoteError(
      "invalidated",
      "Flag preparation was canceled.",
      true
    ));
    this.setState("idle");
  }

  cancel(reason?: "disconnect" | "invalidated"): void {
    const wasPending = this.pending();
    this.generation += 1;
    const cancellationError = reason === "disconnect"
      ? new FlagPlacementQuoteError(
          "disconnect",
          "Cannot place a flag while disconnected.",
          true
        )
      : new FlagPlacementQuoteError(
          "invalidated",
          "Flag placement changed before preparation completed.",
          true
        );
    this.rejectMovementWaiter(cancellationError);
    this.setState("idle");
    if (wasPending && reason) {
      this.onError(cancellationError);
    }
  }

  destroy(): void {
    this.cancel();
  }

  private setState(state: FlagBuildIntentState): void {
    this.state = state;
    this.onState(state);
  }

  private waitForMovementSettlement(
    generation: number,
    traceId: string,
    bindingRelocationRevision: number | null,
    movementDeadlineAt: number,
    requireNextState: boolean
  ): Promise<void> {
    this.assertBinding(bindingRelocationRevision);
    if (!this.playerState?.moving && !requireNextState) return Promise.resolve();
    if (this.movementWaiter) {
      return Promise.reject(new Error("A movement wait is already active."));
    }
    const remainingMs = Math.max(0, movementDeadlineAt - this.now());
    if (remainingMs === 0) {
      return Promise.reject(movementTimeoutError());
    }
    gameplayLatencyTrace.record("build", "build_waiting_for_movement", {
      code: "PLAYER_MOVING",
      movementRevision: this.playerState?.movementRevision ?? null,
      relocationRevision: this.playerState?.relocationRevision ?? null,
      safetyTimeoutMs: remainingMs
    }, { traceId });
    return new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        if (this.movementWaiter?.generation !== generation) return;
        this.movementWaiter = null;
        reject(movementTimeoutError());
      }, remainingMs);
      this.movementWaiter = {
        generation,
        bindingRelocationRevision,
        minimumStateVersion: this.playerStateVersion,
        traceId,
        timer,
        resolve,
        reject
      };
    });
  }

  private resolveMovementWaiter(): void {
    const waiter = this.movementWaiter;
    const state = this.playerState;
    if (!waiter || !state || this.playerStateVersion <= waiter.minimumStateVersion) return;
    if (
      waiter.bindingRelocationRevision !== null &&
      state.relocationRevision !== waiter.bindingRelocationRevision
    ) {
      this.clearMovementWaiter();
      waiter.reject(new FlagPlacementQuoteError(
        "invalidated",
        "Flag placement changed before preparation completed.",
        true
      ));
      return;
    }
    if (state.moving) return;
    this.clearMovementWaiter();
    gameplayLatencyTrace.record("build", "build_movement_settled", {
      movementRevision: state.movementRevision,
      relocationRevision: state.relocationRevision
    }, { traceId: waiter.traceId });
    waiter.resolve();
  }

  private assertBinding(bindingRelocationRevision: number | null): void {
    if (
      bindingRelocationRevision !== null &&
      this.playerState &&
      this.playerState.relocationRevision !== bindingRelocationRevision
    ) {
      throw new FlagPlacementQuoteError(
        "invalidated",
        "Flag placement changed before preparation completed.",
        true
      );
    }
  }

  private clearMovementWaiter(): void {
    if (!this.movementWaiter) return;
    globalThis.clearTimeout(this.movementWaiter.timer);
    this.movementWaiter = null;
  }

  private rejectMovementWaiter(error: FlagPlacementQuoteError): void {
    const waiter = this.movementWaiter;
    if (!waiter) return;
    this.clearMovementWaiter();
    waiter.reject(error);
  }
}

function movementTimeoutError(): FlagPlacementQuoteError {
  return new FlagPlacementQuoteError(
    "movement",
    "Stop moving to place a flag.",
    true
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
