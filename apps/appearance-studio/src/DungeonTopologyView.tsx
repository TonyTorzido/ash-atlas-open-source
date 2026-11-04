import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { DungeonDefinition, DungeonPrefabDefinition } from "@ash-atlas/shared";
import { GameAppButton } from "../../client/src/ui/GameAppShell.js";
import {
  buildDungeonTopology, connectDungeonAnchors, findDungeonTopologyRoute, layoutDungeonTopology,
  topologyNodeHeight, topologyPortPoint, visibleTopologyPorts, TOPOLOGY_NODE_WIDTH,
  TOPOLOGY_NODE_HEADER_HEIGHT, TOPOLOGY_NODE_META_HEIGHT, TOPOLOGY_PORT_HEIGHT, TOPOLOGY_MORE_HEIGHT,
  type DungeonTopologyEdge, type DungeonTopologyIssue, type DungeonTopologyModel,
  type TopologyPoint, type TopologyPositions
} from "./dungeonTopology.js";
import "./DungeonTopologyView.css";

export type DungeonTopologyProps = Readonly<{
  dungeon: DungeonDefinition;
  prefabs: readonly DungeonPrefabDefinition[];
  selectedRoomId: string;
  selectedAnchorId?: string | null;
  disabled?: boolean;
  preferenceKey?: string;
  onSelectRoom(roomId: string): void;
  onSelectAnchor(roomId: string, anchorId: string): void;
  onEditRoom?(roomId: string): void;
  onChangeDungeon(edit: (draft: DungeonDefinition) => void): void;
}>;
type Endpoint = { roomId: string; anchorId: string };
type View = { x: number; y: number; zoom: number };
type Drag = { pointerId: number; clientX: number; clientY: number; origin: TopologyPoint; roomId?: string; moved: boolean };

const clampZoom = (zoom: number): number => Math.min(1.8, Math.max(0.15, zoom));

function loadPositions(key: string): TopologyPositions {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, TopologyPoint] => {
      const point = entry[1] as TopologyPoint | null;
      return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) < 100_000 && Math.abs(point.y) < 100_000);
    }));
  } catch { return {}; }
}

export function DungeonTopology(props: DungeonTopologyProps) {
  const model = useMemo(() => buildDungeonTopology(props.dungeon), [props.dungeon]);
  const [allAnchors, setAllAnchors] = useState(false);
  const storageKey = `ash-atlas-dungeon-topology:${props.preferenceKey ?? props.dungeon.id}`;
  const [manual, setManual] = useState<TopologyPositions>(() => loadPositions(storageKey));
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const initialFit = useRef<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [routeTarget, setRouteTarget] = useState("selected");
  const [source, setSource] = useState<Endpoint | null>(null);
  const [destination, setDestination] = useState<Endpoint | null>(null);
  const [bidirectional, setBidirectional] = useState(true);
  const [prefabId, setPrefabId] = useState("");
  const [notice, setNotice] = useState("");
  const [issueFilter, setIssueFilter] = useState<"all" | DungeonTopologyIssue["severity"]>("all");
  const id = useId().replace(/:/gu, "");
  const automatic = useMemo(() => layoutDungeonTopology(model, allAnchors), [model, allAnchors]);
  const positions = useMemo(() => ({ ...automatic, ...manual }), [automatic, manual]);
  const selectedRoom = model.rooms.find((room) => room.roomId === props.selectedRoomId);
  const selectedPort = selectedRoom?.ports.find((port) => port.anchorId === props.selectedAnchorId);
  const selectedEdge = model.edges.find((edge) => edge.portalId === selectedEdgeId);
  const targetId = routeTarget === "selected" ? props.selectedRoomId : routeTarget;
  const route = useMemo(() => findDungeonTopologyRoute(model, targetId), [model, targetId]);
  const portalPrefabs = props.prefabs.filter((prefab) => !prefab.retired && prefab.type === "portal");
  const portalPrefab = portalPrefabs.find((prefab) => prefab.id === prefabId) ?? portalPrefabs[0];
  const errorCount = model.issues.filter((issue) => issue.severity === "error").length;
  const warningCount = model.issues.filter((issue) => issue.severity === "warning").length;

  useEffect(() => { setManual(loadPositions(storageKey)); setSelectedEdgeId(null); setSource(null); setDestination(null); setNotice(""); initialFit.current = null; }, [storageKey]);
  useEffect(() => {
    const timeout = window.setTimeout(() => { try { localStorage.setItem(storageKey, JSON.stringify(manual)); } catch { /* Layout stays usable when storage is unavailable. */ } }, 180);
    return () => window.clearTimeout(timeout);
  }, [manual, storageKey]);
  useEffect(() => {
    if (selectedEdge && !(selectedEdge.source.kind === "room" && selectedEdge.source.roomId === props.selectedRoomId)
      && !(selectedEdge.destination.kind === "room" && selectedEdge.destination.roomId === props.selectedRoomId)) setSelectedEdgeId(null);
  }, [props.selectedRoomId, selectedEdge]);

  function fit(nextPositions: TopologyPositions = positions): void {
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds || !model.rooms.length) return;
    const minX = Math.min(...model.rooms.map((room) => nextPositions[room.roomId]?.x ?? 0)) - 130;
    const minY = Math.min(...model.rooms.map((room) => nextPositions[room.roomId]?.y ?? 0)) - 35;
    const maxX = Math.max(...model.rooms.map((room) => (nextPositions[room.roomId]?.x ?? 0) + TOPOLOGY_NODE_WIDTH)) + 150;
    const maxY = Math.max(...model.rooms.map((room) => (nextPositions[room.roomId]?.y ?? 0) + topologyNodeHeight(room, allAnchors))) + 35;
    const width = bounds.width || 800; const height = bounds.height || 600;
    const zoom = clampZoom(Math.min(width / (maxX - minX), height / (maxY - minY), 1));
    setView({ x: (width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (height - (maxY - minY) * zoom) / 2 - minY * zoom, zoom });
  }
  useEffect(() => {
    if (initialFit.current === storageKey || !viewport.current) return;
    initialFit.current = storageKey; fit();
  }, [storageKey, model.rooms.length, manual]);
  useEffect(() => {
    const host = viewport.current;
    if (!host) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const x = event.clientX - rect.left; const y = event.clientY - rect.top;
      setView((current) => {
        const zoom = clampZoom(current.zoom * Math.exp(-event.deltaY * 0.0015));
        return { zoom, x: x - (x - current.x) * zoom / current.zoom, y: y - (y - current.y) * zoom / current.zoom };
      });
    };
    host.addEventListener("wheel", wheel, { passive: false });
    return () => host.removeEventListener("wheel", wheel);
  }, []);

  function zoomBy(factor: number): void {
    const rect = viewport.current?.getBoundingClientRect();
    setView((current) => {
      const zoom = clampZoom(current.zoom * factor); const x = (rect?.width ?? 800) / 2; const y = (rect?.height ?? 600) / 2;
      return { zoom, x: x - (x - current.x) * zoom / current.zoom, y: y - (y - current.y) * zoom / current.zoom };
    });
  }
  function focusRoom(roomId: string): void {
    props.onSelectRoom(roomId);
    const point = positions[roomId]; const room = model.rooms.find((value) => value.roomId === roomId);
    const rect = viewport.current?.getBoundingClientRect();
    if (point && room && rect) setView((current) => ({ ...current, x: rect.width / 2 - (point.x + TOPOLOGY_NODE_WIDTH / 2) * current.zoom, y: rect.height / 2 - (point.y + topologyNodeHeight(room, allAnchors) / 2) * current.zoom }));
  }
  function selectAnchor(roomId: string, anchorId: string): void {
    if (source && source.roomId !== roomId) setDestination({ roomId, anchorId });
    setSelectedEdgeId(null); props.onSelectAnchor(roomId, anchorId);
  }
  function selectEdge(edge: DungeonTopologyEdge): void {
    setSelectedEdgeId(edge.portalId);
    const endpoint = edge.source.kind === "room" && model.rooms.some((room) => edge.source.kind === "room" && room.roomId === edge.source.roomId) ? edge.source
      : edge.destination.kind === "room" && model.rooms.some((room) => edge.destination.kind === "room" && room.roomId === edge.destination.roomId) ? edge.destination : null;
    if (endpoint) props.onSelectAnchor(endpoint.roomId, endpoint.anchorId);
  }
  function openIssue(issue: DungeonTopologyIssue): void {
    if (issue.roomId && model.rooms.some((room) => room.roomId === issue.roomId)) {
      focusRoom(issue.roomId);
      if (issue.anchorId) props.onSelectAnchor(issue.roomId, issue.anchorId);
      setSelectedEdgeId(issue.portalId ?? null);
    } else {
      const edge = model.edges.find((value) => value.portalId === issue.portalId);
      if (edge) selectEdge(edge);
    }
  }
  function beginDrag(event: ReactPointerEvent<HTMLElement>, roomId?: string): void {
    if (event.button !== 0) return;
    if (!roomId && (event.target as Element).closest(".dungeon-topology-node, .dungeon-topology-edge")) return;
    const origin = roomId ? positions[roomId] : view;
    if (!origin) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, origin, moved: false, ...(roomId ? { roomId } : {}) };
  }
  function moveDrag(event: ReactPointerEvent<HTMLElement>): void {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.clientX; const dy = event.clientY - active.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 4) active.moved = true;
    if (!active.moved) return;
    if (active.roomId) setManual((current) => ({ ...current, [active.roomId!]: { x: active.origin.x + dx / view.zoom, y: active.origin.y + dy / view.zoom } }));
    else setView((current) => ({ ...current, x: active.origin.x + dx, y: active.origin.y + dy }));
  }
  function endDrag(event: ReactPointerEvent<HTMLElement>): void {
    if (drag.current?.pointerId !== event.pointerId) return;
    suppressClick.current = drag.current.moved;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }
  function createConnection(): void {
    if (props.disabled || !source || !destination || !portalPrefab) return;
    try {
      // Validate before entering the parent's state updater so a failed connection creates no undo entry.
      const draft = structuredClone(props.dungeon);
      const portalId = connectDungeonAnchors(draft, source, destination, portalPrefab, bidirectional);
      props.onChangeDungeon((next) => { connectDungeonAnchors(next, source, destination, portalPrefab, bidirectional); });
      setSelectedEdgeId(portalId); props.onSelectAnchor(source.roomId, source.anchorId);
      setSource(null); setDestination(null); setNotice("Connection created with its portal objects. Use Undo to reverse it.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "The anchors could not be connected."); }
  }

  return <section className="dungeon-topology" aria-label="Dungeon topology" onPointerDown={(event) => event.stopPropagation()}
    style={{ "--topology-node-header-height": `${TOPOLOGY_NODE_HEADER_HEIGHT}px`, "--topology-node-meta-height": `${TOPOLOGY_NODE_META_HEIGHT}px`,
      "--topology-port-height": `${TOPOLOGY_PORT_HEIGHT}px`, "--topology-more-height": `${TOPOLOGY_MORE_HEIGHT}px` } as CSSProperties}>
    <div className="dungeon-topology-toolbar">
      <div><strong>Dungeon topology</strong><span>{model.rooms.length} rooms · {model.edges.length} directed connections</span></div>
      <div className="dungeon-topology-actions">
        <GameAppButton onClick={() => zoomBy(0.8)} aria-label="Zoom out topology">−</GameAppButton>
        <output aria-label="Topology zoom">{Math.round(view.zoom * 100)}%</output>
        <GameAppButton onClick={() => zoomBy(1.25)} aria-label="Zoom in topology">+</GameAppButton>
        <GameAppButton onClick={() => fit()}>Fit dungeon</GameAppButton>
        <GameAppButton onClick={() => { setManual({}); fit(automatic); setNotice("Graph layout reset. Room geometry is unchanged."); }}>Auto-layout</GameAppButton>
        <GameAppButton onClick={() => focusRoom(props.selectedRoomId)} disabled={!selectedRoom}>Find selected</GameAppButton>
      </div>
    </div>
    <div className="dungeon-topology-flowbar">
      <label>Route from Start<select aria-label="Route from Start" value={routeTarget} onChange={(event) => setRouteTarget(event.target.value)}>
        <option value="selected">Selected room</option>
        {model.rooms.filter((room) => room.exit || room.boss).map((room) => <option key={room.roomId} value={room.roomId}>{room.boss ? "Boss" : "Exit"} · {room.name}</option>)}
      </select></label>
      <span className="dungeon-topology-route-status" aria-live="polite">{route.distance === null ? "No usable route from Start" : route.distance === 0 ? "At Start" : `${route.distance} connection${route.distance === 1 ? "" : "s"} · ${route.alternativeCount > 1 ? `${route.alternativeCount}${route.alternativeCount === 999 ? "+" : ""} shortest routes` : "shortest route"}${route.conditional ? " · requirements apply" : ""}`}</span>
      <label className="dungeon-topology-toggle"><input type="checkbox" checked={allAnchors} onChange={(event) => setAllAnchors(event.target.checked)} /> All anchors</label>
      <a href={`#${id}-issues`} className={errorCount ? "dungeon-topology-error-text" : ""}>{errorCount} structural errors · {warningCount} warnings</a>
    </div>
    <div className="dungeon-topology-workspace">
      <div className="dungeon-topology-viewport" ref={viewport} tabIndex={0} role="region" aria-label="Dungeon connection graph" aria-describedby={`${id}-help`}
        onPointerDown={(event) => beginDrag(event)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Escape") { setSource(null); setDestination(null); }
          else if (event.key.toLowerCase() === "f") { event.preventDefault(); fit(); }
          else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(1.25); }
          else if (event.key === "-") { event.preventDefault(); zoomBy(0.8); }
          else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault(); setView((current) => ({ ...current, x: current.x + (event.key === "ArrowLeft" ? 60 : event.key === "ArrowRight" ? -60 : 0), y: current.y + (event.key === "ArrowUp" ? 60 : event.key === "ArrowDown" ? -60 : 0) }));
          }
        }}>
        <div className="dungeon-topology-plane" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <svg className="dungeon-topology-connections" aria-label="Directed portal connections">
            <defs><marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
            {model.edges.map((edge, index) => {
              const geometry = edgeGeometry(model, edge, positions, allAnchors);
              const highlighted = route.portalIds.includes(edge.portalId);
              return <g key={`${edge.portalId}:${index}`} role="button" tabIndex={0} aria-label={`${edge.portal.interactionLabel}: ${endpointRoomLabel(model, edge.source)} to ${endpointRoomLabel(model, edge.destination)}${edge.valid ? "" : ", invalid"}`} aria-pressed={selectedEdgeId === edge.portalId}
                className={`dungeon-topology-edge${!edge.valid ? " invalid" : ""}${!edge.portal.enabled ? " disabled" : ""}${highlighted ? " route" : ""}${edge.portalId === selectedEdgeId || edge.portalId === hoveredEdgeId ? " selected" : ""}`}
                onClick={() => selectEdge(edge)} onMouseEnter={() => setHoveredEdgeId(edge.portalId)} onMouseLeave={() => setHoveredEdgeId(null)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectEdge(edge); } }}>
                <title>{edge.portal.interactionLabel}{edge.requirements.length ? ` · ${edge.requirements.join("; ")}` : ""}{!edge.valid ? " · Invalid connection" : ""}</title>
                <path className="dungeon-topology-edge-hit" d={geometry.path} />
                <path className="dungeon-topology-edge-line" d={geometry.path} markerEnd={`url(#${id}-arrow)`} />
                <text x={geometry.label.x} y={geometry.label.y - 8} className="dungeon-topology-edge-label" textAnchor="middle">{!edge.valid ? "Invalid" : !edge.portal.enabled ? "Disabled" : edge.requirements.length ? "Gated" : edge.oneWay ? "One-way" : ""}</text>
                {geometry.worldSource && <text className="dungeon-topology-world" x={geometry.start.x - 8} y={geometry.start.y + 4} textAnchor="end">World</text>}
                {geometry.worldDestination && <text className="dungeon-topology-world" x={geometry.end.x - 12} y={geometry.end.y + 4} textAnchor="end">World</text>}
                {geometry.missingSource && <text className="dungeon-topology-world" x={geometry.start.x} y={geometry.start.y - 12}>Missing source</text>}
                {geometry.missingDestination && <text className="dungeon-topology-world" x={geometry.end.x} y={geometry.end.y - 12}>Missing destination</text>}
              </g>;
            })}
          </svg>
          {model.rooms.map((room, index) => {
            const point = positions[room.roomId] ?? { x: 0, y: 0 };
            const ports = visibleTopologyPorts(room, allAnchors);
            const errors = room.issues.filter((issue) => issue.severity === "error").length;
            return <article key={`${room.roomId}:${index}`} aria-label={`${room.name} topology node`} data-room-id={room.roomId}
              className={`dungeon-topology-node${props.selectedRoomId === room.roomId ? " selected" : ""}${!room.reachable && room.room.active ? " disconnected" : ""}${errors ? " has-errors" : ""}${route.roomIds.includes(room.roomId) ? " on-route" : ""}`}
              style={{ left: point.x, top: point.y, width: TOPOLOGY_NODE_WIDTH }}>
              <button type="button" className="dungeon-topology-node-heading" aria-label={`Select ${room.name}`} aria-pressed={props.selectedRoomId === room.roomId}
                onPointerDown={(event) => beginDrag(event, room.roomId)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
                onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } setSelectedEdgeId(null); props.onSelectRoom(room.roomId); }}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                  event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 60 : 20;
                  setManual((current) => ({ ...current, [room.roomId]: { x: point.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: point.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) } }));
                }}>
                <span className="dungeon-topology-badges">{room.start && <span>START</span>}{room.boss && <span>BOSS</span>}{room.exit && <span>EXIT</span>}{!room.room.active && <span>INACTIVE</span>}{!room.reachable && room.room.active && <span>UNREACHABLE</span>}</span>
                <strong>{room.name}</strong>
                <span className="dungeon-topology-node-meta">{room.boss ? "Boss encounter" : room.encounterNames.length ? `${room.encounterNames.length} encounter${room.encounterNames.length === 1 ? "" : "s"}` : "Exploration"} · {room.room.mobs.filter((mob) => !mob.retired).length} mobs</span>
              </button>
              <div className="dungeon-topology-node-counts"><span>{room.ports.length} anchors</span>{errors > 0 && <button type="button" onClick={() => openIssue(room.issues.find((issue) => issue.severity === "error")!)}>{errors} error{errors === 1 ? "" : "s"}</button>}</div>
              <div className="dungeon-topology-ports">{ports.map((port, portIndex) => <button key={`${port.anchorId}:${portIndex}`} type="button"
                className={`dungeon-topology-port${props.selectedRoomId === room.roomId && props.selectedAnchorId === port.anchorId ? " selected" : ""}${port.issues.some((issue) => issue.severity === "error") ? " invalid" : ""}${source?.roomId === room.roomId && source.anchorId === port.anchorId ? " connection-source" : ""}${destination?.roomId === room.roomId && destination.anchorId === port.anchorId ? " connection-destination" : ""}`}
                aria-label={`${room.name}: ${port.label}${port.issues.some((issue) => issue.severity === "error") ? ", invalid" : ""}`} aria-pressed={props.selectedRoomId === room.roomId && props.selectedAnchorId === port.anchorId}
                title={`${port.label} · ${port.roles.join(" · ") || "Unused"}${port.anchor.facing !== undefined ? ` · facing ${port.anchor.facing}` : ""}`} onClick={() => selectAnchor(room.roomId, port.anchorId)}>
                <span aria-hidden="true" className="dungeon-topology-port-dot" /><span>{port.label}</span><span aria-hidden="true" className="dungeon-topology-port-dot" />
              </button>)}</div>
              {ports.length < room.ports.length && <button type="button" className="dungeon-topology-more" onClick={() => setAllAnchors(true)}>Show {room.ports.length - ports.length} other anchors</button>}
            </article>;
          })}
        </div>
        {!model.rooms.length && <p className="dungeon-topology-empty">Add a room to begin connecting your dungeon.</p>}
      </div>
      <aside className="dungeon-topology-inspector" aria-label="Topology inspector">
        {source ? <section className="dungeon-topology-connect" aria-label="Connect anchors">
          <h3>Connect anchors</h3><p>Choose a destination port on the graph or use the selectors.</p>
          <EndpointPicker label="From" value={source} model={model} onChange={setSource} />
          <EndpointPicker label="To" value={destination} model={model} excludeRoomId={source.roomId} onChange={setDestination} />
          <label>Portal artwork<select value={portalPrefab?.id ?? ""} onChange={(event) => setPrefabId(event.target.value)}>{portalPrefabs.map((prefab) => <option key={prefab.id} value={prefab.id}>{prefab.name}</option>)}</select></label>
          <label className="dungeon-topology-toggle"><input type="checkbox" checked={bidirectional} onChange={(event) => setBidirectional(event.target.checked)} /> Create return connection</label>
          <p className="dungeon-topology-muted">Uses these anchors for approach, threshold, and arrival. Adds the required portal objects.</p>
          {!portalPrefab && <p role="alert">Add a portal artwork prefab before connecting anchors.</p>}
          <div className="dungeon-topology-actions"><GameAppButton variant="primary" disabled={props.disabled || !destination || !portalPrefab} onClick={createConnection}>Create connection</GameAppButton><GameAppButton onClick={() => { setSource(null); setDestination(null); setNotice(""); }}>Cancel</GameAppButton></div>
        </section> : selectedEdge ? <ConnectionInspector edge={selectedEdge} model={model} onSelectAnchor={props.onSelectAnchor} /> : selectedRoom ? <section aria-label="Selected topology room">
          <h3>{selectedRoom.name}</h3>
          <p>{selectedRoom.encounterNames.join(" · ") || "No encounter assigned"}</p>
          {props.onEditRoom && <GameAppButton onClick={() => props.onEditRoom?.(selectedRoom.roomId)}>Edit room</GameAppButton>}
          {selectedPort ? <><h4>{selectedPort.label}</h4><dl><dt>Role</dt><dd>{selectedPort.roles.join(" · ") || "Unused anchor"}</dd><dt>Position</dt><dd>{selectedPort.anchor.x}, {selectedPort.anchor.y}</dd><dt>Facing</dt><dd>{selectedPort.anchor.facing ?? "Default"}</dd></dl>
            {selectedPort.issues.map((issue) => <p key={issue.id} className={`dungeon-topology-${issue.severity}-text`}>{issue.message}</p>)}
            <GameAppButton disabled={props.disabled || !selectedRoom.room.active} onClick={() => { setSource({ roomId: selectedRoom.roomId, anchorId: selectedPort.anchorId }); setDestination(null); setNotice(""); }}>Connect from this anchor</GameAppButton>
            <details><summary>Technical identity</summary><code>{selectedRoom.roomId} / {selectedPort.anchorId}</code></details>
          </> : <p className="dungeon-topology-muted">Select an anchor port to inspect or connect it.</p>}
          <h4>Connections</h4>
          <div className="dungeon-topology-connection-list">{model.edges.filter((edge) => edge.source.kind === "room" && edge.source.roomId === selectedRoom.roomId).map((edge, index) => <button type="button" key={`${edge.portalId}:${index}`} onClick={() => selectEdge(edge)}>{edge.portal.interactionLabel}<small>{endpointRoomLabel(model, edge.destination)} · {edge.valid ? edge.portal.enabled ? edge.requirements.length ? "Gated" : edge.oneWay ? "One-way" : "Return available" : "Disabled" : "Invalid"}</small></button>)}</div>
        </section> : <p>Select a room, anchor, or connection.</p>}
        {notice && <p className="dungeon-topology-notice" role="status" aria-label="Topology action result">{notice}</p>}
        <section id={`${id}-issues`} className="dungeon-topology-validation" aria-label="Topology validation">
          <div className="dungeon-topology-validation-heading"><h3>Structural validation</h3><span>{model.issues.length} issues</span></div>
          <label className="sr-only" htmlFor={`${id}-filter`}>Validation severity</label><select id={`${id}-filter`} value={issueFilter} onChange={(event) => setIssueFilter(event.target.value as typeof issueFilter)}><option value="all">All severities</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Information</option></select>
          {model.issues.length === 0 && <p>No structural topology issues found. Run Play Test to verify authored playability.</p>}
          <ul>{model.issues.filter((issue) => issueFilter === "all" || issue.severity === issueFilter).map((issue) => <li key={issue.id} className={`dungeon-topology-issue ${issue.severity}`}>
            <button type="button" onClick={() => openIssue(issue)} disabled={!issue.roomId && !issue.portalId}><span>{issue.severity}</span>{issue.message}</button>
          </li>)}</ul>
        </section>
      </aside>
    </div>
    <p id={`${id}-help`} className="dungeon-topology-help">Drag room headings to arrange · Drag empty space to pan · Wheel to zoom · F to fit · Arrow keys move the focused room or view. Graph layout is saved on this device.</p>
  </section>;
}

function EndpointPicker(props: { label: string; value: Endpoint | null; model: DungeonTopologyModel; excludeRoomId?: string; onChange(value: Endpoint | null): void }) {
  const rooms = props.model.rooms.filter((room) => room.room.active && room.roomId !== props.excludeRoomId);
  const selected = rooms.find((room) => room.roomId === props.value?.roomId);
  return <div className="dungeon-topology-endpoint-picker"><label>{props.label} room<select aria-label={`${props.label} room`} value={selected?.roomId ?? ""} onChange={(event) => {
    const room = rooms.find((value) => value.roomId === event.target.value); const anchor = room?.ports.find((port) => port.anchorId === room.room.spawnAnchorId) ?? room?.ports[0];
    props.onChange(room && anchor ? { roomId: room.roomId, anchorId: anchor.anchorId } : null);
  }}><option value="">Choose room</option>{rooms.map((room, index) => <option key={`${room.roomId}:${index}`} value={room.roomId}>{room.name}</option>)}</select></label>
    <label>{props.label} anchor<select aria-label={`${props.label} anchor`} value={selected && props.value ? props.value.anchorId : ""} disabled={!selected} onChange={(event) => { if (selected) props.onChange({ roomId: selected.roomId, anchorId: event.target.value }); }}><option value="">Choose anchor</option>{selected?.ports.map((port, index) => <option key={`${port.anchorId}:${index}`} value={port.anchorId}>{port.label}{port.unused ? " · unused" : ""}</option>)}</select></label></div>;
}

function endpointRoomLabel(model: DungeonTopologyModel, endpoint: DungeonTopologyEdge["source"]): string {
  return endpoint.kind === "world" ? "World" : model.rooms.find((room) => room.roomId === endpoint.roomId)?.name ?? "Missing room";
}

function ConnectionInspector(props: { edge: DungeonTopologyEdge; model: DungeonTopologyModel; onSelectAnchor(roomId: string, anchorId: string): void }) {
  const { edge, model } = props;
  return <section aria-label="Selected connection"><h3>{edge.portal.interactionLabel}</h3><p>{endpointRoomLabel(model, edge.source)} → {endpointRoomLabel(model, edge.destination)}</p>
    <p className={!edge.valid ? "dungeon-topology-error-text" : ""}>{!edge.valid ? "Invalid connection" : !edge.portal.enabled ? "Disabled" : edge.oneWay ? "One-way connection" : "Return connection available"}</p>
    {[{ label: "Source anchor", endpoint: edge.source, anchorId: edge.source.kind === "room" ? edge.source.anchorId : undefined },
      { label: "Approach", endpoint: edge.source, anchorId: edge.portal.sourceApproachAnchorId },
      { label: "Threshold", endpoint: edge.source, anchorId: edge.portal.sourceThresholdAnchorId },
      { label: "Destination anchor", endpoint: edge.destination, anchorId: edge.destination.kind === "room" ? edge.destination.anchorId : undefined },
      { label: "Arrival", endpoint: edge.destination, anchorId: edge.portal.destinationArrivalAnchorId }].map(({ label, endpoint, anchorId }) => {
      if (endpoint.kind !== "room") return null;
      const room = model.rooms.find((value) => value.roomId === endpoint.roomId); const port = room?.ports.find((value) => value.anchorId === anchorId);
      return <div className="dungeon-topology-endpoint-detail" key={label}><span>{label}</span><button type="button" disabled={!port} onClick={() => { if (anchorId) props.onSelectAnchor(endpoint.roomId, anchorId); }}>{room?.name ?? "Missing room"}<small>{port?.label ?? "Missing anchor"}</small></button></div>;
    })}
    {edge.requirements.length > 0 && <><h4>Requirements</h4><ul>{edge.requirements.map((requirement, index) => <li key={`${requirement}:${index}`}>{requirement}</li>)}</ul></>}
    {edge.issues.map((issue) => <p key={issue.id} className={`dungeon-topology-${issue.severity}-text`}>{issue.message}</p>)}
    <details><summary>Technical identity</summary><code>{edge.portalId}</code>{edge.portal.reciprocalPortalId && <p>Paired portal: <code>{edge.portal.reciprocalPortalId}</code></p>}</details>
  </section>;
}

function edgeGeometry(model: DungeonTopologyModel, edge: DungeonTopologyEdge, positions: TopologyPositions, all: boolean) {
  function portPoint(endpoint: DungeonTopologyEdge["source"], outgoing: boolean): TopologyPoint | null {
    if (endpoint.kind !== "room") return null;
    const room = model.rooms.find((value) => value.roomId === endpoint.roomId); const position = positions[endpoint.roomId];
    if (!room || !position) return null;
    return topologyPortPoint(room, position, endpoint.anchorId, outgoing, all);
  }
  const source = portPoint(edge.source, edge.destination.kind !== "world"); const destination = portPoint(edge.destination, false);
  const start = source ?? { x: (destination?.x ?? 400) - 110, y: destination?.y ?? 60 };
  const end = destination ?? { x: start.x + (edge.destination.kind === "world" ? -110 : 110), y: start.y };
  const sameRoom = edge.source.kind === "room" && edge.destination.kind === "room" && edge.source.roomId === edge.destination.roomId;
  const reverse = end.x < start.x;
  const bend = Math.max(65, Math.min(180, Math.abs(end.x - start.x) / 2));
  const sourceTop = edge.source.kind === "room" ? positions[edge.source.roomId]?.y : undefined;
  const destinationTop = edge.destination.kind === "room" ? positions[edge.destination.roomId]?.y : undefined;
  const detour = Math.min(sourceTop ?? start.y, destinationTop ?? end.y) - (sameRoom ? 70 : 40);
  const path = reverse
    ? `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${start.x + bend} ${detour}, ${start.x} ${detour} L ${end.x} ${detour} C ${end.x - bend} ${detour}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`
    : `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`;
  return { path, start, end, label: { x: (start.x + end.x) / 2, y: reverse ? detour : (start.y + end.y) / 2 }, worldSource: edge.source.kind === "world", worldDestination: edge.destination.kind === "world", missingSource: !source && edge.source.kind === "room", missingDestination: !destination && edge.destination.kind === "room" };
}
