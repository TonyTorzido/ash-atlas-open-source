import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("startup presentation architecture", () => {
  it("leaves ordinary startup recovery to the bounded convergence watchdog", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(appSource).not.toContain('requestWorldResync("initial-bootstrap")');
    expect(appSource).not.toContain('requestWorldResync("reconnect-bootstrap")');
  });

  it("paints the converged Pixi state before either readiness event can reveal the world", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const dataReady = sourceBetween(
      appSource,
      "presentationDataReady: (authority) => {",
      "ready: (epoch) => {"
    );
    expect(dataReady.indexOf("paintCurrentFrame()"))
      .toBeLessThan(dataReady.indexOf('type: "world_ready"'));
    expect(dataReady.indexOf("setMobPresentationReady(true)"))
      .toBeLessThan(dataReady.indexOf("paintCurrentFrame()"));

    const rendererReady = sourceBetween(
      appSource,
      "created.update(renderStateRef.current);",
      "refreshOverlay();"
    );
    expect(rendererReady.indexOf("paintCurrentFrame()"))
      .toBeLessThan(rendererReady.indexOf('type: "overlay_ready"'));
  });

  it("keeps the reveal behind painted map, server snapshot, and world convergence", () => {
    const startupSource = readFileSync(
      new URL("./startupState.ts", import.meta.url),
      "utf8"
    );
    const presentationReady = sourceBetween(
      startupSource,
      "export function isStartupPresentationReady(",
      "\n}"
    );
    expect(presentationReady).toContain("mapPainted");
    expect(presentationReady).toContain("worldReady");
    expect(presentationReady).toContain("presentationSnapshotReceived");

  });

  it("keeps non-greenhouse interior readiness scene-owned and marks greenhouse state readiness", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const canonicalLocationHandler = sourceBetween(
      appSource,
      "const handleCanonicalLocation = useCallback",
      "const portalLocation = usePortalLocationController"
    );

    const locationDispatchIndex = canonicalLocationHandler.indexOf(
      'dispatchStartup({ type: "location" })'
    );
    const worldBranchIndex = canonicalLocationHandler.indexOf(
      'if (location.kind === "world")'
    );
    expect(locationDispatchIndex).toBeGreaterThanOrEqual(0);
    expect(locationDispatchIndex).toBeGreaterThan(worldBranchIndex);
    expect(canonicalLocationHandler).toContain("previous?.kind === \"interior\"");

    const greenhouseMessageHandler = sourceBetween(
      appSource,
      "if (isManorServerMessage(frame)) {",
      "else if (isSalonServerMessage(frame))"
    );
    expect(greenhouseMessageHandler).toContain(
      'frame.type === "GREENHOUSE_STATE"'
    );
    expect(greenhouseMessageHandler).toContain(
      'dispatchStartup({ type: "location" })'
    );
  });

  it("implements the startup paint as a synchronous complete overlay frame", () => {
    const overlaySource = readFileSync(
      new URL("./map/pixiOverlay.ts", import.meta.url),
      "utf8"
    );
    const paintCurrentFrame = sourceBetween(
      overlaySource,
      "paintCurrentFrame(): boolean {",
      "reconcileLocalPlayer(): boolean {"
    );

    expect(paintCurrentFrame).toContain("drawFrame();");
    expect(paintCurrentFrame).not.toContain("requestAnimationFrame");
  });

  it("commits population presentation before reporting its convergence checkpoint", () => {
    const worldHandlerSource = readFileSync(
      new URL("./features/world/useWorldFrameHandler.ts", import.meta.url),
      "utf8"
    );
    const populationHandler = sourceBetween(
      worldHandlerSource,
      'case "POPULATION_ZONE_DELTA": {',
      'case "POPULATION_RESYNC_RESULT"'
    );

    expect(populationHandler.indexOf("overlayRef.current?.update"))
      .toBeLessThan(populationHandler.indexOf("observePopulation"));
  });

  it("keeps an HTML curtain mounted until React has a replacement ready", () => {
    const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    const htmlSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");

    expect(htmlSource).toContain('class="initial-curtain"');
    expect(htmlSource).toContain('href="%BASE_URL%initial-curtain.css"');
    expect(htmlSource).not.toContain("<style>");
    expect(mainSource).not.toContain("replaceChildren");
    expect(mainSource).not.toContain("rootElement.innerHTML");
  });
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
