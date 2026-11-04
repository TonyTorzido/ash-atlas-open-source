/**
 * Procedural sound for the Tilted Vault (WebAudio, no asset files). Everything
 * routes through the game's sfx bus (gameAudio), so the Sound settings master
 * and effects sliders apply and nothing plays before audio is unlocked. Every
 * call is best effort and silent when audio is not running.
 */
import { gameAudio } from "../../audio/gameAudio.js";

type Target = Readonly<{ ctx: AudioContext; bus: AudioNode }>;

const target = (): Target | null => gameAudio()?.sfxTarget() ?? null;

let noiseWhite: AudioBuffer | null = null;
let noiseBrown: AudioBuffer | null = null;
const lastPlayed = new Map<string, number>();

const noiseBuffer = (ctx: AudioContext, brown: boolean): AudioBuffer => {
  const cached = brown ? noiseBrown : noiseWhite;
  if (cached && cached.sampleRate === ctx.sampleRate) return cached;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i += 1) {
    const white = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * white) / 1.02; data[i] = last * 3.5; } else data[i] = white;
  }
  if (brown) noiseBrown = buffer; else noiseWhite = buffer;
  return buffer;
};

/** Skip a repeat of the same cue inside `gapMs` so a rattling marble never machine-guns. */
const throttled = (key: string, gapMs: number): boolean => {
  const now = performance.now();
  if (now - (lastPlayed.get(key) ?? -1e9) < gapMs) return true;
  lastPlayed.set(key, now);
  return false;
};

const envelope = (t: Target, gain: number, start: number, attack: number, decay: number): GainNode => {
  const g = t.ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
  g.connect(t.bus);
  return g;
};

const tone = (
  t: Target, freq: number, gain: number, decay: number,
  opts: Readonly<{ type?: OscillatorType; slideTo?: number; attack?: number; delay?: number }> = {}
): void => {
  const start = t.ctx.currentTime + (opts.delay ?? 0);
  const osc = t.ctx.createOscillator();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(freq, start);
  if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, start + decay);
  const env = envelope(t, gain, start, opts.attack ?? 0.004, decay);
  osc.connect(env);
  osc.start(start);
  osc.stop(start + (opts.attack ?? 0.004) + decay + 0.05);
  osc.onended = () => { osc.disconnect(); env.disconnect(); };
};

const noise = (
  t: Target, gain: number, decay: number,
  opts: Readonly<{ filter?: BiquadFilterType; freq?: number; endFreq?: number; q?: number; delay?: number; attack?: number; brown?: boolean }> = {}
): void => {
  const start = t.ctx.currentTime + (opts.delay ?? 0);
  const src = t.ctx.createBufferSource();
  src.buffer = noiseBuffer(t.ctx, opts.brown === true);
  const filter = t.ctx.createBiquadFilter();
  filter.type = opts.filter ?? "lowpass";
  filter.frequency.setValueAtTime(opts.freq ?? 1500, start);
  if (opts.endFreq) filter.frequency.exponentialRampToValueAtTime(opts.endFreq, start + decay);
  filter.Q.value = opts.q ?? 0.7;
  const env = envelope(t, gain, start, opts.attack ?? 0.003, decay);
  src.connect(filter);
  filter.connect(env);
  src.start(start, Math.random() * 1.5);
  src.stop(start + (opts.attack ?? 0.003) + decay + 0.05);
  src.onended = () => { src.disconnect(); filter.disconnect(); env.disconnect(); };
};

/** A looping noise bed whose level and brightness are driven from outside. */
class Loop {
  private src: AudioBufferSourceNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;
  private extra: OscillatorNode | null = null;
  private extraGain: GainNode | null = null;
  private lfo: OscillatorNode | null = null;
  private ctx: AudioContext | null = null;

  constructor(
    private readonly kind: "roll" | "grind" | "ambience"
  ) {}

  private build(t: Target): void {
    const ctx = t.ctx;
    this.ctx = ctx;
    const brown = this.kind !== "roll";
    this.src = ctx.createBufferSource();
    this.src.buffer = noiseBuffer(ctx, brown);
    this.src.loop = true;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = this.kind === "roll" ? "bandpass" : "lowpass";
    this.filter.frequency.value = this.kind === "roll" ? 260 : this.kind === "grind" ? 420 : 210;
    this.filter.Q.value = this.kind === "roll" ? 0.9 : 0.6;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.src.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(t.bus);
    this.src.start(0, Math.random());
    if (this.kind === "grind") {
      // A low stone growl under the noise.
      this.extra = ctx.createOscillator();
      this.extra.type = "sawtooth";
      this.extra.frequency.value = 46;
      this.extraGain = ctx.createGain();
      this.extraGain.gain.value = 0.35;
      this.lfo = ctx.createOscillator();
      this.lfo.frequency.value = 2.3;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.25;
      this.lfo.connect(lfoGain);
      lfoGain.connect(this.extraGain.gain);
      this.extra.connect(this.extraGain);
      this.extraGain.connect(this.gain);
      this.extra.start();
      this.lfo.start();
    } else if (this.kind === "ambience") {
      this.lfo = ctx.createOscillator();
      this.lfo.frequency.value = 0.09;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 70;
      this.lfo.connect(lfoGain);
      lfoGain.connect(this.filter.frequency);
      this.lfo.start();
    }
  }

  /** Move to a level (0..1 of this loop's own scale) and brightness (Hz). Builds on first non-zero use. */
  set(level: number, freq?: number): void {
    const t = target();
    if (!t) { if (this.gain) this.dispose(); return; }
    if (this.ctx && this.ctx !== t.ctx) this.dispose();
    if (!this.gain) {
      if (level <= 0.0005) return;
      this.build(t);
    }
    const now = t.ctx.currentTime;
    this.gain!.gain.setTargetAtTime(level, now, 0.08);
    if (freq !== undefined && this.filter && this.kind !== "ambience") this.filter.frequency.setTargetAtTime(freq, now, 0.08);
  }

  dispose(): void {
    try { this.src?.stop(); this.extra?.stop(); this.lfo?.stop(); } catch { /* already stopped */ }
    for (const node of [this.src, this.filter, this.gain, this.extra, this.extraGain, this.lfo]) {
      try { node?.disconnect(); } catch { /* detached */ }
    }
    this.src = this.filter = this.gain = this.extra = this.extraGain = this.lfo = null;
    this.ctx = null;
  }
}

const rollLoop = new Loop("roll");
const grindLoop = new Loop("grind");
const ambienceLoop = new Loop("ambience");
let dripTimer = 6;

export const vaultSfx = {
  /** Wall or marble impact. `strength` is 0..1. */
  bump(strength: number): void {
    const t = target();
    if (!t || throttled("bump", 55)) return;
    const s = Math.min(1, Math.max(0, strength));
    noise(t, 0.05 + 0.3 * s, 0.05 + 0.06 * s, { filter: "lowpass", freq: 700 + 1900 * s, endFreq: 260 });
    tone(t, 150 - 40 * s, 0.07 + 0.3 * s, 0.09, { slideTo: 70 });
    if (s > 0.5) tone(t, 940, 0.025 * s, 0.05, { type: "triangle" });
  },

  /** Called each frame with the fastest marble's speed as 0..1 of max speed (0 when nothing rolls). */
  roll(speed01: number): void {
    const s = Math.min(1, Math.max(0, speed01));
    rollLoop.set(s < 0.04 ? 0 : 0.015 + 0.12 * s * s, 150 + 750 * s);
  },

  /** Turning floor grind; call every frame with whether the floor is turning. */
  grind(active: boolean): void { grindLoop.set(active ? 0.06 : 0, 380); },

  /** Quarry ambience bed plus the odd far-off drip. Call every frame with dt in seconds. */
  ambience(active: boolean, dt: number): void {
    ambienceLoop.set(active ? 0.075 : 0);
    if (!active) return;
    dripTimer -= dt;
    if (dripTimer > 0) return;
    dripTimer = 5 + Math.random() * 9;
    const t = target();
    if (t) tone(t, 1100 + Math.random() * 700, 0.018, 0.22, { slideTo: 700, attack: 0.002 });
  },

  stopLoops(): void { rollLoop.dispose(); grindLoop.dispose(); ambienceLoop.dispose(); },

  fall(): void {
    const t = target();
    if (!t) return;
    tone(t, 560, 0.16, 0.55, { slideTo: 110, type: "sine", attack: 0.02 });
    tone(t, 281, 0.07, 0.55, { slideTo: 60, type: "triangle", attack: 0.02 });
    noise(t, 0.06, 0.5, { filter: "bandpass", freq: 1400, endFreq: 240, q: 1.2, attack: 0.04 });
  },

  respawn(): void {
    const t = target();
    if (!t) return;
    tone(t, 392, 0.05, 0.5, { attack: 0.12, slideTo: 523 });
    tone(t, 784, 0.03, 0.45, { attack: 0.14, slideTo: 1046, type: "triangle" });
  },

  plate(pressed: boolean): void {
    const t = target();
    if (!t || throttled("plate", 120)) return;
    if (pressed) {
      noise(t, 0.2, 0.025, { filter: "highpass", freq: 2400 });
      tone(t, 210, 0.2, 0.12, { slideTo: 95 });
      tone(t, 660, 0.035, 0.25, { type: "triangle", delay: 0.02 });
    } else {
      noise(t, 0.1, 0.02, { filter: "highpass", freq: 3000 });
      tone(t, 150, 0.08, 0.08, { slideTo: 110 });
    }
  },

  crackStage(): void {
    const t = target();
    if (!t || throttled("crack", 90)) return;
    noise(t, 0.14, 0.03, { filter: "bandpass", freq: 3200, q: 2 });
    tone(t, 1900, 0.02, 0.03, { type: "square" });
  },

  crumble(): void {
    const t = target();
    if (!t) return;
    noise(t, 0.3, 0.5, { filter: "lowpass", freq: 1500, endFreq: 220, attack: 0.01 });
    noise(t, 0.12, 0.2, { filter: "bandpass", freq: 2600, q: 1.5, delay: 0.05 });
    tone(t, 90, 0.2, 0.35, { slideTo: 45, delay: 0.1 });
  },

  chip(): void {
    const t = target();
    if (!t || throttled("chip", 80)) return;
    noise(t, 0.2, 0.07, { filter: "bandpass", freq: 2200, q: 1.1 });
    tone(t, 230, 0.12, 0.08, { slideTo: 140 });
  },

  wallBreak(): void {
    const t = target();
    if (!t) return;
    noise(t, 0.42, 0.9, { filter: "lowpass", freq: 1800, endFreq: 120, attack: 0.01 });
    tone(t, 80, 0.4, 0.8, { slideTo: 38 });
    noise(t, 0.15, 0.3, { filter: "bandpass", freq: 3000, q: 1.2, delay: 0.12 });
  },

  /** Deep stone chime: inharmonic partials, long tail. */
  sealChime(): void {
    const t = target();
    if (!t) return;
    const base = 98;
    [[1, 0.3, 2.6], [2.01, 0.14, 2.0], [2.76, 0.1, 1.5], [4.2, 0.05, 1.0], [5.4, 0.03, 0.7]].forEach(([ratio, gain, decay]) => {
      tone(t, base * ratio!, gain!, decay!, { attack: 0.006 });
    });
    tone(t, base / 2, 0.22, 1.8, { attack: 0.02 });
    noise(t, 0.1, 0.5, { filter: "lowpass", freq: 600, endFreq: 150 });
  },

  /** Stone door grinding open. */
  doorUnlock(): void {
    const t = target();
    if (!t) return;
    noise(t, 0.28, 1.5, { filter: "lowpass", freq: 260, endFreq: 760, brown: true, attack: 0.15 });
    tone(t, 52, 0.14, 1.4, { type: "sawtooth", slideTo: 66, attack: 0.2 });
    tone(t, 70, 0.3, 0.5, { slideTo: 40, delay: 1.45 });
    noise(t, 0.2, 0.4, { filter: "lowpass", freq: 900, endFreq: 150, delay: 1.45 });
  },

  celebrate(): void {
    const t = target();
    if (!t) return;
    [392, 494, 587, 784, 988].forEach((freq, i) => {
      tone(t, freq, 0.07, 1.4, { type: "triangle", attack: 0.02, delay: 0.35 + i * 0.16 });
      tone(t, freq * 2, 0.02, 1.0, { delay: 0.35 + i * 0.16 });
    });
  }
};
