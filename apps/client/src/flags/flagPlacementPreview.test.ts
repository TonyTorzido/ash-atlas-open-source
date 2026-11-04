import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FLAG_PREVIEW_CACHE_TTL_MS,
  FlagPlacementPreviewTerrain
} from "./flagPlacementPreview.js";

describe("FlagPlacementPreviewTerrain", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("invalidates immediately and refreshes authority after sub-threshold coordinate movement", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        isLand: true,
        isSaltwater: false,
        insideMajorLake: false,
        worldReleaseId: "release-a"
      }))
      .mockResolvedValueOnce(response({
        isLand: false,
        isSaltwater: true,
        insideMajorLake: false,
        worldReleaseId: "release-a"
      }));
    const terrain = vi.fn();
    const preview = new FlagPlacementPreviewTerrain("http://server.test", terrain, fetcher as typeof fetch);

    preview.setPosition({ lat: 35, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(terrain).toHaveBeenLastCalledWith("land");

    preview.setPosition({ lat: 35.00001, lon: -106 });
    expect(terrain).toHaveBeenLastCalledWith("unknown");
    await vi.advanceTimersByTimeAsync(120);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(terrain).toHaveBeenLastCalledWith("water");
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      URL | RequestInfo,
      RequestInit
    ];
    expect(String(url)).toBe("http://server.test/api/flags/placement-quote");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
  });

  it("binds a buoy quote request and returned build intent to the buoy kind", async () => {
    const fetcher = vi.fn(async () => response({
      surfaceKind: "water",
      waterKind: "ocean",
      isLand: false,
      isSaltwater: true,
      placementQuote: {
        quoteId: "buoy-quote",
        anchorKind: "buoy",
        expiresAt: Date.now() + 60_000
      }
    }));
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 35, lon: -106 });

    await expect(preview.ensureQuoteForCurrentPosition("buoy")).resolves.toMatchObject({
      quoteId: "buoy-quote",
      anchorKind: "buoy"
    });
    const [, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ anchorKind: "buoy" });
  });

  it("retains the server-owned quote only until its expiry", async () => {
    let now = 1_000;
    const fetcher = vi.fn(async () => response({
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      placementQuote: {
        quoteId: "11111111-1111-4111-8111-111111111111",
        expiresAt: 16_000
      }
    }));
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch,
      () => now
    );
    preview.setPosition({ lat: 35, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);

    expect(preview.currentQuoteId()).toBe("11111111-1111-4111-8111-111111111111");
    now = 16_001;
    expect(preview.currentQuoteId()).toBeUndefined();
  });

  it("renews a stationary quote only when the existing quote expires", async () => {
    vi.setSystemTime(1_000);
    let request = 0;
    const fetcher = vi.fn(async () => {
      request += 1;
      return response({
        isLand: true,
        isSaltwater: false,
        insideMajorLake: false,
        worldReleaseId: "release-a",
        placementQuote: {
          quoteId: `quote-${request}`,
          expiresAt: Date.now() + 60_000
        }
      });
    });
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 35, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);
    expect(preview.currentQuoteId()).toBe("quote-1");

    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(preview.currentQuoteId()).toBe("quote-2");
  });

  it("does not start a replacement request when Build consumes a quote", async () => {
    const fetcher = vi.fn(async () => response({
      isLand: true,
      placementQuote: { quoteId: "quote-1", expiresAt: Date.now() + 60_000 }
    }));
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 35, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);

    preview.consumeQuote("quote-1");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(preview.currentQuoteId()).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("invalidates a quote immediately after movement", async () => {
    const fetcher = vi.fn(async () => response({
      isLand: true,
      isSaltwater: false,
      placementQuote: { quoteId: "quote-1", expiresAt: Date.now() + 60_000 }
    }));
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 35, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);
    expect(preview.currentQuoteId()).toBe("quote-1");
    preview.setPosition({ lat: 35.001, lon: -106 });
    expect(preview.currentQuoteId()).toBeUndefined();
  });

  it("invokes the browser fetch implementation with the Window-compatible binding", async () => {
    const fetcher = vi.fn(function (this: typeof globalThis) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(response({
        isLand: true,
        placementQuote: {
          quoteId: "bound-fetch-quote",
          expiresAt: Date.now() + 60_000
        }
      }));
    });
    vi.stubGlobal("fetch", fetcher);
    const preview = new FlagPlacementPreviewTerrain("http://server.test", vi.fn());

    preview.setPosition({ lat: 29.9511, lon: -90.0715 });
    await vi.advanceTimersByTimeAsync(120);

    expect(preview.currentQuoteId()).toBe("bound-fetch-quote");
  });

  it("bypasses preview debounce and shares one in-flight quote request", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((done) => {
      resolve = done;
    }));
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 35, lon: -106 });

    const first = preview.ensureQuoteForCurrentPosition();
    const second = preview.ensureQuoteForCurrentPosition();
    expect(fetcher).toHaveBeenCalledOnce();
    resolve(response({
      isLand: true,
      placementQuote: {
        quoteId: "quote-1",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000
      }
    }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ quoteId: "quote-1" }),
      expect.objectContaining({ quoteId: "quote-1" })
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("returns a precise retryable moving outcome without requesting rich lookup", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: false,
        outcome: "PLAYER_MOVING",
        message: "Finish moving before preparing this flag location.",
        retryable: true,
        authoritativePosition: { lat: 35, lon: -106 }
      })
    } as Response));
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 35.000001, lon: -106.000001 });

    await expect(preview.ensureQuoteForCurrentPosition()).rejects.toMatchObject({
      reason: "movement",
      code: "PLAYER_MOVING",
      retryable: true,
      message: "Finish moving before preparing this flag location."
    });
    const [url] = fetcher.mock.calls[0] as unknown as [URL | RequestInfo, RequestInit];
    expect(String(url)).toContain("/api/flags/placement-quote");
    expect(String(url)).not.toContain("/api/world/lookup");
  });

  it.each([
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [400, false]
  ])("classifies HTTP %s retryability and preserves Retry-After", async (status, retryable) => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status,
      headers: new Headers({ "retry-after": "1" })
    } as Response));
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 35, lon: -106 });

    await expect(preview.ensureQuoteForCurrentPosition()).rejects.toMatchObject({
      code: "HTTP_ERROR",
      retryable,
      retryAfterMs: 1_000
    });
  });

  it("turns a stalled quote request into a bounded retryable timeout", async () => {
    const fetcher = vi.fn((_url: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }));
    const terrain = vi.fn();
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      terrain,
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 35, lon: -106 });
    const pending = preview.ensureQuoteForCurrentPosition();
    const rejected = expect(pending).rejects.toMatchObject({
      reason: "unavailable",
      code: "QUOTE_REQUEST_TIMEOUT",
      retryable: true,
      retryAfterMs: 150
    });

    await vi.advanceTimersByTimeAsync(1_250);

    await rejected;
    expect(terrain).toHaveBeenLastCalledWith("unknown");
  });

  it("binds quote preparation to submitted movement and relocation revisions", async () => {
    const fetcher = vi.fn(async () => response({
      authoritativePosition: { lat: 29.9511, lon: -90.0715 },
      isLand: true
    }));
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch,
      Date.now,
      () => ({ movementRevision: 7, relocationRevision: 3 })
    );
    preview.setPosition({ lat: 29.9511001, lon: -90.0714999 });
    await preview.ensureQuoteForCurrentPosition();

    const [, init] = fetcher.mock.calls[0] as unknown as [URL | RequestInfo, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      trigger: "build",
      movementRevision: 7,
      relocationRevision: 3,
      requestedPosition: { lat: 29.9511001, lon: -90.0714999 }
    });
  });

  it("keeps an expiry-time renewal failure silent", async () => {
    vi.setSystemTime(1_000);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        isLand: true,
        placementQuote: { quoteId: "quote-1", expiresAt: 61_000 }
      }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: false,
          outcome: "COMPACT_WORLD_UNAVAILABLE",
          message: "World is temporarily unavailable.",
          retryable: true
        })
      } as Response);
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 35, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(preview.currentQuoteId()).toBeUndefined();
  });

  it("cancels an awaited quote if the player moves", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((done) => {
      resolve = done;
    }));
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 35, lon: -106 });
    const pending = preview.ensureQuoteForCurrentPosition();

    preview.setPosition({ lat: 35.001, lon: -106 });
    resolve(response({
      isLand: true,
      placementQuote: {
        quoteId: "old-position",
        expiresAt: Date.now() + 60_000
      }
    }));

    await expect(pending).rejects.toMatchObject({
      reason: "movement",
      code: "PLAYER_MOVING"
    });
    expect(preview.currentQuoteId()).toBeUndefined();
  });

  it.each(["disconnect", "destroyed"] as const)(
    "cancels an awaited quote on %s",
    async (reason) => {
      const fetcher = vi.fn((_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }));
      const preview = new FlagPlacementPreviewTerrain(
        "http://server.test",
        vi.fn(),
        fetcher as typeof fetch
      );
      preview.setPosition({ lat: 35, lon: -106 });
      const pending = preview.ensureQuoteForCurrentPosition();

      if (reason === "destroyed") preview.destroy();
      else preview.cancel("disconnect");

      await expect(pending).rejects.toMatchObject({ reason });
    }
  );

  it.each([
    ["river", {
      isLand: true,
      flagPlacementWater: {
        blocked: true,
        kind: "river",
        sourceId: "70591949",
        sourceName: null,
        distanceM: 10,
        corridorRadiusM: 16.608,
        reason: "inside authoritative supporting-river corridor",
        resolution: "water-placement-surface-v1",
        releaseId: "world-packages-v1"
      }
    }],
    ["lake", {
      isLand: true,
      isSaltwater: false,
      insideMajorLake: true
    }],
    ["ocean", {
      isLand: false,
      isSaltwater: true,
      insideMajorLake: false
    }]
  ])("uses the normalized authoritative %s classification", async (_surface, result) => {
    const fetcher = vi.fn(async () => response({
      ...result,
      worldReleaseId: "world-packages-v1"
    }));
    const terrain = vi.fn();
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      terrain,
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 39.1, lon: -120.1 });
    await vi.advanceTimersByTimeAsync(120);
    expect(terrain).toHaveBeenLastCalledWith("water");
  });

  it("refreshes after meaningful movement or cache expiry", async () => {
    let now = 1_000;
    const fetcher = vi.fn(async () => response({
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false
    }));
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      vi.fn(),
      fetcher as typeof fetch,
      () => now
    );
    preview.setPosition({ lat: 35, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);
    preview.setPosition({ lat: 35.001, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);
    expect(fetcher).toHaveBeenCalledTimes(2);

    now += FLAG_PREVIEW_CACHE_TTL_MS + 1;
    preview.setPosition({ lat: 35.001, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("ignores an older response after the player moves", async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetcher = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(response({ isLand: true, isSaltwater: false, insideMajorLake: false }));
    const terrain = vi.fn();
    const preview = new FlagPlacementPreviewTerrain("http://server.test", terrain, fetcher as typeof fetch);

    preview.setPosition({ lat: 35, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);
    preview.setPosition({ lat: 35.001, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);
    resolveFirst(response({ isLand: false, isSaltwater: true }));
    await Promise.resolve();

    expect(terrain).toHaveBeenLastCalledWith("land");
  });

  it("invalidates the exact-point cache when the authoritative release changes", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        isLand: true,
        isSaltwater: false,
        insideMajorLake: false,
        worldReleaseId: "release-a"
      }))
      .mockResolvedValueOnce(response({
        isLand: false,
        isSaltwater: true,
        worldReleaseId: "release-b"
      }));
    const terrain = vi.fn();
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      terrain,
      fetcher as typeof fetch
    );
    preview.setPosition({ lat: 35, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);

    preview.setWorldReleaseId("release-a");
    expect(fetcher).toHaveBeenCalledOnce();
    preview.setWorldReleaseId("release-b");
    expect(terrain).toHaveBeenLastCalledWith("unknown");
    await vi.advanceTimersByTimeAsync(120);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(terrain).toHaveBeenLastCalledWith("water");
  });

  it("refreshes an unchanged position after claimed territory is removed", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        outcome: "PLACEMENT_BLOCKED",
        placementQuote: undefined,
        placementFailure: {
          code: "FLAG_PLACEMENT_BLOCKED",
          message: "Cannot build here: inside your claimed territory",
          retryable: false
        }
      }))
      .mockResolvedValueOnce(response({
        isLand: true,
        isSaltwater: false,
        insideMajorLake: false
      }));
    const terrain = vi.fn();
    const preview = new FlagPlacementPreviewTerrain(
      "http://server.test",
      terrain,
      fetcher as typeof fetch
    );

    preview.setPosition({ lat: 35, lon: -106 });
    await vi.advanceTimersByTimeAsync(120);
    expect(terrain).toHaveBeenLastCalledWith("unknown");

    preview.invalidateCurrentPosition();
    expect(terrain).toHaveBeenLastCalledWith("unknown");
    await vi.advanceTimersByTimeAsync(120);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(terrain).toHaveBeenLastCalledWith("land");
  });
});

function response(body: unknown): Response {
  const record = body as Record<string, unknown>;
  return {
    ok: true,
    json: async () => ({
      outcome: "QUOTE_READY",
      authoritativePosition: { lat: 35, lon: -106 },
      placementQuote: {
        quoteId: "default-quote",
        expiresAt: Date.now() + 60_000
      },
      ...record
    })
  } as Response;
}
