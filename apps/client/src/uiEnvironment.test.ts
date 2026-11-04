import { describe, expect, it } from "vitest";

import {
  detectDisplayMode,
  resolveApplicationViewport,
  resolveAutomaticLayoutMode,
  resolveEffectiveLayoutMode,
  resolveInputMode,
  resolveUiPresentation,
  type UiSignals
} from "./uiEnvironment.js";

describe("gameplay environment classification", () => {
  it("uses a separate desktop command presentation without converting tablets to desktop", () => {
    expect(resolveUiPresentation(signals(1280, 800, false, true, false))).toBe("desktop");
    expect(resolveUiPresentation(signals(1099, 800, false, true, false))).toBe("touch");
    expect(resolveUiPresentation(signals(1280, 599, false, true, false))).toBe("touch");
    expect(resolveUiPresentation(signals(1366, 1024, true, false, true))).toBe("touch");
    expect(resolveUiPresentation(signals(1366, 1024, true, true, true))).toBe("touch");
  });
  it.each([
    ["iPhone portrait", signals(390, 844, true, false, true), "compact", "touch"],
    ["Android phone", signals(412, 915, true, false, true), "compact", "touch"],
    ["iPad portrait", signals(768, 1024, true, false, true), "wide", "touch"],
    ["iPad landscape", signals(1024, 768, true, false, true), "wide", "touch"],
    ["Android tablet", signals(800, 1280, true, false, true), "wide", "touch"],
    ["closed foldable", signals(390, 882, true, false, true), "compact", "touch"],
    ["open foldable", signals(820, 1180, true, false, true), "wide", "touch"],
    ["Windows Surface", signals(1368, 912, true, true, true), "wide", "hybrid"],
    ["touch Chromebook", signals(1366, 768, true, true, true), "wide", "hybrid"],
    ["desktop", signals(1440, 900, false, true, false), "wide", "mouse"],
    ["narrow desktop window", signals(700, 900, false, true, false), "compact", "mouse"],
    ["tablet split screen", signals(600, 1024, true, false, true), "compact", "touch"],
    ["short phone landscape", signals(844, 390, true, false, true), "compact", "touch"]
  ] as const)("%s resolves independently from device identity", (_name, environment, layout, input) => {
    expect(resolveAutomaticLayoutMode(environment)).toBe(layout);
    expect(resolveInputMode(environment)).toBe(input);
  });

  it("uses viewport capability rather than user-agent claims or request-desktop-site state", () => {
    const narrowDesktopClaim = signals(430, 932, true, false, true);
    const wideMobileClaim = signals(1024, 768, true, false, true);
    expect(resolveAutomaticLayoutMode(narrowDesktopClaim)).toBe("compact");
    expect(resolveAutomaticLayoutMode(wideMobileClaim)).toBe("wide");
  });

  it("applies remembered overrides with a narrow-viewport safety fallback", () => {
    expect(resolveEffectiveLayoutMode("wide", "compact", { width: 1024, height: 768 }))
      .toEqual({ layoutMode: "compact", wideOverrideBlocked: false });
    expect(resolveEffectiveLayoutMode("compact", "wide", { width: 720, height: 560 }))
      .toEqual({ layoutMode: "wide", wideOverrideBlocked: false });
    expect(resolveEffectiveLayoutMode("compact", "wide", { width: 430, height: 932 }))
      .toEqual({ layoutMode: "compact", wideOverrideBlocked: true });
    expect(resolveEffectiveLayoutMode("wide", "automatic", { width: 1024, height: 768 }))
      .toEqual({ layoutMode: "wide", wideOverrideBlocked: false });
  });

  it("detects browser and installed display modes without using them as layout inputs", () => {
    expect(detectDisplayMode({ standaloneMedia: true })).toBe("standalone");
    expect(detectDisplayMode({ standaloneMedia: false, navigatorStandalone: true })).toBe("standalone");
    expect(detectDisplayMode({ standaloneMedia: false, navigatorStandalone: false })).toBe("browser");
  });

  it("reports the real compact viewport and bounded canonical wide stage", () => {
    expect(resolveApplicationViewport({ width: 1440, height: 900 }, "wide"))
      .toEqual({ width: 1157.8984375, height: 868 });
    expect(resolveApplicationViewport({ width: 1920, height: 1080 }, "wide"))
      .toEqual({ width: 1366, height: 1024 });
    expect(resolveApplicationViewport({ width: 390, height: 844 }, "compact"))
      .toEqual({ width: 390, height: 844 });
  });
});

function signals(
  width: number,
  height: number,
  hasTouch: boolean,
  hasFinePointer: boolean,
  hasCoarsePointer: boolean
): UiSignals {
  return { width, height, hasTouch, hasFinePointer, hasCoarsePointer };
}
