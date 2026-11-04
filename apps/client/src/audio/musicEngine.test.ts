import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SOUND_SETTINGS } from "./soundSettings.js";
import { COMBAT_DUCK_GAIN, FADE_SECONDS, MusicEngine, resolveLoopPoints, type TrackManifest } from "./musicEngine.js";

class FakeParam {
  value: number;
  constructor(value = 1) { this.value = value; }
  cancelScheduledValues(): void { /* no-op */ }
  setValueAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; }
}
class FakeNode {
  gain = new FakeParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  startedWith: number[] | null = null;
  start = vi.fn((...args: number[]) => { this.startedWith = args; });
  stop = vi.fn();
  addEventListener = vi.fn();
}
class FakeContext {
  state: "suspended" | "running" = "suspended";
  currentTime = 0;
  destination = new FakeNode();
  allSources: FakeSource[] = [];
  /** Real sources only: the one-sample silent unlock buffer is not a track. */
  get sources(): FakeSource[] { return this.allSources.filter((source) => !(source.buffer as { silent?: boolean } | null)?.silent); }
  sampleRate = 44100;
  baseLatency = 0.01;
  createBuffer(): { silent: boolean } { return { silent: true }; }
  onstatechange: (() => void) | null = null;
  createGain(): FakeNode { return new FakeNode(); }
  createBufferSource(): FakeSource { const s = new FakeSource(); this.allSources.push(s); return s; }
  resume = vi.fn(async () => { this.state = "running"; });
  suspend = vi.fn(async () => { this.state = "suspended"; });
}

const manifest: TrackManifest = {
  dir: "assets/audio/music/",
  formats: {
    m4a: { loop: "loop.m4a", loopStartSec: 0, loopEndSec: 50, intro: "intro.m4a", introLoopAtSec: 4 }
  }
};

function setup(autoplay = false) {
  const ctx = new FakeContext();
  const createContext = vi.fn(() => ctx as unknown as AudioContext);
  const loadBuffer = vi.fn(async (_c: AudioContext, url: string) => ({ duration: url.includes("intro") ? 8 : 50, length: 50 * 44100, sampleRate: 44100 }) as unknown as AudioBuffer);
  const engine = new MusicEngine(manifest, { createContext, loadBuffer, baseUrl: "/", autoplay });
  engine.setSettings({ ...DEFAULT_SOUND_SETTINGS, master: 80 });
  return { ctx, engine, createContext, loadBuffer };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

describe("music engine diagnostics and unlock", () => {
  it("unlocks with a silent buffer inside the gesture and reports the whole picture once per session", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, engine } = setup();
      const reports: Array<{ kind: string; report: Record<string, unknown> }> = [];
      engine.setReporter((kind, report) => reports.push({ kind, report }), () => ({ native: true }));
      engine.unlock("touchend");
      expect(ctx.allSources.some((source) => (source.buffer as { silent?: boolean } | null)?.silent && source.start.mock.calls.length > 0)).toBe(true);
      await vi.advanceTimersByTimeAsync(10_100);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ kind: "session", report: { unlockEvent: "touchend", ctxState: "running", native: true, overworld: true, musicOn: true, loaded: true, playing: true, loopPoints: "trimmed" } });
      expect(reports[0]!.report.gainMaster).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reports).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a load failure as an error with the failure text", async () => {
    const { engine, loadBuffer } = setup();
    loadBuffer.mockRejectedValueOnce(new Error("audio 404"));
    const reports: Array<{ kind: string; report: Record<string, unknown> }> = [];
    engine.setReporter((kind, report) => reports.push({ kind, report }));
    engine.unlock("click");
    await flush();
    expect(reports[0]).toMatchObject({ kind: "error", report: { loadFailed: "audio 404" } });
  });

  it("sends one compact session report per launch, after the music starts", async () => {
    vi.useFakeTimers();
    try {
      const { engine } = setup();
      const reports: Array<{ kind: string; report: Record<string, unknown> }> = [];
      engine.setReporter((kind, report) => reports.push({ kind, report }));
      engine.preload();
      engine.unlock("touchend");
      await vi.advanceTimersByTimeAsync(3_100);
      expect(reports).toHaveLength(1);
      expect(reports[0]!.report).toMatchObject({ autoplayWorked: false, playing: true });
      expect(reports[0]!.report.bootToPlayMs).toEqual(expect.any(Number));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(reports).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("music engine boot and autoplay", () => {
  it("web: preloads the files at boot without trying to resume, then the first gesture starts it instantly", async () => {
    const { ctx, engine, createContext, loadBuffer } = setup(false);
    engine.preload();
    await flush();
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(loadBuffer).toHaveBeenCalledTimes(2);
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(engine.snapshot().playing).toBe(false);
    engine.unlock("touchend");
    await flush();
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(loadBuffer).toHaveBeenCalledTimes(2);
    expect(engine.snapshot().playing).toBe(true);
    expect(engine.buildReport().autoplayWorked).toBe(false);
  });

  it("native: resumes without a gesture and starts once the world is ready", async () => {
    const { ctx, engine } = setup(true);
    engine.setGameReady(false);
    engine.preload();
    await flush();
    expect(ctx.resume).toHaveBeenCalled();
    expect(ctx.state).toBe("running");
    expect(engine.snapshot().loaded).toBe(true);
    expect(engine.snapshot().playing).toBe(false);
    engine.setGameReady(true);
    expect(engine.snapshot().playing).toBe(true);
    expect(engine.buildReport()).toMatchObject({ autoplayWorked: true, autoplayTried: true });
    // A later tap must not start a second copy.
    engine.unlock("touchend");
    await flush();
    expect(engine.snapshot().startCount).toBe(1);
    expect(ctx.sources.filter((source) => source.loop)).toHaveLength(1);
  });

  it("native: when the WebView blocks the autoplay resume, the first tap starts the music once", async () => {
    const { ctx, engine } = setup(true);
    ctx.resume.mockImplementationOnce(async () => undefined);
    engine.preload();
    await flush();
    expect(ctx.state).toBe("suspended");
    expect(engine.snapshot().playing).toBe(false);
    engine.unlock("touchend");
    await flush();
    expect(engine.snapshot().playing).toBe(true);
    expect(engine.snapshot().startCount).toBe(1);
    expect(engine.buildReport().autoplayWorked).toBe(false);
  });

  it("does not start on the loading screens, only once the game is ready", async () => {
    const { engine } = setup(true);
    engine.setGameReady(false);
    engine.preload();
    await flush();
    expect(engine.snapshot().playing).toBe(false);
    engine.setGameReady(true);
    expect(engine.snapshot().playing).toBe(true);
  });
});

describe("music engine", () => {
  it("does nothing until the first gesture, then loads and loops gaplessly", async () => {
    const { ctx, engine, createContext, loadBuffer } = setup();
    engine.setOverworld(true);
    expect(createContext).not.toHaveBeenCalled();
    expect(loadBuffer).not.toHaveBeenCalled();
    engine.unlock();
    await flush();
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(ctx.resume).toHaveBeenCalled();
    expect(loadBuffer).toHaveBeenCalledWith(ctx, "/assets/audio/music/loop.m4a", expect.any(Function));
    const [loop] = ctx.sources;
    expect(loop?.loop).toBe(true);
    expect(loop?.loopStart).toBe(0);
    expect(loop?.loopEnd).toBe(50);
    expect(engine.snapshot().playing).toBe(true);
  });

  it("applies the volume math to the buses and ducks 40% in combat", async () => {
    const { engine } = setup();
    engine.unlock();
    await flush();
    engine.setSettings({ master: 50, music: 100, sfx: 20, musicOn: true });
    const s = engine.snapshot();
    expect(s.master).toBeCloseTo(0.25, 6);
    expect(s.music).toBeCloseTo(1, 6);
    expect(s.sfx).toBeCloseTo(0.04, 6);
    expect(s.duck).toBe(1);
    engine.setDucked(true);
    expect(engine.snapshot().duck).toBeCloseTo(COMBAT_DUCK_GAIN, 6);
    engine.setDucked(false);
    expect(engine.snapshot().duck).toBe(1);
  });

  it("stops when music is switched off or the player leaves the overworld, and restarts after", async () => {
    const { ctx, engine } = setup();
    engine.unlock();
    await flush();
    engine.setSettings({ ...DEFAULT_SOUND_SETTINGS, master: 80, musicOn: false });
    expect(engine.snapshot().playing).toBe(false);
    expect(ctx.sources[0]?.stop).toHaveBeenCalledWith(expect.closeTo(FADE_SECONDS + 0.05, 5));
    engine.setSettings({ ...DEFAULT_SOUND_SETTINGS, master: 80 });
    expect(engine.snapshot().playing).toBe(true);
    engine.setOverworld(false);
    expect(engine.snapshot().playing).toBe(false);
    expect(engine.snapshot().startCount).toBe(2);
  });

  it("fades out and suspends when hidden, and resumes on return", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, engine } = setup();
      engine.unlock();
      await flush();
      expect(engine.snapshot().track).toBe(1);
      engine.setHidden(true);
      expect(engine.snapshot().track).toBe(0);
      await vi.advanceTimersByTimeAsync(FADE_SECONDS * 1000 + 200);
      expect(ctx.suspend).toHaveBeenCalled();
      expect(ctx.state).toBe("suspended");
      engine.setHidden(false);
      await flush();
      expect(ctx.state).toBe("running");
      expect(engine.snapshot().track).toBe(1);
      expect(engine.snapshot().startCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("plays the intro once, starting the loop partway through it", async () => {
    const { ctx, engine } = setup();
    engine.unlock();
    await flush();
    expect(ctx.sources).toHaveLength(2);
    const [loop, intro] = ctx.sources;
    expect(intro?.startedWith?.[0]).toBeCloseTo(0.05, 6);
    expect(loop?.startedWith?.[0]).toBeCloseTo(4.05, 6);
    engine.setOverworld(false);
    engine.setOverworld(true);
    expect(ctx.sources).toHaveLength(3);
  });

  it("picks the untrimmed loop points when the decoder kept the AAC priming", () => {
    const format = { loop: "a", loopStartSec: 0, loopEndSec: 53.79, untrimmed: { decodedSamples: 2373632, loopStartSec: 0.0232, loopEndSec: 53.8163 } };
    expect(resolveLoopPoints(format, { length: 2372608, sampleRate: 44100 })).toEqual({ start: 0, end: 53.79 });
    expect(resolveLoopPoints(format, { length: 2373632, sampleRate: 44100 })).toEqual({ start: 0.0232, end: 53.8163 });
  });
});
