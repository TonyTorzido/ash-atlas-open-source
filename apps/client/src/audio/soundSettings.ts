import { useSyncExternalStore } from "react";

/**
 * Sound settings (per device): master, music and sound-effect volumes (0 to 100) and a music on/off switch.
 * Persisted like the other per-device settings (localStorage, try/catch, still applies for the session).
 */
export type SoundSettings = Readonly<{
  master: number;
  music: number;
  sfx: number;
  musicOn: boolean;
}>;

export const DEFAULT_SOUND_SETTINGS: SoundSettings = { master: 0, music: 60, sfx: 80, musicOn: true };
export const SOUND_SETTINGS_KEY = "ashAtlas.sound.v2";

export function clampVolume(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Slider value (0 to 100) to a gain: a squared curve, so the lower half of the slider is still usable. */
export function volumeToGain(volume: number): number {
  const v = clampVolume(volume, 0) / 100;
  return v * v;
}

/** What the engine sets on its buses. `musicBus` excludes the combat duck and master (those are separate nodes). */
export function busGains(settings: SoundSettings): Readonly<{ master: number; music: number; sfx: number }> {
  return {
    master: volumeToGain(settings.master),
    music: settings.musicOn ? volumeToGain(settings.music) : 0,
    sfx: volumeToGain(settings.sfx)
  };
}

export function parseSoundSettings(raw: string | null): SoundSettings {
  if (!raw) return DEFAULT_SOUND_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof SoundSettings, unknown>> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_SOUND_SETTINGS;
    return {
      master: clampVolume(parsed.master, DEFAULT_SOUND_SETTINGS.master),
      music: clampVolume(parsed.music, DEFAULT_SOUND_SETTINGS.music),
      sfx: clampVolume(parsed.sfx, DEFAULT_SOUND_SETTINGS.sfx),
      musicOn: typeof parsed.musicOn === "boolean" ? parsed.musicOn : DEFAULT_SOUND_SETTINGS.musicOn
    };
  } catch {
    return DEFAULT_SOUND_SETTINGS;
  }
}

export function readStoredSoundSettings(): SoundSettings {
  try {
    return parseSoundSettings(window.localStorage.getItem(SOUND_SETTINGS_KEY));
  } catch {
    return DEFAULT_SOUND_SETTINGS;
  }
}

let current: SoundSettings = typeof window === "undefined" ? DEFAULT_SOUND_SETTINGS : readStoredSoundSettings();
const listeners = new Set<() => void>();

export function soundSettings(): SoundSettings {
  return current;
}

export function updateSoundSettings(patch: Partial<SoundSettings>): void {
  const next: SoundSettings = {
    master: clampVolume(patch.master, current.master),
    music: clampVolume(patch.music, current.music),
    sfx: clampVolume(patch.sfx, current.sfx),
    musicOn: typeof patch.musicOn === "boolean" ? patch.musicOn : current.musicOn
  };
  try { window.localStorage.setItem(SOUND_SETTINGS_KEY, JSON.stringify(next)); } catch { /* Still applies for this session. */ }
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeSoundSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSoundSettings(): readonly [SoundSettings, (patch: Partial<SoundSettings>) => void] {
  const value = useSyncExternalStore(subscribeSoundSettings, soundSettings, () => DEFAULT_SOUND_SETTINGS);
  return [value, updateSoundSettings] as const;
}
