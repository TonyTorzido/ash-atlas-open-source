// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isPerfProbeEnabled, isPerfProbeVisible, setPerfProbeEnabled } from "./perfProbe.js";
import { isLegacyRenderQualityEnabled, setLegacyRenderQualityEnabled } from "./renderQualityFlag.js";

afterEach(() => {
  setPerfProbeEnabled(false);
  setLegacyRenderQualityEnabled(false);
});

describe("perf probe switches", () => {
  it("persists and live-toggles the probe overlay without scrollbars", () => {
    expect(isPerfProbeEnabled()).toBe(false);
    setPerfProbeEnabled(true);
    expect(isPerfProbeEnabled()).toBe(true);
    expect(isPerfProbeVisible()).toBe(true);
    const element = document.querySelector<HTMLElement>(".perf-probe");
    expect(element?.style.overflow).toBe("hidden");
    setPerfProbeEnabled(false);
    expect(document.querySelector(".perf-probe")).toBeNull();
    expect(isPerfProbeEnabled()).toBe(false);
  });

  it("legacy render quality defaults off and persists", () => {
    expect(isLegacyRenderQualityEnabled()).toBe(false);
    setLegacyRenderQualityEnabled(true);
    expect(isLegacyRenderQualityEnabled()).toBe(true);
  });
});
