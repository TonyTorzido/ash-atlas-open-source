import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const theme = readFileSync(fileURLToPath(new URL("../ashAtlasTheme.css", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const plate = readFileSync(
  fileURLToPath(new URL("../ui/WorldActivityTimerPlate.tsx", import.meta.url)),
  "utf8"
);
const droppedItemPrompt = readFileSync(
  fileURLToPath(new URL("../ui/DroppedItemPrompt.tsx", import.meta.url)),
  "utf8"
);
const populationVisibility = readFileSync(
  fileURLToPath(new URL(
    "../population/usePopulationPreparationVisibility.ts",
    import.meta.url
  )),
  "utf8"
);
const populationNotice = readFileSync(
  fileURLToPath(new URL(
    "../population/PopulationPreparationNotice.tsx",
    import.meta.url
  )),
  "utf8"
);
const flagHandler = readFileSync(
  fileURLToPath(new URL("../features/flags/useFlagFrameHandler.ts", import.meta.url)),
  "utf8"
);
const flagBuildHandler = readFileSync(
  fileURLToPath(new URL("../features/flags/flagBuildFrameHandler.ts", import.meta.url)),
  "utf8"
);

describe("world activity timer styling", () => {
  it("removes map-attached timer marker and ghost presentation", () => {
    expect(styles).not.toContain(".flag-build-marker");
    expect(styles).not.toContain(".flag-build-ghost");
    expect(app).not.toContain("createStationBuildMarker");
    expect(app).not.toContain("flagHardeningMarkerRef");
    expect(app).not.toContain("cityConstructionMarkerRef");
    expect(app).not.toContain("cityFlagConversionMarkerRef");
    expect(plate).toContain("WorldActivityTimerGlyph");
  });

  it("owns every compatible activity in the fixed top-center stack", () => {
    expect(styles).toMatch(/\.world-activity-timer-plate\s*\{[^}]*white-space: nowrap/s);
    expect(styles).toMatch(/\.gameplay-status-stack\s*\{[^}]*position: fixed[^}]*z-index: 40[^}]*top: 66px[^}]*left: 50%/s);
    expect(styles).toMatch(/html\[data-ui-profile="phone"\] \.gameplay-status-stack\s*\{[^}]*var\(--hud-chat-height\)/s);
    expect(app).toContain('data-gameplay-status-stack="top-center"');
    expect(app).toContain("<WorldActivityTimerPlate {...worldActivityTimer} />");
    expect(app).not.toContain("flagBuild.position.lon");
    expect(app).not.toContain('cancel.textContent = "Cancel"');
  });

  it("keeps the invalid water preview non-interactive and readable", () => {
    expect(styles).toMatch(/\.flag-placement-preview\s*\{[^}]*pointer-events: none/s);
    expect(styles).toMatch(/\.flag-placement-preview-popup[^}]*\{[^}]*pointer-events: none/s);
    expect(styles).toMatch(/\.flag-placement-preview-reason\s*\{[^}]*max-width: calc\(100cqw - 48px\)/s);
    expect(styles).toMatch(/\.flag-placement-preview-reason\s*\{[^}]*white-space: normal/s);
    expect(styles).toMatch(/\.flag-placement-preview-reason\s*\{[^}]*overflow-wrap: anywhere/s);
  });

  it("keeps placement validation feedback non-interactive and readable", () => {
    expect(styles).not.toContain("flag-placement-validating-popup");
    expect(styles).toMatch(
      /\.flag-placement-validating\s*\{[^}]*background: rgba\(68, 48, 29, 0\.78\)/s
    );
    expect(styles).toMatch(
      /\.flag-placement-validating\s*\{[^}]*border: var\(--aa-ui-border-width\) solid var\(--aa-ui-border\)[^}]*var\(--aa-ui-shadow\)/s
    );
    expect(styles).toMatch(/\.flag-placement-validating\s*\{[^}]*text-align: center/s);
    expect(styles).toMatch(/\.flag-placement-validating\s*\{[^}]*white-space: nowrap/s);
    expect(app).toContain('className="flag-placement-validating"');
    expect(app).toContain('"Preparing location…"');
    expect(app).not.toContain("flagPlacementValidationPopupRef");
  });

  it("shakes rejected flags and pops a temporary crossed-world icon without a message", () => {
    expect(styles).toMatch(
      /\.precision-flag-placement-cursor\s*\{[^}]*position: absolute[^}]*z-index: 1600[^}]*pointer-events: none/s
    );
    expect(styles).toMatch(
      /\.precision-flag-placement-arrow\s*\{[^}]*linear-gradient\(135deg,[^}]*clip-path:/s
    );
    expect(styles).not.toContain(".flag-placement-preview-blocked");
    expect(styles).not.toContain(".flag-placement-rejection-feedback");
    expect(styles).toMatch(
      /\.flag-placement-preview-overlap \.flag-placement-preview-icon\s*\{[^}]*flag-placement-rejected-shake/s
    );
    expect(styles).toMatch(
      /\.flag-placement-location-rejection\s*\{[^}]*flag-placement-location-pop/s
    );
    expect(app).toContain('element.className = "precision-flag-placement-cursor"');
    expect(app).toContain('anchor: "top-left"');
    expect(app).toContain('buildableStatus.previewState !== "overlap"');
    expect(app).toContain("!flagPlacementBlockedPosition");
    expect(app).toContain("flagPlacementBlockedPosition ??");
    expect(app).toContain('locationIcon.className = "flag-placement-location-rejection"');
    expect(app).toContain('flagPlacementRejectionReason ?? "Flag placement unavailable"');
    expect(app).not.toContain("No valid build location");
    expect(app).toContain("2_200");
    expect(app).toContain('const popup = previewState === "overlap"');
  });

  it("uses distinct flag, planner, and queued-build cursor badges", () => {
    expect(app).toContain('const cursorState = !rulerMode ? "flag" : rulerBuildAction ? "build" : "planner"');
    expect(app).toContain('element.dataset.placementCursorState = cursorState');
    expect(app).toContain('badge.dataset.placementBadge = cursorState');
    expect(app).toContain('Measurement cursor. Release to place a point.');
    expect(app).toContain('Queued build cursor. Release to choose its location.');
    expect(app).toContain('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 4 6 6-3 3-6-6 3-3Z"/><path d="m13 9-8 8 2 2 8-8"/></svg>');
    expect(app).toContain('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h11l3 3v12H5v-15Zm11 0v3h3M8 11h8M8 14h8M8 17h5"/></svg>');
    expect(app).not.toContain('flag.textContent = rulerMode ? "\\u2316" : "\\u2691"');
    expect(styles).toMatch(/\.precision-flag-placement-flag svg\s*\{[^}]*width: 18px[^}]*height: 18px[^}]*stroke: currentcolor/s);
  });

  it("uses the compact parchment, leather, bronze, and iron marker treatment", () => {
    expect(styles).toMatch(/\.world-activity-timer-plate\s*\{[^}]*width: min\(89px/s);
    expect(styles).toMatch(/\.world-activity-timer-plate\s*\{[^}]*background: rgba\(68, 48, 29, 0\.78\)/s);
    expect(styles).toMatch(/\.world-activity-timer-progress,[\s\S]*?\.flag-build-progress\s*\{[^}]*height: 5px/s);
    expect(styles).toMatch(/@container mobile-app \(max-width: 480px\)[\s\S]*?\.world-activity-timer-plate/s);
    expect(styles).toMatch(/width: min\(83px, calc\(100cqw - 20px\)\)/s);
    expect(app).toContain(
      'const flagBuildAnchorLabel = flagBuild?.anchorKind === "buoy" ? "Buoy" : "Flag"'
    );
    expect(plate).toContain('className="world-activity-timer-icon"');
    expect(plate).toContain('M6 21V3M7 4h10l-2 4 2 4H7');
    expect(plate).toContain('case "gathering-chopping"');
    expect(plate).toContain('case "gathering-mining"');
    expect(plate).toContain('case "gathering-harvesting"');
    expect(styles).toMatch(/\.world-activity-timer-icon svg\s*\{[^}]*stroke: currentColor/s);
    expect(styles).toMatch(
      /\.world-activity-timer-heading\s*> output\s*\{[^}]*justify-self: center[^}]*text-align: center/s
    );
  });

  it("matches the compact warm preparation plate and progress treatment", () => {
    expect(styles).toMatch(
      /\.gameplay-status-stack\s*\{[^}]*width: min\(232px, calc\(100cqw - 28px\)\)/s
    );
    expect(styles).toMatch(/\.population-preparation-status\s*\{[^}]*width: 100%/s);
    expect(styles).toMatch(
      /\.population-preparation-status\s*\{[^}]*background: rgba\(68, 48, 29, 0\.78\)/s
    );
    expect(styles).toMatch(
      /\.population-preparation-status\s*\{[^}]*border: var\(--aa-ui-border-width\) solid var\(--aa-ui-border\)/s
    );
    expect(styles).toMatch(
      /\.population-preparation-status\s*\{[^}]*var\(--aa-ui-shadow\)/s
    );
    expect(styles).toMatch(
      /\.population-preparation-status\s*> span\s*\{[^}]*justify-content: center[^}]*text-align: center/s
    );
    expect(styles).toMatch(
      /\.population-preparation-progress\s*\{[^}]*height: 5px/s
    );
  });

  it("gives the production dropped-item prompt the approved warm status surface", () => {
    expect(droppedItemPrompt).toContain('className="dropped-item-prompt"');
    expect(theme).toMatch(
      /\.dropped-item-prompt\s*\{[^}]*background: rgba\(68, 48, 29, 0\.78\)/s
    );
    expect(theme).toMatch(
      /\.dropped-item-prompt\s*\{[^}]*border: var\(--aa-ui-border-width\) solid var\(--aa-ui-border\)[^}]*var\(--aa-ui-shadow\)/s
    );
  });

  it("maps city contribution into the fixed activity lane without a map position", () => {
    expect(app).toContain('kind: "city-flag-conversion"');
    expect(app).toContain("activeCityFlagConversion.flagName");
    expect(app).toContain("activeCityFlagConversion.cityName");
    expect(app).not.toContain("activeCityFlagConversion.position.lon");
  });

  it("maps every timed construction channel through the shared plate", () => {
    for (const kind of [
      "flag-hardening",
      "furnace",
      "tannery",
      "loom",
      "kitchen",
      "fishing-hut",
      "manor",
      "kingdom-seat",
      "city-construction",
      "greenhouse"
    ]) {
      expect(app).toContain(`kind: "${kind}"`);
    }
  });

  it("ticks all activity deadlines through React state instead of marker DOM", () => {
    expect(app).toContain("setFlagBuildClock(performance.now()), 50");
    expect(app).toContain("!greenhouseFeature.build");
    expect(app).toMatch(/greenhouseFeature\.build,\s+greenhousePlanterAction,\s+tanneryConstruction/);
    expect(app).not.toContain("querySelector<HTMLElement>(\".flag-build-progress\")");
    expect(app).not.toContain("new maplibregl.Marker({ element, anchor: \"bottom\", offset: [0, -34] }");
  });

  it("does not retain blue preparation cards or normal build-start toasts", () => {
    const validatingStyles = styles.match(/\.flag-placement-validating\s*\{[^}]*\}/s)?.[0] ?? "";
    const buildStyles = styles.match(/\.world-activity-timer-plate\s*\{[^}]*\}/s)?.[0] ?? "";
    const errorNoticeStyles = styles.match(
      /\.action-error-notice,\s*\.action-success-notice\s*\{[^}]*\}/s
    )?.[0] ?? "";
    expect(validatingStyles).not.toMatch(/56 189 248|8 47 73|#e0f2fe/);
    expect(buildStyles).not.toMatch(/2 6 23|#0(?:2|8)2f/);
    expect(errorNoticeStyles).not.toMatch(/125, 211, 252|8, 47, 73|#e0f2fe/);
    expect(errorNoticeStyles).toMatch(
      /#e7dcc2|180 157 117|var\(--aa-ui-parchment-100\)/
    );
    expect(app).not.toContain('showActionError(quote ? "Validating placement');
    expect(app).not.toContain('"Moving to edge — flag build queued"');
    for (const source of [flagHandler, flagBuildHandler]) {
      expect(source).not.toContain("Flag queued. Construction will start");
      expect(source).not.toContain('showActionError("Constructing flag');
    }
    expect(flagBuildHandler).toContain("message.flagName");
  });

  it("uses the hardening deadline and activity icon without a map marker", () => {
    expect(app).toContain('kind: "flag-hardening"');
    expect(app).toContain("flagHardening.targetTier");
    expect(app).toContain("flagHardening.countdown");
    expect(app).not.toContain("flagHardening.position");
  });

  it("shows real current-wilds progress without flashing warm destinations", () => {
    expect(app).toContain("setPopulationPreparationProgress");
    expect(populationVisibility).toMatch(
      /progress\.status === "pending"[\s\S]*?progress\.total > 0[\s\S]*?progress\.completed < progress\.total/
    );
    expect(app).toContain("PopulationPreparationNotice");
    expect(populationNotice).toContain("usePopulationPreparationVisibility");
    expect(populationVisibility).toContain(
      "POPULATION_PREPARATION_VISIBILITY_DELAY_MS = 180"
    );
    expect(populationNotice).toContain("`${percent}%`");
    expect(populationNotice).toContain("populationPreparationCopy");
    expect(populationNotice).toContain("Restoring nearby wildlife…");
    expect(populationNotice).not.toContain("Preparing surroundings");
    expect(styles).toMatch(
      /\.population-preparation-progress\s*\{[^}]*height: 5px/s
    );
  });
});
