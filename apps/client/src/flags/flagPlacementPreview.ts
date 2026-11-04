import {
  classifyFlagPlacementTerrain,
  distanceMeters,
  type PersonalAnchorKind,
  type FlagPlacementWaterDecision,
  type FlagPlacementTerrain
} from "@ash-atlas/shared";
import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";

export const FLAG_PREVIEW_MOVEMENT_THRESHOLD_M = 8;
export const FLAG_PREVIEW_CACHE_TTL_MS = 15_000;
const LOOKUP_DEBOUNCE_MS = 120;
const QUOTE_REQUEST_TIMEOUT_MS = 1_250;

type Point = { lat: number; lon: number };
export type ReadyFlagPlacementQuote = {
  anchorKind: PersonalAnchorKind;
  quoteId: string;
  expiresAt: number;
  createdAt: number;
  position: Point;
  traceId: string;
  quoteRequestId: string;
};

export class FlagPlacementQuoteError extends Error {
  constructor(
    readonly reason: "movement" | "disconnect" | "destroyed" | "invalidated" | "unavailable",
    message: string,
    readonly retryable = true,
    readonly code = defaultFlagPlacementQuoteCode(reason),
    readonly retryAfterMs = 150
  ) {
    super(message);
    this.name = "FlagPlacementQuoteError";
  }
}

type LookupResponse = {
  ok?: boolean;
  outcome?: string;
  message?: string;
  retryable?: boolean;
  traceId?: string;
  quoteRequestId?: string;
  authoritativePosition?: Point;
  flagPlacementWater?: FlagPlacementWaterDecision | null;
  isLand?: boolean | null;
  isSaltwater?: boolean | null;
  insideMajorLake?: boolean | null;
  landCoverClass?: string | null;
  worldReleaseId?: string | null;
  placementQuote?: {
    anchorKind?: PersonalAnchorKind;
    quoteId: string;
    createdAt?: number;
    expiresAt: number;
  };
  placementFailure?: {
    code?: string;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  };
  retryAfterMs?: number;
};

export type FlagPlacementQuoteRequestContext = {
  movementRevision?: number;
  relocationRevision?: number;
};

type QuoteTrigger = "background" | "build" | "refresh" | "diagnostic";

export class FlagPlacementPreviewTerrain {
  private anchorKind: PersonalAnchorKind = "flag";
  private position: Point | null = null;
  private pendingPosition: Point | null = null;
  private resolved: {
    position: Point;
    terrain: FlagPlacementTerrain;
    releaseId: string | null;
    resolvedAt: number;
  } | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private quoteRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private quote: ReadyFlagPlacementQuote | null = null;
  private lookupPromise: Promise<ReadyFlagPlacementQuote | null> | null = null;

  constructor(
    private readonly serverHttpBase: string,
    private readonly onTerrain: (terrain: FlagPlacementTerrain) => void,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now,
    private readonly requestContext: () => FlagPlacementQuoteRequestContext = () => ({}),
    private readonly csrfToken = ""
  ) {}

  setPosition(position: Point | null): void {
    this.position = position;
    if (!position) {
      this.cancelPending("movement");
      this.quote = null;
      this.onTerrain("unknown");
      return;
    }
    const resolvedMatchesPosition = Boolean(
      this.resolved &&
      this.resolved.position.lat === position.lat &&
      this.resolved.position.lon === position.lon
    );
    const quoteMatchesPosition = Boolean(
      this.quote &&
      this.quote.position.lat === position.lat &&
      this.quote.position.lon === position.lon &&
      this.quote.expiresAt > this.now()
    );
    if (
      this.resolved &&
      resolvedMatchesPosition &&
      this.now() - this.resolved.resolvedAt < FLAG_PREVIEW_CACHE_TTL_MS &&
      quoteMatchesPosition
    ) {
      this.onTerrain(this.resolved.terrain);
      return;
    }
    if (
      this.pendingPosition &&
      this.pendingPosition.lat === position.lat &&
      this.pendingPosition.lon === position.lon
    ) {
      return;
    }
    this.cancelPending("movement");
    this.onTerrain("unknown");
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      void this.startLookup(position).catch(() => undefined);
    }, LOOKUP_DEBOUNCE_MS);
  }

  setWorldReleaseId(releaseId: string | null): void {
    if (!releaseId || this.resolved?.releaseId === releaseId) return;
    this.resolved = null;
    this.quote = null;
    const position = this.position;
    this.cancelPending("invalidated");
    if (position) this.setPosition(position);
  }

  invalidateCurrentPosition(): void {
    const position = this.position;
    this.resolved = null;
    this.quote = null;
    this.cancelPending("invalidated");
    this.setPosition(position);
  }

  destroy(): void {
    this.cancelPending("destroyed");
    this.quote = null;
  }

  currentQuoteId(): string | undefined {
    return this.quote && this.quote.expiresAt > this.now() ? this.quote.quoteId : undefined;
  }

  currentQuote(): ReadyFlagPlacementQuote | null {
    return this.quote && this.quote.expiresAt > this.now() ? { ...this.quote } : null;
  }

  consumeQuote(quoteId: string): void {
    if (this.quote?.quoteId !== quoteId) return;
    this.quote = null;
    if (this.quoteRefreshTimer !== null) globalThis.clearTimeout(this.quoteRefreshTimer);
    this.quoteRefreshTimer = null;
  }

  quoteRequestInFlight(): boolean {
    return this.lookupPromise !== null || this.timer !== null;
  }

  cancel(reason: "disconnect" | "destroyed" | "movement" | "invalidated"): void {
    this.cancelPending(reason);
    this.quote = null;
  }

  async ensureQuoteForCurrentPosition(anchorKind: PersonalAnchorKind = "flag"): Promise<ReadyFlagPlacementQuote> {
    const position = this.position;
    if (!position) {
      throw new FlagPlacementQuoteError("unavailable", "A current location is not available.", false);
    }
    if (this.anchorKind !== anchorKind) {
      this.anchorKind = anchorKind;
      this.cancelPending("invalidated");
    }
    const current = this.currentQuote();
    if (
      current &&
      distanceMeters(current.position, position) < FLAG_PREVIEW_MOVEMENT_THRESHOLD_M
    ) {
      return current;
    }
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer);
      this.timer = null;
    }
    const quote = await this.startLookup(position, "build");
    if (!quote) {
      throw new FlagPlacementQuoteError(
        "unavailable",
        "Location preparation could not be completed. Try again."
      );
    }
    if (
      !this.position ||
      distanceMeters(this.position, position) >= FLAG_PREVIEW_MOVEMENT_THRESHOLD_M
    ) {
      throw new FlagPlacementQuoteError(
        "movement",
        "Flag preparation canceled because you moved."
      );
    }
    return quote;
  }

  refreshForDiagnostics(): Promise<ReadyFlagPlacementQuote | null> {
    const position = this.position;
    if (!position) return Promise.resolve(null);
    this.quote = null;
    return this.startLookup(position, "diagnostic");
  }

  private startLookup(
    position: Point,
    trigger: QuoteTrigger = "background"
  ): Promise<ReadyFlagPlacementQuote | null> {
    if (
      this.lookupPromise &&
      this.pendingPosition?.lat === position.lat &&
      this.pendingPosition?.lon === position.lon
    ) {
      return this.lookupPromise;
    }
    const promise = this.lookup(position, trigger);
    this.lookupPromise = promise;
    void promise.finally(() => {
      if (this.lookupPromise === promise) this.lookupPromise = null;
    }).catch(() => undefined);
    return promise;
  }

  private async lookup(
    position: Point,
    trigger: QuoteTrigger
  ): Promise<ReadyFlagPlacementQuote | null> {
    const generation = ++this.generation;
    const quoteRequestId = crypto.randomUUID();
    const traceId = gameplayLatencyTrace.newTraceId();
    this.pendingPosition = position;
    this.controller = new AbortController();
    const requestController = this.controller;
    let requestTimedOut = false;
    const requestTimeout = globalThis.setTimeout(() => {
      requestTimedOut = true;
      requestController.abort();
    }, QUOTE_REQUEST_TIMEOUT_MS);
    const url = new URL("/api/flags/placement-quote", this.serverHttpBase);
    const context = this.requestContext();
    const startedAt = performance.now();
    gameplayLatencyTrace.record("flag-preparation", "quote_request_transmitted", {
      quoteRequestId,
      trigger,
      requestedLat: position.lat,
      requestedLon: position.lon,
      movementRevision: context.movementRevision ?? null,
      relocationRevision: context.relocationRevision ?? null,
      endpoint: "/api/flags/placement-quote"
    }, { traceId });
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        credentials: "include",
        signal: requestController.signal,
        headers: {
          "content-type": "application/json",
          "x-csrf-token": this.csrfToken
        },
        body: JSON.stringify({
          quoteRequestId,
          traceId,
          trigger,
          requestedPosition: position,
          anchorKind: this.anchorKind,
          ...context
        })
      });
      if (!response.ok) {
        throw new FlagPlacementQuoteError(
          "unavailable",
          `Location preparation request failed (${response.status}).`,
          isRetryableHttpStatus(response.status),
          "HTTP_ERROR",
          parseRetryAfterMs(response.headers.get("retry-after"))
        );
      }
      if (generation !== this.generation) {
        throw this.cancellationError(generation);
      }
      const result = await response.json() as LookupResponse;
      if (generation !== this.generation) throw this.cancellationError(generation);
      gameplayLatencyTrace.record("flag-preparation", "quote_response_received", {
        quoteRequestId,
        trigger,
        outcome: result.outcome ?? "UNKNOWN",
        totalMs: performance.now() - startedAt,
        quotePresent: Boolean(result.placementQuote),
        retryable: result.placementFailure?.retryable ?? result.retryable ?? false,
        richWorldCalls: 0
      }, {
        traceId,
        failure: !result.placementQuote
      });
      const terrain = classifyFlagPlacementTerrain(result);
      const authoritativePosition = result.authoritativePosition ?? position;
      this.resolved = {
        position: authoritativePosition,
        terrain,
        releaseId: result.worldReleaseId ?? null,
        resolvedAt: this.now()
      };
      this.onTerrain(terrain);
      if (!result.placementQuote) {
        const failure = result.placementFailure;
        throw new FlagPlacementQuoteError(
          result.outcome === "PLAYER_MOVING" ? "movement" : "unavailable",
          failure?.message ?? result.message ?? "Location preparation could not be completed.",
          failure?.retryable ?? result.retryable ?? true,
          failure?.code ?? result.outcome ?? "INTERNAL_ERROR",
          failure?.retryAfterMs ?? result.retryAfterMs ?? 150
        );
      }
      this.quote = result.placementQuote
        ? {
            ...result.placementQuote,
            anchorKind: result.placementQuote.anchorKind ?? this.anchorKind,
            createdAt: result.placementQuote.createdAt ?? this.now(),
            position: authoritativePosition,
            traceId: result.traceId ?? traceId,
            quoteRequestId: result.quoteRequestId ?? quoteRequestId
          }
        : null;
      this.scheduleQuoteRefresh();
      return this.quote;
    } catch (error) {
      if (error instanceof FlagPlacementQuoteError) throw error;
      if (generation !== this.generation) {
        throw this.cancellationError(generation);
      }
      if (isAbortError(error)) {
        if (requestTimedOut) {
          this.onTerrain("unknown");
          throw new FlagPlacementQuoteError(
            "unavailable",
            "Location preparation timed out. Try again.",
            true,
            "QUOTE_REQUEST_TIMEOUT",
            150
          );
        }
        throw this.cancellationError(generation);
      }
      if (generation === this.generation) {
        this.onTerrain("unknown");
      }
      throw error;
    } finally {
      globalThis.clearTimeout(requestTimeout);
      if (generation === this.generation) {
        this.pendingPosition = null;
        this.controller = null;
      }
    }
  }

  private readonly cancellationReasons = new Map<number, FlagPlacementQuoteError["reason"]>();

  private cancelPending(reason: FlagPlacementQuoteError["reason"]): void {
    if (this.controller || this.lookupPromise) {
      this.cancellationReasons.set(this.generation, reason);
    }
    this.generation += 1;
    this.quote = null;
    this.controller?.abort();
    this.controller = null;
    this.pendingPosition = null;
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
    if (this.quoteRefreshTimer !== null) globalThis.clearTimeout(this.quoteRefreshTimer);
    this.quoteRefreshTimer = null;
  }

  private cancellationError(generation: number): FlagPlacementQuoteError {
    const reason = this.cancellationReasons.get(generation) ?? "invalidated";
    this.cancellationReasons.delete(generation);
    const message = reason === "movement"
      ? "Flag preparation canceled because you moved."
      : reason === "disconnect"
        ? "Flag preparation canceled because the connection closed."
        : "Flag preparation was canceled.";
    return new FlagPlacementQuoteError(reason, message);
  }

  private scheduleQuoteRefresh(): void {
    if (this.quoteRefreshTimer !== null) globalThis.clearTimeout(this.quoteRefreshTimer);
    this.quoteRefreshTimer = null;
    const quote = this.quote;
    if (!quote) return;
    const delayMs = Math.max(0, quote.expiresAt - this.now());
    this.quoteRefreshTimer = globalThis.setTimeout(() => {
      this.quoteRefreshTimer = null;
      const position = this.position;
      if (
        !position ||
        position.lat !== quote.position.lat ||
        position.lon !== quote.position.lon ||
        this.quote?.quoteId !== quote.quoteId
      ) {
        return;
      }
      gameplayLatencyTrace.record("flag-preparation", "automatic_refresh_attempted", {
        quoteId: quote.quoteId,
        quoteAgeMs: this.now() - quote.createdAt
      }, { traceId: quote.traceId });
      void this.startLookup(position, "refresh").catch((error: unknown) => {
        gameplayLatencyTrace.record("flag-preparation", "automatic_refresh_failed_silently", {
          code: error instanceof FlagPlacementQuoteError ? error.code : "INTERNAL_ERROR",
          retryable: error instanceof FlagPlacementQuoteError ? error.retryable : true
        }, { traceId: quote.traceId, failure: true });
      });
    }, delayMs);
  }
}

function defaultFlagPlacementQuoteCode(
  reason: FlagPlacementQuoteError["reason"]
): string {
  switch (reason) {
    case "movement":
      return "PLAYER_MOVING";
    case "disconnect":
    case "destroyed":
      return "CLIENT_DISCONNECTED";
    case "invalidated":
      return "REVISION_STALE";
    case "unavailable":
      return "LOCATION_UNAVAILABLE";
  }
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 150;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(2_000, seconds * 1_000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.max(0, Math.min(2_000, retryAt - Date.now()))
    : 150;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
