import { CISTERN_WARRENS_MOVE_SPEED, STANDARD_INDOOR_SPATIAL_PROFILE } from "@ash-atlas/shared";
import type { DungeonDefinition, DungeonPrefabDefinition, DungeonRoomDefinition, IndoorPoint, InteriorSpaceKind } from "@ash-atlas/shared";

import { DRAW_SHAPE_LABELS, shapeVertices, type RoomAuthoring, type ShapeRef } from "./interiorAuthoring.js";

/** Pure helpers behind the Interiors canvas tools, labels, library filter and validation focus. */

// ---------------------------------------------------------------------------
// Tools and shortcuts
// ---------------------------------------------------------------------------

export type CanvasTool = "select" | "pan" | "floor" | "wall" | "collider" | "clickArea" | "anchor" | "place";

export type CanvasToolDefinition = Readonly<{ tool: CanvasTool; label: string; short: string; key: string; hint: string; needsShapes: boolean }>;

export const TOOL_GLYPHS: Readonly<Record<CanvasTool, string>> = {
  select: "↖", pan: "✋", floor: "▱", wall: "▤", collider: "▭", clickArea: "☝", anchor: "◎", place: "＋"
};

export const CANVAS_TOOLS: readonly CanvasToolDefinition[] = [
  { tool: "select", label: "Select", short: "Select", key: "V", hint: "Click things to select and drag them", needsShapes: false },
  { tool: "pan", label: "Pan", short: "Pan", key: "H", hint: "Drag to move the view (or hold Space)", needsShapes: false },
  { tool: "floor", label: "Draw Floor", short: "Floor", key: "F", hint: "Click dots to outline the walkable floor", needsShapes: true },
  { tool: "wall", label: "Wall", short: "Wall", key: "W", hint: "Click dots to outline a wall", needsShapes: true },
  { tool: "collider", label: "Collider", short: "Collide", key: "C", hint: "Click dots to outline something players cannot walk through", needsShapes: true },
  { tool: "clickArea", label: "Click Area", short: "Click", key: "K", hint: "Click dots to outline something players can tap", needsShapes: true },
  { tool: "anchor", label: "Anchor", short: "Anchor", key: "A", hint: "Click to drop a point: spawn, door or message", needsShapes: true },
  { tool: "place", label: "Place from library", short: "Place", key: "P", hint: "Click the room to place the chosen library item", needsShapes: false }
];

/** The tool a bare key press selects, or null. */
export function toolForKey(key: string): CanvasTool | null {
  const upper = key.length === 1 ? key.toUpperCase() : "";
  return CANVAS_TOOLS.find((definition) => definition.key === upper)?.tool ?? null;
}

export const SHORTCUT_SHEET: readonly Readonly<{ keys: string; action: string }>[] = [
  ...CANVAS_TOOLS.map((definition) => ({ keys: definition.key, action: definition.label })),
  { keys: "Space (hold)", action: "Pan while held" },
  { keys: "Esc", action: "Back to Select, or cancel the shape you are drawing" },
  { keys: "Enter", action: "Close the shape you are drawing" },
  { keys: "Delete", action: "Remove the selected item" },
  { keys: "Ctrl+Z", action: "Undo" },
  { keys: "Ctrl+Y", action: "Redo" },
  { keys: "Ctrl+S", action: "Save to worktree" },
  { keys: "Wheel", action: "Zoom the view" },
  { keys: "?", action: "Show this list" }
];

// ---------------------------------------------------------------------------
// Friendly names
// ---------------------------------------------------------------------------

export function friendlyId(value: string): string {
  return value.split("_").map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part).join(" ");
}

export type CanvasEntityKind = "anchor" | "collider" | "zone" | "resourceZone" | "object" | "mob" | "placement" | "floor" | "wall" | "clickArea";
export type CanvasEntityRef = Readonly<{ kind: CanvasEntityKind; id: string }>;

const OBJECT_TYPE_NAMES: Readonly<Record<string, string>> = {
  portal: "Door", door: "Door", ladder: "Ladder", chest: "Chest", valve: "Valve", switch: "Switch", shrine: "Shrine",
  harvestable: "Harvestable", destructible: "Destructible", npc: "Character", decoration: "Decoration", exit_ladder: "Exit ladder"
};
const ZONE_PURPOSE_NAMES: Readonly<Record<string, string>> = { trigger: "Trigger zone", encounter_boundary: "Encounter area", leash: "Leash area" };
export const friendlyObjectType = (type: string): string => OBJECT_TYPE_NAMES[type] ?? friendlyId(type);

export const ENTITY_GLYPHS: Readonly<Record<CanvasEntityKind, string>> = {
  anchor: "◎", collider: "▭", zone: "▨", resourceZone: "⚘", object: "▣", mob: "⚔", placement: "▦", floor: "▱", wall: "▓", clickArea: "☝"
};

export type NamingContext = Readonly<{
  room: DungeonRoomDefinition;
  dungeon: DungeonDefinition;
  prefabs: readonly DungeonPrefabDefinition[];
  authoring?: RoomAuthoring | null;
  anchorRoles?: Readonly<Record<string, string>>;
}>;

function destinationName(dungeon: DungeonDefinition, destination: DungeonDefinition["portals"][number]["destination"]): string {
  return destination.kind === "room" ? dungeon.rooms.find((value) => value.id === destination.roomId)?.name ?? friendlyId(destination.roomId) : "the world";
}

/** Door and exit names: "Door → Sewer Depths", "Exit to world". */
export function portalLabel(dungeon: DungeonDefinition, portal: DungeonDefinition["portals"][number]): string {
  return portal.destination.kind === "world" ? "Exit to world" : `Door → ${destinationName(dungeon, portal.destination)}`;
}

/** The human name of every active anchor in the room (ids stay in the inspector). */
export function anchorNames(context: NamingContext): Map<string, string> {
  const { room, dungeon } = context;
  const names = new Map<string, string>();
  const plain: string[] = [];
  for (const anchor of room.anchors.filter((value) => !value.retired)) {
    const owner = room.objects.find((object) => !object.retired && object.anchorId === anchor.id);
    const mob = room.mobs.find((value) => !value.retired && value.anchorId === anchor.id);
    const node = room.resourceNodes?.find((value) => !value.retired && value.anchorId === anchor.id);
    const leaving = dungeon.portals.find((portal) => !portal.retired && portal.source.kind === "room" && portal.source.roomId === room.id && portal.source.anchorId === anchor.id);
    const arriving = dungeon.portals.find((portal) => !portal.retired && portal.destination.kind === "room" && portal.destination.roomId === room.id && portal.destination.anchorId === anchor.id);
    const role = context.anchorRoles?.[anchor.id];
    const authoredName = context.authoring?.anchorNames?.[anchor.id];
    if (authoredName) names.set(anchor.id, authoredName);
    else if (anchor.id === room.spawnAnchorId || role === "spawn") names.set(anchor.id, "Spawn");
    else if (leaving) names.set(anchor.id, portalLabel(dungeon, leaving));
    else if (owner) names.set(anchor.id, owner.name);
    else if (mob) names.set(anchor.id, friendlyId(mob.archetype));
    else if (node) names.set(anchor.id, `${friendlyId(node.resourceType)} node`);
    else if (arriving) names.set(anchor.id, `Arrival from ${destinationName(dungeon, arriving.source)}`);
    else if (role === "message") names.set(anchor.id, "Message");
    else if (role === "portal") names.set(anchor.id, "Door point");
    else plain.push(anchor.id);
  }
  plain.forEach((id, index) => names.set(id, plain.length === 1 ? "Point" : `Point ${index + 1}`));
  return names;
}

export type SelectionSummary = Readonly<{ glyph: string; type: string; name: string }>;

/** Icon, friendly type and name of a canvas selection, for the inspector header and canvas labels. */
export function describeSelection(context: NamingContext, selection: CanvasEntityRef): SelectionSummary | null {
  const { room, dungeon } = context;
  const glyph = ENTITY_GLYPHS[selection.kind];
  switch (selection.kind) {
    case "anchor": {
      const anchor = room.anchors.find((value) => value.id === selection.id);
      if (!anchor) return null;
      const name = anchorNames(context).get(anchor.id) ?? "Point";
      const role = anchor.id === room.spawnAnchorId ? "spawn" : context.anchorRoles?.[anchor.id];
      return { glyph, type: role === "spawn" ? "Spawn point" : role === "portal" ? "Door point" : role === "message" ? "Message point" : "Point", name };
    }
    case "object": {
      const object = room.objects.find((value) => value.id === selection.id);
      if (!object) return null;
      const portal = object.type === "portal" ? dungeon.portals.find((value) => value.id === object.portalId) : undefined;
      return { glyph, type: friendlyObjectType(object.type), name: portal ? portalLabel(dungeon, portal) : object.name };
    }
    case "mob": {
      const mob = room.mobs.find((value) => value.id === selection.id);
      return mob ? { glyph, type: "Enemy", name: friendlyId(mob.archetype) } : null;
    }
    case "collider": return room.colliders.some((value) => value.id === selection.id) ? { glyph, type: "Collider", name: friendlyId(selection.id) } : null;
    case "zone": {
      const zone = room.zones.find((value) => value.id === selection.id);
      return zone ? { glyph, type: ZONE_PURPOSE_NAMES[zone.purpose] ?? "Zone", name: friendlyId(selection.id) } : null;
    }
    case "resourceZone": return room.resourceSpawnZones?.some((value) => value.id === selection.id) ? { glyph, type: "Resource zone", name: friendlyId(selection.id) } : null;
    case "placement": {
      const placement = Object.values(room.layers).flat().find((value) => value.id === selection.id);
      const prefab = placement ? context.prefabs.find((value) => value.id === placement.prefabId) : undefined;
      return placement ? { glyph, type: prefab?.type === "decoration" ? "Decoration" : "Room art", name: prefab?.name ?? friendlyId(placement.prefabId) } : null;
    }
    case "floor": return context.authoring?.floors.some((value) => value.id === selection.id) ? { glyph, type: "Floor", name: friendlyId(selection.id) } : null;
    case "wall": {
      const wall = context.authoring?.walls.find((value) => value.id === selection.id);
      return wall ? { glyph, type: DRAW_SHAPE_LABELS[wall.kind as keyof typeof DRAW_SHAPE_LABELS] ?? "Wall", name: friendlyId(selection.id) } : null;
    }
    case "clickArea": return context.authoring?.clickAreas.some((value) => value.id === selection.id) ? { glyph, type: "Click area", name: friendlyId(selection.id) } : null;
  }
}

// ---------------------------------------------------------------------------
// Canvas labels
// ---------------------------------------------------------------------------

export type LabelCandidate = Readonly<{ key: string; text: string; x: number; y: number; priority: number }>;
export type PlacedLabel = LabelCandidate & Readonly<{ tx: number; ty: number; textAnchor: "start" | "end" }>;

/** Bold label text is wider than a plain average glyph; err wide so labels never touch. */
export function estimateLabelWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.74 + 12;
}

/**
 * Greedy label layout: highest priority first. A label tries the right of its point, then the left; it is
 * skipped when both sides would touch a placed label or another candidate's marker (important labels may cover a marker).
 */
export function layoutLabels(candidates: readonly LabelCandidate[], options: { fontSize: number; roomWidth: number; roomHeight: number }): PlacedLabel[] {
  type Box = { left: number; right: number; top: number; bottom: number };
  const placed: PlacedLabel[] = [];
  const boxes: Box[] = [];
  const offset = options.fontSize * 1.1;
  const gap = options.fontSize * 0.4;
  const markerHalf = 16;
  const touches = (a: Box, b: Box): boolean => a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top;
  const ordered = candidates.map((candidate, index) => ({ candidate, index })).sort((a, b) => b.candidate.priority - a.candidate.priority || a.index - b.index);
  for (const { candidate } of ordered) {
    const width = estimateLabelWidth(candidate.text, options.fontSize);
    const markers: Box[] = candidates.filter((other) => other !== candidate).map((other) => ({ left: other.x - markerHalf, right: other.x + markerHalf, top: other.y - markerHalf, bottom: other.y + markerHalf }));
    const preferLeft = candidate.x + offset + width > options.roomWidth && candidate.x - offset - width >= 0;
    const sides = preferLeft ? [true, false] : [false, true];
    // First choice clears other labels and other markers; failing that an important label (priority 50+) only has to clear other labels.
    const attempts = sides.map((flip) => ({ flip, avoidMarkers: true })).concat(candidate.priority >= 50 ? sides.map((flip) => ({ flip, avoidMarkers: false })) : []);
    for (const { flip, avoidMarkers } of attempts) {
      const left = flip ? candidate.x - offset - width : candidate.x + offset;
      const box: Box = { left, right: left + width, top: candidate.y - options.fontSize * 0.75, bottom: candidate.y + options.fontSize * 0.45 };
      if (box.left < 0 || box.right > options.roomWidth) continue;
      if (boxes.some((other) => touches(box, other)) || (avoidMarkers && markers.some((other) => touches(box, other)))) continue;
      boxes.push(box);
      placed.push({ ...candidate, tx: flip ? candidate.x - offset : candidate.x + offset, ty: candidate.y + options.fontSize * 0.33, textAnchor: flip ? "end" : "start" });
      break;
    }
  }
  return placed;
}

/** Plain-language movement text for the Room tab, from the space's spatial profile. */
export function movementProfileText(kind: InteriorSpaceKind): string {
  return kind === "dungeon"
    ? `Players move at half speed here · ${CISTERN_WARRENS_MOVE_SPEED} units per second · equipment modifiers apply`
    : `Players move at normal indoor speed · ${STANDARD_INDOOR_SPATIAL_PROFILE.movementUnitsPerSecond} units per second · equipment modifiers apply`;
}

// ---------------------------------------------------------------------------
// Library filter
// ---------------------------------------------------------------------------

export type ArtFamily = InteriorSpaceKind | "shared";

/** Which interior kind a prefab's art is made for; anything unrecognised is shared and shows everywhere. */
export function prefabArtFamily(prefab: Pick<DungeonPrefabDefinition, "id" | "assetKey">): ArtFamily {
  const text = `${prefab.assetKey} ${prefab.id}`.toLowerCase();
  if (text.includes("/dungeons/shared/") || text.includes("dungeon_")) return "shared";
  if (text.includes("greenhouse")) return "greenhouse";
  if (text.includes("manor")) return "manor";
  if (text.includes("salon")) return "salon";
  if (text.includes("/dungeons/") || text.includes("sewer")) return "dungeon";
  return "shared";
}

export function prefabMatchesInteriorKind(prefab: Pick<DungeonPrefabDefinition, "id" | "assetKey">, kind: InteriorSpaceKind): boolean {
  const family = prefabArtFamily(prefab);
  return family === "shared" || family === kind;
}

// ---------------------------------------------------------------------------
// Focus a selection on the canvas
// ---------------------------------------------------------------------------

/** The room point that best represents a canvas selection (its centre), or null when it no longer exists. */
export function selectionPoint(room: DungeonRoomDefinition, authoring: RoomAuthoring | null | undefined, selection: CanvasEntityRef): IndoorPoint | null {
  const centre = (points: readonly IndoorPoint[]): IndoorPoint | null => points.length === 0 ? null : { x: points.reduce((sum, value) => sum + value.x, 0) / points.length, y: points.reduce((sum, value) => sum + value.y, 0) / points.length };
  const rectCentre = (shape: { x: number; y: number; width: number; height: number }): IndoorPoint => ({ x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 });
  const anchorOf = (id: string | undefined): IndoorPoint | null => room.anchors.find((value) => value.id === id) ?? null;
  switch (selection.kind) {
    case "anchor": return anchorOf(selection.id);
    case "object": return anchorOf(room.objects.find((value) => value.id === selection.id)?.anchorId);
    case "mob": return anchorOf(room.mobs.find((value) => value.id === selection.id)?.anchorId);
    case "placement": { const value = Object.values(room.layers).flat().find((candidate) => candidate.id === selection.id); return value ? rectCentre(value) : null; }
    case "resourceZone": { const shape = room.resourceSpawnZones?.find((value) => value.id === selection.id)?.shape; return !shape ? null : shape.kind === "rectangle" ? rectCentre(shape) : centre(shape.points); }
    case "collider":
    case "zone": {
      const shape = (selection.kind === "collider" ? room.colliders : room.zones).find((value) => value.id === selection.id);
      return !shape ? null : shape.kind === "rectangle" ? rectCentre(shape) : centre(shape.points);
    }
    default: return authoring ? centre(shapeVertices(room, authoring, selection as ShapeRef) ?? []) : null;
  }
}

/**
 * The pan (CSS pixels) that brings a room point to the middle of the canvas.
 * `size` is the unscaled on-screen size of the room canvas.
 */
export function panToPoint(point: IndoorPoint, room: { width: number; height: number }, size: { width: number; height: number }, zoom: number): IndoorPoint {
  return { x: -((point.x / room.width) - 0.5) * size.width * zoom, y: -((point.y / room.height) - 0.5) * size.height * zoom };
}

// ---------------------------------------------------------------------------
// Inspector wording
// ---------------------------------------------------------------------------

export const LAYER_NAMES: Readonly<Record<string, string>> = {
  background: "Background (behind everything)", below_player: "Below players", actors: "With players", above_player: "Above players", ceiling: "Ceiling (over the room)"
};
export const friendlyLayer = (layer: string): string => LAYER_NAMES[layer] ?? friendlyId(layer);

/** Blank-room checklist: which setup steps a room already has. */
export type RoomChecklistItem = Readonly<{ id: "art" | "floor" | "spawn" | "exit"; label: string; done: boolean }>;

export function roomChecklist(input: { room: DungeonRoomDefinition; dungeon: DungeonDefinition; authoring?: RoomAuthoring | null }): RoomChecklistItem[] {
  const { room, dungeon, authoring } = input;
  const floorsDrawn = authoring ? !authoring.autoFloors && authoring.floors.some((value) => !value.retired) : false;
  const hasSpawn = room.anchors.some((value) => !value.retired && value.id === room.spawnAnchorId);
  const hasExit = dungeon.portals.some((portal) => !portal.retired && ((portal.source.kind === "room" && portal.source.roomId === room.id) || (portal.destination.kind === "room" && portal.destination.roomId === room.id)));
  const items: RoomChecklistItem[] = [
    { id: "art", label: "Add room art", done: Object.values(room.layers).some((layer) => layer.some((placement) => !placement.retired)) },
    { id: "floor", label: "Draw the floor", done: floorsDrawn },
    { id: "spawn", label: "Add a spawn point", done: hasSpawn },
    { id: "exit", label: "Add an exit or door", done: hasExit }
  ];
  return authoring ? items : items.filter((item) => item.id !== "floor");
}
