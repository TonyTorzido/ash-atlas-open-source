import {
  distanceMeters,
  type FlagPlacementWaterDecision,
  type LatLon,
  type WaterSourceHighlight
} from "@ash-atlas/shared";
import type { FreshwaterEligibilityInput } from "@ash-atlas/shared";

import type { AppLogger } from "../logger.js";
import type {
  WorldLookupFailure,
  WorldLookupFailureCode,
  WorldGameplayEnvironmentResult,
  SettlementLookupResult,
  WorldLookupResult,
  WorldReleaseIdentity,
  RequiredCanonicalSurfaceAuthority,
  RequiredRiverAuthority,
  RequiredWaterbodyIdentityAuthority,
  WorldRuntimeIdentity,
  WorldSettlement,
  WorldWaterbodyIdentity,
  WorldWaterNameFallback
} from "./worldTypes.js";
import {
  WorldBatchAdmissionController,
  WorldBatchAdmissionRejectedError,
  type WorldBatchAdmissionMetrics,
  type WorldBatchCaller,
  type WorldBatchPriority
} from "./worldBatchAdmission.js";

export type RequiredWorldRelease = Omit<WorldReleaseIdentity, "packageCount">;
export const WORLD_GAMEPLAY_ENVIRONMENT_BATCH_MAX_POINTS = 512;
export type CanonicalWaterbodyLookup = NonNullable<
  FreshwaterEligibilityInput["canonicalWaterbody"]
>;

type SharedLookup<T> = {
  controller: AbortController;
  subscribers: number;
  settled: boolean;
  promise: Promise<T>;
};

export type WaterHighlightCacheOptions = {
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  now?: () => number;
};

export type WaterHighlightCacheMetrics = {
  entries: number;
  approximateBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  staleExpirations: number;
  authorityInvalidations: number;
  oversizedResponses: number;
};

export type InteractiveLookupCacheMetrics = {
  entries: number;
  negativeEntries: number;
  inFlight: number;
  hits: number;
  negativeHits: number;
  misses: number;
  negativeMisses: number;
  builds: number;
  upstreamAttempts: number;
  sharedWaits: number;
  evictions: number;
  staleExpirations: number;
  negativeExpirations: number;
  authorityInvalidations: number;
  failureClassifications: Partial<Record<WorldLookupFailureCode, number>>;
};

export type GameplayEnvironmentCacheMetrics = {
  entries: number;
  protectedEntries: number;
  probationaryEntries: number;
  negativeEntries: number;
  inFlight: number;
  inFlightBatches: number;
  hits: number;
  negativeHits: number;
  misses: number;
  builds: number;
  upstreamAttempts: number;
  sharedWaits: number;
  batchBuilds: number;
  batchUpstreamAttempts: number;
  batchSharedWaits: number;
  batchPoints: number;
  evictions: number;
  staleExpirations: number;
  negativeExpirations: number;
  authorityInvalidations: number;
  probationaryHits: number;
  probationaryEvictions: number;
  promotions: number;
  failureClassifications: Partial<Record<WorldLookupFailureCode, number>>;
};

type InteractiveLookupCacheEntry = {
  value: WorldLookupResult;
  expiresAt: number;
};

type GameplayEnvironmentCacheEntry = {
  value: WorldGameplayEnvironmentResult;
  expiresAt: number;
};

type WaterHighlightCacheEntry = {
  value: WaterSourceHighlight[];
  expiresAt: number;
  approximateBytes: number;
};

export class WorldReleaseMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldReleaseMismatchError";
  }
}

export class WorldSettlementLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldSettlementLookupError";
  }
}

export class WorldBatchLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldBatchLookupError";
  }
}

export class WorldBatchInvalidResponseError extends WorldBatchLookupError {
  constructor(message: string) {
    super(message);
    this.name = "WorldBatchInvalidResponseError";
  }
}

export class WorldBatchBackpressureError extends WorldBatchLookupError {
  constructor(
    message: string,
    readonly retryAfterMs: number,
    readonly statusCode: number | null
  ) {
    super(message);
    this.name = "WorldBatchBackpressureError";
  }
}

export class WorldLookupClient {
  private readonly waterHighlightCache = new Map<string, WaterHighlightCacheEntry>();
  private readonly interactiveLookupCache = new Map<string, InteractiveLookupCacheEntry>();
  private readonly interactiveLookups = new Map<string, SharedLookup<WorldLookupResult>>();
  private readonly gameplayEnvironmentCache = new Map<string, GameplayEnvironmentCacheEntry>();
  private readonly gameplayEnvironmentProbationaryCache =
    new Map<string, GameplayEnvironmentCacheEntry>();
  private readonly gameplayEnvironmentLookups =
    new Map<string, SharedLookup<WorldGameplayEnvironmentResult>>();
  private readonly gameplayEnvironmentBatches =
    new Map<string, SharedLookup<WorldGameplayEnvironmentResult[]>>();
  private readonly resourceEnvironmentBatches = new Map<string, SharedLookup<WorldLookupResult[]>>();
  private readonly batchAdmission = new WorldBatchAdmissionController();
  private readonly waterCacheOptions: Required<WaterHighlightCacheOptions>;
  private waterCacheBytes = 0;
  private verifiedReleaseIdentity: WorldReleaseIdentity | null = null;
  private readonly waterCacheMetrics = {
    hits: 0,
    misses: 0,
    evictions: 0,
    staleExpirations: 0,
    authorityInvalidations: 0,
    oversizedResponses: 0
  };
  private readonly interactiveCacheMetrics = {
    hits: 0,
    negativeHits: 0,
    misses: 0,
    negativeMisses: 0,
    builds: 0,
    upstreamAttempts: 0,
    sharedWaits: 0,
    evictions: 0,
    staleExpirations: 0,
    negativeExpirations: 0,
    authorityInvalidations: 0
  };
  private readonly interactiveFailureClassifications:
    Partial<Record<WorldLookupFailureCode, number>> = {};
  private readonly gameplayEnvironmentCacheMetrics = {
    hits: 0,
    negativeHits: 0,
    misses: 0,
    builds: 0,
    upstreamAttempts: 0,
    sharedWaits: 0,
    batchBuilds: 0,
    batchUpstreamAttempts: 0,
    batchSharedWaits: 0,
    batchPoints: 0,
    evictions: 0,
    staleExpirations: 0,
    negativeExpirations: 0,
    authorityInvalidations: 0,
    probationaryHits: 0,
    probationaryEvictions: 0,
    promotions: 0
  };
  private readonly gameplayEnvironmentFailureClassifications:
    Partial<Record<WorldLookupFailureCode, number>> = {};

  constructor(
    private readonly baseUrl: string,
    private readonly logger: AppLogger,
    private readonly timeoutMs = 2_000,
    private readonly requiredRelease?: RequiredWorldRelease,
    private readonly resourceBatchTimeoutMs = 10_000,
    waterCacheOptions: WaterHighlightCacheOptions = {
      maxEntries: 256,
      maxBytes: 4_194_304,
      ttlMs: 300_000
    },
    private readonly requiredRiverAuthority?: RequiredRiverAuthority,
    private readonly requiredLakeAuthority?: RequiredCanonicalSurfaceAuthority,
    private readonly requiredOceanCoastAuthority?: RequiredCanonicalSurfaceAuthority,
    private readonly requiredWaterbodyIdentityAuthority?: RequiredWaterbodyIdentityAuthority
  ) {
    this.waterCacheOptions = {
      ...waterCacheOptions,
      now: waterCacheOptions.now ?? Date.now
    };
    for (const [name, value] of Object.entries(this.waterCacheOptions)) {
      if (name === "now") continue;
      if (!Number.isSafeInteger(value) || Number(value) <= 0) {
        throw new Error(`water highlight cache ${name} must be a positive safe integer`);
      }
    }
  }

  async lookupGameplayEnvironment(
    lat: number,
    lon: number,
    options: { signal?: AbortSignal | undefined } = {}
  ): Promise<WorldGameplayEnvironmentResult> {
    validateBatchPoints([{ lat, lon }]);
    throwIfAborted(options.signal);
    const point = { lat, lon };
    const key = gameplayEnvironmentCacheKey(
      point,
      this.verifiedReleaseIdentity ?? this.requiredRelease
    );
    const cached = this.getGameplayEnvironmentCache(key);
    if (cached) return cached;

    const inFlight = this.gameplayEnvironmentLookups.get(key);
    if (inFlight) {
      this.gameplayEnvironmentCacheMetrics.sharedWaits += 1;
      return subscribeToSharedLookup(
        inFlight, options.signal,
        "gameplay environment lookup has no active subscribers",
        cloneGameplayEnvironment
      );
    }

    this.gameplayEnvironmentCacheMetrics.builds += 1;
    this.gameplayEnvironmentCacheMetrics.upstreamAttempts += 1;
    const controller = new AbortController();
    const shared: SharedLookup<WorldGameplayEnvironmentResult> = {
      controller,
      subscribers: 0,
      settled: false,
      promise: this.fetchGameplayEnvironment(point, controller.signal)
    };
    this.gameplayEnvironmentLookups.set(key, shared);
    void shared.promise.then(
      (result) => {
        this.setGameplayEnvironmentCache(key, result);
        if (result.failure) {
          this.gameplayEnvironmentFailureClassifications[result.failure.code] =
            (this.gameplayEnvironmentFailureClassifications[result.failure.code] ?? 0) + 1;
        }
      },
      () => undefined
    ).finally(() => {
      shared.settled = true;
      if (this.gameplayEnvironmentLookups.get(key) === shared) {
        this.gameplayEnvironmentLookups.delete(key);
      }
    });
    return subscribeToSharedLookup(
      shared, options.signal,
      "gameplay environment lookup has no active subscribers",
      cloneGameplayEnvironment
    );
  }

  async lookupGameplayEnvironments(
    points: readonly LatLon[],
    options: {
      signal?: AbortSignal | undefined;
      caller?: WorldBatchCaller | undefined;
      priority?: WorldBatchPriority | undefined;
      onAdmitted?: (() => void) | undefined;
      cacheClass?: "protected" | "probationary" | undefined;
    } = {}
  ): Promise<WorldGameplayEnvironmentResult[]> {
    validateBatchPoints(points);
    throwIfAborted(options.signal);
    if (points.length === 0) return [];

    const authority = this.verifiedReleaseIdentity ?? this.requiredRelease;
    const results = new Array<WorldGameplayEnvironmentResult | undefined>(points.length);
    const missingPoints: LatLon[] = [];
    const missingIndexes: number[] = [];
    const missingKeys: string[] = [];
    for (const [index, point] of points.entries()) {
      const key = gameplayEnvironmentCacheKey(point, authority);
      const cached = this.getGameplayEnvironmentCache(
        key,
        options.cacheClass ?? "protected"
      );
      if (cached) {
        results[index] = cached;
      } else {
        missingPoints.push(point);
        missingIndexes.push(index);
        missingKeys.push(key);
      }
    }
    if (missingPoints.length > 0) {
      const batchKey = gameplayEnvironmentBatchKey(missingPoints, authority);
      let shared = this.gameplayEnvironmentBatches.get(batchKey);
      if (!shared) {
        const controller = new AbortController();
        this.gameplayEnvironmentCacheMetrics.batchBuilds += 1;
        this.gameplayEnvironmentCacheMetrics.batchUpstreamAttempts += 1;
        this.gameplayEnvironmentCacheMetrics.batchPoints += missingPoints.length;
        shared = {
          controller,
          subscribers: 0,
          settled: false,
          promise: this.runAdmittedBatch(
            options.caller ?? "other",
            controller.signal,
            () => this.fetchGameplayEnvironmentBatch(missingPoints, controller.signal),
            options.priority,
            options.onAdmitted
          )
        };
        if (this.gameplayEnvironmentBatches.size < 128) {
          this.gameplayEnvironmentBatches.set(batchKey, shared);
        }
        const current = shared;
        void current.promise.finally(() => {
          current.settled = true;
          if (this.gameplayEnvironmentBatches.get(batchKey) === current) {
            this.gameplayEnvironmentBatches.delete(batchKey);
          }
        }).catch(() => undefined);
      } else {
        this.gameplayEnvironmentCacheMetrics.batchSharedWaits += 1;
        options.onAdmitted?.();
      }
      const fetched = await subscribeToSharedLookup(
        shared, options.signal,
        "gameplay environment batch has no active subscribers",
        (results) => results.map(cloneGameplayEnvironment)
      );
      for (const [missingIndex, result] of fetched.entries()) {
        const resultIndex = missingIndexes[missingIndex];
        const cacheKey = missingKeys[missingIndex];
        if (resultIndex === undefined || cacheKey === undefined) {
          throw new WorldBatchLookupError(
            "gameplay environment batch returned an invalid result mapping"
          );
        }
        results[resultIndex] = result;
        this.setGameplayEnvironmentCache(
          cacheKey,
          result,
          options.cacheClass ?? "protected"
        );
      }
    }
    return results.map((result, index) => {
      if (!result) {
        throw new WorldBatchLookupError(
          `gameplay environment batch omitted result ${index}`
        );
      }
      return result;
    });
  }

  /**
   * Resolve the nearest final square-grid water cell around a land point.
   *
   * The World API exposes membership for a point, not a proximity query. We
   * therefore ask it for the bounded neighboring cell centers and measure
   * against those same canonical cell rectangles in EPSG:3857. Legacy river
   * and lake distance fields are intentionally not consulted here.
   */
  async lookupCanonicalWaterbodiesNear(
    point: LatLon,
    origin: WorldGameplayEnvironmentResult,
    maxDistanceM: number
  ): Promise<CanonicalWaterbodyLookup[]> {
    if (!Number.isFinite(maxDistanceM) || maxDistanceM < 0) {
      throw new WorldBatchLookupError("canonical water search radius must be non-negative");
    }
    const anchors = canonicalGridSurfaces(origin);
    if (anchors.length === 0) {
      return [unresolvedCanonicalWaterbody(origin)];
    }
    const points: LatLon[] = [];
    const cellCoordinates = new Set<string>();
    for (const anchor of anchors) {
      const radiusCells = Math.ceil(maxDistanceM / anchor.cellSizeM) + 1;
      for (let rowOffset = -radiusCells; rowOffset <= radiusCells; rowOffset += 1) {
        for (let columnOffset = -radiusCells; columnOffset <= radiusCells; columnOffset += 1) {
          const rowId = clampCanonicalGridIndex(anchor.rowId + rowOffset, anchor.cellSizeM);
          const columnId = wrapCanonicalGridColumn(anchor.columnId + columnOffset, anchor.cellSizeM);
          const cellKey = `${anchor.cellSizeM}:${rowId}:${columnId}`;
          if (cellCoordinates.has(cellKey)) {
            continue;
          }
          cellCoordinates.add(cellKey);
          points.push(canonicalCellCenter(rowId, columnId, anchor.cellSizeM));
        }
      }
    }
    // A 600m search on a finer locked grid can legitimately span more than
    // the World batch admission limit. Keep every request within that
    // contract while preserving the exact ordered cell set for resolution.
    const results: WorldGameplayEnvironmentResult[] = [];
    for (let offset = 0; offset < points.length; offset += WORLD_GAMEPLAY_ENVIRONMENT_BATCH_MAX_POINTS) {
      results.push(...await this.lookupGameplayEnvironments(
        points.slice(offset, offset + WORLD_GAMEPLAY_ENVIRONMENT_BATCH_MAX_POINTS),
        { caller: "other", priority: 1 }
      ));
    }
    if (results.some((result) => !result.ok)) {
      return [unresolvedCanonicalWaterbody(origin)];
    }

    const candidates = results.flatMap((result) => {
      const surface = canonicalGridSurface(result);
      const waterbody = canonicalWaterbodyAt(result, surface);
      if (!surface || !waterbody) return [];
      const distanceM = canonicalCellDistanceM(point, surface);
      if (distanceM > maxDistanceM) return [];
      return [{
        ...waterbody,
        distanceM,
        searchComplete: true,
        sourceRevision: result.worldReleaseId ?? result.release?.releaseId ?? null
      }];
    });
    candidates.sort((left, right) => (
      (left.distanceM ?? Number.POSITIVE_INFINITY) - (right.distanceM ?? Number.POSITIVE_INFINITY) ||
      canonicalWaterbodyKindOrder(left.kind) - canonicalWaterbodyKindOrder(right.kind) ||
      (left.sourceId ?? "").localeCompare(right.sourceId ?? "")
    ));
    const unique = new Map<string, CanonicalWaterbodyLookup>();
    for (const candidate of candidates) {
      const key = candidate.kind && candidate.sourceId
        ? `${candidate.kind}:${candidate.sourceId}`
        : `unresolved:${candidate.kind ?? "unknown"}:${candidate.resolutionStatus ?? "invalid"}:${candidate.sourceName ?? ""}`;
      const prior = unique.get(key);
      if (!prior || (candidate.distanceM ?? Number.POSITIVE_INFINITY) < (prior.distanceM ?? Number.POSITIVE_INFINITY)) {
        unique.set(key, candidate);
      }
    }
    return [...unique.values()];
  }

  async lookupCanonicalWaterbodyNear(
    point: LatLon,
    origin: WorldGameplayEnvironmentResult,
    maxDistanceM: number
  ): Promise<CanonicalWaterbodyLookup> {
    const candidates = await this.lookupCanonicalWaterbodiesNear(point, origin, maxDistanceM);
    return candidates[0] ?? {
      kind: null,
      sourceId: null,
      sourceName: null,
      distanceM: null,
      searchComplete: true,
      sourceRevision: origin.worldReleaseId ?? origin.release?.releaseId ?? null
    };
  }

  private async fetchGameplayEnvironment(
    point: LatLon,
    signal: AbortSignal
  ): Promise<WorldGameplayEnvironmentResult> {
    const url = new URL("/api/gameplay-environment", this.baseUrl);
    url.searchParams.set("lat", String(point.lat));
    url.searchParams.set("lon", String(point.lon));
    const request = abortableRequest(signal, this.timeoutMs);
    try {
      const response = await fetch(url, { signal: request.signal });
      if (!response.ok) {
        this.logger.warn(
          {
            lat: point.lat,
            lon: point.lon,
            worldApiBase: this.baseUrl,
            statusCode: response.status,
            worldTraffic: "compact-gameplay-environment"
          },
          "compact gameplay environment lookup returned non-ok HTTP status"
        );
        return degradedGameplayEnvironment(
          response.status === 429 || response.status === 503
            ? worldFailure(
                "WORLD_AUTHORITY_OVERLOADED",
                "World validation is busy. Try again shortly.",
                true,
                2_000
              )
            : response.status >= 500
              ? worldFailure(
                  "WORLD_AUTHORITY_UNAVAILABLE",
                  "World validation is temporarily unavailable. Try again shortly.",
                  true,
                  2_000
                )
              : worldFailure(
                  "WORLD_LOOKUP_RETRYABLE",
                  "World validation could not be completed. Try again shortly.",
                  true,
                  2_000
                ),
          point
        );
      }
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        return degradedGameplayEnvironment(
          worldFailure(
            "WORLD_RESPONSE_INVALID",
            "World validation returned an invalid response. Try again shortly.",
            true,
            2_000
          ),
          point
        );
      }
      return normalizeGameplayEnvironment(raw, {
        point,
        ...(this.requiredRelease ? { requiredRelease: this.requiredRelease } : {}),
        ...(this.requiredRiverAuthority
          ? { requiredRiverAuthority: this.requiredRiverAuthority }
          : {}),
        ...(this.requiredLakeAuthority
          ? { requiredLakeAuthority: this.requiredLakeAuthority }
          : {}),
        ...(this.requiredOceanCoastAuthority
          ? { requiredOceanCoastAuthority: this.requiredOceanCoastAuthority }
          : {}),
        ...(this.requiredWaterbodyIdentityAuthority
          ? { requiredWaterbodyIdentityAuthority: this.requiredWaterbodyIdentityAuthority }
          : {})
      });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      this.logger.warn(
        {
          err: error,
          lat: point.lat,
          lon: point.lon,
          worldApiBase: this.baseUrl,
          worldTraffic: "compact-gameplay-environment"
        },
        "compact gameplay environment lookup failed"
      );
      return degradedGameplayEnvironment(
        request.signal.aborted
          ? worldFailure(
              "WORLD_LOOKUP_TIMEOUT",
              "World validation timed out. Try again shortly.",
              true,
              2_000
            )
          : worldFailure(
              "WORLD_AUTHORITY_UNAVAILABLE",
              "World validation is temporarily unavailable. Try again shortly.",
              true,
              2_000
            ),
        point
      );
    } finally {
      request.dispose();
    }
  }

  private async fetchGameplayEnvironmentBatch(
    points: readonly LatLon[],
    signal: AbortSignal
  ): Promise<WorldGameplayEnvironmentResult[]> {
    const request = abortableRequest(signal, this.resourceBatchTimeoutMs);
    try {
      const response = await fetch(new URL("/api/gameplay-environment-batch", this.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          points: points.map((point) => ({ latitude: point.lat, longitude: point.lon }))
        }),
        signal: request.signal
      });
      if (!response.ok) {
        throw await worldBatchHttpError(response, "gameplay environment batch API");
      }
      const raw = recordOrNull(await response.json());
      const release = normalizeReleaseIdentity(raw?.release);
      const runtime = normalizeRuntimeIdentity(raw?.runtime);
      if (
        raw?.ok !== true ||
        raw.contract_version !== "gameplay-environment-v1" ||
        !release ||
        !runtime ||
        !Array.isArray(raw.results)
      ) {
        throw new WorldBatchInvalidResponseError(
          "gameplay environment batch API returned a malformed response"
        );
      }
      if (this.requiredRelease) assertReleaseIdentity(release, this.requiredRelease);
      if (raw.results.length !== points.length) {
        throw new WorldBatchInvalidResponseError(
          "gameplay environment batch API returned the wrong result count"
        );
      }
      return raw.results.map((row, index) => {
        const point = points[index];
        if (!point) {
          throw new WorldBatchInvalidResponseError(
            `gameplay environment batch result ${index} has no input point`
          );
        }
        const result = normalizeGameplayEnvironment({
          ok: true,
          contract_version: "gameplay-environment-v1",
          release: raw.release,
          runtime: raw.runtime,
          result: row
        }, {
          point,
          ...(this.requiredRelease ? { requiredRelease: this.requiredRelease } : {}),
          ...(this.requiredRiverAuthority
            ? { requiredRiverAuthority: this.requiredRiverAuthority }
            : {}),
          ...(this.requiredLakeAuthority
            ? { requiredLakeAuthority: this.requiredLakeAuthority }
            : {}),
          ...(this.requiredOceanCoastAuthority
            ? { requiredOceanCoastAuthority: this.requiredOceanCoastAuthority }
            : {}),
          ...(this.requiredWaterbodyIdentityAuthority
            ? { requiredWaterbodyIdentityAuthority: this.requiredWaterbodyIdentityAuthority }
            : {})
        });
        if (!result.ok || !sameRelease(result.release, release)) {
          throw new WorldBatchInvalidResponseError(
            `gameplay environment batch result ${index} failed exact authority or coordinate validation`
          );
        }
        return result;
      });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      this.logger.warn(
        {
          err: error,
          pointCount: points.length,
          worldApiBase: this.baseUrl,
          worldTraffic: "compact-gameplay-environment-batch"
        },
        "compact gameplay environment batch lookup failed"
      );
      if (error instanceof WorldBatchLookupError || error instanceof WorldReleaseMismatchError) {
        throw error;
      }
      throw new WorldBatchLookupError(
        "gameplay environment batch authority is unavailable"
      );
    } finally {
      request.dispose();
    }
  }

  async lookupResourceEnvironments(
    points: readonly LatLon[],
    options: {
      signal?: AbortSignal | undefined;
      caller?: WorldBatchCaller | undefined;
      priority?: WorldBatchPriority | undefined;
    } = {}
  ): Promise<WorldLookupResult[]> {
    validateBatchPoints(points);
    throwIfAborted(options.signal);
    const key = resourceBatchKey(points, this.requiredRelease);
    let shared = this.resourceEnvironmentBatches.get(key);
    if (!shared) {
      const controller = new AbortController();
      shared = {
        controller,
        subscribers: 0,
        settled: false,
        promise: this.runAdmittedBatch(
          options.caller ?? "resource-vision",
          controller.signal,
          () => this.fetchResourceEnvironmentBatch(points, controller.signal),
          options.priority
        )
      };
      if (this.resourceEnvironmentBatches.size < 128) {
        this.resourceEnvironmentBatches.set(key, shared);
      }
      const current = shared;
      void current.promise.finally(() => {
        current.settled = true;
        if (this.resourceEnvironmentBatches.get(key) === current) {
          this.resourceEnvironmentBatches.delete(key);
        }
      }).catch(() => undefined);
    }
    return subscribeToSharedLookup(
      shared, options.signal,
      "resource environment batch has no active subscribers"
    );
  }

  private async fetchResourceEnvironmentBatch(
    points: readonly LatLon[],
    signal: AbortSignal
  ): Promise<WorldLookupResult[]> {
    const request = abortableRequest(signal, this.resourceBatchTimeoutMs);
    try {
      const response = await fetch(new URL("/api/resource-environment-batch", this.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          points: points.map((point) => ({ latitude: point.lat, longitude: point.lon }))
        }),
        signal: request.signal
      });
      if (!response.ok) {
        throw await worldBatchHttpError(response, "resource environment batch API");
      }
      const raw = recordOrNull(await response.json());
      const release = normalizeReleaseIdentity(raw?.release);
      if (
        raw?.ok !== true ||
        raw.contract_version !== "resource-environment-v1" ||
        !release ||
        !Array.isArray(raw.results)
      ) {
        throw new WorldBatchLookupError("resource environment batch API returned a malformed response");
      }
      if (this.requiredRelease) assertReleaseIdentity(release, this.requiredRelease);
      if (raw.results.length !== points.length) {
        throw new WorldBatchLookupError("resource environment batch API returned the wrong result count");
      }
      return raw.results.map((entry, index) => {
        const point = points[index];
        const result = normalizeResourceEnvironment(entry, point, release);
        if (!result.ok) {
          throw new WorldBatchLookupError(
            `resource environment batch result ${index} failed coordinate validation`
          );
        }
        return result;
      });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (error instanceof WorldBatchLookupError || error instanceof WorldReleaseMismatchError) {
        throw error;
      }
      throw new WorldBatchLookupError("resource environment batch authority is unavailable");
    } finally {
      request.dispose();
    }
  }

  async lookup(
    lat: number,
    lon: number,
    options: { signal?: AbortSignal | undefined } = {}
  ): Promise<WorldLookupResult> {
    throwIfAborted(options.signal);
    const key = [
      worldReleaseIdentityKey(this.verifiedReleaseIdentity ?? this.requiredRelease),
      lat.toFixed(6),
      lon.toFixed(6)
    ].join(":");
    const cached = this.interactiveLookupCache.get(key);
    const now = this.waterCacheOptions.now();
    if (cached && cached.expiresAt > now) {
      this.interactiveLookupCache.delete(key);
      this.interactiveLookupCache.set(key, cached);
      if (cached.value.ok) this.interactiveCacheMetrics.hits += 1;
      else this.interactiveCacheMetrics.negativeHits += 1;
      return cached.value;
    }
    if (cached) {
      this.interactiveLookupCache.delete(key);
      this.interactiveCacheMetrics.staleExpirations += 1;
      if (!cached.value.ok) this.interactiveCacheMetrics.negativeExpirations += 1;
    }
    const inFlight = this.interactiveLookups.get(key);
    if (inFlight) {
      this.interactiveCacheMetrics.sharedWaits += 1;
      return subscribeToSharedLookup(
        inFlight, options.signal,
        "interactive lookup has no active subscribers"
      );
    }
    this.interactiveCacheMetrics.misses += 1;
    this.interactiveCacheMetrics.negativeMisses += 1;
    this.interactiveCacheMetrics.builds += 1;
    this.interactiveCacheMetrics.upstreamAttempts += 1;
    const controller = new AbortController();
    const shared: SharedLookup<WorldLookupResult> = {
      controller,
      subscribers: 0,
      settled: false,
      promise: this.lookupUncached(lat, lon, controller.signal)
    };
    this.interactiveLookups.set(key, shared);
    void shared.promise.then(
      (result) => {
        while (this.interactiveLookupCache.size >= 512) {
          const oldest = this.interactiveLookupCache.keys().next().value as string | undefined;
          if (!oldest) break;
          this.interactiveLookupCache.delete(oldest);
          this.interactiveCacheMetrics.evictions += 1;
        }
        this.interactiveLookupCache.set(key, {
          value: result,
          expiresAt: this.waterCacheOptions.now() + (result.ok ? 15_000 : 2_000)
        });
        if (result.failure) {
          this.interactiveFailureClassifications[result.failure.code] =
            (this.interactiveFailureClassifications[result.failure.code] ?? 0) + 1;
        }
      },
      () => undefined
    ).finally(() => {
      shared.settled = true;
      if (this.interactiveLookups.get(key) === shared) {
        this.interactiveLookups.delete(key);
      }
    });
    return subscribeToSharedLookup(
      shared, options.signal,
      "interactive lookup has no active subscribers"
    );
  }

  private async lookupUncached(
    lat: number,
    lon: number,
    signal: AbortSignal
  ): Promise<WorldLookupResult> {
    const url = new URL("/api/lookup", this.baseUrl);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));

    const request = abortableRequest(signal, this.timeoutMs);
    try {
      const response = await fetch(url, { signal: request.signal });
      if (!response.ok) {
        this.logger.warn(
          {
            lat,
            lon,
            worldApiBase: this.baseUrl,
            statusCode: response.status
          },
          "world lookup returned non-ok HTTP status"
        );
        return this.degraded(
          response.status === 429 || response.status === 503
            ? worldFailure(
                "WORLD_AUTHORITY_OVERLOADED",
                "World validation is busy. Try again shortly.",
                true,
                2_000
              )
            : response.status >= 500
              ? worldFailure(
                  "WORLD_AUTHORITY_UNAVAILABLE",
                  "World validation is temporarily unavailable. Try again shortly.",
                  true,
                  2_000
                )
              : worldFailure(
                  "WORLD_LOOKUP_RETRYABLE",
                  "World validation could not be completed. Try again shortly.",
                  true,
                  2_000
                ),
          { lat, lon }
        );
      }
      let raw: Record<string, unknown>;
      try {
        const parsed = await response.json() as unknown;
        const record = recordOrNull(parsed);
        if (!record) throw new Error("lookup response was not an object");
        raw = record;
      } catch {
        return this.degraded(
          worldFailure(
            "WORLD_RESPONSE_INVALID",
            "World validation returned an invalid response. Try again shortly.",
            true,
            2_000
          ),
          { lat, lon }
        );
      }
      const options: {
        latitude: number;
        longitude: number;
        requiredRelease?: RequiredWorldRelease;
      } = {
        latitude: lat,
        longitude: lon
      };
      if (this.requiredRelease) options.requiredRelease = this.requiredRelease;
      return normalizeWorldLookup(raw, options);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      this.logger.warn(
        {
          err: error,
          lat,
          lon,
          worldApiBase: this.baseUrl
        },
        "world lookup failed"
      );
      return this.degraded(
        request.signal.aborted
          ? worldFailure(
              "WORLD_LOOKUP_TIMEOUT",
              "World validation timed out. Try again shortly.",
              true,
              2_000
            )
          : worldFailure(
              "WORLD_AUTHORITY_UNAVAILABLE",
              "World validation is temporarily unavailable. Try again shortly.",
              true,
              2_000
            ),
        { lat, lon }
      );
    } finally {
      request.dispose();
    }
  }

  async lookupMany(
    points: readonly LatLon[],
    options: { signal?: AbortSignal | undefined } = {}
  ): Promise<WorldLookupResult[]> {
    validateBatchPoints(points);
    throwIfAborted(options.signal);
    const request = abortableRequest(options.signal, this.timeoutMs);
    try {
      const response = await fetch(new URL("/api/lookup-batch", this.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          points: points.map((point) => ({ latitude: point.lat, longitude: point.lon }))
        }),
        signal: request.signal
      });
      if (!response.ok) {
        throw new WorldBatchLookupError(`world batch API returned HTTP ${response.status}`);
      }
      const raw = recordOrNull(await response.json());
      const release = normalizeReleaseIdentity(raw?.release);
      if (raw?.ok !== true || !release || !Array.isArray(raw.results)) {
        throw new WorldBatchLookupError("world batch API returned a malformed response");
      }
      if (this.requiredRelease) assertReleaseIdentity(release, this.requiredRelease);
      if (raw.results.length !== points.length) {
        throw new WorldBatchLookupError("world batch API returned the wrong result count");
      }
      return raw.results.map((entry, index) => {
        const point = points[index];
        const record = recordOrNull(entry);
        if (!point || !record) {
          throw new WorldBatchLookupError(`world batch result ${index} is malformed`);
        }
        const normalized = normalizeWorldLookup(record, {
          latitude: point.lat,
          longitude: point.lon,
          ...(this.requiredRelease ? { requiredRelease: this.requiredRelease } : {})
        });
        if (!normalized.ok || !sameRelease(normalized.release, release)) {
          throw new WorldBatchLookupError(
            `world batch result ${index} failed exact release or coordinate validation`
          );
        }
        return normalized;
      });
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (error instanceof WorldBatchLookupError || error instanceof WorldReleaseMismatchError) {
        throw error;
      }
      throw new WorldBatchLookupError("world batch authority is unavailable");
    } finally {
      request.dispose();
    }
  }

  async lookupSettlement(lat: number, lon: number): Promise<SettlementLookupResult> {
    const url = new URL("/api/settlement-at", this.baseUrl);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new WorldSettlementLookupError(`world settlement API returned HTTP ${response.status}`);
      }
      return normalizeSettlementLookup(await response.json());
    } catch (error) {
      this.logger.warn(
        { err: error, lat, lon, worldApiBase: this.baseUrl },
        "world settlement lookup failed"
      );
      if (error instanceof WorldSettlementLookupError) {
        throw error;
      }
      throw new WorldSettlementLookupError("world settlement authority is unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  async isReachable(options: { signal?: AbortSignal | undefined } = {}): Promise<boolean> {
    try {
      await this.verifyRequiredRelease(options);
      return true;
    } catch {
      if (options.signal?.aborted) throw abortReason(options.signal);
      return false;
    }
  }

  async verifyRequiredRelease(
    options: { signal?: AbortSignal | undefined } = {}
  ): Promise<WorldReleaseIdentity> {
    throwIfAborted(options.signal);
    const request = abortableRequest(options.signal, this.timeoutMs);
    try {
      const response = await fetch(new URL("/api/health", this.baseUrl), {
        signal: request.signal
      });
      if (!response.ok) {
        throw new WorldReleaseMismatchError(`world API health returned HTTP ${response.status}`);
      }
      const health = recordOrNull(await response.json());
      const release = normalizeReleaseIdentity(health?.release);
      if (health?.ok !== true || !release) {
        throw new WorldReleaseMismatchError("world API health omitted a valid release identity");
      }
      if (this.requiredRelease) {
        assertReleaseIdentity(release, this.requiredRelease);
      }
      if (this.requiredRiverAuthority) {
        assertRiverAuthorityHealth(health, this.requiredRiverAuthority);
      }
      if (this.requiredLakeAuthority) {
        assertCanonicalSurfaceAuthorityHealth(
          health,
          this.requiredLakeAuthority,
          "lake_surface",
          "lakeWaterAuthorityV1",
          "lake"
        );
      }
      if (this.requiredOceanCoastAuthority) {
        assertCanonicalSurfaceAuthorityHealth(
          health,
          this.requiredOceanCoastAuthority,
          "ocean_coast_surface",
          "oceanCoastWaterAuthorityV1",
          "ocean coast"
        );
      }
      if (this.requiredWaterbodyIdentityAuthority) {
        assertWaterbodyIdentityAuthorityHealth(
          health,
          this.requiredWaterbodyIdentityAuthority
        );
      }
      const previousIdentity = worldReleaseIdentityKey(
        this.verifiedReleaseIdentity ?? this.requiredRelease
      );
      const nextIdentity = worldReleaseIdentityKey(release);
      if (previousIdentity !== nextIdentity && this.waterHighlightCache.size > 0) {
        this.clearWaterHighlightCache();
        this.waterCacheMetrics.authorityInvalidations += 1;
      }
      if (previousIdentity !== nextIdentity && this.interactiveLookupCache.size > 0) {
        this.interactiveLookupCache.clear();
        this.interactiveCacheMetrics.authorityInvalidations += 1;
      }
      if (
        previousIdentity !== nextIdentity
        && (
          this.gameplayEnvironmentCache.size > 0
          || this.gameplayEnvironmentProbationaryCache.size > 0
        )
      ) {
        this.gameplayEnvironmentCache.clear();
        this.gameplayEnvironmentProbationaryCache.clear();
        this.gameplayEnvironmentCacheMetrics.authorityInvalidations += 1;
      }
      this.verifiedReleaseIdentity = release;
      return release;
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (error instanceof WorldReleaseMismatchError) throw error;
      throw new WorldReleaseMismatchError("world API health is unavailable");
    } finally {
      request.dispose();
    }
  }

  async collectibleWaterSourcesNear(
    center: LatLon,
    radiusM: number,
    options: { signal?: AbortSignal | undefined } = {}
  ): Promise<WaterSourceHighlight[]> {
    throwIfAborted(options.signal);
    const authority = this.verifiedReleaseIdentity ?? this.requiredRelease;
    const cacheKey = [
      worldReleaseIdentityKey(authority),
      center.lat.toFixed(6),
      center.lon.toFixed(6),
      radiusM.toFixed(3)
    ].join(":");
    const cached = this.getWaterHighlightCache(cacheKey);
    if (cached) return cached;

    const url = new URL("/api/collectible-water-sources.geojson", this.baseUrl);
    url.searchParams.set("lat", String(center.lat));
    url.searchParams.set("lon", String(center.lon));
    url.searchParams.set("radius_m", String(radiusM));
    const request = abortableRequest(options.signal, this.timeoutMs);
    try {
      const response = await fetch(url, { signal: request.signal });
      if (!response.ok) {
        this.logger.warn(
          {
            worldApiBase: this.baseUrl,
            statusCode: response.status
          },
          "world water-source highlight endpoint returned non-ok HTTP status"
        );
        return [];
      }
      const raw = (await response.json()) as unknown;
      const collection = recordOrNull(raw);
      if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
        this.logger.warn(
          { worldApiBase: this.baseUrl },
          "world water-source highlight endpoint returned malformed GeoJSON"
        );
        return [];
      }
      const highlights = normalizeWaterHighlights(raw, center, radiusM);
      this.setWaterHighlightCache(cacheKey, highlights);
      return highlights;
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      this.logger.warn(
        {
          err: error,
          worldApiBase: this.baseUrl
        },
        "world water-source highlight lookup failed"
      );
      return [];
    } finally {
      request.dispose();
    }
  }

  waterHighlightCacheMetrics(): WaterHighlightCacheMetrics {
    return {
      entries: this.waterHighlightCache.size,
      approximateBytes: this.waterCacheBytes,
      ...this.waterCacheMetrics
    };
  }

  interactiveLookupCacheMetrics(): InteractiveLookupCacheMetrics {
    let negativeEntries = 0;
    for (const entry of this.interactiveLookupCache.values()) {
      if (!entry.value.ok) negativeEntries += 1;
    }
    return {
      entries: this.interactiveLookupCache.size,
      negativeEntries,
      inFlight: this.interactiveLookups.size,
      ...this.interactiveCacheMetrics,
      failureClassifications: { ...this.interactiveFailureClassifications }
    };
  }

  gameplayEnvironmentMetrics(): GameplayEnvironmentCacheMetrics {
    let negativeEntries = 0;
    for (const entry of [
      ...this.gameplayEnvironmentCache.values(),
      ...this.gameplayEnvironmentProbationaryCache.values()
    ]) {
      if (!entry.value.ok) negativeEntries += 1;
    }
    return {
      entries: this.gameplayEnvironmentCache.size
        + this.gameplayEnvironmentProbationaryCache.size,
      protectedEntries: this.gameplayEnvironmentCache.size,
      probationaryEntries: this.gameplayEnvironmentProbationaryCache.size,
      negativeEntries,
      inFlight: this.gameplayEnvironmentLookups.size,
      inFlightBatches: this.gameplayEnvironmentBatches.size,
      ...this.gameplayEnvironmentCacheMetrics,
      failureClassifications: { ...this.gameplayEnvironmentFailureClassifications }
    };
  }

  worldBatchAdmissionMetrics(): WorldBatchAdmissionMetrics {
    return this.batchAdmission.metrics();
  }

  shutdownBatchAdmission(): void {
    const reason = new Error("World batch admission is shutting down");
    this.batchAdmission.close(reason);
    for (const batch of this.gameplayEnvironmentBatches.values()) {
      if (!batch.settled) batch.controller.abort(reason);
    }
    for (const batch of this.resourceEnvironmentBatches.values()) {
      if (!batch.settled) batch.controller.abort(reason);
    }
  }

  private async runAdmittedBatch<T>(
    caller: WorldBatchCaller,
    signal: AbortSignal,
    operation: () => Promise<T>,
    priority?: WorldBatchPriority,
    onAdmitted?: () => void
  ): Promise<T> {
    try {
      return await this.batchAdmission.run(
        caller,
        signal,
        operation,
        priority,
        onAdmitted
      );
    } catch (error) {
      if (error instanceof WorldBatchAdmissionRejectedError) {
        throw new WorldBatchBackpressureError(
          error.message,
          error.retryAfterMs,
          null
        );
      }
      throw error;
    }
  }

  private getGameplayEnvironmentCache(
    key: string,
    cacheClass: "protected" | "probationary" = "protected"
  ): WorldGameplayEnvironmentResult | null {
    const protectedEntry = this.gameplayEnvironmentCache.get(key);
    const entry = protectedEntry
      ?? this.gameplayEnvironmentProbationaryCache.get(key);
    if (!entry) {
      this.gameplayEnvironmentCacheMetrics.misses += 1;
      return null;
    }
    if (entry.expiresAt <= this.waterCacheOptions.now()) {
      this.gameplayEnvironmentCache.delete(key);
      this.gameplayEnvironmentProbationaryCache.delete(key);
      this.gameplayEnvironmentCacheMetrics.misses += 1;
      this.gameplayEnvironmentCacheMetrics.staleExpirations += 1;
      if (!entry.value.ok) {
        this.gameplayEnvironmentCacheMetrics.negativeExpirations += 1;
      }
      return null;
    }
    if (protectedEntry) {
      if (cacheClass === "protected") {
        this.gameplayEnvironmentCache.delete(key);
        this.gameplayEnvironmentCache.set(key, entry);
      }
    } else if (cacheClass === "protected") {
      this.gameplayEnvironmentProbationaryCache.delete(key);
      this.setGameplayEnvironmentCache(key, entry.value, "protected");
      this.gameplayEnvironmentCacheMetrics.promotions += 1;
    } else {
      this.gameplayEnvironmentProbationaryCache.delete(key);
      this.gameplayEnvironmentProbationaryCache.set(key, entry);
      this.gameplayEnvironmentCacheMetrics.probationaryHits += 1;
    }
    if (entry.value.ok) this.gameplayEnvironmentCacheMetrics.hits += 1;
    else this.gameplayEnvironmentCacheMetrics.negativeHits += 1;
    return cloneGameplayEnvironment(entry.value);
  }

  private setGameplayEnvironmentCache(
    key: string,
    value: WorldGameplayEnvironmentResult,
    cacheClass: "protected" | "probationary" = "protected"
  ): void {
    if (cacheClass === "probationary" && this.gameplayEnvironmentCache.has(key)) {
      return;
    }
    const target = cacheClass === "protected"
      ? this.gameplayEnvironmentCache
      : this.gameplayEnvironmentProbationaryCache;
    const maximum = cacheClass === "protected" ? 512 : 128;
    this.gameplayEnvironmentCache.delete(key);
    this.gameplayEnvironmentProbationaryCache.delete(key);
    while (target.size >= maximum) {
      const oldest = target.keys().next().value as string | undefined;
      if (!oldest) break;
      target.delete(oldest);
      if (cacheClass === "protected") {
        this.gameplayEnvironmentCacheMetrics.evictions += 1;
      } else {
        this.gameplayEnvironmentCacheMetrics.probationaryEvictions += 1;
      }
    }
    target.set(key, {
      value: immutableGameplayEnvironment(value),
      expiresAt: this.waterCacheOptions.now() + (value.ok ? 300_000 : 2_000)
    });
  }

  private getWaterHighlightCache(key: string): WaterSourceHighlight[] | null {
    const entry = this.waterHighlightCache.get(key);
    if (!entry) {
      this.waterCacheMetrics.misses += 1;
      return null;
    }
    if (entry.expiresAt <= this.waterCacheOptions.now()) {
      this.waterHighlightCache.delete(key);
      this.waterCacheBytes -= entry.approximateBytes;
      this.waterCacheMetrics.misses += 1;
      this.waterCacheMetrics.staleExpirations += 1;
      return null;
    }
    this.waterHighlightCache.delete(key);
    this.waterHighlightCache.set(key, entry);
    this.waterCacheMetrics.hits += 1;
    return cloneWaterHighlights(entry.value);
  }

  private setWaterHighlightCache(key: string, value: WaterSourceHighlight[]): void {
    const cachedValue = cloneWaterHighlights(value);
    const approximateBytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(cachedValue));
    if (approximateBytes > this.waterCacheOptions.maxBytes) {
      this.waterCacheMetrics.oversizedResponses += 1;
      return;
    }
    const existing = this.waterHighlightCache.get(key);
    if (existing) {
      this.waterHighlightCache.delete(key);
      this.waterCacheBytes -= existing.approximateBytes;
    }
    while (
      this.waterHighlightCache.size >= this.waterCacheOptions.maxEntries ||
      this.waterCacheBytes + approximateBytes > this.waterCacheOptions.maxBytes
    ) {
      const oldestKey = this.waterHighlightCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.waterHighlightCache.get(oldestKey);
      this.waterHighlightCache.delete(oldestKey);
      this.waterCacheBytes -= oldest?.approximateBytes ?? 0;
      this.waterCacheMetrics.evictions += 1;
    }
    this.waterHighlightCache.set(key, {
      value: cachedValue,
      expiresAt: this.waterCacheOptions.now() + this.waterCacheOptions.ttlMs,
      approximateBytes
    });
    this.waterCacheBytes += approximateBytes;
  }

  private clearWaterHighlightCache(): void {
    this.waterHighlightCache.clear();
    this.waterCacheBytes = 0;
  }

  private degraded(
    failure: WorldLookupFailure,
    context: { lat: number; lon: number }
  ): WorldLookupResult {
    const message = failure.message;
    return {
      ok: false,
      failure,
      packageId: null,
      latitude: context.lat,
      longitude: context.lon,
      countryId: null,
      countryName: null,
      countryCode: null,
      regionId: null,
      regionName: null,
      regionCode: null,
      cityId: null,
      cityName: null,
      insideCity: null,
      cityBoundaryDistanceM: null,
      elevationM: null,
      terrainClass: null,
      landCoverClass: null,
      sourceLandCoverCode: null,
      biome: null,
      biomeId: null,
      ecoregion: null,
      ecoregionId: null,
      isLand: null,
      isSaltwater: null,
      isCoastal: null,
      coastlineDistanceM: null,
      landCoverConflict: null,
      ecologyResolution: null,
      ecologyDistanceM: null,
      ecologySourcePackageId: null,
      ecologyFallbackMaxM: null,
      insideMajorLake: null,
      majorLakeId: null,
      majorLakeName: null,
      majorLakeDistanceM: null,
      majorLakeSearchRadiusM: null,
      majorLakeSearchComplete: null,
      namedRiverId: null,
      namedRiverName: null,
      riverClass: null,
      riverDistanceM: null,
      namedRiverSearchRadiusM: null,
      namedRiverSearchComplete: null,
      supportingRiverId: null,
      supportingRiverFlowOrder: null,
      supportingRiverDischargeCms: null,
      supportingRiverDrainageAreaSqKm: null,
      supportingRiverDistanceM: null,
      supportingRiverSearchRadiusM: null,
      supportingRiverSearchComplete: null,
      nearestWaterSourceType: null,
      nearestWaterSourceId: null,
      nearestWaterSourceName: null,
      nearestWaterSourceKind: null,
      nearestWaterSourceDistanceM: null,
      nearestWaterResolution: null,
      nearestWaterSearchRadiusM: null,
      nearestWaterSearchComplete: null,
      oceanDepthClass: null,
      flagPlacementWater: null,
      derivedTags: [],
      release: null,
      warnings: [message],
      slope: null,
      worldReleaseId: null,
      worldReleaseVersion: null,
      environmentSchemaVersion: null,
      generatorVersion: null,
      sourceVersions: {},
      raw: {
        warning: message,
        context
      },
      warning: message
    };
  }
}

function unresolvedCanonicalWaterbody(
  origin: WorldGameplayEnvironmentResult
): CanonicalWaterbodyLookup {
  return {
    kind: null,
    sourceId: null,
    sourceName: null,
    distanceM: null,
    searchComplete: false,
    sourceRevision: origin.worldReleaseId ?? origin.release?.releaseId ?? null
  };
}

export function normalizeSettlementLookup(raw: unknown): SettlementLookupResult {
  const payload = recordOrNull(raw);
  if (!payload || typeof payload.found !== "boolean") {
    throw new WorldSettlementLookupError("world settlement API returned an invalid response");
  }
  const authorityPayload = recordOrNull(payload.authority);
  if (!authorityPayload) {
    throw new WorldSettlementLookupError("world settlement API omitted authority identity");
  }
  const authority = {
    releaseId: requiredString(
      authorityPayload.release_id ?? authorityPayload.releaseId,
      "authority release id"
    ),
    releaseFingerprint: requiredSha256(
      authorityPayload.release_fingerprint ?? authorityPayload.releaseFingerprint,
      "authority release fingerprint"
    ),
    foundingPolicyId: requiredString(
      authorityPayload.founding_policy_id ?? authorityPayload.foundingPolicyId,
      "authority founding policy id"
    ),
    foundingPolicyFingerprint: requiredSha256(
      authorityPayload.founding_policy_fingerprint ?? authorityPayload.foundingPolicyFingerprint,
      "authority founding policy fingerprint"
    ),
    resolutionPolicyId: requiredString(
      authorityPayload.resolution_policy_id ?? authorityPayload.resolutionPolicyId,
      "authority resolution policy id"
    ),
    resolutionPolicyFingerprint: requiredSha256(
      authorityPayload.resolution_policy_fingerprint ??
        authorityPayload.resolutionPolicyFingerprint,
      "authority resolution policy fingerprint"
    )
  };
  if (!payload.found) {
    if (payload.inside !== false || payload.settlement !== null) {
      throw new WorldSettlementLookupError("world settlement API returned an invalid not-found response");
    }
    const nearest = recordOrNull(payload.nearest);
    return {
      found: false,
      inside: false,
      settlement: null,
      authority,
      nearest: nearest ? {
        municipalityId: requiredString(
          nearest.municipality_id ?? nearest.municipalityId ?? nearest.settlement_id ??
            nearest.settlementId ?? nearest.id,
          "nearest municipality id"
        ),
        name: requiredString(nearest.name, "nearest municipality name"),
        countryCode: requiredString(
          nearest.country_code ?? nearest.countryCode,
          "nearest municipality country code"
        ),
        regionCode: nullableString(nearest.region_code ?? nearest.regionCode),
        jurisdictionName: nullableString(
          nearest.jurisdiction_name ?? nearest.jurisdictionName ?? nearest.region_name ??
            nearest.regionName
        ),
        subtype: requiredString(
          nearest.subtype ?? nearest.municipality_type ?? nearest.municipalityType,
          "nearest municipality subtype"
        ),
        distanceM: requiredFiniteNumber(
          nearest.distance_m ?? nearest.distanceM,
          "nearest municipality distance"
        ),
        bearingDegrees: requiredFiniteNumber(
          nearest.bearing_degrees ?? nearest.bearingDegrees,
          "nearest municipality bearing"
        )
      } : null
    };
  }
  const settlement = recordOrNull(payload.settlement);
  if (payload.inside !== true || !settlement) {
    throw new WorldSettlementLookupError("world settlement API omitted settlement data");
  }
  const settlementId = requiredString(
    settlement.settlement_id ?? settlement.settlementId ?? settlement.id,
    "settlement id"
  );
  const sourceVersion = requiredString(
    settlement.source_version ?? settlement.sourceVersion,
    "source version"
  );
  const settlementClass = requiredString(
    settlement.settlement_class ?? settlement.settlementClass ?? settlement.subtype,
    "settlement class"
  );
  const settlementReleaseId = requiredString(
    settlement.release_id ?? settlement.releaseId,
    "settlement release id"
  );
  const settlementReleaseFingerprint = requiredSha256(
    settlement.release_fingerprint ?? settlement.releaseFingerprint,
    "settlement release fingerprint"
  );
  const foundingPolicyId = requiredString(
    settlement.founding_policy_id ?? settlement.foundingPolicyId,
    "settlement founding policy id"
  );
  const foundingPolicyFingerprint = requiredSha256(
    settlement.founding_policy_fingerprint ?? settlement.foundingPolicyFingerprint,
    "settlement founding policy fingerprint"
  );
  const foundingEligible = requiredBoolean(
    settlement.founding_eligible ?? settlement.foundingEligible,
    "settlement founding eligibility"
  );
  const populationFieldsProvided =
    hasOwn(settlement, "population") ||
    hasOwn(settlement, "minimum_founding_population") ||
    hasOwn(settlement, "minimumFoundingPopulation") ||
    hasOwn(settlement, "founding_ineligibility_reason") ||
    hasOwn(settlement, "foundingIneligibilityReason");
  const population = nullableAliasedField(
    settlement,
    "population",
    "population",
    "settlement population",
    (value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
  const minimumFoundingPopulation = nullableAliasedField(
    settlement,
    "minimum_founding_population",
    "minimumFoundingPopulation",
    "settlement minimum founding population",
    (value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
  );
  const foundingIneligibilityReason = nullableAliasedField(
    settlement,
    "founding_ineligibility_reason",
    "foundingIneligibilityReason",
    "settlement founding ineligibility reason",
    (value): value is WorldSettlement["foundingIneligibilityReason"] =>
      value === "class_ineligible" ||
      value === "population_missing" ||
      value === "population_below_minimum"
  );
  if (populationFieldsProvided) {
    const eligibilityReasonIsConsistent = foundingEligible
      ? foundingIneligibilityReason === null &&
        (minimumFoundingPopulation === null ||
          (population !== null && population >= minimumFoundingPopulation))
      : foundingIneligibilityReason !== null;
    const populationReasonIsConsistent =
      foundingIneligibilityReason === null ||
      foundingIneligibilityReason === "class_ineligible" ||
      (foundingIneligibilityReason === "population_missing" &&
        population === null && minimumFoundingPopulation !== null) ||
      (foundingIneligibilityReason === "population_below_minimum" &&
        population !== null && minimumFoundingPopulation !== null &&
        population < minimumFoundingPopulation);
    if (!eligibilityReasonIsConsistent || !populationReasonIsConsistent) {
      throw new WorldSettlementLookupError(
        "world settlement API returned inconsistent founding eligibility"
      );
    }
  }
  const resolutionPolicyId = requiredString(
    settlement.resolution_policy_id ?? settlement.resolutionPolicyId,
    "settlement resolution policy id"
  );
  const resolutionPolicyFingerprint = requiredSha256(
    settlement.resolution_policy_fingerprint ?? settlement.resolutionPolicyFingerprint,
    "settlement resolution policy fingerprint"
  );
  const resolution = recordOrNull(settlement.resolution);
  if (!resolution) {
    throw new WorldSettlementLookupError("world settlement API omitted resolution metadata");
  }
  const resolutionPolicy = requiredString(
    resolution.policy_id ?? resolution.policyId,
    "settlement resolution metadata policy id"
  );
  const selectedAs = requiredResolutionSelection(
    resolution.selected_as ?? resolution.selectedAs
  );
  const candidateCount = requiredPositiveInteger(
    resolution.candidate_count ?? resolution.candidateCount,
    "settlement resolution candidate count"
  );
  if (
    settlementReleaseId !== authority.releaseId ||
    settlementReleaseFingerprint !== authority.releaseFingerprint ||
    foundingPolicyId !== authority.foundingPolicyId ||
    foundingPolicyFingerprint !== authority.foundingPolicyFingerprint ||
    resolutionPolicyId !== authority.resolutionPolicyId ||
    resolutionPolicyFingerprint !== authority.resolutionPolicyFingerprint ||
    resolutionPolicy !== authority.resolutionPolicyId
  ) {
    throw new WorldSettlementLookupError(
      "world settlement API returned inconsistent authority identity"
    );
  }
  return {
    found: true,
    inside: true,
    nearest: null,
    authority,
    settlement: {
      settlementId,
      source: requiredString(settlement.source, "settlement source"),
      sourceSettlementId: requiredString(
        settlement.source_feature_id ?? settlement.sourceFeatureId ??
          settlement.source_settlement_id ?? settlement.sourceSettlementId,
        "source settlement id"
      ),
      name: requiredString(settlement.name, "settlement name"),
      countryCode: requiredString(settlement.country_code ?? settlement.countryCode, "country code"),
      regionCode: nullableString(settlement.region_code ?? settlement.regionCode),
      jurisdictionName: nullableString(
        settlement.jurisdiction_name ?? settlement.jurisdictionName ?? settlement.region_name ??
          settlement.regionName
      ),
      subtype: settlementClass,
      administrativeLevel: requiredString(
        settlement.administrative_level ?? settlement.administrativeLevel ?? settlement.subtype,
        "administrative level"
      ),
      sourceClass: nullableString(
        settlement.source_class ?? settlement.sourceClass ?? settlementClass
      ),
      sourceVersion,
      settlementClass,
      settlementReleaseId,
      settlementReleaseFingerprint,
      foundingPolicyId,
      foundingPolicyFingerprint,
      resolutionPolicyId,
      resolutionPolicyFingerprint,
      resolution: {
        policyId: resolutionPolicy,
        selectedAs,
        candidateCount
      },
      foundingEligible,
      population,
      minimumFoundingPopulation,
      foundingIneligibilityReason
    }
  };
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nullableAliasedField<T>(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
  label: string,
  isValid: (value: unknown) => value is T
): T | null {
  const keys = snakeKey === camelKey ? [snakeKey] : [snakeKey, camelKey];
  const provided = keys.filter((key) => hasOwn(record, key));
  if (provided.length === 0) return null;
  const values = provided.map((key) => {
    const value = record[key];
    if (value === null) return null;
    if (!isValid(value)) {
      throw new WorldSettlementLookupError(`world settlement API returned an invalid ${label}`);
    }
    return value;
  });
  if (values.length === 2 && values[0] !== values[1]) {
    throw new WorldSettlementLookupError(`world settlement API returned inconsistent ${label}`);
  }
  return values[0] ?? null;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new WorldSettlementLookupError(`world settlement API omitted ${label}`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 64) {
    throw new WorldSettlementLookupError(`world settlement API returned an invalid ${label}`);
  }
  return value;
}

function requiredResolutionSelection(
  value: unknown
): WorldSettlement["resolution"]["selectedAs"] {
  if (
    value !== "primary_locality" &&
    value !== "authoritative_primary" &&
    value !== "standalone_locality" &&
    value !== "peer_overlap"
  ) {
    throw new WorldSettlementLookupError(
      "world settlement API returned an invalid resolution selection"
    );
  }
  return value;
}

function requiredSha256(value: unknown, label: string): string {
  const normalized = requiredString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new WorldSettlementLookupError(`world settlement API returned an invalid ${label}`);
  }
  return normalized;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorldSettlementLookupError(`world settlement API omitted ${label}`);
  }
  return value;
}

type GeoJsonFeature = {
  id?: unknown;
  properties?: unknown;
  geometry?: unknown;
};

function normalizeWaterHighlights(
  raw: unknown,
  center: LatLon,
  radiusM: number
): WaterSourceHighlight[] {
  const collection = recordOrNull(raw);
  const features = Array.isArray(collection?.features) ? collection.features : [];
  return features
    .flatMap((feature, index) => waterHighlightFromFeature(feature, index))
    .map((highlight) => ({
      highlight,
      distanceM: distanceMeters(center, {
        lat: highlight.lat,
        lon: highlight.lon
      })
    }))
    .filter((candidate) => candidate.distanceM <= radiusM)
    .sort(
      (left, right) => left.distanceM - right.distanceM || left.highlight.id.localeCompare(right.highlight.id)
    )
    .slice(0, 40)
    .map((candidate) => candidate.highlight);
}

function cloneWaterHighlights(highlights: readonly WaterSourceHighlight[]): WaterSourceHighlight[] {
  return highlights.map((highlight) => ({ ...highlight }));
}

function worldReleaseIdentityKey(
  release: RequiredWorldRelease | WorldReleaseIdentity | undefined
): string {
  if (!release) return "unverified-world-authority";
  return [
    release.releaseId,
    release.profileSetFingerprint,
    release.buildContractFingerprint,
    release.boundaryReleaseId,
    "packageCount" in release ? release.packageCount : "required"
  ].join("|");
}

function waterHighlightFromFeature(feature: unknown, index: number): WaterSourceHighlight[] {
  const record = recordOrNull(feature) as GeoJsonFeature | null;
  if (!record) {
    return [];
  }
  const properties = recordOrNull(record.properties);
  const point = representativePoint(record.geometry);
  if (!point || !properties) {
    return [];
  }
  const collectible = booleanProperty(properties, "collectible") ?? true;
  const waterSourceType = stringProperty(properties, "water_source_type") ?? "unknown";
  const waterKind = stringProperty(properties, "water_kind") ?? "unknown";
  if (!collectible || waterSourceType === "playa" || waterKind === "dry_or_intermittent") {
    return [];
  }
  return [
    {
      id:
        stringProperty(properties, "source_id") ??
        stringProperty(properties, "id") ??
        (typeof record.id === "string" ? record.id : `water-source-${index}`),
      name: stringProperty(properties, "source_name") ?? stringProperty(properties, "name"),
      sourceDataset: stringProperty(properties, "source_dataset"),
      waterSourceType,
      waterKind,
      collectible,
      lat: point.lat,
      lon: point.lon
    }
  ];
}

function representativePoint(geometry: unknown): LatLon | null {
  const record = recordOrNull(geometry);
  const type = stringProperty(record, "type");
  const coordinates = record?.coordinates;
  if (!type || coordinates === undefined) {
    return null;
  }
  if (type === "Point") {
    return pointFromPosition(coordinates);
  }
  if (type === "MultiPoint" || type === "LineString") {
    return pointFromPositions(coordinates);
  }
  if (type === "MultiLineString" || type === "Polygon") {
    return pointFromNestedPositions(coordinates);
  }
  if (type === "MultiPolygon") {
    return pointFromDeepNestedPositions(coordinates);
  }
  return null;
}

function pointFromPosition(value: unknown): LatLon | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return { lat, lon };
}

function pointFromPositions(value: unknown): LatLon | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  return pointFromPosition(value[Math.floor(value.length / 2)]);
}

function pointFromNestedPositions(value: unknown): LatLon | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  return pointFromPositions(value[0]);
}

function pointFromDeepNestedPositions(value: unknown): LatLon | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  return pointFromNestedPositions(value[0]);
}

export function normalizeGameplayEnvironment(
  raw: unknown,
  options: {
    point: LatLon;
    requiredRelease?: RequiredWorldRelease;
    requiredRiverAuthority?: RequiredRiverAuthority;
    requiredLakeAuthority?: RequiredCanonicalSurfaceAuthority;
    requiredOceanCoastAuthority?: RequiredCanonicalSurfaceAuthority;
    requiredWaterbodyIdentityAuthority?: RequiredWaterbodyIdentityAuthority;
  }
): WorldGameplayEnvironmentResult {
  const payload = recordOrNull(raw);
  const row = recordOrNull(payload?.result);
  const release = normalizeReleaseIdentity(payload?.release);
  const runtime = normalizeRuntimeIdentity(payload?.runtime);
  let releaseMatches = options.requiredRelease === undefined;
  if (release && options.requiredRelease) {
    try {
      assertReleaseIdentity(release, options.requiredRelease);
      releaseMatches = true;
    } catch {
      releaseMatches = false;
    }
  }
  if (!releaseMatches) {
    return degradedGameplayEnvironment(
      worldFailure(
        "WORLD_RELEASE_MISMATCH",
        "World data is updating. Flag placement is temporarily unavailable.",
        true,
        2_000
      ),
      options.point,
      raw,
      release,
      runtime
    );
  }

  const latitude = nullableNumber(row?.latitude);
  const longitude = nullableNumber(row?.longitude);
  const packageId = nullableString(row?.packageId);
  const isLand = nullableBoolean(row?.isLand);
  const isSaltwater = nullableBoolean(row?.isSaltwater);
  const isCoastalLand = nullableBoolean(row?.isCoastalLand);
  const isRiverbank = nullableBoolean(row?.isRiverbank ?? row?.is_riverbank);
  const isLakeshore = nullableBoolean(row?.isLakeshore ?? row?.is_lakeshore);
  const insideMajorLake = nullableBoolean(row?.insideMajorLake);
  const flagPlacementWater = normalizeFlagPlacementWater(row?.flagPlacementWater);
  const surfaceKind = surfaceKindValue(row?.surfaceKind);
  const waterKindValue = authoritativeWaterKind(row?.waterKind);
  const riverSurface = normalizeRiverSurface(row?.riverSurface);
  const lakeSurface = normalizeLakeSurface(row?.lakeSurface);
  const oceanCoastSurface = normalizeOceanCoastSurface(row?.oceanCoastSurface);
  const waterbodyIdentity = normalizeWaterbodyIdentity(row);
  const waterNameFallback = normalizeWaterNameFallback(row);
  const riverContractValid = waterKindValue !== "river" || Boolean(
    surfaceKind === "water" &&
    isLand === false &&
    isSaltwater === false &&
    flagPlacementWater?.kind === "river" &&
    riverSurface
  );
  const riverIdentityValid = !options.requiredRiverAuthority || Boolean(
    runtime?.sha === options.requiredRiverAuthority.runtimeSha &&
    (waterKindValue !== "river" || (
      riverSurface?.sourceReleaseId === options.requiredRiverAuthority.releaseId &&
      riverSurface.sourceManifestSha256 === options.requiredRiverAuthority.manifestSha256 &&
      riverSurface.cellSizeM === options.requiredRiverAuthority.cellSizeM
    ))
  );
  const lakeIdentityValid = !options.requiredLakeAuthority || Boolean(
    runtime?.sha === options.requiredLakeAuthority.runtimeSha &&
    lakeSurface?.sourceReleaseId === options.requiredLakeAuthority.releaseId &&
    lakeSurface.sourceManifestSha256 === options.requiredLakeAuthority.manifestSha256 &&
    lakeSurface.cellSizeM === options.requiredLakeAuthority.cellSizeM
  );
  const oceanCoastIdentityValid = !options.requiredOceanCoastAuthority || Boolean(
    runtime?.sha === options.requiredOceanCoastAuthority.runtimeSha &&
    oceanCoastSurface?.sourceReleaseId === options.requiredOceanCoastAuthority.releaseId &&
    oceanCoastSurface.sourceManifestSha256 === options.requiredOceanCoastAuthority.manifestSha256 &&
    oceanCoastSurface.cellSizeM === options.requiredOceanCoastAuthority.cellSizeM
  );
  const waterbodyIdentityAuthorityValid = !options.requiredWaterbodyIdentityAuthority || Boolean(
    runtime?.sha === options.requiredWaterbodyIdentityAuthority.runtimeSha &&
    (surfaceKind !== "water" || waterbodyIdentity !== null)
  );
  const valid = Boolean(
    payload?.ok === true &&
    payload.contract_version === "gameplay-environment-v1" &&
    row &&
    release &&
    runtime &&
    latitude === options.point.lat &&
    longitude === options.point.lon &&
    packageId &&
    isLand !== null &&
    isSaltwater !== null &&
    isCoastalLand !== null &&
    isRiverbank !== null &&
    isLakeshore !== null &&
    insideMajorLake !== null &&
    flagPlacementWater &&
    flagPlacementWater.releaseId === release.releaseId &&
    riverContractValid &&
    riverIdentityValid &&
    lakeIdentityValid &&
    oceanCoastIdentityValid &&
    waterbodyIdentityAuthorityValid
  );
  if (!valid) {
    return degradedGameplayEnvironment(
      worldFailure(
        "WORLD_RESPONSE_INVALID",
        "World validation returned an invalid response. Try again shortly.",
        true,
        2_000
      ),
      options.point,
      raw,
      release,
      runtime
    );
  }

  return {
    ok: true,
    contractVersion: "gameplay-environment-v1",
    runtime,
    packageId,
    latitude: latitude ?? options.point.lat,
    longitude: longitude ?? options.point.lon,
    countryId: normalizedId(row?.countryId),
    countryName: nullableString(row?.countryName),
    countryCode: nullableString(row?.countryCode),
    regionId: normalizedId(row?.regionId),
    regionName: nullableString(row?.regionName),
    regionCode: nullableString(row?.regionCode),
    cityId: null,
    cityName: null,
    settlementId: normalizedId(row?.settlementId),
    settlementName: nullableString(row?.settlementName),
    elevationM: nullableNumber(row?.elevationM),
    elevationBand: nullableString(row?.elevationBand),
    terrainClass: nullableString(row?.terrainClass),
    landCoverClass: nullableString(row?.landCoverClass),
    biome: nullableString(row?.biomeName),
    biomeName: nullableString(row?.biomeName),
    biomeId: normalizedId(row?.biomeId),
    ecoregion: nullableString(row?.ecoregionName),
    ecoregionName: nullableString(row?.ecoregionName),
    ecoregionId: normalizedId(row?.ecoregionId),
    isLand,
    isSaltwater,
    isCoastalLand,
    isRiverbank,
    isLakeshore,
    isCoastal: nullableBoolean(row?.isCoastal),
    insideMajorLake,
    majorLakeId: normalizedId(row?.majorLakeId),
    majorLakeName: nullableString(row?.majorLakeName),
    majorLakeDistanceM: nullableNumber(row?.majorLakeDistanceM),
    namedRiverId: normalizedId(row?.namedRiverId),
    namedRiverName: nullableString(row?.namedRiverName),
    riverClass: nullableString(row?.riverClass),
    riverDistanceM: nullableNumber(row?.riverDistanceM),
    supportingRiverId: normalizedId(row?.supportingRiverId),
    supportingRiverFlowOrder: nullableNumber(row?.supportingRiverFlowOrder),
    supportingRiverDischargeCms: nullableNumber(row?.supportingRiverDischargeCms),
    supportingRiverDrainageAreaSqKm: nullableNumber(
      row?.supportingRiverDrainageAreaSqKm
    ),
    supportingRiverDistanceM: nullableNumber(row?.supportingRiverDistanceM),
    flagPlacementWater,
    surfaceKind,
    waterKind: waterKindValue,
    waterbodyIdentity,
    waterNameFallback,
    riverSurface,
    lakeSurface,
    oceanCoastSurface,
    derivedTags: [],
    release,
    warnings: [],
    worldReleaseId: release?.releaseId ?? null,
    worldReleaseVersion: release?.releaseId ?? null,
    environmentSchemaVersion: "gameplay-environment-v1",
    generatorVersion: null,
    sourceVersions: {},
    raw
  };
}

function degradedGameplayEnvironment(
  failure: WorldLookupFailure,
  point: LatLon,
  raw: unknown = null,
  release: WorldReleaseIdentity | null = null,
  runtime: WorldRuntimeIdentity | null = null
): WorldGameplayEnvironmentResult {
  return {
    ok: false,
    failure,
    contractVersion: "gameplay-environment-v1",
    runtime,
    packageId: null,
    latitude: point.lat,
    longitude: point.lon,
    countryId: null,
    countryName: null,
    countryCode: null,
    regionId: null,
    regionName: null,
    regionCode: null,
    cityId: null,
    cityName: null,
    settlementId: null,
    settlementName: null,
    elevationM: null,
    elevationBand: null,
    terrainClass: null,
    landCoverClass: null,
    biome: null,
    biomeName: null,
    biomeId: null,
    ecoregion: null,
    ecoregionName: null,
    ecoregionId: null,
    isLand: null,
    isSaltwater: null,
    isCoastalLand: null,
    isRiverbank: null,
    isLakeshore: null,
    isCoastal: null,
    insideMajorLake: null,
    majorLakeId: null,
    majorLakeName: null,
    majorLakeDistanceM: null,
    namedRiverId: null,
    namedRiverName: null,
    riverClass: null,
    riverDistanceM: null,
    supportingRiverId: null,
    supportingRiverFlowOrder: null,
    supportingRiverDischargeCms: null,
    supportingRiverDrainageAreaSqKm: null,
    supportingRiverDistanceM: null,
    flagPlacementWater: null,
    surfaceKind: null,
    waterKind: null,
    waterbodyIdentity: null,
    waterNameFallback: null,
    riverSurface: null,
    derivedTags: [],
    release,
    warnings: [failure.message],
    worldReleaseId: release?.releaseId ?? null,
    worldReleaseVersion: release?.releaseId ?? null,
    environmentSchemaVersion: "gameplay-environment-v1",
    generatorVersion: null,
    sourceVersions: {},
    raw,
    warning: failure.message
  };
}

export function normalizeWorldLookup(
  raw: Record<string, unknown>,
  options: {
    latitude?: number;
    longitude?: number;
    requiredRelease?: RequiredWorldRelease;
  } = {}
): WorldLookupResult {
  const profile = recordOrNull(raw.profile);
  const selectedPackage = recordOrNull(raw.selected_package);
  const release = normalizeReleaseIdentity(raw.release);
  const administrative = recordOrNull(profile?.administrative);
  const environment = recordOrNull(profile?.environment);
  const water = recordOrNull(profile?.water);
  const waterbodyIdentity = normalizeWaterbodyIdentity(water)
    ?? normalizeWaterbodyIdentity(profile);
  const waterNameFallback = normalizeWaterNameFallback(raw)
    ?? normalizeWaterNameFallback(profile)
    ?? normalizeWaterNameFallback(water);
  const flagPlacementWater = normalizeFlagPlacementWater(profile?.flag_placement_water);
  const warnings = Array.isArray(profile?.warnings) ? profile.warnings.map(String) : [];
  const packageId = nullableString(selectedPackage?.package_id);
  const latitude = nullableNumber(profile?.latitude);
  const longitude = nullableNumber(profile?.longitude);
  const coordinateMatches =
    (options.latitude === undefined || latitude === options.latitude) &&
    (options.longitude === undefined || longitude === options.longitude);
  const environmentalBoolean = (keys: readonly string[]): boolean | null =>
    nullableBoolean(
      firstDefinedProperty(environment ?? {}, keys)
        ?? firstDefinedProperty(profile ?? {}, keys)
    );
  let releaseMatches = options.requiredRelease === undefined;
  if (options.requiredRelease && release) {
    try {
      assertReleaseIdentity(release, options.requiredRelease);
      releaseMatches = true;
    } catch {
      releaseMatches = false;
    }
  }
  const ok =
    raw.ok === true &&
    raw.covered === true &&
    profile !== null &&
    packageId !== null &&
    release !== null &&
    coordinateMatches &&
    releaseMatches;

  let failure: WorldLookupFailure | undefined;
  if (!ok) {
    if (release && options.requiredRelease && !releaseMatches) {
      failure = worldFailure(
        "WORLD_RELEASE_MISMATCH",
        "World data is updating. Flag placement is temporarily unavailable.",
        true,
        2_000
      );
    } else if (
      raw.ok === true &&
      raw.covered === false &&
      profile !== null &&
      release !== null &&
      coordinateMatches &&
      releaseMatches
    ) {
      failure = worldFailure(
        "WORLD_COORDINATE_UNCOVERED",
        "This location is outside available world coverage.",
        false
      );
    }
    failure ??= worldFailure(
      "WORLD_RESPONSE_INVALID",
      "World validation returned an invalid response. Try again shortly.",
      true,
      2_000
    );
  }

  const result: WorldLookupResult = {
    ok,
    ...(failure ? { failure } : {}),
    packageId,
    latitude,
    longitude,
    countryId: normalizedId(administrative?.country_id),
    countryName: nullableString(administrative?.country_name),
    countryCode: nullableString(administrative?.country_code),
    regionId: normalizedId(administrative?.region_id),
    regionName: nullableString(administrative?.region_name),
    regionCode: nullableString(administrative?.region_code),
    cityId: normalizedId(administrative?.city_id),
    cityName: nullableString(administrative?.city_name),
    insideCity: nullableBoolean(administrative?.inside_city),
    cityBoundaryDistanceM: nullableNumber(administrative?.city_boundary_distance_m),
    elevationM: nullableNumber(environment?.elevation_m),
    terrainClass: nullableString(environment?.terrain_class),
    landCoverClass: nullableString(environment?.land_cover_class),
    sourceLandCoverCode: nullableNumber(environment?.source_land_cover_code),
    biome: nullableString(environment?.biome_name),
    biomeId: normalizedId(environment?.biome_id),
    ecoregion: nullableString(environment?.ecoregion_name),
    ecoregionId: normalizedId(environment?.ecoregion_id),
    isLand: nullableBoolean(environment?.is_land),
    isSaltwater: nullableBoolean(environment?.is_saltwater),
    isCoastal: nullableBoolean(environment?.is_coastal),
    isCoastalLand: environmentalBoolean(["is_coastal_land", "isCoastalLand"]),
    isRiverbank: environmentalBoolean(["is_riverbank", "isRiverbank"]),
    isLakeshore: environmentalBoolean(["is_lakeshore", "isLakeshore"]),
    coastlineDistanceM: nullableNumber(environment?.coastline_distance_m),
    coastlineSearchRadiusM: nullableNumber(environment?.coastline_search_radius_m),
    coastlineSearchComplete: nullableBoolean(environment?.coastline_search_complete),
    coastalThresholdM: nullableNumber(environment?.coastal_threshold_m),
    landCoverConflict: nullableBoolean(environment?.land_cover_conflict),
    ecologyResolution: ecologyResolution(environment?.ecology_resolution),
    ecologyDistanceM: nullableNumber(environment?.ecology_distance_m),
    ecologySourcePackageId: nullableString(environment?.ecology_source_package_id),
    ecologyFallbackMaxM: nullableNumber(environment?.ecology_fallback_max_m),
    ecologySearchComplete: nullableBoolean(environment?.ecology_search_complete),
    insideMajorLake: nullableBoolean(water?.inside_major_lake),
    majorLakeId: normalizedId(water?.major_lake_id),
    majorLakeName: nullableString(water?.major_lake_name),
    majorLakeDistanceM: nullableNumber(water?.major_lake_distance_m),
    majorLakeSearchRadiusM: nullableNumber(water?.major_lake_search_radius_m),
    majorLakeSearchComplete: nullableBoolean(water?.major_lake_search_complete),
    namedRiverId: normalizedId(water?.nearest_named_river_id),
    namedRiverName: nullableString(water?.nearest_named_river_name),
    riverClass: nullableString(water?.river_class),
    riverDistanceM: nullableNumber(water?.river_distance_m),
    namedRiverSearchRadiusM: nullableNumber(water?.named_river_search_radius_m),
    namedRiverSearchComplete: nullableBoolean(water?.named_river_search_complete),
    supportingRiverId: normalizedId(water?.nearest_supporting_river_id),
    supportingRiverFlowOrder: nullableNumber(water?.supporting_river_flow_order),
    supportingRiverDischargeCms: nullableNumber(water?.supporting_river_discharge_cms),
    supportingRiverDrainageAreaSqKm: nullableNumber(
      water?.supporting_river_drainage_area_sq_km
    ),
    supportingRiverDistanceM: nullableNumber(water?.supporting_river_distance_m),
    supportingRiverSearchRadiusM: nullableNumber(water?.supporting_river_search_radius_m),
    supportingRiverSearchComplete: nullableBoolean(water?.supporting_river_search_complete),
    nearestWaterSourceType: nullableString(water?.nearest_water_source_type),
    nearestWaterSourceId: normalizedId(water?.nearest_water_source_id),
    nearestWaterSourceName: nullableString(water?.nearest_water_source_name),
    nearestWaterSourceKind: waterKind(water?.nearest_water_source_kind),
    nearestWaterSourceDistanceM: nullableNumber(water?.nearest_water_source_distance_m),
    nearestWaterResolution: nullableString(water?.nearest_water_resolution),
    nearestWaterSearchRadiusM: nullableNumber(water?.nearest_water_search_radius_m),
    nearestWaterSearchComplete: nullableBoolean(water?.nearest_water_search_complete),
    oceanDepthClass: nullableString(water?.ocean_depth_class),
    waterbodyIdentity,
    waterNameFallback,
    flagPlacementWater,
    derivedTags: Array.isArray(profile?.derived_tags) ? profile.derived_tags.map(String) : [],
    release,
    warnings,
    slope: null,
    worldReleaseId: release?.releaseId ?? null,
    worldReleaseVersion: release?.releaseId ?? null,
    environmentSchemaVersion: nullableString(profile?.environment_schema_version),
    generatorVersion: null,
    sourceVersions: stringRecord(profile?.source_versions),
    raw
  };
  if (!ok) {
    result.warning = failure?.message ?? "world lookup failed exact global release validation";
  }
  return result;
}

function worldFailure(
  code: WorldLookupFailureCode,
  message: string,
  retryable: boolean,
  retryAfterMs?: number
): WorldLookupFailure {
  return {
    code,
    message,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  };
}

function normalizeFlagPlacementWater(value: unknown): FlagPlacementWaterDecision | null {
  const decision = recordOrNull(value);
  const kind = nullableString(decision?.kind);
  const releaseId = nullableString(decision?.release_id);
  const reason = nullableString(decision?.reason);
  const resolution = nullableString(decision?.resolution);
  if (
    typeof decision?.blocked !== "boolean" ||
    !kind ||
    !["ocean", "lake", "river", "inland_water", "land", "unknown"].includes(kind) ||
    !releaseId ||
    !reason ||
    !resolution
  ) {
    return null;
  }
  return {
    blocked: decision.blocked,
    kind: kind as FlagPlacementWaterDecision["kind"],
    sourceId: normalizedId(decision.source_id),
    sourceName: nullableString(decision.source_name),
    distanceM: nullableNumber(decision.distance_m),
    corridorRadiusM: nullableNumber(decision.corridor_radius_m),
    reason,
    resolution,
    releaseId
  };
}

function normalizeReleaseIdentity(value: unknown): WorldReleaseIdentity | null {
  const release = recordOrNull(value);
  const releaseId = nullableString(release?.release_id);
  const profileSetFingerprint = nullableString(release?.profile_set_fingerprint);
  const buildContractFingerprint = nullableString(release?.build_contract_fingerprint);
  const boundaryReleaseId = nullableString(release?.boundary_release_id);
  const packageCount = nullableNumber(release?.package_count);
  if (!releaseId || !profileSetFingerprint || !buildContractFingerprint || !boundaryReleaseId || packageCount === null) {
    return null;
  }
  return { releaseId, profileSetFingerprint, buildContractFingerprint, boundaryReleaseId, packageCount };
}

function normalizeRuntimeIdentity(value: unknown): WorldRuntimeIdentity | null {
  const runtime = recordOrNull(value);
  const sha = nullableString(runtime?.sha);
  const branch = nullableString(runtime?.branch);
  if (!sha?.trim() || !branch?.trim()) return null;
  return { sha, branch };
}

function assertReleaseIdentity(
  actual: WorldReleaseIdentity,
  required: RequiredWorldRelease
): void {
  for (const key of [
    "releaseId",
    "profileSetFingerprint",
    "buildContractFingerprint",
    "boundaryReleaseId"
  ] as const) {
    if (actual[key] !== required[key]) {
      throw new WorldReleaseMismatchError(
        `world API ${key} is ${actual[key]}, expected ${required[key]}`
      );
    }
  }
}

function surfaceKindValue(value: unknown): "land" | "water" | null {
  return value === "land" || value === "water" ? value : null;
}

function authoritativeWaterKind(
  value: unknown
): "ocean" | "lake" | "river" | "inland_water" | null {
  return value === "ocean" || value === "lake" || value === "river" || value === "inland_water"
    ? value
    : null;
}

function normalizeWaterbodyIdentity(
  row: Record<string, unknown> | null
): WorldWaterbodyIdentity | null {
  if (!row) return null;
  const nested = firstDefinedProperty(row, [
    "waterbodyIdentity",
    "waterbody_identity",
    "waterbody"
  ]);
  const hasDirectFields = [
    "canonicalWaterbodyId",
    "canonical_waterbody_id",
    "gameplayWaterType",
    "gameplay_water_type",
    "displayName",
    "display_name",
    "parentCanonicalWaterbodyId",
    "parent_canonical_waterbody_id",
    "parentCanonicalWaterbodyName",
    "parent_canonical_waterbody_name",
    "resolutionStatus",
    "resolution_status",
    "candidateCount",
    "candidate_count"
  ].some((key) => Object.prototype.hasOwnProperty.call(row, key));
  if (nested === undefined && !hasDirectFields) return null;

  if (nested === null) return null;
  const identity = nested === undefined ? row : recordOrNull(nested);
  if (!identity) return invalidWaterbodyIdentity();

  const canonicalValue = firstDefinedProperty(identity, [
    "canonicalWaterbodyId",
    "canonical_waterbody_id"
  ]);
  const typeValue = firstDefinedProperty(identity, [
    "gameplayWaterType",
    "gameplay_water_type"
  ]);
  const displayValue = firstDefinedProperty(identity, [
    "displayName",
    "display_name"
  ]);
  const rawStatus = firstDefinedProperty(identity, [
    "resolutionStatus",
    "resolution_status",
    "resolution_state"
  ]) ?? firstDefinedProperty(row, [
    "waterbodyResolutionStatus",
    "waterbody_resolution_status"
  ]);
  const resolutionStatus = normalizeWaterbodyResolutionStatus(rawStatus);
  const candidateCountValue = firstDefinedProperty(identity, [
    "candidateCount",
    "candidate_count"
  ]);
  const canonicalWaterbodyId = trimmedNullableString(canonicalValue);
  const gameplayWaterType = authoritativeWaterKind(typeValue);
  const displayName = trimmedNullableString(displayValue);
  const parentValue = firstDefinedProperty(identity, [
    "parentCanonicalWaterbodyId",
    "parent_canonical_waterbody_id"
  ]);
  const parentCanonicalWaterbodyId = trimmedNullableString(parentValue);
  const parentNameValue = firstDefinedProperty(identity, [
    "parentCanonicalWaterbodyName",
    "parent_canonical_waterbody_name"
  ]);
  const parentCanonicalWaterbodyName = trimmedNullableString(parentNameValue);
  const candidateCount = nullableNonNegativeInteger(candidateCountValue);
  const valid = Boolean(
    resolutionStatus &&
    gameplayWaterType &&
    (resolutionStatus !== "resolved" || canonicalWaterbodyId) &&
    (canonicalWaterbodyId === null || resolutionStatus === "resolved") &&
    (candidateCountValue === undefined || candidateCountValue === null || candidateCount !== null) &&
    (canonicalValue === undefined || canonicalValue === null || typeof canonicalValue === "string") &&
    (typeValue === undefined || typeValue === null || typeof typeValue === "string") &&
    (displayValue === undefined || displayValue === null || typeof displayValue === "string") &&
    (parentValue === undefined || parentValue === null || typeof parentValue === "string")
    && (parentNameValue === undefined || parentNameValue === null || typeof parentNameValue === "string")
  );
  return {
    canonicalWaterbodyId,
    gameplayWaterType,
    displayName,
    resolutionStatus: valid ? resolutionStatus! : "invalid",
    candidateCount,
    parentCanonicalWaterbodyId,
    parentCanonicalWaterbodyName
  };
}

function normalizeWaterNameFallback(
  row: Record<string, unknown> | null
): WorldWaterNameFallback | null {
  if (!row) return null;
  const nested = firstDefinedProperty(row, ["waterNameFallback", "water_name_fallback"]);
  if (nested === undefined || nested === null) return null;
  const fallback = recordOrNull(nested);
  if (!fallback) return null;
  const name = trimmedNullableString(firstDefinedProperty(fallback, ["name", "displayName"]));
  const waterClassValue = firstDefinedProperty(fallback, ["waterClass", "water_class"]);
  const waterClass = waterClassValue === "river" || waterClassValue === "lake" || waterClassValue === "ocean"
    ? waterClassValue
    : null;
  const authority = trimmedNullableString(fallback.authority);
  const referenceId = trimmedNullableString(firstDefinedProperty(fallback, ["referenceId", "reference_id"]));
  const distanceM = nullableNumber(firstDefinedProperty(fallback, ["distanceM", "distance_m"]));
  if (!name || !waterClass || !authority || (distanceM !== null && distanceM < 0)) return null;
  return { name, waterClass, distanceM, authority, referenceId };
}

function normalizeWaterbodyResolutionStatus(
  value: unknown
): WorldWaterbodyIdentity["resolutionStatus"] | null {
  if (value === "resolved" || value === "mapped") return "resolved";
  if (value === "unresolved") return "unresolved";
  if (value === "ambiguous" || value === "ambiguous_same_precedence") return "ambiguous";
  if (value === "invalid") return "invalid";
  return null;
}

function invalidWaterbodyIdentity(): WorldWaterbodyIdentity {
  return {
    canonicalWaterbodyId: null,
    gameplayWaterType: null,
    displayName: null,
    resolutionStatus: "invalid",
    candidateCount: null,
    parentCanonicalWaterbodyId: null,
    parentCanonicalWaterbodyName: null
  };
}

function firstDefinedProperty(
  record: Record<string, unknown>,
  keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function trimmedNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

type CanonicalGridSurface =
  | NonNullable<WorldLookupResult["riverSurface"]>
  | NonNullable<WorldLookupResult["lakeSurface"]>
  | NonNullable<WorldLookupResult["oceanCoastSurface"]>;

function canonicalGridSurface(
  result: WorldLookupResult
): CanonicalGridSurface | null {
  // A World result may carry metadata for all three surface authorities. Once
  // membership resolves to a type, only that type's grid may be used for the
  // distance calculation; falling back to another surface can select a cell
  // from the wrong authority at a boundary. Land results have no preferred
  // type, so retain the deterministic all-surface fallback for the search
  // anchor.
  const preferred = result.waterKind === "river"
    ? result.riverSurface
    : result.waterKind === "lake"
      ? result.lakeSurface
      : result.waterKind === "ocean"
        ? result.oceanCoastSurface
        : null;
  const surfaces = result.waterKind !== null
    ? [preferred]
    : [result.riverSurface, result.lakeSurface, result.oceanCoastSurface];
  for (const surface of surfaces) {
    if (
      surface &&
      Number.isSafeInteger(surface.rowId) &&
      Number.isSafeInteger(surface.columnId) &&
      surface.rowId >= 0 &&
      surface.columnId >= 0 &&
      Number.isFinite(surface.cellSizeM) &&
      surface.cellSizeM > 0
    ) {
      return surface;
    }
  }
  return null;
}

function canonicalGridSurfaces(
  result: WorldLookupResult
): CanonicalGridSurface[] {
  // Land origins have no resolved water type, so search each locked surface
  // independently. This keeps a nearby lake or ocean from being hidden by
  // the first (usually river) surface when the overlays use different grids.
  const preferred = result.waterKind === "river"
    ? result.riverSurface
    : result.waterKind === "lake"
      ? result.lakeSurface
      : result.waterKind === "ocean"
        ? result.oceanCoastSurface
        : null;
  const surfaces = result.waterKind !== null
    ? [preferred]
    : [result.riverSurface, result.lakeSurface, result.oceanCoastSurface];
  return surfaces.filter((surface): surface is CanonicalGridSurface => Boolean(
    surface &&
    Number.isSafeInteger(surface.rowId) &&
    Number.isSafeInteger(surface.columnId) &&
    surface.rowId >= 0 &&
    surface.columnId >= 0 &&
    Number.isFinite(surface.cellSizeM) &&
    surface.cellSizeM > 0
  ));
}

function canonicalWaterbodyAt(
  result: WorldGameplayEnvironmentResult,
  surface: CanonicalGridSurface | null
): Omit<CanonicalWaterbodyLookup, "distanceM" | "searchComplete" | "sourceRevision"> | null {
  if (result.surfaceKind !== "water" || !surface) return null;
  if (result.waterbodyIdentity) {
    const identity = result.waterbodyIdentity;
    const kind = identity.gameplayWaterType;
    if (
      identity.resolutionStatus !== "resolved" ||
      !kind ||
      !identity.canonicalWaterbodyId ||
      (result.waterKind !== null && result.waterKind !== kind)
    ) {
      return {
        kind,
        sourceId: null,
        sourceName: identity.displayName,
        waterNameFallback: sameClassWaterNameFallback(result, kind),
        resolutionStatus: (
          result.waterKind !== null && result.waterKind !== kind
            ? "invalid"
            : identity.resolutionStatus
        )
      };
    }
    return {
      kind,
      sourceId: identity.canonicalWaterbodyId,
      sourceName: identity.displayName,
      waterNameFallback: sameClassWaterNameFallback(result, kind),
      resolutionStatus: "resolved"
    };
  }

  // Compatibility for World runtimes that expose the canonical river feature
  // field but predate the identity overlay. Never synthesize an identity from
  // a source release, cell coordinates, or legacy nearest-water IDs.
  if (result.waterKind === "river" && result.riverSurface?.isRiver === true) {
    const canonicalFeatureId = result.riverSurface.canonicalFeatureId?.trim();
    if (!canonicalFeatureId) return null;
    return {
      kind: "river",
      sourceId: canonicalFeatureId,
      sourceName: result.namedRiverName?.trim() || null,
      waterNameFallback: sameClassWaterNameFallback(result, "river"),
      resolutionStatus: "resolved"
    };
  }
  return null;
}

function sameClassWaterNameFallback(
  result: WorldGameplayEnvironmentResult,
  kind: CanonicalWaterbodyLookup["kind"]
): WorldWaterNameFallback | null {
  const fallback = result.waterNameFallback;
  return fallback && fallback.waterClass === kind ? fallback : null;
}

function canonicalWaterbodyKindOrder(
  kind: CanonicalWaterbodyLookup["kind"]
): number {
  return kind === "lake" ? 0
    : kind === "river" ? 1
      : kind === "ocean" ? 2
        : kind === "inland_water" ? 3
          : 4;
}

const WEB_MERCATOR_RADIUS_M = 6_378_137;
const WEB_MERCATOR_HALF_WORLD_M = Math.PI * WEB_MERCATOR_RADIUS_M;
const WEB_MERCATOR_MAX_LAT = 85.05112878;

function canonicalCellCenter(
  rowId: number,
  columnId: number,
  cellSizeM: number
): LatLon {
  const x = -WEB_MERCATOR_HALF_WORLD_M + (columnId + 0.5) * cellSizeM;
  const y = WEB_MERCATOR_HALF_WORLD_M - (rowId + 0.5) * cellSizeM;
  return unprojectWebMercator(x, y);
}

function unprojectWebMercator(x: number, y: number): LatLon {
  return {
    lat: Math.max(
      -WEB_MERCATOR_MAX_LAT,
      Math.min(
        WEB_MERCATOR_MAX_LAT,
        (Math.atan(Math.exp(y / WEB_MERCATOR_RADIUS_M)) * 2 - Math.PI / 2)
          * (180 / Math.PI)
      )
    ),
    lon: ((x / WEB_MERCATOR_RADIUS_M) * (180 / Math.PI) + 540) % 360 - 180
  };
}

function projectWebMercator(point: LatLon): { x: number; y: number } {
  const latitude = Math.max(-WEB_MERCATOR_MAX_LAT, Math.min(WEB_MERCATOR_MAX_LAT, point.lat));
  const latitudeRadians = latitude * (Math.PI / 180);
  return {
    x: WEB_MERCATOR_RADIUS_M * point.lon * (Math.PI / 180),
    y: WEB_MERCATOR_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2))
  };
}

function canonicalCellDistanceM(
  point: LatLon,
  surface: CanonicalGridSurface
): number {
  const projected = projectWebMercator(point);
  const west = -WEB_MERCATOR_HALF_WORLD_M + surface.columnId * surface.cellSizeM;
  const east = west + surface.cellSizeM;
  const north = WEB_MERCATOR_HALF_WORLD_M - surface.rowId * surface.cellSizeM;
  const south = north - surface.cellSizeM;
  // Columns wrap at the antimeridian: measure against the nearest world copy.
  const horizontal = Math.min(...[-2, 0, 2].map((copies) => {
    const x = projected.x + copies * WEB_MERCATOR_HALF_WORLD_M;
    return x < west ? west - x : x > east ? x - east : 0;
  }));
  const vertical = projected.y < south ? south - projected.y : projected.y > north ? projected.y - north : 0;
  return Math.hypot(horizontal, vertical);
}

function clampCanonicalGridIndex(index: number, cellSizeM: number): number {
  const cellCount = Math.ceil((2 * WEB_MERCATOR_HALF_WORLD_M) / cellSizeM);
  return Math.min(cellCount - 1, Math.max(0, index));
}

function wrapCanonicalGridColumn(index: number, cellSizeM: number): number {
  const cellCount = Math.ceil((2 * WEB_MERCATOR_HALF_WORLD_M) / cellSizeM);
  return ((index % cellCount) + cellCount) % cellCount;
}

function normalizeRiverSurface(
  value: unknown
): NonNullable<WorldLookupResult["riverSurface"]> | null {
  const surface = recordOrNull(value);
  const cellSizeM = nullableNumber(surface?.cell_size_m);
  const rowId = nullableNumber(surface?.row_id);
  const columnId = nullableNumber(surface?.column_id);
  const sourceReleaseId = nullableString(surface?.source_release_id);
  const sourceManifestSha256 = nullableString(surface?.source_manifest_sha256);
  const membership = surface?.is_river;
  if (
    typeof membership !== "boolean" ||
    cellSizeM === null ||
    rowId === null ||
    columnId === null ||
    !sourceReleaseId ||
    !sourceManifestSha256 ||
    (membership && (
      surface?.surface_kind !== "water" ||
      surface?.water_kind !== "river"
    )) ||
    (!membership && (
      surface?.surface_kind !== null ||
      surface?.water_kind !== null
    ))
  ) return null;
  return {
    surfaceKind: membership ? "water" : null,
    waterKind: membership ? "river" : null,
    isRiver: membership,
    cellSizeM,
    rowId,
    columnId,
    sourceReleaseId,
    sourceManifestSha256,
    canonicalFeatureId: nullableString(surface?.canonical_feature_id)
  };
}

function normalizeLakeSurface(
  value: unknown
): NonNullable<WorldLookupResult["lakeSurface"]> | null {
  const surface = normalizeCanonicalSurface(value, "lake", "is_lake");
  return surface ? { ...surface, isLake: surface.membership } : null;
}

function normalizeOceanCoastSurface(
  value: unknown
): NonNullable<WorldLookupResult["oceanCoastSurface"]> | null {
  const surface = normalizeCanonicalSurface(value, "ocean", "is_ocean_coast");
  return surface ? { ...surface, isOceanCoast: surface.membership } : null;
}

function normalizeCanonicalSurface<TKind extends "lake" | "ocean">(
  value: unknown,
  kind: TKind,
  wireMembershipKey: "is_lake" | "is_ocean_coast"
): {
  surfaceKind: "water" | null;
  waterKind: TKind | null;
  membership: boolean;
  cellSizeM: number;
  rowId: number;
  columnId: number;
  sourceReleaseId: string;
  sourceManifestSha256: string;
  canonicalFeatureId: string | null;
  canonicalFeatureName: string | null;
} | null {
  const surface = recordOrNull(value);
  const membership = surface?.[wireMembershipKey];
  const cellSizeM = nullableNumber(surface?.cell_size_m);
  const rowId = nullableNumber(surface?.row_id);
  const columnId = nullableNumber(surface?.column_id);
  const sourceReleaseId = nullableString(surface?.source_release_id);
  const sourceManifestSha256 = nullableString(surface?.source_manifest_sha256);
  if (
    typeof membership !== "boolean" ||
    cellSizeM === null || rowId === null || columnId === null ||
    !sourceReleaseId || !sourceManifestSha256 ||
    (membership && (
      surface?.surface_kind !== "water" || surface?.water_kind !== kind
    ))
  ) return null;
  return {
    surfaceKind: membership ? "water" : null,
    waterKind: membership ? kind : null,
    membership,
    cellSizeM,
    rowId,
    columnId,
    sourceReleaseId,
    sourceManifestSha256,
    canonicalFeatureId: kind === "lake"
      ? nullableString(surface?.lake_id)
      : null,
    canonicalFeatureName: kind === "lake"
      ? nullableString(surface?.lake_name)
      : null
  };
}

function assertRiverAuthorityHealth(
  health: Record<string, unknown>,
  required: RequiredRiverAuthority
): void {
  const runtime = recordOrNull(health.runtime);
  const riverSurface = recordOrNull(health.river_surface);
  const identity = recordOrNull(riverSurface?.identity);
  const capabilities = recordOrNull(health.capabilities);
  if (
    nullableString(runtime?.sha) !== required.runtimeSha ||
    nullableString(riverSurface?.mode) !== required.releaseId ||
    nullableString(identity?.release_id) !== required.releaseId ||
    nullableString(identity?.manifest_sha256) !== required.manifestSha256 ||
    nullableString(identity?.policy) !== required.policy ||
    nullableNumber(riverSurface?.cell_size_m) !== required.cellSizeM ||
    capabilities?.riverWaterAuthorityV1 !== true
  ) {
    throw new WorldReleaseMismatchError(
      "World river authority does not match the locked runtime and source identity"
    );
  }
}

function assertCanonicalSurfaceAuthorityHealth(
  health: Record<string, unknown>,
  required: RequiredCanonicalSurfaceAuthority,
  healthKey: "lake_surface" | "ocean_coast_surface",
  capabilityKey: "lakeWaterAuthorityV1" | "oceanCoastWaterAuthorityV1",
  label: string
): void {
  const runtime = recordOrNull(health.runtime);
  const surface = recordOrNull(health[healthKey]);
  const identity = recordOrNull(surface?.identity);
  const capabilities = recordOrNull(health.capabilities);
  if (
    nullableString(runtime?.sha) !== required.runtimeSha ||
    nullableString(surface?.mode) !== required.releaseId ||
    nullableString(identity?.release_id) !== required.releaseId ||
    nullableString(identity?.manifest_sha256) !== required.manifestSha256 ||
    nullableString(identity?.policy) !== required.policy ||
    nullableNumber(identity?.cell_size_m) !== required.cellSizeM ||
    capabilities?.[capabilityKey] !== true
  ) {
    throw new WorldReleaseMismatchError(
      `World ${label} authority does not match the locked runtime and source identity`
    );
  }
}

function assertWaterbodyIdentityAuthorityHealth(
  health: Record<string, unknown>,
  required: RequiredWaterbodyIdentityAuthority
): void {
  const runtime = recordOrNull(health.runtime);
  const overlay = recordOrNull(
    health.waterbody_identity_overlay
      ?? health.waterbody_identity
      ?? health.waterbodyIdentityOverlay
      ?? health.waterbodyIdentity
  );
  // The protected pipeline emits the sealed overlay identity directly. Keep accepting the
  // earlier nested health shape for already-parked test runtimes, but validate the same exact
  // release/hash/schema/policy authority in either representation.
  const identity = recordOrNull(overlay?.identity) ?? overlay;
  const capabilities = recordOrNull(health.capabilities);
  const schema = nullableString(identity?.schema ?? identity?.schema_version);
  const schemaVersion = nullableString(identity?.schema_version ?? identity?.schemaVersion);
  const policyVersion = nullableString(identity?.policy_version ?? identity?.policyVersion);
  if (
    nullableString(runtime?.sha) !== required.runtimeSha ||
    nullableString(overlay?.mode ?? identity?.release_id ?? identity?.releaseId) !== required.releaseId ||
    nullableString(identity?.manifest_sha256 ?? identity?.manifestSha256) !== required.manifestSha256 ||
    nullableString(identity?.policy) !== required.policy ||
    schema !== required.schema ||
    schemaVersion !== required.schemaVersion ||
    policyVersion !== required.policyVersion ||
    capabilities?.waterbodyIdentityV1 !== true
  ) {
    throw new WorldReleaseMismatchError(
      "World waterbody identity authority does not match the locked runtime and overlay"
    );
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorldSettlementLookupError(`world settlement API omitted ${field}`);
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function normalizeResourceEnvironment(
  value: unknown,
  expectedPoint: LatLon | undefined,
  release: WorldReleaseIdentity
): WorldLookupResult {
  const row = recordOrNull(value);
  const latitude = nullableNumber(row?.latitude);
  const longitude = nullableNumber(row?.longitude);
  const packageId = nullableString(row?.package_id);
  const isLand = nullableBoolean(row?.is_land);
  const isSaltwater = nullableBoolean(row?.is_saltwater);
  const insideMajorLake = nullableBoolean(row?.inside_major_lake);
  const surfaceKind = surfaceKindValue(row?.surface_kind);
  const waterKindValue = authoritativeWaterKind(row?.water_kind);
  const ok = Boolean(
    row?.ok === true &&
    expectedPoint &&
    latitude === expectedPoint.lat &&
    longitude === expectedPoint.lon &&
    packageId &&
    isLand !== null &&
    isSaltwater !== null &&
    insideMajorLake !== null
  );
  return {
    ok,
    packageId,
    latitude,
    longitude,
    elevationM: nullableNumber(row?.elevation_m),
    terrainClass: nullableString(row?.terrain_class),
    landCoverClass: nullableString(row?.land_cover_class),
    sourceLandCoverCode: nullableNumber(row?.source_land_cover_code),
    biome: nullableString(row?.biome),
    ecoregion: nullableString(row?.ecoregion),
    isLand,
    isSaltwater,
    insideMajorLake,
    surfaceKind,
    waterKind: waterKindValue,
    riverDistanceM: nullableNumber(row?.river_distance_m),
    majorLakeDistanceM: nullableNumber(row?.major_lake_distance_m),
    release,
    warnings: nullableString(row?.warning) ? [String(row?.warning)] : [],
    raw: row ?? value,
    ...(nullableString(row?.warning) ? { warning: String(row?.warning) } : {})
  };
}

function normalizedId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+\.0+$/.test(trimmed)) return trimmed.slice(0, trimmed.indexOf("."));
    return trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  return null;
}

function ecologyResolution(
  value: unknown
): Exclude<WorldLookupResult["ecologyResolution"], undefined> {
  return value === "exact" ||
    value === "nearest_land_fallback" ||
    value === "unavailable" ||
    value === "not_applicable"
    ? value
    : null;
}

function waterKind(
  value: unknown
): Exclude<WorldLookupResult["nearestWaterSourceKind"], undefined> {
  return value === "fresh" || value === "salt" || value === "unknown" ? value : null;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = recordOrNull(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry]] : []
    )
  );
}

function stringProperty(record: Record<string, unknown> | null, key: string): string | null {
  return nullableString(record?.[key]);
}

function booleanProperty(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameRelease(
  left: WorldReleaseIdentity | null | undefined,
  right: WorldReleaseIdentity
): boolean {
  return Boolean(
    left &&
      left.releaseId === right.releaseId &&
      left.profileSetFingerprint === right.profileSetFingerprint &&
      left.buildContractFingerprint === right.buildContractFingerprint &&
      left.boundaryReleaseId === right.boundaryReleaseId &&
      left.packageCount === right.packageCount
  );
}

function validateBatchPoints(points: readonly LatLon[]): void {
  if (points.length > WORLD_GAMEPLAY_ENVIRONMENT_BATCH_MAX_POINTS) {
    throw new WorldBatchLookupError(
      `world batch lookup is limited to `
      + `${WORLD_GAMEPLAY_ENVIRONMENT_BATCH_MAX_POINTS} points`
    );
  }
  for (const [index, point] of points.entries()) {
    if (
      !Number.isFinite(point.lat) ||
      !Number.isFinite(point.lon) ||
      point.lat < -90 ||
      point.lat > 90 ||
      point.lon < -180 ||
      point.lon > 180
    ) {
      throw new WorldBatchLookupError(`world batch point ${index} is outside valid WGS84 bounds`);
    }
  }
}

async function worldBatchHttpError(
  response: Response,
  context: string
): Promise<WorldBatchLookupError> {
  const retryAfterHeaderMs = parseRetryAfterMs(response.headers.get("retry-after"));
  let structuredRetryAfterMs: number | null = null;
  try {
    const raw = recordOrNull(JSON.parse(await response.text()));
    structuredRetryAfterMs = boundedRetryAfterMs(
      raw?.retry_after_ms
      ?? recordOrNull(raw?.details)?.retry_after_ms
      ?? recordOrNull(raw?.error)?.retry_after_ms
    );
  } catch {
    structuredRetryAfterMs = null;
  }
  if (response.status === 429 || response.status === 503) {
    return new WorldBatchBackpressureError(
      `${context} returned HTTP ${response.status}`,
      Math.max(
        1_000,
        retryAfterHeaderMs ?? 0,
        structuredRetryAfterMs ?? 0
      ),
      response.status
    );
  }
  return new WorldBatchLookupError(
    `${context} returned HTTP ${response.status}`
  );
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

function boundedRetryAfterMs(value: unknown): number | null {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return Math.min(60_000, Math.ceil(milliseconds));
}

function resourceBatchKey(
  points: readonly LatLon[],
  requiredRelease: RequiredWorldRelease | undefined
): string {
  return JSON.stringify([
    "resource-environment-v1",
    requiredRelease ?? null,
    points.map((point) => [point.lat, point.lon])
  ]);
}

function gameplayEnvironmentCacheKey(
  point: LatLon,
  authority: RequiredWorldRelease | WorldReleaseIdentity | undefined
): string {
  return [
    "gameplay-environment-v1",
    worldReleaseIdentityKey(authority),
    point.lat.toFixed(6),
    point.lon.toFixed(6),
    // Preserve exact point authority when two positions share the same six-decimal cell key.
    String(point.lat),
    String(point.lon)
  ].join(":");
}

function gameplayEnvironmentBatchKey(
  points: readonly LatLon[],
  authority: RequiredWorldRelease | WorldReleaseIdentity | undefined
): string {
  return JSON.stringify([
    "gameplay-environment-v1",
    worldReleaseIdentityKey(authority),
    points.map((point) => [
      point.lat.toFixed(6),
      point.lon.toFixed(6),
      point.lat,
      point.lon
    ])
  ]);
}

function cloneGameplayEnvironment(
  value: WorldGameplayEnvironmentResult
): WorldGameplayEnvironmentResult {
  return structuredClone(value);
}

function immutableGameplayEnvironment(
  value: WorldGameplayEnvironmentResult
): WorldGameplayEnvironmentResult {
  return deepFreezeGameplayEnvironment(cloneGameplayEnvironment(value));
}

function deepFreezeGameplayEnvironment<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeGameplayEnvironment(child);
    }
    Object.freeze(value);
  }
  return value;
}

async function subscribeToSharedLookup<T>(
  shared: SharedLookup<T>,
  signal: AbortSignal | undefined,
  abandonedMessage: string,
  project?: (value: T) => T
): Promise<T> {
  throwIfAborted(signal);
  shared.subscribers += 1;
  let abortListener: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        abortListener = () => reject(abortReason(signal));
        signal.addEventListener("abort", abortListener, { once: true });
      })
    : null;
  try {
    const result = await (aborted ? Promise.race([shared.promise, aborted]) : shared.promise);
    return project ? project(result) : result;
  } finally {
    if (abortListener) signal?.removeEventListener("abort", abortListener);
    shared.subscribers -= 1;
    if (shared.subscribers === 0 && !shared.settled) {
      shared.controller.abort(new Error(abandonedMessage));
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortableRequest(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  };
}
