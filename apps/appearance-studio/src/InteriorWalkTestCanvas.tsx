import { useEffect, useMemo, useRef, useState } from "react";
import { Application, Assets, Container, Graphics, Sprite } from "pixi.js";
import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  MANOR_PLAYER_VISUAL_HEIGHT_UNITS,
  STANDARD_INDOOR_SPATIAL_PROFILE,
  advanceIndoorVector,
  findIndoorNavigationRoute,
  interiorNavigation,
  manorPointInPolygon,
  type IndoorNavigationCollider,
  type IndoorPoint,
  type IndoorRoomNavigation,
  type InteriorRoom,
  type InteriorSpace
} from "@ash-atlas/shared";
import { PixiTextureCache, PlayerRenderer } from "@ash-atlas/player-renderer";
import { GameActionPrompt } from "../../client/src/ui/GameActionPrompt.js";
import { DebugToggle } from "./InteriorCanvasFields.js";
import { clamp } from "./interiorCanvasAuthoring.js";
import { decorationWalkColliders } from "./interiorDecorationModel.js";

const RUNTIME_ASSET_URL = (assetKey: string): string => assetKey.startsWith("data:image/svg+xml,") ? assetKey : `/runtime-assets/${assetKey}`;
const WALK_PLAYER_APPEARANCE = {
  schemaVersion: 1 as const,
  catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision,
  revision: 0,
  bodyVariantId: "default" as const,
  poseId: "idle" as const,
  slots: {},
  activeHand: null
} satisfies Parameters<PlayerRenderer["updateAppearance"]>[0];

export type WalkTestDebugOverlay = {
  feet: boolean;
  collisionFootprint: boolean;
  navigation: boolean;
  hotspotsAnchors: boolean;
  logicalCoordinates: boolean;
  renderedDimensions: boolean;
  cameraScale: boolean;
};

export type WalkTestAnchor = {
  id: string;
  retired?: boolean;
  x: number;
  y: number;
  kind: "spawn" | "portal" | "message" | "point";
  message?: string;
  locked?: boolean;
  destinationRoomId?: string;
  destinationAnchorId?: string;
};
export type WalkTestHotspot = { anchorId: string; retired?: boolean; interactionLabel: string; polygon: readonly IndoorPoint[] };
/** The narrow room model the Walk Test needs; every interior kind adapts its own room to this. */
export type WalkTestRoom = {
  id: string;
  name: string;
  width: number;
  height: number;
  spawnAnchorId: string;
  anchors: readonly WalkTestAnchor[];
  hotspots: readonly WalkTestHotspot[];
  /** Prebuilt movement inputs (drawn floors, colliders and any extra blockers). */
  navigation: IndoorRoomNavigation;
};

function colliderPoints(collider: IndoorNavigationCollider): readonly IndoorPoint[] {
  return "points" in collider
    ? collider.points
    : [{ x: collider.minX, y: collider.minY }, { x: collider.maxX, y: collider.minY }, { x: collider.maxX, y: collider.maxY }, { x: collider.minX, y: collider.maxY }];
}

/** Resolve a click area to a read-only authored message for the Walk Test. */
export function doorClickMessage(room: WalkTestRoom, point: IndoorPoint): { title: string; text: string } | null {
  for (const hotspot of room.hotspots) {
    if (hotspot.retired || !manorPointInPolygon(point, hotspot.polygon)) continue;
    const anchor = room.anchors.find((value) => value.id === hotspot.anchorId && !value.retired);
    if (!anchor || anchor.kind !== "message" || !anchor.message?.trim()) continue;
    return { title: hotspot.interactionLabel, text: anchor.message.trim() };
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function InteriorWalkTestCanvas(props: {
  room: WalkTestRoom;
  arrivalAnchorId?: string | null;
  onTraverse?(roomId: string, anchorId: string): void;
  assetKey: string;
  viewZoom: number;
  viewPan: IndoorPoint;
  debug: WalkTestDebugOverlay;
  onViewZoom(value: number): void;
  onViewPan(value: IndoorPoint): void;
  onLogicalPoint(point: IndoorPoint): void;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerPositionRef = useRef<IndoorPoint | null>(null);
  const routeRef = useRef<IndoorPoint[]>([]);
  const panRef = useRef(props.viewPan);
  const zoomRef = useRef(props.viewZoom);
  const onLogicalPointRef = useRef(props.onLogicalPoint);
  const onViewPanRef = useRef(props.onViewPan);
  const onViewZoomRef = useRef(props.onViewZoom);
  const pointerRef = useRef<{ x: number; y: number; origin: IndoorPoint } | null>(null);
  const [status, setStatus] = useState("Double-click a walkable location to move.");
  const [messagePopup, setMessagePopup] = useState<{ title: string; text: string } | null>(null);
  const [portalPopup, setPortalPopup] = useState<WalkTestAnchor | null>(null);
  const [metrics, setMetrics] = useState({ fit: 1, renderedWidth: props.room.width, renderedHeight: props.room.height });
  useEffect(() => { panRef.current = props.viewPan; }, [props.viewPan]);
  useEffect(() => { zoomRef.current = props.viewZoom; }, [props.viewZoom]);
  useEffect(() => { onLogicalPointRef.current = props.onLogicalPoint; }, [props.onLogicalPoint]);
  useEffect(() => { onViewPanRef.current = props.onViewPan; }, [props.onViewPan]);
  useEffect(() => { onViewZoomRef.current = props.onViewZoom; }, [props.onViewZoom]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let initialized = false;
    let destroyed = false;
    const app = new Application();
    let animationFrame: number | null = null;
    let previousFrameTime: number | null = null;
    const destroy = (): void => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      // Pixi's ticker is created by Application.init(). React StrictMode can
      // clean up this effect while that async initialization is still pending.
      if (!initialized || destroyed) return;
      destroyed = true;
      app.ticker?.stop();
      app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
    };
    const roomRoot = new Container();
    const layer = new Container();
    const debugLayer = new Container();
    const playerLayer = new Container();
    roomRoot.addChild(layer, playerLayer, debugLayer);
    const initialize = async (): Promise<() => void> => {
      await app.init({ width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight), backgroundColor: 0x071116, antialias: true, autoStart: false, sharedTicker: false });
      initialized = true;
      if (disposed) { destroy(); return () => { /* disposed before setup completed */ }; }
      host.replaceChildren(app.canvas);
      app.stage.addChild(roomRoot);
      const floorTexture = await Assets.load(RUNTIME_ASSET_URL(props.assetKey));
      if (disposed) return () => { /* disposed before texture load completed */ };
      const floor = new Sprite(floorTexture);
      floor.width = props.room.width;
      floor.height = props.room.height;
      layer.addChild(floor);
      const background = new Graphics().rect(0, 0, props.room.width, props.room.height).fill(0x182a2d);
      layer.addChildAt(background, 0);
      const player = new PlayerRenderer({ local: true, color: 0x48c8de, catalog: DEFAULT_PLAYER_APPEARANCE_CATALOG, textureLoader: new PixiTextureCache((assetKey) => `/appearance-assets/${assetKey}`) });
      await player.updateAppearance(WALK_PLAYER_APPEARANCE);
      if (disposed) { player.destroy(); return () => { /* disposed before player setup completed */ }; }
      playerLayer.addChild(player.root);
      const spawn = props.room.anchors.find((value) => value.id === (props.arrivalAnchorId ?? props.room.spawnAnchorId) && !value.retired) ?? props.room.anchors.find((value) => !value.retired) ?? { x: props.room.width / 2, y: props.room.height / 2 };
      playerPositionRef.current = { x: spawn.x, y: spawn.y };
      const staticDebug = new Graphics();
      debugLayer.addChild(staticDebug);
      const dynamicDebug = new Graphics();
      debugLayer.addChild(dynamicDebug);
      if (props.debug.navigation) {
        for (const surface of props.room.navigation.walkableSurfaces ?? []) staticDebug.poly(surface.flatMap((point) => [point.x, point.y])).fill({ color: 0x48c8de, alpha: 0.13 }).stroke({ color: 0x48c8de, width: 2 });
        for (const collider of props.room.navigation.colliders) staticDebug.poly(colliderPoints(collider).flatMap((point) => [point.x, point.y])).fill({ color: 0xef4444, alpha: 0.34 }).stroke({ color: 0xff3030, width: 3 });
      }
      if (props.debug.hotspotsAnchors) {
        for (const hotspot of props.room.hotspots.filter((value) => !value.retired)) staticDebug.poly(hotspot.polygon.flatMap((point) => [point.x, point.y])).fill({ color: 0xe879f9, alpha: 0.18 }).stroke({ color: 0xe879f9, width: 2 });
        for (const anchor of props.room.anchors.filter((value) => !value.retired)) staticDebug.circle(anchor.x, anchor.y, 10).fill({ color: 0xe5b94d, alpha: 0.85 });
      }
      const updateTransform = (): void => {
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        const fit = Math.min(width / props.room.width, height / props.room.height) * zoomRef.current;
        roomRoot.scale.set(fit);
        roomRoot.position.set(width / 2 - props.room.width * fit / 2 + panRef.current.x, height / 2 - props.room.height * fit / 2 + panRef.current.y);
        setMetrics({ fit, renderedWidth: props.room.width * fit, renderedHeight: props.room.height * fit });
      };
      const render = (): void => {
        if (disposed) return;
        const position = playerPositionRef.current;
        if (position) {
          player.root.position.set(position.x, position.y);
          // The room root owns camera fit/zoom. Keep the player scale in the
          // same logical units as production's positionActor helper so the
          // effective rendered height is exactly the indoor profile height.
          player.root.scale.set(MANOR_PLAYER_VISUAL_HEIGHT_UNITS / player.baseHeightPx);
          dynamicDebug.clear();
          if (props.debug.feet) dynamicDebug.moveTo(position.x - 14, position.y).lineTo(position.x + 14, position.y).stroke({ color: 0xffffff, width: 3 });
          if (props.debug.collisionFootprint) dynamicDebug.circle(position.x, position.y, STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius).stroke({ color: 0xff3030, width: 2 });
          if (props.debug.renderedDimensions) dynamicDebug.rect(position.x - 20, position.y - MANOR_PLAYER_VISUAL_HEIGHT_UNITS, 40, MANOR_PLAYER_VISUAL_HEIGHT_UNITS).stroke({ color: 0xe5b94d, width: 1 });
          const next = routeRef.current[0];
          if (next) {
            const now = performance.now();
            const elapsedMs = previousFrameTime === null ? 0 : clamp(now - previousFrameTime, 0, 100);
            previousFrameTime = now;
            const advance = advanceIndoorVector(
              position,
              next,
              STANDARD_INDOOR_SPATIAL_PROFILE.movementUnitsPerSecond * elapsedMs / 1000
            );
            playerPositionRef.current = { x: advance.x, y: advance.y };
            if (advance.arrived) routeRef.current.shift();
          }
        }
        updateTransform();
        app.render();
        if (routeRef.current.length > 0) animationFrame = window.requestAnimationFrame(render);
      };
      const moveTo = (point: IndoorPoint): void => {
        const position = playerPositionRef.current;
        if (!position) return;
        setMessagePopup(null);
        const route = findIndoorNavigationRoute(props.room.navigation, position, point);
        if (!route) { setStatus("That location is outside the floor or blocked by a collision polygon."); return; }
        routeRef.current = route;
        previousFrameTime = null;
        setStatus(`Walking to ${Math.round(point.x)}, ${Math.round(point.y)}.`);
        animationFrame = window.requestAnimationFrame(render);
      };
      const pointFromPointer = (event: PointerEvent): IndoorPoint => {
        const bounds = host.getBoundingClientRect();
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        const logicalX = (event.clientX - bounds.left) * width / Math.max(1, bounds.width);
        const logicalY = (event.clientY - bounds.top) * height / Math.max(1, bounds.height);
        const fit = Math.min(width / props.room.width, height / props.room.height) * zoomRef.current;
        return { x: clamp((logicalX - width / 2 - panRef.current.x) / fit + props.room.width / 2, 0, props.room.width), y: clamp((logicalY - height / 2 - panRef.current.y) / fit + props.room.height / 2, 0, props.room.height) };
      };
      const onPointerDown = (event: PointerEvent): void => { const point = pointFromPointer(event); onLogicalPointRef.current(point); pointerRef.current = { x: event.clientX, y: event.clientY, origin: panRef.current }; host.setPointerCapture(event.pointerId); };
      const onPointerMove = (event: PointerEvent): void => { const point = pointFromPointer(event); onLogicalPointRef.current(point); const pointer = pointerRef.current; if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4) onViewPanRef.current({ x: pointer.origin.x + event.clientX - pointer.x, y: pointer.origin.y + event.clientY - pointer.y }); };
      const onPointerUp = (event: PointerEvent): void => {
        const pointer = pointerRef.current;
        pointerRef.current = null;
        const point = pointFromPointer(event);
        onLogicalPointRef.current(point);
        if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 8) {
          const hotspot = props.room.hotspots.find((value) => !value.retired && manorPointInPolygon(point, value.polygon));
          const anchor = props.room.anchors.find((value) => value.id === hotspot?.anchorId && !value.retired && value.kind === "portal");
          if (anchor) { routeRef.current = []; setPortalPopup(anchor); return; }
          const message = doorClickMessage(props.room, point);
          if (message) {
            routeRef.current = [];
            setMessagePopup(message);
            setStatus(`${message.title}: message opened.`);
          } else {
            moveTo(point);
          }
        }
      };
      const onWheel = (event: WheelEvent): void => { event.preventDefault(); onViewZoomRef.current(clamp(zoomRef.current - event.deltaY * 0.001, 0.5, 3)); };
      host.addEventListener("pointerdown", onPointerDown); host.addEventListener("pointermove", onPointerMove); host.addEventListener("pointerup", onPointerUp); host.addEventListener("pointercancel", onPointerUp); host.addEventListener("wheel", onWheel, { passive: false });
      updateTransform();
      render();
      let cleanedUp = false;
      return () => {
        if (cleanedUp) return;
        cleanedUp = true;
        host.removeEventListener("pointerdown", onPointerDown);
        host.removeEventListener("pointermove", onPointerMove);
        host.removeEventListener("pointerup", onPointerUp);
        host.removeEventListener("pointercancel", onPointerUp);
        host.removeEventListener("wheel", onWheel);
        player.destroy();
      };
    };
    let cleanupInner: (() => void) | undefined;
    void initialize().then((cleanup) => {
      cleanupInner = cleanup;
      // The effect may have been cleaned up between the final await and this
      // continuation. Release listeners/player resources even in that race.
      if (disposed) cleanup();
    }).catch((caught: unknown) => { if (!disposed) setStatus(errorMessage(caught)); });
    return () => { disposed = true; cleanupInner?.(); destroy(); };
  }, [props.assetKey, props.debug, props.room]);
  return <div className="manor-walk-canvas-wrap ash-atlas-compact-ui">
    <div ref={hostRef} className="manor-walk-canvas" aria-label={`${props.room.name} exact player Walk Test`} />
    <div className="manor-walk-overlay" role="status"><span>{status}</span>{props.debug.renderedDimensions ? <span>Rendered room {Math.round(metrics.renderedWidth)} × {Math.round(metrics.renderedHeight)} px</span> : null}{props.debug.cameraScale ? <span>Camera scale {metrics.fit.toFixed(3)}×</span> : null}</div>
    {messagePopup ? <GameActionPrompt title={messagePopup.title} category="NOTICE" message={{ text: messagePopup.text }} actions={[]} cancelLabel="Close" ariaLabel="Door message" onCancel={() => setMessagePopup(null)} /> : null}
    {portalPopup ? <GameActionPrompt title={props.room.hotspots.find((value) => value.anchorId === portalPopup.id)?.interactionLabel ?? "Room door"} category="PORTAL" actions={[{ key: "enter", label: "Enter room", enabled: !portalPopup.locked, disabledReason: "This door is locked.", onSelect: () => { if (portalPopup.destinationRoomId && portalPopup.destinationAnchorId) props.onTraverse?.(portalPopup.destinationRoomId, portalPopup.destinationAnchorId); setPortalPopup(null); } }]} onCancel={() => setPortalPopup(null)} /> : null}
  </div>;
}

/** Adapt an exported interior room (drawn floors, colliders, decoration footprints, typed anchors, click areas) to the Walk Test model. */
export function interiorWalkTestRoom(space: InteriorSpace, room: InteriorRoom): WalkTestRoom {
  const portalOf = (anchorId: string) => space.portals.find((portal) => portal.source.kind === "room" && portal.source.roomId === room.id && portal.source.anchorId === anchorId);
  return {
    id: room.id,
    name: room.name,
    width: room.width,
    height: room.height,
    spawnAnchorId: room.spawnAnchorId,
    anchors: room.anchors.map((anchor): WalkTestAnchor => {
      const destination = anchor.role === "portal" ? portalOf(anchor.id)?.destination : undefined;
      return {
        id: anchor.id,
        retired: anchor.retired,
        x: anchor.x,
        y: anchor.y,
        kind: anchor.role,
        ...(anchor.message ? { message: anchor.message } : {}),
        ...(destination?.kind === "room" ? { destinationRoomId: destination.roomId, destinationAnchorId: destination.anchorId } : {})
      };
    }),
    hotspots: room.clickAreas.flatMap((area) => {
      const anchorId = "anchorId" in area.target ? area.target.anchorId : room.objects.find((object) => object.id === (area.target as { objectId: string }).objectId)?.anchorId;
      return anchorId ? [{ anchorId, retired: area.retired, interactionLabel: area.interactionLabel, polygon: area.polygon }] : [];
    }),
    // Collision-enabled decorations block like they do for players in the Manor.
    navigation: interiorNavigation(room, decorationWalkColliders(room, space.modules?.decoration?.definitions ?? []))
  };
}

/** Floor-only backdrop for rooms without authored art. */
function interiorPlaceholderDataUrl(room: InteriorRoom): string {
  const floors = room.floors.filter((floor) => !floor.retired)
    .map((floor) => `<polygon points="${floor.polygon.map((point) => `${point.x},${point.y}`).join(" ")}" fill="#302a23" stroke="#8e754b" stroke-width="3"/>`).join("");
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${room.width}" height="${room.height}" viewBox="0 0 ${room.width} ${room.height}"><rect width="100%" height="100%" fill="#182a2d"/>${floors}</svg>`)}`;
}

const DEFAULT_WALK_DEBUG: WalkTestDebugOverlay = { feet: false, collisionFootprint: false, navigation: true, hotspotsAnchors: true, logicalCoordinates: false, renderedDimensions: false, cameraScale: false };

/** Walk Test for any interior kind: the exported room's drawn floors are the only walkable surface. */
export function InteriorWalkTest(props: { space: InteriorSpace; roomId: string; onExit(): void }): React.JSX.Element {
  const [roomId, setRoomId] = useState(props.roomId);
  const [arrivalId, setArrivalId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<IndoorPoint>({ x: 0, y: 0 });
  const [debug, setDebug] = useState(DEFAULT_WALK_DEBUG);
  const [coordinate, setCoordinate] = useState<IndoorPoint | null>(null);
  const room = props.space.rooms.find((value) => value.id === roomId) ?? props.space.rooms[0]!;
  // The exported space is rebuilt on every edit render; only its content may restart the Pixi scene.
  const identity = JSON.stringify([room, props.space.portals, props.space.modules?.decoration?.definitions]);
  const walkRoom = useMemo(() => interiorWalkTestRoom(props.space, room), [identity]);
  const assetKey = (room.id === props.space.defaultRoomId ? props.space.environment.floorAssetKey : undefined) ?? interiorPlaceholderDataUrl(room);
  const toggle = (key: keyof WalkTestDebugOverlay): void => setDebug((value) => ({ ...value, [key]: !value[key] }));
  return <section className="manor-walk-layout dungeon-studio" aria-label="Interior Walk Test">
    <div className="manor-walk-main"><InteriorWalkTestCanvas key={`${room.id}:${arrivalId}`} arrivalAnchorId={arrivalId} onTraverse={(nextRoom, anchorId) => { setArrivalId(anchorId); setRoomId(nextRoom); }} room={walkRoom} assetKey={assetKey} viewZoom={zoom} viewPan={pan} debug={debug} onViewZoom={setZoom} onViewPan={setPan} onLogicalPoint={setCoordinate} /></div>
    <aside className="manor-test-panel panel">
      <h3>Walk Test</h3>
      <p>Walk the exact player over the floors you drew. Movement is limited to floor polygons and stops at colliders; click areas open their portal or message.</p>
      <div className="manor-test-facts"><span>Room {room.width} × {room.height}</span><span>Player radius {STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius}</span><span>Movement {STANDARD_INDOOR_SPATIAL_PROFILE.movementUnitsPerSecond} units/s</span>{debug.logicalCoordinates && coordinate ? <span>Logical coordinates {Math.round(coordinate.x)}, {Math.round(coordinate.y)}</span> : null}</div>
      <label className="field compact"><span>Room</span><select value={room.id} onChange={(event) => { setArrivalId(null); setRoomId(event.target.value); }}>{props.space.rooms.filter((value) => !value.retired).map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
      <div className="manor-debug-toggles">
        <DebugToggle label="Feet" checked={debug.feet} onChange={() => toggle("feet")} />
        <DebugToggle label="Collision footprint" checked={debug.collisionFootprint} onChange={() => toggle("collisionFootprint")} />
        <DebugToggle label="Floor navigation / collision" checked={debug.navigation} onChange={() => toggle("navigation")} />
        <DebugToggle label="Hotspots / anchors" checked={debug.hotspotsAnchors} onChange={() => toggle("hotspotsAnchors")} />
        <DebugToggle label="Logical coordinates" checked={debug.logicalCoordinates} onChange={() => toggle("logicalCoordinates")} />
        <DebugToggle label="Effective rendered dimensions" checked={debug.renderedDimensions} onChange={() => toggle("renderedDimensions")} />
        <DebugToggle label="Camera scale" checked={debug.cameraScale} onChange={() => toggle("cameraScale")} />
      </div>
      <div className="manor-view-actions"><button type="button" onClick={() => setZoom((value) => Math.min(3, value + 0.1))}>+</button><button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}>−</button><button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Reset View</button><button type="button" onClick={props.onExit}>Back to editing</button></div>
    </aside>
  </section>;
}
