import {
  cisternWarrensStoredDistanceToIndoor,
  combatPositionToDungeonLocal,
  dungeonCombatMetersToLocalDistance,
  dungeonLocalToCombatPosition,
  type DroppedItemSnapshot,
  type DungeonEnemySnapshot,
  type DungeonObjectSnapshot,
  type DungeonResourceSnapshot,
  type DungeonSnapshot,
  type CombatEntitySnapshot,
  type LatLon
} from "@ash-atlas/shared";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { useIndoorMovementInput } from "../movement/indoorMovementInput.js";
import type { CombatPresentationController } from "../combat/combatPresentation.js";
import { DungeonEntityLayer } from "./DungeonEntityLayer.js";
import {
  DungeonCombatFeedback,
  DungeonEnemyLayer,
  DungeonRoomPresentation
} from "./DungeonRoomPresentation.js";
import { BossTelegraphLayer } from "./BossTelegraphLayer.js";
import { IndoorSceneStage } from "./IndoorSceneStage.js";
import { IndoorSceneViewport } from "./IndoorSceneViewport.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { groundItemGeometryForArtwork } from "./groundItemGeometry.js";
import { stackDroppedItemsForWorld } from "../droppedItems/droppedItemModel.js";
import {
  clampDungeonZoom,
  dungeonPinchZoom,
  dungeonWheelZoom,
  initialDungeonZoom,
  persistDungeonZoomPreference,
  type DungeonZoomLimits
} from "./dungeonZoom.js";

function releaseDungeonPointerCapture(stage: HTMLDivElement | null, pointerId: number): void {
  if (!stage || !Number.isFinite(pointerId)) return;
  try {
    if (!stage.hasPointerCapture || stage.hasPointerCapture(pointerId)) {
      stage.releasePointerCapture?.(pointerId);
    }
  } catch {
    // The browser may have already discarded capture when the target unmounts.
  }
}

type Props = {
  snapshot: DungeonSnapshot;
  drops: readonly DroppedItemSnapshot[];
  movementDisabled: boolean;
  onMove(x: number, y: number): void;
  onSelectObject(object: DungeonObjectSnapshot): void;
  onSelectResource?(resource: DungeonResourceSnapshot): void;
  onSelectEnemy?(enemy: DungeonEnemySnapshot): void;
  combatEntities?: readonly CombatEntitySnapshot[];
  combatPresentation?: CombatPresentationController;
  onResetZoomReady?(reset: (() => void) | null): void;
  onSelectDroppedItem(drop: DroppedItemSnapshot): void;
  targeting?: boolean;
  onTargetPosition?(position: LatLon): void;
  onStageElementChange?(element: HTMLDivElement | null): void;
  targetPreview?: { position: LatLon; radiusM?: number; rangeM?: number } | null;
  debugOverlayEnabled?: boolean;
};

export function dungeonStageClientPointToCombatPosition(
  point: Readonly<{ x: number; y: number }>,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  roomWidth: number,
  roomHeight: number
): LatLon | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const x = (point.x - bounds.left) / bounds.width;
  const y = (point.y - bounds.top) / bounds.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return dungeonLocalToCombatPosition(x * roomWidth, y * roomHeight);
}

export function DungeonZoneLayer({
  snapshot,
  drops,
  movementDisabled,
  onMove,
  onSelectObject,
  onSelectResource,
  onSelectEnemy,
  combatEntities = [],
  combatPresentation,
  onResetZoomReady,
  onSelectDroppedItem,
  targeting = false,
  onTargetPosition,
  onStageElementChange,
  targetPreview = null,
  debugOverlayEnabled = false
}: Props): React.JSX.Element {
  const dungeonName = snapshot.name || "Cistern Warrens";
  const stageRef = useRef<HTMLDivElement>(null);
  const pointerPositionsRef = useRef(new Map<number, { x: number; y: number }>());
  const capturedPointerIdsRef = useRef(new Set<number>());
  const buttonTouchPointerIdsRef = useRef(new Set<number>());
  const pointerGestureSuppressedRef = useRef(false);
  const suppressClicksUntilRef = useRef(0);
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const ignoreUntrackedPointerUpsRef = useRef(true);
  const zoomLimits: DungeonZoomLimits = snapshot.camera;
  const [zoom, setZoom] = useState(() => initialDungeonZoom(zoomLimits));
  const applyZoom = useCallback((nextZoom: number): void => {
    const clamped = clampDungeonZoom(nextZoom, snapshot.camera);
    setZoom(clamped);
    persistDungeonZoomPreference(clamped);
  }, [snapshot.camera]);
  const setStageElement = useCallback((element: HTMLDivElement | null) => {
    stageRef.current = element;
    onStageElementChange?.(element);
  }, [onStageElementChange]);
  const movementInput = useIndoorMovementInput({
    stageRef,
    roomWidth: snapshot.roomWidth,
    roomHeight: snapshot.roomHeight,
    movementDisabled: movementDisabled || targeting,
    onBeforeMove: () => undefined,
    onMove,
    useTransformedBounds: true,
    pointerGestureSuppressedRef
  });
  const resetLocalInput = useCallback((): void => {
    const stage = stageRef.current;
    for (const pointerId of capturedPointerIdsRef.current) {
      releaseDungeonPointerCapture(stage, pointerId);
    }
    capturedPointerIdsRef.current.clear();
    buttonTouchPointerIdsRef.current.clear();
    pointerPositionsRef.current.clear();
    pinchRef.current = null;
    pointerGestureSuppressedRef.current = false;
    suppressClicksUntilRef.current = 0;
    ignoreUntrackedPointerUpsRef.current = true;
    movementInput.clearPendingMovement();
  }, [movementInput.clearPendingMovement]);
  const resetZoom = useCallback((): void => {
    applyZoom(snapshot.camera.defaultZoom);
    resetLocalInput();
  }, [applyZoom, resetLocalInput, snapshot.camera.defaultZoom]);
  useEffect(() => {
    onResetZoomReady?.(resetZoom);
    return () => onResetZoomReady?.(null);
  }, [onResetZoomReady, resetZoom]);
  useEffect(() => {
    setZoom(initialDungeonZoom(snapshot.camera));
    resetLocalInput();
  }, [resetLocalInput, snapshot.instanceId, snapshot.spaceId, snapshot.camera.minZoom,
    snapshot.camera.defaultZoom, snapshot.camera.maxZoom]);
  useEffect(() => {
    const reset = (): void => resetLocalInput();
    document.addEventListener("visibilitychange", reset);
    window.addEventListener("blur", reset);
    window.addEventListener("pagehide", reset);
    window.addEventListener("pageshow", reset);
    return () => {
      document.removeEventListener("visibilitychange", reset);
      window.removeEventListener("blur", reset);
      window.removeEventListener("pagehide", reset);
      window.removeEventListener("pageshow", reset);
    };
  }, [resetLocalInput]);
  useEffect(() => () => resetLocalInput(), [resetLocalInput]);
  const pctX = (value: number): string => `${value / snapshot.roomWidth * 100}%`;
  const pctY = (value: number): string => `${value / snapshot.roomHeight * 100}%`;
  const zoneId = `interior:${snapshot.instanceId}:${snapshot.spaceId}`;
  const renderedDrops = drops
    .filter((drop) => drop.status === "active" && drop.zoneId === zoneId)
    .sort((left, right) =>
      (left.pileOrder ?? 0) - (right.pileOrder ?? 0)
      || left.dropId.localeCompare(right.dropId)
    );
  const renderedStacks = stackDroppedItemsForWorld(renderedDrops);
  const pileOffsets = new Map<string, number>();
  const pileOffset = cisternWarrensStoredDistanceToIndoor(3);

  return <IndoorSceneViewport className="dungeon-zone" ariaLabel={dungeonName}>
    <div
      className="dungeon-stage-shell"
      style={{
        "--dungeon-fit-padding": `${snapshot.camera.fitPadding}px`,
        "--dungeon-background-color": snapshot.environment.backgroundColor,
        "--dungeon-floor-color": snapshot.environment.floorColor,
        "--dungeon-wall-color": snapshot.environment.wallColor,
        "--dungeon-accent-color": snapshot.environment.accentColor
      } as CSSProperties}
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        applyZoom(dungeonWheelZoom(zoom, event.deltaY, zoomLimits));
      }}
    >
      <IndoorSceneStage
        roomWidth={snapshot.roomWidth}
        roomHeight={snapshot.roomHeight}
        scale={zoom}
        frameClassName="dungeon-stage-frame"
        innerClassName="dungeon-stage cistern-warrens-stage"
        stageRef={setStageElement}
        onClick={movementInput.onClick}
        onDoubleClick={movementInput.onDoubleClick}
        onPointerDownCapture={(event) => {
        if (event.pointerType !== "touch") return;
        // A backgrounded app can lose the final pointer-up/cancel. If no
        // pointer remains active, a new touch starts a fresh gesture even when
        // the interrupted gesture's suppression window has not elapsed.
        if (pointerPositionsRef.current.size === 0 &&
            buttonTouchPointerIdsRef.current.size === 0 &&
            (pointerGestureSuppressedRef.current ||
              performance.now() < suppressClicksUntilRef.current)) {
          pinchRef.current = null;
          pointerGestureSuppressedRef.current = false;
          suppressClicksUntilRef.current = 0;
        }
        movementInput.onPointerDownCapture(event);
        const target = event.target as Element | null;
        if (target?.closest("button")) {
          if (Number.isFinite(event.pointerId)) {
            const buttonTouches = buttonTouchPointerIdsRef.current;
            if (buttonTouches.size > 0) {
              pointerGestureSuppressedRef.current = true;
              suppressClicksUntilRef.current = performance.now() + 500;
              movementInput.clearPendingMovement();
            }
            buttonTouches.add(event.pointerId);
          }
          return;
        }
        // Some test/browser shims omit pointerId on pointerdown. Preserve the
        // legacy untracked-up path only for that incomplete event shape; real
        // pointer streams remain generation-safe across lifecycle resets.
        if (!Number.isFinite(event.pointerId)) {
          ignoreUntrackedPointerUpsRef.current = false;
          return;
        }
        event.currentTarget.setPointerCapture?.(event.pointerId);
        capturedPointerIdsRef.current.add(event.pointerId);
        pointerPositionsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointerPositionsRef.current.size < 2) return;
        pointerGestureSuppressedRef.current = true;
        suppressClicksUntilRef.current = performance.now() + 500;
        movementInput.clearPendingMovement();
        const [first, second] = [...pointerPositionsRef.current.values()];
        pinchRef.current = { distance: Math.hypot(second!.x - first!.x, second!.y - first!.y), zoom };
        }}
        onPointerMove={(event) => {
        movementInput.onPointerMove(event);
        if (event.pointerType !== "touch" || !pointerPositionsRef.current.has(event.pointerId)) return;
        pointerPositionsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (!pinchRef.current || pointerPositionsRef.current.size < 2) return;
        event.preventDefault();
        event.stopPropagation();
        const [first, second] = [...pointerPositionsRef.current.values()];
        applyZoom(dungeonPinchZoom(
          pinchRef.current.zoom,
          pinchRef.current.distance,
          Math.hypot(second!.x - first!.x, second!.y - first!.y),
          zoomLimits
        ));
        }}
        onPointerUp={(event) => {
        const suppressedGesture = pointerGestureSuppressedRef.current;
        const trackedPointer = pointerPositionsRef.current.has(event.pointerId);
        pointerPositionsRef.current.delete(event.pointerId);
        capturedPointerIdsRef.current.delete(event.pointerId);
        buttonTouchPointerIdsRef.current.delete(event.pointerId);
        releaseDungeonPointerCapture(event.currentTarget, event.pointerId);
        if (pointerPositionsRef.current.size === 0 && buttonTouchPointerIdsRef.current.size === 0 &&
            (suppressedGesture || performance.now() >= suppressClicksUntilRef.current)) {
          pinchRef.current = null;
          pointerGestureSuppressedRef.current = false;
        }
        // The releases belonging to a pinch/multi-touch gesture must not be
        // interpreted as taps, but the suppression must end with that gesture
        // so a later double-tap remains usable.
        if (!suppressedGesture &&
            (trackedPointer || !ignoreUntrackedPointerUpsRef.current)) {
          movementInput.onPointerUp(event);
        }
        }}
        onPointerCancel={(event) => {
        movementInput.onPointerCancel(event);
        const hasPointerId = Number.isFinite(event.pointerId);
        const trackedPointer = hasPointerId
          ? pointerPositionsRef.current.has(event.pointerId)
            || capturedPointerIdsRef.current.has(event.pointerId)
            || buttonTouchPointerIdsRef.current.has(event.pointerId)
          : pointerPositionsRef.current.size > 0
            || capturedPointerIdsRef.current.size > 0
            || buttonTouchPointerIdsRef.current.size > 0;
        if (!trackedPointer) return;
        if (hasPointerId) {
          pointerPositionsRef.current.delete(event.pointerId);
          capturedPointerIdsRef.current.delete(event.pointerId);
          buttonTouchPointerIdsRef.current.delete(event.pointerId);
        } else {
          pointerPositionsRef.current.clear();
          capturedPointerIdsRef.current.clear();
          buttonTouchPointerIdsRef.current.clear();
        }
        releaseDungeonPointerCapture(event.currentTarget, event.pointerId);
        movementInput.clearPendingMovement();
        if (pointerPositionsRef.current.size === 0 && buttonTouchPointerIdsRef.current.size === 0) {
          pinchRef.current = null;
          pointerGestureSuppressedRef.current = false;
        }
        }}
        onLostPointerCapture={(event) => {
        movementInput.onLostPointerCapture(event);
        const trackedPointer = Number.isFinite(event.pointerId) && (
          pointerPositionsRef.current.has(event.pointerId)
          || capturedPointerIdsRef.current.has(event.pointerId)
          || buttonTouchPointerIdsRef.current.has(event.pointerId)
        );
        // A normal phone stream dispatches lostpointercapture after pointerup.
        // At that point the pointer is intentionally no longer tracked and the
        // completed tap must remain available to the double-tap recognizer.
        // Only an active pointer can have its pending gesture cancelled by
        // capture loss; unknown/completed pointers are lifecycle no-ops.
        if (!trackedPointer) return;
        if (Number.isFinite(event.pointerId)) {
          pointerPositionsRef.current.delete(event.pointerId);
          capturedPointerIdsRef.current.delete(event.pointerId);
          buttonTouchPointerIdsRef.current.delete(event.pointerId);
        } else {
          pointerPositionsRef.current.clear();
          capturedPointerIdsRef.current.clear();
          buttonTouchPointerIdsRef.current.clear();
        }
        movementInput.clearPendingMovement();
        if (pointerPositionsRef.current.size === 0 && buttonTouchPointerIdsRef.current.size === 0) {
          pinchRef.current = null;
          pointerGestureSuppressedRef.current = false;
        }
        }}
        onClickCapture={(event) => {
        if (performance.now() < suppressClicksUntilRef.current) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (!targeting) return;
        const position = dungeonStageClientPointToCombatPosition(
          { x: event.clientX, y: event.clientY },
          event.currentTarget.getBoundingClientRect(),
          snapshot.roomWidth,
          snapshot.roomHeight
        );
        if (!position) return;
        event.preventDefault();
        event.stopPropagation();
        onTargetPosition?.(position);
        }}
      >
      <DungeonRoomPresentation
        snapshot={snapshot}
        onSelectObject={onSelectObject}
        {...(onSelectResource ? { onSelectResource } : {})}
        actors={<>
      <BossTelegraphLayer
        telegraphs={snapshot.telegraphs}
        roomWidth={snapshot.roomWidth}
        roomHeight={snapshot.roomHeight}
        serverNow={snapshot.serverTime}
      />
      {targetPreview?.rangeM ? <div
        className="dungeon-ability-target-range"
        aria-hidden="true"
        style={{
          left: pctX(snapshot.player.x),
          top: pctY(snapshot.player.y),
          width: pctX(dungeonCombatMetersToLocalDistance(targetPreview.rangeM) * 2),
          height: pctY(dungeonCombatMetersToLocalDistance(targetPreview.rangeM) * 2)
        }}
      /> : null}
      {targetPreview ? (() => {
        const local = combatPositionToDungeonLocal(targetPreview.position);
        const radius = targetPreview.radiusM
          ? dungeonCombatMetersToLocalDistance(targetPreview.radiusM)
          : pileOffset;
        return <div
          className="dungeon-ability-target-preview"
          role="status"
          aria-label="Class ability target preview"
          style={{ left: pctX(local.x), top: pctY(local.y), width: pctX(radius * 2), height: pctY(radius * 2) }}
        ><span aria-hidden="true" /></div>;
      })() : null}
      {renderedStacks.map((stack) => {
        const drop = stack.displayDrop;
        const position = combatPositionToDungeonLocal(drop);
        const ground = groundItemGeometryForArtwork(
          drop.itemId,
          drop.variant,
          snapshot.playerVisualHeight
        );
        const pileId = drop.pileId ?? drop.dropId;
        const pileIndex = pileOffsets.get(pileId) ?? 0;
        pileOffsets.set(pileId, pileIndex + 1);
        return <button
          key={stack.key}
          type="button"
          className="dungeon-ground-loot"
          data-ground-visual-height={ground.visualHeightUnits}
          data-ground-hit-mode={ground.geometry.shape === "rectangle" && ground.geometry.width === 1 && ground.geometry.height === 1 ? "locked" : "custom"}
          style={{
            left: pctX(position.x + ((pileIndex % 3) - 1) * pileOffset + ground.hitOffsetXUnits),
            top: pctY(position.y - Math.floor(pileIndex / 3) * pileOffset + ground.hitOffsetYUnits),
            width: pctX(ground.hitWidthUnits),
            height: pctY(ground.hitHeightUnits),
            boxSizing: "border-box"
          }}
          aria-label={`Inspect dropped ${drop.itemId.replaceAll("_", " ")}`}
          onClick={() => onSelectDroppedItem(drop)}
        >
          <span
            className="dungeon-ground-visual-frame"
            style={{
              width: `${ground.visualWidthUnits / Math.max(ground.hitWidthUnits, 0.001) * 100}%`,
              height: `${ground.visualHeightUnits / Math.max(ground.hitHeightUnits, 0.001) * 100}%`
            }}
          >
            <ItemArtwork itemId={drop.itemId} variant={drop.variant} size="ground" nameTooltip="hover-only" label={drop.itemId.replaceAll("_", " ")} />
          </span>
        </button>;
      })}
      <DungeonEntityLayer
        player={snapshot.player}
        occupants={snapshot.occupants}
        displayColor={snapshot.player.displayColor}
        sessionId={snapshot.sessionId}
        spaceId={snapshot.spaceId}
        serverTime={snapshot.serverTime}
        roomWidth={snapshot.roomWidth}
        roomHeight={snapshot.roomHeight}
        playerVisualHeight={snapshot.playerVisualHeight}
        combatEntities={combatEntities}
        {...(combatPresentation ? { combatPresentation } : {})}
        ariaLabel={`${snapshot.player.name} and ${dungeonName} occupants`}
      />
      <DungeonEnemyLayer
        enemies={snapshot.enemies}
        roomWidth={snapshot.roomWidth}
        roomHeight={snapshot.roomHeight}
        playerVisualHeight={snapshot.playerVisualHeight}
        combatEntities={combatEntities}
        {...(combatPresentation ? { combatPresentation } : {})}
        {...(onSelectEnemy ? { onSelectEnemy } : {})}
      />
      {combatPresentation ? <DungeonCombatFeedback
        snapshot={snapshot}
        combatEntities={combatEntities}
        combatPresentation={combatPresentation}
      /> : null}
        </>}
      />
    </IndoorSceneStage>
      {debugOverlayEnabled ? <aside className="dungeon-debug-overlay" aria-label="Dungeon debug overlay">
        <strong>{snapshot.dungeonId}/{snapshot.spaceId}</strong>
        <span>Revision {snapshot.dungeonRevision}</span>
        <span>{snapshot.objects.length} objects · {snapshot.enemies.length} enemies</span>
        <span>{snapshot.completed ? "Completed" : "Active"}</span>
      </aside> : null}
    </div>
  </IndoorSceneViewport>;
}
