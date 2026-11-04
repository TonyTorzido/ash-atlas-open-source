import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(import.meta.dirname, "pixiOverlay.ts"),
  "utf8"
);

describe("movement and gameplay-view boundaries", () => {
  it("draws both authoritative circles in the fading leash layer", () => {
    const drawStart = source.indexOf("function renderMovementLeashLayer(");
    const draw = source.slice(
      drawStart,
      source.indexOf("function renderSelectionLayer(", drawStart)
    );
    expect(source).toContain("visibleState.gameplayViewCircle ?? null");
    expect(draw).toContain("localPlayer.moveLeashRadiusM");
    expect(draw).toContain("gameplayViewCircle.radiusM");
    expect(draw).toContain("closedPolylineDashSegments(gameplayViewCirclePoints, 9, 5)");
    expect(draw).toContain("color: 0x000000, width: 1.25, alpha: 1");
    expect(draw).toContain("color: 0x38bdf8, width: 1.25, alpha: 0.85");
    expect(draw).toContain("leashLayer.addChild(gameplayViewBoundary)");
    expect(draw).not.toContain("gameplayViewBoundary.fill(");
  });

  it("keeps water readiness gating without drawing a duplicate solid circle", () => {
    const waterStart = source.indexOf("function renderWaterHighlightLayer(");
    const water = source.slice(
      waterStart,
      source.indexOf("function renderCollectibleLayer(", waterStart)
    );
    expect(water).toContain("if (!resourceVision)");
    expect(water).not.toContain("resourceVisionRing");
    expect(water).not.toContain("circleAlpha");
  });
});
