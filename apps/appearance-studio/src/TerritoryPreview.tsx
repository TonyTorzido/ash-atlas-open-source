import { Application, Assets, Container, Graphics, Text, type Texture } from "pixi.js";
import { useEffect, useRef, useState } from "react";
import {
  TERRITORY_STRUCTURE_REFERENCE_HEIGHT,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  playerOverallScale,
  playerTemplateTransform,
  territoryStructureInteractionBounds,
  territoryStructurePieceBounds,
  territoryStructureVisual,
  type TerritoryStructureCatalog,
  type TerritoryStructureType
} from "@ash-atlas/shared";
import { createTerritoryStructureRoot } from "../../client/src/map/territoryStructureRenderer.js";
import { SPRITE_BASE_ZOOM, SPRITE_PRESENTATION, spriteHeightForZoom, spriteLayoutForZoom } from "../../client/src/map/spritePresentation.js";

type Props = {
  catalog: TerritoryStructureCatalog;
  structureType: TerritoryStructureType;
  packId: string;
  showBounds: boolean;
  showAnchor: boolean;
  showPieces: boolean;
  burning: boolean;
  emblem: boolean;
  tint: string;
  mapZoom: number;
  magnification: number;
  selectedComponent: string | null;
  soloComponent: boolean;
};

export function TerritoryPreview(props: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Application | null>(null);
  const frameRef = useRef({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
  const [ready, setReady] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadingArt, setLoadingArt] = useState(true);
  const [tapResult, setTapResult] = useState("Tap any part of the structure to check its interaction area.");
  useEffect(() => {
    setTapResult("Tap any part of the structure to check its interaction area.");
  }, [props.structureType, props.packId]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const app = new Application();
    let disposed = false;
    let initialized = false;
    let observer: ResizeObserver | undefined;
    void app.init({
      resizeTo: host, backgroundAlpha: 0, antialias: true, autoStart: false,
      resolution: Math.min(globalThis.devicePixelRatio || 1, 2), autoDensity: true
    }).then(() => {
      initialized = true;
      if (disposed) { app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true }); return; }
      host.appendChild(app.canvas);
      runtimeRef.current = app;
      setReady((value) => value + 1);
      observer = new ResizeObserver(() => {
        app.resize();
        setReady((value) => value + 1);
      });
      observer.observe(host);
    }).catch((caught: unknown) => { if (!disposed) setError(String(caught)); });
    return () => {
      disposed = true;
      observer?.disconnect();
      runtimeRef.current = null;
      if (initialized) app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
    };
  }, []);

  useEffect(() => {
    const app = runtimeRef.current;
    if (!app) return;
    const visual = territoryStructureVisual(props.structureType, props.packId, props.catalog);
    let cancelled = false;
    void Promise.all(visual.pieces.map(async (piece) => [
      piece.asset, await Assets.load<Texture>(`/runtime-assets/${piece.asset}?revision=${props.catalog.revision}`)
    ] as const)).then((loaded) => {
      if (cancelled) return;
      setError(null);
      for (const child of app.stage.removeChildren()) child.destroy({ children: true });
      const textures = Object.fromEntries(loaded);
      const stage = new Container();
      const layout = spriteLayoutForZoom(
        app.screen.width * 0.4, app.screen.height * 0.78,
        TERRITORY_STRUCTURE_REFERENCE_HEIGHT, props.mapZoom, SPRITE_PRESENTATION.flag
      );
      frameRef.current = { ...layout, scaleX: layout.scaleX * props.magnification, scaleY: layout.scaleY * props.magnification };
      stage.position.set(layout.x, layout.y);
      stage.scale.set(frameRef.current.scaleX, frameRef.current.scaleY);
      const line = 1 / Math.max(stage.scale.y, 0.01);
      stage.addChild(new Graphics().moveTo(-200, 0).lineTo(200, 0).stroke({ color: 0x91a0b5, width: line, alpha: 0.45 }));
      const root = createTerritoryStructureRoot(visual, (asset) => textures[asset]!, {
        controlColor: Number.parseInt(props.tint.slice(1), 16),
        burning: props.burning,
        ...(props.emblem ? { emblem: "K" } : {})
      });
      if (props.soloComponent && props.selectedComponent) {
        for (const child of root.children) child.visible = child.label === props.selectedComponent;
      }
      stage.addChild(root);
      const guides = new Graphics();
      if (props.showPieces) {
        for (const piece of territoryStructurePieceBounds(visual)) {
          guides.rect(piece.left, piece.top, piece.width, piece.height).stroke({ color: 0x91a0b5, width: line, alpha: piece.visible ? 1 : 0.4 });
        }
      }
      if (props.showBounds) {
        const hit = territoryStructureInteractionBounds(props.structureType, props.catalog);
        guides.rect(hit.left, hit.top, hit.right - hit.left, hit.bottom - hit.top)
          .fill({ color: 0xe5b94d, alpha: 0.12 }).stroke({ color: 0xe5b94d, width: line * 2 });
      }
      if (props.showAnchor) {
        guides.moveTo(-4, 0).lineTo(4, 0).moveTo(0, -4).lineTo(0, 4)
          .stroke({ color: 0x48c8de, width: line * 2 }).circle(0, 0, 1).fill(0x48c8de);
      }
      const selected = root.children.find((child) => child.label === props.selectedComponent);
      if (selected) {
        const bounds = selected.getLocalBounds();
        guides.rect(
          visual.root.offsetX + (selected.x + bounds.x * selected.scale.x) * visual.root.scale,
          visual.root.offsetY + (selected.y + bounds.y * selected.scale.y) * visual.root.scale,
          bounds.width * selected.scale.x * visual.root.scale,
          bounds.height * selected.scale.y * visual.root.scale
        ).stroke({ color: 0x48c8de, width: line * 2 });
      }
      stage.addChild(guides);
      app.stage.addChild(stage);
      const playerHeight = spriteHeightForZoom(props.mapZoom, SPRITE_BASE_ZOOM, SPRITE_PRESENTATION.player) *
        playerOverallScale(DEFAULT_PLAYER_APPEARANCE_CATALOG, "default") *
        playerTemplateTransform(DEFAULT_PLAYER_APPEARANCE_CATALOG, "default", "idle").scale;
      const rulerX = app.screen.width - 28;
      const rulerTop = layout.y - playerHeight * props.magnification;
      app.stage.addChild(new Graphics().moveTo(rulerX, rulerTop).lineTo(rulerX, layout.y)
        .moveTo(rulerX - 5, rulerTop).lineTo(rulerX + 5, rulerTop)
        .moveTo(rulerX - 5, layout.y).lineTo(rulerX + 5, layout.y)
        .stroke({ color: 0x91a0b5, width: 1 }));
      const rulerLabel = new Text({ text: "Player", style: { fill: 0x91a0b5, fontSize: 12, fontFamily: "system-ui, sans-serif" } });
      rulerLabel.anchor.set(1, 0.5);
      rulerLabel.position.set(rulerX - 9, (layout.y + rulerTop) / 2);
      app.stage.addChild(rulerLabel);
      app.render();
      setLoadingArt(false);
    }).catch((caught: unknown) => { if (!cancelled) setError(`Preview unavailable: ${String(caught)}`); });
    return () => { cancelled = true; };
  }, [props, ready]);

  const name = props.catalog.structures[props.structureType]!.displayName;
  return <div className="territory-preview-wrap">
    <div ref={hostRef} className="territory-preview" role="img"
      aria-label={`${name} live game composition with ground anchor and interaction bounds`}
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const frame = frameRef.current;
        const hit = territoryStructureInteractionBounds(props.structureType, props.catalog, frame.x, frame.y, frame.scaleX, frame.scaleY);
        const x = event.clientX - rect.left, y = event.clientY - rect.top;
        setTapResult(x >= hit.left && x <= hit.right && y >= hit.top && y <= hit.bottom ? `Selected ${name}` : "Outside interaction area");
      }} />
    {loadingArt && !error ? <p role="status" className="territory-preview-loading">Loading artwork…</p> : null}
    {error && <p role="alert" className="connection-error">{error}</p>}
    <p role="status" className="empty-copy">{tapResult}</p>
    <small>Gold: tap area · Cyan: fixed ground anchor and selected component · Grey: piece bounds. Solo is preview-only. Player ruler uses the current base appearance scale. {props.magnification}× inspection at map zoom {props.mapZoom} (base {SPRITE_BASE_ZOOM}).</small>
  </div>;
}
