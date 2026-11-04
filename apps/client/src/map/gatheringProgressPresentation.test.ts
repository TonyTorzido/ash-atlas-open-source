import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  formatGatheringRemainingTime,
  GATHERING_PROGRESS_STYLE
} from "./gatheringProgressPresentation.js";

const overlaySource = readFileSync(new URL("./pixiOverlay.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("gathering progress presentation", () => {
  it("uses a bronze, parchment, ink plate with determinate remaining time", () => {
    expect(GATHERING_PROGRESS_STYLE.fill).toBe(0x98703d);
    expect(GATHERING_PROGRESS_STYLE.parchment).toBe(0xe7dcc2);
    expect(GATHERING_PROGRESS_STYLE.plate).toBe(0x0d0b08);
    expect(formatGatheringRemainingTime(3_249)).toBe("3.2s");
  });

  it("keeps the world animation renderer free of the obsolete timer plate", () => {
    expect(overlaySource).not.toContain("gatheringProgressLayer");
    expect(overlaySource).not.toContain("drawGatheringProgress");
    expect(overlaySource).not.toContain("GATHERING_PROGRESS_STYLE");
    expect(appSource).toContain("gatheringProgressForTask(");
    expect(appSource).toContain("WorldActivityTimerPlate");
    expect(appSource).toContain("worldActivityKindForGatheringLabel");
  });

  it("renders moving sprites fractionally while keeping text on whole pixels", () => {
    expect(overlaySource).toContain("resolution: OVERLAY_RENDER_RESOLUTION");
    expect(overlaySource).toContain("autoDensity: true");
    expect(overlaySource).toContain("roundPixels: false");
    expect(overlaySource).toContain("roundPixels: true");
    expect(overlaySource).toContain("overlayTextResolution()");
    expect(overlaySource).toContain("resolution: OVERLAY_RENDERER_RESOLUTION");
  });
});
