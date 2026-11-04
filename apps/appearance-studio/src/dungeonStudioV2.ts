import {
  STANDARD_INDOOR_SPATIAL_PROFILE,
  type DungeonCatalog,
  type DungeonBossTemplateDefinition,
  type DungeonDefinition,
  type DungeonMobPlacementDefinition,
  type DungeonObjectDefinition,
  type DungeonPrefabDefinition,
  type DungeonResourceNodeDefinition,
  type DungeonResourceSpawnZoneDefinition,
  type DungeonRoomDefinition,
  type DungeonTriggerDefinition,
  type IndoorPoint,
  type MobArchetypeKey
} from "@ash-atlas/shared";
import { DUNGEON_RESOURCE_TYPES, type DungeonResourceType, type BossDefinition } from "@ash-atlas/shared";

export const DUNGEON_WALK_TEST_PRESETS = {
  phone_portrait: {
    id: "phone_portrait",
    label: "Phone portrait",
    playableWidthPx: 390,
    playableHeightPx: 620
  },
  phone_landscape: {
    id: "phone_landscape",
    label: "Phone landscape",
    playableWidthPx: 740,
    playableHeightPx: 360
  },
  tablet: {
    id: "tablet",
    label: "Tablet",
    playableWidthPx: 1024,
    playableHeightPx: 720
  },
  desktop: {
    id: "desktop",
    label: "Desktop",
    playableWidthPx: 1180,
    playableHeightPx: 660
  }
} as const;

export type DungeonWalkTestPresetId = keyof typeof DUNGEON_WALK_TEST_PRESETS;
export type DungeonWalkTestPreset = (typeof DUNGEON_WALK_TEST_PRESETS)[DungeonWalkTestPresetId];
export type DungeonGameViewWarningCode =
  | "player_too_small"
  | "excessive_black_space"
  | "spawn_near_bounds"
  | "interaction_reach_too_small"
  | "high_wave_density"
  | "important_art_too_small";
export type DungeonGameViewWarning = Readonly<{
  code: DungeonGameViewWarningCode;
  message: string;
}>;
export type DungeonGameViewReport = Readonly<{
  preset: DungeonWalkTestPreset;
  currentZoom: number;
  playerHeightAtDefaultZoomPx: number;
  playerHeightAtMinimumZoomPx: number;
  visibleRoomCoveragePercent: number;
  blackSpacePercent: number;
  warnings: readonly DungeonGameViewWarning[];
}>;

// These are deliberately conservative authoring hints, not catalog validity rules.
const MIN_PHONE_PLAYER_HEIGHT_PX = 24;
const EXCESSIVE_BLACK_SPACE_PERCENT = 45;
const MIN_PROJECTED_INTERACTION_REACH_PX = 22;
const MIN_IMPORTANT_ART_EDGE_PX = 18;
const HIGH_WAVE_MOBS_PER_STANDARD_ROOM = 10;
export const ONE_ROOM_CHEST_REWARD_TABLE_ID = "basic_dungeon_chest";
export const DEFAULT_DUNGEON_ENTRANCE_ASSET_KEY = "apps/client/public/assets/dungeons/shared/orc-cave-entrance.png";

/** All generated asset IDs obey the bridge's 64-character storage contract. */
export function dungeonAssetId(label: string, existing: readonly string[]): string {
  const base = safeDungeonId(label).slice(0, 56).replace(/[-_]+$/u, "");
  const ids = new Set(existing);
  for (let index = 1; ; index += 1) {
    const suffix = `_${index}`;
    const id = `${base.slice(0, 64 - suffix.length).replace(/[-_]+$/u, "")}${suffix}`;
    if (!ids.has(id)) return id;
  }
}

export function resourceShapeFromZone(zone: DungeonRoomDefinition["zones"][number], id: string): DungeonResourceSpawnZoneDefinition["shape"] {
  return zone.kind === "polygon"
    ? { id, retired: false, kind: "polygon", points: zone.points.map((point) => ({ x: point.x, y: point.y })) }
    : { id, retired: false, kind: "rectangle", x: zone.x, y: zone.y, width: zone.width, height: zone.height };
}

/** Published identities remain available to retained runs; world entry is removed. */
export function archiveCreatorDungeon(catalog: DungeonCatalog, id: string): void {
  const dungeon = catalog.dungeons.find((value) => value.id === id);
  if (!dungeon || id === "cistern_warrens") throw new Error("The stock Cistern Warrens cannot be archived.");
  disconnectDungeonWorldEntrance(catalog, id);
  dungeon.retired = true;
}

export type DungeonEntranceInput = Readonly<{
  name: string;
  description: string;
  lat: number;
  lon: number;
  assetKey: string;
}>;

export function dungeonGameViewReport(
  room: DungeonRoomDefinition,
  prefabs: readonly DungeonPrefabDefinition[],
  encounters: readonly DungeonDefinition["encounters"][number][],
  presetId: DungeonWalkTestPresetId,
  currentZoom = room.camera.defaultZoom
): DungeonGameViewReport {
  const preset = DUNGEON_WALK_TEST_PRESETS[presetId];
  const baseScale = Math.max(0, Math.min(
    (preset.playableWidthPx - room.camera.fitPadding * 2) / room.width,
    (preset.playableHeightPx - room.camera.fitPadding * 2) / room.height
  ));
  const scale = baseScale * currentZoom;
  const renderedWidth = room.width * scale;
  const renderedHeight = room.height * scale;
  const visibleWidth = Math.min(preset.playableWidthPx, renderedWidth);
  const visibleHeight = Math.min(preset.playableHeightPx, renderedHeight);
  const viewportArea = preset.playableWidthPx * preset.playableHeightPx;
  const roomArea = Math.max(1, renderedWidth * renderedHeight);
  const visibleArea = visibleWidth * visibleHeight;
  const visibleRoomCoveragePercent = Math.min(100, visibleArea / roomArea * 100);
  const blackSpacePercent = Math.max(0, (1 - visibleArea / viewportArea) * 100);
  const warnings: DungeonGameViewWarning[] = [];
  const playerHeightAtDefaultZoomPx = STANDARD_INDOOR_SPATIAL_PROFILE.playerVisualHeightUnits
    * baseScale * room.camera.defaultZoom;
  const playerHeightAtMinimumZoomPx = STANDARD_INDOOR_SPATIAL_PROFILE.playerVisualHeightUnits
    * baseScale * room.camera.minZoom;

  if (presetId !== "desktop" && playerHeightAtDefaultZoomPx < MIN_PHONE_PLAYER_HEIGHT_PX) {
    warnings.push({ code: "player_too_small", message: `Player projects to ${formatPixels(playerHeightAtDefaultZoomPx)} at default zoom on this phone view.` });
  }
  if (blackSpacePercent > EXCESSIVE_BLACK_SPACE_PERCENT) {
    warnings.push({ code: "excessive_black_space", message: `${Math.round(blackSpacePercent)}% projected black or letterbox space at the current zoom.` });
  }
  const spawn = room.anchors.find((anchor) => anchor.id === room.spawnAnchorId && !anchor.retired);
  if (spawn) {
    const nearestBound = Math.min(spawn.x, spawn.y, room.width - spawn.x, room.height - spawn.y);
    if (nearestBound < STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius * 2) {
      warnings.push({ code: "spawn_near_bounds", message: `Spawn is only ${Math.round(nearestBound)} room units from a bound; allow at least two player radii (${STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius * 2}).` });
    }
  }
  const smallReach = room.objects.find((object) => object.available && !object.retired
    && object.type !== "decoration" && object.interactionRadius * baseScale * room.camera.defaultZoom < MIN_PROJECTED_INTERACTION_REACH_PX);
  if (smallReach) {
    warnings.push({ code: "interaction_reach_too_small", message: `${smallReach.name}'s interaction reach projects below ${MIN_PROJECTED_INTERACTION_REACH_PX}px at default zoom.` });
  }
  const roomEncounters = encounters.filter((encounter) => !encounter.retired && encounter.roomId === room.id);
  const standardRoomAreas = room.width * room.height / 1_000_000;
  const denseWave = roomEncounters.flatMap((encounter) => encounter.waves)
    .find((wave) => wave.mobSpawnIds.length / standardRoomAreas >= HIGH_WAVE_MOBS_PER_STANDARD_ROOM);
  if (denseWave) {
    warnings.push({ code: "high_wave_density", message: `${denseWave.mobSpawnIds.length} mobs share one wave at high density for this room; verify crowding in Walk Test.` });
  }
  const importantTypes = new Set(["portal", "door", "ladder", "chest", "valve", "switch", "shrine", "exit_ladder"]);
  const smallArt = room.objects.find((object) => {
    if (object.retired || !importantTypes.has(object.type)) return false;
    const prefab = prefabs.find((candidate) => candidate.id === object.prefabId && !candidate.retired);
    return prefab != null && Math.min(prefab.defaultWidth, prefab.defaultHeight)
      * baseScale * room.camera.defaultZoom < MIN_IMPORTANT_ART_EDGE_PX;
  });
  if (smallArt) {
    warnings.push({ code: "important_art_too_small", message: `${smallArt.name}'s shortest art edge projects below ${MIN_IMPORTANT_ART_EDGE_PX}px at default zoom.` });
  }

  return {
    preset,
    currentZoom,
    playerHeightAtDefaultZoomPx,
    playerHeightAtMinimumZoomPx,
    visibleRoomCoveragePercent,
    blackSpacePercent,
    warnings
  };
}

function formatPixels(value: number): string {
  return `${value.toFixed(1)}px`;
}

export type DungeonWizardInput = {
  name: string;
  themeId: string;
  backgroundColor: string;
  floorColor: string;
  wallColor: string;
  accentColor: string;
  instancePolicy: DungeonDefinition["instancePolicy"];
  resetPolicy: DungeonDefinition["reset"]["policy"];
  width: number;
  height: number;
};

export function safeDungeonId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "draft_dungeon";
}

export function runtimeDungeonAssetUrl(assetKey: string): string {
  return `/runtime-assets/${assetKey}`;
}

export type PrefabArtSpec = {
  href: string;
  width: number;
  height: number;
  opacity: number;
  rotationDeg: number;
  flipX: boolean;
  flipY: boolean;
  pivotX: number;
  pivotY: number;
};

export function prefabArtSpec(
  prefab: DungeonPrefabDefinition,
  transform?: Partial<Pick<PrefabArtSpec, "width" | "height" | "opacity" | "rotationDeg" | "flipX" | "flipY">>
): PrefabArtSpec {
  return {
    href: runtimeDungeonAssetUrl(prefab.assetKey),
    width: transform?.width ?? prefab.defaultWidth,
    height: transform?.height ?? prefab.defaultHeight,
    opacity: transform?.opacity ?? prefab.defaultOpacity,
    rotationDeg: transform?.rotationDeg ?? prefab.defaultRotationDeg,
    flipX: transform?.flipX ?? prefab.defaultFlipX,
    flipY: transform?.flipY ?? prefab.defaultFlipY,
    pivotX: prefab.pivotX,
    pivotY: prefab.pivotY
  };
}

export function createLayerPlacement(
  prefab: DungeonPrefabDefinition,
  id: string,
  point: IndoorPoint,
  room: DungeonRoomDefinition
): DungeonRoomDefinition["layers"][keyof DungeonRoomDefinition["layers"]][number] {
  const width = prefab.type === "surface" ? room.width : Math.min(prefab.defaultWidth, room.width);
  const height = prefab.type === "surface" ? room.height : Math.min(prefab.defaultHeight, room.height);
  return {
    id, retired: false, prefabId: prefab.id, prefabRevision: prefab.revision,
    x: prefab.type === "surface" ? 0 : clamp(point.x - width * prefab.pivotX, 0, room.width - width),
    y: prefab.type === "surface" ? 0 : clamp(point.y - height * prefab.pivotY, 0, room.height - height),
    width, height, rotationDeg: prefab.defaultRotationDeg, opacity: prefab.defaultOpacity,
    flipX: prefab.defaultFlipX, flipY: prefab.defaultFlipY, zIndex: 0
  };
}

export function createDungeonObject(
  prefab: DungeonPrefabDefinition,
  id: string,
  anchorId: string,
  name: string,
  portalId?: string
): DungeonObjectDefinition {
  const semanticType = portalId ? "portal" : semanticObjectType(prefab);
  return {
    id, retired: false, type: semanticType,
    prefabId: prefab.id, prefabRevision: prefab.revision, layerId: prefab.defaultLayerId,
    name, anchorId, available: true, initialState: semanticObjectInitialState(prefab, semanticType),
    interactionRadius: prefab.interactionRadius ?? 80,
    rotationDeg: prefab.defaultRotationDeg, opacity: prefab.defaultOpacity,
    flipX: prefab.defaultFlipX, flipY: prefab.defaultFlipY, zIndex: 0,
    ...(portalId ? { portalId, interactionLabel: name } : {})
  };
}

export function semanticObjectInitialState(
  prefab: Pick<DungeonPrefabDefinition, "id" | "name">,
  type = semanticObjectType(prefab)
): DungeonObjectDefinition["initialState"] {
  const value = `${prefab.id} ${prefab.name}`.toLowerCase();
  if (type === "portal" || type === "door" || type === "chest") return "closed";
  if (type === "switch") return /\bpressure[ _-]*plate\b/u.test(value) ? "released" : "off";
  return "idle";
}

export function semanticObjectType(prefab: Pick<DungeonPrefabDefinition, "id" | "name">): DungeonObjectDefinition["type"] {
  const value = `${prefab.id} ${prefab.name}`.toLowerCase();
  if (/\bchest\b/u.test(value)) return "chest";
  if (/\b(?:lever|switch|pressure[ _-]*plate)\b/u.test(value)) return "switch";
  if (/\b(?:exit[ _-]*)?ladder\b/u.test(value)) return "exit_ladder";
  if (/\bdoor\b/u.test(value)) return "door";
  return "decoration";
}

export type DungeonResourceZoneInput = Readonly<{
  id: string;
  shape: DungeonResourceSpawnZoneDefinition["shape"];
  resourceTypes: readonly DungeonResourceType[];
  minCount: number;
  maxCount: number;
  minimumSpacing: number;
  seed: number;
  respawnSeconds: number | null;
  resetOnRun: boolean;
  interactionRadius: number;
  prefabId?: string;
  minYield?: number;
  maxYield?: number;
}>;

export function createDungeonResourceSpawnZone(
  input: DungeonResourceZoneInput
): DungeonResourceSpawnZoneDefinition {
  const resourceTypes = input.resourceTypes.filter((resourceType) =>
    (DUNGEON_RESOURCE_TYPES as readonly string[]).includes(resourceType)
  );
  if (resourceTypes.length === 0) throw new Error("A resource spawn zone needs an eligible resource type.");
  const minCount = Math.max(0, Math.floor(input.minCount));
  const maxCount = Math.max(minCount, Math.floor(input.maxCount));
  const minYield = input.minYield === undefined ? undefined : Math.max(1, Math.floor(input.minYield));
  const maxYield = input.maxYield === undefined ? undefined : Math.max(minYield ?? 1, Math.floor(input.maxYield));
  return {
    id: input.id,
    retired: false,
    shape: structuredClone(input.shape),
    resourceTypes,
    minCount,
    maxCount,
    minimumSpacing: Math.max(0, input.minimumSpacing),
    seed: Math.max(0, Math.floor(input.seed)),
    ...(minYield === undefined ? {} : { minYield }),
    ...(maxYield === undefined ? {} : { maxYield }),
    respawnSeconds: input.respawnSeconds === null ? null : Math.max(0, input.respawnSeconds),
    resetOnRun: input.resetOnRun,
    interactionRadius: Math.max(1, input.interactionRadius),
    ...(input.prefabId ? { prefabId: input.prefabId } : {})
  };
}

export type DungeonResourceNodeInput = Readonly<{
  id: string;
  anchorId: string;
  resourceType: DungeonResourceType;
  minYield: number;
  maxYield: number;
  respawnSeconds: number | null;
  resetOnRun: boolean;
  interactionRadius: number;
  prefabId?: string;
  prefabRevision?: string;
}>;

export function createDungeonResourceNode(
  input: DungeonResourceNodeInput
): DungeonResourceNodeDefinition {
  if (!(DUNGEON_RESOURCE_TYPES as readonly string[]).includes(input.resourceType)) {
    throw new Error(`Resource type ${input.resourceType} is not eligible for dungeon harvesting.`);
  }
  const minYield = Math.max(1, Math.floor(input.minYield));
  return {
    id: input.id,
    retired: false,
    anchorId: input.anchorId,
    resourceType: input.resourceType,
    minYield,
    maxYield: Math.max(minYield, Math.floor(input.maxYield)),
    respawnSeconds: input.respawnSeconds === null ? null : Math.max(0, input.respawnSeconds),
    resetOnRun: input.resetOnRun,
    available: true,
    interactionRadius: Math.max(1, input.interactionRadius),
    ...(input.prefabId ? { prefabId: input.prefabId } : {}),
    ...(input.prefabRevision ? { prefabRevision: input.prefabRevision } : {})
  };
}

export function replaceDungeonPrefabArt(
  catalog: DungeonCatalog,
  prefabId: string,
  assetKey: string,
  nativeWidth: number,
  nativeHeight: number
): DungeonCatalog {
  const next = structuredClone(catalog) as DungeonCatalog;
  const prefab = next.prefabs.find((candidate) => candidate.id === prefabId && !candidate.retired);
  if (!prefab) throw new Error(`Unknown dungeon prefab ${prefabId}.`);
  const revision = `${prefab.revision}-art-${next.catalogRevision + 1}`;
  const widthScale = nativeWidth > 0 && prefab.nativeWidth > 0 ? nativeWidth / prefab.nativeWidth : 1;
  const heightScale = nativeHeight > 0 && prefab.nativeHeight > 0 ? nativeHeight / prefab.nativeHeight : 1;
  prefab.revision = revision;
  prefab.assetKey = assetKey;
  prefab.nativeWidth = Math.max(1, Math.floor(nativeWidth));
  prefab.nativeHeight = Math.max(1, Math.floor(nativeHeight));
  // Preserve authored collider IDs and state variants; when the art changes,
  // keep their normalized placement while giving the editor sizing assistance.
  prefab.defaultColliders = prefab.defaultColliders.map((collider) => ({
    ...collider,
    x: collider.x * widthScale,
    y: collider.y * heightScale,
    width: collider.width * widthScale,
    height: collider.height * heightScale
  }));
  for (const dungeon of next.dungeons) for (const room of dungeon.rooms) {
    for (const placement of Object.values(room.layers).flat()) {
      if (placement.prefabId === prefabId) placement.prefabRevision = revision;
    }
    for (const object of room.objects) {
      if (object.prefabId === prefabId) object.prefabRevision = revision;
    }
    for (const node of room.resourceNodes ?? []) {
      if (node.prefabId === prefabId) node.prefabRevision = revision;
    }
  }
  next.catalogRevision += 1;
  return next;
}

export function createDungeonRewardTable(
  catalog: DungeonCatalog,
  input: Readonly<{ id: string; gold?: number; items: readonly { itemId: string; quantity: number }[] }>
): DungeonCatalog {
  const next = structuredClone(catalog) as DungeonCatalog;
  if (next.rewardTables.some((table) => table.id === input.id && !table.retired)) {
    throw new Error(`Reward table ${input.id} already exists.`);
  }
  next.rewardTables.push({
    id: input.id,
    revision: "1",
    retired: false,
    ...(input.gold === undefined ? {} : { gold: Math.max(0, Math.floor(input.gold)) }),
    items: input.items.map((item) => ({ itemId: item.itemId, quantity: Math.max(1, Math.floor(item.quantity)) }))
  });
  next.rewardTableIds = [...new Set([...next.rewardTableIds, input.id])];
  next.catalogRevision += 1;
  return next;
}

export function updateDungeonRewardTable(
  catalog: DungeonCatalog,
  tableId: string,
  patch: Readonly<{ gold?: number; items?: readonly { itemId: string; quantity: number }[] }>
): DungeonCatalog {
  const next = structuredClone(catalog) as DungeonCatalog;
  const table = next.rewardTables.find((candidate) => candidate.id === tableId && !candidate.retired);
  if (!table) throw new Error(`Unknown reward table ${tableId}.`);
  table.revision = `${Number(table.revision) + 1}`;
  if (patch.gold !== undefined) table.gold = Math.max(0, Math.floor(patch.gold));
  if (patch.items !== undefined) table.items = patch.items.map((item) => ({
    itemId: item.itemId, quantity: Math.max(1, Math.floor(item.quantity))
  }));
  next.catalogRevision += 1;
  return next;
}

export function selectDungeonBossTemplate(
  catalog: DungeonCatalog,
  input: Readonly<{
    id: string;
    definition: BossDefinition;
    rewardPolicyId?: string;
  }>
): DungeonCatalog {
  const next = structuredClone(catalog) as DungeonCatalog;
  if (next.bossTemplates.some((template) => template.id === input.id && !template.retired)) {
    throw new Error(`Boss template ${input.id} already exists.`);
  }
  const template: DungeonBossTemplateDefinition = {
    id: input.id,
    revision: String(input.definition.revision),
    retired: false,
    bossDefinitionId: input.definition.id,
    controllerId: input.definition.controllerId,
    ...(input.definition.appearanceId ? { appearanceId: input.definition.appearanceId } : {}),
    rewardPolicyId: input.rewardPolicyId ?? input.definition.rewardPolicy.id,
    ...(input.definition.displayName ? { displayName: input.definition.displayName } : {})
  };
  next.bossTemplates.push(template);
  next.bossTemplateIds = [...new Set([...next.bossTemplateIds, template.id])];
  next.catalogRevision += 1;
  return next;
}

export function moveDungeonMobGroup(
  dungeon: DungeonDefinition,
  roomId: string,
  spawnGroupId: string,
  delta: IndoorPoint
): void {
  const room = dungeon.rooms.find((candidate) => candidate.id === roomId);
  if (!room) throw new Error(`Unknown dungeon room ${roomId}.`);
  const mobs = room.mobs.filter((mob) => !mob.retired && mob.spawnGroupId === spawnGroupId);
  const anchorIds = new Set(mobs.map((mob) => mob.anchorId));
  for (const anchor of room.anchors) {
    if (!anchor.retired && anchorIds.has(anchor.id)) {
      anchor.x = clamp(anchor.x + delta.x, 0, room.width);
      anchor.y = clamp(anchor.y + delta.y, 0, room.height);
    }
  }
}

export function setDungeonMobGroupControls(
  dungeon: DungeonDefinition,
  encounterId: string,
  controls: Readonly<{ formation: "scatter" | "line" | "wedge" | "circle"; linkedAggro: boolean }>
): void {
  const encounter = dungeon.encounters.find((candidate) => candidate.id === encounterId);
  if (!encounter) throw new Error(`Unknown dungeon encounter ${encounterId}.`);
  encounter.groupControls = { formation: controls.formation, linkedAggro: controls.linkedAggro };
}

/** Copy local room logic and independent reward tables without placing a world entrance. */
export function duplicateDungeon(catalog: DungeonCatalog, dungeonId: string): { catalog: DungeonCatalog; dungeonId: string } {
  const next = structuredClone(catalog);
  const source = next.dungeons.find((dungeon) => dungeon.id === dungeonId);
  if (!source) throw new Error("Choose a dungeon to duplicate.");
  const id = uniqueId(`${safeDungeonId(source.name).slice(0, 48).replace(/_+$/u, "")}_copy`, next.dungeons.map((dungeon) => dungeon.id));
  const rewardIds = new Map<string, string>();
  for (const tableId of source.rewardTableIds) {
    const table = next.rewardTables.find((candidate) => candidate.id === tableId);
    if (!table) continue;
    const copyId = uniqueId(`${id}_loot`, next.rewardTableIds);
    next.rewardTables.push({ ...structuredClone(table), id: copyId, revision: `${copyId}-v1`, retired: false });
    next.rewardTableIds.push(copyId);
    rewardIds.set(tableId, copyId);
  }
  const copy = JSON.parse(JSON.stringify(source, (_key, value: unknown) => typeof value === "string" ? rewardIds.get(value) ?? value : value)) as DungeonDefinition;
  copy.id = id;
  copy.name = `${source.name.slice(0, 73)} (Copy)`;
  copy.revision = `${id}-v1`;
  copy.retired = false;
  for (const portal of copy.portals) if (portal.source.kind === "world") portal.enabled = false;
  next.dungeons.push(copy);
  return { catalog: next, dungeonId: id };
}

export type DungeonRoomInput = Readonly<{
  name: string;
  width: number;
  height: number;
  /** Defaults to a safe ID derived from the name, made unique among the dungeon's rooms. */
  id?: string;
  /** Studio drafts start inactive until wired; scaffolded rooms are active. */
  active?: boolean;
}>;

/** Pure blank room: one spawn anchor at the center, no art. Callers push it into `dungeon.rooms`. */
export function createDungeonRoom(dungeon: Pick<DungeonDefinition, "rooms">, input: DungeonRoomInput): DungeonRoomDefinition {
  const id = input.id ?? uniqueId(safeDungeonId(input.name) || "draft_room", dungeon.rooms.map((value) => value.id));
  const { width, height } = input;
  return {
    id, retired: false, name: input.name.trim() || "New Room", active: input.active ?? false,
    width, height, spatialProfileId: "standard_indoor_v1",
    spawnAnchorId: "spawn",
    camera: { mode: "fixed_center", center: { x: width / 2, y: height / 2 }, fitPadding: 0, defaultZoom: 1, minZoom: 0.5, maxZoom: 1.6 },
    environment: { environmentId: `${id}_environment`, visualTreatmentId: null, musicAssetKey: null, ambienceAssetKey: null },
    layers: { background: [], below_player: [], actors: [], above_player: [], ceiling: [] },
    anchors: [{ id: "spawn", retired: false, x: width / 2, y: height / 2 }],
    colliders: [], zones: [], objects: [], mobs: []
  };
}

export function createDungeonFromWizard(
  catalog: DungeonCatalog,
  input: DungeonWizardInput
): DungeonDefinition {
  const portalPrefab = catalog.prefabs.find((prefab) => !prefab.retired && prefab.type === "portal");
  if (!portalPrefab) throw new Error("A portal prefab is required before creating a dungeon.");
  const floorPrefab = catalog.prefabs.find((prefab) => !prefab.retired && prefab.type === "surface");
  if (!floorPrefab) throw new Error("A surface prefab is required before creating a dungeon.");
  const baseId = safeDungeonId(input.name);
  const id = uniqueId(baseId, catalog.dungeons.map((dungeon) => dungeon.id));
  const roomId = `${id}_entrance`;
  const width = Math.max(320, Math.round(input.width));
  const height = Math.max(320, Math.round(input.height));
  const gate = { x: width / 2, y: Math.max(80, height - 100) };
  const entrancePortalId = `${id}_world_to_entrance`;
  const escapePortalId = `${id}_entrance_to_world`;
  const portalObjectId = `${id}_escape_portal_object`;
  const room: DungeonRoomDefinition = {
    id: roomId, retired: false, name: `${input.name.trim()} Entrance`, active: true,
    width, height, spatialProfileId: "standard_indoor_v1", spawnAnchorId: "spawn",
    camera: { mode: "fixed_center", center: { x: width / 2, y: height / 2 }, fitPadding: 0, defaultZoom: 1, minZoom: 0.5, maxZoom: 1.6 },
    environment: { environmentId: `${id}_${input.themeId}`, visualTreatmentId: null, musicAssetKey: null, ambienceAssetKey: null },
    layers: { background: [], below_player: [], actors: [], above_player: [], ceiling: [] },
    anchors: [
      { id: "spawn", retired: false, x: width / 2, y: height / 2 },
      { id: "entrance_escape", retired: false, ...gate, facing: -Math.PI / 2 },
      { id: "death_recovery", retired: false, x: width / 2, y: height / 2 + 40 }
    ],
    colliders: [], zones: [], mobs: [],
    objects: [createDungeonObject(portalPrefab, portalObjectId, "entrance_escape", "Return to world", escapePortalId)]
  };
  room.layers[floorPrefab.defaultLayerId].push({
    id: `${id}_initial_floor`, retired: false, prefabId: floorPrefab.id, prefabRevision: floorPrefab.revision,
    x: 0, y: 0, width, height, rotationDeg: floorPrefab.defaultRotationDeg,
    opacity: floorPrefab.defaultOpacity, flipX: floorPrefab.defaultFlipX,
    flipY: floorPrefab.defaultFlipY, zIndex: 0
  });
  return {
    id, revision: `${id}-v1`, retired: false, instancePolicy: input.instancePolicy,
    name: input.name.trim(), description: `A new ${input.themeId.replace(/_/gu, " ")} dungeon.`,
    spatialProfileId: "standard_indoor_v1",
    entrance: { roomId, arrivalAnchorId: "entrance_escape", portalId: entrancePortalId },
    escape: { portalId: escapePortalId },
    deathRecovery: { roomId, anchorId: "death_recovery" },
    reset: { policy: input.resetPolicy, revision: `${id}-v1`, despawnAfterSeconds: null, resetEnemies: true, resetLoot: true, resetDoors: true, resetBoss: true },
    environment: { environmentId: input.themeId, backgroundColor: input.backgroundColor, floorColor: input.floorColor, wallColor: input.wallColor, accentColor: input.accentColor, musicAssetKey: null, ambienceAssetKey: null },
    rooms: [room],
    portals: [
      { id: entrancePortalId, retired: false, source: { kind: "world" }, destination: { kind: "room", roomId, anchorId: "entrance_escape" }, destinationArrivalAnchorId: "entrance_escape", reciprocalPortalId: escapePortalId, conditions: ["always"], interactionLabel: `Draft — needs world entrance binding for ${input.name.trim()}`, presentation: "door", enabled: false },
      { id: escapePortalId, retired: false, source: { kind: "room", roomId, anchorId: "entrance_escape" }, destination: { kind: "world" }, sourceApproachAnchorId: "entrance_escape", sourceThresholdAnchorId: "entrance_escape", reciprocalPortalId: entrancePortalId, conditions: ["always"], interactionLabel: "Return to world", presentation: "door", enabled: true }
    ],
    encounters: [], triggers: [], rewardTableIds: [], bossTemplateIds: []
  };
}

export type OneRoomCombatReadiness = Readonly<{
  roomArtPlaced: boolean;
  encounterId: string | null;
  mobBackedEncounter: boolean;
  chestObjectId: string | null;
  chestStartsUnavailable: boolean;
  escapePortalId: string | null;
  roomEnterStartsEncounter: boolean;
  escapeLockedDuringEncounter: boolean;
  clearExposesChest: boolean;
  dungeonCompletionAction: boolean;
  walkTestReady: boolean;
  liveWorldBound: boolean;
  lootRewardConfigured: boolean;
  lootRuntimeReady: boolean;
  missingPrerequisites: readonly string[];
}>;

export function oneRoomCombatReadiness(
  dungeon: DungeonDefinition,
  room: DungeonRoomDefinition,
  catalog?: Pick<DungeonCatalog, "entrances" | "rewardTables">
): OneRoomCombatReadiness {
  const roomArtPlaced = Object.values(room.layers).some((placements) =>
    placements.some((placement) => !placement.retired));
  const encounter = firstMobBackedEncounter(dungeon, room);
  const chest = room.objects.find((object) => !object.retired && object.type === "chest");
  const escape = roomWorldEscapePortal(dungeon, room);
  const roomEnterStartsEncounter = Boolean(encounter && dungeon.triggers.some((trigger) =>
    !trigger.retired && trigger.enabled && trigger.event.type === "room_enter" && trigger.event.roomId === room.id
    && trigger.actions.some((action) => action.type === "start_encounter" && action.encounterId === encounter.id)));
  const completionTriggers = encounter ? dungeon.triggers.filter((trigger) =>
    !trigger.retired && trigger.enabled
    && ((trigger.event.type === "encounter_state" && trigger.event.encounterId === encounter.id && trigger.event.state === "completed")
      || (trigger.event.type === "room_clear" && trigger.event.roomId === room.id))) : [];
  const clearExposesChest = Boolean(chest && completionTriggers.some((trigger) =>
    trigger.actions.some((action) => action.type === "set_object_available"
      && action.roomId === room.id && action.objectId === chest.id && action.available)));
  const dungeonCompletionAction = completionTriggers.some((trigger) =>
    trigger.actions.some((action) => action.type === "complete_dungeon"));
  const liveWorldBound = dungeonHasLiveWorldEntrance(catalog, dungeon);
  const configuredRewardTableIds = new Set(dungeon.triggers.flatMap((trigger) =>
    trigger.retired || !trigger.enabled ? [] : trigger.actions
      .flatMap((action) => action.type === "grant_reward" ? [action.rewardTableId] : [])));
  const lootRewardConfigured = configuredRewardTableIds.size > 0;
  const lootRuntimeReady = lootRewardConfigured && [...configuredRewardTableIds].every((rewardTableId) =>
    catalog?.rewardTables?.some((rewardTable) => !rewardTable.retired && rewardTable.id === rewardTableId));
  const missingPrerequisites = [
    ...(roomArtPlaced ? [] : ["Place floor or room art"]),
    ...(encounter ? [] : ["Place one or more mobs"]),
    ...(chest ? [] : ["Place a Treasure Chest"]),
    ...(escape ? [] : ["Add an enabled room-to-world exit portal"])
  ];
  const chestStartsUnavailable = Boolean(chest && !chest.available && chest.initialState === "closed");
  const escapeLockedDuringEncounter = Boolean(encounter && escape && encounter.lockPortalIds.includes(escape.id));
  return {
    roomArtPlaced,
    encounterId: encounter?.id ?? null,
    mobBackedEncounter: Boolean(encounter),
    chestObjectId: chest?.id ?? null,
    chestStartsUnavailable,
    escapePortalId: escape?.id ?? null,
    roomEnterStartsEncounter,
    escapeLockedDuringEncounter,
    clearExposesChest,
    dungeonCompletionAction,
    walkTestReady: Boolean(roomArtPlaced && encounter && chest && escape && chestStartsUnavailable
      && roomEnterStartsEncounter && escapeLockedDuringEncounter && clearExposesChest && dungeonCompletionAction),
    liveWorldBound,
    lootRewardConfigured,
    lootRuntimeReady,
    missingPrerequisites
  };
}

export function dungeonHasLiveWorldEntrance(
  catalog: Pick<DungeonCatalog, "entrances"> | undefined,
  dungeon: DungeonDefinition
): boolean {
  const entrancePortal = dungeon.portals.find((portal) => !portal.retired && portal.id === dungeon.entrance.portalId);
  return Boolean(entrancePortal?.enabled && entrancePortal.source.kind === "world"
    && entrancePortal.destination.kind === "room" && entrancePortal.destination.roomId === dungeon.entrance.roomId
    && catalog?.entrances?.some((binding) => !binding.retired && binding.dungeonId === dungeon.id
      && binding.portalId === dungeon.entrance.portalId));
}

export function saveDungeonWorldEntrance(
  catalog: DungeonCatalog,
  dungeonId: string,
  input: DungeonEntranceInput
): void {
  const dungeon = catalog.dungeons.find((candidate) => candidate.id === dungeonId);
  if (!dungeon) return;
  const portal = dungeon.portals.find((candidate) => !candidate.retired && candidate.id === dungeon.entrance.portalId
    && candidate.source.kind === "world" && candidate.destination.kind === "room");
  if (!portal) return;
  const existing = catalog.entrances.find((candidate) => candidate.dungeonId === dungeon.id && !candidate.retired)
    ?? catalog.entrances.find((candidate) => candidate.dungeonId === dungeon.id);
  for (const candidate of catalog.entrances) {
    if (candidate.dungeonId === dungeon.id && candidate !== existing) candidate.retired = true;
  }
  const id = existing?.id ?? uniqueId(`${dungeon.id}_world_entrance`, catalog.entrances.map((candidate) => candidate.id));
  const revision = existing ? bumpEntranceRevision(existing.revision) : `${id}-v1`;
  const portalRevision = existing ? bumpEntranceRevision(existing.portalRevision) : `${portal.id}-v1`;
  const value = {
    id, dungeonId: dungeon.id, revision, retired: false,
    name: input.name.trim(), description: input.description.trim(), lat: input.lat, lon: input.lon,
    interactionRadiusM: 95, footprintRadiusM: 35,
    portalId: portal.id, portalRevision, interactionLabel: `Enter ${dungeon.name}`,
    presentation: "cave" as const, assetKey: input.assetKey,
    preloadSceneKey: `${dungeon.id}/${dungeon.entrance.roomId}`
  };
  if (existing) Object.assign(existing, value);
  else catalog.entrances.push(value);
  portal.enabled = true;
  portal.interactionLabel = `Enter ${dungeon.name}`;
}

export function disconnectDungeonWorldEntrance(catalog: DungeonCatalog, dungeonId: string): void {
  const dungeon = catalog.dungeons.find((candidate) => candidate.id === dungeonId);
  if (!dungeon) return;
  for (const entrance of catalog.entrances) {
    if (entrance.dungeonId !== dungeon.id || entrance.retired) continue;
    entrance.revision = bumpEntranceRevision(entrance.revision);
    entrance.portalRevision = bumpEntranceRevision(entrance.portalRevision);
    entrance.retired = true;
  }
  const portal = dungeon.portals.find((candidate) => candidate.id === dungeon.entrance.portalId && candidate.source.kind === "world");
  if (portal) {
    portal.enabled = false;
    portal.interactionLabel = `Draft — needs world entrance binding for ${dungeon.name}`;
  }
}

function bumpEntranceRevision(revision: string): string {
  const match = /^(.*)-v(\d+)$/u.exec(revision);
  return match ? `${match[1]}-v${Number(match[2]) + 1}` : `${revision}-v2`;
}

export function wireOneRoomCombatFlow(
  dungeon: DungeonDefinition,
  room: DungeonRoomDefinition
): boolean {
  const encounter = firstMobBackedEncounter(dungeon, room);
  const chest = room.objects.find((object) => !object.retired && object.type === "chest");
  const escape = roomWorldEscapePortal(dungeon, room);
  if (!encounter || !chest || !escape) return false;

  chest.available = false;
  chest.initialState = "closed";
  encounter.lockPortalIds = [...new Set([...encounter.lockPortalIds, escape.id])];

  const startId = oneRoomGeneratedTriggerId(room.id, encounter.id, "start");
  const completeId = oneRoomGeneratedTriggerId(room.id, encounter.id, "complete");
  const rewardId = oneRoomGeneratedTriggerId(room.id, encounter.id, "reward");
  const generatedIds = new Set([startId, completeId, rewardId]);
  const authoredTriggers = dungeon.triggers.filter((trigger) => !generatedIds.has(trigger.id));
  const existingChestReward = authoredTriggers.some((trigger) => !trigger.retired && trigger.enabled &&
    trigger.event.type === "object_interact" && trigger.event.roomId === room.id && trigger.event.objectId === chest.id &&
    trigger.actions.some((action) => action.type === "grant_reward" && action.rewardTableId === (chest.rewardTableId ?? ONE_ROOM_CHEST_REWARD_TABLE_ID)));
  dungeon.rewardTableIds = [...new Set([...dungeon.rewardTableIds, chest.rewardTableId ?? ONE_ROOM_CHEST_REWARD_TABLE_ID])];
  dungeon.triggers = [
    ...authoredTriggers,
    {
      id: startId,
      retired: false,
      enabled: true,
      scope: "instance",
      repetition: "once",
      cooldownMs: 0,
      event: { type: "room_enter", roomId: room.id },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "start_encounter", encounterId: encounter.id }]
    },
    {
      id: completeId,
      retired: false,
      enabled: true,
      scope: "instance",
      repetition: "once",
      cooldownMs: 0,
      event: { type: "room_clear", roomId: room.id },
      conditions: { mode: "all", items: [] },
      actions: [
        { type: "set_object_available", roomId: room.id, objectId: chest.id, available: true },
        { type: "complete_dungeon" }
      ]
    },
    {
      id: rewardId,
      retired: existingChestReward,
      enabled: !existingChestReward,
      scope: "player",
      repetition: "once",
      cooldownMs: 0,
      event: { type: "object_interact", roomId: room.id, objectId: chest.id },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "grant_reward", rewardTableId: chest.rewardTableId ?? ONE_ROOM_CHEST_REWARD_TABLE_ID }]
    }
  ];
  return true;
}

function firstMobBackedEncounter(
  dungeon: DungeonDefinition,
  room: DungeonRoomDefinition
): DungeonDefinition["encounters"][number] | undefined {
  const activeMobIds = new Set(room.mobs.filter((mob) => !mob.retired).map((mob) => mob.id));
  return dungeon.encounters.find((encounter) => !encounter.retired && encounter.roomId === room.id
    && encounter.waves.some((wave) => wave.mobSpawnIds.some((mobId) => activeMobIds.has(mobId))));
}

function roomWorldEscapePortal(
  dungeon: DungeonDefinition,
  room: DungeonRoomDefinition
): DungeonDefinition["portals"][number] | undefined {
  const candidates = dungeon.portals.filter((portal) => !portal.retired && portal.enabled
    && portal.source.kind === "room" && portal.source.roomId === room.id && portal.destination.kind === "world");
  return candidates.find((portal) => portal.id === dungeon.escape.portalId) ?? candidates[0];
}

function oneRoomGeneratedTriggerId(roomId: string, encounterId: string, purpose: "start" | "complete" | "reward"): string {
  return `one_room_${roomId}_${encounterId}_${purpose}`;
}

export function createMobPlacement(
  archetype: MobArchetypeKey,
  id: string,
  anchorId: string,
  encounterId: string,
  leashZoneId: string
): DungeonMobPlacementDefinition {
  return { id, retired: false, archetype, anchorId, facing: Math.PI, encounterId, spawnGroupId: `${encounterId}_group`, waveIndex: 1, leashZoneId, visualScale: 1 };
}

export function assignMobToEncounterWave(
  dungeon: DungeonDefinition,
  roomId: string,
  mobId: string,
  encounterId: string,
  waveIndex: number
): void {
  const room = dungeon.rooms.find((value) => value.id === roomId);
  const mob = room?.mobs.find((value) => value.id === mobId && !value.retired);
  const encounter = dungeon.encounters.find((value) => value.id === encounterId && !value.retired && value.roomId === roomId);
  const targetWave = encounter?.waves[waveIndex - 1];
  if (!mob || !encounter || !targetWave) return;
  for (const candidate of dungeon.encounters) {
    for (const wave of candidate.waves) wave.mobSpawnIds = wave.mobSpawnIds.filter((value) => value !== mobId);
  }
  mob.encounterId = encounter.id;
  mob.waveIndex = waveIndex;
  if (!targetWave.mobSpawnIds.includes(mobId)) targetWave.mobSpawnIds.push(mobId);
}

export function removeEncounterWave(dungeon: DungeonDefinition, encounterId: string, waveIndex: number): void {
  const encounter = dungeon.encounters.find((value) => value.id === encounterId && !value.retired);
  if (!encounter || encounter.waves.length <= 1 || !encounter.waves[waveIndex - 1]) return;
  const destinationIndex = waveIndex === 1 ? 2 : waveIndex - 1;
  const movingMobIds = [...encounter.waves[waveIndex - 1]!.mobSpawnIds];
  encounter.waves.splice(waveIndex - 1, 1);
  const destinationAfterRemoval = waveIndex === 1 ? 1 : destinationIndex;
  for (const mobId of movingMobIds) assignMobToEncounterWave(dungeon, encounter.roomId, mobId, encounter.id, destinationAfterRemoval);
  encounter.waves.forEach((wave, index) => {
    for (const mobId of wave.mobSpawnIds) {
      const mob = dungeon.rooms.find((value) => value.id === encounter.roomId)?.mobs.find((value) => value.id === mobId);
      if (mob) { mob.encounterId = encounter.id; mob.waveIndex = index + 1; }
    }
  });
}

export function defaultTriggerEvent(type: DungeonTriggerDefinition["event"]["type"], dungeon: DungeonDefinition, room: DungeonRoomDefinition): DungeonTriggerDefinition["event"] {
  const zoneId = room.zones.find((zone) => !zone.retired)?.id ?? "missing_zone";
  const objectId = room.objects.find((object) => !object.retired)?.id ?? "missing_object";
  const portalId = dungeon.portals.find((portal) => !portal.retired)?.id ?? "missing_portal";
  const encounterId = dungeon.encounters.find((encounter) => !encounter.retired)?.id ?? "missing_encounter";
  switch (type) {
    case "room_enter": case "room_exit": case "room_clear": return { type, roomId: room.id };
    case "zone_enter": case "zone_exit": case "all_players_present": return { type, roomId: room.id, zoneId };
    case "object_interact": case "object_destroyed": return { type, roomId: room.id, objectId };
    case "object_state": return { type, roomId: room.id, objectId, state: "on" };
    case "object_sequence": return { type, roomId: room.id, objectIds: [objectId] };
    case "portal_used": return { type, portalId };
    case "timer": return { type, delayMs: 1000 };
    case "encounter_state": return { type, encounterId, state: "completed" };
    case "player_count": return { type, operator: "at_least", count: 1 };
    case "dungeon_flag": return { type, flagId: "flag", value: true };
  }
}

export function defaultTriggerAction(type: DungeonTriggerDefinition["actions"][number]["type"], dungeon: DungeonDefinition, room: DungeonRoomDefinition): DungeonTriggerDefinition["actions"][number] {
  const encounterId = dungeon.encounters.find((encounter) => !encounter.retired)?.id ?? "missing_encounter";
  const objectId = room.objects.find((object) => !object.retired)?.id ?? "missing_object";
  const portalId = dungeon.portals.find((portal) => !portal.retired)?.id ?? "missing_portal";
  const triggerId = dungeon.triggers.find((trigger) => !trigger.retired)?.id ?? "missing_trigger";
  switch (type) {
    case "start_encounter": return { type, encounterId };
    case "start_wave": return { type, encounterId, waveId: dungeon.encounters.find((value) => value.id === encounterId)?.waves[0]?.id ?? "wave_1" };
    case "set_object_state": return { type, roomId: room.id, objectId, state: "on" };
    case "set_object_available": return { type, roomId: room.id, objectId, available: true };
    case "set_portal_locked": return { type, portalId, locked: true };
    case "enable_trigger": return { type, triggerId, enabled: true };
    case "play_cue": return { type, cueId: "dungeon_cue" };
    case "show_message": return { type, text: "Something stirs.", tone: "info" };
    case "set_dungeon_flag": return { type, flagId: "flag", value: true };
    case "grant_reward": return { type, rewardTableId: dungeon.rewardTableIds[0] ?? "missing_reward" };
    case "grant_run_reward": return { type, rewardTableId: dungeon.rewardTableIds[0] ?? "missing_reward", recipients: "present" };
    case "complete_dungeon": return { type };
  }
}

function uniqueId(prefix: string, ids: readonly string[]): string {
  if (!ids.includes(prefix)) return prefix;
  let index = 2;
  while (ids.includes(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
