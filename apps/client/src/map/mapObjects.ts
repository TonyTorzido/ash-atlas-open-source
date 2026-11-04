import type {
  CollectibleNode,
  CombatEntitySnapshot,
  CityStructureSnapshot,
  CitySnapshot,
  DroppedItemSnapshot,
  DungeonEntranceSnapshot,
  DungeonObjectSnapshot,
  DungeonPrefabDefinition,
  DungeonRoomDefinition,
  FlagSnapshot,
  FurnaceWorldSnapshot,
  TanneryWorldSnapshot,
  LoomWorldSnapshot,
  KitchenWorldSnapshot,
  FishingHutWorldSnapshot,
  GreenhouseSnapshot,
  LatLon,
  FishingBiteEventKind,
  ManorWorldSnapshot,
  MilitaryBomberChannelSnapshot,
  MilitarySiegeVolleyCue,
  MilitaryBomberDetonationCue,
  MilitaryUnitGroupSnapshot,
  WarCampSnapshot,
  PlayerSnapshot,
  ResourceVision,
  WaterSourceHighlight
} from "@ash-atlas/shared";

import type { DungeonPortalBarricade } from "../ui/DungeonRoomPresentation.js";
import type { DungeonEnemyElite } from "../features/interiorMap/dungeonElitePresentation.js";
import type { GameplayViewCircle } from "./gameplayViewCircle.js";
import type { GatheringPresentation } from "../players/gatheringPresentation.js";

export type FishingCastPresentation = Readonly<{
  point: LatLon;
  status: "targeting" | "pending" | "invalid" | "bound";
  cue?: FishingBiteEventKind | null;
}>;

export function fishingCastCuePulse(
  cue: FishingBiteEventKind | null | undefined,
  frameNowMs: number,
  reducedMotion: boolean
): number {
  if (!cue || reducedMotion) return cue ? 0.5 : 0;
  const periodMs = cue === "true_strike" ? 95 : 180;
  return (Math.sin(frameNowMs / periodMs) + 1) / 2;
}

/**
 * One map-rendered interior room. Positions are room-local units (y-down);
 * players, combat entities and drops use lngLat (combat position indoors).
 */
/**
 * A plain picture placed in room units (Manor, Salon and Greenhouse art: floors, fixtures, decorations).
 * `height: null` keeps the texture's aspect ratio at `width`.
 */
export type InteriorSpriteItem = Readonly<{
  key: string;
  url: string;
  layerId: "background" | "below_player" | "actors" | "above_player" | "ceiling";
  x: number;
  y: number;
  width: number;
  height: number | null;
  anchorX: number;
  anchorY: number;
  rotationDeg?: number;
  scaleX?: number;
  scaleY?: number;
  alpha?: number;
  /** Draw order inside a non-actor layer (actors y-sort). */
  zIndex?: number;
  /** "contain": keep the texture's aspect inside the width x height box, centred (CSS object-fit: contain). */
  fit?: "fill" | "contain";
}>;

export type InteriorRenderState = Readonly<{
  spaceKey: string;
  roomWidth: number;
  roomHeight: number;
  metersPerUnit: number;
  layers: DungeonRoomDefinition["layers"];
  prefabs: readonly DungeonPrefabDefinition[];
  objects: readonly DungeonObjectSnapshot[];
  /** Locked portals, each drawn under its dungeon's barricade prop. */
  barricades?: readonly DungeonPortalBarricade[];
  /** Local player plus room occupants, already in lngLat. */
  players: readonly PlayerSnapshot[];
  /** Smoothed render position for a player, e.g. the sampled movement timeline. */
  playerPosition?: (playerId: string) => LatLon | null;
  /** The room's combat entities; replaces the world combat store indoors. */
  combatEntities: readonly CombatEntitySnapshot[];
  /** Authored per-mob visual scale on top of the world mob presentation. */
  mobVisualScales?: ReadonlyMap<string, number>;
  /** Rolled dungeon elites: drawn with an "Elite <name>" label, modifier badges and shield state. */
  mobElites?: ReadonlyMap<string, DungeonEnemyElite>;
  selectedObjectId: string | null;
  /** Plain pictures (Manor, Salon and Greenhouse floor art, fixtures, decorations, placement previews). */
  sprites?: readonly InteriorSpriteItem[];
  /** Set while the room holds an Ash Heart puzzle drawn on its floor. */
  heartPuzzle?: Readonly<{ dungeonId: string; roomId: string; sessionId: string; solved: boolean; active: boolean }>;
  /** Set in a Tilted Vault combat room: its forward door opens (and glows) once every mob in the room is dead. */
  vaultCombat?: Readonly<{ roomId: string; doorUnlocked: boolean }>;
  /** Extra tap frames (room units) for objects whose art is baked into the room, e.g. the painted puzzle-room doors. */
  objectHitFrames?: ReadonlyMap<string, Readonly<{ left: number; top: number; right: number; bottom: number }>>;
}>;

export type SaplingRenderItem = Readonly<{
  id: string;
  lat: number;
  lon: number;
  state: "sapling" | "grown";
  /** 0 (just planted) to 1 (about to mature); grown trees are 1. */
  growth: number;
  phase: "healthy" | "needs_tending" | "dying";
  /** Grown trees: a Giving Berry is ready to gather (draws the fruiting tree). */
  berryAvailable: boolean;
}>;

export type RenderState = {
  localPlayerId: string;
  players: PlayerSnapshot[];
  flags: FlagSnapshot[];
  cities: CitySnapshot[];
  cityStructures: CityStructureSnapshot[];
  dungeonEntrances: DungeonEntranceSnapshot[];
  manors: ManorWorldSnapshot[];
  /** Durable owner greenhouses rendered as world buildings. */
  greenhouses?: GreenhouseSnapshot[];
  furnaces: FurnaceWorldSnapshot[];
  tanneries: TanneryWorldSnapshot[];
  looms: LoomWorldSnapshot[];
  kitchens?: KitchenWorldSnapshot[];
  /** Authoritative field military groups rendered as world units. */
  militaryGroups?: MilitaryUnitGroupSnapshot[];
  /** Other players' War Camps in vision: attack targets with health and burn state. */
  warCamps?: readonly WarCampSnapshot[];
  /** The local player's authoritative Bomber planting deadline, if active. */
  militaryBomberChannel?: MilitaryBomberChannelSnapshot | null;
  /** Synchronized server clock used by world military countdown labels. */
  militaryClockMs?: number;
  /** Authoritative Siege volley occurrences used only for launch presentation. */
  militarySiegeVolleyCues?: readonly MilitarySiegeVolleyCue[];
  militaryBomberDetonationCues?: readonly MilitaryBomberDetonationCue[];
  /** Advisory client preview of flags a Siege could damage from its deploy point. */
  siegeDeploymentPreviewFlagIds?: readonly string[];
  fishingHuts?: FishingHutWorldSnapshot[];
  /** Player-planted Giving Tree saplings and grown player trees, already reduced to what is drawn. */
  saplings?: readonly SaplingRenderItem[];
  fishingCastPoint?: FishingCastPresentation | null;
  /** The local player's chop / mine / fish animation, if any. */
  localGathering?: GatheringPresentation | null;
  collectibles: CollectibleNode[];
  droppedItems: DroppedItemSnapshot[];
  resourceVision: ResourceVision | null;
  gameplayViewCircle?: GameplayViewCircle | null;
  /** The active Compass waypoint, drawn as an arrow on the gameplay view circle edge. */
  mapWaypoint?: { lat: number; lon: number; label: string } | null;
  waterHighlights: WaterSourceHighlight[];
  developerMovementLeash?: boolean;
  flagPlacementPreview?: {
    lat: number;
    lon: number;
    radiusM: number;
    state: "valid" | "touching" | "overlap";
  } | null;
  selectedFlagId: string | null;
  selectedCityId: string | null;
  selectedDungeonEntranceId: string | null;
  selectedManorId: string | null;
  selectedGreenhouseId?: string | null;
  selectedFurnaceId: string | null;
  selectedTanneryId: string | null;
  selectedLoomId: string | null;
  selectedKitchenId?: string | null;
  selectedFishingHutId?: string | null;
  selectedCollectibleId: string | null;
  selectedDroppedItemId: string | null;
  selectedCombatEntityId: string | null;
  selectedMilitaryGroupId?: string | null;
  worldTargetAnchor?: LatLon | null;
  worldTargetAnchorEntityId?: string | null;
  selectedPlayerId?: string | null;
  /** Present only while the map renders an interior; world arrays are then ignored. */
  interior?: InteriorRenderState | null;
};

export type WorldMapSelectionState = Pick<
  RenderState,
  | "selectedFlagId"
  | "selectedCityId"
  | "selectedDungeonEntranceId"
  | "selectedManorId"
  | "selectedGreenhouseId"
  | "selectedFurnaceId"
  | "selectedTanneryId"
  | "selectedLoomId"
  | "selectedKitchenId"
  | "selectedFishingHutId"
  | "selectedCollectibleId"
  | "selectedDroppedItemId"
   | "selectedCombatEntityId"
   | "selectedMilitaryGroupId"
  | "selectedPlayerId"
>;
