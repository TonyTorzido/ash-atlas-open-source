import { manorPolygonGeometryIssues, type IndoorPoint, type ManorPlacementSurfaceDefinition } from "@ash-atlas/shared";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { NumberField } from "./InteriorCanvasFields.js";
import { clamp, parseFootprint, shouldClosePolygon, uniqueId } from "./interiorCanvasAuthoring.js";
import {
  MANOR_DECORATION_ITEMS,
  defaultDecorationTransform,
  manorDecorationContainmentReason,
  manorDecorationFootprintClass,
  manorDecorationFootprintInRoom,
  manorDecorationNeedsHorizontalMirror,
  manorDecorationPointToNormalized,
  manorDecorationSvgTransform,
  manorDecorationTransformForImportedPng,
  manorDecorationTransformWithAnchor,
  surfaceLabel
} from "./interiorDecorationModel.js";
import type { InteriorDecoration } from "./interiorModules.js";
import type { StudioApi } from "./studioApi.js";

/**
 * The Decoration Test of the InteriorStudio: places, transforms and shapes the
 * PNG decorations of a space with the Manor decoration module, on the floors and
 * walls of one room. It edits InteriorDecoration definitions; the caller decides
 * how they persist (id-preserving retire on publish).
 */

export type DecorationTestRoom = { id: string; width: number; height: number; placementSurfaces: ManorPlacementSurfaceDefinition[] };

const RUNTIME_ASSET_URL = (assetKey: string): string => assetKey.startsWith("data:image/svg+xml,") ? assetKey : `/runtime-assets/${assetKey}`;

/** The stand-in art of a decoration whose PNG is not loaded yet (it cannot publish until a PNG replaces it). */
function decorationPlaceholderKey(): string {
  return `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120"><rect width="100%" height="100%" fill="#59432a" stroke="#c5a66b" stroke-width="4"/><text x="90" y="64" text-anchor="middle" fill="#eadfc5" font-size="16">Load a PNG</text></svg>')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type DecorationSurfaceChoice = "floor" | "back_wall" | "left_wall" | "right_wall";

export function InteriorDecorationTest(props: {
  api: StudioApi;
  room: DecorationTestRoom;
  /** Blob URLs of PNGs staged this session, by the asset key they will publish under. */
  previews: Readonly<Record<string, string>>;
  decorations: InteriorDecoration[];
  selectedId: string | null;
  writesAllowed: boolean;
  onChange(value: InteriorDecoration[]): void;
  onSelect(id: string | null): void;
  onPreview(assetKey: string, url: string): void;
  onPendingAsset?(token: string, assetKey: string): void;
}): React.JSX.Element {
  const selected = props.decorations.find((value) => value.id === props.selectedId) ?? null;
  const surface = selected ? props.room.placementSurfaces.find((value) => value.id === selected.surfaceId) ?? null : null;
  const reason = selected ? manorDecorationContainmentReason(selected, surface) : null;
  const [editStatus, setEditStatus] = useState<string | null>(null);
  const [creationSurface, setCreationSurface] = useState<DecorationSurfaceChoice | null>(null);
  const [sideWallMenuOpen, setSideWallMenuOpen] = useState(false);
  const [footprintDraft, setFootprintDraft] = useState<IndoorPoint[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ id: string; offset: IndoorPoint } | null>(null);
  const anchorDragRef = useRef<string | null>(null);
  useEffect(() => {
    setCreationSurface(selected ? surface?.kind ?? null : null);
    setFootprintDraft(null);
  }, [selected?.id, surface?.id]);
  const toRoomPoint = (clientX: number, clientY: number, svg: SVGSVGElement): IndoorPoint => {
    const bounds = svg.getBoundingClientRect();
    return {
      x: clamp((clientX - bounds.left) / Math.max(1, bounds.width) * props.room.width, 0, props.room.width),
      y: clamp((clientY - bounds.top) / Math.max(1, bounds.height) * props.room.height, 0, props.room.height)
    };
  };
  const beginDrag = (event: ReactPointerEvent<SVGGElement>, value: InteriorDecoration): void => {
    if (footprintDraft !== null) return;
    if (!props.writesAllowed) return;
    event.stopPropagation();
    props.onSelect(value.id);
    setCreationSurface(props.room.placementSurfaces.find((candidate) => candidate.id === value.surfaceId)?.kind ?? null);
    setSideWallMenuOpen(false);
    setEditStatus(null);
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const point = toRoomPoint(event.clientX, event.clientY, svg);
    svg.setPointerCapture(event.pointerId);
    dragRef.current = {
      id: value.id,
      offset: { x: point.x - value.transform.x, y: point.y - value.transform.y }
    };
  };
  const beginAnchorDrag = (event: ReactPointerEvent<SVGCircleElement>, value: InteriorDecoration): void => {
    if (!props.writesAllowed || footprintDraft !== null) return;
    event.stopPropagation();
    props.onSelect(value.id);
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    svg.setPointerCapture(event.pointerId);
    anchorDragRef.current = value.id;
    setEditStatus(null);
  };
  const pointString = (points: readonly IndoorPoint[]): string => points.map((point) => `${point.x},${point.y}`).join(" ");
  const commitEdit = (edit: (draft: InteriorDecoration) => void, prefix = "Edit rejected"): boolean => {
    if (!selected || !props.writesAllowed) return false;
    const candidate = structuredClone(selected);
    edit(candidate);
    const next = props.decorations.map((value) => value.id === selected.id ? candidate : value);
    const candidateSurface = props.room.placementSurfaces.find((value) => value.id === candidate.surfaceId) ?? null;
    if (candidate.footprint.some((point) =>
      !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
      setEditStatus(`${prefix}: custom footprint points must stay normalized between 0 and 1.`);
      return false;
    }
    const candidateReason = manorDecorationContainmentReason(candidate, candidateSurface);
    if (candidateReason) {
      setEditStatus(`${prefix}: ${candidateReason}`);
      return false;
    }
    setEditStatus(null);
    props.onChange(next);
    return true;
  };
  const moveDrag = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const anchorId = anchorDragRef.current;
    if (anchorId) {
      const current = props.decorations.find((value) => value.id === anchorId);
      if (!current) return;
      const currentSurface = props.room.placementSurfaces.find((value) => value.id === current.surfaceId) ?? null;
      const normalized = manorDecorationPointToNormalized(
        toRoomPoint(event.clientX, event.clientY, event.currentTarget),
        current,
        manorDecorationNeedsHorizontalMirror(current, currentSurface)
      );
      commitEdit((draft) => {
        draft.transform = manorDecorationTransformWithAnchor(
          draft.transform,
          clamp(normalized.x, 0, 1),
          clamp(normalized.y, 0, 1),
          manorDecorationNeedsHorizontalMirror(draft, currentSurface)
        );
      }, "Anchor move blocked");
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const point = toRoomPoint(event.clientX, event.clientY, event.currentTarget);
    commitEdit((draft) => {
      draft.transform = {
        ...draft.transform,
        x: point.x - drag.offset.x,
        y: point.y - drag.offset.y
      };
    }, "Drop blocked");
  };
  const endDrag = (): void => {
    dragRef.current = null;
    anchorDragRef.current = null;
  };
  const finishFootprint = (): void => {
    if (!selected || footprintDraft === null) return;
    if (footprintDraft.length < 3) {
      setEditStatus("Footprint needs at least three connected points before it can close.");
      return;
    }
    const points = footprintDraft.map((point) => ({ x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) }));
    if (manorPolygonGeometryIssues(points).length > 0) {
      setEditStatus("Footprint edit blocked: use a simple polygon without duplicate or crossing edges.");
      return;
    }
    if (commitEdit((draft) => { draft.footprint = points; }, "Footprint edit blocked")) {
      setFootprintDraft(null);
      setEditStatus("Footprint saved in normalized PNG coordinates.");
    }
  };
  const addFootprintPoint = (roomPoint: IndoorPoint): void => {
    if (!selected || footprintDraft === null) return;
    const selectedSurface = props.room.placementSurfaces.find((value) => value.id === selected.surfaceId) ?? null;
    const normalized = manorDecorationPointToNormalized(
      roomPoint,
      selected,
      manorDecorationNeedsHorizontalMirror(selected, selectedSurface)
    );
    const point = { x: clamp(normalized.x, 0, 1), y: clamp(normalized.y, 0, 1) };
    if (shouldClosePolygon(footprintDraft, point, 0.08)) {
      finishFootprint();
      return;
    }
    setFootprintDraft((current) => [...current ?? [], point]);
    setEditStatus("Footprint editor active: click the gold first dot after three points to close.");
  };
  const startFootprintRemake = (): void => {
    if (!selected || !props.writesAllowed) return;
    setFootprintDraft([]);
    setEditStatus("Footprint editor active: click connected points in normalized PNG coordinates.");
  };
  const resetFootprint = (): void => {
    if (!selected) return;
    if (commitEdit((draft) => {
      draft.footprint = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    }, "Footprint reset blocked")) {
      setFootprintDraft(null);
      setEditStatus("Footprint reset to the full PNG frame.");
    }
  };
  const add = (surfaceKind: DecorationSurfaceChoice): void => {
    const firstSurface = props.room.placementSurfaces.find((value) => !value.retired && value.kind === surfaceKind);
    if (!firstSurface) {
      setEditStatus(`Add blocked: no active ${surfaceLabel(surfaceKind).toLowerCase()} surface is authored in this room.`);
      return;
    }
    const id = uniqueId("decoration", props.decorations.map((value) => value.id));
    const draft: InteriorDecoration = {
      id,
      name: `${surfaceLabel(surfaceKind)} decoration`,
      itemId: MANOR_DECORATION_ITEMS[0]?.itemId ?? "wood",
      placementMode: "movable",
      roomId: props.room.id,
      retired: false,
      assetKey: decorationPlaceholderKey(),
      surfaceId: firstSurface.id,
      layer: "in_front",
      transform: defaultDecorationTransform(firstSurface),
      footprint: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      collision: false,
      zIndex: props.decorations.length,
      mirrorX: firstSurface.kind === "right_wall"
    };
    const candidateReason = manorDecorationContainmentReason(draft, firstSurface);
    if (candidateReason) { setEditStatus(`Add blocked: ${candidateReason}`); return; }
    setCreationSurface(surfaceKind);
    setSideWallMenuOpen(false);
    props.onChange([...props.decorations, draft]);
    props.onSelect(id);
    setEditStatus(null);
  };
  const loadSelectedPng = (file: File): void => {
    if (!selected) {
      setEditStatus("Choose a floor or wall surface before loading a PNG.");
      return;
    }
    const stem = file.name.replace(/\.png$/iu, "");
    const selectedId = selected.id;
    setEditStatus("Staging PNG for Save…");
    void props.api.importManorPng(file).then((asset) => {
      if (props.selectedId !== selectedId) return;
      if (commitEdit((draft) => {
        props.onPreview(asset.assetKey, URL.createObjectURL(file));
        draft.assetKey = asset.assetKey;
        draft.transform = manorDecorationTransformForImportedPng(
          draft.transform,
          asset.width,
          asset.height
        );
        if (draft.name.endsWith(" decoration")) draft.name = stem;
      }, "PNG load blocked")) {
        props.onPendingAsset?.(asset.stagingToken, asset.assetKey);
        setEditStatus("PNG staged. Save to publish it.");
      }
    }).catch((caught: unknown) => {
      setEditStatus(`PNG load blocked: ${errorMessage(caught)}`);
    });
  };
  const duplicate = (): void => {
    if (!selected || !props.writesAllowed) return;
    const copy = structuredClone(selected);
    copy.id = uniqueId(`${selected.id}_copy`, props.decorations.map((value) => value.id));
    copy.name = `${selected.name} copy`;
    copy.zIndex = props.decorations.length;
    const copyReason = manorDecorationContainmentReason(copy, props.room.placementSurfaces.find((value) => value.id === copy.surfaceId) ?? null);
    if (copyReason) { setEditStatus(`Duplicate blocked: ${copyReason}`); return; }
    props.onChange([...props.decorations, copy]);
    props.onSelect(copy.id);
    setEditStatus(null);
  };
  const remove = (): void => {
    if (!selected || !props.writesAllowed) return;
    props.onChange(props.decorations.filter((value) => value.id !== selected.id));
    props.onSelect(null);
    setEditStatus(null);
  };
  const moveZ = (delta: number): void => {
    if (!selected) return;
    commitEdit((draft) => { draft.zIndex = Math.max(0, draft.zIndex + delta); });
  };
  const resetTransform = (): void => {
    if (!selected || !surface) return;
    commitEdit((draft) => { draft.transform = defaultDecorationTransform(surface); }, "Reset blocked");
  };
  const chooseExistingSurface = (id: string): void => {
    const target = props.room.placementSurfaces.find((value) => value.id === id);
    if (!target) return;
    const committed = commitEdit((draft) => {
      draft.surfaceId = id;
      draft.mirrorX = target.kind === "right_wall";
    });
    if (committed) setCreationSurface(target.kind);
  };
  const playerPreview = selected ? <g className="manor-decoration-player-preview"><circle cx={selected.transform.x} cy={selected.transform.y - 35} r="18" /><text x={selected.transform.x + 22} y={selected.transform.y - 30}>Canonical player · {selected.layer === "behind" ? "in front" : selected.layer === "in_front" ? "behind" : "rug / noncollision"}</text></g> : null;
  return <div className="manor-studio"><div className="manor-decoration-layout">
    <aside className="manor-decoration-library panel">
      <h3>Decoration Overlay Test Mode</h3>
      {selected ? <DecorationMetadata selected={selected} writesAllowed={props.writesAllowed} onEdit={commitEdit} /> : null}
      <p>Studio-only draft state. Choose a surface before loading its PNG. Nothing here creates inventory, database, economy, or production placement data.</p>
      <button type="button" disabled={!props.writesAllowed} onClick={() => add("floor")}>Add Floor</button>
      <button type="button" disabled={!props.writesAllowed} onClick={() => add("back_wall")}>Add Back Wall</button>
      <button type="button" disabled={!props.writesAllowed} onClick={() => { setSideWallMenuOpen((value) => !value); setCreationSurface(null); }}>Add Side Wall</button>
      {sideWallMenuOpen ? <div className="manor-decoration-side-menu" aria-label="Side wall choice"><button type="button" disabled={!props.writesAllowed} onClick={() => add("left_wall")}>Left</button><button type="button" disabled={!props.writesAllowed} onClick={() => add("right_wall")}>Right</button></div> : null}
      {creationSurface && selected ? <div className="manor-decoration-create-menu"><strong>{surfaceLabel(creationSurface)} decoration</strong><p>{creationSurface === "right_wall" ? "Right-wall art uses the left-authored PNG mirrored once at render time; footprint coordinates remain PNG-local." : "Load a PNG for this selected placement surface."}</p><button type="button" disabled={!props.writesAllowed} onClick={() => fileRef.current?.click()}>Load PNG</button><input ref={fileRef} hidden type="file" accept="image/png,.png" onChange={(event) => { const file = event.target.files?.[0]; if (file) loadSelectedPng(file); event.target.value = ""; }} /></div> : null}
      <div className="manor-decoration-list" role="listbox" aria-label="Draft decorations">{props.decorations.slice().sort((a, b) => a.zIndex - b.zIndex).map((value) => <button key={value.id} type="button" role="option" aria-selected={value.id === props.selectedId} className={value.id === props.selectedId ? "selected" : ""} onClick={() => { props.onSelect(value.id); setCreationSurface(props.room.placementSurfaces.find((surfaceValue) => surfaceValue.id === value.surfaceId)?.kind ?? null); setSideWallMenuOpen(false); setEditStatus(null); }}>{value.name}<small>{surfaceLabel(props.room.placementSurfaces.find((surfaceValue) => surfaceValue.id === value.surfaceId)?.kind ?? "floor")} · {value.layer} · z {value.zIndex}</small></button>)}</div>
    </aside>
    <div className="manor-decoration-canvas"><svg viewBox={`0 0 ${props.room.width} ${props.room.height}`} aria-label="Manor decoration overlay canvas" onPointerDown={(event) => { if (footprintDraft !== null) { event.stopPropagation(); addFootprintPoint(toRoomPoint(event.clientX, event.clientY, event.currentTarget)); } }} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}><rect width={props.room.width} height={props.room.height} fill="#071116" />{props.room.placementSurfaces.filter((value) => !value.retired).map((value) => <polygon key={value.id} points={pointString(value.kind === "floor" ? value.polygon : value.roomPolygon)} className={`manor-placement-surface ${value.kind}`} />)}{selected?.layer === "behind" ? playerPreview : null}{props.decorations.slice().sort((a, b) => a.zIndex - b.zIndex).map((value) => { const decorationSurface = props.room.placementSurfaces.find((candidate) => candidate.id === value.surfaceId) ?? null; const mirrorX = manorDecorationNeedsHorizontalMirror(value, decorationSurface); const footprint = manorDecorationFootprintInRoom(value, mirrorX); const source = props.previews[value.assetKey] ?? RUNTIME_ASSET_URL(value.assetKey); const isSelectedDecoration = value.id === props.selectedId; return <g key={value.id} className={`manor-decoration ${isSelectedDecoration ? "selected" : ""}`} onPointerDown={(event) => beginDrag(event, value)}><g transform={manorDecorationSvgTransform(value.transform, mirrorX)}><image href={source} x="0" y="0" width={value.transform.width} height={value.transform.height} preserveAspectRatio="none" opacity={value.layer === "rug" ? 0.75 : 1} onClick={() => props.onSelect(value.id)} /></g><polygon points={pointString(footprint)} className={manorDecorationFootprintClass(value.collision, isSelectedDecoration)} onClick={() => props.onSelect(value.id)} />{isSelectedDecoration ? <circle cx={value.transform.x} cy={value.transform.y} r="12" className="manor-decoration-anchor-handle" aria-label="Decoration anchor handle" onPointerDown={(event) => beginAnchorDrag(event, value)}><title>Drag decoration anchor; art stays in place while the normalized anchor changes.</title></circle> : null}</g>; })}{selected && footprintDraft !== null ? (() => { const selectedSurface = props.room.placementSurfaces.find((value) => value.id === selected.surfaceId) ?? null; const draftRoomPoints = manorDecorationFootprintInRoom({ ...selected, footprint: footprintDraft }, manorDecorationNeedsHorizontalMirror(selected, selectedSurface)); return <><polyline points={pointString(draftRoomPoints)} className="manor-decoration-footprint-draft" />{draftRoomPoints.map((point, index) => <circle key={`footprint:${index}`} cx={point.x} cy={point.y} r={index === 0 && footprintDraft.length >= 3 ? 16 : 8} className={index === 0 && footprintDraft.length >= 3 ? "manor-first-vertex" : "manor-draft-vertex"} onPointerDown={index === 0 && footprintDraft.length >= 3 ? (event) => { event.stopPropagation(); finishFootprint(); } : undefined}><title>{index === 0 && footprintDraft.length >= 3 ? "Click gold first dot to close footprint" : `Footprint vertex ${index + 1}`}</title></circle>)}</>;
      })() : null}{selected?.layer !== "behind" ? playerPreview : null}</svg></div>
    <aside className="manor-decoration-inspector panel">{selected ? <><h3>{selected.name}</h3><div className="manor-decoration-actions"><button type="button" disabled={!props.writesAllowed} onClick={resetTransform}>Reset transform</button><button type="button" disabled={!props.writesAllowed} onClick={duplicate}>Duplicate</button><button type="button" className="danger" disabled={!props.writesAllowed} onClick={remove}>Delete</button><button type="button" disabled={!props.writesAllowed} onClick={() => moveZ(1)}>Bring forward</button><button type="button" disabled={!props.writesAllowed} onClick={() => moveZ(-1)}>Send backward</button></div><label className="field compact"><span>Placement surface</span><select value={selected.surfaceId} onChange={(event) => chooseExistingSurface(event.target.value)}>{props.room.placementSurfaces.filter((value) => !value.retired).map((value) => <option key={value.id} value={value.id}>{surfaceLabel(value.kind)} · {value.id}</option>)}</select></label><label className="field compact"><span>Preview order</span><select value={selected.layer} onChange={(event) => { commitEdit((draft) => { draft.layer = event.target.value as InteriorDecoration["layer"]; }); }}><option value="behind">Player behind decoration</option><option value="in_front">Player in front of decoration</option><option value="rug">Rug-like noncollision</option></select></label><div className="field-grid"><NumberField label="X" value={selected.transform.x} onChange={(value) => { commitEdit((draft) => { draft.transform.x = value; }); }} /><NumberField label="Y" value={selected.transform.y} onChange={(value) => { commitEdit((draft) => { draft.transform.y = value; }); }} /><NumberField label="Width" value={selected.transform.width} min={1} onChange={(value) => { commitEdit((draft) => { draft.transform.width = value; }); }} /><NumberField label="Height" value={selected.transform.height} min={1} onChange={(value) => { commitEdit((draft) => { draft.transform.height = value; }); }} /><NumberField label="Rotation" value={selected.transform.rotationDeg} onChange={(value) => { commitEdit((draft) => { draft.transform.rotationDeg = value; }); }} /><NumberField label="Scale X" value={selected.transform.scaleX} step={0.05} onChange={(value) => { commitEdit((draft) => { draft.transform.scaleX = value; }); }} /><NumberField label="Scale Y" value={selected.transform.scaleY} step={0.05} onChange={(value) => { commitEdit((draft) => { draft.transform.scaleY = value; }); }} /><NumberField label="Anchor X" value={selected.transform.anchorX} min={0} max={1} step={0.01} onChange={(value) => { commitEdit((draft) => { draft.transform = manorDecorationTransformWithAnchor(draft.transform, value, draft.transform.anchorY, manorDecorationNeedsHorizontalMirror(draft, surface)); }); }} /><NumberField label="Anchor Y" value={selected.transform.anchorY} min={0} max={1} step={0.01} onChange={(value) => { commitEdit((draft) => { draft.transform = manorDecorationTransformWithAnchor(draft.transform, draft.transform.anchorX, value, manorDecorationNeedsHorizontalMirror(draft, surface)); }); }} /></div><div className="manor-decoration-actions"><button type="button" disabled={!props.writesAllowed} onClick={startFootprintRemake}>Remake footprint</button><button type="button" disabled={!props.writesAllowed || footprintDraft === null || footprintDraft.length < 3} onClick={finishFootprint}>{footprintDraft !== null && footprintDraft.length >= 3 ? `Close footprint · ${footprintDraft.length} points` : "Close footprint"}</button><button type="button" disabled={!props.writesAllowed} onClick={resetFootprint}>Reset footprint</button></div><p className="manor-inspector-note">The red anchor handle and Anchor X/Y use Asset Studio's pivot convention: the art and footprint stay in place while the normalized anchor changes. Footprint editing uses normalized PNG-local coordinates; the gold first dot closes it after three points.</p><label className="field compact"><span>Editable polygon footprint (normalized x/y JSON)</span><textarea key={`footprint:${selected.id}`} defaultValue={JSON.stringify(selected.footprint)} onBlur={(event) => { const parsed = parseFootprint(event.currentTarget.value); if (!parsed) { setEditStatus("Edit rejected: footprint must be a JSON array of x/y points."); return; } commitEdit((draft) => { draft.footprint = parsed; }); }} /></label><label className="toggle"><input type="checkbox" checked={selected.collision} disabled={!props.writesAllowed} onChange={(event) => { commitEdit((draft) => { draft.collision = event.target.checked; }); }} /><span>Optional collision footprint</span></label><p className={editStatus || reason ? "manor-invalid-overlay" : "manor-valid-overlay"} role="status">{editStatus ?? reason ?? "Valid overlay · full transformed polygon is contained by the selected surface."}</p></> : <p className="empty-copy">Choose Add Floor, Add Back Wall, or Add Side Wall to begin a Studio-only overlay draft.</p>}</aside>
  </div></div>;
}

function DecorationMetadata(props: {
  selected: InteriorDecoration;
  writesAllowed: boolean;
  onEdit(edit: (draft: InteriorDecoration) => void): boolean;
}): React.JSX.Element {
  return <div className="manor-decoration-metadata">
    <label className="field compact"><span>Decoration name</span><input value={props.selected.name} maxLength={120} disabled={!props.writesAllowed} onChange={(event) => props.onEdit((draft) => { draft.name = event.target.value; })} /></label>
    <label className="field compact"><span>Inventory custody</span><select value={props.selected.itemId ?? ""} disabled={!props.writesAllowed} onChange={(event) => props.onEdit((draft) => { draft.itemId = event.target.value || null; })}><option value="">Free universal decoration</option>{MANOR_DECORATION_ITEMS.map((item) => <option key={item.itemId} value={item.itemId}>{item.displayName} · {item.itemId}</option>)}</select></label>
    <label className="field compact"><span>Placement mode</span><select value={props.selected.placementMode} disabled={!props.writesAllowed} onChange={(event) => props.onEdit((draft) => { draft.placementMode = event.target.value as InteriorDecoration["placementMode"]; })}><option value="permanent">Permanent · authored position only</option><option value="movable">Movable · owner can reposition</option></select></label>
  </div>;
}
