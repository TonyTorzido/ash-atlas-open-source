import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isPhoneRenderProfile,
  overlayAntialias,
  overlayRendererResolution,
  overlayTextResolution,
  playerLayerResolution
} from "./renderQuality.js";
import { isAppleDevice, startRenderQualityGovernor, sustainedSlow } from "./renderQualityGovernor.js";
import { isReducedRenderQualityEnabled, setReducedRenderQualityEnabled } from "./renderQualityFlag.js";

const store = new Map<string, string>();
function device(dpr: number, coarse: boolean): void {
  vi.stubGlobal("devicePixelRatio", dpr);
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: coarse && query.includes("coarse") }),
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    }
  });
}
afterEach(() => {
  store.clear();
  vi.unstubAllGlobals();
});

describe("render quality", () => {
  it("is High by default: a 3x iPhone renders every canvas at 3x with antialiasing", () => {
    device(3, true);
    expect(isPhoneRenderProfile()).toBe(true);
    expect(overlayRendererResolution()).toBe(3);
    expect(overlayTextResolution()).toBe(3);
    expect(playerLayerResolution()).toBe(3);
    expect(overlayAntialias()).toBe(true);
  });

  it("keeps a 2x device at 2x and never goes below 2x on a 1x desktop screen", () => {
    device(2, true);
    expect(overlayRendererResolution()).toBe(2);
    device(1, false);
    expect(overlayRendererResolution()).toBe(2);
    expect(playerLayerResolution()).toBe(2);
  });

  it("Low caps the backbuffers at 2x and drops overlay MSAA on phones only", () => {
    device(3, true);
    setReducedRenderQualityEnabled(true);
    expect(overlayRendererResolution()).toBe(2);
    expect(playerLayerResolution()).toBe(2);
    expect(overlayAntialias()).toBe(false);
    expect(overlayTextResolution()).toBe(3);
    device(3, false);
    setReducedRenderQualityEnabled(true);
    expect(overlayAntialias()).toBe(true);
  });
});

describe("render quality governor", () => {
  const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 };
  const android = { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 6)", platform: "Linux armv8l", maxTouchPoints: 5 };

  it("recognises Apple devices, including iPadOS in desktop mode", () => {
    expect(isAppleDevice(iphone)).toBe(true);
    expect(isAppleDevice({ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(isAppleDevice(android)).toBe(false);
  });

  it("needs consecutive slow windows", () => {
    expect(sustainedSlow([40])).toBe(false);
    expect(sustainedSlow([40, 20])).toBe(false);
    expect(sustainedSlow([20, 40, 40])).toBe(true);
    expect(sustainedSlow([40, 40, 17])).toBe(false);
  });

  function run(nav: typeof android, frameMs: number, seconds: number): void {
    device(3, true);
    let t = 1000;
    const queue: FrameRequestCallback[] = [];
    startRenderQualityGovernor(nav, (cb) => queue.push(cb), () => undefined);
    for (let elapsed = 0; elapsed < seconds * 1000 && queue.length > 0; elapsed += frameMs) {
      t += frameMs;
      queue.shift()!(t);
    }
  }

  it("lowers quality on a non-Apple device that holds under 28 fps for 20 s", () => {
    run(android, 50, 30);
    expect(isReducedRenderQualityEnabled()).toBe(true);
  });

  it("leaves a device that holds 60 fps alone", () => {
    run(android, 16.7, 40);
    expect(isReducedRenderQualityEnabled()).toBe(false);
  });

  it("never lowers an iPhone", () => {
    run(iphone, 50, 40);
    expect(isReducedRenderQualityEnabled()).toBe(false);
  });
});
