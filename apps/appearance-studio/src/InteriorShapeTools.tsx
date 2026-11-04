import type { DungeonRoomDefinition } from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { DebugToggle, NumberField, VertexListEditor, WallMappingFields } from "./InteriorCanvasFields.js";
import {
  ANCHOR_ROLE_LABELS,
  DRAW_SHAPE_LABELS,
  anchorRoleOf,
  doorDestinations,
  entranceRoomId,
  portalDestinationOptions,
  setDoorDestinations,
  WORLD_DESTINATION,
  type DoorDestination,
  retireAnchor,
  retireShape,
  setAnchorMessage,
  setAnchorName,
  setAnchorRole,
  setShapeVertices,
  shapeVertices,
  updateClickArea,
  updateWall,
  type AuthoringSources,
  type AuthoringView,
  type DrawShapeKind,
  type RoomAuthoring,
  type ShapeRef
} from "./interiorAuthoring.js";
import type { InteriorAnchorRole } from "@ash-atlas/shared";
import { anchorNames, describeSelection, ENTITY_GLYPHS, friendlyId, type CanvasEntityKind, type NamingContext } from "./interiorStudioUx.js";

/** What the Shapes tab can act on (a subset of the studio's canvas selection). */
export type ShapeSelection = Readonly<{ kind: string; id: string }> | null;

export const SHAPE_SELECTION_KINDS: ReadonlySet<string> = new Set(["floor", "wall", "clickArea", "collider", "zone"]);
const ROLES: readonly InteriorAnchorRole[] = ["spawn", "portal", "message", "point"];

const shapeTitle = (ref: ShapeRef, authoring: RoomAuthoring): string => {
  if (ref.kind === "floor") return "Floor";
  if (ref.kind === "collider") return "Collider";
  if (ref.kind === "zone") return "Zone";
  if (ref.kind === "clickArea") return "Click area";
  const wall = authoring.walls.find((value) => value.id === ref.id);
  return wall ? DRAW_SHAPE_LABELS[wall.kind] : "Wall";
};

export type ShapeToolsProps = {
  view: AuthoringView;
  sources: AuthoringSources;
  spaceId: string;
  room: DungeonRoomDefinition;
  authoring: RoomAuthoring;
  selection: ShapeSelection;
  writesAllowed: boolean;
  snapToGrid: boolean;
  selectedVertex: number | null;
  debug: { floors: boolean; walls: boolean; clickAreas: boolean };
  onDebug(key: "floors" | "walls" | "clickAreas"): void;
  onSnap(value: boolean): void;
  onSelect(selection: ShapeSelection): void;
  onSelectVertex(index: number | null): void;
  /** One undoable edit of the editing view. */
  onEdit(edit: (draft: AuthoringView) => void): void;
  onError(message: string): void;
  /** Show a (new) anchor in another room so it can be dragged into place. */
  onRevealAnchor?(roomId: string, anchorId: string): void;
};

/** Canvas drawing tools and the inspector for floors, walls, colliders, click areas and typed anchors. */
export function ShapeTools(props: ShapeToolsProps): React.JSX.Element {
  const { room, authoring, selection } = props;
  const disabled = !props.writesAllowed;
  const active = <T extends { retired: boolean }>(values: readonly T[]): T[] => values.filter((value) => !value.retired);
  const rows: { ref: ShapeRef; label: string }[] = [
    ...active(authoring.floors).map((value) => ({ ref: { kind: "floor", id: value.id } as ShapeRef, label: "Floor" })),
    ...active(authoring.walls).map((value) => ({ ref: { kind: "wall", id: value.id } as ShapeRef, label: DRAW_SHAPE_LABELS[value.kind] })),
    ...active(room.colliders).map((value) => ({ ref: { kind: "collider", id: value.id } as ShapeRef, label: "Collider" })),
    ...active(authoring.clickAreas).map((value) => ({ ref: { kind: "clickArea", id: value.id } as ShapeRef, label: "Click area" }))
  ];
  const anchors = active(room.anchors);
  const dungeon = props.view.dungeons.find((value) => value.id === props.spaceId);
  const naming: NamingContext | null = dungeon ? { room, dungeon, prefabs: [], authoring, anchorRoles: Object.fromEntries(anchors.map((anchor) => [anchor.id, anchorRoleOf(props.view, props.sources, props.spaceId, room, anchor.id)])) } : null;
  const anchorLabels = naming ? anchorNames(naming) : new Map<string, string>();
  const sameKind = (kind: string): number => rows.filter((row) => row.ref.kind === kind).length;
  const nameOf = (row: { ref: ShapeRef; label: string }, index: number): string => {
    const summary = naming ? describeSelection(naming, row.ref as { kind: CanvasEntityKind; id: string }) : null;
    const base = summary && summary.name !== summary.type ? summary.name : row.label;
    return sameKind(row.ref.kind) > 1 && base === row.label ? `${row.label} ${rows.filter((value, position) => value.ref.kind === row.ref.kind && position <= index).length}` : base;
  };
  return <div className="interior-shape-tools" aria-label="Room shapes">
    <p className="manor-help">Pick a drawing tool on the canvas (Floor, Wall, Collider, Click Area, Anchor) and click dots to outline it.</p>
    <div className="divider"><span>SHAPES</span></div>
    {authoring.autoFloors ? <p className="manor-inspector-note">This room uses an automatic floor that follows its size. Drawing a floor replaces it.</p> : null}
    <ul className="interior-shape-list" aria-label="Shapes in this room">
      {rows.map((row) => <li key={`${row.ref.kind}:${row.ref.id}`}><button type="button" aria-pressed={selection?.kind === row.ref.kind && selection.id === row.ref.id} onClick={() => props.onSelect(row.ref)}><span className="row-glyph" aria-hidden="true">{ENTITY_GLYPHS[row.ref.kind as CanvasEntityKind]}</span><span className="row-name">{nameOf(row, rows.indexOf(row))}</span><small className="row-id">{row.ref.id}</small></button></li>)}
      {rows.length === 0 ? <li className="empty-copy">No shapes yet.</li> : null}
    </ul>
    <div className="divider"><span>ANCHORS</span></div>
    <ul className="interior-shape-list" aria-label="Anchors in this room">
      {anchors.map((anchor) => <li key={anchor.id}><button type="button" aria-pressed={selection?.kind === "anchor" && selection.id === anchor.id} onClick={() => props.onSelect({ kind: "anchor", id: anchor.id })}><span className="row-glyph" aria-hidden="true">{ENTITY_GLYPHS.anchor}</span><span className="row-name">{anchorLabels.get(anchor.id) ?? friendlyId(anchor.id)}</span><small className="row-id">{ANCHOR_ROLE_LABELS[anchorRoleOf(props.view, props.sources, props.spaceId, room, anchor.id)]} · {anchor.id}</small></button></li>)}
    </ul>

    {selection?.kind === "anchor" ? <AnchorInspector {...props} anchorId={selection.id} /> : null}
    {selection && SHAPE_SELECTION_KINDS.has(selection.kind) ? <ShapeInspector {...props} ref_={selection as ShapeRef} /> : null}
  </div>;
}

export function AnchorInspector(props: ShapeToolsProps & { anchorId: string }): React.JSX.Element | null {
  const { room, spaceId, anchorId } = props;
  const anchor = room.anchors.find((value) => value.id === anchorId && !value.retired);
  const role = anchor ? anchorRoleOf(props.view, props.sources, spaceId, room, anchorId) : "point";
  const dungeon = props.view.dungeons.find((value) => value.id === spaceId);
  const options = portalDestinationOptions(props.view, props.sources, spaceId, room.id);
  const canLeave = entranceRoomId(props.sources, spaceId) === room.id;
  const savedRows = (): DoorDestination[] => {
    const current = dungeon ? doorDestinations(dungeon, room.id, anchorId) : [];
    return current.length > 0 ? current : options[0] ? [{ roomId: options[0].roomId, label: options[0].roomName }] : [];
  };
  const [rows, setRows] = useState<DoorDestination[]>(savedRows);
  useEffect(() => { setRows(savedRows()); }, [anchorId, room.id]);
  if (!anchor) return null;
  const roomName = (roomId: string): string => roomId === WORLD_DESTINATION ? "Outside (leave Manor)" : options.find((option) => option.roomId === roomId)?.roomName ?? roomId;
  const defaultLabel = (roomId: string): string => roomId === WORLD_DESTINATION ? "Leave Manor" : roomName(roomId);
  const editRow = (index: number, patch: Partial<DoorDestination>): void => setRows((current) => current.map((row, position) => {
    if (position !== index) return row;
    const next = { ...row, ...patch };
    // A new destination room resets the anchor choice, and the label when it was still the default.
    if (patch.roomId !== undefined && patch.roomId !== row.roomId) {
      const { anchorId: _anchor, ...rest } = next;
      return { ...rest, label: row.label.trim() === "" || row.label === defaultLabel(row.roomId) ? defaultLabel(patch.roomId) : row.label };
    }
    return next;
  }));
  const saveDoor = (): void => {
    // Dry run on a copy to report errors now and learn which anchors get created (ids are deterministic).
    const preview = setDoorDestinations(structuredClone(props.view), props.sources, spaceId, room.id, anchorId, rows);
    if (!preview.ok) { props.onError(preview.error); return; }
    props.onEdit((draft) => { setDoorDestinations(draft, props.sources, spaceId, room.id, anchorId, rows); });
    const first = preview.createdAnchors[0];
    if (first && props.onRevealAnchor) queueMicrotask(() => props.onRevealAnchor!(first.roomId, first.anchorId));
  };
  const message = props.authoring.anchors[anchorId]?.message ?? "";
  const disabled = !props.writesAllowed;
  return <section className="interior-shape-inspector" aria-label={`Anchor ${anchorId}`}>
    <h3>Anchor · {props.authoring.anchorNames?.[anchorId] ?? anchorId}</h3>
    <label className="field compact"><span>Name</span><input aria-label="Anchor name" value={props.authoring.anchorNames?.[anchorId] ?? ""} maxLength={40} disabled={disabled} placeholder="e.g. Left door, Exit, Stairs" onChange={(event) => { const name = event.target.value; props.onEdit((draft) => { setAnchorName(draft, props.sources, spaceId, room.id, anchorId, name); }); }} /></label>
    <div className="field-grid">
      <NumberField label="X" unit="px" value={anchor.x} disabled={disabled} onChange={(x) => props.onEdit((draft) => { const target = draft.dungeons.find((value) => value.id === spaceId)?.rooms.find((value) => value.id === room.id)?.anchors.find((value) => value.id === anchorId); if (target) target.x = x; })} />
      <NumberField label="Y" unit="px" value={anchor.y} disabled={disabled} onChange={(y) => props.onEdit((draft) => { const target = draft.dungeons.find((value) => value.id === spaceId)?.rooms.find((value) => value.id === room.id)?.anchors.find((value) => value.id === anchorId); if (target) target.y = y; })} />
    </div>
    <label className="field compact"><span>Anchor role</span><select value={role} disabled={disabled} onChange={(event) => props.onEdit((draft) => {
      const result = setAnchorRole(draft, props.sources, spaceId, room.id, anchorId, event.target.value as InteriorAnchorRole);
      if (!result.ok) props.onError(result.error);
    })}>{ROLES.map((value) => <option key={value} value={value}>{ANCHOR_ROLE_LABELS[value]}</option>)}</select></label>
    {role === "spawn" ? <p className="manor-inspector-note">The room spawn is where players arrive when no portal chose a spot. Make another anchor the spawn to change it.</p> : null}
    {role === "point" ? <p className="manor-inspector-note">A plain point for objects, enemies, resources and click-area targets.</p> : null}
    {role === "message" ? <>
      <label className="field compact"><span>Message text</span><textarea value={message} maxLength={240} disabled={disabled} placeholder="Shown when the click area bound to this anchor is tapped." onChange={(event) => props.onEdit((draft) => { setAnchorMessage(draft, props.sources, spaceId, room.id, anchorId, event.target.value); })} /></label>
      <p className="manor-inspector-note">A click area bound to this anchor shows the message. Message anchors need no destination.</p>
    </> : null}
    {role === "portal" ? <section className="interior-door-destinations" aria-label="Destinations">
      <div className="divider"><span>DESTINATIONS</span></div>
      {options.length === 0 && !canLeave ? <p className="manor-inspector-note">Add another room to connect this door to.</p> : null}
      {rows.map((row, index) => {
        const target = options.find((option) => option.roomId === row.roomId);
        return <div className="interior-door-destination" key={index} role="group" aria-label={`Destination ${index + 1}`}>
          <label className="field compact"><span>Destination room</span><select value={row.roomId} disabled={disabled} onChange={(event) => editRow(index, { roomId: event.target.value })}>
            {options.map((option) => <option key={option.roomId} value={option.roomId}>{option.roomName}</option>)}
            {canLeave ? <option value={WORLD_DESTINATION}>Outside (leave Manor)</option> : null}
          </select></label>
          {row.roomId !== WORLD_DESTINATION ? <label className="field compact"><span>Destination anchor</span><select value={row.anchorId ?? ""} disabled={disabled} onChange={(event) => { const value = event.target.value; setRows((current) => current.map((entry, position) => { if (position !== index) return entry; const { anchorId: _previous, ...rest } = entry; return value ? { ...rest, anchorId: value } : rest; })); }}>
            <option value="">New anchor in {target?.roomName ?? "that room"}</option>
            {(target?.anchors ?? []).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id} · {ANCHOR_ROLE_LABELS[candidate.role]}</option>)}
          </select></label> : null}
          <label className="field compact"><span>Button label</span><input value={row.label} maxLength={80} disabled={disabled} placeholder={defaultLabel(row.roomId)} onChange={(event) => editRow(index, { label: event.target.value })} /></label>
          <button type="button" aria-label={`Remove destination ${index + 1}`} disabled={disabled || rows.length <= 1} onClick={() => setRows((current) => current.filter((_, position) => position !== index))}>−</button>
        </div>;
      })}
      <div className="interior-door-actions">
        <button type="button" disabled={disabled || options.length === 0} onClick={() => setRows((current) => {
          const next = options.find((option) => !current.some((row) => row.roomId === option.roomId)) ?? options[0]!;
          return [...current, { roomId: next.roomId, label: next.roomName }];
        })}>+ Add destination</button>
        <button type="button" className="primary" disabled={disabled || rows.length === 0} onClick={saveDoor}>Save door</button>
      </div>
      <p className="manor-inspector-note">Each destination is a button in the door prompt (one destination: a single button). Save door creates the portals both ways; a new anchor in the other room is selected afterwards so you can drag it onto its doorway. Outside (leave Manor) is only offered in the entrance room and makes this the only way out.</p>
    </section> : null}
    <button type="button" className="danger wide" disabled={disabled} onClick={() => {
      props.onEdit((draft) => { const result = retireAnchor(draft, props.sources, spaceId, room.id, anchorId); if (!result.ok) props.onError(result.error); });
      props.onSelect(null);
    }}>Retire anchor</button>
  </section>;
}

function ShapeInspector(props: ShapeToolsProps & { ref_: ShapeRef }): React.JSX.Element | null {
  const { room, spaceId, authoring } = props;
  const ref = props.ref_;
  const vertices = shapeVertices(room, authoring, ref);
  const wall = ref.kind === "wall" ? authoring.walls.find((value) => value.id === ref.id) : undefined;
  const area = ref.kind === "clickArea" ? authoring.clickAreas.find((value) => value.id === ref.id) : undefined;
  const disabled = !props.writesAllowed;
  if (!vertices && !wall && !area) return null;
  const targets = [
    ...room.anchors.filter((anchor) => !anchor.retired && anchor.id !== room.spawnAnchorId).map((anchor) => ({ value: `anchor:${anchor.id}`, label: `Anchor · ${anchor.id}` })),
    ...room.objects.filter((object) => !object.retired).map((object) => ({ value: `object:${object.id}`, label: `Object · ${object.name}` }))
  ];
  const target = area ? ("anchorId" in area.target ? `anchor:${area.target.anchorId}` : `object:${area.target.objectId}`) : "";
  return <section className="interior-shape-inspector" aria-label={`${shapeTitle(ref, authoring)} ${ref.id}`}>
    <h3>{shapeTitle(ref, authoring)} · {ref.id}</h3>
    {ref.kind === "floor" && authoring.autoFloors ? <p className="manor-inspector-note">Editing this automatic floor makes it a hand-authored floor.</p> : null}
    {vertices ? <VertexListEditor points={vertices} disabled={disabled} selectedIndex={props.selectedVertex} onSelect={props.onSelectVertex}
      onChange={(points) => props.onEdit((draft) => { setShapeVertices(draft, props.sources, spaceId, room.id, ref, points); })} />
      : <p className="manor-inspector-note">This is a rectangle. Drag it on the canvas or edit it in the Objects tab.</p>}
    {area ? <>
      <label className="field compact"><span>Interaction label</span><input value={area.interactionLabel} disabled={disabled} onChange={(event) => props.onEdit((draft) => { updateClickArea(draft, props.sources, spaceId, room.id, area.id, (value) => { value.interactionLabel = event.target.value || "Interact"; }); })} /></label>
      <label className="field compact"><span>Bound to</span><select value={target} disabled={disabled} onChange={(event) => props.onEdit((draft) => { updateClickArea(draft, props.sources, spaceId, room.id, area.id, (value) => {
        const [kind, id] = [event.target.value.slice(0, event.target.value.indexOf(":")), event.target.value.slice(event.target.value.indexOf(":") + 1)];
        value.target = kind === "object" ? { objectId: id } : { anchorId: id };
      }); })}>
        {!targets.some((option) => option.value === target) ? <option value={target}>{target.split(":")[1]} · needs a binding</option> : null}
        {targets.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <p className="manor-inspector-note">Tapping this area triggers its anchor (portal or message) or object.</p>
    </> : null}
    {wall ? <>
      <label className="field compact"><span>Wall side</span><select value={wall.kind} disabled={disabled} onChange={(event) => props.onEdit((draft) => { updateWall(draft, props.sources, spaceId, room.id, wall.id, (value) => { value.kind = event.target.value as typeof wall.kind; }); })}>
        <option value="back_wall">Back wall</option><option value="left_wall">Left wall</option><option value="right_wall">Right wall</option>
      </select></label>
      <WallMappingFields title={`${DRAW_SHAPE_LABELS[wall.kind]} image mapping`} idKey={wall.id} transform={wall.transform} imagePolygon={wall.imagePolygon} disabled={disabled}
        onTransform={(key, value) => props.onEdit((draft) => { updateWall(draft, props.sources, spaceId, room.id, wall.id, (candidate) => { candidate.transform[key] = value; }); })}
        onImagePolygon={(parsed) => props.onEdit((draft) => { updateWall(draft, props.sources, spaceId, room.id, wall.id, (candidate) => { if (parsed.length === candidate.roomPolygon.length) candidate.imagePolygon = parsed; else props.onError("The image polygon needs one point for each wall vertex."); }); })} />
    </> : null}
    <button type="button" className="danger wide" disabled={disabled} onClick={() => {
      props.onEdit((draft) => { if (!retireShape(draft, props.sources, spaceId, room.id, ref)) props.onError("That shape could not be retired."); });
      props.onSelect(null);
    }}>Retire {shapeTitle(ref, authoring).toLowerCase()}</button>
  </section>;
}
