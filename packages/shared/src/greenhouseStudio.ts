import { INTERIOR_DATA } from "./data/interiors/index.js";
import type { InteriorCatalog, InteriorRoom, InteriorSpace } from "./interior/interiorCatalog.js";
import { greenhouseRoomOf, greenhouseSpaceOf, greenhouseStudioInputFromCatalog } from "./interior/greenhouseView.js";
import {
  manorPolygonContainsPolygon,
  manorPolygonGeometryIssues,
  manorPolygonIntersectsPolygon,
  manorPointInPolygon
} from "./manorTemplateCatalog.js";

export type GreenhouseStudioAnchor = Readonly<{
  anchorId: string;
  roomId: string;
  row: number;
  column: number;
  x: number;
  y: number;
}>;

export const GREENHOUSE_WATER_STORAGE_ANCHOR_ID = "greenhouse-water-storage:greenhouse_main_room";
export const GREENHOUSE_WATER_STORAGE_ART_ID = "greenhouse-water-storage-art:greenhouse_main_room";
export const GREENHOUSE_WATER_STORAGE_ASSET_PATH = "apps/client/src/assets/structures/greenhouse-water-tank.png";
export const GREENHOUSE_POT_ASSET_PATH = "apps/client/src/assets/structures/greenhouse-pot.png";
export const GREENHOUSE_DOOR_ASSET_PATH = "apps/client/src/assets/structures/greenhouse-door.png";
export const GREENHOUSE_PLANTER_CAPACITY = 15;
export const GREENHOUSE_STAGE_ART_ASSET_PATHS = Object.freeze([
  "apps/client/src/assets/plants/wheat-seedling.png",
  "apps/client/src/assets/plants/wheat-middle-2.png",
  "apps/client/src/assets/plants/wheat-middle-3.png",
  "apps/client/src/assets/plants/wheat-full.png"
] as const);
export const GREENHOUSE_GIVING_BERRY_STAGE_ART_ASSET_PATHS = Object.freeze([
  "apps/client/src/assets/plants/giving-berry-tree-seedling.png",
  "apps/client/src/assets/plants/giving-berry-tree-middle-2.png",
  "apps/client/src/assets/plants/giving-berry-tree-fruiting.png",
  "apps/client/src/assets/plants/giving-berry-tree-mature.png"
] as const);
export const GREENHOUSE_ALL_STAGE_ART_ASSET_PATHS = Object.freeze([
  ...GREENHOUSE_STAGE_ART_ASSET_PATHS,
  ...GREENHOUSE_GIVING_BERRY_STAGE_ART_ASSET_PATHS
] as const);
export const GREENHOUSE_OVERLAY_ASSET_PATHS = Object.freeze([
  "apps/client/src/assets/structures/greenhouse-overlays/overlay-01.png",
  "apps/client/src/assets/structures/greenhouse-overlays/overlay-02.png",
  "apps/client/src/assets/structures/greenhouse-overlays/overlay-03.png",
  "apps/client/src/assets/structures/greenhouse-overlays/overlay-04.png"
] as const);

export type GreenhouseStudioWaterStorageAnchor = Readonly<{
  anchorId: string;
  roomId: string;
  x: number;
  y: number;
}>;

export type GreenhouseStudioWaterStorageArt = Readonly<{
  overlayId: string;
  assetPath: typeof GREENHOUSE_WATER_STORAGE_ASSET_PATH;
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDeg: number;
  scaleX: number;
  scaleY: number;
  zIndex: number;
}>;

export type GreenhouseStudioOverlay = Readonly<{
  overlayId: string;
  assetPath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDeg: number;
  scaleX: number;
  scaleY: number;
  zIndex: number;
}>;

/** Studio-authored room geometry.  The same point and polygon rules used by
 * Manor are intentionally reused here so preview and server validation agree. */
export type GreenhouseStudioPoint = Readonly<{ x: number; y: number }>;
export type GreenhouseStudioSurfaceKind = "floor" | "back_wall" | "left_wall" | "right_wall";
export type GreenhouseStudioSurface = Readonly<{
  surfaceId: string;
  kind: GreenhouseStudioSurfaceKind;
  points: readonly GreenhouseStudioPoint[];
}>;
export type GreenhouseStudioCollider = Readonly<{
  colliderId: string;
  points: readonly GreenhouseStudioPoint[];
}>;
export type GreenhouseStudioTouchArea =
  | Readonly<{ kind: "circle"; radius: number }>
  | Readonly<{ kind: "polygon"; points: readonly GreenhouseStudioPoint[] }>;
export type GreenhouseStudioPlantStage = 1 | 2 | 3 | 4;
export type GreenhouseStudioPlantStageArt = Readonly<{
  cropId: string;
  stage: GreenhouseStudioPlantStage;
  artId: string;
  assetPath: typeof GREENHOUSE_ALL_STAGE_ART_ASSET_PATHS[number];
  /** Normalized image-local point placed at the authored offset from the plot anchor. */
  pivotX: number;
  pivotY: number;
  /** Room-coordinate offset from the Farm Plot placement anchor. */
  offsetX: number;
  offsetY: number;
  /** Uniform fraction of the Farm Plot render frame used by this stage image. */
  scale: number;
}>;
export type GreenhouseStudioPlacementTemplate = Readonly<{
  templateId: "pot" | "water_tank";
  assetPath: string;
  renderWidth: number;
  renderHeight: number;
  /** Normalized image-local point that is placed at the room anchor. */
  pivotX: number;
  pivotY: number;
  physicalFootprint: readonly GreenhouseStudioPoint[];
  touchArea: GreenhouseStudioTouchArea;
}>;
export type GreenhouseStudioExit = Readonly<{
  anchorId: string;
  touchArea: GreenhouseStudioTouchArea;
  assetPath: string;
  x: number;
  y: number;
  renderWidth: number;
  renderHeight: number;
  pivotX: number;
  pivotY: number;
}>;
export type GreenhouseStudioGeometry = Readonly<{
  surfaces: readonly GreenhouseStudioSurface[];
  colliders: readonly GreenhouseStudioCollider[];
  exit: GreenhouseStudioExit;
  templates: Readonly<{
    pot: GreenhouseStudioPlacementTemplate;
    waterTank: GreenhouseStudioPlacementTemplate;
  }>;
  stageArt: readonly GreenhouseStudioPlantStageArt[];
}>;

export type GreenhouseStudioCatalog = Readonly<{
  schemaVersion: 4;
  catalogRevision: number;
  roomId: string;
  roomWidth: number;
  roomHeight: number;
  planterCapacity: number;
  /** Legacy projections are retained in memory so old runtime consumers can reconcile v1-v3 rows. */
  anchors: readonly GreenhouseStudioAnchor[];
  waterStorage: GreenhouseStudioWaterStorageAnchor;
  waterStorageArt: GreenhouseStudioWaterStorageArt;
  overlays: readonly GreenhouseStudioOverlay[];
  geometry: GreenhouseStudioGeometry;
}>;

const DEFAULT_WATER_STORAGE_X = 1_020;
const DEFAULT_WATER_STORAGE_Y = 720;
const DEFAULT_WATER_STORAGE_ART_X = 940;
const DEFAULT_WATER_STORAGE_ART_Y = 640;
const DEFAULT_WATER_STORAGE_ART_WIDTH = 160;
const DEFAULT_WATER_STORAGE_ART_HEIGHT = 160;

function defaultStageArt(): GreenhouseStudioPlantStageArt[] {
  return [
    { cropId: "wheat", stage: 1, artId: "wheat_seedling", assetPath: GREENHOUSE_STAGE_ART_ASSET_PATHS[0], pivotX: 0.5, pivotY: 0.5, offsetX: 0, offsetY: 0, scale: 0.68 },
    { cropId: "wheat", stage: 2, artId: "wheat_middle_2", assetPath: GREENHOUSE_STAGE_ART_ASSET_PATHS[1], pivotX: 0.5, pivotY: 0.5, offsetX: 0, offsetY: 0, scale: 0.68 },
    { cropId: "wheat", stage: 3, artId: "wheat_middle_3", assetPath: GREENHOUSE_STAGE_ART_ASSET_PATHS[2], pivotX: 0.5, pivotY: 0.5, offsetX: 0, offsetY: 0, scale: 0.68 },
    { cropId: "wheat", stage: 4, artId: "wheat_full", assetPath: GREENHOUSE_STAGE_ART_ASSET_PATHS[3], pivotX: 0.5, pivotY: 0.5, offsetX: 0, offsetY: 0, scale: 0.68 }
  ];
}

function defaultGivingBerryStageArt(): GreenhouseStudioPlantStageArt[] {
  return GREENHOUSE_GIVING_BERRY_STAGE_ART_ASSET_PATHS.map((assetPath, index) => ({
    cropId: "giving_berry_tree",
    stage: (index + 1) as GreenhouseStudioPlantStage,
    artId: ["giving_berry_tree_seedling", "giving_berry_tree_middle_2", "giving_berry_tree_fruiting", "giving_berry_tree_mature"][index]!,
    assetPath,
    pivotX: 0.5,
    pivotY: index === 3 ? 0.88 : 0.7,
    offsetX: 0,
    offsetY: 0,
    scale: index === 3 ? 0.9 : 0.8
  }));
}

const defaultGeometry = (roomWidth: number, roomHeight: number): GreenhouseStudioGeometry => ({
  surfaces: [{
    surfaceId: "greenhouse-floor-surface:greenhouse_main_room",
    kind: "floor",
    points: [{ x: 0, y: 0 }, { x: roomWidth, y: 0 }, { x: roomWidth, y: roomHeight }, { x: 0, y: roomHeight }]
  }],
  colliders: [],
  exit: {
    anchorId: "greenhouse-exit:greenhouse_main_room",
    assetPath: GREENHOUSE_DOOR_ASSET_PATH,
    x: roomWidth / 2,
    y: roomHeight - 96,
    renderWidth: 144,
    renderHeight: 144,
    pivotX: 0.5,
    pivotY: 0.5,
    touchArea: { kind: "polygon", points: [
      { x: Math.max(0, roomWidth / 2 - 72), y: Math.max(0, roomHeight - 96) },
      { x: Math.min(roomWidth, roomWidth / 2 + 72), y: Math.max(0, roomHeight - 96) },
      { x: Math.min(roomWidth, roomWidth / 2 + 72), y: roomHeight },
      { x: Math.max(0, roomWidth / 2 - 72), y: roomHeight }
    ] }
  },
  templates: {
    pot: {
      templateId: "pot",
      assetPath: GREENHOUSE_POT_ASSET_PATH,
      renderWidth: 96,
      renderHeight: 72,
      pivotX: 0.5,
      pivotY: 0.5,
      physicalFootprint: [{ x: -28, y: -20 }, { x: 28, y: -20 }, { x: 28, y: 20 }, { x: -28, y: 20 }],
      touchArea: { kind: "circle", radius: 90 }
    },
    waterTank: {
      templateId: "water_tank",
      assetPath: GREENHOUSE_WATER_STORAGE_ASSET_PATH,
      renderWidth: 160,
      renderHeight: 160,
      pivotX: 0.5,
      pivotY: 0.5,
      physicalFootprint: [{ x: -60, y: -45 }, { x: 60, y: -45 }, { x: 60, y: 45 }, { x: -60, y: 45 }],
      touchArea: { kind: "circle", radius: 90 }
    }
  },
  stageArt: defaultStageArt()
});

const INTERIOR_CATALOG_DATA = INTERIOR_DATA as unknown as InteriorCatalog;
/** The unified interior space the Greenhouse is authored in (packages/shared/src/data/interiors/greenhouse.json). */
export const GREENHOUSE_INTERIOR_SPACE: InteriorSpace = greenhouseSpaceOf(INTERIOR_CATALOG_DATA);
export const GREENHOUSE_INTERIOR_ROOM: InteriorRoom = greenhouseRoomOf(GREENHOUSE_INTERIOR_SPACE);
/** Read-only view over {@link GREENHOUSE_INTERIOR_SPACE} in the legacy Studio catalog shape. */
export const GREENHOUSE_STUDIO_CATALOG = parseGreenhouseStudioCatalog(greenhouseStudioInputFromCatalog(INTERIOR_CATALOG_DATA));

function defaultCompatibilityAnchors(roomId: string, roomWidth: number, roomHeight: number): GreenhouseStudioAnchor[] {
  const anchors: GreenhouseStudioAnchor[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      anchors.push({
        anchorId: `greenhouse-main-anchor:${roomId}:${row}:${column}`,
        roomId,
        row,
        column,
        x: roomWidth * ((column + 1) / 6),
        y: roomHeight * ((row + 1) / 4)
      });
    }
  }
  return anchors;
}

export function parseGreenhouseStudioCatalog(value: unknown): GreenhouseStudioCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Greenhouse Studio catalog must be an object");
  }
  const raw = value as Record<string, unknown>;
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3 && raw.schemaVersion !== 4) || !Number.isInteger(raw.catalogRevision) || (raw.catalogRevision as number) < 0) {
    throw new Error("Greenhouse Studio catalog schema or revision is invalid");
  }
  if (typeof raw.roomId !== "string" || raw.roomId.trim() === "" ||
      typeof raw.roomWidth !== "number" || !Number.isFinite(raw.roomWidth) || raw.roomWidth <= 0 ||
      typeof raw.roomHeight !== "number" || !Number.isFinite(raw.roomHeight) || raw.roomHeight <= 0) {
    throw new Error("Greenhouse Studio room layout is invalid");
  }
  const rawAnchors = Array.isArray(raw.anchors) ? raw.anchors : defaultCompatibilityAnchors(raw.roomId as string, raw.roomWidth as number, raw.roomHeight as number);
  if (rawAnchors.length !== GREENHOUSE_PLANTER_CAPACITY) {
    throw new Error("Greenhouse Studio anchor layout is invalid");
  }
  const anchors = rawAnchors.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Greenhouse Studio anchor ${index + 1} is invalid`);
    }
    const anchor = candidate as Record<string, unknown>;
    if (typeof anchor.anchorId !== "string" || anchor.anchorId.trim() === "" ||
        typeof anchor.roomId !== "string" || anchor.roomId !== raw.roomId ||
        !Number.isInteger(anchor.row) || (anchor.row as number) < 0 ||
        !Number.isInteger(anchor.column) || (anchor.column as number) < 0 ||
        typeof anchor.x !== "number" || !Number.isFinite(anchor.x) || anchor.x < 0 || anchor.x > (raw.roomWidth as number) ||
        typeof anchor.y !== "number" || !Number.isFinite(anchor.y) || anchor.y < 0 || anchor.y > (raw.roomHeight as number)) {
      throw new Error(`Greenhouse Studio anchor ${index + 1} is invalid`);
    }
    if (anchor.anchorId !== `greenhouse-main-anchor:${raw.roomId}:${anchor.row}:${anchor.column}`) {
      throw new Error(`Greenhouse Studio anchor ${index + 1} has an unstable ID`);
    }
    return {
      anchorId: anchor.anchorId,
      roomId: anchor.roomId,
      row: anchor.row as number,
      column: anchor.column as number,
      x: anchor.x as number,
      y: anchor.y as number
    } satisfies GreenhouseStudioAnchor;
  });
  const ids = new Set(anchors.map((anchor) => anchor.anchorId));
  if (ids.size !== anchors.length) throw new Error("Greenhouse Studio anchor IDs must be unique");
  const coordinates = new Set(anchors.map((anchor) => `${anchor.roomId}:${anchor.row}:${anchor.column}`));
  if (coordinates.size !== anchors.length) throw new Error("Greenhouse Studio anchor grid locations must be unique");
  const waterStorageCandidate = raw.schemaVersion === 2 || raw.schemaVersion === 3 || raw.schemaVersion === 4 ? raw.waterStorage : null;
  const waterStorage = waterStorageCandidate && typeof waterStorageCandidate === "object" && !Array.isArray(waterStorageCandidate)
    ? waterStorageCandidate as Record<string, unknown>
    : {
        anchorId: GREENHOUSE_WATER_STORAGE_ANCHOR_ID,
        roomId: raw.roomId,
        x: DEFAULT_WATER_STORAGE_X,
        y: DEFAULT_WATER_STORAGE_Y
      };
  if (typeof waterStorage.anchorId !== "string" || waterStorage.anchorId !== GREENHOUSE_WATER_STORAGE_ANCHOR_ID ||
      typeof waterStorage.roomId !== "string" || waterStorage.roomId !== raw.roomId ||
      typeof waterStorage.x !== "number" || !Number.isFinite(waterStorage.x) || waterStorage.x < 0 || waterStorage.x > (raw.roomWidth as number) ||
      typeof waterStorage.y !== "number" || !Number.isFinite(waterStorage.y) || waterStorage.y < 0 || waterStorage.y > (raw.roomHeight as number)) {
    throw new Error("Greenhouse Studio water-storage anchor is invalid");
  }
  const waterStorageArtCandidate = raw.schemaVersion === 2 || raw.schemaVersion === 3 || raw.schemaVersion === 4 ? raw.waterStorageArt : null;
  const waterStorageArt = waterStorageArtCandidate && typeof waterStorageArtCandidate === "object" && !Array.isArray(waterStorageArtCandidate)
    ? waterStorageArtCandidate as Record<string, unknown>
    : {
        overlayId: GREENHOUSE_WATER_STORAGE_ART_ID,
        assetPath: GREENHOUSE_WATER_STORAGE_ASSET_PATH,
        x: DEFAULT_WATER_STORAGE_ART_X,
        y: DEFAULT_WATER_STORAGE_ART_Y,
        width: DEFAULT_WATER_STORAGE_ART_WIDTH,
        height: DEFAULT_WATER_STORAGE_ART_HEIGHT,
        rotationDeg: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 10
      };
  if (typeof waterStorageArt.overlayId !== "string" || waterStorageArt.overlayId !== GREENHOUSE_WATER_STORAGE_ART_ID ||
      waterStorageArt.assetPath !== GREENHOUSE_WATER_STORAGE_ASSET_PATH ||
      !finiteNonNegative(waterStorageArt.x) || !finiteNonNegative(waterStorageArt.y) ||
      !finitePositive(waterStorageArt.width) || !finitePositive(waterStorageArt.height) ||
      !finitePositive(waterStorageArt.scaleX) || !finitePositive(waterStorageArt.scaleY) ||
      typeof waterStorageArt.rotationDeg !== "number" || !Number.isFinite(waterStorageArt.rotationDeg) ||
      !Number.isInteger(waterStorageArt.zIndex) ||
      (waterStorageArt.x as number) + (waterStorageArt.width as number) * (waterStorageArt.scaleX as number) > (raw.roomWidth as number) + 0.01 ||
      (waterStorageArt.y as number) + (waterStorageArt.height as number) * (waterStorageArt.scaleY as number) > (raw.roomHeight as number) + 0.01) {
    throw new Error("Greenhouse Studio water-storage art is invalid");
  }
  const overlaysRaw = raw.schemaVersion === 2 || raw.schemaVersion === 3 || raw.schemaVersion === 4 ? raw.overlays : [];
  if (!Array.isArray(overlaysRaw)) throw new Error("Greenhouse Studio overlays are invalid");
  const overlays = overlaysRaw.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Greenhouse Studio overlay ${index + 1} is invalid`);
    }
    const overlay = candidate as Record<string, unknown>;
    if (typeof overlay.overlayId !== "string" || overlay.overlayId.trim() === "" ||
        typeof overlay.assetPath !== "string" || !GREENHOUSE_OVERLAY_ASSET_PATHS.includes(overlay.assetPath as typeof GREENHOUSE_OVERLAY_ASSET_PATHS[number]) ||
        !finiteNonNegative(overlay.x) || !finiteNonNegative(overlay.y) ||
        !finitePositive(overlay.width) || !finitePositive(overlay.height) ||
        !finitePositive(overlay.scaleX) || !finitePositive(overlay.scaleY) ||
        typeof overlay.rotationDeg !== "number" || !Number.isFinite(overlay.rotationDeg) ||
        !Number.isInteger(overlay.zIndex)) {
      throw new Error(`Greenhouse Studio overlay ${index + 1} is invalid`);
    }
    if ((overlay.x as number) > (raw.roomWidth as number) || (overlay.y as number) > (raw.roomHeight as number) ||
        (overlay.x as number) + (overlay.width as number) * (overlay.scaleX as number) > (raw.roomWidth as number) + 0.01 ||
        (overlay.y as number) + (overlay.height as number) * (overlay.scaleY as number) > (raw.roomHeight as number) + 0.01) {
      throw new Error(`Greenhouse Studio overlay ${index + 1} is outside the room`);
    }
    return {
      overlayId: overlay.overlayId,
      assetPath: overlay.assetPath,
      x: overlay.x as number,
      y: overlay.y as number,
      width: overlay.width as number,
      height: overlay.height as number,
      rotationDeg: overlay.rotationDeg as number,
      scaleX: overlay.scaleX as number,
      scaleY: overlay.scaleY as number,
      zIndex: overlay.zIndex as number
    } satisfies GreenhouseStudioOverlay;
  });
  if (new Set(overlays.map((overlay) => overlay.overlayId)).size !== overlays.length) {
    throw new Error("Greenhouse Studio overlay IDs must be unique");
  }
  if (new Set(overlays.map((overlay) => overlay.assetPath)).size !== overlays.length) {
    throw new Error("Greenhouse Studio overlay assets must be unique");
  }
  const geometry = parseGeometry(raw.geometry, raw.roomWidth as number, raw.roomHeight as number);
  const planterCapacity = raw.planterCapacity === undefined
    ? GREENHOUSE_PLANTER_CAPACITY
    : typeof raw.planterCapacity === "number" ? raw.planterCapacity : null;
  if (typeof planterCapacity !== "number" || !Number.isInteger(planterCapacity) || planterCapacity < GREENHOUSE_PLANTER_CAPACITY) {
    throw new Error("Greenhouse Studio planter capacity is invalid");
  }
  return {
    schemaVersion: 4,
    catalogRevision: raw.catalogRevision as number,
    roomId: raw.roomId,
    roomWidth: raw.roomWidth as number,
    roomHeight: raw.roomHeight as number,
    planterCapacity,
    anchors,
    waterStorage: {
      anchorId: waterStorage.anchorId,
      roomId: waterStorage.roomId,
      x: waterStorage.x as number,
      y: waterStorage.y as number
    },
    waterStorageArt: {
      overlayId: waterStorageArt.overlayId,
      assetPath: waterStorageArt.assetPath,
      x: waterStorageArt.x as number,
      y: waterStorageArt.y as number,
      width: waterStorageArt.width as number,
      height: waterStorageArt.height as number,
      rotationDeg: waterStorageArt.rotationDeg as number,
      scaleX: waterStorageArt.scaleX as number,
      scaleY: waterStorageArt.scaleY as number,
      zIndex: waterStorageArt.zIndex as number
    },
    overlays,
    geometry
  };
}

function parseGeometry(value: unknown, roomWidth: number, roomHeight: number): GreenhouseStudioGeometry {
  if (value === undefined) return defaultGeometry(roomWidth, roomHeight);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Greenhouse Studio geometry is invalid");
  const raw = value as Record<string, unknown>;
  const surfaces = parseSurfaces(raw.surfaces, roomWidth, roomHeight);
  const colliders = parseColliders(raw.colliders, roomWidth, roomHeight);
  const exitValue = raw.exit;
  if (!exitValue || typeof exitValue !== "object" || Array.isArray(exitValue)) throw new Error("Greenhouse Studio exit is invalid");
  const exitRaw = exitValue as Record<string, unknown>;
  if (typeof exitRaw.anchorId !== "string" || exitRaw.anchorId.trim() === "") throw new Error("Greenhouse Studio exit ID is invalid");
  const exit = {
    anchorId: exitRaw.anchorId,
    touchArea: parseTouchArea(exitRaw.touchArea, roomWidth, roomHeight),
    assetPath: typeof exitRaw.assetPath === "string" && exitRaw.assetPath.trim() ? exitRaw.assetPath : GREENHOUSE_DOOR_ASSET_PATH,
    x: finiteNonNegative(exitRaw.x) ? exitRaw.x as number : roomWidth / 2,
    y: finiteNonNegative(exitRaw.y) ? exitRaw.y as number : roomHeight - 96,
    renderWidth: finitePositive(exitRaw.renderWidth) ? exitRaw.renderWidth as number : 144,
    renderHeight: finitePositive(exitRaw.renderHeight) ? exitRaw.renderHeight as number : 144,
    pivotX: normalizedUnit(exitRaw.pivotX) ? exitRaw.pivotX as number : 0.5,
    pivotY: normalizedUnit(exitRaw.pivotY) ? exitRaw.pivotY as number : 0.5
  } satisfies GreenhouseStudioExit;
  if (exit.x > roomWidth || exit.y > roomHeight || exit.x - exit.pivotX * exit.renderWidth < 0 || exit.y - exit.pivotY * exit.renderHeight < 0 || exit.x + (1 - exit.pivotX) * exit.renderWidth > roomWidth || exit.y + (1 - exit.pivotY) * exit.renderHeight > roomHeight) {
    throw new Error("Greenhouse Studio door art is outside the room");
  }
  const templatesRaw = raw.templates;
  if (!templatesRaw || typeof templatesRaw !== "object" || Array.isArray(templatesRaw)) throw new Error("Greenhouse Studio placement templates are invalid");
  const templates = templatesRaw as Record<string, unknown>;
  const pot = parseTemplate(templates.pot, "pot", roomWidth, roomHeight);
  const waterTank = parseTemplate(templates.waterTank, "water_tank", roomWidth, roomHeight);
  const stageArt = parseStageArt(raw.stageArt);
  return { surfaces, colliders, exit, templates: { pot, waterTank }, stageArt };
}

function parseStageArt(value: unknown): readonly GreenhouseStudioPlantStageArt[] {
  if (value === undefined) return defaultStageArt();
  if (!Array.isArray(value) || (value.length !== 4 && value.length !== 8)) throw new Error("Greenhouse Studio stage art is invalid");
  const stageArt = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`Greenhouse Studio stage art ${index + 1} is invalid`);
    const raw = candidate as Record<string, unknown>;
    if (!Number.isInteger(raw.stage) || (raw.stage as number) < 1 || (raw.stage as number) > 4 ||
        typeof raw.artId !== "string" || raw.artId.trim() === "" ||
        !GREENHOUSE_ALL_STAGE_ART_ASSET_PATHS.includes(raw.assetPath as typeof GREENHOUSE_ALL_STAGE_ART_ASSET_PATHS[number]) ||
        !normalizedUnit(raw.pivotX) || !normalizedUnit(raw.pivotY) ||
        typeof raw.offsetX !== "number" || !Number.isFinite(raw.offsetX) ||
        typeof raw.offsetY !== "number" || !Number.isFinite(raw.offsetY) ||
        !finitePositive(raw.scale) || (raw.scale as number) > 4) {
      throw new Error(`Greenhouse Studio stage art ${index + 1} is invalid`);
    }
    return {
      cropId: typeof raw.cropId === "string" && raw.cropId.trim() !== "" ? raw.cropId : "wheat",
      stage: raw.stage as GreenhouseStudioPlantStage,
      artId: raw.artId,
      assetPath: raw.assetPath as typeof GREENHOUSE_ALL_STAGE_ART_ASSET_PATHS[number],
      pivotX: raw.pivotX as number,
      pivotY: raw.pivotY as number,
      offsetX: raw.offsetX as number,
      offsetY: raw.offsetY as number,
      scale: raw.scale as number
    } satisfies GreenhouseStudioPlantStageArt;
  });
  if (value.length === 4) stageArt.push(...defaultGivingBerryStageArt());
  if (new Set(stageArt.map((art) => `${art.cropId}:${art.stage}`)).size !== stageArt.length || new Set(stageArt.map((art) => `${art.cropId}:${art.artId}`)).size !== stageArt.length) {
    throw new Error("Greenhouse Studio stage art IDs must be unique");
  }
  for (const cropId of new Set(stageArt.map((art) => art.cropId))) {
    const cropStages = stageArt.filter((art) => art.cropId === cropId);
    if (cropStages.length !== 4 || !cropStages.every((art, index) => art.stage === index + 1)) throw new Error(`Greenhouse Studio ${cropId} stage art stages must be ordered`);
  }
  return stageArt;
}

function parseSurfaces(value: unknown, roomWidth: number, roomHeight: number): readonly GreenhouseStudioSurface[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Greenhouse Studio needs a floor surface");
  const surfaces = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`Greenhouse Studio surface ${index + 1} is invalid`);
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.surfaceId !== "string" || raw.surfaceId.trim() === "" ||
        !["floor", "back_wall", "left_wall", "right_wall"].includes(raw.kind as string)) throw new Error(`Greenhouse Studio surface ${index + 1} is invalid`);
    const points = parseRoomPoints(raw.points, roomWidth, roomHeight);
    if (manorPolygonGeometryIssues(points).length > 0) throw new Error(`Greenhouse Studio surface ${index + 1} polygon is invalid`);
    return { surfaceId: raw.surfaceId, kind: raw.kind as GreenhouseStudioSurfaceKind, points } satisfies GreenhouseStudioSurface;
  });
  if (!surfaces.some((surface) => surface.kind === "floor")) throw new Error("Greenhouse Studio needs a floor surface");
  if (new Set(surfaces.map((surface) => surface.surfaceId)).size !== surfaces.length) throw new Error("Greenhouse Studio surface IDs must be unique");
  return surfaces;
}

function parseColliders(value: unknown, roomWidth: number, roomHeight: number): readonly GreenhouseStudioCollider[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Greenhouse Studio blockers are invalid");
  const colliders = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`Greenhouse Studio blocker ${index + 1} is invalid`);
    const raw = candidate as Record<string, unknown>;
    const points = parseRoomPoints(raw.points, roomWidth, roomHeight);
    if (typeof raw.colliderId !== "string" || raw.colliderId.trim() === "" || manorPolygonGeometryIssues(points).length > 0) throw new Error(`Greenhouse Studio blocker ${index + 1} is invalid`);
    return { colliderId: raw.colliderId, points } satisfies GreenhouseStudioCollider;
  });
  if (new Set(colliders.map((collider) => collider.colliderId)).size !== colliders.length) throw new Error("Greenhouse Studio blocker IDs must be unique");
  return colliders;
}

function parseRoomPoints(value: unknown, roomWidth: number, roomHeight: number): GreenhouseStudioPoint[] {
  if (!Array.isArray(value) || value.length < 3) throw new Error("Greenhouse Studio polygons need at least three points");
  const points = value.map((point) => {
    if (!point || typeof point !== "object" || Array.isArray(point)) throw new Error("Greenhouse Studio polygon point is invalid");
    const raw = point as Record<string, unknown>;
    if (!finiteNonNegative(raw.x) || !finiteNonNegative(raw.y) || (raw.x as number) > roomWidth || (raw.y as number) > roomHeight) throw new Error("Greenhouse Studio polygon point is outside the room");
    return { x: raw.x as number, y: raw.y as number };
  });
  return points;
}

function parseTouchArea(value: unknown, roomWidth: number, roomHeight: number, localCoordinates = false): GreenhouseStudioTouchArea {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Greenhouse Studio touch area is invalid");
  const raw = value as Record<string, unknown>;
  if (raw.kind === "circle" && finitePositive(raw.radius)) return { kind: "circle", radius: raw.radius };
  if (raw.kind === "polygon") {
    return {
      kind: "polygon",
      points: localCoordinates ? parseLocalPoints(raw.points) : parseRoomPoints(raw.points, roomWidth, roomHeight)
    };
  }
  throw new Error("Greenhouse Studio touch area is invalid");
}

function parseTemplate(value: unknown, templateId: "pot" | "water_tank", roomWidth: number, roomHeight: number): GreenhouseStudioPlacementTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Greenhouse Studio ${templateId} template is invalid`);
  const raw = value as Record<string, unknown>;
  if (raw.templateId !== templateId) throw new Error(`Greenhouse Studio ${templateId} template ID is unstable`);
  const assetPath = raw.assetPath === undefined
    ? (templateId === "pot" ? GREENHOUSE_POT_ASSET_PATH : GREENHOUSE_WATER_STORAGE_ASSET_PATH)
    : raw.assetPath;
  if (typeof assetPath !== "string" || assetPath.trim() === "") throw new Error(`Greenhouse Studio ${templateId} asset path is invalid`);
  const renderWidth = raw.renderWidth === undefined ? (templateId === "pot" ? 96 : 160) : raw.renderWidth;
  const renderHeight = raw.renderHeight === undefined ? (templateId === "pot" ? 72 : 160) : raw.renderHeight;
  if (!finitePositive(renderWidth) || !finitePositive(renderHeight)) throw new Error(`Greenhouse Studio ${templateId} render size is invalid`);
  const pivotX = raw.pivotX === undefined ? 0.5 : raw.pivotX;
  const pivotY = raw.pivotY === undefined ? 0.5 : raw.pivotY;
  if (!normalizedUnit(pivotX) || !normalizedUnit(pivotY)) throw new Error(`Greenhouse Studio ${templateId} image pivot is invalid`);
  const footprint = raw.physicalFootprint;
  if (!Array.isArray(footprint) || footprint.length < 3) throw new Error(`Greenhouse Studio ${templateId} footprint is invalid`);
  const parsedPhysicalFootprint = footprint.map((point) => {
    if (!point || typeof point !== "object" || Array.isArray(point)) throw new Error(`Greenhouse Studio ${templateId} footprint is invalid`);
    const candidate = point as Record<string, unknown>;
    if (typeof candidate.x !== "number" || !Number.isFinite(candidate.x) || typeof candidate.y !== "number" || !Number.isFinite(candidate.y)) throw new Error(`Greenhouse Studio ${templateId} footprint is invalid`);
    return { x: candidate.x, y: candidate.y };
  });
  if (manorPolygonGeometryIssues(parsedPhysicalFootprint).length > 0) throw new Error(`Greenhouse Studio ${templateId} footprint is invalid`);
  const physicalFootprint = centerLocalFootprint(parsedPhysicalFootprint);
  return {
    templateId,
    assetPath,
    renderWidth,
    renderHeight,
    pivotX,
    pivotY,
    physicalFootprint,
    touchArea: parseTouchArea(raw.touchArea, roomWidth, roomHeight, true)
  };
}

function parseLocalPoints(value: unknown): GreenhouseStudioPoint[] {
  if (!Array.isArray(value) || value.length < 3) throw new Error("Greenhouse Studio local polygon needs at least three points");
  return value.map((point) => {
    if (!point || typeof point !== "object" || Array.isArray(point)) throw new Error("Greenhouse Studio local polygon point is invalid");
    const raw = point as Record<string, unknown>;
    if (typeof raw.x !== "number" || !Number.isFinite(raw.x) || typeof raw.y !== "number" || !Number.isFinite(raw.y)) {
      throw new Error("Greenhouse Studio local polygon point is invalid");
    }
    return { x: raw.x, y: raw.y };
  });
}

function boundsOfPoints(points: readonly GreenhouseStudioPoint[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y))
  };
}

export type GreenhousePlacementKind = "pot" | "water_tank";
export type GreenhousePlacementOccupant = Readonly<{ kind: GreenhousePlacementKind; x: number; y: number }>;

export type GreenhouseTemplateImageFrame = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/** Resolve the rendered PNG frame from its image-local placement anchor.
 * Physical footprints are centered on this frame; touch areas remain anchored
 * to the placement point independently of the physical footprint. */
export function greenhouseTemplateImageFrame(
  catalog: Pick<GreenhouseStudioCatalog, "geometry">,
  kind: GreenhousePlacementKind,
  x: number,
  y: number
): GreenhouseTemplateImageFrame {
  const template = kind === "pot" ? catalog.geometry.templates.pot : catalog.geometry.templates.waterTank;
  return {
    x: x - template.pivotX * template.renderWidth,
    y: y - template.pivotY * template.renderHeight,
    width: template.renderWidth,
    height: template.renderHeight
  };
}

/** Persist only the v4 authoring contract.  Legacy anchor/hotspot projections
 * stay available in memory for runtime compatibility but are never published
 * back into the Studio catalog. */
export function serializeGreenhouseStudioCatalog(catalog: GreenhouseStudioCatalog): Record<string, unknown> {
  const templates = {
    ...catalog.geometry.templates,
    pot: { ...catalog.geometry.templates.pot, physicalFootprint: centerLocalFootprint(catalog.geometry.templates.pot.physicalFootprint) },
    waterTank: { ...catalog.geometry.templates.waterTank, physicalFootprint: centerLocalFootprint(catalog.geometry.templates.waterTank.physicalFootprint) }
  };
  return {
    schemaVersion: 4,
    catalogRevision: catalog.catalogRevision,
    roomId: catalog.roomId,
    roomWidth: catalog.roomWidth,
    roomHeight: catalog.roomHeight,
    planterCapacity: catalog.planterCapacity,
    overlays: catalog.overlays,
    geometry: { ...catalog.geometry, templates }
  };
}

/** Resolve a stage PNG frame from the authored Farm Plot render frame. The
 * stage image has no independent interaction region; its offset is purely
 * visual relative to the plot's placement anchor. */
export function greenhousePlantStageArtFrame(
  catalog: Pick<GreenhouseStudioCatalog, "geometry">,
  stageArt: Pick<GreenhouseStudioPlantStageArt, "pivotX" | "pivotY" | "offsetX" | "offsetY" | "scale">,
  plotAnchorX: number,
  plotAnchorY: number
): GreenhouseTemplateImageFrame {
  const plot = catalog.geometry.templates.pot;
  const width = plot.renderWidth * stageArt.scale;
  const height = plot.renderHeight * stageArt.scale;
  const anchorX = plotAnchorX + stageArt.offsetX;
  const anchorY = plotAnchorY + stageArt.offsetY;
  return {
    x: anchorX - stageArt.pivotX * width,
    y: anchorY - stageArt.pivotY * height,
    width,
    height
  };
}

export type GreenhouseStudioTouchBounds = Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;

export function greenhouseTemplateTouchBounds(
  catalog: Pick<GreenhouseStudioCatalog, "geometry">,
  kind: GreenhousePlacementKind,
  x: number,
  y: number
): GreenhouseStudioTouchBounds {
  const area = kind === "pot" ? catalog.geometry.templates.pot.touchArea : catalog.geometry.templates.waterTank.touchArea;
  if (area.kind === "circle") {
    return { minX: x - area.radius, minY: y - area.radius, maxX: x + area.radius, maxY: y + area.radius };
  }
  const xs = area.points.map((point) => point.x + x);
  const ys = area.points.map((point) => point.y + y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  };
}

/** Resolve a click against the authored touch geometry, independently of the
 * tighter physical footprint used for placement validation. */
export function greenhouseTemplateTouchContainsPoint(
  catalog: Pick<GreenhouseStudioCatalog, "geometry">,
  kind: GreenhousePlacementKind,
  x: number,
  y: number,
  pointX: number,
  pointY: number
): boolean {
  const area = kind === "pot" ? catalog.geometry.templates.pot.touchArea : catalog.geometry.templates.waterTank.touchArea;
  const localPoint = { x: pointX - x, y: pointY - y };
  if (area.kind === "circle") return Math.hypot(localPoint.x, localPoint.y) <= area.radius + 1e-9;
  return manorPointInPolygon(localPoint, area.points);
}

export function greenhouseTemplateFootprint(
  catalog: Pick<GreenhouseStudioCatalog, "geometry">,
  kind: GreenhousePlacementKind,
  x: number,
  y: number
): GreenhouseStudioPoint[] {
  const template = kind === "pot" ? catalog.geometry.templates.pot : catalog.geometry.templates.waterTank;
  const frame = greenhouseTemplateImageFrame(catalog, kind, x, y);
  return centerLocalFootprint(template.physicalFootprint).map((point) => ({
    x: point.x + frame.x + frame.width / 2,
    y: point.y + frame.y + frame.height / 2
  }));
}

/** Shared placement check used by Studio preview, client preview, and server authority. */
export function greenhousePlacementIssue(
  catalog: Pick<GreenhouseStudioCatalog, "geometry">,
  kind: GreenhousePlacementKind,
  x: number,
  y: number,
  occupants: readonly GreenhousePlacementOccupant[] = []
): string | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "Choose a finite room position.";
  const floor = catalog.geometry.surfaces.find((surface) => surface.kind === "floor");
  if (!floor) return "The room has no authored floor surface.";
  const footprint = greenhouseTemplateFootprint(catalog, kind, x, y);
  if (!manorPolygonContainsPolygon(floor.points, footprint)) return "The footprint must stay fully inside the floor.";
  const wallSurfaces = catalog.geometry.surfaces.filter((surface) => surface.kind !== "floor");
  if (catalog.geometry.colliders.some((collider) => manorPolygonIntersectsPolygon(footprint, collider.points)) ||
      wallSurfaces.some((surface) => manorPolygonIntersectsPolygon(footprint, surface.points))) {
    return "The footprint overlaps a wall or blocker.";
  }
  if (occupants.some((occupant) => manorPolygonIntersectsPolygon(footprint, greenhouseTemplateFootprint(catalog, occupant.kind, occupant.x, occupant.y)))) return "The footprint overlaps another placed object.";
  return null;
}

/**
 * Resolve a live placement drag against the same authored geometry used by
 * placement validation.  The requested pointer position is never allowed to
 * tunnel through a wall, floor edge, or another object: first clamp to the
 * first invalid point on the swept segment.  This keeps the blueprint on the
 * valid side of authored walls and blockers even for a large pointer jump;
 * subsequent pointer events can then continue the drag from that boundary.
 */
export function resolveGreenhousePlacementPosition(
  catalog: Pick<GreenhouseStudioCatalog, "geometry">,
  kind: GreenhousePlacementKind,
  requested: GreenhouseStudioPoint,
  occupants: readonly GreenhousePlacementOccupant[] = [],
  current?: GreenhouseStudioPoint
): GreenhouseStudioPoint | null {
  const finitePoint = (point: GreenhouseStudioPoint): GreenhouseStudioPoint => ({
    x: Number.isFinite(point.x) ? point.x : 0,
    y: Number.isFinite(point.y) ? point.y : 0
  });
  const target = finitePoint(requested);
  const floor = catalog.geometry.surfaces.find((surface) => surface.kind === "floor");
  if (!floor) return target;
  const collisionPolygons = [
    ...catalog.geometry.colliders.map((collider) => collider.points),
    ...catalog.geometry.surfaces.filter((candidate) => candidate.kind !== "floor").map((candidate) => candidate.points),
    ...occupants.map((occupant) => greenhouseTemplateFootprint(catalog, occupant.kind, occupant.x, occupant.y))
  ];
  const valid = (point: GreenhouseStudioPoint): boolean => greenhousePlacementIssue(catalog, kind, point.x, point.y, occupants) === null;
  const start = current && valid(finitePoint(current))
    ? finitePoint(current)
    : findNearestValidGreenhousePosition(catalog, kind, target, occupants);
  if (!start) return null;
  if (!valid(start)) return start;
  let position = start;
  let remaining = { x: target.x - start.x, y: target.y - start.y };
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const candidate = { x: position.x + remaining.x, y: position.y + remaining.y };
    const blockedPrefix = (point: GreenhouseStudioPoint): boolean =>
      !valid(point) || greenhousePlacementPathIntersects(catalog, kind, position, point, collisionPolygons);
    if (!blockedPrefix(candidate)) return candidate;
    let low = 0;
    let high = 1;
    for (let probe = 0; probe < 42; probe += 1) {
      const middle = (low + high) / 2;
      const probePoint = { x: position.x + remaining.x * middle, y: position.y + remaining.y * middle };
      if (blockedPrefix(probePoint)) high = middle;
      else low = middle;
    }
    const safeT = Math.max(0, low - 1e-4);
    position = { x: position.x + remaining.x * safeT, y: position.y + remaining.y * safeT };
    const residual = { x: remaining.x * (1 - safeT), y: remaining.y * (1 - safeT) };
    if (Math.hypot(residual.x, residual.y) <= 1e-6) return position;

    const edgePolygons = [floor.points, ...collisionPolygons];
    let best: { point: GreenhouseStudioPoint; progress: number } | null = null;
    for (const polygon of edgePolygons) {
      for (let index = 0; index < polygon.length; index += 1) {
        const edgeStart = polygon[index]!;
        const edgeEnd = polygon[(index + 1) % polygon.length]!;
        const length = Math.hypot(edgeEnd.x - edgeStart.x, edgeEnd.y - edgeStart.y);
        if (length <= 1e-7) continue;
        if (greenhousePlacementEdgeDistance(edgeStart, edgeEnd, position, catalog, kind) > 3) continue;
        const tangent = { x: (edgeEnd.x - edgeStart.x) / length, y: (edgeEnd.y - edgeStart.y) / length };
        const projected = residual.x * tangent.x + residual.y * tangent.y;
        if (Math.abs(projected) <= 1e-6) continue;
        const candidatePoint = { x: position.x + tangent.x * projected, y: position.y + tangent.y * projected };
        if (!valid(candidatePoint) || greenhousePlacementPathIntersects(catalog, kind, position, candidatePoint, collisionPolygons)) continue;
        if (!best || Math.abs(projected) > best.progress) best = { point: candidatePoint, progress: Math.abs(projected) };
      }
    }
    if (!best) return position;
    position = best.point;
    remaining = { x: target.x - position.x, y: target.y - position.y };
  }
  return position;
}

function greenhousePlacementEdgeDistance(
  start: GreenhouseStudioPoint,
  end: GreenhouseStudioPoint,
  position: GreenhouseStudioPoint,
  catalog: Pick<GreenhouseStudioCatalog, "geometry">,
  kind: GreenhousePlacementKind
): number {
  const footprint = greenhouseTemplateFootprint(catalog, kind, position.x, position.y);
  return Math.min(...footprint.map((point) => greenhousePointSegmentDistance(point, start, end)));
}

function greenhousePointSegmentDistance(point: GreenhouseStudioPoint, start: GreenhouseStudioPoint, end: GreenhouseStudioPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function greenhousePlacementPathIntersects(
  catalog: Pick<GreenhouseStudioCatalog, "geometry">,
  kind: GreenhousePlacementKind,
  start: GreenhouseStudioPoint,
  end: GreenhouseStudioPoint,
  collisionPolygons: readonly (readonly GreenhouseStudioPoint[])[]
): boolean {
  const startFootprint = greenhouseTemplateFootprint(catalog, kind, start.x, start.y);
  const endFootprint = greenhouseTemplateFootprint(catalog, kind, end.x, end.y);
  const floor = catalog.geometry.surfaces.find((surface) => surface.kind === "floor");
  for (let index = 0; index < startFootprint.length; index += 1) {
    const next = (index + 1) % startFootprint.length;
    const sweptQuad = [startFootprint[index]!, startFootprint[next]!, endFootprint[next]!, endFootprint[index]!];
    if (greenhousePolygonArea(sweptQuad) <= 1e-7) continue;
    if (floor && !manorPolygonContainsPolygon(floor.points, sweptQuad)) return true;
    if (collisionPolygons.some((polygon) => manorPolygonIntersectsPolygon(sweptQuad, polygon))) return true;
  }
  if (floor && (!manorPolygonContainsPolygon(floor.points, startFootprint) || !manorPolygonContainsPolygon(floor.points, endFootprint))) return true;
  return false;
}

function greenhousePolygonArea(points: readonly GreenhouseStudioPoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    area += points[index]!.x * points[next]!.y - points[next]!.x * points[index]!.y;
  }
  return Math.abs(area) / 2;
}

function findNearestValidGreenhousePosition(
  catalog: Pick<GreenhouseStudioCatalog, "geometry">,
  kind: GreenhousePlacementKind,
  requested: GreenhouseStudioPoint,
  occupants: readonly GreenhousePlacementOccupant[]
): GreenhouseStudioPoint | null {
  if (greenhousePlacementIssue(catalog, kind, requested.x, requested.y, occupants) === null) return requested;
  const floor = catalog.geometry.surfaces.find((surface) => surface.kind === "floor");
  const maxX = floor ? Math.max(...floor.points.map((point) => point.x)) : 2_000;
  const maxY = floor ? Math.max(...floor.points.map((point) => point.y)) : 2_000;
  const maxRadius = Math.hypot(maxX, maxY);
  let candidates = 0;
  for (let radius = 8; radius <= maxRadius && candidates < 4096; radius += 16) {
    const samples = Math.max(16, Math.min(128, Math.ceil(radius / 16) * 16));
    for (let index = 0; index < samples; index += 1) {
      candidates += 1;
      const angle = index / samples * Math.PI * 2;
      const candidate = { x: requested.x + Math.cos(angle) * radius, y: requested.y + Math.sin(angle) * radius };
      if (greenhousePlacementIssue(catalog, kind, candidate.x, candidate.y, occupants) === null) return candidate;
      if (candidates >= 4096) break;
    }
  }
  return null;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Store footprint dimensions around a local (0, 0) center. At placement time
 * this center maps to the rendered image frame's center, not its pivot.
 * Also normalize legacy points authored with a top-left origin. */
function centerLocalFootprint(points: readonly GreenhouseStudioPoint[]): GreenhouseStudioPoint[] {
  const bounds = boundsOfPoints(points);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return points.map((point) => ({ x: point.x - centerX, y: point.y - centerY }));
}

function normalizedUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
