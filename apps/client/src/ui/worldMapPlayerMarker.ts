import type { PlayerAppearanceSnapshot } from "@ash-atlas/shared";
import {
  PixiTextureCache,
  PlayerRenderer,
  playerDisplayColorNumber
} from "@ash-atlas/player-renderer";
import { playerAppearanceAssetUrl } from "@ash-atlas/player-renderer/asset-registry";
import { Application } from "pixi.js";
import {
  playerMapMarkerRootScaleForRenderer
} from "../map/spritePresentation.js";
import { playerLayerResolution } from "../perf/renderQuality.js";

const MARKER_WIDTH_PX = 36;
const MARKER_HEIGHT_PX = 36;
const MARKER_GROUND_PADDING_PX = 4;
const MARKER_TOP_PADDING_PX = 2;
const renderResolution = playerLayerResolution;

export const WORLD_MAP_REMOTE_PLAYER_SCALE = 0.75;

export function worldMapPlayerMarkerRenderHeight(
  boundsY: number,
  playerScale: number
): number {
  return Math.max(
    MARKER_HEIGHT_PX,
    Math.ceil(
      MARKER_GROUND_PADDING_PX
      - boundsY * playerScale
      + MARKER_TOP_PADDING_PX
    )
  );
}

export type WorldMapPlayerMarkerElement = Readonly<{
  outer: HTMLDivElement;
  inner: HTMLDivElement;
  destroy(): void;
}>;

export type WorldMapPlayerMarkerOptions = Readonly<{
  ariaLabel?: string;
  className?: string;
  label?: string;
  local?: boolean;
  scaleMultiplier?: number;
}>;

export function createWorldMapPlayerMarkerElement(
  displayColor: string | null,
  appearance?: PlayerAppearanceSnapshot,
  options: WorldMapPlayerMarkerOptions = {}
): WorldMapPlayerMarkerElement {
  const outer = document.createElement("div");
  outer.className = options.className ?? "world-map-player-marker";
  outer.setAttribute("role", "img");
  outer.setAttribute(
    "aria-label",
    options.ariaLabel ?? "Your approximate location"
  );

  const inner = document.createElement("div");
  inner.className = "world-map-player-marker-model";
  inner.style.setProperty(
    "--player-display-color",
    displayColor ?? "#38bdf8"
  );
  outer.append(inner);
  if (options.label) {
    const label = document.createElement("strong");
    label.textContent = options.label;
    outer.append(label);
  }

  const scaleMultiplier = options.scaleMultiplier ?? 1;
  const local = options.local ?? true;

  const app = new Application();
  let initialized = false;
  let destroyed = false;
  let renderer: PlayerRenderer | null = null;
  void app.init({
    width: MARKER_WIDTH_PX,
    height: MARKER_HEIGHT_PX,
    backgroundAlpha: 0,
    antialias: true,
    autoStart: false,
    sharedTicker: false,
    resolution: renderResolution(),
    roundPixels: true
  }).then(() => {
    initialized = true;
    app.stop();
    app.ticker.stop();
    if (destroyed) {
      app.destroy(
        { removeView: true, releaseGlobalResources: false },
        { children: true }
      );
      return;
    }
    renderer = new PlayerRenderer({
      local,
      color: playerDisplayColorNumber(displayColor),
      textureLoader: new PixiTextureCache(playerAppearanceAssetUrl),
      diagnostic: (message, detail) => console.warn(message, detail)
    });
    renderer.root.scale.set(
      playerMapMarkerRootScaleForRenderer(renderer.overallScale) * scaleMultiplier
    );
    app.canvas.className = "world-map-player-marker-canvas";
    app.stage.addChild(renderer.root);
    inner.replaceChildren(app.canvas);
    const activeRenderer = renderer;
    void activeRenderer.updateAppearance(appearance).then(() => {
      if (destroyed || renderer !== activeRenderer) return;
      const markerRootScale = playerMapMarkerRootScaleForRenderer(
        activeRenderer.overallScale
      ) * scaleMultiplier;
      activeRenderer.root.scale.set(markerRootScale);
      const renderHeight = worldMapPlayerMarkerRenderHeight(
        activeRenderer.root.getLocalBounds().y,
        markerRootScale
      );
      app.renderer.resize(MARKER_WIDTH_PX, renderHeight);
      activeRenderer.root.position.set(
        MARKER_WIDTH_PX / 2,
        renderHeight - MARKER_GROUND_PADDING_PX
      );
      app.render();
    });
  }).catch((error: unknown) => {
    console.warn("World Map player marker could not be rendered", error);
  });

  return {
    outer,
    inner,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (!initialized) return;
      renderer?.root.removeFromParent();
      renderer?.destroy();
      renderer = null;
      app.destroy(
        { removeView: true, releaseGlobalResources: false },
        { children: true }
      );
    }
  };
}
