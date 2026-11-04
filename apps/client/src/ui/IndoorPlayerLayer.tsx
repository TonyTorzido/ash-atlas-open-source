import {
  createPlayerWalkMotionState,
  observePlanarWalkMotion,
  type PlayerWalkMotionState
} from "../map/playerWalkMotion.js";
import { interiorLocalToLngLat, type PlayerAppearanceSnapshot, type PlayerCombatPoseId } from "@ash-atlas/shared";
import {
  PixiTextureCache,
  PlayerRenderer,
  playerDisplayColorNumber
} from "@ash-atlas/player-renderer";
import { playerAppearanceAssetUrl } from "@ash-atlas/player-renderer/asset-registry";
import { Application } from "pixi.js";
import { useContext, useEffect, useRef } from "react";

import { localMoveInput } from "../movement/localMoveInput.js";
import { createJacketRig, type JacketRig } from "../players/jacketRig.js";

import { IndoorPresentationClock } from "./IndoorPresentationClock.js";
import { playerLayerResolution } from "../perf/renderQuality.js";

export type IndoorRenderedActorPosition = Readonly<{ x: number; y: number }>;
export type IndoorPositionSource = Readonly<{
  render(now: number): IndoorRenderedActorPosition | null;
}>;
export type IndoorRemoteActor = Readonly<{
  playerId: string;
  x: number;
  y: number;
  displayColor: string | null;
  appearance?: PlayerAppearanceSnapshot;
}>;
export type IndoorPoseResolver = (playerId: string, nowMs: number) => PlayerCombatPoseId;

const renderResolution = playerLayerResolution;
/** Every indoor profile draws the player at this height (docs/architecture/INTERIOR_MAP_RENDERER.md). */
const INTERIOR_PLAYER_HEIGHT_M = 33.65;
const lifecycle = {
  applicationsCreated: 0,
  activeApplications: 0,
  activeAnimationLoops: 0,
  activeObservers: 0,
  rendererResizes: 0,
  renderedFrames: 0
};

export function indoorPlayerLayerDebugSnapshot(): Readonly<typeof lifecycle> {
  return { ...lifecycle };
}

export function IndoorPlayerLayer({
  roomWidth,
  roomHeight,
  playerVisualHeightUnits,
  positionSource,
  displayColor,
  appearance,
  remoteActors = [],
  poseFor,
  localPlayerId = "",
  className,
  canvasClassName,
  ariaLabel
}: {
  roomWidth: number;
  roomHeight: number;
  playerVisualHeightUnits: number;
  positionSource: IndoorPositionSource;
  displayColor: string | null;
  appearance?: PlayerAppearanceSnapshot;
  remoteActors?: readonly IndoorRemoteActor[];
  poseFor?: IndoorPoseResolver;
  localPlayerId?: string;
  className: string;
  canvasClassName: string;
  ariaLabel: string;
}): React.JSX.Element {
  const presentationNow = useContext(IndoorPresentationClock);
  const hostRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef({ positionSource, appearance, remoteActors, poseFor, localPlayerId, presentationNow });
  const appRef = useRef<Application | null>(null);
  const localRendererRef = useRef<PlayerRenderer | null>(null);
  currentRef.current = { positionSource, appearance, remoteActors, poseFor, localPlayerId, presentationNow };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let initialized = false;
    let frameId: number | null = null;
    let observer: ResizeObserver | null = null;
    let localRenderer: PlayerRenderer | null = null;
    const app = new Application();
    const remotes = new Map<string, {
      renderer: PlayerRenderer;
      appearanceRevision: number | undefined;
      displayColor: string | null;
      walkMotion: PlayerWalkMotionState;
    }>();
    const localWalkMotion = createPlayerWalkMotionState();
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    // Interiors draw the same Jacket B player as the overworld overlay: the rig sits in the player artwork
    // and hides the legacy drawn body once its sheets are ready (same hand-off as map/pixiOverlay.ts).
    const metersPerUnit = INTERIOR_PLAYER_HEIGHT_M / playerVisualHeightUnits;
    const rigs = new Map<PlayerRenderer, JacketRig>();
    const attachRig = (renderer: PlayerRenderer, seed: string): void => {
      const rig = createJacketRig(seed, renderResolution());
      if (!rig) return;
      renderer.root.addChild(rig.root);
      rigs.set(renderer, rig);
    };
    const detachRig = (renderer: PlayerRenderer): void => {
      rigs.get(renderer)?.destroy();
      rigs.delete(renderer);
    };
    const stepWalk = (
      renderer: PlayerRenderer,
      motion: PlayerWalkMotionState,
      x: number,
      y: number,
      now: number,
      local: boolean
    ): void => {
      const walking = !reducedMotion && observePlanarWalkMotion(
        motion, x, y, playerVisualHeightUnits, now
      );
      if (walking || renderer.walkAnimating) {
        renderer.setLocomotion(walking);
        renderer.updateAnimation(now);
      }
      const rig = rigs.get(renderer);
      if (!rig) return;
      const position = interiorLocalToLngLat({ x, y }, metersPerUnit);
      rig.update({
        lat: position.lat,
        lon: position.lon,
        walking,
        nowMs: now,
        bearingDeg: 0,
        targetHeight: renderer.baseHeightPx * renderer.overallScale,
        inputX: local && localMoveInput.active ? localMoveInput.dx : null
      });
      renderer.visualRoot.visible = !rig.ready;
    };
    lifecycle.applicationsCreated += 1;

    const initialize = async (): Promise<void> => {
      await app.init({
        width: Math.max(1, host.clientWidth),
        height: Math.max(1, host.clientHeight),
        backgroundAlpha: 0,
        antialias: true,
        autoStart: false,
        sharedTicker: false,
        resolution: renderResolution(),
        roundPixels: false
      });
      initialized = true;
      app.stop();
      app.ticker.stop();
      if (disposed) {
        app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
        return;
      }
      lifecycle.activeApplications += 1;
      appRef.current = app;
      app.canvas.className = canvasClassName;
      host.replaceChildren(app.canvas);
      const textures = new PixiTextureCache(playerAppearanceAssetUrl);
      localRenderer = new PlayerRenderer({
        local: true,
        color: playerDisplayColorNumber(displayColor),
        textureLoader: textures,
        diagnostic: (message, detail) => console.warn(message, detail)
      });
      localRendererRef.current = localRenderer;
      await localRenderer.updateAppearance(currentRef.current.appearance);
      if (disposed) return;
      app.stage.addChild(localRenderer.root);
      attachRig(localRenderer, "indoor-local");
      let renderedWidth = -1;
      let renderedHeight = -1;
      const resize = (): void => {
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        if (width === renderedWidth && height === renderedHeight) return;
        renderedWidth = width;
        renderedHeight = height;
        app.renderer.resize(width, height);
        lifecycle.rendererResizes += 1;
      };
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(host);
      lifecycle.activeObservers += 1;
      const renderFrame = (frameNow: number): void => {
        if (disposed) return;
        const current = currentRef.current;
        const now = current.presentationNow?.() ?? frameNow;
        const localPosition = current.positionSource.render(now);
        if (localPosition) {
          localRenderer!.setPose?.(current.poseFor?.(current.localPlayerId, now) ?? "idle");
          positionActor(
            localRenderer!, app, roomWidth, roomHeight, playerVisualHeightUnits,
            localPosition.x, localPosition.y
          );
          stepWalk(localRenderer!, localWalkMotion, localPosition.x, localPosition.y, now, true);
        }
        const desired = new Set<string>();
        for (const actor of current.remoteActors) {
          desired.add(actor.playerId);
          let record = remotes.get(actor.playerId);
          if (!record || record.displayColor !== actor.displayColor) {
            if (record) {
              detachRig(record.renderer);
              record.renderer.root.removeFromParent();
              record.renderer.destroy();
            }
            const renderer = new PlayerRenderer({
              local: false,
              color: playerDisplayColorNumber(actor.displayColor),
              textureLoader: textures
            });
            record = {
              renderer,
              appearanceRevision: actor.appearance?.revision,
              displayColor: actor.displayColor,
              walkMotion: createPlayerWalkMotionState()
            };
            remotes.set(actor.playerId, record);
            app.stage.addChild(renderer.root);
            attachRig(renderer, `indoor-${actor.playerId}`);
            void renderer.updateAppearance(actor.appearance);
          } else if (record.appearanceRevision !== actor.appearance?.revision) {
            record.appearanceRevision = actor.appearance?.revision;
            void record.renderer.updateAppearance(actor.appearance);
          }
          record.renderer.setPose?.(current.poseFor?.(actor.playerId, now) ?? "idle");
          positionActor(
            record.renderer, app, roomWidth, roomHeight, playerVisualHeightUnits,
            actor.x, actor.y
          );
          stepWalk(record.renderer, record.walkMotion, actor.x, actor.y, now, false);
        }
        for (const [playerId, record] of remotes) {
          if (desired.has(playerId)) continue;
          detachRig(record.renderer);
          record.renderer.root.removeFromParent();
          record.renderer.destroy();
          remotes.delete(playerId);
        }
        app.render();
        lifecycle.renderedFrames += 1;
        frameId = window.requestAnimationFrame(renderFrame);
      };
      lifecycle.activeAnimationLoops += 1;
      frameId = window.requestAnimationFrame(renderFrame);
    };
    void initialize();

    return () => {
      disposed = true;
      appRef.current = null;
      localRendererRef.current = null;
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        lifecycle.activeAnimationLoops -= 1;
      }
      if (observer) {
        observer.disconnect();
        lifecycle.activeObservers -= 1;
      }
      if (localRenderer) detachRig(localRenderer);
      localRenderer?.root.removeFromParent();
      localRenderer?.destroy();
      for (const record of remotes.values()) {
        detachRig(record.renderer);
        record.renderer.root.removeFromParent();
        record.renderer.destroy();
      }
      if (initialized) {
        lifecycle.activeApplications -= 1;
        app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
      }
    };
  }, [canvasClassName, displayColor, playerVisualHeightUnits, roomHeight, roomWidth]);

  useEffect(() => {
    const renderer = localRendererRef.current;
    const app = appRef.current;
    if (!renderer || !app) return;
    void renderer.updateAppearance(appearance).then(() => {
      if (localRendererRef.current === renderer && appRef.current === app) app.render();
    });
  }, [appearance?.revision]);

  return <div ref={hostRef} className={className} aria-label={ariaLabel} />;
}

function positionActor(
  renderer: PlayerRenderer,
  app: Application,
  roomWidth: number,
  roomHeight: number,
  playerVisualHeightUnits: number,
  x: number,
  y: number
): void {
  const root = renderer.root;
  root.position.set(
    x / roomWidth * app.screen.width,
    y / roomHeight * app.screen.height
  );
  root.scale.set(
    Math.min(app.screen.width / roomWidth, app.screen.height / roomHeight) *
    playerVisualHeightUnits / renderer.baseHeightPx
  );
}
