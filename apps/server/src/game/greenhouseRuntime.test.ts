import { describe, expect, it } from "vitest";

import {
  GREENHOUSE_STUDIO_CATALOG,
  GREENHOUSE_PLANTER_INTERACTION_RADIUS,
  GREENHOUSE_TANK_INTERACTION_RADIUS
} from "@ash-atlas/shared";
import { GreenhouseRuntime, GreenhouseRuntimeError } from "./greenhouseRuntime.js";

describe("GreenhouseRuntime water-storage targeting", () => {
  it("accepts only the settled owner session inside the authored tank radius", () => {
    const runtime = new GreenhouseRuntime();
    const entered = runtime.enter("player-1", "greenhouse-1", GREENHOUSE_STUDIO_CATALOG.waterStorage);
    expect(runtime.isNearWaterStorage("player-1", entered.sessionId)).toBe(true);

    runtime.moveTo("player-1", entered.sessionId, GREENHOUSE_STUDIO_CATALOG.waterStorage.x + GREENHOUSE_TANK_INTERACTION_RADIUS + 1, GREENHOUSE_STUDIO_CATALOG.waterStorage.y);
    expect(runtime.isNearWaterStorage("player-1", entered.sessionId)).toBe(false);
    expect(() => runtime.isNearWaterStorage("player-1", "stale-session")).toThrowError(GreenhouseRuntimeError);
  });

  it("does not authorize tank actions while movement is still settling", () => {
    const runtime = new GreenhouseRuntime();
    const entered = runtime.enter("player-2", "greenhouse-2", { x: GREENHOUSE_STUDIO_CATALOG.waterStorage.x - 20, y: GREENHOUSE_STUDIO_CATALOG.waterStorage.y });
    runtime.moveTo("player-2", entered.sessionId, GREENHOUSE_STUDIO_CATALOG.waterStorage.x, GREENHOUSE_STUDIO_CATALOG.waterStorage.y);
    expect(runtime.isNearWaterStorage("player-2", entered.sessionId)).toBe(false);
    runtime.tick(1);
    expect(runtime.isNearWaterStorage("player-2", entered.sessionId)).toBe(true);
  });

  it("does not disconnect a replacement session with a stale socket session id", async () => {
    const runtime = new GreenhouseRuntime();
    const prior = runtime.enter("player-3", "greenhouse-3");
    const replacement = runtime.restore("player-3", "greenhouse-3");

    await runtime.disconnect("player-3", prior.sessionId);

    expect(runtime.get("player-3")?.sessionId).toBe(replacement.sessionId);
  });
});

describe("GreenhouseRuntime planter targeting", () => {
  it("uses the authored floor surface for spawn and movement validation", () => {
    const runtime = new GreenhouseRuntime();
    const entered = runtime.enter("navigation-player", "greenhouse-navigation", { x: GREENHOUSE_STUDIO_CATALOG.roomWidth / 2, y: 100 });
    expect(entered.position.y).toBeGreaterThan(200);
    expect(() => runtime.moveTo("navigation-player", entered.sessionId, GREENHOUSE_STUDIO_CATALOG.roomWidth / 2, 100))
      .toThrowError(GreenhouseRuntimeError);
  });

  it("requires a settled session inside the authored planter radius", () => {
    const runtime = new GreenhouseRuntime();
    const anchor = GREENHOUSE_STUDIO_CATALOG.anchors[0]!;
    const entered = runtime.enter("planter-player", "greenhouse-planter", anchor);
    expect(runtime.isNearPlanter("planter-player", entered.sessionId, anchor.anchorId)).toBe(true);

    runtime.moveTo(
      "planter-player",
      entered.sessionId,
      anchor.x + GREENHOUSE_PLANTER_INTERACTION_RADIUS + 1,
      anchor.y
    );
    expect(runtime.isNearPlanter("planter-player", entered.sessionId, anchor.anchorId)).toBe(false);
    expect(() => runtime.isNearPlanter("planter-player", entered.sessionId, "missing-anchor"))
      .toThrowError(GreenhouseRuntimeError);
  });
});
