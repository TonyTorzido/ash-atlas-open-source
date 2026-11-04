// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { perfMetrics } from "./perfMetrics.js";
import { buildPerfSample, configurePerfUpload, startPerfUpload, stopPerfUpload } from "./perfUpload.js";
import { setPerfProbeEnabled } from "./perfProbe.js";

afterEach(() => {
  stopPerfUpload();
  setPerfProbeEnabled(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("perf upload", () => {
  it("builds a compact sample with network signals", () => {
    perfMetrics.noteRtt(42);
    perfMetrics.noteServerDelta("combat");
    const sample = buildPerfSample();
    expect(sample).toMatchObject({ rttMs: 42, legacyRenderQuality: false });
    expect(sample).toHaveProperty("rendersPerFrame");
    expect(sample).toHaveProperty("combatDeltaGapP95Ms");
    expect(JSON.stringify(sample).length).toBeLessThan(1200);
  });

  it("posts every 10 s only while the probe is on, and backs off instead of stopping on 403", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    configurePerfUpload("http://127.0.0.1:3001", "csrf");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
    setPerfProbeEnabled(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/api/diagnostics/perf-sample");
    expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf");
    setPerfProbeEnabled(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockImplementation(async () => ({ status: 403 }) as Response);
    startPerfUpload();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Backoff: 20 s after the first failure, then it keeps retrying.
    await vi.advanceTimersByTimeAsync(19_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetchMock.mockImplementation(async () => ({ status: 200 }) as Response);
    await vi.advanceTimersByTimeAsync(40_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(6);
  });
});
