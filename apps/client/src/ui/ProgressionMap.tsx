import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ProtectionLockIcon } from "./ProtectionLockIcon.js";
import "./ProgressionMap.css";

export type ProgressionMapPoint = Readonly<{ x: number; y: number }>;
export type ProgressionMapNode = Readonly<{
  id: string;
  label: string;
  icon: ReactNode;
  desktop: ProgressionMapPoint;
  phone: ProgressionMapPoint;
  rank: number;
  maximumRank: number;
  progress: "untrained" | "partial" | "maxed";
  eligibility: "locked" | "purchasable" | "unavailable" | "busy";
  application: "equipped" | "active" | "inactive" | "not-applicable";
  inspection: "selected" | "unselected";
  stateLabel: string;
  reason?: string;
  badge?: string;
  nodeType?: "class" | "destination";
  categoryLabel?: string;
  gateway?: boolean;
  emphasis?: boolean;
  path?: boolean;
  rankLabel?: string;
  showDots?: boolean;
  onSelect?(): void;
}>;

export type ProgressionMapEdge = Readonly<{
  source: string;
  target: string;
  state: "locked" | "available" | "earned";
  highlighted?: boolean;
  curve?: Readonly<{
    desktop: Readonly<{ control1: ProgressionMapPoint; control2: ProgressionMapPoint }>;
    phone: Readonly<{ control1: ProgressionMapPoint; control2: ProgressionMapPoint }>;
  }>;
}>;

type NodeStyle = CSSProperties & {
  "--progression-x": number;
  "--progression-y": number;
  "--progression-phone-x": number;
  "--progression-phone-y": number;
};

type MapStyle = CSSProperties & {
  "--progression-canvas-width"?: string;
  "--progression-canvas-height"?: string;
  "--progression-phone-canvas-width"?: string;
  "--progression-phone-canvas-height"?: string;
  "--progression-map-zoom"?: number;
  "--progression-map-pan-x"?: string;
  "--progression-map-pan-y"?: string;
};

const DESKTOP_CANVAS = { width: 1760, height: 1240 } as const;
const PHONE_CANVAS = { width: 1320, height: 1500 } as const;
const PAN_EDGE_PADDING = 64;
const PAN_START_THRESHOLD = 5;

export function ProgressionMap({ label, nodes, edges, className = "", interactive = false, layoutKey, centerNodeId }: Readonly<{
  label: string;
  nodes: readonly ProgressionMapNode[];
  edges: readonly ProgressionMapEdge[];
  className?: string;
  interactive?: boolean;
  layoutKey?: string;
  centerNodeId?: string;
}>): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const keyboardNavigationRef = useRef(false);
  const panRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const pointersRef = useRef(new Map<number, ProgressionMapPoint>());
  const captureTargetsRef = useRef(new Map<number, HTMLElement>());
  const pinchRef = useRef<Readonly<{ distance: number; zoom: number; contentX: number; contentY: number }> | null>(null);
  const transformRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } });
  const suppressPointerActivationRef = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const coordinateSet = layoutKey === "phone" || (typeof document !== "undefined" && document.documentElement.dataset.layoutMode === "compact") ? "phone" : "desktop";
  const canvasSize = coordinateSet === "phone" ? PHONE_CANVAS : DESKTOP_CANVAS;
  const clampPan = (next: Readonly<{ x: number; y: number }>, zoomValue = transformRef.current.zoom) => {
    const viewport = viewportRef.current;
    if (!viewport) return next;
    const clampAxis = (value: number, viewportSize: number, contentSize: number) => {
      if (viewportSize <= 0) return value;
      const minimum = viewportSize - contentSize - PAN_EDGE_PADDING, maximum = PAN_EDGE_PADDING;
      const bounded = minimum > maximum ? (viewportSize - contentSize) / 2 : Math.min(maximum, Math.max(minimum, value));
      return Number(bounded.toFixed(3));
    };
    return { x: clampAxis(next.x, viewport.clientWidth, canvasSize.width * zoomValue), y: clampAxis(next.y, viewport.clientHeight, canvasSize.height * zoomValue) };
  };
  const applyTransform = (nextPan: Readonly<{ x: number; y: number }>, nextZoom = transformRef.current.zoom) => {
    const next = { zoom: nextZoom, pan: { x: nextPan.x, y: nextPan.y } };
    transformRef.current = next;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.setProperty("--progression-map-zoom", String(next.zoom));
      canvas.style.setProperty("--progression-map-pan-x", `${next.pan.x}px`);
      canvas.style.setProperty("--progression-map-pan-y", `${next.pan.y}px`);
    }
    return next;
  };
  const commitTransform = (nextPan: Readonly<{ x: number; y: number }>, nextZoom = transformRef.current.zoom) => {
    const next = applyTransform(nextPan, nextZoom);
    setZoom(next.zoom);
    setPan(next.pan);
  };
  const centerPoint = (point: ProgressionMapPoint, zoomValue = zoom) => {
    const viewport = viewportRef.current;
    if (!viewport || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return false;
    commitTransform(clampPan({ x: (viewport.clientWidth / 2) - ((point.x / 100) * canvasSize.width * zoomValue), y: (viewport.clientHeight / 2) - ((point.y / 100) * canvasSize.height * zoomValue) }, zoomValue), zoomValue);
    return true;
  };
  const canvasStyle = interactive ? {
    "--progression-canvas-width": "1760px",
    "--progression-canvas-height": "1240px",
    "--progression-phone-canvas-width": "1320px",
    "--progression-phone-canvas-height": "1500px",
    "--progression-map-zoom": zoom,
    "--progression-map-pan-x": `${pan.x}px`,
    "--progression-map-pan-y": `${pan.y}px`,
  } as MapStyle : undefined;
  useLayoutEffect(() => {
    if (!interactive) return;
    const target = byId.get(centerNodeId ?? "");
    if (!target) { commitTransform(clampPan({ x: 0, y: 0 })); return; }
    let disposed = false, frame: number | undefined, observer: ResizeObserver | undefined;
    const tryCenter = () => {
      if (disposed || !centerPoint(target[coordinateSet])) return false;
      observer?.disconnect();
      return true;
    };
    if (!tryCenter()) {
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => { tryCenter(); });
        const viewport = viewportRef.current;
        if (viewport) observer.observe(viewport);
      }
      if (typeof requestAnimationFrame !== "undefined") frame = requestAnimationFrame(() => { tryCenter(); });
    }
    return () => {
      disposed = true;
      observer?.disconnect();
      if (frame !== undefined && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(frame);
    };
  }, [centerNodeId, coordinateSet, interactive, layoutKey]);
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    keyboardNavigationRef.current = false;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (pointersRef.current.size >= 2) return;
    if (pointersRef.current.size === 0) suppressPointerActivationRef.current = false;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const captureTarget = event.target instanceof Element ? event.target.closest<HTMLElement>(".progression-map-node") ?? event.currentTarget : event.currentTarget;
    captureTargetsRef.current.set(event.pointerId, captureTarget);
    captureTarget.setPointerCapture?.(event.pointerId);
    if (pointersRef.current.size === 2) {
      const [first, second] = [...pointersRef.current.values()], distance = Math.hypot(second!.x - first!.x, second!.y - first!.y);
      const offsetX = event.currentTarget.clientWidth / 2, offsetY = event.currentTarget.clientHeight / 2;
      const { zoom: currentZoom, pan: currentPan } = transformRef.current;
      pinchRef.current = { distance, zoom: currentZoom, contentX: (offsetX - currentPan.x) / currentZoom, contentY: (offsetY - currentPan.y) / currentZoom };
      panRef.current = null;
      suppressPointerActivationRef.current = true;
    } else {
      const currentPan = transformRef.current.pan;
      panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: currentPan.x, panY: currentPan.y, moved: false };
    }
    setPanning(true);
  };
  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size === 2) {
      const [first, second] = [...pointersRef.current.values()], distance = Math.hypot(second!.x - first!.x, second!.y - first!.y);
      if (pinch.distance <= 0) return;
      event.preventDefault();
      const nextZoom = Math.max(0.4, Math.min(1.2, Number((pinch.zoom * (distance / pinch.distance)).toFixed(3))));
      const offsetX = event.currentTarget.clientWidth / 2, offsetY = event.currentTarget.clientHeight / 2;
      applyTransform(clampPan({ x: offsetX - (pinch.contentX * nextZoom), y: offsetY - (pinch.contentY * nextZoom) }, nextZoom), nextZoom);
      return;
    }
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (!pan.moved && Math.hypot(event.clientX - pan.x, event.clientY - pan.y) < PAN_START_THRESHOLD) return;
    pan.moved = true;
    suppressPointerActivationRef.current = true;
    event.preventDefault();
    applyTransform(clampPan({ x: pan.panX + event.clientX - pan.x, y: pan.panY + event.clientY - pan.y }));
  };
  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId) && panRef.current?.pointerId !== event.pointerId) return;
    pointersRef.current.clear();
    pinchRef.current = null;
    panRef.current = null;
    for (const [pointerId, captureTarget] of captureTargetsRef.current) captureTarget.releasePointerCapture?.(pointerId);
    captureTargetsRef.current.clear();
    const current = transformRef.current;
    setZoom(current.zoom);
    setPan(current.pan);
    setPanning(false);
  };
  const zoomCanvas = (deltaY: number, viewport: HTMLDivElement) => {
    if (deltaY === 0) return;
    const step = deltaY > 0 ? -0.2 : 0.2;
    const { zoom: currentZoom, pan: currentPan } = transformRef.current;
    const nextZoom = Math.max(0.4, Math.min(1.2, Number((currentZoom + step).toFixed(1))));
    if (nextZoom === currentZoom) return;
    const offsetX = viewport.clientWidth / 2, offsetY = viewport.clientHeight / 2;
    const contentX = (offsetX - currentPan.x) / currentZoom, contentY = (offsetY - currentPan.y) / currentZoom;
    commitTransform(clampPan({ x: offsetX - (contentX * nextZoom), y: offsetY - (contentY * nextZoom) }, nextZoom), nextZoom);
  };
  useEffect(() => {
    if (!interactive) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => { event.preventDefault(); zoomCanvas(event.deltaY, viewport); };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [interactive, pan.x, pan.y, zoom]);
  const canvas = <div ref={canvasRef} className="progression-map-canvas" style={canvasStyle}>
    <svg className="progression-map-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {edges.flatMap((edge) => {
        const source = byId.get(edge.source), target = byId.get(edge.target);
        if (!source || !target) return null;
        return (["desktop", "phone"] as const).map((coordinateSet) => {
          const curve = edge.curve?.[coordinateSet];
          const attributes = {
            className: "progression-map-edge", "data-coordinate-set": coordinateSet, "data-edge-source": edge.source,
            "data-edge-target": edge.target, "data-edge-state": edge.state, "data-highlighted": edge.highlighted ? "true" : undefined,
            "data-edge-shape": curve ? "curve" : "straight", "aria-hidden": true,
          } as const;
          return curve
            ? <path key={`${edge.source}-${edge.target}-${coordinateSet}`} {...attributes} fill="none" d={`M ${source[coordinateSet].x} ${source[coordinateSet].y} C ${curve.control1.x} ${curve.control1.y}, ${curve.control2.x} ${curve.control2.y}, ${target[coordinateSet].x} ${target[coordinateSet].y}`} />
            : <line key={`${edge.source}-${edge.target}-${coordinateSet}`} {...attributes} x1={source[coordinateSet].x} y1={source[coordinateSet].y} x2={target[coordinateSet].x} y2={target[coordinateSet].y} />;
        });
      })}
    </svg>
    <ol className="progression-map-nodes">
      {nodes.map((node) => {
        const accessibleLabel = [
          node.label,
          node.categoryLabel ?? (node.nodeType === "class" ? "Class" : null),
          node.rankLabel === "" ? null : node.rankLabel ?? `rank ${node.rank} of ${node.maximumRank}`,
          node.stateLabel,
          node.badge,
          node.reason,
        ].filter(Boolean).join(", ");
        const content = <>
          <span className="progression-map-medallion">
            {node.icon}
            {node.eligibility === "locked" ? <span className="progression-map-lock-cue" aria-hidden="true"><ProtectionLockIcon /></span> : null}
          </span>
          <strong>{node.label}</strong>
          {node.categoryLabel ? <span className="progression-map-category">{node.categoryLabel}</span> : null}
          {node.rankLabel ? <span className="progression-map-rank">{node.rankLabel}</span> : null}
          {node.showDots === false ? null : <span className="progression-map-dots" aria-hidden="true">{Array.from({ length: node.maximumRank }, (_, rank) => <i key={rank} data-filled={rank < node.rank} />)}</span>}
          {node.badge ? <b className="progression-map-badge">{node.badge}</b> : null}
        </>;
        const attributes = {
          className: "progression-map-node",
          "data-node-id": node.id,
          "data-progress": node.progress,
          "data-eligibility": node.eligibility,
          "data-application": node.application,
          "data-inspection": node.inspection,
          "data-gateway": node.gateway ? "true" : undefined,
          "data-emphasis": node.emphasis || node.gateway ? "true" : undefined,
          "data-path": node.path ? "true" : undefined,
          "data-node-type": node.nodeType ?? "skill",
        } as const;
        return <li key={node.id} style={{
        "--progression-x": node.desktop.x,
        "--progression-y": node.desktop.y,
        "--progression-phone-x": node.phone.x,
        "--progression-phone-y": node.phone.y,
      } as NodeStyle}>
        {node.onSelect ? <button type="button" {...attributes} aria-pressed={node.inspection === "selected"} aria-label={accessibleLabel} onFocus={() => { if (keyboardNavigationRef.current) centerPoint(node[coordinateSet]); }} onClick={(event) => {
          if (event.detail !== 0 && suppressPointerActivationRef.current) { event.preventDefault(); event.stopPropagation(); return; }
          node.onSelect?.();
        }}>{content}</button>
          : <div {...attributes} role="group" aria-label={accessibleLabel}>{content}</div>}
      </li>;
      })}
    </ol>
  </div>;
  const graph = interactive ? <div className="progression-map-stage">{canvas}</div> : canvas;
  return <section className={`progression-map${interactive ? " progression-map-interactive" : ""} ${className}`.trim()} aria-label={label}>
    {interactive ? <div ref={viewportRef} className="progression-map-viewport" data-panning={panning ? "true" : undefined} tabIndex={0} onKeyDownCapture={(event) => { if (["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) keyboardNavigationRef.current = true; }} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={stopPan} onPointerCancel={stopPan}>{graph}</div> : graph}
  </section>;
}
