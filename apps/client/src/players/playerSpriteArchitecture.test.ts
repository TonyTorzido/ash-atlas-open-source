import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("shared player visual architecture", () => {
  it("keeps the world renderer on the canonical player-renderer package", () => {
    const world = source("../map/pixiOverlay.ts");
    expect(world).toContain('from "@ash-atlas/player-renderer"');
    expect(world).toContain("new PlayerRenderer");
    expect(world).not.toContain("function createPlayerSprite");
    expect(world).toContain("releaseGlobalResources: false");
  });

  it("draws the afloat raft behind the world body and never indoors", () => {
    const world = source("../map/pixiOverlay.ts");
    const sprite = source("./playerSprite.ts");
    expect(world).toContain("new PlayerRaft()");
    expect(world.indexOf("container.addChild(raft.root)")).toBeLessThan(world.indexOf("container.addChild(artwork,"));
    expect(world).toContain("afloat: player.afloat === true && !latestState.interior");
    expect(world).toContain("rendered.raft.destroy()");
    expect(sprite).toContain("PLAYER_RAFT_PRESENTATION");
    expect(sprite).toContain("../assets/water/raft.png");
  });

  it("delegates every interior actor wrapper to IndoorPlayerLayer", () => {
    const manor = source("../ui/ManorPlayerLayer.tsx");
    const salonScene = source("../ui/SalonScene.tsx");
    const salon = source("../ui/SalonPlayerLayer.tsx");
    const dungeon = source("../ui/DungeonEntityLayer.tsx");
    const greenhouse = source("../ui/GreenhousePlayerLayer.tsx");
    const greenhouseScene = source("../ui/GreenhouseScene.tsx");

    expect(manor).toContain('from "./IndoorPlayerLayer.js"');
    expect(manor).toContain("<IndoorPlayerLayer");
    expect(salonScene).toContain("<SalonPlayerLayer");
    expect(salon).toContain('from "./IndoorPlayerLayer.js"');
    expect(salon).toContain("<IndoorPlayerLayer");
    expect(dungeon).toContain('from "./IndoorPlayerLayer.js"');
    expect(dungeon).toContain("<IndoorPlayerLayer");
    expect(dungeon).toContain("DungeonMovementTimeline");
    expect(dungeon).toContain("useLayoutEffect");
    expect(dungeon).toContain("positionSource={positionSourceRef.current}");
    expect(greenhouse).toContain('from "./IndoorPlayerLayer.js"');
    expect(greenhouse).toContain("<IndoorPlayerLayer");
    expect(greenhouse).toContain("GreenhouseMovementTimeline");
    expect(greenhouse).toContain("positionSource={positionSourceRef.current}");
    expect(greenhouseScene).toContain("<GreenhousePlayerLayer");
    expect(greenhouseScene).toContain("greenhouse-self");
    expect(greenhouseScene).toContain("Exit Greenhouse");
    expect(greenhouseScene).not.toContain("greenhouse-player-marker");
  });

  it("keeps renderer, appearance, positioning, high-DPI, and cleanup ownership canonical", () => {
    const layer = source("../ui/IndoorPlayerLayer.tsx");
    const manorFeature = source("../features/manor/useManorFeature.ts");

    expect(layer).toContain('from "@ash-atlas/player-renderer"');
    expect(layer).toContain("new PlayerRenderer");
    expect(layer).toContain("updateAppearance");
    expect(layer).toContain("current.positionSource.render(now)");
    expect(layer).not.toContain("reportCameraPosition");
    expect(layer).toContain("x / roomWidth * app.screen.width");
    expect(layer).toContain("y / roomHeight * app.screen.height");
    expect(layer).toContain("playerVisualHeightUnits / renderer.baseHeightPx");
    expect(layer).toContain("resolution: renderResolution()");
    expect(layer).toContain("roundPixels: false");
    expect(layer).not.toContain("Math.round(x / roomWidth");
    expect(layer).not.toContain("Math.round(y / roomHeight");
    expect(layer).toContain("diagnostic: (message, detail) => console.warn(message, detail)");
    expect(layer).toContain("releaseGlobalResources: false");
    expect(layer).toContain("window.cancelAnimationFrame(frameId)");
    expect(layer).toContain("observer.disconnect()");
    expect(layer).toContain("root.removeFromParent()");
    expect(layer).toContain("renderer.destroy()");
    expect(manorFeature).toContain("displayColorRef.current = message.displayColor");
  });
});
