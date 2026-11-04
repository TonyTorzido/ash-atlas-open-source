import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const overlaySource = readFileSync(new URL("./pixiOverlay.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("flag visibility architecture", () => {
  it("keeps gameplay territory and selected-flag rendering independent of developer views", () => {
    expect(overlaySource).toContain(
      "renderTerritoryLayer(map, territoryLayer, getCachedTerritoryGroups(visibleState));"
    );
    expect(overlaySource).toContain("if (selectedFlag) {");
    expect(overlaySource).not.toContain("developerFlagRadii");
    expect(appSource).not.toContain("flagRadiiEnabled");
  });

  it("keeps saved planning overlays visible in Select mode without enabling pencil editing", () => {
    expect(appSource).toContain(
      "const planningOverlayActive = rulerMode && planningBuilderMode !== \"pencil\";"
    );
    expect(appSource).toContain("planningOverlayActive ? planningAnchorLines : []");
    expect(appSource).toContain("planningOverlayActive ? visiblePlanningAnchors : []");
    expect(appSource).toContain(
      "if (rulerModeRef.current && planningBuilderModeRef.current === \"select\")"
    );
    expect(appSource).toContain(
      "const pickedMilitaryGroup = overlayRef.current?.pickMilitaryGroupAt(event.point) ?? null;"
    );
  });

  it("uses runtime presentation anchors for buoy layers and Castle sprites", () => {
    expect(overlaySource).toMatch(
      /color\.anchor\.set\(\s*WORLD_SPRITE_PRESENTATION\.buoy\.anchorX,\s*WORLD_SPRITE_PRESENTATION\.buoy\.anchorY\s*\)/u
    );
    expect(overlaySource).toMatch(
      /hardware\.anchor\.set\(\s*WORLD_SPRITE_PRESENTATION\.buoy\.anchorX,\s*WORLD_SPRITE_PRESENTATION\.buoy\.anchorY\s*\)/u
    );
    expect([...overlaySource.matchAll(
      /(?:shadow|marker)\.anchor\.set\(\s*WORLD_SPRITE_PRESENTATION\.kingdomSeat\.anchorX,\s*WORLD_SPRITE_PRESENTATION\.kingdomSeat\.anchorY\s*\)/gu
    )]).toHaveLength(2);
    expect(overlaySource).not.toContain("anchor.set(0.5, 0.856)");
  });

  it("uses a small green target reticle for every Siege target", () => {
    expect(overlaySource).toContain("const siegePreviewFlagIds = new Set([");
    expect(overlaySource).toContain("...siegeTargetFlagIds(selectedSiege, state.flags)");
    expect(overlaySource).toContain("const marker = new Graphics();");
    expect(overlaySource).toMatch(/siegePreviewFlagIds[\s\S]*?color: 0x22c55e/u);
    expect(overlaySource).toContain(".circle(point.x, point.y, 16)");
    expect(overlaySource).toContain('marker.eventMode = "none";');
    expect(overlaySource).not.toContain("point.y - 36");
  });

  it("rounds territory outline joins so shared vertices do not leave hairline gaps", () => {
    expect(overlaySource).toMatch(
      /zoneSeams\.stroke\(\{[^}]*cap: "round", join: "round"/u
    );
    expect(overlaySource).toMatch(
      /outerBoundary\.stroke\(\{[^}]*cap: "round", join: "round"/u
    );
  });
});
