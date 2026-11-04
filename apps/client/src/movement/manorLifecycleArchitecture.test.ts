import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const manorFeature = readFileSync(
  fileURLToPath(new URL("../features/manor/useManorFeature.ts", import.meta.url)),
  "utf8"
);

describe("manor client lifecycle architecture", () => {
  it("routes high-frequency positions only into the manor timeline", () => {
    const handler = manorFeature.slice(
      manorFeature.indexOf('case "MANOR_POSITION"'),
      manorFeature.indexOf('case "MANOR_EXITED"')
    );
    expect(handler).toContain("movementTimelineRef.current.applySnapshot");
    expect(handler).not.toContain("setManorSession");
    expect(handler).not.toContain("setState");
  });

  it("keeps cached world collections while inside", () => {
    const entered = manorFeature.slice(
      manorFeature.indexOf('case "MANOR_ENTERED"'),
      manorFeature.indexOf('case "MANOR_POSITION"')
    );
    for (const setter of ["setFlags([])", "setCities([])", "setManors([])", "setCollectibles([])", "setDroppedItems([])"]) {
      expect(entered).not.toContain(setter);
    }
  });

  it("defers map resize, camera restore, renderer resume, and resync until world layout", () => {
    const exited = manorFeature.slice(
      manorFeature.indexOf('case "MANOR_EXITED"'),
      manorFeature.indexOf('case "MANOR_ERROR"')
    );
    expect(exited).toContain("pendingWorldRestoreRef.current = message.player");
    expect(exited).not.toContain("mapRef.current?.resize");
    expect(exited).not.toContain("jumpTo");
    expect(app).toContain("useLayoutEffect");
    expect(app).toContain('requestWorldResync("manor-exit")');
    expect(app).toContain("setRenderingActive(true)");
  });

  it("retires stale world movement correlation when the manor exit installs a new epoch", () => {
    const exitHandler = app.slice(
      app.indexOf("const handleManorExited"),
      app.indexOf("const handleBeforeManorEnter")
    );
    expect(exitHandler).toContain("pendingTravelWatchdogRef.current?.clear()");
    expect(exitHandler).toContain("pendingTravelRequestIdRef.current = null;");
    expect(exitHandler).toContain("localMovementRequestsRef.current.reset();");
    expect(exitHandler).toContain("clearPostArrivalTravelBinding({");
  });

  it("keeps first-manor construction reachable from the phone HUD", () => {
    const phoneBuildOptions = app.slice(app.indexOf("const phoneBuildOptions"), app.indexOf("const closeUtilityPanels"));
    expect(phoneBuildOptions).toContain('id: "manor"');
    expect(phoneBuildOptions).toContain("ownManor === null");
    expect(phoneBuildOptions).toContain("setManorBuildPanelOpen(true)");
  });
});
