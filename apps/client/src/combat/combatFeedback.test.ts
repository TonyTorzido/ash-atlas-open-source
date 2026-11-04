import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ isNative: false, pluginAvailable: true, impact: vi.fn(async (_options: unknown) => undefined) }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => native.isNative,
    isPluginAvailable: () => native.pluginAvailable
  }
}));
vi.mock("@capacitor/haptics", () => ({
  Haptics: { impact: native.impact },
  ImpactStyle: { Light: "LIGHT", Medium: "MEDIUM", Heavy: "HEAVY" }
}));

import {
  HAPTIC_SUPPRESS_MS,
  combatCueStats,
  combatHapticsEnabled,
  hapticStyleForCue,
  playCombatCue,
  readStoredCombatHaptics,
  setCombatHapticsEnabled,
  setCombatSfxHandler
} from "./combatFeedback.js";

describe("combat cues", () => {
  beforeEach(() => {
    native.isNative = false;
    native.pluginAvailable = true;
    native.impact.mockClear();
    combatCueStats.hapticCalls = 0;
    combatCueStats.hapticSkipped = 0;
    setCombatHapticsEnabled(true);
    setCombatSfxHandler(null);
  });
  afterEach(() => {
    setCombatSfxHandler(null);
    vi.restoreAllMocks();
  });

  it("maps cues to haptics: light hit and dash, medium kill and hurt, heavy big hurt", () => {
    expect(hapticStyleForCue("hit")).toBe("light");
    expect(hapticStyleForCue("kill")).toBe("medium");
    expect(hapticStyleForCue("hurt")).toBe("medium");
    expect(hapticStyleForCue("hurt", { heavy: true })).toBe("heavy");
    expect(hapticStyleForCue("dash")).toBe("light");
    expect(hapticStyleForCue("swing")).toBeNull();
    expect(hapticStyleForCue("ready")).toBeNull();
  });

  it("is a no-op for haptics on web but still runs the sound hook", () => {
    const sfx = vi.fn();
    setCombatSfxHandler(sfx);
    playCombatCue("hit");
    playCombatCue("kill");
    expect(native.impact).not.toHaveBeenCalled();
    expect(combatCueStats.hapticCalls).toBe(0);
    expect(combatCueStats.hapticSkipped).toBe(2);
    expect(sfx).toHaveBeenCalledTimes(2);
    expect(sfx.mock.calls[0]?.[0]).toBe("hit");
  });

  it("does nothing when the sound hook is unset and survives a throwing hook", () => {
    expect(() => playCombatCue("swing")).not.toThrow();
    setCombatSfxHandler(() => { throw new Error("broken"); });
    expect(() => playCombatCue("swing")).not.toThrow();
  });

  it("plays impacts on a native shell and skips them when the plugin is missing or the setting is off", () => {
    native.isNative = true;
    playCombatCue("dash");
    expect(native.impact).toHaveBeenCalledWith({ style: "LIGHT" });
    native.pluginAvailable = false;
    playCombatCue("kill");
    expect(native.impact).toHaveBeenCalledTimes(1);
    native.pluginAvailable = true;
    setCombatHapticsEnabled(false);
    expect(combatHapticsEnabled()).toBe(false);
    playCombatCue("hurt", { heavy: true });
    expect(native.impact).toHaveBeenCalledTimes(1);
  });

  it("drops a weaker haptic right after a stronger one", () => {
    native.isNative = true;
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(10_000);
    playCombatCue("kill");
    now.mockReturnValue(10_000 + HAPTIC_SUPPRESS_MS - 10);
    playCombatCue("hit");
    expect(native.impact).toHaveBeenCalledTimes(1);
    now.mockReturnValue(10_000 + HAPTIC_SUPPRESS_MS + 10);
    playCombatCue("hit");
    expect(native.impact).toHaveBeenCalledTimes(2);
  });

  it("defaults to on", () => {
    expect(readStoredCombatHaptics()).toBe(true);
  });
});
