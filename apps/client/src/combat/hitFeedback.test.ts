import { describe, expect, it } from "vitest";

import {
  DAMAGE_BIG_SETTLED_SCALE,
  DAMAGE_POP_BIG_START_SCALE,
  DAMAGE_POP_IN_MS,
  DAMAGE_POP_SETTLE_MS,
  DAMAGE_POP_START_SCALE,
  DEATH_GHOST_MS,
  DEATH_SHRINK_TO,
  DeathGhostLook,
  HITSTOP_CATCHUP_MS,
  HIT_TUNING,
  IMPACT_FLASH_ALPHA,
  IMPACT_FLASH_FADE_MS,
  IMPACT_RED_MS,
  SHAKE_REDUCED_SCALE,
  SHAKE_TUNING,
  ScreenShakeState,
  damagePopScale,
  deathGhostLook,
  easeInOutCubic,
  easeOutCubic,
  hitstopLag,
  holdJitterPx,
  iframeShimmer,
  impactFlashAlpha,
  impactRedStrength,
  minTint,
  pushDurationMs,
  pushFraction,
  redTint,
  shakeOffset,
  shakeScale
} from "./hitFeedback.js";

describe("easing", () => {
  it("runs 0..1, clamps, and is monotonic", () => {
    for (const ease of [easeOutCubic, easeInOutCubic]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      expect(ease(-1)).toBe(0);
      expect(ease(2)).toBe(1);
      let previous = 0;
      for (let t = 0; t <= 1; t += 0.05) {
        expect(ease(t)).toBeGreaterThanOrEqual(previous - 1e-12);
        previous = ease(t);
      }
    }
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
  });
});

describe("hitstop lag", () => {
  it("grows with the clock during the hold, shrinks to 0 over the catch-up, and the sampled time never runs backwards", () => {
    const hold = 60;
    expect(hitstopLag(-1, hold)).toBe(0);
    expect(hitstopLag(0, hold)).toBe(0);
    expect(hitstopLag(30, hold)).toBe(30);
    expect(hitstopLag(hold - 1, hold)).toBe(hold - 1);
    expect(hitstopLag(hold, hold)).toBe(hold);
    expect(hitstopLag(hold + HITSTOP_CATCHUP_MS / 2, hold)).toBeCloseTo(hold / 2);
    expect(hitstopLag(hold + HITSTOP_CATCHUP_MS, hold)).toBe(0);
    expect(hitstopLag(Number.NaN, hold)).toBe(0);
    let previous = -Infinity;
    for (let elapsed = 0; elapsed < hold + HITSTOP_CATCHUP_MS + 20; elapsed += 1) {
      const sampled = elapsed - hitstopLag(elapsed, hold);
      expect(sampled).toBeGreaterThanOrEqual(previous);
      previous = sampled;
    }
  });

  it("keeps the brief's ranges: 50-80 ms on a swing, longer on the finisher, lighter when the player is hit", () => {
    expect(HIT_TUNING.swing.holdMs).toBeGreaterThanOrEqual(50);
    expect(HIT_TUNING.swing.holdMs).toBeLessThanOrEqual(80);
    expect(HIT_TUNING.finisher.holdMs).toBeGreaterThan(HIT_TUNING.swing.holdMs);
    expect(HIT_TUNING.incoming.holdMs).toBeLessThan(HIT_TUNING.swing.holdMs);
    expect(HIT_TUNING.incoming.pushPx).toBeLessThan(HIT_TUNING.swing.pushPx);
  });
});

describe("push", () => {
  it("starts part way, peaks at 1 after the hold, and returns to 0", () => {
    const hold = 60;
    expect(pushFraction(-1, hold)).toBe(0);
    expect(pushFraction(0, hold)).toBeGreaterThan(0);
    expect(pushFraction(0, hold)).toBeLessThan(1);
    let peak = 0;
    for (let elapsed = 0; elapsed < pushDurationMs(hold); elapsed += 1) peak = Math.max(peak, pushFraction(elapsed, hold));
    expect(peak).toBeCloseTo(1, 2);
    expect(pushFraction(pushDurationMs(hold), hold)).toBe(0);
  });

  it("trembles only while frozen", () => {
    expect(Math.abs(holdJitterPx(0, 60))).toBeGreaterThan(0);
    expect(holdJitterPx(0, 60)).toBe(-holdJitterPx(16, 60));
    expect(holdJitterPx(60, 60)).toBe(0);
  });
});

describe("impact flash", () => {
  it("is full white during the hold, then fades quickly while the red takes over and decays", () => {
    const hold = 60;
    expect(impactFlashAlpha(0, hold)).toBe(IMPACT_FLASH_ALPHA);
    expect(impactFlashAlpha(hold - 1, hold)).toBe(IMPACT_FLASH_ALPHA);
    expect(impactFlashAlpha(hold + IMPACT_FLASH_FADE_MS / 2, hold)).toBeLessThan(IMPACT_FLASH_ALPHA / 2);
    expect(impactFlashAlpha(hold + IMPACT_FLASH_FADE_MS, hold)).toBe(0);
    expect(impactFlashAlpha(-1, hold)).toBe(0);
    expect(impactRedStrength(hold, hold)).toBeGreaterThan(impactRedStrength(0, hold));
    expect(impactRedStrength(hold + IMPACT_RED_MS, hold)).toBe(0);
  });

  it("builds red tints on the existing ramp and combines them per channel", () => {
    expect(redTint(0)).toBe(0xffffff);
    expect(redTint(1)).toBe(0xff5a5a);
    expect(minTint(0xff8080, 0xffc0c0)).toBe(0xff8080);
    expect(minTint(0xa0dcff, 0xff8080)).toBe(0xa08080);
  });
});

describe("screen shake", () => {
  it("decays to zero over its duration", () => {
    const out = { x: 0, y: 0 };
    expect(shakeOffset(10, 4, 100, out)).toBe(true);
    expect(Math.hypot(out.x, out.y)).toBeLessThanOrEqual(4);
    expect(shakeOffset(100, 4, 100, out)).toBe(false);
    expect(out).toEqual({ x: 0, y: 0 });
  });

  it("scales with the setting and is off under OS reduced motion", () => {
    expect(shakeScale("full", false)).toBe(1);
    expect(shakeScale("reduced", false)).toBe(SHAKE_REDUCED_SCALE);
    expect(shakeScale("off", false)).toBe(0);
    expect(shakeScale("full", true)).toBe(0);
  });

  it("starts nothing at scale 0 and keeps a stronger running shake", () => {
    const shake = new ScreenShakeState();
    const out = { x: 0, y: 0 };
    expect(shake.start(0, "finisher", 0)).toBe(false);
    expect(shake.sample(10, out)).toBe(false);
    expect(shake.start(0, "signature", 1)).toBe(true);
    expect(shake.start(5, "finisher", 1)).toBe(false);
    expect(shake.sample(20, out)).toBe(true);
    expect(shake.sample(SHAKE_TUNING.signature.durationMs, out)).toBe(false);
    expect(shake.start(1000, "finisher", 1)).toBe(true);
  });
});

describe("damage pop", () => {
  it("scales in big, undershoots, and settles at 1 (bigger and settled larger for big hits)", () => {
    expect(damagePopScale(0, "outgoing")).toBe(DAMAGE_POP_START_SCALE);
    expect(damagePopScale(DAMAGE_POP_IN_MS, "outgoing")).toBeLessThan(1);
    expect(damagePopScale(DAMAGE_POP_IN_MS + DAMAGE_POP_SETTLE_MS, "outgoing")).toBe(1);
    expect(damagePopScale(0, "big")).toBe(DAMAGE_POP_BIG_START_SCALE);
    expect(damagePopScale(1000, "big")).toBe(DAMAGE_BIG_SETTLED_SCALE);
    expect(damagePopScale(0, "incoming")).toBeLessThan(damagePopScale(0, "outgoing"));
    expect(damagePopScale(0, "outgoing", true)).toBe(1);
  });

  it("shrinks steadily during the pop-in, then only grows back to its settled size", () => {
    for (const kind of ["outgoing", "incoming", "big"] as const) {
      for (let elapsed = 0; elapsed + 8 <= DAMAGE_POP_IN_MS; elapsed += 8) {
        expect(damagePopScale(elapsed + 8, kind)).toBeLessThanOrEqual(damagePopScale(elapsed, kind));
      }
      for (let elapsed = DAMAGE_POP_IN_MS; elapsed + 8 <= DAMAGE_POP_IN_MS + DAMAGE_POP_SETTLE_MS; elapsed += 8) {
        expect(damagePopScale(elapsed + 8, kind)).toBeGreaterThanOrEqual(damagePopScale(elapsed, kind));
      }
    }
  });
});

describe("i-frame shimmer", () => {
  it("pulses inside the i-frames and is 0 outside", () => {
    expect(iframeShimmer(-1, 200)).toBe(0);
    expect(iframeShimmer(0, 200)).toBe(0);
    expect(iframeShimmer(50, 200)).toBeGreaterThan(0.5);
    expect(iframeShimmer(200, 200)).toBe(0);
  });
});

describe("death ghost curve", () => {
  const out: DeathGhostLook = { flash: 0, alpha: 1, scale: 1, sink: 0, labels: 1 };
  /** Samples the curve every `stepMs` (a 60 Hz or a 30 Hz render loop). */
  const frames = (stepMs: number, reduced = false): DeathGhostLook[] => {
    const list: DeathGhostLook[] = [];
    for (let t = 0; t < DEATH_GHOST_MS; t += stepMs) list.push({ ...deathGhostLook(t, reduced, out)! });
    return list;
  };

  it("starts untouched, ends at alpha 0, and is gone at DEATH_GHOST_MS", () => {
    expect(deathGhostLook(-50, false, out)).toMatchObject({ alpha: 1, scale: 1, flash: 0 });
    const last = frames(1).at(-1)!;
    expect(last.alpha).toBeLessThan(0.001);
    expect(last.scale).toBeCloseTo(DEATH_SHRINK_TO, 2);
    expect(deathGhostLook(DEATH_GHOST_MS, false, out)).toBeNull();
  });

  it("alpha and scale fall monotonically with no frame jump (60 Hz and 30 Hz)", () => {
    for (const step of [16.7, 33.3]) {
      const list = frames(step);
      for (let i = 1; i < list.length; i += 1) {
        expect(list[i]!.alpha).toBeLessThanOrEqual(list[i - 1]!.alpha);
        expect(list[i]!.scale).toBeLessThanOrEqual(list[i - 1]!.scale);
        expect(list[i - 1]!.alpha - list[i]!.alpha, `alpha step at frame ${i}`).toBeLessThan(0.06 * (step / 16.7));
        expect(list[i - 1]!.scale - list[i]!.scale, `scale step at frame ${i}`).toBeLessThan(0.01 * (step / 16.7));
      }
    }
  });

  it("the white flash eases in and out: it never jumps and is gone before the fade is half done", () => {
    const list = frames(16.7);
    let peak = 0;
    for (let i = 1; i < list.length; i += 1) {
      expect(Math.abs(list[i]!.flash - list[i - 1]!.flash), `flash step at frame ${i}`).toBeLessThan(0.5);
      peak = Math.max(peak, list[i]!.flash);
    }
    expect(peak).toBeGreaterThan(0.5);
    expect(deathGhostLook(120, false, out)!.flash).toBe(0);
    expect(deathGhostLook(1, false, out)!.flash).toBeLessThan(0.05);
  });

  it("labels fade out quickly and reduced motion neither shrinks nor sinks", () => {
    expect(deathGhostLook(200, false, out)!.labels).toBe(0);
    for (const look of frames(16.7, true)) {
      expect(look.scale).toBe(1);
      expect(look.sink).toBe(0);
    }
  });
});
