import { busGains, type SoundSettings, DEFAULT_SOUND_SETTINGS } from "./soundSettings.js";

/**
 * Web Audio music engine: one decoded buffer played through an AudioBufferSourceNode with loop=true and
 * sample-accurate loopStart/loopEnd (HTMLAudio loops leave a gap on iOS). Graph:
 *
 *   loop source -> trackGain (start/stop/pause fade) -> musicBus (music volume) -> duckGain (combat) -> master -> output
 *   sfx sources -> sfxBus (sound-effect volume) -> master
 *
 * Nothing runs per frame: every change is an AudioParam ramp scheduled once.
 */

export type TrackFormat = Readonly<{
  loop: string;
  loopStartSec: number;
  loopEndSec: number;
  /** Loop points to use when the decoder kept the AAC priming (the decoded buffer has this many samples at 44.1 kHz). */
  untrimmed?: Readonly<{ decodedSamples: number; loopStartSec: number; loopEndSec: number }>;
  intro?: string;
  /** Where in the intro the loop begins; the intro rings out underneath it. Default: the intro's end. */
  introLoopAtSec?: number;
}>;

/** The loop points that match how this decoder handled the file (compares the decoded length, at 44.1 kHz). */
export function resolveLoopPoints(format: TrackFormat, buffer: Pick<AudioBuffer, "length" | "sampleRate">): { start: number; end: number } {
  const samples441 = (buffer.length * 44100) / buffer.sampleRate;
  const alt = format.untrimmed;
  if (alt && Math.abs(samples441 - alt.decodedSamples) < 256) return { start: alt.loopStartSec, end: alt.loopEndSec };
  return { start: format.loopStartSec, end: format.loopEndSec };
}
/** One AAC .m4a track: every supported WebView and browser decodes it. */
export type TrackManifest = Readonly<{ dir: string; formats: Readonly<{ m4a: TrackFormat }> }>;

export const FADE_SECONDS = 1.5;
/** Slider changes ramp briefly (just enough to avoid clicks), so dragging a slider follows the thumb. */
export const VOLUME_RAMP_SECONDS = 0.25;
export const DUCK_FADE_SECONDS = 0.8;
/** Music is lowered by 40% while the player is in combat. */
export const COMBAT_DUCK_GAIN = 0.6;

export type EngineDeps = Readonly<{
  createContext: () => AudioContext;
  loadBuffer: (ctx: AudioContext, url: string, note?: (key: string, value: ReportValue) => void) => Promise<AudioBuffer>;
  baseUrl: string;
  /** True where the WebView lets audio start without a gesture (the native app): the engine then tries at boot. */
  autoplay?: boolean;
}>;

export type ReportValue = string | number | boolean | null;
export type AudioReportKind = "session" | "error";
export type AudioReporter = (kind: AudioReportKind, report: Record<string, ReportValue>) => void;

/** One compact report per launch: this long after music starts, or (if it never starts) after boot. */
export const SESSION_REPORT_AFTER_PLAY_MS = 3_000;
export const SESSION_REPORT_GIVE_UP_MS = 25_000;
const MAX_ERROR_REPORTS = 4;

export type MusicStats = {
  ctxState: string;
  format: string | null;
  loaded: boolean;
  playing: boolean;
  introPlayed: boolean;
  startCount: number;
  stopCount: number;
  master: number;
  music: number;
  sfx: number;
  duck: number;
  track: number;
};

type Note = (key: string, value: ReportValue) => void;
const errText = (error: unknown): string => String((error as { message?: string } | null)?.message ?? error).slice(0, 160);

async function bytesViaFetch(url: string, note: Note, tag: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  const bytes = await response.arrayBuffer();
  note(`try_${tag}`, `${response.status} ${response.type} ok=${response.ok} bytes=${bytes.byteLength} ct=${response.headers.get("content-type") ?? ""}`);
  note("fetchStatus", response.status);
  note("contentType", (response.headers.get("content-type") ?? "").slice(0, 60));
  // WKWebView reports status 0 for some custom-scheme responses that did deliver a body.
  if (!response.ok && !(response.status === 0 && bytes.byteLength > 1024)) throw new Error(`audio ${response.status}`);
  return bytes;
}

function bytesViaXhr(url: string, note: Note, tag: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      const bytes = xhr.response as ArrayBuffer | null;
      note(`try_${tag}`, `${xhr.status} bytes=${bytes?.byteLength ?? -1}`);
      if (bytes && bytes.byteLength > 1024 && (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300))) resolve(bytes);
      else reject(new Error(`xhr ${xhr.status}`));
    };
    xhr.onerror = () => { note(`try_${tag}`, "network error"); reject(new Error("xhr network error")); };
    xhr.send();
  });
}

/**
 * Loads and decodes one track. The bundled file is tried with fetch, then XMLHttpRequest (WKWebView custom schemes can
 * fail fetch), then `webUrl` (the same file on the live web origin) when given. Every attempt is noted for the report.
 */
export async function defaultLoadBuffer(ctx: AudioContext, url: string, note: Note = () => undefined, webUrl?: string): Promise<AudioBuffer> {
  const started = performance.now();
  const attempts: Array<[string, () => Promise<ArrayBuffer>]> = [
    ["fetch", () => bytesViaFetch(url, note, "fetch")],
    ["xhr", () => bytesViaXhr(url, note, "xhr")],
    ...(webUrl ? [["web", () => bytesViaFetch(webUrl, note, "web")] as [string, () => Promise<ArrayBuffer>]] : [])
  ];
  note("url", url);
  let lastError: unknown = new Error("no attempt");
  for (const [tag, get] of attempts) {
    try {
      const bytes = await get();
      note("bytes", bytes.byteLength);
      note("fetchMs", Math.round(performance.now() - started));
      const decodeStarted = performance.now();
      // Callback form: older WebKit has no promise form of decodeAudioData.
      const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
        ctx.decodeAudioData(bytes, resolve, (error) => reject(error instanceof Error ? error : new Error(errText(error))));
      });
      note("decode", "ok");
      note("via", tag);
      note("decodeMs", Math.round(performance.now() - decodeStarted));
      note("duration", Math.round(buffer.duration * 1000) / 1000);
      note("length", buffer.length);
      note("bufferRate", buffer.sampleRate);
      return buffer;
    } catch (error) {
      lastError = error;
      note(`err_${tag}`, errText(error));
      note("loadError", errText(error));
    }
  }
  throw lastError;
}

/** iPhone, iPad and iPadOS-as-Mac WebKit: gesture rules are strict and window blur/focus events are unreliable. */
export function isIosWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iP(?:hone|ad|od)/u.test(navigator.userAgent) || (/Macintosh/u.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function defaultCreateContext(): AudioContext {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio is not available");
  // iOS runs the hardware at its own rate and a forced sampleRate can leave the context silent there, so iOS takes the
  // default rate (the loop points are chosen by decoded length, not by rate).
  if (isIosWebKit()) return new Ctor();
  try {
    // 44.1 kHz matches the files, so decoding does not resample and the loop points stay sample-exact.
    return new Ctor({ latencyHint: "playback", sampleRate: 44100 });
  } catch {
    return new Ctor({ latencyHint: "playback" });
  }
}

type Track = { gain: GainNode; sources: AudioBufferSourceNode[] };

export class MusicEngine {
  readonly stats: MusicStats = {
    ctxState: "none", format: null, loaded: false, playing: false, introPlayed: false,
    startCount: 0, stopCount: 0, master: 0, music: 0, sfx: 0, duck: 1, track: 0
  };

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private duckGain: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private loopBuffer: AudioBuffer | null = null;
  private introBuffer: AudioBuffer | null = null;
  private format: TrackFormat | null = null;
  private loading = false;
  private track: Track | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;

  private unlocked = false;
  private reporter: AudioReporter | null = null;
  private readonly diag: Record<string, ReportValue> = {};
  private gameReady = true;
  private everRunning = false;
  private sessionSent = false;
  private errorReports = 0;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private extras: () => Record<string, ReportValue> = () => ({});
  private overworld = true;
  private hidden = false;
  private ducked = false;
  private settings: SoundSettings = DEFAULT_SOUND_SETTINGS;

  constructor(private readonly manifest: TrackManifest, private readonly deps: EngineDeps) {}

  /** Where the one-per-session report (and error reports) go; `extras` adds wiring-level facts (hidden flags, platform). */
  setReporter(reporter: AudioReporter | null, extras: () => Record<string, ReportValue> = () => ({})): void {
    this.reporter = reporter;
    this.extras = extras;
  }

  /** Everything the engine knows, flat and bounded, for the server log. */
  buildReport(): Record<string, ReportValue> {
    this.syncStats();
    const ctx = this.ctx;
    const s = this.stats;
    return {
      ...this.diag,
      ctxState: s.ctxState,
      ctxSampleRate: ctx?.sampleRate ?? null,
      autoplayWorked: this.diag.autoplayWorked === true,
      unlocked: this.unlocked,
      overworld: this.overworld,
      hidden: this.hidden,
      gameReady: this.gameReady,
      ducked: this.ducked,
      musicOn: this.settings.musicOn,
      loaded: s.loaded,
      playing: s.playing,
      startCount: s.startCount,
      gainMaster: Math.round(s.master * 1000) / 1000,
      gainMusic: Math.round(s.music * 1000) / 1000,
      gainDuck: Math.round(s.duck * 1000) / 1000,
      gainTrack: Math.round(s.track * 1000) / 1000,
      nowMs: Math.round(performance.now()),
      ...this.extras()
    };
  }

  private emit(kind: AudioReportKind): void {
    if (!this.reporter) return;
    if (kind === "error") {
      if (this.errorReports >= MAX_ERROR_REPORTS) return;
      this.errorReports += 1;
    }
    try { this.reporter(kind, this.buildReport()); } catch { /* Diagnostics must never break audio. */ }
  }

  private noteError(key: string, error: unknown): void {
    this.diag[key] = String((error as { message?: string } | null)?.message ?? error).slice(0, 160);
    this.emit("error");
  }

  /**
   * Boot: create the context and start fetching/decoding now, so the first tap (web) or the world appearing (native)
   * starts the music instantly. Where the WebView allows it (deps.autoplay), also try to resume without a gesture.
   */
  preload(): void {
    if (this.ctx) return;
    if (!this.createContextNow()) return;
    this.diag.autoplayTried = this.deps.autoplay === true;
    this.resumeContext(this.deps.autoplay === true);
    this.reconcile();
    if (this.reporter) this.scheduleSessionReport(SESSION_REPORT_GIVE_UP_MS);
  }

  private createContextNow(): boolean {
    try {
      this.ctx = this.deps.createContext();
    } catch (error) {
      this.noteError("createContextError", error);
      return false;
    }
    this.buildGraph(this.ctx);
    this.ctx.onstatechange = () => {
      this.diag.lastStateChange = this.ctx?.state ?? "none";
      if (this.ctx?.state === "running") this.everRunning = true;
      this.reconcile();
    };
    return true;
  }

  private scheduleSessionReport(ms: number): void {
    if (this.sessionSent) return;
    if (this.sessionTimer !== null) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      if (this.sessionSent) return;
      this.sessionSent = true;
      this.emit("session");
    }, ms);
  }

  /** The game is on screen (the loading and sign-in screens are done): music may start. Latches on. */
  setGameReady(ready: boolean): void {
    if (this.gameReady === ready) return;
    this.gameReady = ready;
    if (ready) this.resumeContext(this.deps.autoplay === true);
    this.reconcile();
  }

  /** A real user gesture (touchend, click, keydown): resumes the context inside the gesture, the fallback when autoplay is blocked. */
  unlock(eventType = "unknown"): void {
    if (!this.ctx && !this.createContextNow()) return;
    if (!this.unlocked) {
      this.unlocked = true;
      this.diag.unlockEvent = eventType;
      this.diag.unlockAtMs = Math.round(performance.now());
    }
    this.diag.lastGestureEvent = eventType;
    this.resumeContext(true);
    this.reconcile();
  }

  /** Any later gesture: iOS can leave the context suspended or interrupted (a call, the lock screen). */
  nudge(): void {
    if (!this.hidden) this.resumeContext();
  }

  setSettings(settings: SoundSettings): void {
    this.settings = settings;
    this.applyBusGains();
    this.reconcile();
  }

  /** True while the player is on the overworld (not in an interior or dungeon). */
  setOverworld(overworld: boolean): void {
    if (this.overworld === overworld) return;
    this.overworld = overworld;
    this.reconcile();
  }

  /** True while the tab is hidden, the window lost focus or the native app is inactive. */
  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.reconcile();
  }

  /** Combat ducks the music; ending combat brings it back. */
  setDucked(ducked: boolean): void {
    if (this.ducked === ducked) return;
    this.ducked = ducked;
    this.applyBusGains();
  }

  /** The running context and the sfx bus, for procedural sound effects (null until audio is unlocked). */
  sfxTarget(): Readonly<{ ctx: AudioContext; bus: AudioNode }> | null {
    return this.ctx && this.sfxBus && this.ctx.state === "running" ? { ctx: this.ctx, bus: this.sfxBus } : null;
  }

  /** Plays a decoded sound effect through the sfx bus (no sounds ship yet; combat cues route here later). */
  playSfx(buffer: AudioBuffer, gain = 1): void {
    if (!this.ctx || !this.sfxBus || this.ctx.state !== "running") return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const level = this.ctx.createGain();
    level.gain.value = gain;
    source.connect(level);
    level.connect(this.sfxBus);
    source.onended = () => { source.disconnect(); level.disconnect(); };
    source.start();
  }

  private buildGraph(ctx: AudioContext): void {
    this.master = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.duckGain = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus.connect(this.duckGain);
    this.duckGain.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(ctx.destination);
    const gains = busGains(this.settings);
    this.master.gain.value = gains.master;
    this.musicBus.gain.value = gains.music;
    this.sfxBus.gain.value = gains.sfx;
    this.duckGain.gain.value = this.ducked ? COMBAT_DUCK_GAIN : 1;
    this.syncStats();
  }

  private resumeContext(force = false): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
    // Before any gesture, only the boot-time autoplay attempt may resume (browsers would just log a warning).
    if (!force && !this.unlocked && !this.everRunning) return;
    // The classic iOS unlock: a one-sample silent buffer started inside the gesture, alongside resume().
    try {
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, 1, 22050);
      silent.connect(ctx.destination);
      silent.start(0);
      this.diag.silentUnlock = true;
    } catch (error) {
      this.diag.silentUnlock = `err:${String(error).slice(0, 80)}`;
    }
    this.diag.resumeCalls = (typeof this.diag.resumeCalls === "number" ? this.diag.resumeCalls : 0) + 1;
    void ctx.resume().then(() => {
      this.diag.resume = `ok:${ctx.state}`;
      if (ctx.state === "running") this.everRunning = true;
      this.reconcile();
    }, (error: unknown) => { this.noteError("resumeError", error); });
  }

  private fade(param: AudioParam, value: number, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + seconds);
  }

  private applyBusGains(): void {
    if (!this.ctx || !this.master || !this.musicBus || !this.sfxBus || !this.duckGain) return;
    const gains = busGains(this.settings);
    this.fade(this.master.gain, gains.master, VOLUME_RAMP_SECONDS);
    this.fade(this.musicBus.gain, gains.music, VOLUME_RAMP_SECONDS);
    this.fade(this.sfxBus.gain, gains.sfx, VOLUME_RAMP_SECONDS);
    this.fade(this.duckGain.gain, this.ducked ? COMBAT_DUCK_GAIN : 1, DUCK_FADE_SECONDS);
    this.syncStats();
  }

  /** Decides from the wanted flags whether a track should exist and be audible, and moves toward it. */
  private reconcile(): void {
    if (!this.ctx) return;
    const shouldRun = this.settings.musicOn && this.overworld && this.gameReady;
    // Fetch and decode as soon as music is wanted at all, so starting later is instant.
    if (this.settings.musicOn && !this.loopBuffer) void this.load();
    if (shouldRun && this.loopBuffer && !this.track && this.ctx.state === "running") {
      this.startTrack();
    } else if (!shouldRun && this.track) {
      this.stopTrack();
    }
    this.applyPause(shouldRun);
    this.syncStats();
  }

  private applyPause(shouldRun: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.suspendTimer !== null) { clearTimeout(this.suspendTimer); this.suspendTimer = null; }
    if (this.hidden) {
      if (this.track && shouldRun) this.fade(this.track.gain.gain, 0, FADE_SECONDS);
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        if (this.hidden && this.ctx?.state === "running") void this.ctx.suspend().then(() => this.syncStats(), () => undefined);
      }, FADE_SECONDS * 1000 + 100);
      return;
    }
    this.resumeContext();
    if (this.track && shouldRun) this.fade(this.track.gain.gain, 1, FADE_SECONDS);
  }

  private async load(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this.loading || this.loopBuffer) return;
    this.loading = true;
    try {
      const format = this.manifest.formats.m4a;
      this.stats.format = "m4a";
      const url = (name: string): string => `${this.deps.baseUrl}${this.manifest.dir}${name}`;
      const note = (label: string) => (key: string, value: ReportValue): void => { this.diag[`${label}_${key}`] = value; };
      this.diag.loopUrl = url(format.loop);
      const [loop, intro] = await Promise.all([
        this.deps.loadBuffer(ctx, url(format.loop), note("loop")),
        format.intro ? this.deps.loadBuffer(ctx, url(format.intro), note("intro")).catch(() => null) : Promise.resolve(null)
      ]);
      this.format = format;
      this.loopBuffer = loop;
      this.introBuffer = intro;
      this.stats.loaded = true;
    } catch (error) {
      // Music is a nicety: a failed download or decode just leaves the game quiet.
      console.warn("Music could not be loaded", error);
      this.noteError("loadFailed", error);
    } finally {
      this.loading = false;
    }
    if (this.loopBuffer) this.reconcile();
  }

  private startTrack(): void {
    const ctx = this.ctx;
    const buffer = this.loopBuffer;
    const format = this.format;
    if (!ctx || !buffer || !format || !this.musicBus) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.musicBus);
    const sources: AudioBufferSourceNode[] = [];
    const t0 = ctx.currentTime + 0.05;
    const loop = ctx.createBufferSource();
    loop.buffer = buffer;
    loop.loop = true;
    const points = resolveLoopPoints(format, buffer);
    loop.loopStart = points.start;
    loop.loopEnd = Math.min(points.end, buffer.duration);
    this.diag.loopStart = Math.round(loop.loopStart * 1000) / 1000;
    this.diag.loopEnd = Math.round(loop.loopEnd * 1000) / 1000;
    this.diag.loopPoints = points.end === format.loopEndSec ? "trimmed" : "untrimmed";
    loop.connect(gain);
    sources.push(loop);
    if (this.introBuffer && !this.stats.introPlayed) {
      // The intro plays once; the loop is scheduled to begin exactly where it ends, at the loop start.
      const intro = ctx.createBufferSource();
      intro.buffer = this.introBuffer;
      intro.connect(gain);
      intro.start(t0);
      sources.push(intro);
      loop.start(t0 + (format.introLoopAtSec ?? this.introBuffer.duration), points.start);
      this.stats.introPlayed = true;
    } else {
      loop.start(t0, this.stats.startCount === 0 ? 0 : points.start);
    }
    this.track = { gain, sources };
    this.stats.startCount += 1;
    if (this.stats.startCount === 1) {
      this.diag.bootToPlayMs = Math.round(performance.now());
      // Playing before any gesture means the WebView let audio start on its own.
      this.diag.autoplayWorked = !this.unlocked;
      this.scheduleSessionReport(SESSION_REPORT_AFTER_PLAY_MS);
    }
    if (!this.hidden) this.fade(gain.gain, 1, FADE_SECONDS);
  }

  private stopTrack(): void {
    const ctx = this.ctx;
    const track = this.track;
    if (!ctx || !track) return;
    this.track = null;
    this.stats.stopCount += 1;
    this.fade(track.gain.gain, 0, FADE_SECONDS);
    const end = ctx.currentTime + FADE_SECONDS + 0.05;
    for (const source of track.sources) {
      try { source.stop(end); } catch { /* Already stopped. */ }
    }
    track.sources[0]?.addEventListener("ended", () => {
      for (const source of track.sources) source.disconnect();
      track.gain.disconnect();
    });
  }

  private syncStats(): void {
    const s = this.stats;
    s.ctxState = this.ctx?.state ?? "none";
    s.playing = this.track !== null;
    s.master = this.master?.gain.value ?? 0;
    s.music = this.musicBus?.gain.value ?? 0;
    s.sfx = this.sfxBus?.gain.value ?? 0;
    s.duck = this.duckGain?.gain.value ?? 1;
    s.track = this.track?.gain.gain.value ?? 0;
  }

  /** Live gain readouts for tests and the probe. */
  snapshot(): MusicStats {
    this.syncStats();
    return { ...this.stats };
  }
}
