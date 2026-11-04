import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultLoadBuffer, type ReportValue } from "./musicEngine.js";

const decoded = { duration: 5, length: 10, sampleRate: 44100 } as unknown as AudioBuffer;
const ctx = { decodeAudioData: (_b: ArrayBuffer, ok: (b: AudioBuffer) => void) => ok(decoded) } as unknown as AudioContext;
const body = (): ArrayBuffer => new ArrayBuffer(4096);
const response = (status: number, ok: boolean): Response =>
  ({ status, ok, type: "basic", headers: new Headers(), arrayBuffer: async () => body() }) as unknown as Response;

afterEach(() => { vi.unstubAllGlobals(); });

describe("defaultLoadBuffer fallbacks", () => {
  it("accepts a status 0 response that carries a body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(0, false)));
    const notes: Record<string, ReportValue> = {};
    await expect(defaultLoadBuffer(ctx, "/a.m4a", (k, v) => { notes[k] = v; })).resolves.toBe(decoded);
    expect(notes.via).toBe("fetch");
  });

  it("falls back to the web origin and records every failed attempt", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://web/play/a.m4a") return response(200, true);
      throw new TypeError("Load failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    class FailingXhr { responseType = ""; onload: (() => void) | null = null; onerror: (() => void) | null = null; open(): void { /* no-op */ } send(): void { this.onerror?.(); } }
    vi.stubGlobal("XMLHttpRequest", FailingXhr);
    const notes: Record<string, ReportValue> = {};
    await expect(defaultLoadBuffer(ctx, "/a.m4a", (k, v) => { notes[k] = v; }, "https://web/play/a.m4a")).resolves.toBe(decoded);
    expect(notes.via).toBe("web");
    expect(notes.err_fetch).toBe("Load failed");
    expect(notes.err_xhr).toBe("xhr network error");
  });

  it("throws the last error when every attempt fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Load failed"); }));
    await expect(defaultLoadBuffer(ctx, "/a.m4a")).rejects.toThrow();
  });
});
