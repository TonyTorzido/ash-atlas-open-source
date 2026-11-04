import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SOUND_SETTINGS,
  SOUND_SETTINGS_KEY,
  busGains,
  clampVolume,
  parseSoundSettings,
  soundSettings,
  updateSoundSettings,
  volumeToGain
} from "./soundSettings.js";

describe("sound volume math", () => {
  it("defaults to master 80, music 60, sound effects 80, music on", () => {
    expect(DEFAULT_SOUND_SETTINGS).toEqual({ master: 0, music: 60, sfx: 80, musicOn: true });
  });

  it("clamps and rounds slider values, ignoring junk", () => {
    expect(clampVolume(150, 5)).toBe(100);
    expect(clampVolume(-4, 5)).toBe(0);
    expect(clampVolume(42.6, 5)).toBe(43);
    expect(clampVolume("loud", 5)).toBe(5);
    expect(clampVolume(Number.NaN, 5)).toBe(5);
  });

  it("maps a slider to a squared gain curve", () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(100)).toBe(1);
    expect(volumeToGain(50)).toBeCloseTo(0.25, 6);
  });

  it("gives each bus its own gain and silences music when it is off", () => {
    const on = busGains({ master: 80, music: 60, sfx: 40, musicOn: true });
    expect(on.master).toBeCloseTo(0.64, 6);
    expect(on.music).toBeCloseTo(0.36, 6);
    expect(on.sfx).toBeCloseTo(0.16, 6);
    expect(busGains({ master: 80, music: 60, sfx: 40, musicOn: false }).music).toBe(0);
  });
});

describe("sound settings persistence", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("falls back to defaults for missing or corrupt storage", () => {
    expect(parseSoundSettings(null)).toEqual(DEFAULT_SOUND_SETTINGS);
    expect(parseSoundSettings("{nope")).toEqual(DEFAULT_SOUND_SETTINGS);
    expect(parseSoundSettings(JSON.stringify({ master: 500, music: "x", musicOn: "yes" }))).toEqual({ ...DEFAULT_SOUND_SETTINGS, master: 100 });
  });

  it("writes every change to localStorage and survives a blocked store", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });
    updateSoundSettings({ music: 25, musicOn: false });
    expect(soundSettings()).toEqual({ master: 0, music: 25, sfx: 80, musicOn: false });
    expect(parseSoundSettings(store.get(SOUND_SETTINGS_KEY) ?? null)).toEqual(soundSettings());

    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
    updateSoundSettings({ master: 10 });
    expect(soundSettings().master).toBe(10);
    updateSoundSettings(DEFAULT_SOUND_SETTINGS);
  });
});
