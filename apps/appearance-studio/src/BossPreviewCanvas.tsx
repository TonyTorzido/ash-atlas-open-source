import {
  resolveBossWeaponTransform,
  type BossAppearanceCatalog,
  type BossAppearanceId,
  type PlayerCombatPoseId
} from "@ash-atlas/shared";
import { BossRenderer, PixiTextureCache } from "@ash-atlas/player-renderer";
import { Application, Container, Graphics } from "pixi.js";
import { useEffect, useRef } from "react";

import { movePivot } from "./PreviewCanvas.js";

export type BossPreviewEditTarget = "weapon" | "pivot" | "overall";

type BossPreviewCanvasProps = {
  catalog: BossAppearanceCatalog;
  bossId: BossAppearanceId;
  poseId: PlayerCombatPoseId;
  revision: number;
  zoom: number;
  actualScale: boolean;
  editTarget: BossPreviewEditTarget;
  onDrag(deltaX: number, deltaY: number): void;
  onDragPivot(
    offsetX: number,
    offsetY: number,
    pivotX: number,
    pivotY: number
  ): void;
};

export function BossPreviewCanvas({
  catalog,
  bossId,
  poseId,
  revision,
  zoom,
  actualScale,
  editTarget,
  onDrag,
  onDragPivot
}: BossPreviewCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<{
    app: Application;
    boss: BossRenderer;
    stage: Container;
    guides: Graphics;
  } | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    pivot?: Parameters<typeof movePivot>[0];
  } | null>(null);
  const onDragRef = useRef(onDrag);
  const onDragPivotRef = useRef(onDragPivot);
  onDragRef.current = onDrag;
  onDragPivotRef.current = onDragPivot;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let initialized = false;
    const app = new Application();
    void app.init({
      resizeTo: host,
      antialias: true,
      autoDensity: true,
      backgroundAlpha: 0,
      resolution: Math.min(window.devicePixelRatio, 2)
    }).then(() => {
      initialized = true;
      if (cancelled) {
        app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
        return;
      }
      app.canvas.className = "preview-canvas";
      host.appendChild(app.canvas);
      const stage = new Container();
      const boss = new BossRenderer({
        bossId,
        catalog,
        textureLoader: new PixiTextureCache(
          (assetKey) => `/boss-appearance-assets/${assetKey}`
        )
      });
      const guides = new Graphics();
      boss.visualRoot.addChild(guides);
      stage.addChild(boss.root);
      app.stage.addChild(stage);
      runtimeRef.current = { app, boss, stage, guides };
      updateBossPreview(
        runtimeRef.current,
        catalog,
        bossId,
        poseId,
        zoom,
        actualScale,
        editTarget
      );
    });
    return () => {
      cancelled = true;
      if (!initialized) return;
      if (runtimeRef.current?.app === app) {
        runtimeRef.current.boss.root.removeFromParent();
        runtimeRef.current.boss.destroy();
        runtimeRef.current = null;
      }
      app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
    };
  }, [bossId]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    updateBossPreview(runtime, catalog, bossId, poseId, zoom, actualScale, editTarget);
  }, [actualScale, bossId, catalog, editTarget, poseId, revision, zoom]);

  return (
    <div
      ref={hostRef}
      className="preview-host"
      tabIndex={0}
      aria-label="Boss appearance preview"
      data-edit-target={editTarget}
      onPointerDown={(event) => {
        if (!catalog.bosses.find((boss) => boss.bossId === bossId)?.weapon.assetKey) return;
        if (editTarget === "overall") return;
        let pivot: Parameters<typeof movePivot>[0] | undefined;
        if (editTarget === "pivot") {
          const runtime = runtimeRef.current;
          if (!runtime || runtime.boss.weapon.texture.width <= 0 ||
            runtime.boss.weapon.texture.height <= 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const scale = zoom * (actualScale ? 1 : 2) * runtime.boss.overallScale;
          const localX = (event.clientX - rect.left - runtime.stage.position.x) / scale;
          const localY = (event.clientY - rect.top - runtime.stage.position.y) / scale;
          const transform = resolveBossWeaponTransform(catalog, bossId, poseId);
          if ((localX - transform.offsetX) ** 2 + (localY - transform.offsetY) ** 2 >
            Math.max(4, 16 / scale) ** 2) return;
          pivot = {
            pivotX: transform.pivotX,
            pivotY: transform.pivotY,
            offsetX: transform.offsetX,
            offsetY: transform.offsetY,
            textureWidth: runtime.boss.weapon.texture.width,
            textureHeight: runtime.boss.weapon.texture.height,
            scaleX: transform.scaleX,
            scaleY: transform.scaleY,
            rotationRadians: transform.rotationDegrees * Math.PI / 180
          };
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          x: event.clientX,
          y: event.clientY,
          ...(pivot ? { pivot } : {})
        };
      }}
      onPointerMove={(event) => {
        const previous = dragRef.current;
        if (!previous) return;
        const scale = zoom * (actualScale ? 1 : 2) *
          (runtimeRef.current?.boss.overallScale ?? 1);
        const deltaX = (event.clientX - previous.x) / scale;
        const deltaY = (event.clientY - previous.y) / scale;
        if (previous.pivot) {
          const result = movePivot(previous.pivot, deltaX, deltaY);
          onDragPivotRef.current(
            result.pivot.offsetX,
            result.pivot.offsetY,
            result.pivot.pivotX,
            result.pivot.pivotY
          );
          dragRef.current = {
            x: event.clientX,
            y: event.clientY,
            pivot: result.pivot
          };
          return;
        }
        onDragRef.current(deltaX, deltaY);
        dragRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
      onDragStart={(event) => event.preventDefault()}
    />
  );
}

function updateBossPreview(
  runtime: {
    app: Application;
    boss: BossRenderer;
    stage: Container;
    guides: Graphics;
  },
  catalog: BossAppearanceCatalog,
  bossId: BossAppearanceId,
  poseId: PlayerCombatPoseId,
  zoom: number,
  actualScale: boolean,
  editTarget: BossPreviewEditTarget
): void {
  runtime.boss.setCatalog(catalog);
  runtime.boss.setPose(poseId);
  const transform = resolveBossWeaponTransform(catalog, bossId, poseId);
  runtime.guides.clear()
    .circle(0, 0, 3)
    .fill({ color: 0x94a3b8, alpha: 0.9 });
  if (editTarget !== "overall") {
    runtime.guides
      .circle(transform.offsetX, transform.offsetY, editTarget === "pivot" ? 3 : 4)
      .fill({
        color: editTarget === "pivot" ? 0xfb7185 : 0x48c8de,
        alpha: 0.95
      });
  }
  const bounds = runtime.app.screen;
  runtime.stage.position.set(bounds.width / 2, bounds.height * 0.72);
  runtime.stage.scale.set(zoom * (actualScale ? 1 : 2));
}
