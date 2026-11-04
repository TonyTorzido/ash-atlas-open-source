import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  DEFAULT_PROJECTILE_TRANSFORM,
  EQUIPMENT_DEFINITIONS,
  salonAppearanceCategory,
  playerOverlaySlotForFamily,
  equipmentGemSocket,
  faceFeaturePointInPolygon,
  faceFeaturePolygonIssue,
  isFaceFeatureCategory,
  playerBodyPose,
  resolveAppearanceLocalTransform,
  type AppearanceDefinition,
  type AppearanceDefinitionId,
  type AppearancePartId,
  type EquipmentAppearanceEnhancement,
  type FaceFeatureArea,
  type PlayerAnchorPoint,
  type PlayerAttachmentAnchorId,
  type PlayerCombatPoseId,
  type PlayerSkinToneId,
  type PlayerAppearanceCatalog,
  type PlayerAppearanceSnapshot,
  type ProjectileTransform,
  type RuntimePngInteractionGeometry
} from "@ash-atlas/shared";
import {
  PixiTextureCache,
  PlayerRenderer,
  resolveProjectileSpriteTransform,
  type ProjectileSpriteTransform
} from "@ash-atlas/player-renderer";
import { Application, Container, Graphics, Sprite } from "pixi.js";
import { useEffect, useRef } from "react";

export type PreviewEditTarget =
  "item" | "pivot" | "gem" | "projectile" | "projectile_impact" | "projectile_tail" |
  "overall" | "template" | "main" | "anchors" | "feature_anchor" | "feature_area";

/** Face-feature authoring state: the selected item's category area and chosen vertex. */
export type PreviewFeatureState = Readonly<{
  area: FaceFeatureArea | null;
  selectedVertex: number | null;
}>;
const FEATURE_HANDLE_RADIUS_PX = 10;

type PreviewCanvasProps = {
  catalog: PlayerAppearanceCatalog;
  selected: AppearanceDefinition | null;
  selectedPartId: AppearancePartId;
  revision: number;
  zoom: number;
  actualScale: boolean;
  showGuides: boolean;
  showAnchors: boolean;
  overlayAppearanceIds: AppearanceDefinitionId[];
  enhancementPreview: EquipmentAppearanceEnhancement | null;
  showGemstonePreview: boolean;
  skinToneId: PlayerSkinToneId;
  poseId: PlayerCombatPoseId;
  editTarget: PreviewEditTarget;
  selectedAnchorId: PlayerAttachmentAnchorId;
  mainAnchorSupported: boolean;
  playerHitGeometry: RuntimePngInteractionGeometry | null;
  playerHitAnchorX: number;
  playerHitAnchorY: number;
  projectileAimDegrees: number;
  showProjectileTarget: boolean;
  onSelectAnchor(anchorId: PlayerAttachmentAnchorId): void;
  onDrag(
    deltaX: number,
    deltaY: number,
    anchorId?: PlayerAttachmentAnchorId
  ): void;
  onDragPivot(
    offsetX: number,
    offsetY: number,
    pivotX: number,
    pivotY: number
  ): void;
  onMoveProjectilePoint(
    point: "impact" | "tail",
    x: number,
    y: number
  ): void;
  onMoveGemSocket(x: number, y: number): void;
  onMovePlayerHitCenter(centerX: number, centerY: number): void;
  feature?: PreviewFeatureState;
  onMoveFeatureAnchor?(x: number, y: number): void;
  onEditFeatureArea?(area: FaceFeatureArea, selectedVertex: number | null): void;
};
const NO_FEATURE: PreviewFeatureState = { area: null, selectedVertex: null };

export function PreviewCanvas({
  catalog,
  selected,
  selectedPartId,
  revision,
  zoom,
  actualScale,
  showGuides,
  showAnchors,
  overlayAppearanceIds,
  enhancementPreview,
  showGemstonePreview,
  skinToneId,
  poseId,
  editTarget,
  selectedAnchorId,
  mainAnchorSupported,
  playerHitGeometry,
  playerHitAnchorX,
  playerHitAnchorY,
  projectileAimDegrees,
  showProjectileTarget,
  onSelectAnchor,
  onDrag,
  onDragPivot,
  onMoveProjectilePoint,
  onMoveGemSocket,
  onMovePlayerHitCenter,
  feature = NO_FEATURE,
  onMoveFeatureAnchor,
  onEditFeatureArea
}: PreviewCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<{
    app: Application;
    player: PlayerRenderer;
    stage: Container;
    guides: Graphics;
    mainGuides: Graphics;
    projectile: Sprite;
    projectileGuides: Graphics;
    textureCache: PixiTextureCache;
    projectileAssetKey: string;
    updateGeneration: number;
    panX: number;
    panY: number;
  } | null>(null);
  const panDragRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    anchorId: PlayerAttachmentAnchorId | undefined;
    pivot: PivotDragState | undefined;
    projectilePoint: "impact" | "tail" | undefined;
    gem: { slot: string; partId: AppearancePartId } | undefined;
    playerHitCenter: boolean;
  } | null>(null);
  const featureDragRef = useRef<
    | { kind: "anchor"; anchor: PlayerAnchorPoint; clientX: number; clientY: number;
        pixelsX: number; pixelsY: number }
    | { kind: "default" | "vertex"; vertex: number; area: FaceFeatureArea }
    | null
  >(null);
  const featureRef = useRef(feature);
  featureRef.current = feature;
  const onMoveFeatureAnchorRef = useRef(onMoveFeatureAnchor);
  onMoveFeatureAnchorRef.current = onMoveFeatureAnchor;
  const onEditFeatureAreaRef = useRef(onEditFeatureArea);
  onEditFeatureAreaRef.current = onEditFeatureArea;
  const onDragRef = useRef(onDrag);
  const onDragPivotRef = useRef(onDragPivot);
  const onSelectAnchorRef = useRef(onSelectAnchor);
  const onMoveProjectilePointRef = useRef(onMoveProjectilePoint);
  const onMoveGemSocketRef = useRef(onMoveGemSocket);
  const onMovePlayerHitCenterRef = useRef(onMovePlayerHitCenter);
  const dragFrameRef = useRef<number | null>(null);
  const pendingDragRef = useRef<{
    deltaX: number;
    deltaY: number;
    anchorId?: PlayerAttachmentAnchorId;
    pivot?: { offsetX: number; offsetY: number; pivotX: number; pivotY: number };
  } | null>(null);
  onDragRef.current = onDrag;
  onDragPivotRef.current = onDragPivot;
  onSelectAnchorRef.current = onSelectAnchor;
  onMoveProjectilePointRef.current = onMoveProjectilePoint;
  onMoveGemSocketRef.current = onMoveGemSocket;
  onMovePlayerHitCenterRef.current = onMovePlayerHitCenter;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let initialized = false;
    // The fixed application layout resizes this host without a window resize; keep the canvas in step.
    let hostObserver: ResizeObserver | undefined;
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
      hostObserver = new ResizeObserver(() => app.resize());
      hostObserver.observe(host);
      const stage = new Container();
      const textureCache = new PixiTextureCache(
        (assetKey) => `/appearance-assets/${assetKey}`
      );
      const player = new PlayerRenderer({
        local: true,
        color: 0x38bdf8,
        catalog,
        textureLoader: textureCache
      });
      const guides = new Graphics();
      const mainGuides = new Graphics();
      const projectile = new Sprite();
      projectile.visible = false;
      const projectileGuides = new Graphics();
      player.visualRoot.addChild(guides);
      player.root.addChild(mainGuides);
      stage.addChild(player.root, projectile, projectileGuides);
      app.stage.addChild(stage);
      runtimeRef.current = {
        app,
        player,
        stage,
        guides,
        mainGuides,
        projectile,
        projectileGuides,
        textureCache,
        projectileAssetKey: "",
        updateGeneration: 0,
        panX: 0,
        panY: 0
      };
      updatePreview(
        runtimeRef.current,
        catalog,
        selected,
        selectedPartId,
        revision,
        zoom,
        actualScale,
        showGuides,
        showAnchors,
        overlayAppearanceIds,
        enhancementPreview,
        showGemstonePreview,
        skinToneId,
        poseId,
        editTarget,
        selectedAnchorId,
        mainAnchorSupported,
        playerHitGeometry,
        playerHitAnchorX,
        playerHitAnchorY,
        projectileAimDegrees,
        showProjectileTarget,
        featureRef.current
      );
    });
    return () => {
      cancelled = true;
      hostObserver?.disconnect();
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
      if (!initialized) return;
      if (runtimeRef.current?.app === app) {
        runtimeRef.current.updateGeneration += 1;
        runtimeRef.current = null;
        app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
      }
    };
  }, []);

  const flushPendingDrag = (): void => {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    const pending = pendingDragRef.current;
    pendingDragRef.current = null;
    if (!pending) return;
    if (pending.pivot) {
      onDragPivotRef.current(
        pending.pivot.offsetX,
        pending.pivot.offsetY,
        pending.pivot.pivotX,
        pending.pivot.pivotY
      );
      return;
    }
    onDragRef.current(pending.deltaX, pending.deltaY, pending.anchorId);
  };

  const schedulePendingDrag = (): void => {
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      flushPendingDrag();
    });
  };

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    updatePreview(
      runtime,
      catalog,
      selected,
      selectedPartId,
      revision,
      zoom,
      actualScale,
      showGuides,
      showAnchors,
      overlayAppearanceIds,
      enhancementPreview,
      showGemstonePreview,
      skinToneId,
      poseId,
      editTarget,
      selectedAnchorId,
      mainAnchorSupported,
      playerHitGeometry,
      playerHitAnchorX,
      playerHitAnchorY,
      projectileAimDegrees,
      showProjectileTarget,
      feature
    );
  }, [
    catalog,
    selected,
    selectedPartId,
    revision,
    zoom,
    actualScale,
    showGuides,
    showAnchors,
    overlayAppearanceIds,
    enhancementPreview,
    showGemstonePreview,
    skinToneId,
    poseId,
    editTarget,
    selectedAnchorId,
    mainAnchorSupported,
    playerHitGeometry,
    playerHitAnchorX,
    playerHitAnchorY,
    projectileAimDegrees,
    showProjectileTarget,
    feature
  ]);

  return (
    <div
      ref={hostRef}
      className="preview-host"
      tabIndex={0}
      aria-label="Player appearance preview"
      data-edit-target={editTarget}
      onPointerDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.dataset.panning = "true";
          panDragRef.current = { x: event.clientX, y: event.clientY };
          return;
        }
        if (event.button !== 0) return;
        if (editTarget === "overall") return;
        if (editTarget === "feature_anchor" || editTarget === "feature_area") {
          const runtime = runtimeRef.current;
          const area = feature.area;
          const category = selected ? salonAppearanceCategory(catalog, selected) : null;
          if (!runtime || !selected || !area || !isFaceFeatureCategory(category)) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
          const near = (point: PlayerAnchorPoint): boolean => {
            const handle = runtime.player.faceFeatureGlobalPoint(point);
            return Math.hypot(handle.x - screen.x, handle.y - screen.y) <=
              FEATURE_HANDLE_RADIUS_PX;
          };
          if (editTarget === "feature_anchor") {
            const sprite = runtime.player.appearanceSprite(`style:${category}`);
            if (!sprite) return;
            const cross = runtime.player.faceFeatureGlobalPoint(area.defaultPoint);
            // Start from the texture point already under the cross so nothing jumps.
            const anchor = selected.featureAnchor ??
              equipmentTexturePoint(sprite, cross.x, cross.y);
            featureDragRef.current = {
              kind: "anchor",
              anchor,
              clientX: event.clientX,
              clientY: event.clientY,
              pixelsX: sprite.texture.width * sprite.worldTransform.a,
              pixelsY: sprite.texture.height * sprite.worldTransform.d
            };
            if (!selected.featureAnchor) onMoveFeatureAnchorRef.current?.(anchor.x, anchor.y);
          } else if (near(area.defaultPoint)) {
            featureDragRef.current = { kind: "default", vertex: -1, area };
          } else {
            let vertex = area.polygon.findIndex(near);
            let nextArea = area;
            if (vertex < 0) {
              // Empty space adds a vertex on the nearest edge.
              const local = roundPoint(runtime.player.faceFeaturePointAt(screen.x, screen.y));
              const edge = nearestEdge(area.polygon, local);
              const polygon = [...area.polygon];
              polygon.splice(edge + 1, 0, local);
              if (faceFeaturePolygonIssue(polygon) ||
                !faceFeaturePointInPolygon(area.defaultPoint, polygon)) return;
              nextArea = { ...area, polygon };
              vertex = edge + 1;
            }
            onEditFeatureAreaRef.current?.(nextArea, vertex);
            featureDragRef.current = { kind: "vertex", vertex, area: nextArea };
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if (editTarget === "main" && !mainAnchorSupported) return;
        if ((editTarget === "item" || editTarget === "pivot" || editTarget === "gem") && !selected) return;
        let anchorId: PlayerAttachmentAnchorId | undefined;
        let pivot: PivotDragState | undefined;
        let projectilePoint: "impact" | "tail" | undefined;
        let gem: { slot: string; partId: AppearancePartId } | undefined;
        let playerHitCenter = false;
        if (editTarget === "main" && playerHitGeometry) {
          const runtime = runtimeRef.current;
          if (!runtime) return;
          const frame = playerArtworkFrame(runtime.player);
          const preview = resolvePlayerHitGeometryPreview(
            playerHitGeometry,
            frame.width,
            frame.height,
            runtime.stage.scale.x,
            playerHitAnchorX,
            playerHitAnchorY
          );
          const rect = event.currentTarget.getBoundingClientRect();
          const handle = runtime.player.root.toGlobal({
            x: preview.centerX,
            y: preview.centerY
          });
          playerHitCenter =
            (event.clientX - rect.left - handle.x) ** 2 +
            (event.clientY - rect.top - handle.y) ** 2 <= 18 ** 2;
        }
        if (editTarget === "gem") {
          const runtime = runtimeRef.current;
          if (!runtime || !selected) return;
          const slot = previewEquipmentSlot(catalog, selected);
          const socket = equipmentGemSocket(catalog, selected.appearanceId);
          const gemSprite = slot ? runtime.player.equipmentGemSprite(slot) : null;
          if (!slot || !gemSprite) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const handle = gemSprite.toGlobal({ x: 0, y: 0 });
          if (
            (event.clientX - rect.left - handle.x) ** 2 +
            (event.clientY - rect.top - handle.y) ** 2 > 18 ** 2
          ) return;
          gem = { slot, partId: socket.partId };
        }
        if (
          editTarget === "projectile_impact" ||
          editTarget === "projectile_tail"
        ) {
          const runtime = runtimeRef.current;
          if (!runtime || !selected?.projectileAssetKey || !runtime.projectile.visible) return;
          const rect = event.currentTarget.getBoundingClientRect();
          projectilePoint = editTarget === "projectile_impact" ? "impact" : "tail";
          const transform = selected.projectileTransform ?? DEFAULT_PROJECTILE_TRANSFORM;
          const handle = projectileHandlePosition(runtime.projectile, transform, projectilePoint);
          if (
            (event.clientX - rect.left - handle.x) ** 2 +
            (event.clientY - rect.top - handle.y) ** 2 > 18 ** 2
          ) return;
        }
        if (editTarget === "anchors") {
          const runtime = runtimeRef.current;
          if (!runtime) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const scale = zoom * (actualScale ? 1 : 3) * runtime.player.overallScale;
          const local = runtime.player.visualRoot.toLocal({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
          });
          anchorId = nearestAnchor(
            playerBodyPose(catalog, "default", poseId).anchors,
            local,
            Math.max(3, 12 / scale)
          );
          if (!anchorId) return;
          onSelectAnchorRef.current(anchorId);
        }
        if (editTarget === "pivot") {
          const runtime = runtimeRef.current;
          if (!runtime || !selected) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const scale = zoom * (actualScale ? 1 : 3) * runtime.player.overallScale;
          const local = runtime.player.visualRoot.toLocal({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
          });
          const transform = resolveAppearanceLocalTransform(
            catalog,
            selected.appearanceId,
            poseId,
            "default",
            selectedPartId
          );
          if ((local.x - transform.x) ** 2 + (local.y - transform.y) ** 2 >
            Math.max(4, 16 / scale) ** 2) return;
          const sprite = selectedSprite(runtime.player, transform.layer, transform.x, transform.y);
          if (!sprite) return;
          pivot = {
            pivotX: transform.pivotX,
            pivotY: transform.pivotY,
            offsetX: transform.offsetX,
            offsetY: transform.offsetY,
            textureWidth: sprite.texture.width,
            textureHeight: sprite.texture.height,
            scaleX: transform.scaleX,
            scaleY: transform.scaleY,
            rotationRadians: transform.rotationDegrees * Math.PI / 180
          };
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          x: event.clientX,
          y: event.clientY,
          anchorId,
          pivot,
          projectilePoint,
          gem,
          playerHitCenter
        };
      }}
      onPointerMove={(event) => {
        const previousPan = panDragRef.current;
        if (previousPan) {
          const runtime = runtimeRef.current;
          if (!runtime) return;
          runtime.panX += event.clientX - previousPan.x;
          runtime.panY += event.clientY - previousPan.y;
          runtime.stage.position.set(
            runtime.app.screen.width / 2 + runtime.panX,
            runtime.app.screen.height * 0.72 + runtime.panY
          );
          panDragRef.current = { x: event.clientX, y: event.clientY };
          return;
        }
        const featureDrag = featureDragRef.current;
        if (featureDrag) {
          const runtime = runtimeRef.current;
          if (!runtime) return;
          if (featureDrag.kind === "anchor") {
            onMoveFeatureAnchorRef.current?.(
              clamp01(featureDrag.anchor.x -
                (event.clientX - featureDrag.clientX) / (featureDrag.pixelsX || 1)),
              clamp01(featureDrag.anchor.y -
                (event.clientY - featureDrag.clientY) / (featureDrag.pixelsY || 1))
            );
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const local = roundPoint(runtime.player.faceFeaturePointAt(
            event.clientX - rect.left,
            event.clientY - rect.top
          ));
          const area = featureDrag.area;
          if (featureDrag.kind === "default") {
            if (!faceFeaturePointInPolygon(local, area.polygon)) return;
            const next = { ...area, defaultPoint: local };
            featureDrag.area = next;
            onEditFeatureAreaRef.current?.(next, featureRef.current.selectedVertex);
            return;
          }
          const polygon = area.polygon.map((point, index) =>
            index === featureDrag.vertex ? local : point);
          if (faceFeaturePolygonIssue(polygon) ||
            !faceFeaturePointInPolygon(area.defaultPoint, polygon)) return;
          const next = { ...area, polygon };
          featureDrag.area = next;
          onEditFeatureAreaRef.current?.(next, featureDrag.vertex);
          return;
        }
        const previous = dragRef.current;
        if (!previous) return;
        if (previous.playerHitCenter && playerHitGeometry) {
          const runtime = runtimeRef.current;
          if (!runtime) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const local = runtime.player.root.toLocal({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
          });
          const frame = playerArtworkFrame(runtime.player);
          onMovePlayerHitCenterRef.current(
            clamp01(playerHitAnchorX + local.x / frame.width),
            clamp01(playerHitAnchorY + local.y / frame.height)
          );
          dragRef.current = { ...previous, x: event.clientX, y: event.clientY };
          return;
        }
        if (previous.gem) {
          const runtime = runtimeRef.current;
          if (!runtime) return;
          const sprite = runtime.player.appearanceSprite(
            previous.gem.slot,
            previous.gem.partId
          );
          if (!sprite) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const point = equipmentTexturePoint(
            sprite,
            event.clientX - rect.left,
            event.clientY - rect.top
          );
          onMoveGemSocketRef.current(point.x, point.y);
          dragRef.current = {
            x: event.clientX,
            y: event.clientY,
            anchorId: undefined,
            pivot: undefined,
            projectilePoint: undefined,
            gem: previous.gem,
            playerHitCenter: false
          };
          return;
        }
        if (previous.projectilePoint) {
          const runtime = runtimeRef.current;
          if (!runtime) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const point = projectileTexturePoint(
            runtime.projectile,
            event.clientX - rect.left,
            event.clientY - rect.top
          );
          onMoveProjectilePointRef.current(previous.projectilePoint, point.x, point.y);
          dragRef.current = {
            x: event.clientX,
            y: event.clientY,
            anchorId: undefined,
            pivot: undefined,
            projectilePoint: previous.projectilePoint,
            gem: undefined,
            playerHitCenter: false
          };
          return;
        }
        const runtime = runtimeRef.current;
        const scale = zoom * (actualScale ? 1 : 3) *
          (runtime?.player.overallScale ?? 1);
        const rect = event.currentTarget.getBoundingClientRect();
        const currentLocal = runtime?.player.visualRoot.toLocal({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top
        });
        const previousLocal = runtime?.player.visualRoot.toLocal({
          x: previous.x - rect.left,
          y: previous.y - rect.top
        });
        const deltaX = currentLocal && previousLocal
          ? currentLocal.x - previousLocal.x
          : (event.clientX - previous.x) / scale;
        const deltaY = currentLocal && previousLocal
          ? currentLocal.y - previousLocal.y
          : (event.clientY - previous.y) / scale;
        if (previous.pivot) {
          const result = movePivot(previous.pivot, deltaX, deltaY);
          dragRef.current = {
            x: event.clientX,
            y: event.clientY,
            anchorId: undefined,
            pivot: result.pivot,
            projectilePoint: undefined,
            gem: undefined,
            playerHitCenter: false
          };
          pendingDragRef.current = {
            deltaX: 0,
            deltaY: 0,
            pivot: {
              offsetX: result.pivot.offsetX,
              offsetY: result.pivot.offsetY,
              pivotX: result.pivot.pivotX,
              pivotY: result.pivot.pivotY
            }
          };
          schedulePendingDrag();
          return;
        }
        dragRef.current = {
          x: event.clientX,
          y: event.clientY,
          anchorId: previous.anchorId,
          pivot: undefined,
          projectilePoint: undefined,
          gem: undefined,
          playerHitCenter: false
        };
        const pending = pendingDragRef.current;
        pendingDragRef.current = {
          deltaX: (pending?.pivot ? 0 : pending?.deltaX ?? 0) + deltaX,
          deltaY: (pending?.pivot ? 0 : pending?.deltaY ?? 0) + deltaY,
          ...(previous.anchorId ? { anchorId: previous.anchorId } : {})
        };
        schedulePendingDrag();
      }}
      onPointerUp={(event) => {
        event.currentTarget.dataset.panning = "false";
        panDragRef.current = null;
        featureDragRef.current = null;
        flushPendingDrag();
        dragRef.current = null;
      }}
      onPointerCancel={(event) => {
        event.currentTarget.dataset.panning = "false";
        panDragRef.current = null;
        featureDragRef.current = null;
        flushPendingDrag();
        dragRef.current = null;
      }}
      onAuxClick={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onDragStart={(event) => event.preventDefault()}
    />
  );
}

function updatePreview(
  runtime: {
    app: Application;
    player: PlayerRenderer;
    stage: Container;
    guides: Graphics;
    mainGuides: Graphics;
    projectile: Sprite;
    projectileGuides: Graphics;
    textureCache: PixiTextureCache;
    projectileAssetKey: string;
    updateGeneration: number;
    panX: number;
    panY: number;
  },
  catalog: PlayerAppearanceCatalog,
  selected: AppearanceDefinition | null,
  selectedPartId: AppearancePartId,
  revision: number,
  zoom: number,
  actualScale: boolean,
  showGuides: boolean,
  showAnchors: boolean,
  overlayAppearanceIds: AppearanceDefinitionId[],
  enhancementPreview: EquipmentAppearanceEnhancement | null,
  showGemstonePreview: boolean,
  skinToneId: PlayerSkinToneId,
  poseId: PlayerCombatPoseId,
  editTarget: PreviewEditTarget,
  selectedAnchorId: PlayerAttachmentAnchorId,
  mainAnchorSupported: boolean,
  playerHitGeometry: RuntimePngInteractionGeometry | null,
  playerHitAnchorX: number,
  playerHitAnchorY: number,
  projectileAimDegrees: number,
  showProjectileTarget: boolean,
  feature: PreviewFeatureState
): void {
  const updateGeneration = ++runtime.updateGeneration;
  runtime.guides.visible = showGuides;
  runtime.mainGuides.visible = showGuides;
  runtime.player.setCatalog(catalog);
  const snapshot = previewSnapshot(
    catalog,
    selected,
    revision,
    overlayAppearanceIds,
    editTarget,
    enhancementPreview
  );
  void runtime.player.updateAppearance(snapshot, {
    showGemstones: showGemstonePreview,
    skinToneId
  }).then(() => {
    if (updateGeneration !== runtime.updateGeneration) return;
    runtime.player.setPose(poseId);
    drawGuides(
      runtime,
      catalog,
      selected,
      selectedPartId,
      showGuides,
      showAnchors || editTarget === "anchors",
      poseId,
      editTarget,
      selectedAnchorId,
      mainAnchorSupported,
      playerHitGeometry,
      playerHitAnchorX,
      playerHitAnchorY,
      feature
    );
  });
  updateProjectile(
    runtime,
    selected,
    editTarget,
    projectileAimDegrees,
    showProjectileTarget,
    showGuides,
    updateGeneration
  );
  const bounds = runtime.app.screen;
  runtime.stage.position.set(
    bounds.width / 2 + runtime.panX,
    bounds.height * 0.72 + runtime.panY
  );
  runtime.stage.scale.set(zoom * (actualScale ? 1 : 3));
}

export function previewSnapshot(
  catalog: PlayerAppearanceCatalog,
  selected: AppearanceDefinition | null,
  revision: number,
  overlayAppearanceIds: AppearanceDefinitionId[],
  editTarget: PreviewEditTarget,
  enhancementPreview: EquipmentAppearanceEnhancement | null
): PlayerAppearanceSnapshot {
  const includeSelected = editTarget === "item" || editTarget === "pivot" ||
    editTarget === "gem" || editTarget === "main" ||
    editTarget === "feature_anchor" || editTarget === "feature_area";
  const definitions = overlayAppearanceIds
    .map((appearanceId) => catalog.appearances.find((appearance) =>
      appearance.appearanceId === appearanceId
    ))
    .filter((appearance): appearance is AppearanceDefinition => Boolean(appearance));
  const slots: PlayerAppearanceSnapshot["slots"] = {};
  const styles: NonNullable<PlayerAppearanceSnapshot["styles"]> = {};
  for (const appearance of definitions) {
    const salonCategoryId = salonAppearanceCategory(catalog, appearance);
    if (salonCategoryId) {
      styles[salonCategoryId] = appearance.appearanceId;
      continue;
    }
    const family = catalog.families.find((candidate) =>
      candidate.familyId === appearance.familyId
    );
    if (family && playerOverlaySlotForFamily(family) === "beard") {
      styles.beard = appearance.appearanceId;
      continue;
    }
    const equipmentId =
      appearance.equipmentDefinitionId ??
      appearance.compatibleEquipmentDefinitionIds?.[0] ??
      catalog.families.find((family) => family.familyId === appearance.familyId)
        ?.compatibleEquipmentDefinitionIds[0];
    if (!equipmentId) continue;
    const equipment = EQUIPMENT_DEFINITIONS[equipmentId];
    if (!equipment) continue;
    slots[equipment.slot] = {
      equipmentDefinitionId: equipmentId,
      appearanceId: appearance.appearanceId,
      cosmeticAppearanceId: null
    };
  }
  if (selected && includeSelected) {
    const salonCategoryId = salonAppearanceCategory(catalog, selected);
    if (salonCategoryId) styles[salonCategoryId] = selected.appearanceId;
    const selectedFamily = catalog.families.find((family) =>
      family.familyId === selected.familyId
    );
    if (selectedFamily && playerOverlaySlotForFamily(selectedFamily) === "beard") {
      styles.beard = selected.appearanceId;
    }
    const equipmentId =
      selected.equipmentDefinitionId ??
      selected.compatibleEquipmentDefinitionIds?.[0] ??
      catalog.families.find((family) => family.familyId === selected.familyId)
        ?.compatibleEquipmentDefinitionIds[0];
    if (equipmentId) {
      const equipment = EQUIPMENT_DEFINITIONS[equipmentId];
      if (equipment) {
        const slot = equipment.slot;
        slots[slot] = {
          equipmentDefinitionId: equipmentId,
          appearanceId: selected.appearanceId,
          cosmeticAppearanceId: null,
          ...(enhancementPreview ? { enhancement: enhancementPreview } : {})
        };
      }
    }
  }
  return {
    schemaVersion: 1,
    catalogRevision: catalog.catalogRevision,
    revision,
    bodyVariantId: "default",
    poseId: "idle",
    slots,
    styles,
    activeHand: selected
      ? (selected.familyId === "bow" || selected.familyId === "staff"
          ? "secondary"
          : "melee")
      : null
  };
}

function updateProjectile(
  runtime: {
    player: PlayerRenderer;
    stage: Container;
    projectile: Sprite;
    projectileGuides: Graphics;
    textureCache: PixiTextureCache;
    projectileAssetKey: string;
    updateGeneration: number;
  },
  selected: AppearanceDefinition | null,
  editTarget: PreviewEditTarget,
  projectileAimDegrees: number,
  showProjectileTarget: boolean,
  showGuides: boolean,
  updateGeneration: number
): void {
  const projectileMode = editTarget === "projectile" ||
    editTarget === "projectile_impact" || editTarget === "projectile_tail";
  runtime.player.root.visible = !projectileMode || showProjectileTarget;
  runtime.projectileGuides.visible = showGuides;
  runtime.projectileGuides.clear();
  if (!projectileMode || !selected?.projectileAssetKey) {
    runtime.projectile.visible = false;
    return;
  }
  const apply = (): void => {
    if (runtime.updateGeneration !== updateGeneration) return;
    const transform = selected.projectileTransform ?? DEFAULT_PROJECTILE_TRANSFORM;
    const aimRadians = projectileAimDegrees * Math.PI / 180;
    const pointEditing = editTarget === "projectile_impact" ||
      editTarget === "projectile_tail";
    const target = {
      x: 0,
      y: -runtime.player.baseHeightPx * runtime.player.overallScale / 2
    };
    const resolved = pointEditing
      ? resolveProjectilePointEditorTransform(transform, aimRadians, target)
      : resolveProjectileSpriteTransform(transform, aimRadians, target);
    const sprite = runtime.projectile;
    sprite.visible = true;
    sprite.anchor.set(resolved.anchorX, resolved.anchorY);
    sprite.position.set(resolved.positionX, resolved.positionY);
    sprite.rotation = resolved.rotationRadians;
    sprite.scale.set(resolved.scaleX, resolved.scaleY);
    const impact = runtime.stage.toLocal(
      projectileHandlePosition(sprite, transform, "impact")
    );
    const tail = runtime.stage.toLocal(
      projectileHandlePosition(sprite, transform, "tail")
    );
    const source = {
      x: target.x - Math.cos(aimRadians) * 65,
      y: target.y - Math.sin(aimRadians) * 65
    };
    runtime.projectileGuides
      .moveTo(source.x, source.y)
      .lineTo(target.x, target.y)
      .stroke({ color: 0x94a3b8, width: 0.6, alpha: 0.65 })
      .circle(target.x, target.y, 2)
      .stroke({ color: 0xf8fafc, width: 0.8, alpha: 0.9 })
      .moveTo(tail.x, tail.y)
      .lineTo(impact.x, impact.y)
      .stroke({ color: 0xfacc15, width: 0.8, alpha: 0.9 })
      .circle(impact.x, impact.y, editTarget === "projectile_impact" ? 3 : 2.2)
      .fill({ color: 0xfb7185, alpha: 1 })
      .circle(tail.x, tail.y, editTarget === "projectile_tail" ? 3 : 2.2)
      .fill({ color: 0x22d3ee, alpha: 1 });
  };
  if (runtime.projectileAssetKey === selected.projectileAssetKey) {
    apply();
    return;
  }
  runtime.projectile.visible = false;
  void runtime.textureCache.load(selected.projectileAssetKey).then((texture) => {
    if (runtime.updateGeneration !== updateGeneration) return;
    runtime.projectileAssetKey = selected.projectileAssetKey!;
    runtime.projectile.texture = texture;
    apply();
  });
}

function drawGuides(
  runtime: {
    player: PlayerRenderer;
    guides: Graphics;
    mainGuides: Graphics;
  },
  catalog: PlayerAppearanceCatalog,
  selected: AppearanceDefinition | null,
  selectedPartId: AppearancePartId,
  showGuides: boolean,
  showAnchors: boolean,
  poseId: PlayerCombatPoseId,
  editTarget: PreviewEditTarget,
  selectedAnchorId: PlayerAttachmentAnchorId,
  mainAnchorSupported: boolean,
  playerHitGeometry: RuntimePngInteractionGeometry | null,
  playerHitAnchorX: number,
  playerHitAnchorY: number,
  feature: PreviewFeatureState = NO_FEATURE
): void {
  const guides = runtime.guides;
  const mainGuides = runtime.mainGuides;
  guides.visible = showGuides;
  mainGuides.visible = showGuides;
  guides.clear();
  mainGuides.clear();
  if (!showGuides) return;
  if (editTarget === "gem") return;
  if (editTarget === "main" && mainAnchorSupported) {
    if (playerHitGeometry) {
      const frame = playerArtworkFrame(runtime.player);
      const worldScale = Math.abs(runtime.player.root.worldTransform.a) || 1;
      const hit = resolvePlayerHitGeometryPreview(
        playerHitGeometry,
        frame.width,
        frame.height,
        worldScale,
        playerHitAnchorX,
        playerHitAnchorY
      );
      if (hit.shape === "circle") {
        mainGuides.circle(hit.centerX, hit.centerY, hit.radius);
      } else {
        mainGuides.rect(hit.left, hit.top, hit.width, hit.height);
      }
      mainGuides.stroke({ color: 0xfacc15, width: 1.5 / worldScale, alpha: 1 });
      const handleRadius = 5 / worldScale;
      mainGuides
        .moveTo(hit.centerX, hit.centerY - handleRadius)
        .lineTo(hit.centerX + handleRadius, hit.centerY)
        .lineTo(hit.centerX, hit.centerY + handleRadius)
        .lineTo(hit.centerX - handleRadius, hit.centerY)
        .closePath()
        .fill({ color: 0xfacc15, alpha: 1 });
    }
    mainGuides
      .moveTo(-5, 0)
      .lineTo(5, 0)
      .moveTo(0, -5)
      .lineTo(0, 5)
      .stroke({ color: 0x22d3ee, width: 0.7, alpha: 1 })
      .circle(0, 0, 2.2)
      .fill({
        color: 0x22d3ee,
        alpha: 1
      });
  }
  if (showAnchors && editTarget !== "main") {
    const anchors = playerBodyPose(
      catalog,
      "default",
      poseId
    ).anchors;
    for (const [anchorId, anchor] of Object.entries(anchors)) {
      const isSelected = editTarget === "anchors" && anchorId === selectedAnchorId;
      guides
        .circle(anchor.x, anchor.y, isSelected ? 2.2 : 1.4)
        .fill({
          color: isSelected ? 0xfacc15 : 0x22d3ee,
          alpha: isSelected ? 1 : 0.8
        });
    }
  }
  if ((editTarget === "feature_anchor" || editTarget === "feature_area") && feature.area) {
    const face = playerBodyPose(catalog, "default", poseId).anchors.face;
    const at = (point: PlayerAnchorPoint) => ({ x: face.x + point.x, y: face.y + point.y });
    const worldScale = Math.abs(runtime.player.visualRoot.worldTransform.a) || 1;
    const unit = 1 / worldScale;
    const center = at(feature.area.defaultPoint);
    if (editTarget === "feature_anchor") {
      guides
        .moveTo(center.x - 8 * unit, center.y).lineTo(center.x + 8 * unit, center.y)
        .moveTo(center.x, center.y - 8 * unit).lineTo(center.x, center.y + 8 * unit)
        .stroke({ color: 0xfacc15, width: 1.5 * unit, alpha: 1 });
      return;
    }
    const polygon = feature.area.polygon.map(at);
    guides.poly(polygon.flatMap((point) => [point.x, point.y]), true)
      .fill({ color: 0x22d3ee, alpha: 0.08 })
      .stroke({ color: 0x22d3ee, width: 1.2 * unit, alpha: 0.9 });
    for (const [index, point] of polygon.entries()) {
      const size = (index === feature.selectedVertex ? 5 : 3.5) * unit;
      guides.rect(point.x - size, point.y - size, size * 2, size * 2)
        .fill({ color: index === feature.selectedVertex ? 0xfacc15 : 0x22d3ee, alpha: 1 });
    }
    const handle = 5 * unit;
    guides
      .moveTo(center.x, center.y - handle).lineTo(center.x + handle, center.y)
      .lineTo(center.x, center.y + handle).lineTo(center.x - handle, center.y)
      .closePath()
      .fill({ color: 0xfb7185, alpha: 1 });
    return;
  }
  if (!selected || (editTarget !== "item" && editTarget !== "pivot")) return;
  const transform = resolveAppearanceLocalTransform(
    catalog,
    selected.appearanceId,
    poseId,
    "default",
    selectedPartId
  );
  guides
    .circle(transform.x, transform.y, 1.8)
    .fill({ color: 0xfb7185, alpha: 1 });
  const sprite = [...Object.values(runtime.player.layers)]
    .flatMap((layer) => layer.children)
    .find((child) => "texture" in child && child.position.x === transform.x);
  if (sprite) {
    const bounds = sprite.getBounds();
    const local = runtime.player.visualRoot.toLocal({ x: bounds.x, y: bounds.y });
    guides
      .rect(
        local.x,
        local.y,
        bounds.width / runtime.player.visualRoot.worldTransform.a,
        bounds.height / runtime.player.visualRoot.worldTransform.d
      )
      .stroke({ color: 0xf8fafc, width: 0.55, alpha: 0.8 });
  }
}

type PlayerHitGeometryPreview =
  | { shape: "circle"; centerX: number; centerY: number; radius: number }
  | {
      shape: "rectangle";
      centerX: number;
      centerY: number;
      left: number;
      top: number;
      width: number;
      height: number;
    };

export function resolvePlayerHitGeometryPreview(
  geometry: RuntimePngInteractionGeometry,
  artworkWidth: number,
  artworkHeight: number,
  previewWorldScale: number,
  anchorX: number,
  anchorY: number
): PlayerHitGeometryPreview {
  const centerX = (geometry.centerX - anchorX) * artworkWidth;
  const centerY = (geometry.centerY - anchorY) * artworkHeight;
  if (geometry.shape === "circle") {
    return {
      shape: "circle",
      centerX,
      centerY,
      radius: geometry.radiusPx / Math.max(Math.abs(previewWorldScale), 0.000001)
    };
  }
  const width = artworkWidth * geometry.width;
  const height = artworkHeight * geometry.height;
  return {
    shape: "rectangle",
    centerX,
    centerY,
    left: centerX - width / 2,
    top: centerY - height / 2,
    width,
    height
  };
}

function playerArtworkFrame(player: PlayerRenderer): Readonly<{
  width: number;
  height: number;
}> {
  const bounds = player.visualRoot.getBounds();
  const topLeft = player.root.toLocal({ x: bounds.x, y: bounds.y });
  const bottomRight = player.root.toLocal({
    x: bounds.x + bounds.width,
    y: bounds.y + bounds.height
  });
  return {
    width: Math.max(Math.abs(bottomRight.x - topLeft.x), 0.000001),
    height: player.baseHeightPx * player.overallScale
  };
}

type PivotDragState = {
  pivotX: number;
  pivotY: number;
  offsetX: number;
  offsetY: number;
  textureWidth: number;
  textureHeight: number;
  scaleX: number;
  scaleY: number;
  rotationRadians: number;
};

export function movePivot(
  pivot: PivotDragState,
  deltaX: number,
  deltaY: number
): {
  pivot: PivotDragState;
  offsetDeltaX: number;
  offsetDeltaY: number;
} {
  const cosine = Math.cos(pivot.rotationRadians);
  const sine = Math.sin(pivot.rotationRadians);
  const localX = cosine * deltaX + sine * deltaY;
  const localY = -sine * deltaX + cosine * deltaY;
  const pivotX = clamp01(
    pivot.pivotX + localX / (pivot.textureWidth * pivot.scaleX)
  );
  const pivotY = clamp01(
    pivot.pivotY + localY / (pivot.textureHeight * pivot.scaleY)
  );
  const appliedLocalX = (pivotX - pivot.pivotX) * pivot.textureWidth * pivot.scaleX;
  const appliedLocalY = (pivotY - pivot.pivotY) * pivot.textureHeight * pivot.scaleY;
  return {
    pivot: {
      ...pivot,
      pivotX,
      pivotY,
      offsetX: pivot.offsetX + cosine * appliedLocalX - sine * appliedLocalY,
      offsetY: pivot.offsetY + sine * appliedLocalX + cosine * appliedLocalY
    },
    offsetDeltaX: cosine * appliedLocalX - sine * appliedLocalY,
    offsetDeltaY: sine * appliedLocalX + cosine * appliedLocalY
  };
}

function selectedSprite(
  player: PlayerRenderer,
  layer: keyof PlayerRenderer["layers"],
  x: number,
  y: number
): Sprite | undefined {
  return player.layers[layer].children.find((child): child is Sprite =>
    child instanceof Sprite &&
    Math.abs(child.position.x - x) < 0.001 &&
    Math.abs(child.position.y - y) < 0.001
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function projectileHandlePosition(
  sprite: Sprite,
  transform: ProjectileTransform,
  point: "impact" | "tail"
): Readonly<{ x: number; y: number }> {
  const x = point === "impact" ? transform.impactX : transform.tailX;
  const y = point === "impact" ? transform.impactY : transform.tailY;
  return sprite.toGlobal({
    x: (x - sprite.anchor.x) * sprite.texture.width,
    y: (y - sprite.anchor.y) * sprite.texture.height
  });
}

export function resolveProjectilePointEditorTransform(
  transform: ProjectileTransform,
  previewRadians: number,
  target: Readonly<{ x: number; y: number }>,
  baseScale = 1
): ProjectileSpriteTransform {
  const cosine = Math.cos(previewRadians);
  const sine = Math.sin(previewRadians);
  return {
    anchorX: 0.5,
    anchorY: 0.5,
    positionX: target.x + cosine * transform.offsetX - sine * transform.offsetY,
    positionY: target.y + sine * transform.offsetX + cosine * transform.offsetY,
    rotationRadians: previewRadians + transform.rotationDegrees * Math.PI / 180,
    scaleX: baseScale * transform.scaleX,
    scaleY: baseScale * transform.scaleY
  };
}

function projectileTexturePoint(
  sprite: Sprite,
  screenX: number,
  screenY: number
): Readonly<{ x: number; y: number }> {
  const local = sprite.toLocal({ x: screenX, y: screenY });
  return {
    x: clamp01(local.x / sprite.texture.width + sprite.anchor.x),
    y: clamp01(local.y / sprite.texture.height + sprite.anchor.y)
  };
}

function equipmentTexturePoint(
  sprite: Sprite,
  screenX: number,
  screenY: number
): Readonly<{ x: number; y: number }> {
  const local = sprite.toLocal({ x: screenX, y: screenY });
  return {
    x: clamp01(local.x / sprite.texture.width + sprite.anchor.x),
    y: clamp01(local.y / sprite.texture.height + sprite.anchor.y)
  };
}

function roundPoint(point: PlayerAnchorPoint): PlayerAnchorPoint {
  return { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
}

/** Index of the polygon edge (vertex i to i+1) closest to a point. */
export function nearestEdge(
  polygon: readonly PlayerAnchorPoint[],
  point: PlayerAnchorPoint
): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index]!;
    const end = polygon[(index + 1) % polygon.length]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
    const distance = Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

function previewEquipmentSlot(
  catalog: PlayerAppearanceCatalog,
  appearance: AppearanceDefinition
): string | null {
  const equipmentId = appearance.equipmentDefinitionId ??
    appearance.compatibleEquipmentDefinitionIds?.[0] ??
    catalog.families.find((family) => family.familyId === appearance.familyId)
      ?.compatibleEquipmentDefinitionIds[0];
  return equipmentId ? EQUIPMENT_DEFINITIONS[equipmentId]?.slot ?? null : null;
}

export function nearestAnchor(
  anchors: Readonly<Partial<
    Record<PlayerAttachmentAnchorId, Readonly<{ x: number; y: number }>>
  >>,
  point: Readonly<{ x: number; y: number }>,
  radius: number
): PlayerAttachmentAnchorId | undefined {
  let nearest: PlayerAttachmentAnchorId | undefined;
  let nearestDistance = radius * radius;
  for (const [anchorId, anchor] of Object.entries(anchors) as Array<
    [PlayerAttachmentAnchorId, Readonly<{ x: number; y: number }>]
  >) {
    const distance = (anchor.x - point.x) ** 2 + (anchor.y - point.y) ** 2;
    if (distance > nearestDistance) continue;
    nearest = anchorId;
    nearestDistance = distance;
  }
  return nearest;
}

export const FALLBACK_PREVIEW_CATALOG = DEFAULT_PLAYER_APPEARANCE_CATALOG;
