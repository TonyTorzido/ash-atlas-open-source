import { ARCANE_BLAST_BURST_MS, HOLY_HEAL_BURST_MS, SPARK_DURATION_MS, arcFade, shotFlightProgress, type ShotSlot } from "../combat/swingEffects.js";
import { clientShotProfile } from "../combat/clericArc.js";
import { playCombatCue, playCombatCueAfter } from "../combat/combatFeedback.js";
import {
  BIG_HIT_HEALTH_SHARE,
  DEATH_MARK_TTL_MS,
  IMPACT_SLASH_MS,
  KILL_HITSTOP_MS,
  deathGhostLook,
  type DeathGhostLook,
  currentShakeScale,
  hitFeedbackStats,
  mobRenderProbe,
  iframeShimmer,
  impactFlashAlpha,
  impactRedStrength,
  minTint,
  redTint,
  shimmerTint
} from "../combat/hitFeedback.js";
import { isDodgeFeedback } from "../combat/damageFloaters.js";
import { dashClientState } from "../movement/dash.js";
import { DASH_IFRAME_MS, MOB_RING_TELEGRAPH_ABILITY_IDS, PLAYER_HURT_RADIUS_M, SWING_HALF_ANGLE_DEG, SWING_RANGE_M, isMobSignatureAbilityId, mobHurtRadiusM } from "@ash-atlas/shared";
import {
  MOB_PROJECTILE_ABILITY_IDS,
  PROJECTILE_SHADOW_ALPHA,
  PROJECTILE_SHADOW_RADIUS_X_PX,
  PROJECTILE_SHADOW_RADIUS_Y_PX,
  liftedProjectilePoint,
  mobProjectileGroundPath,
  mobShotFlightProgress
} from "../combat/projectileLift.js";
import {
  type ActiveCityStructureType,
  activeProjectilePresentation,
  type CitySnapshot,
  type CityStructureSnapshot,
  BACKPACK_DEFINITION_IDS,
  DEFAULT_BOSS_APPEARANCE_CATALOG,
  DROPPED_ITEM_PICKUP_RADIUS_M,
  ENCHANTMENT_STONE_VARIANTS,
  bossAppearanceForArchetype,
  type CollectibleNode,
  type CombatEvent,
  type CombatEntitySnapshot,
  type BossCastSnapshot,
  type CompanionSpeciesId,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  type DroppedItemSnapshot,
  type DungeonEntranceSnapshot,
  EQUIPMENT_DEFINITION_IDS,
  type FlagSnapshot,
  type FurnaceWorldSnapshot,
  type TanneryWorldSnapshot,
  type LoomWorldSnapshot,
  type KitchenWorldSnapshot,
  type FishingHutWorldSnapshot,
  type GreenhouseSnapshot,
  type HarmfulStatusId,
  type LatLon,
  type ManorWorldSnapshot,
  MANOR_TYPES,
  resolveManorTypeId,
  type MilitaryUnitGroupSnapshot,
  type WarCampSnapshot,
  type MilitaryUnitType,
  militaryGroupDisplayName,
  type PlayerSnapshot,
  type ResourceVision,
  type ResourceType,
  type ResourceGain,
  harmfulStatusDisplayName,
  MOB_BUFF_DISPLAY_NAMES,
  type MobBuffKind,
  runtimePngAssetRegistrationById,
  type RuntimeSpritePresentation,
  treeVarietyForStableId,
  treeProduceAvailable,
  type WaterSourceHighlight,
  wgs84DestinationPoint,
} from "@ash-atlas/shared";
import { isCastOfGoneMob, noteMobTelegraphsGone, telegraphWindow } from "./telegraphWindow";
import {
  TELEGRAPH_DECAL,
  TELEGRAPH_DEFAULT_PALETTE,
  createTelegraphScreenShape,
  TelegraphDecalView,
  telegraphMarksForAbility,
  telegraphPaletteAt,
  telegraphSeed,
  type TelegraphPalette,
  type TelegraphScreenShape
} from "./telegraphDecal.js";
import { REASSEMBLE_CUE_COLOR, drawReassembleFx } from "./mobReassembleFx.js";
import {
  createMobActionState,
  createMobMotionPose,
  forEachMobActionFx,
  observeMobActions,
  sampleMobMotion,
  type MobActionState,
  type MobDirectionResolver,
  type MobFxKind,
  type MobMotionInput
} from "./mobActionAnimation.js";
import {
  BossRenderer,
  PixiTextureCache,
  PlayerRenderer,
  loadPixiTexture,
  projectileAimRadians,
  resolveProjectileSpriteTransform,
  type FlagBuildArt
} from "@ash-atlas/player-renderer";
import {
  bossAppearanceAssetUrl,
  playerAppearanceAssetUrl
} from "@ash-atlas/player-renderer/asset-registry";
import type maplibregl from "maplibre-gl";
import { AlphaFilter, Application, Assets, Container, Graphics, Point, Sprite, Text, Texture, type TextureSource } from "pixi.js";
import type { Ring } from "polygon-clipping";
import { fishingCastCuePulse, type RenderState, type SaplingRenderItem, type WorldMapSelectionState } from "./mapObjects.js";
import { InteriorRoomLayer } from "./interiorRoomLayer.js";
import { HeartPuzzleLayer } from "./heartPuzzleLayer.js";
import { stackDroppedItemsForWorld } from "../droppedItems/droppedItemModel.js";
import {
  cityStructurePresentationKey,
  isRenderableCityStructureType,
  pngInteractionHitBox,
  type ScreenHitBox,
  WORLD_PNG_PRESENTATION,
  worldLabelPositionBelowHitBox,
  fixedWorldPngDimensions,
  worldPngInteractionHitBox,
  worldPngScaleForZoom
} from "./worldPngPresentation.js";
import {
  worldPngMasterScale,
  worldPngSpriteMasterScale
} from "./worldPngMasterScale.js";
import { clientAssetKeyUrl, runtimePngAssetUrl } from "./runtimePngAssetUrl.js";
import { cityStructureWorldLabelParts } from "../features/settlements/cityConstructionPresentation.js";
import { cityBuildingWarfareView } from "../city/cityBuildingWarfare.js";
import { manorWarfareView } from "../features/manor/manorWarfarePresentation.js";
import { militaryWorldArtSlot, militaryWorldCountdownLabel } from "./militaryWorldPresentation.js";
import { bomberPlantPose, drawMilitaryAction, drawBomberDetonation, BOMBER_ESCAPE_MS, siegeVolleyPose, SIEGE_ACTION_MS } from "./militaryWorldAnimation.js";
import { buildRemainingTimeLabel } from "../flags/flagBuildCountdown.js";
import { combatSampleServerMs, type CombatStore } from "../combat/combatStore.js";
import {
  MOB_INTERPOLATION_DELAY_MS,
  createMobSnapshotTrack,
  pushMobSample,
  sampleMobTrack,
  type MobSnapshotTrack
} from "../combat/mobSnapshotBuffer.js";
import { CombatPresentationController } from "../combat/combatPresentation.js";
import { MOB_RENDER_SNAP_M, nextCompanionRenderPosition, type CompanionRenderMotion } from "../combat/combatRenderSmoothing.js";
import {
  nextMilitaryRenderPosition,
  shouldSnapMilitaryRenderPosition,
  type MilitaryRenderSample
} from "./militaryRenderSmoothing.js";
import { attackDirectionFromPoints } from "../combat/playerAppearancePose.js";
import {
  projectileImpactPresentation,
  projectileImpactSpriteTransform
} from "../combat/projectileImpacts.js";
import { TauntPulseState } from "../combat/tauntPulse.js";
import { ClassAbilityActivationPulseState } from "../combat/classAbilityActivationPulse.js";
import { drawPetAbilityEffect, PetAbilityEffectState, type PetEffectView } from "../combat/petAbilityEffects.js";
import {
  damageFloaterPresentation,
  floatingFeedbackFamily,
  floatingFeedbackLabel,
  type FloatingFeedbackInput,
  type FloatingFeedbackKind
} from "../combat/damageFloaters.js";
import {
  criticalHealthFrameEmphasis,
  HEALTH_BAR_COLORS,
  HealthBarTransitionState,
  isCriticalHealth,
  wardBarPresentation,
  WORLD_HEALTH_BAR_FRAME_POINTS,
  WORLD_HEALTH_BAR_METRICS,
  WORLD_HEALTH_BAR_TONES,
  worldHealthBarTone,
  worldHealthBarVariant,
  mobHealthBarScaleX,
  type WorldHealthBarTone,
  type WorldHealthBarVariant,
  worldHealthBarOffsetBelowAnchor
} from "../combat/healthBarPresentation.js";
import {
  drawMobAttackCountdown,
  mobAttackCountdownKey,
  mobAttackCountdownScale,
  mobAttackCountdownState
} from "./mobAttackCountdown.js";
import {
  flagAccessRenderColor,
  flagTerritoryPresentationKey
} from "../flags/flagDisplay.js";
import {
  BUOY_ARTWORK_URLS,
  TERRITORY_ARTWORK_URLS
} from "./flagArtwork.js";
import {
  personalFlagColorHex,
  TERRITORY_STRUCTURE_CATALOG,
  TERRITORY_STRUCTURE_REFERENCE_HEIGHT,
  territoryStructureInteractionBounds,
  territoryStructurePieceBounds,
  territoryStructureTypeForFlag,
  territoryStructureVisual
} from "@ash-atlas/shared";
import { createTerritoryStructureRoot } from "./territoryStructureRenderer.js";
import {
  biomeTreeArtName,
  biomeTreeArtOtherStateName,
  biomeTreeArtUrl,
  createLazyTextureCache,
  treeArtBiomeAt
} from "./biomeTreeArt.js";
import { loadWorldZoneLookup, type WorldZoneLookup } from "./worldZoneLookup.js";
import { staleWhileInteractingRenderState } from "./staleOverlayState.js";
import { FISHING_HUT_ARTWORK_URL } from "./fishingArtwork.js";
import { ensureRetainedEntity } from "./retainedEntityMap.js";
import { LazyTextureSlots } from "./lazyTextureSlots.js";
import { mobArtworkKeysForBiome } from "./mobArtworkPrefetch.js";
import { applyLogicalTextureSize, overlaySpriteDerivativeFor } from "./overlaySpriteDerivatives.js";
import {
  applyStaticOverlayContainerTransform,
  computeStaticOverlayContainerTransform,
  resetStaticOverlayContainerTransform,
  type StaticOverlayTransformReference
} from "./staticOverlayTransform.js";
import { overlayWalkMode, staticFollowMode } from "./followSwitches.js";
import { FALLEN_PRISON_SMOKE_COLUMN_PX, pointInsideGameplayView, visibleStaticRenderState } from "./staticOverlayVisibility.js";
import {
  flagTravelPresentationInstrumentation,
  type FlagTravelPresentationMetrics
} from "./flagTravelPresentationInstrumentation.js";
import {
  flagTravelPlayerPositionAt,
  isCurrentFlagTravelPlayerMotion,
  paddedViewportCenter,
  type FlagTravelPlayerMotionPlan,
  type ScreenPoint as FlagTravelScreenPoint
} from "./flagTravelPlayerMotion.js";
import {
  flagTravelVisibilityCleanupAt,
  flagTravelVisibilityDecision,
  type FlagTravelVisibilityTiming
} from "./flagTravelVisibilityTransition.js";
import { closedPolylineDashSegments } from "./closedPolylineDashes.js";
import {
  MOB_SPAWN_INTERACTION_ALPHA,
  mobSpawnAlpha
} from "./mobSpawnVisibility.js";
import {
  COLLECTIBLE_SPAWN_INTERACTION_ALPHA,
  CollectibleFirstAppearanceTracker
} from "./collectibleSpawnVisibility.js";
import { perfMetrics, type TextureStats } from "../perf/perfMetrics.js";
import { frameProbeOn, noteFrameProbe } from "../perf/frameProbe.js";
import { noteFrameClock } from "./frameClock.js";
import { isLegacyRenderQualityEnabled } from "../perf/renderQualityFlag.js";
import {
  overlayAntialias,
  overlayRendererResolution,
  overlayTextResolution
} from "../perf/renderQuality.js";
import {
  mergeOwnerTerritoriesWithBoundaries,
  polygonToPathCommands,
  TERRITORY_CIRCLE_SEGMENTS,
  type TerritoryClaimShape,
  type TerritoryRenderGroup
} from "../territory/territoryGeometry.js";
import type {
  PlayerRenderTimeline,
  RenderedPlayerPosition
} from "../movement/playerRenderSmoothing.js";
import { PlayerRaft, playerDisplayColorNumber } from "../players/playerSprite.js";
import { createJacketRig, type JacketRig } from "../players/jacketRig.js";
import { devStockArmourOverride, stockArmourForAppearance } from "../players/stockArmour.js";
import { FLAG_PLANT_MS, jacketGatherInput } from "../players/jacketGather.js";
import { heldSwordTexture, jacketSwordInput } from "../players/jacketSword.js";
import { swordStyleFor } from "../players/swordStyles.js";
import { setPlayerSheetRenderer } from "../players/playerSheetUpload.js";
import { localAttackHeld, localAttackInput, localMoveInput } from "../movement/localMoveInput.js";
import {
  applyPlayerGathering,
  flagBuildArtFromTextures,
  gatheringToolAssetKeyForDefinition,
  remoteGatheringPresentation,
  createPlayerGatheringState,
  type GatheringPresentation,
  type PlayerGatheringState
} from "../players/gatheringPresentation.js";
import {
  GatherTargetReactions,
  collectibleAtGatherTarget,
  gatherReactionKind
} from "./gatherTargetReactions.js";
import {
  createPlayerWalkMotionState,
  observePlayerWalkMotion,
  type PlayerWalkMotionState
} from "./playerWalkMotion.js";
import { gameplayMapDetailAlphaForZoom } from "./mapZoomConfig.js";
import { groundScaleZoom, mapGroundScaleZoom, safeCosLatitude } from "./groundScaleZoom.js";
import { globeOverlayOpacityForMap } from "./globeOcclusion.js";
import {
  SPRITE_BASE_ZOOM,
  SPRITE_PRESENTATION,
  combatChestLiftPx,
  combatChestPointInto,
  itemSpritePresentationForArtwork,
  playerMapPresentationForZoom,
  spriteHeightForZoom,
  spriteHorizontalScale,
  spriteLayoutForZoom,
  staticSpriteLocalScaleDuringTransform,
  textureScaleForHeight,
  worldGroundItemVisualHeight,
  type SpritePresentation
} from "./spritePresentation.js";
import { MOB_SPRITE_PRESENTATION as CANONICAL_MOB_SPRITE_PRESENTATION } from "./mobSpritePresentation.js";
import cityBlueprintUrl from "../assets/city-construction/blueprint.png";
import cityFoundationUrl from "../assets/city-construction/foundation.png";
import cityFramingUrl from "../assets/city-construction/framing.png";
import cityHallSpriteUrl from "../assets/structures/city-hall.png";
import goblinHallSpriteUrl from "../assets/goblins/goblin-hall.png";
import goblinMarketSpriteUrl from "../assets/goblins/goblin-market.png";
import kingdomSeatSpriteUrl from "../assets/structures/kingdom-seat.png";
import manorSpriteUrl from "../assets/structures/manor.png";
import greenhouseSpriteUrl from "../assets/structures/greenhouse.png";
import furnaceMarkerUrl from "../assets/structures/furnace.png";
import tannerySpriteUrl from "../assets/structures/tannery.png";
import poisonStatusUrl from "../assets/status-effects/poison.png";
import gloomStatusUrl from "../assets/status-effects/gloom.png";
import burningStatusUrl from "../assets/status-effects/burning.png";
import stormStatusUrl from "../assets/status-effects/storm.png";
import exposedStatusUrl from "../assets/status-effects/exposed.png";
import iceSlowStatusUrl from "../assets/status-effects/ice-slow.png";
import quarrySignStatusUrl from "../assets/status-effects/quarry-sign.svg";
import weakenedStatusUrl from "../assets/status-effects/weakened.png";
import worldTargetAnchorMarkerUrl from "../assets/world-target-anchor-marker.png";
import treeSpriteUrl from "../assets/tree.png";
import resinTreeSpriteUrl from "../assets/ResinTree1.png";
import givingSaplingStage1Url from "../assets/GivingSaplingStage1.png";
import givingSaplingStage2Url from "../assets/GivingSaplingStage2.png";
import givingSaplingStage3Url from "../assets/GivingSaplingStage3.png";
import willowTreeSpriteUrl from "../assets/willow-tree.png";
import chinesePistacheSpriteUrl from "../assets/chinese-pistache.png";
import wildFlaxSpriteUrl from "../assets/wild-flax.png";
import stoneMineSpriteUrl from "../assets/stone-mine.png";
import coalMineSpriteUrl from "../assets/coal-mine.png";
import ironMineSpriteUrl from "../assets/iron-mine.png";
import sulfurMineSpriteUrl from "../assets/sulfur-mine.png";
import cityHouseSpriteUrl from "../assets/structures/city-house.png";
import cityKennelSpriteUrl from "../assets/structures/city-kennel.png";
import cityMarketSpriteUrl from "../assets/structures/city-market.png";
import cityMonumentForestrySpriteUrl from "../assets/structures/city-monument-forestry.png";
import cityMonumentHuntingSpriteUrl from "../assets/structures/city-monument-hunting.png";
import cityMonumentMiningSpriteUrl from "../assets/structures/city-monument-mining.png";
import citySalonSpriteUrl from "../assets/structures/city-salon.png";
import cisternWarrensSpriteUrl from "../assets/structures/cistern-warrens.png";
import cityWarehouseSpriteUrl from "../assets/structures/city-warehouse.png";
import mayorHouseSpriteUrl from "../assets/structures/mayor-house.png";
import oilWellSpriteUrl from "../assets/structures/OilWell1.png";
import { resourceDisplayName } from "../collectibles/harvest.js";
import { ITEM_ARTWORK_URLS, itemArtworkSource } from "../ui/ItemArtwork.js";
import {
  MOB_ARTWORK_URLS,
  mobArtworkKey,
  type MobArtworkKey
} from "./mobArtwork.js";
import { PET_TEXTURE_URLS, petPresentationKey, petTextureKey, type PetTextureKey } from "../petArtwork.js";
import { mobVisualDescriptor } from "./mobSpriteSources.js";
import {
  createAnimationFrameLoop,
  paintMapSynchronizedOverlayFrame,
  paintSynchronizedOverlayFrame
} from "./animationFrameLoop.js";
export { mobArtworkKey } from "./mobArtwork.js";
import {
  prioritizeWorldObjectPicks,
  worldObjectPickPosition,
  type WorldObjectPickCandidate
} from "./worldObjectPickPriority.js";
import { currentWorldTargetAnchor } from "./worldTargetAnchor.js";
import { siegeTargetFlagIds, siegeFacingTarget } from "./militaryTargetPresentation.js";
import {
  formatWaypointDistance,
  waypointArrowTriangle,
  waypointBearingDegrees,
  waypointDistanceMeters
} from "../mapMarkers/waypointModel.js";

const WORLD_TARGET_ANCHOR_MARKER_SIZE_PX = 28;

const ORC_CAVE_ENTRANCE_FALLBACK_URL = "/assets/dungeons/shared/orc-cave-entrance.png";


export type PixiGameOverlay = {
  update(state: RenderState): void;
  paintCurrentFrame(): boolean;
  settleCurrentFrame(): Promise<boolean>;
  setMobPresentationReady(ready: boolean): void;
  /** Where a mob is drawn now (action-combat swing prediction tests the arc against this). */
  renderedMobPosition(entityId: string): LatLon | null;
  reconcileLocalPlayer(): boolean;
  /** Test readout: the local player's drawn artwork height in CSS px, or null when it is not drawn. */
  localPlayerArtworkHeightPx(): number | null;
  setPendingSelection(selection: WorldMapSelectionState | null): void;
  setViewportInteractionActive(active: boolean): void;
  setProgrammaticCameraMoveActive(active: boolean): void;
  beginFlagTravelPresentation(
    destinationFlagId?: string | null,
    destinationPlayer?: LatLon,
    destinationAnchor?: LatLon,
    destinationCurrentFlagId?: string | null
  ): FlagTravelPresentationCapture;
  startFlagTravelPlayerMotion(input: Readonly<{
    captureId: number;
    cameraGeneration: number;
    startedAtMs: number;
    durationMs: number;
    easing: (progress: number) => number;
  }>): boolean;
  startFlagTravelVisibilityTransition(
    captureId: number,
    startedAtMs: number,
    durationMs: number
  ): boolean;
  clearFlagTravelVisibilityTransition(): void;
  updateFlagTravelTransform(cameraGeneration: number | null): void;
  completeFlagTravelPlayerMotion(cameraGeneration: number): boolean;
  commitFlagTravelDestination(): boolean;
  cancelFlagTravelPresentation(capture: FlagTravelPresentationCapture): void;
  flagTravelPresentationMetrics(): FlagTravelPresentationMetrics;
  setRenderingActive(active: boolean): void;
  /**
   * Runs at the start of every animation frame, before anything is projected. It returns true when it moved the camera, and
   * the overlay then renders the map synchronously, so the camera, the MapLibre canvas and the sprites all show one frame.
   */
  setPreFrameHook(hook: ((nowMs: number) => boolean) | null): void;
  isRenderingActive(): boolean;
  resizeViewport(): void;
  markMapTransformDirty(): void;
  /** A programmatic (follow) camera move ended: reuse the drawn static geometry by translating it; redraw only when data changes, the drift grows, or at settle. */
  markFollowTransformDirty(): void;
  pickMilitaryGroupAt(point: { x: number; y: number }): MilitaryUnitGroupSnapshot | null;
  /** Another player's War Camp under the point, if any. */
  pickWarCampAt(point: { x: number; y: number }): WarCampSnapshot | null;
  pickFlagAt(point: { x: number; y: number }): FlagSnapshot | null;
  pickCityAt(point: { x: number; y: number }): CitySnapshot | null;
  pickCityStructureAt(point: { x: number; y: number }): CityStructureSnapshot | null;
  pickDungeonEntranceAt(point: { x: number; y: number }): DungeonEntranceSnapshot | null;
  pickManorAt(point: { x: number; y: number }): ManorWorldSnapshot | null;
  pickGreenhouseAt(point: { x: number; y: number }): GreenhouseSnapshot | null;
  pickFurnaceAt(point: { x: number; y: number }): FurnaceWorldSnapshot | null;
  pickTanneryAt(point: { x: number; y: number }): TanneryWorldSnapshot | null;
  pickLoomAt(point: { x: number; y: number }): LoomWorldSnapshot | null;
  pickKitchenAt(point: { x: number; y: number }): KitchenWorldSnapshot | null;
  pickFishingHutAt(point: { x: number; y: number }): FishingHutWorldSnapshot | null;
  /** Id of the player-planted sapling or grown player tree under the point, if any. */
  pickSaplingAt(point: { x: number; y: number }): string | null;
  pickCollectibleAt(point: { x: number; y: number }): CollectibleNode | null;
  pickDroppedItemAt(point: { x: number; y: number }): DroppedItemSnapshot | null;
  pickPlayerAt(point: { x: number; y: number }): PlayerSnapshot | null;
  pickCombatEntityAt(point: { x: number; y: number }): CombatEntitySnapshot | null;
  /** Resolves true once the interior space's room textures are ready. */
  whenInteriorReady(spaceKey: string): Promise<boolean>;
  pickWorldObjectsAt(
    point: { x: number; y: number },
    assistancePaddingPx?: number
  ): WorldObjectPick[];
  setMultiTargetHighlights(targets: readonly WorldObjectPick[], activeKey: string | null): void;
  /** Dev-only: draw every combatant's ground hurt circle (docs/plans/hurt-circles.md). Off by default. */
  setHurtCircleDebug(enabled: boolean): void;
  /** Pet tracking result: a pulsing pin on the map for about a minute. */
  showPetPing(ping: Readonly<{ lat: number; lon: number }>): void;
  enqueueCombatEvents(events: readonly CombatEvent[]): void;
  enqueueCombatAncillaryEvents?(events: readonly CombatEvent[]): void;
  enqueueFloatingFeedback(feedback: FloatingFeedbackInput): void;
  /** Short crumble / fade for flags broken by a territory collapse wave. */
  enqueueFlagCollapse(flags: readonly Readonly<{ id: string; lat: number; lon: number; claimRadiusM: number }>[]): void;
  enqueueResourceGain(gain: ResourceGain): void;
  /** The node being harvested; its position becomes the origin of the gain that follows. */
  noteHarvestTarget?(nodeId: string): void;
  removeCombatTargets(entityIds: readonly string[]): void;
  clearCombatFeedback(): void;
  retainedDynamicObjectCount(): number;
  staticMarkerMetrics(): Readonly<{
    created: number;
    updated: number;
    retained: number;
    destroyed: number;
  }>;
  destroy(): void;
};

export type FlagTravelPresentationCapture = Readonly<{
  id: number;
  newlyFrozen: boolean;
}>;

export type { WorldObjectPick } from "./worldObjectPickContracts.js";
import { worldObjectPickKey, type WorldObjectPick } from "./worldObjectPickContracts.js";
import { dungeonEliteMapLabel } from "../features/interiorMap/dungeonElitePresentation.js";

export {
  createAnimationFrameLoop,
  paintMapSynchronizedOverlayFrame,
  paintSynchronizedOverlayFrame,
  startAnimationFrameLoop
} from "./animationFrameLoop.js";
export type { AnimationFrameLoop } from "./animationFrameLoop.js";

export type ManorHitBox = ScreenHitBox & { manor: ManorWorldSnapshot };

type GreenhouseHitBox = ScreenHitBox & { greenhouse: GreenhouseSnapshot };

type FurnaceHitBox = ScreenHitBox & { furnace: FurnaceWorldSnapshot };

type TanneryHitBox = ScreenHitBox & {
  tannery: TanneryWorldSnapshot;
};

type LoomHitBox = ScreenHitBox & {
  loom: LoomWorldSnapshot;
};

type KitchenHitBox = ScreenHitBox & { kitchen: KitchenWorldSnapshot };

type FishingHutHitBox = ScreenHitBox & { fishingHut: FishingHutWorldSnapshot };

export type CollectibleHitBox = ScreenHitBox & { collectible: CollectibleNode };

type CombatEntityHitBox = ScreenHitBox & {
  entity: CombatEntitySnapshot;
  x: number;
  y: number;
};

const DEFAULT_WORLD_MULTI_SELECT_PADDING_PX = 12;
const SPRITE_HITBOX_PADDING_PX = 6;

export const PLAYER_BASE_ZOOM = SPRITE_BASE_ZOOM;
export const PLAYER_BASE_HEIGHT_PX = SPRITE_PRESENTATION.player.baseHeightPx;
export const PLAYER_MIN_HEIGHT_PX = SPRITE_PRESENTATION.player.minHeightPx;
export const PLAYER_MAX_HEIGHT_PX = SPRITE_PRESENTATION.player.maxHeightPx;
export const PLAYER_ZOOM_SCALE_STRENGTH = SPRITE_PRESENTATION.player.zoomStrength;
export const WIDE_ZOOM_LOD_BELOW = 10;
const MIN_DRAWN_SPRITE_HEIGHT_PX = 6;
export const PERSISTENT_WORLD_DETAIL_HIDDEN_ZOOM = 13;
export const PERSISTENT_WORLD_DETAIL_FULL_OPACITY_ZOOM = 13.5;
export function persistentWorldDetailAlphaForZoom(zoom: number): number {
  const progress = Math.max(0, Math.min(
    1,
    (zoom - PERSISTENT_WORLD_DETAIL_HIDDEN_ZOOM) /
      (PERSISTENT_WORLD_DETAIL_FULL_OPACITY_ZOOM -
        PERSISTENT_WORLD_DETAIL_HIDDEN_ZOOM)
  ));
  return progress * progress * (3 - 2 * progress);
}
export const FLAG_MARKER_HEIGHT_PX = TERRITORY_STRUCTURE_REFERENCE_HEIGHT;
export const FLAG_MARKER_HIT_RADIUS_PX = SPRITE_PRESENTATION.flag.hitGeometry.shape === "circle"
  ? SPRITE_PRESENTATION.flag.hitGeometry.radiusPx
  : 24;
export const KINGDOM_SEAT_MARKER_SIZE_PX = 140;
export const KINGDOM_SEAT_HIT_RADIUS_PX = SPRITE_PRESENTATION.kingdomSeat.hitGeometry.shape === "circle"
  ? SPRITE_PRESENTATION.kingdomSeat.hitGeometry.radiusPx
  : 58;
const salonHitGeometry = WORLD_PNG_PRESENTATION.cityStructures.salon.hitGeometry;
export const SALON_STRUCTURE_HIT_RADIUS_PX = salonHitGeometry.shape === "circle"
  ? salonHitGeometry.radiusPx
  : 0;
export const SALON_STRUCTURE_HIT_CENTER_Y_PX =
  (salonHitGeometry.centerY - WORLD_PNG_PRESENTATION.cityStructures.salon.anchorY) *
  WORLD_PNG_PRESENTATION.cityStructures.salon.height;
export const MOB_SPRITE_PRESENTATION = {
  ...CANONICAL_MOB_SPRITE_PRESENTATION,
  xoral: CANONICAL_MOB_SPRITE_PRESENTATION.xoral
} as const;

export const WORLD_SPRITE_PRESENTATION = {
  flag: SPRITE_PRESENTATION.flag,
  buoy: SPRITE_PRESENTATION.buoy,
  city: SPRITE_PRESENTATION.city,
  kingdomSeat: SPRITE_PRESENTATION.kingdomSeat,
  tree: SPRITE_PRESENTATION.tree,
  resinTree: SPRITE_PRESENTATION.tree,
  willowTree: SPRITE_PRESENTATION.willowTree,
  chinesePistache: SPRITE_PRESENTATION.chinesePistache,
  flax: SPRITE_PRESENTATION.flax,
  stoneMine: SPRITE_PRESENTATION.stoneMine,
  coalMine: SPRITE_PRESENTATION.coalMine,
  ironMine: SPRITE_PRESENTATION.ironMine,
  sulfurMine: SPRITE_PRESENTATION.sulfurMine,
  stone: itemSpritePresentationForArtwork("stone"),
  coal: itemSpritePresentationForArtwork("coal"),
  iron: itemSpritePresentationForArtwork("iron"),
  sulfur: itemSpritePresentationForArtwork("sulfur"),
  slag: itemSpritePresentationForArtwork("slag"),
  iron_bar: itemSpritePresentationForArtwork("iron_bar"),
  wood: itemSpritePresentationForArtwork("wood"),
  leather: itemSpritePresentationForArtwork("leather"),
  flax_fiber: itemSpritePresentationForArtwork("flax_fiber"),
  cloth: itemSpritePresentationForArtwork("cloth"),
  food: itemSpritePresentationForArtwork("food"),
  ore: itemSpritePresentationForArtwork("ore"),
  water: itemSpritePresentationForArtwork("water"),
  giving_berry: itemSpritePresentationForArtwork("giving_berry"),
  balsam_resin: itemSpritePresentationForArtwork("balsam_resin"),
  crude_oil: itemSpritePresentationForArtwork("crude_oil"),
  jellyfish_venom: itemSpritePresentationForArtwork("jellyfish_venom"),
  atlas_shrine_shard: itemSpritePresentationForArtwork("atlas_shrine_shard"),
  deer_hide: itemSpritePresentationForArtwork("deer_hide"),
  hog_hide: itemSpritePresentationForArtwork("hog_hide"),
  wolf_pelt: itemSpritePresentationForArtwork("wolf_pelt"),
  bear_hide: itemSpritePresentationForArtwork("bear_hide"),
  alligator_hide: itemSpritePresentationForArtwork("alligator_hide"),
  venomsteel_bar: itemSpritePresentationForArtwork("venomsteel_bar"),
  venomsteel_core: itemSpritePresentationForArtwork("venomsteel_core"),
  gold: itemSpritePresentationForArtwork("gold"),
  pack: itemSpritePresentationForArtwork("pack"),
  generic: itemSpritePresentationForArtwork("generic")
} as const;

const staticSpritePresentationKey = Symbol("staticSpritePresentation");
const staticSpriteCommittedScaleKey = Symbol("staticSpriteCommittedScale");
const staticLabelLayoutKey = Symbol("staticLabelLayout");
type ZoomScaledDisplay = Container & {
  [staticSpritePresentationKey]?: SpritePresentation;
  [staticSpriteCommittedScaleKey]?: number;
  [staticLabelLayoutKey]?: (zoom: number) => void;
};

export const DROPPED_ITEM_HIT_RADIUS_PX = 18;
// Text keeps a fixed 2x raster so world labels stay crisp without forcing the whole renderer
// above the screen's real pixel density (see perf/renderQuality.ts for the legacy switch).
export const OVERLAY_RENDER_RESOLUTION = overlayTextResolution();
// Renderer backbuffer density: never above 2x, and never above the device's DPR.
export const OVERLAY_RENDERER_RESOLUTION = overlayRendererResolution();

const LOCAL_APPEARANCE_SETTLE_BUDGET_MS = 500;
const KINGDOM_SEAT_RUBBLE_TINT = 0x5f5850;
export const FLAG_BURNING_ARTWORK_OFFSET_Y_PX = territoryStructureVisual("bastion_flag").attachments.burning.y;
export const FLAG_KINGDOM_EMBLEM_ARTWORK_Y_PX = territoryStructureVisual("bastion_flag").attachments.emblem.y;

/**
 * Default overlay loader. Large sources load their build-time 1024 px derivative with mipmaps and keep
 * presenting at the source art's size, so on-screen sizes and hit boxes do not change. When the
 * derivative is missing or fails, the full-size source loads as before (no placeholder).
 */
export async function loadOverlayTexture(url: string): Promise<Texture> {
  const derivative = overlaySpriteDerivativeFor(url);
  if (derivative) {
    try {
      const texture = await Assets.load<Texture>({ src: derivative.url, data: { autoGenerateMipmaps: true } });
      if (texture) {
        applyLogicalTextureSize(texture, derivative.width, derivative.height);
        return texture;
      }
    } catch {
      // Fall through to the full-size source.
    }
  }
  return loadPixiTexture(url);
}

export async function loadPresentationTexture(
  src: string,
  loader: (source: string) => Promise<Texture> = loadOverlayTexture,
  fallback: Texture = Texture.WHITE,
  onFailure: (source: string, error: unknown) => void = (source, error) =>
    console.warn("World presentation texture could not be loaded; using a fallback.", {
      source,
      error
    })
): Promise<Texture> {
  try {
    return await loader(src);
  } catch (error) {
    onFailure(src, error);
    return fallback;
  }
}

export function dungeonEntranceAssetUrl(assetKey: string | null | undefined): string | null {
  if (!assetKey) return null;
  const normalized = assetKey.replaceAll("\\", "/");
  const publicPrefix = "apps/client/public";
  if (normalized.startsWith(`${publicPrefix}/`)) {
    return normalized.slice(publicPrefix.length);
  }
  return normalized.startsWith("/assets/") ? normalized : null;
}

export async function settleWithinBudget(
  pending: Promise<unknown>,
  maxWaitMs: number
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      pending.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(0, maxWaitMs));
      })
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

/**
 * The mob ids that should have a sprite this frame. Adds them to `out` (default: a new set) and returns it, so the per-frame
 * caller passes its scratch set instead of allocating a Set and two arrays every frame.
 */
export function desiredMobIdsForPresentation(
  presentationReady: boolean,
  authoritativeEntities: readonly Pick<
    CombatEntitySnapshot,
    "entityId" | "kind" | "companion" | "npcFaction" | "undead"
  >[],
  retainedEntities: Iterable<Readonly<{
    entityId: string;
    kind: "player" | "mob";
  }>>,
  out: Set<string> = new Set()
): Set<string> {
  if (presentationReady) {
    for (const entity of authoritativeEntities) {
      if (entity.kind === "mob") out.add(entity.entityId);
    }
    return out;
  }
  for (const entity of retainedEntities) {
    if (entity.kind === "mob") out.add(entity.entityId);
  }
  for (const entity of authoritativeEntities) {
    if (entity.kind === "mob" && (entity.companion || entity.npcFaction || entity.undead)) {
      out.add(entity.entityId);
    }
  }
  return out;
}

export const SPRITE_ARTWORK_URLS = {
  ...MOB_ARTWORK_URLS,
  tree: treeSpriteUrl,
  resinTree: resinTreeSpriteUrl,
  willowTree: willowTreeSpriteUrl,
  chinesePistache: chinesePistacheSpriteUrl,
  flax: wildFlaxSpriteUrl,
  stoneMine: stoneMineSpriteUrl,
  coalMine: coalMineSpriteUrl,
  ironMine: ironMineSpriteUrl,
  sulfurMine: sulfurMineSpriteUrl,
  stone: ITEM_ARTWORK_URLS.stone,
  coal: ITEM_ARTWORK_URLS.coal,
  iron: ITEM_ARTWORK_URLS.iron,
  sulfur: ITEM_ARTWORK_URLS.sulfur,
  slag: ITEM_ARTWORK_URLS.slag,
  iron_bar: ITEM_ARTWORK_URLS.iron_bar,
  wood: ITEM_ARTWORK_URLS.wood,
  leather: ITEM_ARTWORK_URLS.leather,
  flax_fiber: ITEM_ARTWORK_URLS.flax_fiber,
  cloth: ITEM_ARTWORK_URLS.cloth,
  food: ITEM_ARTWORK_URLS.food,
  freshwater_fish: ITEM_ARTWORK_URLS.freshwater_fish,
  ashen_fish: ITEM_ARTWORK_URLS.ashen_fish,
  ore: ITEM_ARTWORK_URLS.ore,
  water: ITEM_ARTWORK_URLS.water,
  giving_berry: ITEM_ARTWORK_URLS.giving_berry,
  balsam_resin: ITEM_ARTWORK_URLS.balsam_resin,
  crude_oil: ITEM_ARTWORK_URLS.crude_oil,
  jellyfish_venom: ITEM_ARTWORK_URLS.jellyfish_venom,
  atlas_shrine_shard: ITEM_ARTWORK_URLS.atlas_shrine_shard
} as const;

/** Keyed by MobArtworkKey, so a new mob's PNG needs no edit here. */
type MobTextures = Record<MobArtworkKey, Texture> & Record<PetTextureKey, Texture>;

type WorldTextures = Record<string, Texture> & {
  tree: Texture;
  resinTree: Texture;
  willowTree: Texture;
  chinesePistache: Texture;
  flax: Texture;
  stoneMine: Texture;
  coalMine: Texture;
  ironMine: Texture;
  sulfurMine: Texture;
  stone: Texture;
  coal: Texture;
  iron: Texture;
  sulfur: Texture;
  slag: Texture;
  iron_bar: Texture;
  wood: Texture;
  leather: Texture;
  flax_fiber: Texture;
  cloth: Texture;
  food: Texture;
  ore: Texture;
  water: Texture;
  giving_berry: Texture;
  balsam_resin: Texture;
  crude_oil: Texture;
  jellyfish_venom: Texture;
  atlas_shrine_shard: Texture;
  deer_hide: Texture;
  hog_hide: Texture;
  wolf_pelt: Texture;
  bear_hide: Texture;
  alligator_hide: Texture;
};

type CityStructureTextures = Readonly<
  Omit<Record<ActiveCityStructureType, Texture>, "monument" | "quartz_hut" | "library"> &
  Record<"monument_mining" | "monument_forestry" | "monument_hunting" | "goblin_market" | "burning", Texture>
>;
type HarmfulStatusTextures = Record<HarmfulStatusId, Texture>;

export function kingdomSeatMarkerAlpha(
  constructionState: FlagSnapshot["kingdomSeatConstructionState"]
): number {
  return constructionState === "under_construction" ? 0.58 : 1;
}

export function kingdomSeatMarkerPosition(
  flag: Pick<FlagSnapshot, "lat" | "lon" | "kingdomSeatLat" | "kingdomSeatLon">
): { lat: number; lon: number } {
  return {
    lat: flag.kingdomSeatLat ?? flag.lat,
    lon: flag.kingdomSeatLon ?? flag.lon
  };
}

export function playerSpriteHeightForZoom(currentZoom: number): number {
  return spriteHeightForZoom(currentZoom, PLAYER_BASE_ZOOM, SPRITE_PRESENTATION.player);
}

export async function createPixiOverlay(
  map: maplibregl.Map,
  container: HTMLElement,
  combatStore: CombatStore | undefined,
  playerRenderTimeline: PlayerRenderTimeline,
  synchronizedNow: () => number = Date.now,
  combatPresentation?: CombatPresentationController
): Promise<PixiGameOverlay> {
  const app = new Application();
  await app.init({
    resizeTo: container,
    backgroundAlpha: 0,
    antialias: overlayAntialias(),
    autoDensity: true,
    resolution: OVERLAY_RENDERER_RESOLUTION,
    roundPixels: false,
    // Keep Pixi's paint in the same frame as our coordinate updates. An
    // independent ticker can composite stale screen-space geometry for one
    // frame while MapLibre is touch-panning underneath it.
    autoStart: false,
    sharedTicker: false
  });
  app.stop();
  app.ticker.stop();
  // Jacket B sheet pages upload one per frame once loaded, not on the frame a clip first draws them.
  setPlayerSheetRenderer(app.renderer);
  map.on("render", () => { if (frameProbeOn()) noteFrameProbe("m", map, null); });
  // Mob and dog art loads from the URL catalogs, so adding a mob PNG needs
  // no edit here. Optional (not yet bundled) art falls back to a blank texture.
  const loadLinearTextures = async <Key extends string>(
    urls: Readonly<Record<Key, string | null>>
  ): Promise<Record<Key, Texture>> => Object.fromEntries(await Promise.all(
    (Object.entries(urls) as [Key, string | null][]).map(async ([key, url]) => {
      if (!url) return [key, Texture.WHITE] as const;
      const texture = await loadPresentationTexture(url);
      if (texture !== Texture.WHITE) texture.source.scaleMode = "linear";
      return [key, texture] as const;
    })
  )) as Record<Key, Texture>;
  const dogTexturesLoading = loadLinearTextures(PET_TEXTURE_URLS);
  const saplingStageTexturesLoading = loadLinearTextures(GIVING_SAPLING_STAGE_URLS);
  const [
    cityBlueprintTexture,
    cityFoundationTexture,
    cityFramingTexture,
    cityHallTexture,
    goblinHallTexture,
    kingdomSeatTexture,
    manorTexture,
    greenhouseTexture,
    furnaceMarkerTexture,
    tanneryTexture,
    treeTexture,
    resinTreeTexture,
    willowTreeTexture,
    chinesePistacheTexture,
    flaxTexture,
    stoneMineTexture,
    coalMineTexture,
    ironMineTexture,
    sulfurMineTexture,
    stoneTexture,
    coalTexture,
    ironTexture,
    sulfurTexture,
    ironBarTexture,
    slagTexture,
    woodTexture,
    leatherTexture,
    flaxFiberTexture,
    clothTexture,
    deerHideTexture,
    hogHideTexture,
    wolfPeltTexture,
    bearHideTexture,
    alligatorHideTexture,
    foodTexture,
    oreTexture,
    waterTexture,
    givingBerryTexture,
    balsamResinTexture,
    crudeOilTexture,
    jellyfishVenomTexture,
    atlasShrineShardTexture,
    buoyColorTexture,
    buoyHardwareTexture,
    cityHouseTexture,
    oilWellTexture,
    cityKennelTexture,
    cityMarketTexture,
    goblinMarketTexture,
    cityMonumentMiningTexture,
    cityMonumentForestryTexture,
    cityMonumentHuntingTexture,
    citySalonTexture,
    cisternWarrensTexture,
    cityWarehouseTexture,
    orcCaveEntranceTexture,
    mayorHouseTexture,
    poisonStatusTexture,
    gloomStatusTexture,
    burningStatusTexture,
    stormStatusTexture,
    exposedStatusTexture,
    iceSlowStatusTexture,
    quarrySignStatusTexture,
    weakenedStatusTexture,
    worldTargetAnchorMarkerTexture
  ] = await Promise.all([
    loadPresentationTexture(cityBlueprintUrl),
    loadPresentationTexture(cityFoundationUrl),
    loadPresentationTexture(cityFramingUrl),
    loadPresentationTexture(cityHallSpriteUrl),
    loadPresentationTexture(goblinHallSpriteUrl),
    loadPresentationTexture(kingdomSeatSpriteUrl),
    loadPresentationTexture(manorSpriteUrl),
    loadPresentationTexture(greenhouseSpriteUrl),
    loadPresentationTexture(furnaceMarkerUrl),
    loadPresentationTexture(tannerySpriteUrl),
    loadPresentationTexture(treeSpriteUrl),
    loadPresentationTexture(resinTreeSpriteUrl),
    loadPresentationTexture(willowTreeSpriteUrl),
    loadPresentationTexture(chinesePistacheSpriteUrl),
    loadPresentationTexture(wildFlaxSpriteUrl),
    loadPresentationTexture(stoneMineSpriteUrl),
    loadPresentationTexture(coalMineSpriteUrl),
    loadPresentationTexture(ironMineSpriteUrl),
    loadPresentationTexture(sulfurMineSpriteUrl),
    loadPresentationTexture(ITEM_ARTWORK_URLS.stone),
    loadPresentationTexture(ITEM_ARTWORK_URLS.coal),
    loadPresentationTexture(ITEM_ARTWORK_URLS.iron),
    loadPresentationTexture(ITEM_ARTWORK_URLS.sulfur),
    loadPresentationTexture(ITEM_ARTWORK_URLS.iron_bar),
    loadPresentationTexture(ITEM_ARTWORK_URLS.slag),
    loadPresentationTexture(ITEM_ARTWORK_URLS.wood),
    loadPresentationTexture(ITEM_ARTWORK_URLS.leather),
    loadPresentationTexture(ITEM_ARTWORK_URLS.flax_fiber),
    loadPresentationTexture(ITEM_ARTWORK_URLS.cloth),
    loadPresentationTexture(ITEM_ARTWORK_URLS.deer_hide),
    loadPresentationTexture(ITEM_ARTWORK_URLS.hog_hide),
    loadPresentationTexture(ITEM_ARTWORK_URLS.wolf_pelt),
    loadPresentationTexture(ITEM_ARTWORK_URLS.bear_hide),
    loadPresentationTexture(ITEM_ARTWORK_URLS.alligator_hide),
    loadPresentationTexture(ITEM_ARTWORK_URLS.food),
    loadPresentationTexture(ITEM_ARTWORK_URLS.ore),
    loadPresentationTexture(ITEM_ARTWORK_URLS.water),
    loadPresentationTexture(ITEM_ARTWORK_URLS.giving_berry),
    loadPresentationTexture(ITEM_ARTWORK_URLS.balsam_resin),
    loadPresentationTexture(ITEM_ARTWORK_URLS.crude_oil),
    loadPresentationTexture(ITEM_ARTWORK_URLS.jellyfish_venom),
    loadPresentationTexture(ITEM_ARTWORK_URLS.atlas_shrine_shard),
    loadPresentationTexture(BUOY_ARTWORK_URLS.color),
    loadPresentationTexture(BUOY_ARTWORK_URLS.hardware),
    loadPresentationTexture(cityHouseSpriteUrl),
    loadPresentationTexture(oilWellSpriteUrl),
    loadPresentationTexture(cityKennelSpriteUrl),
    loadPresentationTexture(cityMarketSpriteUrl),
    loadPresentationTexture(goblinMarketSpriteUrl),
    loadPresentationTexture(cityMonumentMiningSpriteUrl),
    loadPresentationTexture(cityMonumentForestrySpriteUrl),
    loadPresentationTexture(cityMonumentHuntingSpriteUrl),
    loadPresentationTexture(citySalonSpriteUrl),
    loadPresentationTexture(cisternWarrensSpriteUrl),
    loadPresentationTexture(cityWarehouseSpriteUrl),
    loadPresentationTexture(ORC_CAVE_ENTRANCE_FALLBACK_URL),
    loadPresentationTexture(mayorHouseSpriteUrl),
    loadPresentationTexture(poisonStatusUrl),
    loadPresentationTexture(gloomStatusUrl),
    loadPresentationTexture(burningStatusUrl),
    loadPresentationTexture(stormStatusUrl),
    loadPresentationTexture(exposedStatusUrl),
    loadPresentationTexture(iceSlowStatusUrl),
    loadPresentationTexture(quarrySignStatusUrl),
    loadPresentationTexture(weakenedStatusUrl),
    loadPresentationTexture(worldTargetAnchorMarkerUrl)
  ]);
  for (const texture of [
    cityBlueprintTexture,
    cityFoundationTexture,
    cityFramingTexture,
    cityHallTexture,
    goblinHallTexture,
    kingdomSeatTexture,
    manorTexture,
    greenhouseTexture,
    furnaceMarkerTexture,
    tanneryTexture,
    treeTexture,
    resinTreeTexture,
    willowTreeTexture,
    chinesePistacheTexture,
    flaxTexture,
    stoneMineTexture,
    coalMineTexture,
    ironMineTexture,
    sulfurMineTexture,
    stoneTexture,
    coalTexture,
    ironTexture,
    sulfurTexture,
    ironBarTexture,
    woodTexture,
    leatherTexture,
    flaxFiberTexture,
    clothTexture,
    deerHideTexture,
    hogHideTexture,
    wolfPeltTexture,
    bearHideTexture,
    alligatorHideTexture,
    foodTexture,
    oreTexture,
    waterTexture,
    givingBerryTexture,
    balsamResinTexture,
    crudeOilTexture,
    jellyfishVenomTexture,
    atlasShrineShardTexture,
    buoyColorTexture,
    buoyHardwareTexture,
    cityHouseTexture,
    oilWellTexture,
    cityKennelTexture,
    cityMarketTexture,
    goblinMarketTexture,
    cityMonumentMiningTexture,
    cityMonumentForestryTexture,
    cityMonumentHuntingTexture,
    citySalonTexture,
    cisternWarrensTexture,
    cityWarehouseTexture,
    orcCaveEntranceTexture,
    mayorHouseTexture,
    poisonStatusTexture,
    gloomStatusTexture,
    burningStatusTexture,
    stormStatusTexture,
    exposedStatusTexture,
    iceSlowStatusTexture,
    weakenedStatusTexture,
    worldTargetAnchorMarkerTexture
  ]) {
    texture.source.scaleMode = "linear";
  }
  // Each Manor type draws its own Studio-authored overworld building (the shared Manor sprite otherwise).
  const manorTypeTextures = new Map<string, Readonly<{ texture: Texture; scale: number }>>(
    (await Promise.all(MANOR_TYPES.map(async (type) => {
      const url = type.exteriorAssetKey ? clientAssetKeyUrl(type.exteriorAssetKey) : null;
      const texture = url ? await loadPresentationTexture(url) : Texture.WHITE;
      if (texture === Texture.WHITE) return null;
      texture.source.scaleMode = "linear";
      return [type.id, { texture, scale: type.exteriorScale }] as const;
    }))).filter((entry) => entry !== null)
  );
  const territoryTextures = Object.fromEntries(await Promise.all(
    [...new Set(Object.values(TERRITORY_STRUCTURE_CATALOG.packs).flatMap((pack) =>
      Object.values(pack.structures).flatMap((visual) => visual!.pieces.map((piece) => piece.asset))
    ))].map(async (asset) => {
      const url = TERRITORY_ARTWORK_URLS[asset];
      if (!url) throw new Error(`Territory PNG is not bundled: ${asset}`);
      return [asset, await loadPresentationTexture(url)] as const;
    })
  ));
  // Flag held by the local player's flag-building animation, per cloth colour.
  const flagBuildArtByColor = new Map<number, FlagBuildArt | null>();
  const localFlagBuildArt = (player: PlayerSnapshot): FlagBuildArt | null => {
    const clothColor = player.personalFlagColor
      ? hexToNumber(personalFlagColorHex(player.personalFlagColor))
      : playerDisplayColorNumber(player.displayColor);
    let art = flagBuildArtByColor.get(clothColor);
    if (art === undefined) {
      art = flagBuildArtFromTextures((asset) => territoryTextures[asset], clothColor);
      flagBuildArtByColor.set(clothColor, art);
    }
    return art;
  };
  // Mob art loads the first time a species is drawn (or is prefetched for the current biome at idle), so
  // overlay init no longer decodes every species. Mob textures stay resident: Pixi's idle GC would
  // otherwise unload them after 60 s and re-upload them on the main thread when the species returned.
  const mobTextures = { ...await dogTexturesLoading } as MobTextures;
  const mobArtworkSlots = new LazyTextureSlots((name) => {
    const texture = mobArtworkSlots.peek(name);
    if (texture) (mobTextures as Record<string, Texture>)[name] = texture;
  });
  for (const [key, url] of Object.entries(MOB_ARTWORK_URLS) as [MobArtworkKey, string | null][]) {
    if (!url) {
      (mobTextures as Record<string, Texture>)[key] = Texture.WHITE;
      continue;
    }
    mobArtworkSlots.define(key, async () => {
      const texture = await loadPresentationTexture(url);
      if (texture !== Texture.WHITE) {
        texture.source.scaleMode = "linear";
        texture.source.autoGarbageCollect = false;
      }
      return texture;
    });
  }
  let overlayDestroyed = false;
  let mobPrefetchBiome: string | null = null;
  let mobPrefetchCheckedAtMs = 0;
  let mobPrefetchQueue: MobArtworkKey[] = [];
  let mobPrefetchRunning = false;
  const whenIdle = (task: () => void): void => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(task, { timeout: 3_000 });
    else setTimeout(task, 250);
  };
  const pumpMobPrefetch = (): void => {
    if (overlayDestroyed) return;
    const key = mobPrefetchQueue.shift();
    if (!key) {
      mobPrefetchRunning = false;
      return;
    }
    void mobArtworkSlots.load(key).catch(() => undefined).then(() => whenIdle(pumpMobPrefetch));
  };
  /** Warms the species that spawn in the player's biome, one per idle slot, so first sight does not stall. */
  const prefetchBiomeMobArtwork = (lat: number, lon: number, nowMs: number): void => {
    if (!treeArtZoneLookup || nowMs - mobPrefetchCheckedAtMs < 2_000) return;
    mobPrefetchCheckedAtMs = nowMs;
    const biome = treeArtBiomeAt(treeArtZoneLookup, lat, lon);
    if (biome === mobPrefetchBiome) return;
    mobPrefetchBiome = biome;
    mobPrefetchQueue = mobArtworkKeysForBiome(biome).filter((key) => !mobArtworkSlots.peek(key));
    if (!mobPrefetchRunning && mobPrefetchQueue.length > 0) {
      mobPrefetchRunning = true;
      whenIdle(pumpMobPrefetch);
    }
  };
  const worldTextures = {
    tree: treeTexture,
    resinTree: resinTreeTexture,
    willowTree: willowTreeTexture,
    chinesePistache: chinesePistacheTexture,
    flax: flaxTexture,
    stoneMine: stoneMineTexture,
    coalMine: coalMineTexture,
    ironMine: ironMineTexture,
    sulfurMine: sulfurMineTexture,
    stone: stoneTexture,
    coal: coalTexture,
    iron: ironTexture,
    sulfur: sulfurTexture,
    iron_bar: ironBarTexture,
    slag: slagTexture,
    wood: woodTexture,
    leather: leatherTexture,
    flax_fiber: flaxFiberTexture,
    cloth: clothTexture,
    deer_hide: deerHideTexture,
    hog_hide: hogHideTexture,
    wolf_pelt: wolfPeltTexture,
    bear_hide: bearHideTexture,
    alligator_hide: alligatorHideTexture,
    food: foodTexture,
    ore: oreTexture,
    water: waterTexture,
    giving_berry: givingBerryTexture,
    balsam_resin: balsamResinTexture,
    crude_oil: crudeOilTexture,
    jellyfish_venom: jellyfishVenomTexture,
    atlas_shrine_shard: atlasShrineShardTexture,
    ...await saplingStageTexturesLoading
  } as WorldTextures;
  await Promise.all(Object.entries(ITEM_ARTWORK_URLS).map(async ([artworkKey, source]) => {
    if (worldTextures[artworkKey]) return;
    const texture = await loadPresentationTexture(source);
    texture.source.scaleMode = "linear";
    worldTextures[artworkKey] = texture;
  }));
  await Promise.all(EQUIPMENT_DEFINITION_IDS.map(async (definitionId) => {
    const texture = await loadPresentationTexture(itemArtworkSource(definitionId));
    texture.source.scaleMode = "linear";
    worldTextures[definitionId] = texture;
  }));
  await Promise.all(ENCHANTMENT_STONE_VARIANTS.map(async (variant) => {
    const texture = await loadPresentationTexture(
      itemArtworkSource("enchantment_stone", null, variant)
    );
    texture.source.scaleMode = "linear";
    worldTextures[`enchantment_stone:${variant}`] = texture;
  }));
  const loadOptionalRegisteredTexture = async (
    registrationId: string,
    fallback: Texture
  ): Promise<Texture> => {
    const registration = runtimePngAssetRegistrationById(registrationId);
    const source = registration ? runtimePngAssetUrl(registration.relativeFile) : null;
    if (!source) return fallback;
    const texture = await loadPresentationTexture(source, undefined, fallback);
    texture.source.scaleMode = "linear";
    return texture;
  };
  const [barracksTexture, demolitionFactoryTexture] =
    await Promise.all([
      loadOptionalRegisteredTexture("military-facility-barracks", cityFoundationTexture),
      loadOptionalRegisteredTexture("military-facility-demolition_factory", cityFoundationTexture)
    ]);
  const militaryUnitTextures = Object.fromEntries(
    await Promise.all(([
      "infantry",
      "archer",
      "bomber",
      "field_ballista"
    ] as const).map(async (unitType) => [
      unitType,
      await loadOptionalRegisteredTexture(`military-${unitType}`, cityFoundationTexture)
    ]))
  ) as Record<MilitaryUnitType, Texture>;
  const militaryStateTextures = {
    "military-siege-packed": await loadOptionalRegisteredTexture(
      "military-siege-packed",
      militaryUnitTextures.field_ballista
    ),
    "military-siege-deployed": await loadOptionalRegisteredTexture(
      "military-siege-deployed",
      militaryUnitTextures.field_ballista
    ),
    "military-siege-launch": await loadOptionalRegisteredTexture(
      "military-siege-launch",
      militaryUnitTextures.field_ballista
    ),
    "military-bomber-idle": await loadOptionalRegisteredTexture(
      "military-bomber-idle",
      militaryUnitTextures.bomber
    ),
    "military-bomber-planting": await loadOptionalRegisteredTexture(
      "military-bomber-planting",
      militaryUnitTextures.bomber
    ),
    "military-infantry": militaryUnitTextures.infantry,
    "military-archer": militaryUnitTextures.archer
  } as const;
  const siegeRockTexture = await loadOptionalRegisteredTexture("military-siege-rock", Texture.EMPTY);
  const bomberEscapeTexture = await loadOptionalRegisteredTexture("military-bomber-escaping", Texture.EMPTY);
  const bomberBlastTexture = await loadOptionalRegisteredTexture("military-bomber-detonation", Texture.EMPTY);
  // Registered War Camp slot; falls back to the foundation art until it is authored.
  const warCampTexture = await loadOptionalRegisteredTexture("military-war_camp", cityFoundationTexture);
  const loomTexture = await loadOptionalRegisteredTexture("loom", tanneryTexture);
  const cityStructureTextures: CityStructureTextures = {
    city_house: cityHouseTexture,
    mayor_house: mayorHouseTexture,
    oil_well: oilWellTexture,
    warehouse: cityWarehouseTexture,
    cistern_warrens: cisternWarrensTexture,
    salon: citySalonTexture,
    city_kennel: cityKennelTexture,
    market: cityMarketTexture,
    barracks: barracksTexture,
    demolition_factory: demolitionFactoryTexture,
    goblin_market: goblinMarketTexture,
    monument_mining: cityMonumentMiningTexture,
    monument_forestry: cityMonumentForestryTexture,
    monument_hunting: cityMonumentHuntingTexture,
    burning: burningStatusTexture
  };
  const dungeonEntranceTextures = new Map<string, Texture>();
  dungeonEntranceTextures.set(ORC_CAVE_ENTRANCE_FALLBACK_URL, orcCaveEntranceTexture);
  const pendingDungeonEntranceTextures = new Set<string>();
  const entranceTexture = (entrance: DungeonEntranceSnapshot): Texture => {
    const source = dungeonEntranceAssetUrl(entrance.assetKey);
    return source ? dungeonEntranceTextures.get(source) ?? orcCaveEntranceTexture : orcCaveEntranceTexture;
  };
  const harmfulStatusTextures: HarmfulStatusTextures = {
    poison: poisonStatusTexture,
    gloom: gloomStatusTexture,
    burning: burningStatusTexture,
    storm: stormStatusTexture,
    ice_slow: iceSlowStatusTexture,
    quarry_sign: quarrySignStatusTexture,
    exposed: exposedStatusTexture,
    weakened: weakenedStatusTexture,
    // Metal procs reuse existing icons until dedicated art exists.
    whetted_defense: exposedStatusTexture,
    whetted_attack: weakenedStatusTexture,
    fleet_slow: iceSlowStatusTexture,
    immobilized: iceSlowStatusTexture,
    vengeance_mark: quarrySignStatusTexture,
    // Stun reuses the exposed icon until dedicated art exists.
    stunned: exposedStatusTexture
  };
  app.canvas.className = "game-pixi-overlay";
  container.appendChild(app.canvas);
  const textureStatsProvider = (): TextureStats => {
    let bytes = 0;
    const textures = (app.renderer.texture as { managedTextures?: readonly TextureSource[] }).managedTextures ?? [];
    for (const source of textures) bytes += source.pixelWidth * source.pixelHeight * 4;
    return { count: textures.length, bytes };
  };
  perfMetrics.setTextureStatsProvider(textureStatsProvider);
  perfMetrics.setOverlayResolution(app.renderer.resolution);
  perfMetrics.registerGlCanvas(app.canvas, "pixi");

  const root = new Container();
  const gameplayWorldLayer = new Container();
  const staticLayer = new Container();
  const durableStaticUnderlay = new Container();
  const flagTravelLiveStaticLayer = new Container();
  const durableStaticMarkers = new Container();
  const territoryLayer = new Container();
  const leashLayer = new Container();
  const selectionLayer = new Container();
  const waterHighlightLayer = new Container();
  const waterHighlightGraphics = new Graphics();
  const collectibleLayer = new Container();
  const collectibleSpriteLayer = new Container();
  const collectibleGraphics = new Graphics();
  const droppedItemLayer = new Container();
  const droppedItemSpriteLayer = new Container();
  const droppedItemGraphics = new Graphics();
  const flagLayer = new Container();
  const manorLayer = new Container();
  const greenhouseLayer = new Container();
  const furnaceLayer = new Container();
  const tanneryLayer = new Container();
  const loomLayer = new Container();
  const kitchenLayer = new Container();
  const fishingHutLayer = new Container();
  const saplingLayer = new Container();
  const cityLayer = new Container();
  const cityStructureLayer = new Container();
  const dungeonEntranceLayer = new Container();
  const siegePreviewLayer = new Container();
  const cityStructureArtworkLayer = new Container();
  const cityStructureLabelLayer = new Container();
  const worldDynamicEntityLayer = new Container();
  const militaryGroupLayer = new Container();
  const bossTelegraphLayer = new Container();
  const fishingCastLayer = new Container();
  const fishingCastGraphics = new Graphics();
  const flagCollapseGraphics = new Graphics();
  fishingCastLayer.addChild(fishingCastGraphics, flagCollapseGraphics);
  const flagCollapseEffects = new Map<string, Readonly<{
    lat: number;
    lon: number;
    claimRadiusM: number;
    startedAt: number;
  }>>();
  const localPlayerLayer = new Container();
  const multiTargetHighlightLayer = new Container();
  const worldTargetAnchorMarker = new Sprite(worldTargetAnchorMarkerTexture);
  worldTargetAnchorMarker.anchor.set(0.5);
  worldTargetAnchorMarker.width = WORLD_TARGET_ANCHOR_MARKER_SIZE_PX;
  worldTargetAnchorMarker.height = WORLD_TARGET_ANCHOR_MARKER_SIZE_PX;
  worldTargetAnchorMarker.alpha = 0.75;
  worldTargetAnchorMarker.visible = false;
  const kingdomSeatLayer = new Container();
  const damageFloaterLayer = new Container();
  const projectileImpactLayer = new Container();
  const tauntPulseLayer = new Container();
  const tauntPulseGraphics = new Graphics();
  /** Slash arcs and sparks: ONE Graphics for the whole pool. */
  const swingFxGraphics = new Graphics();
  /** Ground shadows of flying projectiles (player arrows, mob shots): ONE Graphics under the projectile art. */
  const projectileShadowGraphics = new Graphics();
  /** Mob projectiles (ranged aim shots, volley lines, blast orbs) at chest height: ONE Graphics. */
  const mobProjectileGraphics = new Graphics();
  /** Player arcane blasts (staff, wand): bolts, trails and impact bursts, drawn procedurally into ONE Graphics. */
  const arcaneBlastGraphics = new Graphics();
  /** Dev-only hurt circle overlay (Developer App > Developer View), off by default: the ground circles hits use. */
  const hurtCircleGraphics = new Graphics();
  let hurtCircleDebugEnabled = false;
  /** Dev-build probe for full-app specs: the last lifted projectile points and the hurt circles drawn. */
  const hitGeometryProbe: Record<string, unknown> | null = import.meta.env.DEV
    ? ((window as unknown as { __ashHitGeometryProbe?: Record<string, unknown> }).__ashHitGeometryProbe ??= {})
    : null;
  // Declared early: a map resize during construction can call applyLiveStaticLayerTransform before the layers below exist.
  const STATIC_CORRECTION_SCALE_EPSILON = 0.005;
  const STATIC_CORRECTION_ZOOM_EPSILON = 0.01;
  const STATIC_CORRECTION_LAYERS = (): Container[] => [
    flagLayer,
    cityLayer,
    cityStructureLayer,
    manorLayer,
    greenhouseLayer,
    furnaceLayer,
    loomLayer,
    kitchenLayer,
    collectibleSpriteLayer,
    droppedItemSpriteLayer,
    kingdomSeatLayer
  ];
  const petPingGraphics = new Graphics();
  let localPlayerInvisibleUntil = 0;
  const PET_PING_DURATION_MS = 60_000;
  let petPing: { position: LatLon; startedAt: number } | null = null;
  const classAbilityActivationGraphics = new Graphics();
  const classAbilityZoneGraphics = new Graphics();
  const petAbilityEffectGraphics = new Graphics();
  tauntPulseLayer.addChild(
    petPingGraphics,
    petAbilityEffectGraphics,
    classAbilityZoneGraphics,
    classAbilityActivationGraphics,
    tauntPulseGraphics
  );
  waterHighlightLayer.addChild(waterHighlightGraphics);
  collectibleLayer.addChild(collectibleSpriteLayer, collectibleGraphics);
  droppedItemLayer.addChild(droppedItemSpriteLayer, droppedItemGraphics);
  durableStaticUnderlay.addChild(territoryLayer);
  flagTravelLiveStaticLayer.addChild(
    leashLayer,
    selectionLayer,
    waterHighlightLayer,
    collectibleLayer,
    droppedItemLayer
  );
  durableStaticMarkers.addChild(
    flagLayer,
    manorLayer,
    greenhouseLayer,
    furnaceLayer,
    tanneryLayer,
    loomLayer,
    kitchenLayer,
    fishingHutLayer,
    saplingLayer,
    cityLayer,
    cityStructureLayer,
    dungeonEntranceLayer,
    // Keep the advisory Siege chevrons above durable structure art.
    siegePreviewLayer
  );
  staticLayer.addChild(
    durableStaticUnderlay,
    flagTravelLiveStaticLayer,
    durableStaticMarkers
  );
  cityStructureLayer.addChild(
    cityStructureArtworkLayer,
    cityStructureLabelLayer
  );
  gameplayWorldLayer.addChild(
    staticLayer,
    tauntPulseLayer,
    bossTelegraphLayer,
    hurtCircleGraphics,
    fishingCastLayer,
    worldDynamicEntityLayer,
    militaryGroupLayer,
    kingdomSeatLayer
  );
  root.addChild(
    gameplayWorldLayer,
    localPlayerLayer,
    multiTargetHighlightLayer,
    projectileShadowGraphics,
    projectileImpactLayer,
    arcaneBlastGraphics,
    mobProjectileGraphics,
    swingFxGraphics,
    damageFloaterLayer
  );
  multiTargetHighlightLayer.addChild(worldTargetAnchorMarker);
  // Map-rendered interior room: authored floor under the world layers,
  // actors y-sorted with players and mobs, above_player over actors, and the
  // ceiling over the local player and floaters.
  const interiorRoom = new InteriorRoomLayer({
    actorParent: worldDynamicEntityLayer,
    loadTexture: (url) => Assets.load<Texture>({ src: url }),
    unloadTexture: async (url) => {
      await Assets.unload(url);
    }
  });
  gameplayWorldLayer.addChildAt(interiorRoom.below, 0);
  gameplayWorldLayer.addChildAt(
    interiorRoom.above,
    gameplayWorldLayer.getChildIndex(worldDynamicEntityLayer) + 1
  );
  root.addChild(interiorRoom.ceiling);
  // Ash Heart puzzles draw on the room floor, just above the authored background and below the actors.
  const heartPuzzle = new HeartPuzzleLayer();
  gameplayWorldLayer.addChildAt(heartPuzzle.container, 1);
  app.stage.addChild(root);

  let lastFlags: FlagSnapshot[] = [];
  let lastCities: CitySnapshot[] = [];
  let lastCityStructures: CityStructureSnapshot[] = [];
  let lastDungeonEntrances: DungeonEntranceSnapshot[] = [];
  let lastManors: ManorWorldSnapshot[] = [];
  let lastGreenhouses: GreenhouseSnapshot[] = [];
  let lastFurnaces: FurnaceWorldSnapshot[] = [];
  let lastTanneries: TanneryWorldSnapshot[] = [];
  let lastLooms: LoomWorldSnapshot[] = [];
  let lastKitchens: KitchenWorldSnapshot[] = [];
  let lastFishingHuts: FishingHutWorldSnapshot[] = [];
  let lastCollectibles: CollectibleNode[] = [];
  let lastDroppedItems: DroppedItemSnapshot[] = [];
  const flagHitBoxes: Array<ScreenHitBox & { flag: FlagSnapshot }> = [];
  const retainedFlagMarkers = new Map<
    string,
    { signature: string; container: Container & ZoomScaledDisplay }
  >();
  const cityHitBoxes: Array<ScreenHitBox & { city: CitySnapshot }> = [];
  const cityStructureHitBoxes: Array<ScreenHitBox & { structure: CityStructureSnapshot }> = [];
  const dungeonEntranceHitBoxes: Array<ScreenHitBox & { entrance: DungeonEntranceSnapshot }> = [];
  const manorHitBoxes: ManorHitBox[] = [];
  const greenhouseHitBoxes: GreenhouseHitBox[] = [];
  const furnaceHitBoxes: FurnaceHitBox[] = [];
  const tanneryHitBoxes: TanneryHitBox[] = [];
  const loomHitBoxes: LoomHitBox[] = [];
  const kitchenHitBoxes: KitchenHitBox[] = [];
  const fishingHutHitBoxes: FishingHutHitBox[] = [];
  const collectibleHitBoxes: CollectibleHitBox[] = [];
  const retainedCollectibleMarkers = new Map<
    string,
    { signature: string; container: Container }
  >();
  // Trees shake, plants rustle and rocks jolt on each gathering impact.
  const gatherTargetReactions = new GatherTargetReactions();
  const gatherReactionMarker = (id: string): Container | undefined =>
    retainedCollectibleMarkers.get(id)?.container;
  const gatherTargetIdFor = (
    state: PlayerGatheringState,
    presentation: GatheringPresentation
  ): string | null => {
    if (state.targetActionKey !== presentation.actionKey) {
      state.targetActionKey = presentation.actionKey;
      state.targetId = presentation.targetId ??
        collectibleAtGatherTarget(latestState.collectibles, presentation.target);
    }
    return state.targetId;
  };
  const staticMarkerMetrics = {
    created: 0,
    updated: 0,
    retained: 0,
    destroyed: 0
  };
  const droppedItemHitBoxes: Array<ScreenHitBox & { drop: DroppedItemSnapshot }> = [];
  const combatEntityHitBoxes: CombatEntityHitBox[] = [];
  const playerHitBoxes: Array<ScreenHitBox & { player: PlayerSnapshot }> = [];
  const militaryGroupHitBoxes: Array<ScreenHitBox & { group: MilitaryUnitGroupSnapshot }> = [];
  const warCampHitBoxes: Array<ScreenHitBox & { camp: WarCampSnapshot }> = [];
  const militaryRenderSamples = new Map<string, MilitaryRenderSample>();
  let multiTargetHighlights: readonly WorldObjectPick[] = [];
  let activeMultiTargetHighlightKey: string | null = null;
  const presentation = combatPresentation ?? new CombatPresentationController();
  const damageFloaters = presentation.floatingFeedback;
  presentation.setPlayerScreenPointProvider(() => {
    const player = latestState.players.find((candidate) => candidate.playerId === latestState.localPlayerId);
    if (!player) return null;
    const point = map.project([player.lon, player.lat]);
    const bounds = container.getBoundingClientRect();
    return { x: bounds.left + point.x, y: bounds.top + point.y };
  });
  // Position of the node last harvested (cached when noted: the node may be gone when the gain arrives).
  let harvestTargetSpot: { lat: number; lon: number; atMs: number } | null = null;
  // Loot gains pop out of world positions (ground pickups); screen-clamped so off-screen drops use the player.
  presentation.setWorldProjector((lat, lon) => {
    const point = map.project([lon, lat]);
    const bounds = container.getBoundingClientRect();
    return point.x < 0 || point.y < 0 || point.x > bounds.width || point.y > bounds.height
      ? null
      : { x: bounds.left + point.x, y: bounds.top + point.y };
  });
  const projectileImpacts = presentation.projectileImpacts;
  const tauntPulse = new TauntPulseState();
  const classAbilityActivationPulses = new ClassAbilityActivationPulseState();
  const petAbilityEffects = new PetAbilityEffectState();
  // One view object for every frame (no per-frame closures).
  const petAbilityEffectView: PetEffectView = {
    project: (position) => map.project([position.lon, position.lat]),
    radiusPx: (position, radiusM) => screenRadiusForMeters(map, position, radiusM),
    get reducedMotion() { return reducedMotion; },
    opacity: (position) => globeOverlayOpacityForMap(map, position)
  };
  const drawPetAbilityEffectFrame = (effect: Parameters<typeof drawPetAbilityEffect>[1], progress: number): void => {
    drawPetAbilityEffect(petAbilityEffectGraphics, effect, progress, petAbilityEffectView);
  };
  const petEffectOrigin = (entityId: string): LatLon | null => {
    const rendered = renderedDynamicEntities.get(entityId);
    if (rendered?.container.visible && rendered.mobPosition) return rendered.mobPosition;
    return null;
  };
  const classAbilityZones = new Map<string, {
    abilityId: string;
    position: LatLon;
    radiusM: number;
    expiresAt: number;
  }>();
  const playerAppearancePoses = presentation.appearancePoses;
  const swingEffects = presentation.swingEffects;
  const nudgeScratch = { x: 0, y: 0 };
  /** Hit feedback tint (incoming red, dash i-frame shimmer) last written to each player's artwork; absent = white. */
  const playerFxTints = new Map<string, number>();
  const shakeScratch = { x: 0, y: 0 };
  let shakeApplied = false;
  let shakeLastX = 0;
  let shakeLastY = 0;
  /** Ability wind-ups, hit flashes and passive cues of mobs (mobActionAnimation.ts). */
  const mobActionRenders = new Map<string, MobActionRender>();
  const renderedFloaters = new Map<string, Container>();
  const renderedProjectileImpacts = new Map<string, Sprite>();
  /** One pooled sprite per ShotSlot (action-combat hitscan shot projectiles). */
  const shotSprites: Array<Sprite | null> = [];
  const pendingShotTextures = new Set<number>();
  const pendingProjectileTextures = new Set<string>();
  const unavailableProjectileAssets = new Set<string>();
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const playerAppearanceTextures = new PixiTextureCache(playerAppearanceAssetUrl);
  const bossAppearanceTextures = new PixiTextureCache(bossAppearanceAssetUrl);
  const loadProjectileTexture = async (assetKey: string): Promise<Texture | null> => {
    if (unavailableProjectileAssets.has(assetKey)) return null;
    try {
      return await playerAppearanceTextures.load(assetKey);
    } catch (error) {
      if (!unavailableProjectileAssets.has(assetKey)) {
        unavailableProjectileAssets.add(assetKey);
        console.warn("Projectile appearance texture could not be loaded.", { assetKey, error });
      }
      return null;
    }
  };
  let latestState: RenderState = {
    localPlayerId: "",
    players: [],
    flags: [],
    cities: [],
    cityStructures: [],
    dungeonEntrances: [],
    manors: [],
    greenhouses: [],
    furnaces: [],
    tanneries: [],
    looms: [],
    kitchens: [],
    fishingHuts: [],
    fishingCastPoint: null,
    collectibles: [],
    droppedItems: [],
    resourceVision: null,
    waterHighlights: [],
    selectedFlagId: null,
    selectedCityId: null,
    selectedDungeonEntranceId: null,
    selectedManorId: null,
    selectedGreenhouseId: null,
    selectedFurnaceId: null,
    selectedTanneryId: null,
    selectedLoomId: null,
    selectedKitchenId: null,
    selectedFishingHutId: null,
    selectedCollectibleId: null,
    selectedDroppedItemId: null,
    selectedCombatEntityId: null,
    militaryGroups: [],
    siegeDeploymentPreviewFlagIds: [],
  };
  let militaryClockSample = Number.NaN;
  let militaryClockSampledAt = 0;
  let pendingSelection: WorldMapSelectionState | null = null;
  let frozenStaticState: RenderState | null = null;
  let lastDrawnVisibleStaticState: RenderState | null = null;
  let lastFlagsSignature = "";
  let lastFlagsInput: FlagSnapshot[] | null = null;
  let lastCitiesSignature = "";
  let lastCityStructuresSignature = "";
  let lastDungeonEntrancesSignature = "";
  let lastManorsSignature = "";
  let lastGreenhousesSignature = "";
  let lastFurnacesSignature = "";
  let lastTanneriesSignature = "";
  let lastLoomsSignature = "";
  let lastKitchensSignature = "";
  let lastFishingHutsSignature = "";
  let lastCollectiblesSignature = "";
  let lastCollectiblesInput: CollectibleNode[] | null = null;
  let lastDroppedItemsSignature = "";
  let lastWaterHighlightsSignature = "";
  let lastSelectedFlagId: string | null = null;
  let lastSelectedCityId: string | null = null;
  let lastSelectedDungeonEntranceId: string | null = null;
  let lastSelectedManorId: string | null = null;
  let lastSelectedGreenhouseId: string | null = null;
  let lastSelectedFurnaceId: string | null = null;
  let lastSelectedTanneryId: string | null = null;
  let lastSelectedLoomId: string | null = null;
  let lastSelectedKitchenId: string | null = null;
  let lastSelectedFishingHutId: string | null = null;
  let lastSelectedDroppedItemId: string | null = null;
  let lastSelectedMilitaryGroupId: string | null = null;
  let lastFlagPlacementPreviewSignature = "";
  let lastSiegeDeploymentPreviewSignature = "";
  let lastSiegeTargetSignature = "";
  let lastLeashSignature = "";
  let lastGameplayViewCircleSignature = "";
  let cachedTerritorySignature = "";
  let cachedTerritoryGroups: TerritoryRenderGroup[] = [];
  let lastFrameAt = performance.now();
  let staticLayersFrozen = false;
  let manualViewportInteractionActive = false;
  let pendingTransformRedraw = false;
  let staticGeometryReference: StaticOverlayMapTransformReference | null = null;
  let frozenTransformReference: StaticOverlayMapTransformReference | null = null;
  let lastStaticArtworkCorrection: {
    reference: StaticOverlayMapTransformReference;
    scale: number;
    zoom: number;
  } | null = null;
  let needsFlagRedraw = true;
  let needsCityRedraw = true;
  let needsCityStructureRedraw = true;
  let needsDungeonEntranceRedraw = true;
  let needsManorRedraw = true;
  let needsGreenhouseRedraw = true;
  let needsFurnaceRedraw = true;
  let needsTanneryRedraw = true;
  let needsLoomRedraw = true;
  let needsKitchenRedraw = true;
  let needsFishingHutRedraw = true;
  let needsSaplingRedraw = true;
  const saplingHitBoxes: Array<ScreenHitBox & { saplingId: string }> = [];
  let lastSaplingsSignature = "";
  let needsCollectibleRedraw = true;
  let needsDroppedItemRedraw = true;
  let needsWaterHighlightRedraw = true;
  let needsTerritoryRedraw = true;
  let needsLeashRedraw = true;
  let needsSelectionRedraw = true;
  const loadDungeonEntranceTexture = (entrance: DungeonEntranceSnapshot): void => {
    const source = dungeonEntranceAssetUrl(entrance.assetKey);
    if (!source || dungeonEntranceTextures.has(source) || pendingDungeonEntranceTextures.has(source)) return;
    pendingDungeonEntranceTextures.add(source);
    void loadPresentationTexture(source, undefined, orcCaveEntranceTexture).then((texture) => {
      pendingDungeonEntranceTextures.delete(source);
      texture.source.scaleMode = "linear";
      dungeonEntranceTextures.set(source, texture);
      needsDungeonEntranceRedraw = true;
      map.triggerRepaint();
    });
  };
  // Giving Trees and Elder Ferns are drawn in the art of the biome they stand in. Each biome's
  // textures load the first time a tree there is drawn; until then the default tree art shows.
  let treeArtRevision = 0;
  let treeArtZoneLookup: WorldZoneLookup | null = null;
  const markTreeArtChanged = (): void => {
    treeArtRevision += 1;
    needsCollectibleRedraw = true;
    map.triggerRepaint();
  };
  const biomeTreeTextures = createLazyTextureCache(async (url) => {
    const texture = await loadPresentationTexture(url);
    if (texture !== Texture.WHITE) texture.source.scaleMode = "linear";
    return texture;
  }, markTreeArtChanged);
  void loadWorldZoneLookup().then((lookup) => {
    if (!lookup) return;
    treeArtZoneLookup = lookup;
    markTreeArtChanged();
  });
  const biomeTreeTextureFor = (collectible: CollectibleNode): Texture | null => {
    const biome = treeArtBiomeAt(treeArtZoneLookup, collectible.lat, collectible.lon);
    const nowMs = Date.now();
    const name = biomeTreeArtName(collectible, biome, nowMs);
    // Warm the other produce state's art too, so harvesting swaps straight to it.
    const otherName = biomeTreeArtOtherStateName(collectible, biome, nowMs);
    const otherUrl = otherName ? biomeTreeArtUrl(otherName) : null;
    if (otherUrl) biomeTreeTextures.get(otherUrl);
    const url = name ? biomeTreeArtUrl(name) : null;
    const texture = url ? biomeTreeTextures.get(url) : null;
    return texture && texture !== Texture.WHITE ? texture : null;
  };
  let renderingActive = true;
  let mobPresentationReady = false;
  let nextFlagTravelCaptureId = 1;
  let flagTravelPresentationActive = false;
  let flagTravelDestinationFlagId: string | null = null;
  let flagTravelDestinationCurrentFlagId: string | null | undefined;
  let flagTravelDestinationPlayer: LatLon | null = null;
  let flagTravelDestinationAnchor: LatLon | null = null;
  let flagTravelOriginStaticState: RenderState | null = null;
  let flagTravelOriginLocalPlayerScreen: FlagTravelScreenPoint | null = null;
  let flagTravelOriginCombatEntities: CombatEntitySnapshot[] = [];
  let flagTravelTransformReference: StaticOverlayMapTransformReference | null = null;
  let flagTravelPlayerMotion: FlagTravelPlayerMotionPlan | null = null;
  let flagTravelPlannedLocalPlayerPosition: FlagTravelScreenPoint | null = null;
  let flagTravelVisibilityFrameNowMs = 0;
  // When MapLibre's render event last repainted the overlay for flag travel; drawFrame reads it so one
  // display frame paints once instead of once per rAF callback.
  let lastFlagTravelMapRenderPaintAtMs = Number.NEGATIVE_INFINITY;
  let flagTravelVisibilityTransition: {
    captureId: number;
    timing: FlagTravelVisibilityTiming | null;
    cleanupAtMs: number | null;
    originState: RenderState;
    originCombatEntities: CombatEntitySnapshot[];
    firstSeenAtMs: Map<string, number>;
  } | null = null;
  const collectibleFirstAppearances = new CollectibleFirstAppearanceTracker();
  const renderedDynamicEntities = new Map<string, RetainedDynamicEntity>();
  let promotedDynamicTarget: Readonly<{
    container: Container;
    previousSibling: Container | null;
    nextSibling: Container | null;
    originalIndex: number;
  }> | null = null;
  const pendingAppearanceUpdates = new Map<string, Promise<boolean>>();

  const trackAppearanceUpdate = (
    entityId: string,
    update: Promise<boolean>
  ): void => {
    pendingAppearanceUpdates.set(entityId, update);
    void update.then(
      () => {
        if (pendingAppearanceUpdates.get(entityId) === update) {
          pendingAppearanceUpdates.delete(entityId);
        }
      },
      () => {
        if (pendingAppearanceUpdates.get(entityId) === update) {
          pendingAppearanceUpdates.delete(entityId);
        }
      }
    );
  };

  // A throw inside one frame must not stop later frames (a frozen canvas while
  // the server keeps running). Each distinct message is logged once.
  const reportedFrameErrors = new Set<string>();
  const reportOverlayFrameError = (stage: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${stage}:${message}`;
    if (reportedFrameErrors.has(key)) return;
    reportedFrameErrors.add(key);
    console.error(`Pixi overlay ${stage} frame failed; continuing.`, error);
  };

  // Idle-frame skipping for the rAF loop only (map-synced paints always render). Pixi's setters
  // only mark a render group dirty when a value actually changes, so an empty update list means
  // the last composited frame is still correct. Anything unexpected (nested render groups, a
  // resized or re-density canvas, a changed group-alpha filter, a stale frame) renders.
  // Legacy render quality never skips, restoring the old render-every-frame behaviour.
  const IDLE_RENDER_REFRESH_MS = 1000;
  /** A flag-travel overlay paint this recent came from the same display frame as the current rAF callback. */
  const FLAG_TRAVEL_SAME_FRAME_PAINT_MS = 10;
  const idleRenderSkipEnabled = !isLegacyRenderQualityEnabled();
  let lastRenderedAtMs = Number.NEGATIVE_INFINITY;
  let lastRenderedViewKey = "";
  let lastRenderedGroupAlphaVersion = -1;
  const overlaySceneNeedsRender = (): boolean => {
    // Filter uniforms (group-alpha fades) do not mark the render group dirty.
    if (groupAlphaVersion !== lastRenderedGroupAlphaVersion) return true;
    const group = app.stage.renderGroup;
    if (!group || group.structureDidChange || group.renderGroupChildren.length > 0) {
      return true;
    }
    // These are Pixi internals; if a Pixi upgrade drops them, always render.
    if (!group.childrenRenderablesToUpdate || !group.childrenToUpdate) return true;
    if (group.childrenRenderablesToUpdate.index > 0) return true;
    for (const depth in group.childrenToUpdate) {
      if ((group.childrenToUpdate[depth]?.index ?? 0) > 0) return true;
    }
    return false;
  };
  const overlayViewKey = (): string =>
    `${app.renderer.width}x${app.renderer.height}@${app.renderer.resolution}`;
  const renderOverlay = (onlyIfDirty: boolean = false): void => {
    const gameplayDetailAlpha = gameplayMapDetailAlphaForZoom(mapGroundScaleZoom(map));
    staticLayer.alpha = gameplayDetailAlpha;
    staticLayer.visible = gameplayDetailAlpha > 0;
    tauntPulseLayer.alpha = gameplayDetailAlpha;
    tauntPulseLayer.visible = gameplayDetailAlpha > 0;
    worldDynamicEntityLayer.alpha = gameplayDetailAlpha;
    worldDynamicEntityLayer.visible = gameplayDetailAlpha > 0;
    militaryGroupLayer.alpha = gameplayDetailAlpha;
    militaryGroupLayer.visible = gameplayDetailAlpha > 0;
    kingdomSeatLayer.alpha = gameplayDetailAlpha;
    kingdomSeatLayer.visible = gameplayDetailAlpha > 0;
    multiTargetHighlightLayer.alpha = gameplayDetailAlpha;
    multiTargetHighlightLayer.visible = gameplayDetailAlpha > 0;
    projectileImpactLayer.alpha = gameplayDetailAlpha;
    projectileImpactLayer.visible = gameplayDetailAlpha > 0;
    damageFloaterLayer.alpha = gameplayDetailAlpha;
    damageFloaterLayer.visible = gameplayDetailAlpha > 0;
    const cityStructureLabelAlpha = persistentWorldDetailAlphaForZoom(mapGroundScaleZoom(map));
    cityStructureLabelLayer.alpha = cityStructureLabelAlpha;
    cityStructureLabelLayer.visible = cityStructureLabelAlpha > 0;
    const startedAt = performance.now();
    if (onlyIfDirty && idleRenderSkipEnabled) {
      if (
        overlayViewKey() === lastRenderedViewKey &&
        startedAt - lastRenderedAtMs < IDLE_RENDER_REFRESH_MS &&
        !overlaySceneNeedsRender()
      ) {
        return;
      }
    }
    lastRenderedGroupAlphaVersion = groupAlphaVersion;
    try {
      app.render();
    } catch (error) {
      reportOverlayFrameError("render", error);
    }
    lastRenderedAtMs = startedAt;
    lastRenderedViewKey = overlayViewKey();
    if (frameProbeOn()) {
      const localContainer = renderedDynamicEntities.get(latestState.localPlayerId)?.container;
      noteFrameProbe("o", map, localContainer ? { x: localContainer.x, y: localContainer.y } : null);
    }
    const renderMs = performance.now() - startedAt;
    perfMetrics.notePixiRenderCall(renderMs);
    hitFeedbackStats.renderMs += renderMs;
    hitFeedbackStats.renders += 1;
  };
  const renderOverlayWhenDirty = (): void => renderOverlay(true);

  /**
   * The frame's clock. Given the requestAnimationFrame timestamp, motion is computed for the moment the display frame
   * starts (evenly spaced at 60 or 120 Hz) instead of whenever the callback happened to run, which jitters by several
   * milliseconds under load and shows as uneven steps. Never earlier than the previous frame's reading.
   */
  const takeFrameTiming = (frameTimeMs?: number): { now: number; deltaSeconds: number } => {
    const wall = performance.now();
    const now = frameTimeMs !== undefined && Number.isFinite(frameTimeMs) && frameTimeMs <= wall + 1
      ? Math.max(frameTimeMs, lastFrameAt)
      : wall;
    const deltaSeconds = Math.min(Math.max((now - lastFrameAt) / 1_000, 0), 0.1);
    lastFrameAt = now;
    if (frameTimeMs !== undefined) noteFrameClock(now);
    return { now, deltaSeconds };
  };

  const markAllStaticLayersDirty = (): void => {
    lastStaticArtworkCorrection = null;
    needsFlagRedraw = true;
    needsCityRedraw = true;
    needsCityStructureRedraw = true;
    needsDungeonEntranceRedraw = true;
    needsManorRedraw = true;
    needsGreenhouseRedraw = true;
    needsFurnaceRedraw = true;
    needsTanneryRedraw = true;
    needsLoomRedraw = true;
    needsKitchenRedraw = true;
    needsFishingHutRedraw = true;
    needsSaplingRedraw = true;
    needsCollectibleRedraw = true;
    needsDroppedItemRedraw = true;
    needsWaterHighlightRedraw = true;
    needsTerritoryRedraw = true;
    needsLeashRedraw = true;
    needsSelectionRedraw = true;
    cachedTerritorySignature = "";
    cachedTerritoryGroups = [];
  };

  const markFlagTravelLiveStaticLayersDirty = (): void => {
    needsCollectibleRedraw = true;
    needsDroppedItemRedraw = true;
    needsWaterHighlightRedraw = true;
    needsLeashRedraw = true;
    needsSelectionRedraw = true;
  };

  // Follow reuse (docs/plans/raster-smooth.md): while the camera follows the player, the drawn static geometry is translated like a
  // drag does, instead of being marked dirty and rebuilt every frame. Data changes, a large drift, a zoom change, any pick, or
  // FOLLOW_REUSE_SETTLE_MS without a follow move end it with one full redraw.
  const FOLLOW_REUSE_MAX_DRIFT_PX = 64;
  const FOLLOW_REUSE_REFRESH_MS = 250;
  let lastFullStaticRedrawMs = 0;
  const FOLLOW_REUSE_SETTLE_MS = 160;
  let followReuseActive = false;
  let followReuseLastMoveMs = 0;
  let followReuseSettleTimer: ReturnType<typeof setTimeout> | null = null;
  const endFollowReuse = (): void => {
    if (followReuseSettleTimer !== null) { clearTimeout(followReuseSettleTimer); followReuseSettleTimer = null; }
    if (!followReuseActive) return;
    followReuseActive = false;
    resetStaticOverlayContainerTransform(staticLayer);
    resetStaticOverlayContainerTransform(kingdomSeatLayer);
    markAllStaticLayersDirty();
  };
  const settleFollowReuse = (): void => {
    if (!followReuseActive) return;
    endFollowReuse();
    if (renderingActive && !staticLayersFrozen) drawDirtyStaticLayers(latestState);
  };
  const markFollowTransformDirty = (): void => {
    if (staticFollowMode() === "off") {
      markMapTransformDirty();
      return;
    }
    if (!renderingActive || staticLayersFrozen || flagTravelPresentationActive || flagTravelVisibilityTransition) {
      endFollowReuse();
      markMapTransformDirty();
      return;
    }
    const reference = staticGeometryReference;
    if (!reference || !lastDrawnVisibleStaticState || (!followReuseActive && hasDirtyStaticLayers())) {
      endFollowReuse();
      markAllStaticLayersDirty();
      return;
    }
    const live = computeLiveStaticOverlayReference(map, reference);
    const drift = Math.hypot(live.x - live.pivotX, live.y - live.pivotY);
    if (
      drift > FOLLOW_REUSE_MAX_DRIFT_PX ||
      performance.now() - lastFullStaticRedrawMs > FOLLOW_REUSE_REFRESH_MS ||
      Math.abs(live.scale - 1) > 1e-4 ||
      Math.abs(live.rotation) > 1e-4 ||
      Math.abs(map.getZoom() - reference.zoom) > 1e-4
    ) {
      endFollowReuse();
      markAllStaticLayersDirty();
      return;
    }
    followReuseActive = true;
    applyStaticOverlayContainerTransform(staticLayer, live);
    applyStaticOverlayContainerTransform(kingdomSeatLayer, live);
    perfMetrics.noteStaticOverlaySkippedDuringInteraction();
    followReuseLastMoveMs = performance.now();
    if (followReuseSettleTimer === null) {
      const check = (): void => {
        followReuseSettleTimer = null;
        if (!followReuseActive) return;
        const idleMs = performance.now() - followReuseLastMoveMs;
        if (idleMs >= FOLLOW_REUSE_SETTLE_MS) { settleFollowReuse(); map.triggerRepaint(); return; }
        followReuseSettleTimer = setTimeout(check, FOLLOW_REUSE_SETTLE_MS - idleMs);
      };
      followReuseSettleTimer = setTimeout(check, FOLLOW_REUSE_SETTLE_MS);
    }
  };

  const markMapTransformDirty = (): void => {
    if (!renderingActive) {
      markAllStaticLayersDirty();
      return;
    }
    if (staticLayersFrozen) {
      pendingTransformRedraw = true;
      if (manualViewportInteractionActive) {
        const { now, deltaSeconds } = takeFrameTiming();
        paintMapSynchronizedOverlayFrame(
          applyLiveStaticLayerTransform,
          () => drawTimedDynamicPresentation(now, deltaSeconds),
          renderOverlay
        );
        perfMetrics.noteStaticOverlaySkippedDuringInteraction();
        return;
      }
      paintMapSynchronizedOverlayFrame(
        applyLiveStaticLayerTransform,
        () => drawDynamicEntities(displayStateForDynamicEntities(), 0, performance.now()),
        renderOverlay
      );
      perfMetrics.noteStaticOverlaySkippedDuringInteraction();
      return;
    }
    if (flagTravelPresentationActive || flagTravelVisibilityTransition) {
      markFlagTravelLiveStaticLayersDirty();
      return;
    }
    markAllStaticLayersDirty();
  };

  const getCachedTerritoryGroups = (state: RenderState): TerritoryRenderGroup[] => {
    const signature = flagsSignature(state.flags);
    if (signature === cachedTerritorySignature) {
      return cachedTerritoryGroups;
    }
    cachedTerritorySignature = signature;
    cachedTerritoryGroups = mergeOwnerTerritoriesWithBoundaries(
      territoryClaimShapesForFlags(map, state.flags)
    );
    return cachedTerritoryGroups;
  };

  const drawDirtyStaticLayers = (
    state: RenderState,
    scope: "full" | "flag-travel-live" = "full"
  ): void => {
    if (followReuseActive && !staticLayersFrozen && hasDirtyStaticLayers()) {
      // Data changed while the static geometry is translated: one full redraw from an untranslated container.
      endFollowReuse();
    }
    if (staticLayersFrozen) {
      applyLiveStaticLayerTransform();
      if (hasDirtyStaticLayers() || pendingTransformRedraw) {
        perfMetrics.noteStaticOverlaySkippedDuringInteraction();
      }
      return;
    }
    // Every static layer is hidden at this zoom (renderOverlay), so a redraw would be invisible
    // work. The dirty flags stay set and the first frame back above it redraws everything.
    if (scope === "full" && gameplayMapDetailAlphaForZoom(mapGroundScaleZoom(map)) === 0) {
      return;
    }
    if (
      scope === "flag-travel-live"
        ? !hasDirtyFlagTravelLiveStaticLayers()
        : !hasDirtyStaticLayers()
    ) {
      return;
    }
    const visibleState = visibleStaticStateForMap(
      map,
      container,
      state,
      flagTravelDestinationFlagId,
      staticFollowMode() === "freeze" ? FOLLOW_REUSE_MAX_DRIFT_PX : 0
    );
    const startedAt = performance.now();
    let redrew = false;
    if (scope === "full" && needsTerritoryRedraw) {
      renderTerritoryLayer(map, territoryLayer, getCachedTerritoryGroups(visibleState));
      perfMetrics.noteTerritoryRedraw();
      needsTerritoryRedraw = false;
      redrew = true;
    }
    if (needsLeashRedraw) {
      leashLayer.alpha = visibilityDecision(
        "player",
        visibleState.localPlayerId,
        true
      ).alpha;
      // Interiors never draw the movement leash or gameplay view circle.
      if (state.interior) {
        clearLayer(leashLayer);
      } else {
        renderMovementLeashLayer(
          map,
          leashLayer,
          localPlayerFromState(visibleState),
          visibleState.gameplayViewCircle ?? null,
          visibleState.mapWaypoint ?? null
        );
      }
      needsLeashRedraw = false;
      redrew = true;
    }
    if (needsSelectionRedraw) {
      renderSelectionLayer(map, selectionLayer, siegePreviewLayer, visibleState);
      needsSelectionRedraw = false;
      redrew = true;
    }
    if (needsWaterHighlightRedraw) {
      renderWaterHighlightLayer(
        map,
        waterHighlightGraphics,
        visibleState.waterHighlights,
        visibleState.resourceVision,
        (id) => visibilityDecision("water", id).alpha
      );
      needsWaterHighlightRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsFlagRedraw) {
      renderFlagLayers(
        map,
        flagLayer,
        kingdomSeatLayer,
        visibleState.flags,
        flagHitBoxes,
        kingdomSeatTexture,
        territoryTextures,
        {
          buoy: {
            color: buoyColorTexture,
            hardware: buoyHardwareTexture
          }
        },
        retainedFlagMarkers,
        staticMarkerMetrics
      );
      lastFlags = visibleState.flags;
      needsFlagRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsCityRedraw) {
      renderCityLayer(
        map,
        cityLayer,
        visibleState.cities,
        cityHitBoxes,
        {
          blueprint: cityBlueprintTexture,
          foundation: cityFoundationTexture,
          framing: cityFramingTexture,
          complete: cityHallTexture,
          goblinComplete: goblinHallTexture
        }
      );
      lastCities = visibleState.cities;
      needsCityRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsCityStructureRedraw) {
      renderCityStructureLayer(
        map,
        cityStructureArtworkLayer,
        cityStructureLabelLayer,
        visibleState.cityStructures,
        cityStructureHitBoxes,
        cityStructureTextures
      );
      lastCityStructures = visibleState.cityStructures;
      needsCityStructureRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsDungeonEntranceRedraw) {
      renderDungeonEntranceLayer(
        map,
        dungeonEntranceLayer,
        visibleState.dungeonEntrances,
        dungeonEntranceHitBoxes,
        entranceTexture
      );
      lastDungeonEntrances = visibleState.dungeonEntrances;
      needsDungeonEntranceRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsManorRedraw) {
      renderManorLayer(
        map,
        manorLayer,
        visibleState.manors,
        manorHitBoxes,
        manorTexture,
        manorTypeTextures,
        burningStatusTexture
      );
      lastManors = visibleState.manors;
      needsManorRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsGreenhouseRedraw) {
      renderGreenhouseLayer(
        map,
        greenhouseLayer,
        visibleState.greenhouses ?? [],
        greenhouseHitBoxes,
        greenhouseTexture
      );
      lastGreenhouses = visibleState.greenhouses ?? [];
      needsGreenhouseRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsFurnaceRedraw) {
      renderFurnaceLayer(
        map,
        furnaceLayer,
        visibleState.furnaces,
        furnaceHitBoxes,
        furnaceMarkerTexture
      );
      lastFurnaces = visibleState.furnaces;
      needsFurnaceRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsTanneryRedraw) {
      renderTanneryLayer(
        map,
        tanneryLayer,
        visibleState.tanneries,
        tanneryHitBoxes,
        tanneryTexture
      );
      lastTanneries = visibleState.tanneries;
      needsTanneryRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsLoomRedraw) {
      renderLoomLayer(
        map,
        loomLayer,
        visibleState.looms,
        loomHitBoxes,
        loomTexture
      );
      lastLooms = visibleState.looms;
      needsLoomRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsKitchenRedraw) {
      renderKitchenLayer(
        map,
        kitchenLayer,
        visibleState.kitchens ?? [],
        kitchenHitBoxes,
        foodTexture
      );
      lastKitchens = visibleState.kitchens ?? [];
      needsKitchenRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsFishingHutRedraw) {
      renderFishingHutLayer(
        map,
        fishingHutLayer,
        visibleState.fishingHuts ?? [],
        fishingHutHitBoxes
      );
      lastFishingHuts = visibleState.fishingHuts ?? [];
      needsFishingHutRedraw = false;
      redrew = true;
    }
    if (scope === "full" && needsSaplingRedraw) {
      renderSaplingLayer(map, saplingLayer, visibleState.saplings ?? [], worldTextures, saplingHitBoxes);
      needsSaplingRedraw = false;
      redrew = true;
    }
    if (needsCollectibleRedraw) {
      const collectibleFadeNowMs = performance.now();
      renderCollectibleLayer(
        map,
        collectibleSpriteLayer,
        collectibleGraphics,
        visibleState.collectibles,
        collectibleHitBoxes,
        worldTextures,
        retainedCollectibleMarkers,
        staticMarkerMetrics,
        biomeTreeTextureFor,
        treeArtRevision,
        (id) => {
          const visibility = visibilityDecision("collectible", id);
          const firstAppearanceAlpha = collectibleRemainsAcrossFlagTravel(id)
            ? 1
            : collectibleFirstAppearances.alphaFor(
                id,
                collectibleFadeNowMs,
                reducedMotion
              );
          const alpha = visibility.alpha * firstAppearanceAlpha;
          return {
            alpha,
            interactive:
              visibility.interactive &&
              alpha >= COLLECTIBLE_SPAWN_INTERACTION_ALPHA
          };
        }
      );
      lastCollectibles = visibleState.collectibles;
      needsCollectibleRedraw = collectibleFirstAppearances.hasActiveFade(
        collectibleFadeNowMs,
        reducedMotion
      );
      redrew = true;
    }
    if (needsDroppedItemRedraw) {
      renderDroppedItemLayer(
        map,
        droppedItemSpriteLayer,
        droppedItemGraphics,
        visibleState.droppedItems,
        droppedItemHitBoxes,
        visibleState.selectedDroppedItemId,
        worldTextures,
        (id) => visibilityDecision("drop", id)
      );
      lastDroppedItems = visibleState.droppedItems;
      needsDroppedItemRedraw = false;
      redrew = true;
    }
    if (redrew && scope === "full") {
      lastDrawnVisibleStaticState = visibleState;
      staticGeometryReference = captureStaticOverlayTransformReference(map);
      lastFullStaticRedrawMs = performance.now();
    }
    if (redrew) {
      perfMetrics.noteStaticOverlayRedraw(performance.now() - startedAt, scope);
    }
  };

  const observeMilitaryRenderSamples = (
    groups: readonly MilitaryUnitGroupSnapshot[] | undefined
  ): void => {
    const activeIds = new Set<string>();
    for (const group of groups ?? []) {
      if (
        group.lat === null ||
        group.lon === null ||
        !Number.isFinite(group.lat) ||
        !Number.isFinite(group.lon)
      ) {
        militaryRenderSamples.delete(group.groupId);
        continue;
      }
      activeIds.add(group.groupId);
      const authoritative = { lat: group.lat, lon: group.lon };
      const previous = militaryRenderSamples.get(group.groupId);
      if (
        shouldSnapMilitaryRenderPosition(
          previous ?? null,
          { authoritative, locationState: group.locationState },
          reducedMotion
        )
      ) {
        militaryRenderSamples.set(group.groupId, {
          authoritative,
          rendered: authoritative,
          locationState: group.locationState,
          revision: group.revision
        });
      } else {
        militaryRenderSamples.set(group.groupId, {
          ...previous!,
          authoritative,
          locationState: group.locationState,
          revision: group.revision
        });
      }
    }
    for (const groupId of militaryRenderSamples.keys()) {
      if (!activeIds.has(groupId)) militaryRenderSamples.delete(groupId);
    }
  };

  // Per-frame clocks and scratch collections: one clock read and no per-frame Map/Set allocations.
  let frameWallNowMs = Date.now();
  let frameSyncedNowMs = synchronizedNow();
  // Screen point and occlusion of the entity last placed by updateRetainedEntity (read by updateRetainedMob).
  let entityFramePoint: ScreenPoint | null = null;
  let entityFrameGlobeOpacity = 1;
  const combatByIdScratch = new Map<string, CombatEntitySnapshot>();
  const overheadHealthBarScratch = new Set<string>();
  const desiredEntityScratch = new Set<string>();

  const drawDynamicEntities = (
    state: RenderState,
    deltaSeconds: number,
    frameNowMs: number
  ): void => {
    const startedAt = performance.now();
    frameWallNowMs = Date.now();
    frameSyncedNowMs = synchronizedNow();
    combatEntityHitBoxes.length = 0;
    playerHitBoxes.length = 0;
    // Indoors the room's combat entities replace the world combat store.
    const latestCombatEntities = state.interior
      ? state.interior.combatEntities
      : combatStore?.entities() ?? [];
    const combatEntities = flagTravelVisibilityTransition
      ? [
          ...latestCombatEntities.filter((entity) => entity.kind !== "mob"),
          ...visibilityUnion(
          flagTravelVisibilityTransition.originCombatEntities.filter(
            (entity) => entity.kind === "mob"
          ),
          latestCombatEntities.filter((entity) => entity.kind === "mob"),
          (entity) => entity.entityId,
          "mob"
        )]
      : latestCombatEntities;
    const combatById = combatByIdScratch;
    combatById.clear();
    for (const entity of combatEntities) combatById.set(entity.entityId, entity);
    // A room's mobs are authoritative from the dungeon snapshot; the world
    // presentation handshake never runs when a reconnect lands directly indoors.
    const mobsPresentable = mobPresentationReady || Boolean(state.interior);
    // Overhead bars follow the confirmed selection only. Gating on the pending click
    // too dropped the old bar the instant a new mob was clicked and showed the new one
    // only after confirmation, which read as a flicker when switching targets.
    const overheadHealthBarEntityIds = overheadHealthBarScratch;
    overheadHealthBarEntityIds.clear();
    if (latestState.selectedCombatEntityId) {
      overheadHealthBarEntityIds.add(latestState.selectedCombatEntityId);
    }
    const localAttackTargetEntityId = combatById.get(state.localPlayerId)?.targetEntityId;
    const localCombatEntity = combatById.get(state.localPlayerId);
    localPlayerInvisibleUntil = localCombatEntity?.invisibleUntil ?? 0;
    if (localCombatEntity && !state.interior) prefetchBiomeMobArtwork(localCombatEntity.lat, localCombatEntity.lon, frameNowMs);
    if (localAttackTargetEntityId) overheadHealthBarEntityIds.add(localAttackTargetEntityId);
    drawBossTelegraphs(combatEntities);
    const desiredEntityIds = desiredEntityScratch;
    desiredEntityIds.clear();
    for (const player of state.interior?.players ?? state.players) {
      if (player.online === false && player.playerId !== state.localPlayerId) {
        continue;
      }
      desiredEntityIds.add(player.playerId);
      updateRetainedPlayer(
        player,
        combatById.get(player.playerId) ?? null,
        player.playerId === state.localPlayerId,
        overheadHealthBarEntityIds,
        frameNowMs
      );
    }
    desiredMobIdsForPresentation(
      mobsPresentable,
      combatEntities,
      renderedDynamicEntities.values(),
      desiredEntityIds
    );
    for (const entity of combatEntities) {
      if (
        entity.kind === "mob" &&
        (
          mobsPresentable ||
          flagTravelVisibilityTransition ||
          entity.companion ||
          entity.undead ||
          entity.npcFaction
        )
      ) {
        updateRetainedMob(
          entity,
          deltaSeconds,
          frameNowMs,
          combatById.get(entity.targetEntityId ?? "") ?? null,
          overheadHealthBarEntityIds
        );
      }
    }
    for (const [entityId] of renderedDynamicEntities) {
      if (!desiredEntityIds.has(entityId)) {
        playerAppearancePoses.remove(entityId);
      }
    }
    for (const [entityId, entity] of renderedDynamicEntities) {
      if (desiredEntityIds.has(entityId)) continue;
      renderedDynamicEntities.delete(entityId);
      const actionRecord = mobActionRenders.get(entityId) ?? null;
      mobActionRenders.delete(entityId);
      // A mob the server just defeated plays out as a ghost instead of popping away.
      const diedAtMs = deathMarks.get(entityId);
      if (diedAtMs !== undefined && entity.kind === "mob" && entity.container.visible && !hitFeedbackStats.disabled && !hitFeedbackStats.legacyDeathBeat) {
        deathMarks.delete(entityId);
        beginDeathGhost(entity, Math.max(diedAtMs, frameNowMs), actionRecord);
      } else {
        destroyRetainedEntity(entity);
      }
    }
    if (deathMarks.size > 0) {
      for (const [entityId, markedAtMs] of deathMarks) if (frameNowMs - markedAtMs > DEATH_MARK_TTL_MS) deathMarks.delete(entityId);
    }
    drawMilitaryGroups(state, deltaSeconds);
    try {
      interiorRoom.update(state.interior ?? null);
      const interiorTransform = interiorRoom.frame((lngLat) => map.project(lngLat));
      heartPuzzle.frame(interiorTransform, state.interior ?? null, frameNowMs);
    } catch (error) {
      reportOverlayFrameError("interior", error);
    }
    perfMetrics.setRetainedDisplayObjectCount(renderedDynamicEntities.size);
    perfMetrics.noteDynamicOverlayUpdate(performance.now() - startedAt);
  };

  // Military display objects are retained by id (camps and groups), so a camp or group in view no longer
  // rebuilds Text/Graphics every frame and the overlay can go idle while they stand still.
  type MilitaryRecord = {
    root: Container;
    marker: (Container & ZoomScaledDisplay) | null;
    markerPlain: boolean;
    countdown: Text | null;
    countdownText: string;
    label: Text | null;
    labelText: string;
    labelFill: number;
    healthBar: Graphics | null;
    healthKey: string;
  };
  const militaryRecords = new Map<string, MilitaryRecord>();
  const militarySeen = new Set<string>();
  const militaryOrder: Container[] = [];
  let militaryTransient: Container[] = [];

  const militaryRecordFor = (id: string): MilitaryRecord => {
    let record = militaryRecords.get(id);
    if (!record) {
      record = {
        root: new Container(),
        marker: null,
        markerPlain: false,
        countdown: null,
        countdownText: "",
        label: null,
        labelText: "",
        labelFill: 0,
        healthBar: null,
        healthKey: ""
      };
      militaryRecords.set(id, record);
    }
    militarySeen.add(id);
    militaryOrder.push(record.root);
    return record;
  };

  /** Keeps a record's pieces in draw order (marker, countdown, label, health bar) after any is created. */
  const orderMilitaryRecord = (record: MilitaryRecord): void => {
    let index = 0;
    for (const piece of [record.marker, record.countdown, record.label, record.healthBar]) {
      if (!piece) continue;
      if (record.root.children[index] !== piece) record.root.addChildAt(piece, index);
      index += 1;
    }
  };

  const disposeMilitaryMarker = (record: MilitaryRecord): void => {
    if (!record.marker) return;
    record.marker.removeFromParent();
    record.marker.destroy({ children: true });
    record.marker = null;
    record.markerPlain = false;
  };

  const militaryTextStyle = (fill: number, fontWeight: "700" | "800", shadowAlpha: number) => ({
    fill,
    fontFamily: "Inter, Arial, sans-serif",
    fontSize: 10,
    fontWeight,
    stroke: { color: 0x0d0b08, width: 2 },
    dropShadow: { color: 0x0d0b08, alpha: shadowAlpha, blur: 2, distance: 1 }
  });

  const updateMilitaryLabel = (record: MilitaryRecord, text: string, fill: number, x: number, y: number): void => {
    let label = record.label;
    if (!label) {
      label = new Text({
        text,
        resolution: OVERLAY_RENDER_RESOLUTION,
        roundPixels: true,
        style: militaryTextStyle(fill, "700", 0.65)
      });
      label.anchor.set(0.5, 0);
      label.eventMode = "none";
      record.label = label;
      record.labelText = text;
      record.labelFill = fill;
      orderMilitaryRecord(record);
    } else {
      if (record.labelText !== text) {
        label.text = text;
        record.labelText = text;
      }
      if (record.labelFill !== fill) {
        label.style.fill = fill;
        record.labelFill = fill;
      }
    }
    label.position.set(x, y);
  };

  const updateMilitaryCountdown = (record: MilitaryRecord, text: string | null, x: number, y: number): void => {
    if (text === null) {
      if (record.countdown) record.countdown.visible = false;
      return;
    }
    let countdown = record.countdown;
    if (!countdown) {
      countdown = new Text({
        text,
        resolution: OVERLAY_RENDER_RESOLUTION,
        roundPixels: true,
        style: militaryTextStyle(0xe7dcc2, "800", 0.72)
      });
      countdown.anchor.set(0.5, 1);
      countdown.eventMode = "none";
      record.countdown = countdown;
      record.countdownText = text;
      orderMilitaryRecord(record);
    } else if (record.countdownText !== text) {
      countdown.text = text;
      record.countdownText = text;
    }
    countdown.visible = true;
    countdown.position.set(x, y - 28);
  };

  /** Health bar drawn at the origin and moved by position, so it only redraws when its value changes. */
  const updateMilitaryHealthBar = (
    record: MilitaryRecord,
    visible: boolean,
    healthRatio: number,
    fillColor: number,
    x: number,
    y: number
  ): void => {
    if (!visible) {
      if (record.healthBar) record.healthBar.visible = false;
      return;
    }
    let healthBar = record.healthBar;
    if (!healthBar) {
      healthBar = new Graphics();
      record.healthBar = healthBar;
      orderMilitaryRecord(record);
    }
    const key = `${healthRatio}|${fillColor}`;
    if (record.healthKey !== key) {
      record.healthKey = key;
      healthBar.clear()
        .roundRect(-18, 18, 36, 4, 1)
        .fill({ color: HEALTH_BAR_COLORS.frame, alpha: 0.98 })
        .roundRect(-17, 19, 34, 2, 0.5)
        .fill({ color: HEALTH_BAR_COLORS.track, alpha: 1 });
      if (healthRatio > 0) {
        healthBar
          .roundRect(-17, 19, 34 * healthRatio, 2, 0.5)
          .fill({ color: fillColor, alpha: 1 });
      }
    }
    healthBar.visible = true;
    healthBar.position.set(x, y);
  };

  function drawWarCamps(state: RenderState, zoom: number): void {
    const now = state.militaryClockMs ?? Date.now();
    const presentation = SPRITE_PRESENTATION.genericMob;
    for (const camp of state.warCamps ?? []) {
      if (!Number.isFinite(camp.lat) || !Number.isFinite(camp.lon)) continue;
      if (!pointInsideGameplayView({ lat: camp.lat, lon: camp.lon }, latestState)) continue;
      const point = map.project([camp.lon, camp.lat]);
      const burningUntilMs = camp.burningUntil ? Date.parse(camp.burningUntil) : Number.NaN;
      const burning = Number.isFinite(burningUntilMs) && burningUntilMs > now;
      const record = militaryRecordFor(`camp:${camp.campId}`);
      if (!record.marker) {
        const marker = new Container() as Container & ZoomScaledDisplay;
        const sprite = new Sprite(warCampTexture);
        sprite.anchor.set(presentation.anchorX, presentation.anchorY);
        marker.addChild(sprite);
        record.marker = marker;
        record.markerPlain = true;
        orderMilitaryRecord(record);
      }
      (record.marker.children[0] as Sprite).tint = burning ? 0xffa060 : 0xffffff;
      applyZoomScaledPresentation(record.marker, point.x, point.y, warCampTexture.height, presentation, zoom);
      updateMilitaryLabel(
        record,
        burning
          ? `Burning · ${buildRemainingTimeLabel(burningUntilMs - now)}`
          : camp.ownerName ? `War Camp · ${camp.ownerName}` : "War Camp",
        burning ? 0xffb070 : 0xf3ead7,
        point.x,
        point.y + 5
      );
      const maximumHealth = Math.max(1, camp.maximumHealth ?? 2_000);
      const healthRatio = Math.max(0, Math.min(1, (camp.health ?? maximumHealth) / maximumHealth));
      updateMilitaryHealthBar(
        record,
        true,
        healthRatio,
        burning || healthRatio <= 0.5 ? HEALTH_BAR_COLORS.criticalFrame : HEALTH_BAR_COLORS.fillBottom,
        point.x,
        point.y
      );
      warCampHitBoxes.push({
        camp,
        ...spriteInteractionHitBox({
          x: point.x,
          y: point.y,
          textureWidth: warCampTexture.width,
          textureHeight: warCampTexture.height,
          zoom,
          presentation,
          paddingPx: 2
        })
      });
    }
  }

  function drawMilitaryGroups(state: RenderState, deltaSeconds: number): void {
    for (const transient of militaryTransient) transient.destroy({ children: true });
    militaryTransient = [];
    militarySeen.clear();
    militaryOrder.length = 0;
    militaryGroupHitBoxes.length = 0;
    warCampHitBoxes.length = 0;
    const zoom = mapGroundScaleZoom(map);
    const frameAt = performance.now();
    if (state.militaryClockMs !== militaryClockSample) {
      militaryClockSample = state.militaryClockMs ?? Date.now();
      militaryClockSampledAt = frameAt;
    }
    const militaryNow = militaryClockSample + Math.max(0, frameAt - militaryClockSampledAt);
    drawWarCamps(state, zoom);
    for (const group of state.militaryGroups ?? []) {
      if (
        group.lat === null ||
        group.lon === null ||
        !Number.isFinite(group.lat) ||
        !Number.isFinite(group.lon)
      ) continue;
      const authoritativePosition = { lat: group.lat, lon: group.lon };
      if (!pointInsideGameplayView(authoritativePosition, latestState)) continue;
      const previousSample = militaryRenderSamples.get(group.groupId);
      const renderedPosition = previousSample
        ? nextMilitaryRenderPosition(
            previousSample.rendered,
            previousSample.authoritative,
            deltaSeconds,
            reducedMotion
          )
        : authoritativePosition;
      if (
        previousSample &&
        (
          renderedPosition.lat !== previousSample.rendered.lat ||
          renderedPosition.lon !== previousSample.rendered.lon
        )
      ) {
        militaryRenderSamples.set(group.groupId, {
          ...previousSample,
          rendered: renderedPosition
        });
      }
      if (!pointInsideGameplayView(renderedPosition, latestState)) continue;
      const point = map.project([renderedPosition.lon, renderedPosition.lat]);
      const artSlot = militaryWorldArtSlot(
        group,
        state.militaryBomberChannel,
        state.militarySiegeVolleyCues,
        militaryNow
      );
      const texture = militaryStateTextures[artSlot];
      const presentationKey = artSlot === "military-siege-packed"
        ? "militaryUnits.field_ballista.packed"
        : artSlot === "military-siege-deployed"
          ? "militaryUnits.field_ballista.deployed"
          : artSlot === "military-siege-launch"
            ? "militaryUnits.field_ballista.launch"
            : artSlot === "military-bomber-idle"
              ? "militaryUnits.bomber.idle"
              : artSlot === "military-bomber-planting"
                ? "militaryUnits.bomber.planting"
                : `militaryUnits.${group.unitType}`;
      const presentation = SPRITE_PRESENTATION[
        presentationKey as keyof typeof SPRITE_PRESENTATION
      ] ?? SPRITE_PRESENTATION.genericMob;
      const record = militaryRecordFor(`group:${group.groupId}`);
      const bomberChannel = state.militaryBomberChannel?.groupId === group.groupId
        ? state.militaryBomberChannel : null;
      const volley = group.locationState === "DEPLOYED_FIELD"
        ? state.militarySiegeVolleyCues?.find((cue) => cue.groupId === group.groupId &&
          militaryNow >= cue.occurredAt && militaryNow < cue.occurredAt + SIEGE_ACTION_MS)
        : null;
      const bomberTarget = bomberChannel?.targetKind === "city_structure"
        ? state.cityStructures.find((structure) => structure.structureId === bomberChannel.targetFlagId)
        : state.flags.find((flag) => flag.id === bomberChannel?.targetFlagId);
      const explicitTarget = group.targetCityStructureId
        ? state.cityStructures.find((structure) => structure.structureId === group.targetCityStructureId)
        : state.flags.find((flag) => flag.id === group.targetFlagId);
      const target = group.unitType === "field_ballista"
        ? siegeFacingTarget(group, state.flags, state.cityStructures)
        : bomberTarget ?? explicitTarget;
      const targetPoint = target ? map.project([target.lon, target.lat]) : null;
      const direction = targetPoint ? Math.sign(targetPoint.x - point.x) || -1 : -1;
      const plantingAtTarget = bomberChannel && targetPoint && target &&
        pointInsideGameplayView(target, latestState);
      const approachProgress = plantingAtTarget
        ? Math.max(0, Math.min(1, (militaryNow - Date.parse(bomberChannel.startedAt)) / 450)) : 0;
      const approach = reducedMotion ? 1 : approachProgress * approachProgress * (3 - 2 * approachProgress);
      const artPoint = plantingAtTarget
        ? { x: point.x + (targetPoint.x - point.x) * approach,
            y: point.y + (targetPoint.y - point.y) * approach }
        : point;
      const animatedAction = bomberChannel !== null || Boolean(volley) ||
        (artSlot === "military-siege-deployed" && !reducedMotion);
      if (animatedAction) {
        // Animated action art is rebuilt each frame; the rest of the group's objects stay retained.
        disposeMilitaryMarker(record);
        record.marker = new Container() as Container & ZoomScaledDisplay;
        orderMilitaryRecord(record);
      } else if (!record.markerPlain) {
        disposeMilitaryMarker(record);
        const plainMarker = new Container() as Container & ZoomScaledDisplay;
        plainMarker.addChild(new Sprite(texture));
        record.marker = plainMarker;
        record.markerPlain = true;
        orderMilitaryRecord(record);
      }
      const marker = record.marker!;
      applyZoomScaledPresentation(marker, artPoint.x, artPoint.y, texture.height, presentation, zoom);
      const artFacing = direction > 0 ? -1 : 1;
      const targetOffset = targetPoint && marker.scale.x > 0
        ? { x: (targetPoint.x - artPoint.x) / marker.scale.x * artFacing,
            y: (targetPoint.y - artPoint.y) / marker.scale.y }
        : null;
      const targetDistance = targetPoint ? Math.hypot(targetPoint.x - artPoint.x, targetPoint.y - artPoint.y) : 0;
      if (bomberChannel) {
        drawMilitaryAction(
          marker,
          militaryStateTextures["military-bomber-idle"],
          militaryStateTextures["military-bomber-planting"],
          presentation.anchorX,
          presentation.anchorY,
          "bomber",
          bomberPlantPose(Date.parse(bomberChannel.startedAt), militaryNow, reducedMotion),
          direction,
          null,
          null,
          plantingAtTarget
            ? { x: 0, y: 0 }
            : targetOffset && targetDistance < 45
              ? { x: Math.max(-texture.width * 0.3, Math.min(texture.width * 0.3, targetOffset.x)), y: 0 }
            : null,
          true,
          reducedMotion,
          reducedMotion ? 0 : Math.max(0, militaryNow - Date.parse(bomberChannel.startedAt) - 1400)
        );
      } else if (volley) {
        const pose = siegeVolleyPose(volley.occurredAt, militaryNow, reducedMotion);
        drawMilitaryAction(
          marker,
          militaryStateTextures["military-siege-deployed"],
          militaryStateTextures["military-siege-launch"],
          presentation.anchorX,
          presentation.anchorY,
          "siege",
          pose.launch,
          direction,
          pose.rockFlight,
          siegeRockTexture,
          targetOffset && target
            ? pointInsideGameplayView(target, latestState)
              ? targetOffset
              : { x: targetOffset.x * Math.min(1, 110 / Math.max(1, targetDistance)),
                  y: targetOffset.y * Math.min(1, 110 / Math.max(1, targetDistance)) }
            : null,
          pose.loaded,
          reducedMotion
        );
      } else if (artSlot === "military-siege-deployed" && !reducedMotion) {
        drawMilitaryAction(
          marker, texture, militaryStateTextures["military-siege-launch"],
          presentation.anchorX, presentation.anchorY, "siege", 0, direction,
          null, siegeRockTexture
        );
      } else {
        const sprite = marker.children[0] as Sprite;
        if (sprite.texture !== texture) sprite.texture = texture;
        sprite.anchor.set(presentation.anchorX, presentation.anchorY);
        sprite.scale.x = artSlot === "military-siege-deployed" ? artFacing : 1;
      }

      updateMilitaryCountdown(
        record,
        militaryWorldCountdownLabel(group, state.militaryBomberChannel, militaryNow),
        point.x,
        point.y
      );
      updateMilitaryLabel(
        record,
        group.unitType === "field_ballista" || group.unitType === "bomber"
          ? militaryGroupDisplayName(group.unitType, group.memberCount)
          : group.unitType === "infantry"
            ? (group.memberCount > 1 ? `Melee Kippin ×${group.memberCount}` : "Melee Kippin")
            : (group.memberCount > 1 ? `Archer ×${group.memberCount}` : "Archer"),
        0xf3ead7,
        point.x,
        point.y + 5
      );

      const maximumHealth = Math.max(1, group.maxHp);
      const isMachineryGroup = group.unitType === "field_ballista" || group.unitType === "bomber";
      const healthRatio = Math.max(0, Math.min(1, group.currentHp / maximumHealth));
      updateMilitaryHealthBar(
        record,
        isMachineryGroup
          ? group.currentHp < maximumHealth
          : shouldRenderMilitaryGroupHealthBar(group, state.selectedMilitaryGroupId ?? null),
        healthRatio,
        healthRatio <= 0.25 ? HEALTH_BAR_COLORS.criticalFrame : HEALTH_BAR_COLORS.fillBottom,
        point.x,
        point.y
      );
      militaryGroupHitBoxes.push({
        group,
        ...spriteInteractionHitBox({
          x: point.x,
          y: point.y,
          textureWidth: texture.width,
          textureHeight: texture.height,
          zoom,
          presentation,
          paddingPx: 2
        })
      });
    }
    for (const cue of state.militaryBomberDetonationCues ?? []) {
      const elapsed = militaryNow - cue.occurredAt;
      if (elapsed < 0 || elapsed >= BOMBER_ESCAPE_MS || !pointInsideGameplayView(cue.targetPosition, latestState)) continue;
      const point = map.project([cue.targetPosition.lon, cue.targetPosition.lat]);
      const from = map.project([cue.position.lon, cue.position.lat]);
      const direction = Math.sign(from.x - point.x) || 1;
      const actor = new Container() as Container & ZoomScaledDisplay;
      const presentation = SPRITE_PRESENTATION["militaryUnits.bomber.escaping"];
      applyZoomScaledPresentation(actor, point.x, point.y, 1280, presentation, zoom);
      drawBomberDetonation(actor, bomberEscapeTexture, bomberBlastTexture, elapsed, direction, reducedMotion);
      militaryTransient.push(actor);
    }
    // Drop records that left view, keep survivors in draw order, then the transient detonation actors.
    for (const [id, record] of militaryRecords) {
      if (militarySeen.has(id)) continue;
      record.root.removeFromParent();
      record.root.destroy({ children: true });
      militaryRecords.delete(id);
    }
    for (let index = 0; index < militaryOrder.length; index += 1) {
      const root = militaryOrder[index]!;
      if (militaryGroupLayer.children[index] !== root) militaryGroupLayer.addChildAt(root, index);
    }
    for (const transient of militaryTransient) militaryGroupLayer.addChild(transient);
  }

  const telegraphShape = createTelegraphScreenShape();
  // Biome palette per cast, resolved once from the cell the telegraph sits in.
  const telegraphPalettes = new Map<string, TelegraphPalette>();
  // One retained decal per cast: its static layers are tessellated once and animated by transform/alpha.
  const telegraphViews = new Map<string, TelegraphDecalView>();
  const telegraphUsed = new Set<string>();
  const telegraphOrder: TelegraphDecalView[] = [];
  const clearTelegraphViews = (): void => {
    for (const view of telegraphViews.values()) view.destroy();
    telegraphViews.clear();
  };
  const drawCastTelegraph = (cast: BossCastSnapshot, now: number): void => {
    const window = telegraphWindow(cast, now);
    if (now < window.localStart || now >= window.localEnd + TELEGRAPH_DECAL.impactMs) return;
    const geometry = cast.geometry;
    const anchor = geometry.kind === "circle" ? geometry.center : geometry.origin;
    const opacity = globeOverlayOpacityForMap(map, anchor);
    if (opacity <= 0) return;
    let palette = telegraphPalettes.get(cast.castInstanceId);
    if (!palette) {
      if (telegraphPalettes.size > 128) telegraphPalettes.clear();
      palette = latestState.interior ? TELEGRAPH_DEFAULT_PALETTE : telegraphPaletteAt(treeArtZoneLookup, anchor.lat, anchor.lon);
      telegraphPalettes.set(cast.castInstanceId, palette);
    }
    projectTelegraphShape(map, geometry, telegraphShape);
    const extent = telegraphShape.kind === "circle" ? telegraphShape.radius : telegraphShape.reach;
    if (
      telegraphShape.ox + extent < 0 || telegraphShape.oy + extent < 0 ||
      telegraphShape.ox - extent > container.clientWidth || telegraphShape.oy - extent > container.clientHeight
    ) return;
    const span = Math.max(1, window.localEnd - window.localStart);
    const progress = Math.min(1, Math.max(0, (now - window.localStart) / span));
    const impact = now >= window.localEnd ? (now - window.localEnd) / TELEGRAPH_DECAL.impactMs : -1;
    if (telegraphShape.kind === "circle" && MOB_RING_TELEGRAPH_ABILITY_IDS.has(cast.abilityId)) {
      // A travelling ring front (Vault Warden heartbeat): a thin ember band at radius x progress, not a filled warning.
      if (now >= window.localEnd) return;
      const front = telegraphShape.radius * progress;
      const band = Math.max(5, Math.min(12, telegraphShape.radius * 0.01));
      const alpha = opacity * (progress > 0.85 ? (1 - progress) / 0.15 : 1);
      mobProjectileGraphics
        .circle(telegraphShape.ox, telegraphShape.oy, front)
        .stroke({ color: 0xff6a1f, width: band * 2.6, alpha: 0.3 * alpha })
        .circle(telegraphShape.ox, telegraphShape.oy, front)
        .stroke({ color: 0xffd08a, width: band, alpha: 0.95 * alpha });
      if (hitGeometryProbe) hitGeometryProbe.mobRing = { abilityId: cast.abilityId, frontPx: front, atMs: now };
      return;
    }
    let view = telegraphViews.get(cast.castInstanceId);
    if (!view) {
      view = new TelegraphDecalView();
      telegraphViews.set(cast.castInstanceId, view);
      bossTelegraphLayer.addChild(view.root);
    }
    telegraphUsed.add(cast.castInstanceId);
    if (view.update(
      telegraphShape, progress, impact, telegraphSeed(cast.castInstanceId),
      telegraphMarksForAbility(cast.abilityId, telegraphShape.kind), palette, opacity, reducedMotion, now,
      // Mob AI Phase 2 signature moves draw with the heavier ink outline (spec 5 rule 5).
      isMobSignatureAbilityId(cast.abilityId)
    )) telegraphOrder.push(view);
  };
  /** A mob shot in the air: the orb at the caster's chest height, its shadow on the telegraphed ground path. */
  const drawMobProjectile = (cast: BossCastSnapshot, entity: CombatEntitySnapshot, now: number): void => {
    if (!MOB_PROJECTILE_ABILITY_IDS.has(cast.abilityId)) return;
    const progress = mobShotFlightProgress(now - telegraphWindow(cast, now).localEnd);
    if (progress === null) return;
    const path = mobProjectileGroundPath(cast.geometry, { lat: entity.lat, lon: entity.lon });
    if (!path) return;
    const start = map.project([path.start.lon, path.start.lat]);
    const end = map.project([path.end.lon, path.end.lat]);
    const rendered = renderedDynamicEntities.get(entity.entityId);
    const spriteHeightPx = rendered?.visualArtworkHeightPx
      || spriteHeightForZoom(mapGroundScaleZoom(map), SPRITE_BASE_ZOOM, SPRITE_PRESENTATION.player);
    const liftPx = combatChestLiftPx(spriteHeightPx, "mob");
    const lifted = liftedProjectilePoint(start, end, progress, liftPx, liftedScratch);
    const scale = Math.max(0.6, spriteHeightPx / PLAYER_BASE_HEIGHT_PX);
    drawProjectileShadow(lifted.ground.x, lifted.ground.y, scale, 1);
    if (hitGeometryProbe) hitGeometryProbe.mobShotLive = true;
    if (hitGeometryProbe) hitGeometryProbe.mobShot = { abilityId: cast.abilityId, ground: { ...lifted.ground }, body: { ...lifted.body }, liftPx, atMs: now };
    const orb = (cast.abilityId === "caster_blast" ? 6 : 4) * scale;
    mobProjectileGraphics
      .circle(lifted.body.x, lifted.body.y, orb * 1.8)
      .fill({ color: 0xffb35c, alpha: 0.35 })
      .circle(lifted.body.x, lifted.body.y, orb)
      .fill({ color: 0xfff1c9, alpha: 0.95 });
  };
  /** Dev-only: every combatant's ground hurt circle at its feet (the circle server hit tests use). */
  const drawHurtCircles = (combatEntities: readonly CombatEntitySnapshot[]): void => {
    hurtCircleGraphics.clear();
    if (hitGeometryProbe) hitGeometryProbe.hurtCircles = 0;
    if (!hurtCircleDebugEnabled) return;
    let drawnCircles = 0;
    for (const entity of combatEntities) {
      if (entity.lifeState !== "alive") continue;
      const rendered = renderedDynamicEntities.get(entity.entityId);
      const feet = rendered?.container.visible
        ? { x: rendered.container.x, y: rendered.container.y }
        : map.project([entity.lon, entity.lat]);
      const radiusM = entity.kind === "player" ? PLAYER_HURT_RADIUS_M : mobHurtRadiusM(entity.archetypeKey);
      const radiusPx = screenRadiusForMeters(map, entity, radiusM);
      const color = entity.kind === "player" ? 0x5ce1ff : 0xff5c7a;
      hurtCircleGraphics
        .circle(feet.x, feet.y, radiusPx)
        .fill({ color, alpha: 0.18 })
        .stroke({ color, width: 2, alpha: 0.9 })
        .circle(feet.x, feet.y, 2)
        .fill({ color, alpha: 1 });
      drawnCircles += 1;
      if (hitGeometryProbe && entity.kind === "player") hitGeometryProbe.playerCircle = { x: feet.x, y: feet.y, radiusPx };
    }
    if (hitGeometryProbe) hitGeometryProbe.hurtCircles = drawnCircles;
  };
  const drawBossTelegraphs = (combatEntities: readonly CombatEntitySnapshot[]): void => {
    telegraphUsed.clear();
    telegraphOrder.length = 0;
    mobProjectileGraphics.clear();
    if (hitGeometryProbe) hitGeometryProbe.mobShotLive = false;
    drawHurtCircles(combatEntities);
    const now = Date.now();
    const perfNow = performance.now();
    let drawn = 0;
    for (const entity of combatEntities) {
      // A mob that is not alive (defeat settling) or already reported gone draws nothing.
      if (entity.kind === "mob" && entity.lifeState !== "alive") continue;
      // Ordinary mobs (and players carrying a gone mob's warning) share the boss telegraph drawing.
      const bossCasts = entity.kind === "mob" && entity.bossEncounter?.lifecycleState === "active"
        ? entity.bossEncounter.activeCasts
        : null;
      if (bossCasts) {
        for (let index = 0; index < bossCasts.length && drawn < 64; index += 1, drawn += 1) drawCastTelegraph(bossCasts[index]!, now);
      }
      const telegraphs = entity.telegraphs;
      if (telegraphs) {
        for (let index = 0; index < telegraphs.length && drawn < 64; index += 1, drawn += 1) {
          if (isCastOfGoneMob(telegraphs[index]!.castInstanceId, perfNow)) continue;
          drawCastTelegraph(telegraphs[index]!, now);
          drawMobProjectile(telegraphs[index]!, entity, now);
        }
      }
    }
    for (const [castId, view] of telegraphViews) {
      if (telegraphUsed.has(castId)) continue;
      view.destroy();
      telegraphViews.delete(castId);
    }
    for (let index = 0; index < telegraphOrder.length; index += 1) {
      const root = telegraphOrder[index]!.root;
      if (bossTelegraphLayer.children[index] !== root) bossTelegraphLayer.addChildAt(root, index);
    }
    if (hitGeometryProbe) hitGeometryProbe.telegraphDecals = telegraphViews.size;
  };

  const rodTipScratch = new Point();
  const remoteLineScratch = new Point();
  const remoteLineLocalScratch = new Point();
  /** Stage point of the local player's rod tip while the fishing animation shows it. */
  const localRodTipPoint = (): Point | null => {
    const renderer = renderedDynamicEntities.get(latestState.localPlayerId)?.playerRenderer;
    if (!renderer || !renderer.root.visible || !renderer.gatheringToolTip(rodTipScratch)) return null;
    renderer.root.toGlobal(rodTipScratch, rodTipScratch);
    return fishingCastLayer.toLocal(rodTipScratch, undefined, rodTipScratch);
  };

  const drawFishingCastPresentation = (): void => {
    clearGraphicsIfDrawn(fishingCastGraphics);
    const cast = latestState.fishingCastPoint;
    if (!cast) return;
    const target = map.project([cast.point.lon, cast.point.lat]);
    const player = latestState.players.find((candidate) => candidate.playerId === latestState.localPlayerId);
    const rodTip = localRodTipPoint();
    const origin = rodTip ?? (player ? map.project([player.lon, player.lat]) : null);
    const originLift = rodTip ? 0 : 12;
    const color = cast.status === "invalid" ? 0xa65347 : cast.status === "pending" ? 0xc49a59 : 0x4db6c5;
    if (origin) {
      fishingCastGraphics
        .moveTo(origin.x, origin.y - originLift)
        .lineTo(target.x, target.y)
        .stroke({ color, width: cast.status === "bound" ? 2 : 1.5, alpha: cast.status === "invalid" ? 0.55 : 0.75 });
    }
    if (cast.status === "bound" && cast.cue) {
      const pulse = fishingCastCuePulse(cast.cue, Date.now(), reducedMotion);
      const cueColor = cast.cue === "true_strike" ? 0xe7dcc2 : 0x4db6c5;
      const cueRadius = cast.cue === "true_strike" ? 18 + pulse * 9 : 16 + pulse * 6;
      fishingCastGraphics
        .circle(target.x, target.y, cueRadius)
        .stroke({ color: cueColor, width: cast.cue === "true_strike" ? 3 : 2, alpha: 0.72 + pulse * 0.2 });
      if (!reducedMotion) {
        const splashHeight = cast.cue === "true_strike" ? 12 + pulse * 5 : 7 + pulse * 3;
        fishingCastGraphics
          .moveTo(target.x - 12, target.y - splashHeight)
          .lineTo(target.x - 7, target.y - splashHeight - 5)
          .moveTo(target.x + 12, target.y - splashHeight)
          .lineTo(target.x + 7, target.y - splashHeight - 5)
          .stroke({ color: cueColor, width: 2, alpha: 0.7 + pulse * 0.2 });
      }
    }
    fishingCastGraphics
      .circle(target.x, target.y, 14)
      .fill({ color, alpha: cast.status === "invalid" ? 0.18 : 0.2 })
      .stroke({ color, width: 3, alpha: 0.95 })
      .circle(target.x, target.y, 5)
      .fill({ color: 0xe7dcc2, alpha: 0.95 });
    if (cast.status === "invalid") {
      fishingCastGraphics
        .moveTo(target.x - 7, target.y - 7)
        .lineTo(target.x + 7, target.y + 7)
        .moveTo(target.x + 7, target.y - 7)
        .lineTo(target.x - 7, target.y + 7)
        .stroke({ color: 0xe8c8bf, width: 2, alpha: 0.95 });
    }
  };

  const currentDynamicTargetAnchor = (entityId: string): LatLon | null =>
    combatStore?.get(entityId)
    ?? latestState.players.find((player) => player.playerId === entityId)
    ?? null;

  const restorePromotedDynamicTarget = (): void => {
    const promoted = promotedDynamicTarget;
    promotedDynamicTarget = null;
    if (!promoted || promoted.container.parent !== worldDynamicEntityLayer) return;
    const children = worldDynamicEntityLayer.children;
    const nextIndex = promoted.nextSibling?.parent === worldDynamicEntityLayer
      ? children.indexOf(promoted.nextSibling)
      : -1;
    const previousIndex = promoted.previousSibling?.parent === worldDynamicEntityLayer
      ? children.indexOf(promoted.previousSibling)
      : -1;
    const restoreIndex = nextIndex >= 0
      ? nextIndex
      : previousIndex >= 0
        ? previousIndex + 1
        : Math.min(promoted.originalIndex, children.length - 1);
    if (
      restoreIndex >= 0 &&
      worldDynamicEntityLayer.getChildIndex(promoted.container) !== restoreIndex
    ) {
      worldDynamicEntityLayer.setChildIndex(promoted.container, restoreIndex);
    }
  };

  const syncPromotedDynamicTarget = (target: WorldObjectPick | null): void => {
    const entityId = target?.kind === "player"
      ? target.value.playerId
      : target?.kind === "combat_entity"
        ? target.value.entityId
        : null;
    const container = entityId
      ? renderedDynamicEntities.get(entityId)?.container ?? null
      : null;
    if (promotedDynamicTarget?.container === container) return;
    restorePromotedDynamicTarget();
    if (!container || container.parent !== worldDynamicEntityLayer) return;
    const originalIndex = worldDynamicEntityLayer.getChildIndex(container);
    const children = worldDynamicEntityLayer.children;
    promotedDynamicTarget = {
      container,
      previousSibling: (children[originalIndex - 1] as Container | undefined) ?? null,
      nextSibling: (children[originalIndex + 1] as Container | undefined) ?? null,
      originalIndex
    };
    if (originalIndex !== children.length - 1) {
      worldDynamicEntityLayer.setChildIndex(container, children.length - 1);
    }
  };

  const drawMultiTargetHighlights = (): void => {
    worldTargetAnchorMarker.visible = false;
    const activeTarget = activeMultiTargetHighlightKey === null
      ? null
      : multiTargetHighlights.find(
        (target) => worldObjectPickKey(target) === activeMultiTargetHighlightKey
      ) ?? null;
    const activeEntityId = activeTarget?.kind === "player"
      ? activeTarget.value.playerId
      : activeTarget?.kind === "combat_entity"
        ? activeTarget.value.entityId
        : null;
    syncPromotedDynamicTarget(activeTarget);
    if (!activeTarget) return;
    const anchor = currentWorldTargetAnchor(
      worldObjectPickPosition(activeTarget),
      activeEntityId,
      currentDynamicTargetAnchor
    );
    if (anchor) {
      const point = map.project([anchor.lon, anchor.lat]);
      worldTargetAnchorMarker.position.set(point.x, point.y);
      worldTargetAnchorMarker.alpha = globeOverlayOpacityForMap(map, anchor);
      worldTargetAnchorMarker.visible = worldTargetAnchorMarker.alpha > 0;
    }
  };

  const updateRetainedPlayer = (
    player: PlayerSnapshot,
    combat: CombatEntitySnapshot | null,
    local: boolean,
    healthBarEntityIds: ReadonlySet<string>,
    frameNowMs: number
  ): void => {
    const color = playerDisplayColorNumber(player.displayColor);
    let rendered = renderedDynamicEntities.get(player.playerId);
    if (rendered && (rendered.kind !== "player" || rendered.local !== local || rendered.color !== color)) {
      destroyRetainedEntity(rendered);
      renderedDynamicEntities.delete(player.playerId);
      rendered = undefined;
    }
    rendered = ensureRetainedEntity(renderedDynamicEntities, player.playerId, () => {
      const created = createRetainedDynamicEntity({
        entityId: player.playerId,
        kind: "player",
        name: local ? "" : player.username,
        local,
        color,
        mobTextures,
        playerAppearanceTextures
      });
      (local ? localPlayerLayer : worldDynamicEntityLayer).addChild(
        created.container
      );
      return created;
    });
    // Hitstop: a predicted hit holds the attacker's animation sampling for two frames (not the render loop).
    const playerSampleNowMs = swingEffects.sampleNowMs(player.playerId, frameNowMs);
    rendered.playerRenderer?.setPose(
      playerAppearancePoses.poseFor(player.playerId, combat, playerSampleNowMs)
    );
    // Action combat: the arm swing plays from the press (a ranged weapon draws and releases instead); a dash cuts it.
    if (rendered.playerRenderer) {
      const swing = playerAppearancePoses.swingPlaybackFor(player.playerId);
      if (swing && swing.seq !== rendered.swingSeq) {
        rendered.swingSeq = swing.seq;
        if (!swing.cancelled) {
          const ranged = swing.variant !== "shot" && player.appearance
            ? clientShotProfile(player.appearance) !== null ||
              activeProjectilePresentation(DEFAULT_PLAYER_APPEARANCE_CATALOG, player.appearance) !== null
            : false;
          rendered.playerRenderer.playSwing(ranged ? "shot" : swing.variant, swing.side, swing.startedAtMs, reducedMotion);
        }
      } else if (swing?.cancelled && rendered.playerRenderer.swinging) {
        rendered.playerRenderer.cancelSwing();
      }
    }
    // Action combat: a swing lunges along its aim from the press (the artwork offset is otherwise unused for players).
    {
      const swingMotion = playerAppearancePoses.localSwingMotionFor(player.playerId, playerSampleNowMs, reducedMotion);
      // Hit feedback: a short render-only push away from whoever hit the player (the server position is unchanged).
      const pushed = swingEffects.nudge(player.playerId, frameNowMs, nudgeScratch, reducedMotion);
      rendered.artwork.position.set(
        (swingMotion?.offsetX ?? 0) + (pushed ? nudgeScratch.x : 0),
        (swingMotion?.offsetY ?? 0) + (pushed ? nudgeScratch.y : 0)
      );
      applyPlayerHitTint(rendered.artwork, player, local, frameNowMs);
    }
    const appearanceRevision = player.appearance?.revision ?? -1;
    if (
      rendered.playerRenderer &&
      rendered.appearanceRevision !== appearanceRevision
    ) {
      rendered.appearanceRevision = appearanceRevision;
      trackAppearanceUpdate(
        player.playerId,
        rendered.playerRenderer.updateAppearance(player.appearance)
      );
      const projectileAssetKey = player.appearance
        ? activeProjectilePresentation(DEFAULT_PLAYER_APPEARANCE_CATALOG, player.appearance)
          ?.assetKey ?? null
        : null;
      if (projectileAssetKey) void loadProjectileTexture(projectileAssetKey);
    }
    const visibility = visibilityDecision(
      "player",
      player.playerId,
      local && player.playerId === latestState.localPlayerId
    );
    const relocatingLocalPlayer = Boolean(
      flagTravelVisibilityTransition &&
      local &&
      player.playerId === latestState.localPlayerId
    );
    const interiorPosition = latestState.interior?.playerPosition?.(player.playerId);
    rendered.playerPosition = latestState.interior
      ? interiorPosition
        ? { ...interiorPosition, anchorLat: player.anchorLat, anchorLon: player.anchorLon }
        : player
      : visibility.useDestination && !relocatingLocalPlayer
        ? playerRenderTimeline.renderPosition(player.playerId, frameNowMs)
        : player;
    if (!rendered.playerPosition) {
      rendered.container.visible = false;
      return;
    }
    const invisibility = playerInvisibilityPresentation(combat, local, Date.now());
    if (!invisibility.visible) {
      rendered.container.visible = false;
      return;
    }
    applyGroupAlpha(rendered.container, invisibility.alpha * visibility.alpha *
      globeOverlayOpacityForMap(map, rendered.playerPosition));
    updateRetainedEntity(
      rendered,
      rendered.playerPosition,
      combat,
      combat?.name ?? player.username,
      player,
      healthBarEntityIds,
      frameNowMs
    );
    if (rendered.playerRenderer) {
      // Walk cycle follows the interpolated render position, so server
      // corrections below the speed threshold never trigger stutter steps.
      const walking = !reducedMotion && observePlayerWalkMotion(
        rendered.walkMotion,
        rendered.playerPosition.lat,
        rendered.playerPosition.lon,
        frameNowMs
      );
      // Gathering: the local player from client state, other players from their
      // broadcast gathering snapshot.
      const isLocalPlayer = local && player.playerId === latestState.localPlayerId;
      const gathering = latestState.interior
        ? null
        : isLocalPlayer
          ? latestState.localGathering ?? null
          : remoteGatheringPresentation(player.gathering, gatheringToolAssetKeyForDefinition);
      if (gathering?.kind === "flag") rendered.playerRenderer.setFlagBuildArt(localFlagBuildArt(player));
      let gatherTargetX = 0;
      if (gathering) {
        const targetPoint = map.project([gathering.target.lon, gathering.target.lat]);
        gatherTargetX = targetPoint.x;
        if (!isLocalPlayer && gathering.kind === "fish") {
          // The local player's line is drawn by the cast presentation; remote lines run from the rod to the cast point.
          const stagePoint = fishingCastLayer.toGlobal(targetPoint, remoteLineScratch);
          rendered.playerRenderer.setGatheringLineTarget(rendered.playerRenderer.root.toLocal(stagePoint, undefined, remoteLineLocalScratch));
        }
      }
      const gatheringFrames = (gathering || rendered.gathering.actionKey !== null) && applyPlayerGathering(
        rendered.playerRenderer,
        rendered.gathering,
        gathering,
        rendered.container.position.x,
        gatherTargetX,
        frameNowMs,
        reducedMotion
      );
      // The jacket's flag plant clip owns the flag dust (its contact frame, audit M3): from the frame the plant
      // window opens the drawn body's work loop counts no impacts.
      const flagPlantWindow = gathering?.kind === "flag" && gathering.flagCompletesAtMs !== undefined &&
        gathering.flagCompletesAtMs - performance.now() <= FLAG_PLANT_MS;
      rendered.playerRenderer.setFlagImpactsExternal(
        rendered.jacketRig?.ready === true && rendered.container.visible && (flagPlantWindow || rendered.jacketRig.flagPlanting === true)
      );
      if (walking || rendered.playerRenderer.walkAnimating || gatheringFrames || rendered.playerRenderer.animating) {
        rendered.playerRenderer.setLocomotion(walking);
        if (rendered.container.visible) {
          // Hitstop holds the walk cycle and swing with the pose (sampling only; the position keeps moving).
          rendered.playerRenderer.updateAnimation(playerSampleNowMs);
        }
      }
      if (rendered.jacketRig && rendered.container.visible) {
        rendered.jacketRig.update({
          lat: rendered.playerPosition.lat,
          lon: rendered.playerPosition.lon,
          walking,
          nowMs: playerSampleNowMs,
          bearingDeg: map.getBearing(),
          targetHeight: rendered.playerRenderer.baseHeightPx * rendered.playerRenderer.overallScale,
          inputX: isLocalPlayer && localMoveInput.active ? localMoveInput.dx : null,
          attackHeld: isLocalPlayer && localAttackHeld(),
          attackAimX: isLocalPlayer && localAttackHeld() ? localAttackInput.dx : null,
          gather: jacketGatherInput(rendered.playerRenderer, gathering?.flagCompletesAtMs),
          sword: jacketSwordInput(playerAppearancePoses.swingPlaybackFor(player.playerId), rendered.playerRenderer.heldWeapon, swordStyleFor(combat, rendered.playerRenderer.heldWeapon?.familyId)),
          swordStyle: swordStyleFor(combat, rendered.playerRenderer.heldWeapon?.familyId),
          heldSword: heldSwordTexture(rendered.playerRenderer.heldWeapon),
          downed: combat?.lifeState === "downed",
          armour: devStockArmourOverride() === undefined ? stockArmourForAppearance(player.appearance) : devStockArmourOverride() ?? null
        });
        // The drawn body keeps running (gather impacts, tool tips) but is hidden once the rig draws.
        rendered.playerRenderer.visualRoot.visible = !rendered.jacketRig.ready;
        // Impacts (chips, flag dust) spawn from the jacket clip's tool head / flag base, not the hidden body's fist.
        rendered.playerRenderer.setGatherImpactOrigin(rendered.jacketRig.ready ? rendered.jacketRig.gatherImpactPoint ?? null : null);
        if (rendered.jacketRig.takeFlagPlantImpact?.() === true && rendered.jacketRig.ready && !reducedMotion) {
          rendered.playerRenderer.spawnFlagImpact();
        }
      }
      // The worked object reacts on the frame the strike or pick lands (no
      // impacts are counted under reduced motion, so nothing shakes then).
      const impacts = rendered.playerRenderer.gatherImpactCount;
      if (impacts !== rendered.gathering.impactsSeen) {
        rendered.gathering.impactsSeen = impacts;
        const reaction = gathering && !reducedMotion ? gatherReactionKind(gathering.kind) : null;
        const targetId = reaction && gathering ? gatherTargetIdFor(rendered.gathering, gathering) : null;
        if (reaction && targetId) {
          gatherTargetReactions.trigger(targetId, reaction, rendered.gathering.side === "left" ? -1 : 1, frameNowMs);
        }
      }
    }
    // Afloat is an overworld state: interiors never show the raft.
    rendered.raft?.update({
      afloat: player.afloat === true && !latestState.interior,
      bodyHeightPx: rendered.visualArtworkHeightPx,
      nowMs: frameNowMs,
      reducedMotion
    });
    // The server grants protection when it commits the jump; the ring waits until
    // the local flag-travel transition has landed the player so they spawn in with it.
    if (relocatingLocalPlayer) rendered.protectionGlow.visible = false;
    if (!visibility.interactive) {
      for (let index = playerHitBoxes.length - 1; index >= 0; index -= 1) {
        if (playerHitBoxes[index]?.player.playerId === player.playerId) {
          playerHitBoxes.splice(index, 1);
        }
      }
    }
  };

  /**
   * Incoming hit: a strong red multiply on the hit frame that fades (the player rig has no flash sprite).
   * Dash i-frames: a soft pale-blue shimmer while the player cannot be hit.
   */
  const applyPlayerHitTint = (artwork: Container, player: PlayerSnapshot, local: boolean, frameNowMs: number): void => {
    let tint = 0xffffff;
    if (!hitFeedbackStats.disabled) {
      const hit = swingEffects.hitRecord(player.playerId);
      if (hit && hit.strength === "incoming") {
        const elapsed = frameNowMs - hit.startMs;
        tint = redTint(elapsed >= 0 && elapsed < hit.holdMs ? 0.8 : impactRedStrength(elapsed, hit.holdMs) * 1.3);
      }
      let shimmer = 0;
      if (local && player.playerId === latestState.localPlayerId) {
        const start = dashClientState.lastStart;
        if (start) shimmer = iframeShimmer(frameNowMs - start.atMs, DASH_IFRAME_MS);
      } else if (player.dash?.active) {
        shimmer = iframeShimmer(frameSyncedNowMs - player.dash.startedAt, DASH_IFRAME_MS);
      }
      if (shimmer > 0) tint = minTint(tint, shimmerTint(reducedMotion ? 0.5 : shimmer));
    }
    const last = playerFxTints.get(player.playerId) ?? 0xffffff;
    if (last === tint) return;
    artwork.tint = tint;
    if (tint === 0xffffff) playerFxTints.delete(player.playerId);
    else playerFxTints.set(player.playerId, tint);
  };

  const updateRetainedMob = (
    entity: CombatEntitySnapshot,
    deltaSeconds: number,
    frameNowMs: number,
    targetEntity: CombatEntitySnapshot | null,
    healthBarEntityIds: ReadonlySet<string>
  ): void => {
    // A species whose art has not landed is held back (no blank sprite); the load starts here.
    const artKey = entity.companion
      ? null
      : mobArtworkKey(entity.archetypeKey, entity.npcFaction?.presentationKey);
    if (artKey && !mobArtworkSlots.request(artKey)) return;
    let rendered = renderedDynamicEntities.get(entity.entityId);
    const firstPresentedAtMs = rendered?.kind === "mob"
      ? rendered.firstPresentedAtMs
      : frameNowMs;
    if (rendered && shouldRecreateRetainedMobArtwork(rendered, entity)) {
      destroyRetainedEntity(rendered);
      renderedDynamicEntities.delete(entity.entityId);
      rendered = undefined;
    }
    rendered = ensureRetainedEntity(renderedDynamicEntities, entity.entityId, () => {
      const created = createRetainedDynamicEntity({
        entityId: entity.entityId,
        kind: "mob",
        name: mobNameplate(entity),
        local: false,
        color: entity.archetypeKey === "training_dummy" ? 0xf59e0b : 0x84cc16,
        archetypeKey: entity.archetypeKey,
        npcPresentationKey: entity.npcFaction?.presentationKey ?? null,
        companionSpecies: entity.companion?.species ?? null,
        appearanceVariant: entity.appearanceVariant ?? "normal",
        mobTextures,
        playerAppearanceTextures,
        bossAppearanceTextures,
        firstPresentedAtMs
      });
      worldDynamicEntityLayer.addChild(created.container);
      return created;
    });
    const pose = playerAppearancePoses.poseFor(entity.entityId, entity, frameNowMs);
    rendered.bossRenderer?.setPose(pose);
    const visibility = visibilityDecision("mob", entity.entityId);
    // World mobs draw from a timestamped snapshot buffer, MOB_INTERPOLATION_DELAY_MS behind the server clock. Hitstop shifts
    // the sample clock (frozen during the hold, then catching up smoothly), so there is no jump when it ends.
    const sampledAtMs = entity.companion || hitFeedbackStats.legacyMobSmoothing ? undefined : combatSampleServerMs.get(entity);
    if (visibility.useDestination && sampledAtMs !== undefined) {
      const track = rendered.mobTrack ??= createMobSnapshotTrack();
      if (rendered.mobTrackSource !== entity) {
        rendered.mobTrackSource = entity;
        pushMobSample(track, sampledAtMs, entity.lat, entity.lon, MOB_RENDER_SNAP_M);
      }
      const renderServerMs = frameSyncedNowMs - swingEffects.hitstopLagMs(entity.entityId, frameNowMs) - MOB_INTERPOLATION_DELAY_MS;
      rendered.mobPosition = sampleMobTrack(track, renderServerMs) ?? entity;
    } else if (visibility.useDestination && rendered.mobPosition && swingEffects.isHeld(entity.entityId, frameNowMs)) {
      // Held (legacy glide): keep last frame's drawn position, and let the glide clock wait too so the mob does not
      // jump forward by the hold when it ends.
      const motion = rendered.companionMotion;
      if (motion) {
        const heldMs = deltaSeconds * 1000;
        motion.startMs += heldMs;
        motion.lastSampleMs += heldMs;
      }
    } else if (visibility.useDestination) {
      const motion = nextCompanionRenderPosition(
        rendered.companionMotion,
        rendered.mobPosition,
        entity,
        frameNowMs,
        entity.companion ? undefined : MOB_RENDER_SNAP_M
      );
      rendered.companionMotion = motion.motion;
      rendered.mobPosition = motion.position;
    } else {
      rendered.mobPosition = entity;
    }
    if (mobRenderProbe.enabled && rendered.mobPosition) mobRenderProbe.frames.push([frameNowMs, entity.entityId, rendered.mobPosition.lat, rendered.mobPosition.lon]);
    updateRetainedEntity(
      rendered,
      rendered.mobPosition,
      entity,
      mobNameplate(entity),
      null,
      healthBarEntityIds,
      frameNowMs
    );
    const sourcePoint = entityFramePoint!;
    const targetPoint = targetEntity
      ? map.project([targetEntity.lon, targetEntity.lat])
      : null;
    const attackDirection = targetPoint
      ? attackDirectionFromPoints(sourcePoint, targetPoint)
      : null;
    const attackMotion = pose === "attack_action"
      ? playerAppearancePoses.attackStrikeMotionFor(
          entity.entityId,
          frameNowMs,
          attackDirection,
          reducedMotion
        )
      : null;
    // Predicted swing hit: a short nudge in the swing direction (cancelled with the prediction).
    const nudged = swingEffects.nudge(entity.entityId, frameNowMs, nudgeScratch, reducedMotion);
    rendered.artwork.position.set(
      (attackMotion?.offsetX ?? 0) + (nudged ? nudgeScratch.x : 0),
      (attackMotion?.offsetY ?? 0) + (nudged ? nudgeScratch.y : 0)
    );
    rendered.artwork.rotation = attackMotion?.rotationRadians ?? 0;
    applyMobActionMotion(rendered, entity, frameNowMs, deltaSeconds, attackDirection?.x ?? 0, pose === "attack_action");
    // Shadow Hide: your own pet fades with you while you are hidden (others don't see it at all).
    const hiddenWithOwner = entity.companion?.ownerPlayerId === latestState.localPlayerId &&
      localPlayerInvisibleUntil > frameWallNowMs;
    const combinedAlpha = visibility.alpha * mobSpawnAlpha(
      rendered.firstPresentedAtMs,
      frameNowMs,
      reducedMotion
    );
    applyGroupAlpha(rendered.container, combinedAlpha * (hiddenWithOwner ? 0.62 : 1) *
      entityFrameGlobeOpacity);
    if (
      !visibility.interactive ||
      combinedAlpha < MOB_SPAWN_INTERACTION_ALPHA
    ) {
      for (let index = combatEntityHitBoxes.length - 1; index >= 0; index -= 1) {
        if (combatEntityHitBoxes[index]?.entity.entityId === entity.entityId) {
          combatEntityHitBoxes.splice(index, 1);
        }
      }
    }
  };

  const mobMotionPose = createMobMotionPose();
  const mobMotionInput: MobMotionInput = {
    archetypeKey: null, heightPx: 0, wallNowMs: 0, deltaSeconds: 0, reducedMotion, hitElapsedMs: Number.NaN,
    shelled: false, staggered: false, acquireRemainingMs: Number.NaN, targetDirX: 0, lungeProgress: 0
  };
  const resolveMobActionDirection: MobDirectionResolver = (cast, mob, out) => {
    const geometry = cast.geometry;
    const from = geometry.kind === "circle"
      ? map.project([mob.lon, mob.lat])
      : map.project([geometry.origin.lon, geometry.origin.lat]);
    const toward = geometry.kind === "circle"
      ? geometry.center
      : wgs84DestinationPoint(geometry.origin, 50, geometry.facingDegrees);
    const to = map.project([toward.lon, toward.lat]);
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    out.dirX = length > 0.5 ? (to.x - from.x) / length : 1;
    out.dirY = length > 0.5 ? (to.y - from.y) / length : 0;
  };
  // Ground effect drawing context, set per mob around forEachMobActionFx (no per-frame closures).
  let mobFxRecord: MobActionRender | null = null;
  let mobFxRendered: RetainedDynamicEntity | null = null;
  let mobFxAnchorX = Number.NaN;
  let mobFxAnchorY = 0;
  const drawMobFx = (kind: MobFxKind | "scuff" | "reassemble", ageMs: number, lifeMs: number): void => {
    const record = mobFxRecord;
    const rendered = mobFxRendered;
    if (!record || !rendered) return;
    if (!record.fx) {
      record.fx = new Graphics();
      rendered.container.addChildAt(record.fx, rendered.container.getChildIndex(rendered.artwork));
    }
    if (Number.isNaN(mobFxAnchorX)) {
      const anchor = map.project([record.state.anchorLon, record.state.anchorLat]);
      mobFxAnchorX = anchor.x - rendered.container.position.x;
      mobFxAnchorY = anchor.y - rendered.container.position.y;
    }
    record.fxDrawn = true;
    if (kind === "reassemble") {
      drawReassembleFx(record.fx, record.state, record.state.reassembleStartMs + ageMs, mobFxAnchorX, mobFxAnchorY, rendered.visualArtworkHeightPx, REASSEMBLE_CUE_COLOR, reducedMotion);
      return;
    }
    drawMobActionFx(record.fx, kind, ageMs / lifeMs, mobFxAnchorX, mobFxAnchorY, rendered.visualArtworkHeightPx, record.state);
  };

  /**
   * Layers the mob's ability wind-up / strike, hit flash and passive cues over the transforms
   * already set this frame (zoom scale, basic attack lunge). Off-screen mobs only track starts.
   */
  const applyMobActionMotion = (
    rendered: RetainedDynamicEntity,
    entity: CombatEntitySnapshot,
    frameNowMs: number,
    deltaSeconds: number,
    targetDirX: number,
    attacking: boolean
  ): void => {
    let record = mobActionRenders.get(entity.entityId);
    if (!record || record.artwork !== rendered.artwork) {
      // New (or recreated) artwork: keep the timeline, rebuild the display objects lazily.
      record = {
        state: record?.state ?? createMobActionState(),
        artwork: rendered.artwork,
        flash: null,
        flashChecked: false,
        fx: null,
        fxDrawn: false,
        tint: 0xffffff,
        restScaleX: 0,
        restScaleY: 0
      };
      mobActionRenders.set(entity.entityId, record);
    }
    const wallNowMs = frameWallNowMs;
    observeMobActions(record.state, entity, wallNowMs, resolveMobActionDirection);
    if (!rendered.container.visible) return;
    if (entity.lifeState !== "alive") {
      record.state.programId = null;
      record.state.reassembleEndMs = Number.NaN;
    }
    const input = mobMotionInput;
    input.archetypeKey = entity.archetypeKey;
    input.heightPx = rendered.visualArtworkHeightPx;
    // Hitstop holds the mob's animation sampling for two frames after a predicted hit.
    input.wallNowMs = wallNowMs - swingEffects.hitstopLagMs(entity.entityId, frameNowMs);
    input.deltaSeconds = deltaSeconds;
    // A predicted swing hit starts the existing hit flash on the press; the server's DAMAGE flash for the same hit is absorbed.
    const predictedHitElapsedMs = swingEffects.hitElapsedMs(entity.entityId, frameNowMs);
    // A predicted hit still ahead of its contact frame (negative) holds the server flash back too, so the flash
    // lands with the blade; only a mob with no predicted hit at all flashes from the server echo.
    input.hitElapsedMs = predictedHitElapsedMs >= 0
      ? predictedHitElapsedMs
      : Number.isNaN(predictedHitElapsedMs)
        ? playerAppearancePoses.hitElapsedMs(entity.entityId, frameNowMs)
        : Number.NaN;
    input.shelled = false;
    input.staggered = false;
    const buffs = entity.mobBuffs;
    if (buffs) {
      for (let index = 0; index < buffs.length; index += 1) {
        if (buffs[index]!.kind === "shell" && buffs[index]!.endsAt > wallNowMs) input.shelled = true;
        if (buffs[index]!.kind === "staggered" && buffs[index]!.endsAt > wallNowMs) input.staggered = true;
      }
    }
    const ai = entity.aiPresentation;
    input.acquireRemainingMs = ai?.phase === "acquiring" && ai.deadlineAt !== null
      ? Math.max(0, ai.deadlineAt - frameSyncedNowMs)
      : Number.NaN;
    input.targetDirX = targetDirX;
    input.lungeProgress = attacking
      ? playerAppearancePoses.attackStrikeProgressFor(entity.entityId, frameNowMs, reducedMotion)
      : 0;
    const pose = mobMotionPose;
    const artwork = rendered.artwork;
    record.restScaleX = artwork.scale.x;
    record.restScaleY = artwork.scale.y;
    if (sampleMobMotion(record.state, input, pose)) {
      artwork.position.set(artwork.position.x + pose.x, artwork.position.y + pose.y);
      artwork.rotation += pose.rotation;
      artwork.scale.set(artwork.scale.x * pose.scaleX, artwork.scale.y * pose.scaleY);
    }
    const impact = hitFeedbackStats.disabled ? undefined : swingEffects.hitRecord(entity.entityId);
    if (impact && impact.strength !== "incoming") {
      const elapsed = frameNowMs - impact.startMs;
      const white = impactFlashAlpha(elapsed, impact.holdMs);
      if (white > pose.flash) pose.flash = white;
      const red = impactRedStrength(elapsed, impact.holdMs);
      if (red > 0) pose.tint = minTint(pose.tint, redTint(red));
    }
    // Tilted Vault Ember Wail ward: the untouchable Shade fades and flickers until the ward drops.
    if (mobBuffRemainingMs(entity, "warded", wallNowMs) > 0) {
      pose.alpha *= reducedMotion ? 0.45 : 0.3 + 0.3 * (Math.sin(frameNowMs / 40) + 1) / 2;
    }
    if (artwork.alpha !== pose.alpha) artwork.alpha = pose.alpha;
    if (record.tint !== pose.tint) {
      artwork.tint = pose.tint;
      record.tint = pose.tint;
    }
    if (pose.flash > 0 && !record.flashChecked) {
      record.flashChecked = true;
      record.flash = createMobFlashSprite(rendered);
    }
    if (record.flash) {
      record.flash.visible = pose.flash > 0;
      record.flash.alpha = pose.flash;
    }
    if (record.fx && record.fxDrawn) {
      record.fx.clear();
      record.fxDrawn = false;
    }
    mobFxRecord = record;
    mobFxRendered = rendered;
    mobFxAnchorX = Number.NaN;
    forEachMobActionFx(record.state, wallNowMs, drawMobFx);
    mobFxRecord = null;
    mobFxRendered = null;
  };

  const updateRetainedEntity = (
    rendered: RetainedDynamicEntity,
    position: LatLon,
    combat: CombatEntitySnapshot | null,
    displayName: string,
    playerHitBoxSnapshot: PlayerSnapshot | null,
    healthBarEntityIds: ReadonlySet<string>,
    frameNowMs: number
  ): void => {
    const point = map.project([position.lon, position.lat]);
    const margin = 80;
    const visible =
      (!combat?.npcFaction || (pointInsideGameplayView(combat, latestState) && pointInsideGameplayView(position, latestState))) &&
      point.x >= -margin &&
      point.y >= -margin &&
      point.x <= container.clientWidth + margin &&
      point.y <= container.clientHeight + margin;
    const globeOpacity = globeOverlayOpacityForMap(map, position);
    entityFramePoint = point;
    entityFrameGlobeOpacity = globeOpacity;
    rendered.container.visible = visible && globeOpacity > 0;
    if (!visible) {
      return;
    }
    rendered.container.position.set(point.x, point.y);
    const zoom = mapGroundScaleZoom(map);
    const persistentDetailAlpha = persistentWorldDetailAlphaForZoom(zoom);
    const playerRendererScale = rendered.playerRenderer?.overallScale ?? 1;
    const playerPresentation = rendered.kind === "player"
      ? playerMapPresentationForZoom(
        zoom,
        playerRendererScale,
        combat !== null,
        zoom
      )
      : null;
    const interiorMobScale = rendered.kind === "mob"
      ? latestState.interior?.mobVisualScales?.get(rendered.entityId) ?? 1
      : 1;
    const artworkHeight = playerPresentation?.artworkHeightPx ??
      spriteHeightForZoom(zoom, SPRITE_BASE_ZOOM, rendered.presentation) * interiorMobScale;
    // Wide-zoom LOD: below z10 nameplates, bars and badges are unreadable, and a sprite under a
    // few pixels tall is not worth a draw. Hit boxes below are still pushed for every on-screen entity.
    const wideZoom = zoom < WIDE_ZOOM_LOD_BELOW;
    if (
      !rendered.local &&
      artworkHeight * (rendered.playerRenderer?.overallScale ?? rendered.bossRenderer?.overallScale ?? 1) <
        MIN_DRAWN_SPRITE_HEIGHT_PX
    ) {
      rendered.container.visible = false;
    }
    const artworkScaleY = artworkHeight / rendered.baseArtworkHeightPx;
    rendered.artwork.scale.set(
      artworkScaleY * spriteHorizontalScale(rendered.presentation),
      artworkScaleY
    );
    updateHarmfulStatusIcons(
      rendered,
      combat?.harmfulStatusIds ?? [],
      harmfulStatusTextures
    );
    drawBossAttackRange(rendered.attackRange, map, position, combat);
    // A reassembling skeleton is rooted too, but its heap and gather cue replace the root ring.
    // Staggered mobs take the same label: both are "Vulnerable" windows.
    const reassemblingMs = combat ? mobBuffRemainingMs(combat, "reassembling", frameWallNowMs) : -1;
    const staggeredMs = combat ? mobBuffRemainingMs(combat, "staggered", frameWallNowMs) : -1;
    const vulnerableMs = Math.max(reassemblingMs, staggeredMs);
    const rooted = combat && reassemblingMs < 0
      ? rootedControlEffectPresentation(combat, frameWallNowMs)
      : null;
    const mobBuff = rooted === null && reassemblingMs < 0 && combat ? mobBuffPresentation(combat, frameWallNowMs) : null;
    rendered.rootEffect.visible = rooted !== null && !wideZoom;
    rendered.statusIcons.visible = !wideZoom;
    const rootTimerWanted = !wideZoom && (rooted !== null || mobBuff !== null || vulnerableMs >= 0);
    if (rootTimerWanted || rendered.rootTimer) {
      const rootTimer = rootTimerWanted ? ensureRootTimer(rendered) : rendered.rootTimer!;
      rootTimer.visible = rootTimerWanted;
      if (vulnerableMs >= 0) {
        const text = `${MOB_BUFF_DISPLAY_NAMES.staggered} ${(vulnerableMs / 1_000).toFixed(1)}s`;
        if (rootTimer.text !== text) rootTimer.text = text;
      } else if (rooted) {
        drawRootEffect(rendered.rootEffect, frameNowMs, reducedMotion);
        if (rootTimer.text !== rooted.timerText) rootTimer.text = rooted.timerText;
      } else if (mobBuff && rootTimer.text !== mobBuff.timerText) {
        rootTimer.text = mobBuff.timerText;
      }
    }
    const visualArtworkHeight = artworkHeight *
      (rendered.playerRenderer?.overallScale ?? rendered.bossRenderer?.overallScale ?? 1);
    rendered.visualArtworkHeightPx = visualArtworkHeight;
    const protection = rendered.kind === "player"
      ? playerProtectionGlowPresentation(combat, frameWallNowMs)
      : null;
    rendered.protectionGlow.visible = protection !== null || mobBuff !== null;
    if (protection) {
      drawProtectionGlow(rendered.protectionGlow, visualArtworkHeight, protection.remainingMs, frameNowMs, reducedMotion);
    } else if (mobBuff) {
      drawProtectionGlow(rendered.protectionGlow, visualArtworkHeight, mobBuff.remainingMs, frameNowMs, reducedMotion, MOB_BUFF_GLOW_COLORS[mobBuff.kind]);
    }
    const visibleArtworkTop = -visualArtworkHeight * rendered.presentation.anchorY;
    if (rendered.healthBar) {
      const healthBarY = worldHealthBarOffsetBelowAnchor(
        visualArtworkHeight,
        rendered.presentation.anchorY
      );
      rendered.healthBar.position.y = healthBarY;
      // Slim mob bars: never wider than the mob's sprite (bosses and players keep their authored width).
      rendered.healthBar.scale.x = rendered.kind === "mob" && worldHealthBarVariant(rendered.kind, combat) === "mob"
        ? mobHealthBarScaleX(Math.abs(rendered.artwork.width) * mobVisibleWidthShare(rendered.presentation))
        : 1;
      rendered.statusIcons.position.y =
        healthBarY + WORLD_HEALTH_BAR_METRICS[worldHealthBarVariant(rendered.kind, combat)].height + 2 + HARMFUL_STATUS_TILE_SIZE_PX / 2;
    }
    // A dungeon elite shows its name and modifier badges over the sprite, tinted while its shield is up.
    const elite = rendered.kind === "mob"
      ? latestState.interior?.mobElites?.get(rendered.entityId) ?? null
      : null;
    const labelText = elite ? dungeonEliteMapLabel(elite, combat?.name ?? displayName) : displayName;
    if (rendered.name !== displayName) rendered.name = displayName;
    const labelWanted =
      (elite !== null || (rendered.kind === "player" && !rendered.local)) &&
      persistentDetailAlpha > 0 && !wideZoom;
    if (labelWanted || rendered.label) {
      const label = labelWanted ? ensureNameLabel(rendered) : rendered.label!;
      label.position.y = visibleArtworkTop - 8;
      if (label.text !== labelText) {
        label.text = labelText;
        if (elite && label.style.align !== "center") label.style.align = "center";
      }
      label.tint = elite?.shieldActive === true ? ELITE_SHIELD_LABEL_TINT : 0xffffff;
      label.alpha = persistentDetailAlpha;
      label.visible = labelWanted;
    }
    if (rendered.healthBar) {
      const shouldShowHealthBar = combat !== null && shouldRenderOverheadHealthBar(
        rendered.kind,
        rendered.local,
        combat,
        healthBarEntityIds,
        latestState.localPlayerId
      );
      const wantsHealthBar = shouldShowHealthBar &&
        (rendered.kind === "mob" || (playerPresentation?.healthBarVisible ?? false));
      // Short fade so bars ease in/out with target selection instead of popping.
      const fadeDeltaMs = rendered.healthBarFadeAtMs === null
        ? 0
        : Math.min(100, Math.max(0, frameNowMs - rendered.healthBarFadeAtMs));
      rendered.healthBarFadeAtMs = frameNowMs;
      rendered.healthBarFade = reducedMotion
        ? (wantsHealthBar ? 1 : 0)
        : wantsHealthBar
          ? Math.min(1, rendered.healthBarFade + fadeDeltaMs / HEALTH_BAR_FADE_IN_MS)
          : Math.max(0, rendered.healthBarFade - fadeDeltaMs / HEALTH_BAR_FADE_OUT_MS);
      rendered.healthBar.alpha = persistentDetailAlpha * rendered.healthBarFade;
      rendered.healthBar.visible =
        rendered.healthBarFade > 0 && persistentDetailAlpha > 0 && !wideZoom;
    }
    if (rendered.healthBar && rendered.healthBarState && combat) {
      const healthChanged =
        combat.currentHealth !== rendered.currentHealth || combat.maxHealth !== rendered.maxHealth;
      const wardChanged = (combat.ward ?? 0) !== rendered.ward;
      const presentationChanged = healthChanged
        ? rendered.currentHealth === null || rendered.maxHealth === null
          ? rendered.healthBarState.setInitialHealth(
              combat.currentHealth,
              combat.maxHealth,
              frameNowMs
            )
          : rendered.healthBarState.setHealth(
              combat.currentHealth,
              combat.maxHealth,
              frameNowMs,
              reducedMotion
            )
        : false;
      const animationChanged = rendered.healthBarState.advance(frameNowMs, reducedMotion);
      const critical = isCriticalHealth(combat.currentHealth, combat.maxHealth);
      const criticalChanged = critical !== rendered.healthCritical;
      const barVariant = worldHealthBarVariant(rendered.kind, combat);
      const barTone = worldHealthBarTone(rendered.kind, combat, latestState.localPlayerId);
      const styleChanged = barVariant !== rendered.healthBarVariant || barTone !== rendered.healthBarTone;
      rendered.healthBarVariant = barVariant;
      rendered.healthBarTone = barTone;
      if (
        styleChanged ||
        presentationChanged ||
        animationChanged ||
        criticalChanged ||
        wardChanged ||
        (critical && !reducedMotion)
      ) {
        drawHealthBar(
          rendered.healthBar,
          rendered.healthBarState,
          barVariant,
          barTone,
          critical ? criticalHealthFrameEmphasis(frameNowMs, reducedMotion) : 0,
          combat.ward ?? 0,
          combat.currentHealth,
          combat.maxHealth
        );
      }
      rendered.currentHealth = combat.currentHealth;
      rendered.maxHealth = combat.maxHealth;
      rendered.ward = combat.ward ?? 0;
      rendered.healthCritical = critical;
    }
    let aiLabelY = visibleArtworkTop - 25;
    if (rendered.kind === "mob") {
      const badge = combat
        ? mobAttackCountdownState(combat, latestState.localPlayerId, frameSyncedNowMs)
        : null;
      const badgeKey = mobAttackCountdownKey(badge);
      if (badgeKey !== rendered.attackBadgeKey) {
        rendered.attackBadgeKey = badgeKey;
        if (badge) {
          drawMobAttackCountdown(rendered.attackBadgeGraphics, badge);
          ensureAttackBadgeText(rendered).text = String(badge.seconds);
        }
      }
      rendered.attackBadge.visible = badge !== null && persistentDetailAlpha > 0 && !wideZoom;
      rendered.attackBadge.alpha = persistentDetailAlpha;
      rendered.attackBadge.position.set(0, visibleArtworkTop - 24);
      rendered.attackBadge.scale.set(mobAttackCountdownScale(badge, frameNowMs, reducedMotion));
      // Speech sits above the badge when both show, and above an elite's label.
      if (elite) {
        const eliteLabel = ensureNameLabel(rendered);
        eliteLabel.position.y = visibleArtworkTop - (badge ? 40 : 8);
        aiLabelY = eliteLabel.position.y - eliteLabel.height - 2;
      } else {
        aiLabelY = visibleArtworkTop - (badge ? 50 : 25);
      }
    }
    const aiText = combat && !wideZoom ? mobAiPresentationText(combat, frameSyncedNowMs) : null;
    if (aiText !== null) {
      const aiLabel = ensureAiLabel(rendered);
      aiLabel.position.y = aiLabelY;
      aiLabel.visible = true;
      if (aiLabel.text !== aiText) aiLabel.text = aiText;
    } else if (rendered.aiLabel) {
      rendered.aiLabel.visible = false;
    }
    if (globeOpacity >= 0.5 && combat && combat.entityId !== latestState.localPlayerId) {
      const artworkKey = rendered.kind === "mob"
        ? mobArtworkKey(rendered.archetypeKey, combat.npcFaction?.presentationKey)
        : null;
      const dogKey = combat.companion ? petTextureKey(combat.companion.species) : null;
      if (artworkKey || dogKey) {
        const texture = dogKey ? mobTextures[dogKey] : mobTextures[artworkKey!];
        const presentation = combat.companion ? SPRITE_PRESENTATION[petPresentationKey(combat.companion.species)] : MOB_SPRITE_PRESENTATION[artworkKey!];
        combatEntityHitBoxes.push({
          entity: combat,
          x: point.x,
          y: point.y,
          ...spriteInteractionHitBox({
            x: point.x,
            y: point.y,
            textureWidth: texture.width,
            textureHeight: texture.height,
            zoom,
            presentation
          })
        });
      } else {
        combatEntityHitBoxes.push({
          shape: "circle",
          entity: combat,
          x: point.x,
          y: point.y,
          radius: MOB_SPRITE_PRESENTATION.generic.hitGeometry.shape === "circle"
            ? MOB_SPRITE_PRESENTATION.generic.hitGeometry.radiusPx
            : 37.5
        });
      }
    }
    if (globeOpacity >= 0.5 && playerHitBoxSnapshot && rendered.entityId !== latestState.localPlayerId) {
      playerHitBoxes.push({
        player: playerHitBoxSnapshot,
        ...pngInteractionHitBox({
          x: point.x,
          y: point.y,
          width: rendered.artwork.width,
          height: visualArtworkHeight,
          anchorX: SPRITE_PRESENTATION.player.anchorX,
          anchorY: SPRITE_PRESENTATION.player.anchorY,
          geometry: SPRITE_PRESENTATION.player.hitGeometry
        })
      });
    }
  };

  const activeFloaterIds = new Set<string>();
  /** Released label-only floaters by style key, reused for the next number of the same style (no new Text). */
  // Death beat: a defeated mob's sprite is kept for DEATH_GHOST_MS and flashes white, then fades and shrinks. The server removes
  // the mob the same tick as the killing blow, so without this it popped out and its last number was erased with it.
  /** Mob id -> performance.now() at which its killing blow lands (the ghost's clock starts there). */
  const deathMarks = new Map<string, number>();
  type DeathGhost = { rendered: RetainedDynamicEntity; startMs: number; lat: number; lon: number; scaleX: number; scaleY: number; baseX: number; baseY: number; heightPx: number; flash: Sprite | null; labels: Array<{ child: Container["children"][number]; alpha: number }> };
  const deathGhosts: DeathGhost[] = [];
  const ghostLook: DeathGhostLook = { flash: 0, alpha: 1, scale: 1, sink: 0, labels: 1 };
  const beginDeathGhost = (rendered: RetainedDynamicEntity, startMs: number, actionRecord: MobActionRender | null): void => {
    // The ghost never shows an attack: the pose, ground effects, range ring, status marks and tint snap back to rest.
    const artwork = rendered.artwork;
    artwork.position.set(0, 0);
    artwork.rotation = 0;
    artwork.tint = 0xffffff;
    artwork.alpha = 1;
    if (actionRecord && actionRecord.restScaleX !== 0) artwork.scale.set(actionRecord.restScaleX, actionRecord.restScaleY);
    if (actionRecord?.fx) {
      actionRecord.fx.clear();
      actionRecord.fx.visible = false;
    }
    if (actionRecord?.flash) actionRecord.flash.visible = false;
    rendered.attackRange.clear();
    rendered.attackRange.visible = false;
    rendered.rootEffect.visible = false;
    rendered.statusIcons.visible = false;
    if (rendered.rootTimer) rendered.rootTimer.visible = false;
    // The name, bar and badges are not part of the sprite: they fade out on their own short curve (drawDeathGhosts).
    const labels = rendered.container.children.filter((child) =>
      child !== rendered.artwork && child !== actionRecord?.fx && child !== rendered.attackRange && child !== rendered.rootEffect &&
      child !== rendered.statusIcons && child !== rendered.rootTimer
    ).map((child) => ({ child, alpha: child.alpha }));
    const at = rendered.mobPosition;
    const flash = createMobFlashSprite(rendered);
    deathGhosts.push({
      rendered,
      startMs,
      lat: at?.lat ?? 0,
      lon: at?.lon ?? 0,
      scaleX: rendered.artwork.scale.x,
      scaleY: rendered.artwork.scale.y,
      baseX: rendered.artwork.position.x,
      baseY: rendered.artwork.position.y,
      heightPx: rendered.artwork.height,
      flash,
      labels
    });
    hitFeedbackStats.deathGhostsStarted += 1;
    if (deathGhosts.length > hitFeedbackStats.deathGhostsMaxActive) hitFeedbackStats.deathGhostsMaxActive = deathGhosts.length;
  };
  const drawDeathGhosts = (nowMs: number): void => {
    for (let index = deathGhosts.length - 1; index >= 0; index -= 1) {
      const ghost = deathGhosts[index]!;
      const look = deathGhostLook(nowMs - ghost.startMs, reducedMotion, ghostLook);
      if (!look) {
        destroyRetainedEntity(ghost.rendered);
        deathGhosts.splice(index, 1);
        continue;
      }
      const { container: ghostContainer, artwork } = ghost.rendered;
      const point = map.project([ghost.lon, ghost.lat]);
      ghostContainer.position.set(point.x, point.y);
      artwork.scale.set(ghost.scaleX * look.scale, ghost.scaleY * look.scale);
      artwork.position.set(ghost.baseX, ghost.baseY + look.sink * ghost.heightPx);
      ghostContainer.alpha = look.alpha;
      for (const label of ghost.labels) {
        label.child.visible = look.labels > 0;
        label.child.alpha = label.alpha * look.labels;
      }
      if (ghost.flash) {
        ghost.flash.visible = look.flash > 0;
        ghost.flash.alpha = look.flash;
      }
      if (hitFeedbackStats.deathGhostProbe) hitFeedbackStats.deathGhostFrames.push([nowMs, look.alpha, look.scale, look.flash, point.x, point.y]);
    }
  };
  const clearDeathGhosts = (): void => {
    for (const ghost of deathGhosts) destroyRetainedEntity(ghost.rendered);
    deathGhosts.length = 0;
    deathMarks.clear();
  };

  const drawnFloaterIds = new Set<string>();
  const floaterPool = new Map<string, Container[]>();
  const floaterPoolKeys = new Map<Container, string>();
  const FLOATER_POOL_LIMIT = 16;
  const floaterOrigin = { x: 0, y: 0 };
  const floaterGlobal = { x: 0, y: 0 };
  const floaterLocal = { x: 0, y: 0 };
  const releaseFloater = (display: Container): void => {
    const key = floaterPoolKeys.get(display);
    const pool = key === undefined ? undefined : floaterPool.get(key);
    if (pool && pool.length < FLOATER_POOL_LIMIT) {
      display.visible = false;
      pool.push(display);
      return;
    }
    floaterPoolKeys.delete(display);
    display.destroy({ children: true });
  };
  const drawDamageFloaters = (nowMs: number): void => {
    damageFloaters.prune(nowMs);
    const activeIds = activeFloaterIds;
    activeIds.clear();
    for (const floater of damageFloaters.floaters()) {
      if (floatingFeedbackFamily(floater.kind) === "reward") continue;
      activeIds.add(floater.eventId);
      const target = renderedDynamicEntities.get(floater.targetEntityId)
        ?? retainedFlagMarkers.get(floater.targetEntityId);
      let display = renderedFloaters.get(floater.eventId);
      if (target ? !target.container.visible : !floater.worldPosition) {
        if (display) display.visible = false;
        continue;
      }
      if (!display && !floater.icon) {
        const pooled = floaterPool.get(floaterStyleKey(floater))?.pop();
        if (pooled && (pooled.destroyed || !(pooled.children[0] instanceof Text) || pooled.parent !== damageFloaterLayer)) {
          floaterPoolKeys.delete(pooled);
          if (!pooled.destroyed) pooled.destroy({ children: true });
        } else if (pooled) {
          (pooled.children[0] as Text).text = floatingFeedbackLabel(floater);
          display = pooled;
          renderedFloaters.set(floater.eventId, display);
        }
      }
      if (!display) {
        const style = floatingFeedbackStyle(floater.kind, floater.emphasis === "big", isDodgeFeedback(floater));
        const label = new Text({
          text: floatingFeedbackLabel(floater),
          resolution: OVERLAY_RENDER_RESOLUTION,
          roundPixels: true,
          style: {
            fill: style.fill,
            fontFamily: "Georgia, Inter, system-ui, sans-serif",
            fontSize: style.fontSize,
            fontWeight: "800",
            stroke: { color: style.stroke, width: 4 },
            dropShadow: { color: 0x000000, alpha: 0.65, blur: 2, distance: 1 }
          }
        });
        display = new Container();
        if (floater.icon) {
          const icon = new Sprite(worldTextures[floater.icon]);
          const resinGainDimensions = fixedWorldPngDimensions(
            WORLD_PNG_PRESENTATION.resinGain
          );
          const iconSize = floater.icon === "balsam_resin"
            ? resinGainDimensions.width
            : 26;
          icon.anchor.set(0, 1);
          icon.width = iconSize;
          icon.height = iconSize;
          const gap = 4;
          const width = label.width + gap + icon.width;
          label.anchor.set(0, 1);
          icon.position.x = -width / 2;
          label.position.x = icon.position.x + icon.width + gap;
          display.addChild(icon, label);
        } else {
          label.anchor.set(0.5, 1);
          display.addChild(label);
          const key = floaterStyleKey(floater);
          floaterPoolKeys.set(display, key);
          if (!floaterPool.has(key)) floaterPool.set(key, []);
        }
        damageFloaterLayer.addChild(display);
        renderedFloaters.set(floater.eventId, display);
      }
      const presentation = damageFloaterPresentation(floater, nowMs, reducedMotion);
      if (!drawnFloaterIds.has(floater.eventId) && presentation.alpha > 0) {
        drawnFloaterIds.add(floater.eventId);
        const labels = hitFeedbackStats.floatersDrawn;
        labels.push(floatingFeedbackLabel(floater));
        hitFeedbackStats.floatersDrawnTotal += 1;
        if (labels.length > 16) labels.shift();
        if (!target) hitFeedbackStats.orphanFloatersDrawn += 1;
        if (drawnFloaterIds.size > 256) drawnFloaterIds.delete(drawnFloaterIds.values().next().value as string);
      }
      display.visible = true;
      display.alpha = presentation.alpha * Math.min(1, target?.container.alpha
        ?? globeOverlayOpacityForMap(map, floater.worldPosition!));
      display.scale.set(presentation.scale);
      const targetScale = Math.max(0.8, target?.container.scale.y ?? 1);
      const anchor = target
        ? damageFloaterLayer.toLocal(target.container.toGlobal(floaterOrigin, floaterGlobal), undefined, floaterLocal)
        : map.project([floater.worldPosition!.lon, floater.worldPosition!.lat]);
      // Floaters (damage numbers, DODGE) start at the target chest (anchor + height offset), not the feet.
      const chestTarget = renderedDynamicEntities.get(floater.targetEntityId);
      const chestLiftPx = chestTarget
        ? combatChestLiftPx(chestTarget.visualArtworkHeightPx, chestTarget.playerRenderer ? "player" : "mob")
        : floater.chestLiftPx ?? 0;
      display.position.set(
        anchor.x + presentation.xOffsetPx,
        anchor.y - chestLiftPx + presentation.yOffsetPx * targetScale
      );
    }
    for (const [eventId, display] of renderedFloaters) {
      if (activeIds.has(eventId)) continue;
      renderedFloaters.delete(eventId);
      releaseFloater(display);
    }
  };

  const sparkPoint = { x: 0, y: 0 };
  /** dynamicEntityCenter without allocating: writes into `out`. */
  const dynamicEntityCenterInto = (entityId: string, out: { x: number; y: number }): { x: number; y: number } | null => {
    const rendered = renderedDynamicEntities.get(entityId);
    if (!rendered?.container.visible) return null;
    // Impact VFX spawn at the chest (anchor + height offset), never the feet; hit tests stay on the ground.
    return combatChestPointInto(
      rendered.container.x, rendered.container.y, rendered.visualArtworkHeightPx, rendered.playerRenderer ? "player" : "mob", out
    );
  };

  const dynamicEntityCenter = (
    entityId: string
  ): Readonly<{ x: number; y: number }> | null => {
    const rendered = renderedDynamicEntities.get(entityId);
    if (!rendered?.container.visible) return null;
    return combatChestPointInto(
      rendered.container.x, rendered.container.y, rendered.visualArtworkHeightPx, rendered.playerRenderer ? "player" : "mob",
      { x: 0, y: 0 }
    );
  };

  const SHOT_ARROW_LENGTH_FRACTION = 0.5;
  const liftedScratch = { ground: { x: 0, y: 0 }, body: { x: 0, y: 0 } };
  /** One soft ground shadow at a projectile's true (server-tested) ground position. */
  const drawProjectileShadow = (x: number, y: number, scale: number, alpha: number): void => {
    projectileShadowGraphics
      .ellipse(x, y, PROJECTILE_SHADOW_RADIUS_X_PX * scale, PROJECTILE_SHADOW_RADIUS_Y_PX * scale)
      .fill({ color: 0x000000, alpha: PROJECTILE_SHADOW_ALPHA * alpha });
  };
  const shotStart = { x: 0, y: 0 };
  const shotEnd = { x: 0, y: 0 };
  const arcaneImpact = { x: 0, y: 0 };
  /** A colour `amount` (0..1) of the way to white: the arcane bolt's hot core from its tint. */
  const lightenTint = (tint: number, amount: number): number => {
    const channel = (shift: number): number => {
      const value = (tint >> shift) & 0xff;
      return Math.round(value + (255 - value) * amount) << shift;
    };
    return channel(16) | channel(8) | channel(0);
  };
  /**
   * The arcane blast: a glowing bolt (tinted halo, bright core, a short fading trail) flown at chest height from just
   * ahead of the caster (the staff tip) along the shot's path, with a flash at the tip on release; then an impact burst
   * on the mob it hit (flash, expanding ring, rays), or a small fizzle at the end point on a miss.
   */
  /** A colour `amount` (0..1) of the way to black: the holy arc's outline/rim, derived from the one tint. */
  const darkenTint = (tint: number, amount: number): number => {
    const channel = (shift: number): number => Math.round(((tint >> shift) & 0xff) * (1 - amount)) << shift;
    return channel(16) | channel(8) | channel(0);
  };
  const drawArcaneBlast = (shot: ShotSlot, elapsed: number): void => {
    const rad = (shot.bearingDeg * Math.PI) / 180;
    const metersPerDegLat = 111_320;
    const cosLat = safeCosLatitude(shot.lat);
    const endLat = shot.lat + (Math.cos(rad) * shot.distanceM) / metersPerDegLat;
    const endLon = shot.lon + (Math.sin(rad) * shot.distanceM) / (metersPerDegLat * cosLat);
    const start = map.project([shot.lon, shot.lat]);
    const end = map.project([endLon, endLat]);
    const playerHeightPx = spriteHeightForZoom(mapGroundScaleZoom(map), SPRITE_BASE_ZOOM, SPRITE_PRESENTATION.player);
    const scale = Math.max(0.6, playerHeightPx / PLAYER_BASE_HEIGHT_PX);
    const bodyLiftPx = combatChestLiftPx(playerHeightPx, "player");
    // The staff tip: a little ahead of the caster along the aim and a little above the chest.
    const pathLengthPx = Math.hypot(end.x - start.x, end.y - start.y);
    const tipLeadPx = Math.min(pathLengthPx, 0.22 * playerHeightPx);
    const ux = pathLengthPx > 0 ? (end.x - start.x) / pathLengthPx : 0;
    const uy = pathLengthPx > 0 ? (end.y - start.y) / pathLengthPx : 0;
    const tipX = start.x + ux * tipLeadPx;
    const tipY = start.y + uy * tipLeadPx - bodyLiftPx - 0.12 * playerHeightPx;
    const tint = shot.tint;
    const core = lightenTint(tint, 0.8);
    const holy = shot.holy;
    const outline = darkenTint(tint, 0.42);
    const progress = shotFlightProgress(elapsed, shot.flightMs);
    if (elapsed < shot.flightMs) {
      const lifted = liftedProjectilePoint(start, end, progress, bodyLiftPx, liftedScratch);
      // Ease the bolt from the staff tip onto the chest-height path over the first third of the flight.
      const blend = Math.min(1, progress * 3);
      const bx = tipX + (lifted.body.x - tipX) * blend;
      const by = tipY + (lifted.body.y - tipY) * blend;
      drawProjectileShadow(lifted.ground.x, lifted.ground.y, scale, 0.8);
      if (!reducedMotion && progress > 0) {
        // Trail: three fading orbs behind the bolt, back toward the tip.
        for (let step = 1; step <= 3; step += 1) {
          const back = Math.min(1, (step * 0.07) / progress);
          const tx = bx - (bx - tipX) * back;
          const ty = by - (by - tipY) * back;
          if (holy) arcaneBlastGraphics.circle(tx, ty, (6 - step) * scale + 1.2 * scale).fill({ color: outline, alpha: 0.4 - step * 0.09 });
          arcaneBlastGraphics.circle(tx, ty, (6 - step) * scale).fill({ color: tint, alpha: 0.38 - step * 0.09 });
        }
      }
      if (holy) {
        arcaneBlastGraphics
          .circle(bx, by, 11 * scale).stroke({ color: outline, width: 1.5 * scale, alpha: 0.5 })
          .circle(bx, by, 7.6 * scale).fill({ color: outline, alpha: 0.85 });
      }
      arcaneBlastGraphics
        .circle(bx, by, 11 * scale).fill({ color: tint, alpha: 0.28 })
        .circle(bx, by, 6.5 * scale).fill({ color: tint, alpha: 0.7 })
        .circle(bx, by, 3.2 * scale).fill({ color: core, alpha: 0.95 });
      if (elapsed < 90) {
        // Release flash at the staff tip.
        const flash = elapsed / 90;
        arcaneBlastGraphics
          .circle(tipX, tipY, (5 + 7 * flash) * scale).fill({ color: tint, alpha: 0.45 * (1 - flash) })
          .circle(tipX, tipY, 3 * scale).fill({ color: core, alpha: 0.8 * (1 - flash) });
      }
      return;
    }
    // Impact: on the mob's chest when it hit (and is drawn), else where the bolt ended.
    const burst = Math.min(1, (elapsed - shot.flightMs) / ARCANE_BLAST_BURST_MS);
    const hitPoint = shot.targetId ? dynamicEntityCenterInto(shot.targetId, arcaneImpact) : null;
    const cx = hitPoint ? hitPoint.x : end.x;
    const cy = hitPoint ? hitPoint.y : end.y - bodyLiftPx;
    const fade = 1 - burst;
    if (!hitPoint) {
      // Miss: a small fizzle.
      arcaneBlastGraphics
        .circle(cx, cy, (4 + 8 * burst) * scale).stroke({ color: tint, width: 2 * scale, alpha: 0.7 * fade })
        .circle(cx, cy, 3 * scale * fade).fill({ color: core, alpha: 0.7 * fade });
      return;
    }
    if (burst < 0.4) {
      // Flash: a bright disc that blooms and fades in the first few frames.
      const flash = burst / 0.4;
      arcaneBlastGraphics
        .circle(cx, cy, (10 + 10 * flash) * scale).fill({ color: tint, alpha: 0.5 * (1 - flash) })
        .circle(cx, cy, (6 + 4 * flash) * scale).fill({ color: core, alpha: 0.95 * (1 - flash * flash) });
    }
    const ring = (8 + (reducedMotion ? 10 : 22) * burst) * scale;
    if (holy) arcaneBlastGraphics.circle(cx, cy, ring).stroke({ color: outline, width: (5.5 - 3 * burst) * scale, alpha: 0.7 * fade });
    arcaneBlastGraphics.circle(cx, cy, ring).stroke({ color: tint, width: (3.5 - 2 * burst) * scale, alpha: 0.9 * fade });
    if (!reducedMotion) {
      const near = ring * 0.6;
      const far = ring * 1.15;
      for (let ray = 0; ray < SPARK_RAY_COUNT; ray += 1) {
        const cos = sparkRayCos[ray]!;
        const sin = sparkRaySin[ray]!;
        arcaneBlastGraphics.moveTo(cx + cos * near, cy + sin * near).lineTo(cx + cos * far, cy + sin * far);
      }
      arcaneBlastGraphics.stroke({ color: core, width: 2 * scale, alpha: 0.8 * fade });
    }
  };
  /**
   * A holy arc heal on an ally: a soft glow, an expanding ring and a rising plus on their chest, in the arc's tint.
   * Skipped while the ally is not drawn.
   */
  const drawHealBurst = (shot: ShotSlot, elapsed: number): void => {
    const center = dynamicEntityCenterInto(shot.targetId, arcaneImpact);
    if (!center) return;
    const playerHeightPx = spriteHeightForZoom(mapGroundScaleZoom(map), SPRITE_BASE_ZOOM, SPRITE_PRESENTATION.player);
    const scale = Math.max(0.6, playerHeightPx / PLAYER_BASE_HEIGHT_PX);
    const t = Math.min(1, elapsed / HOLY_HEAL_BURST_MS);
    const fade = 1 - t;
    const tint = shot.tint;
    const core = lightenTint(tint, 0.7);
    const { x: cx, y: cy } = center;
    const rim = darkenTint(tint, 0.45);
    const ringR = (10 + (reducedMotion ? 10 : 24) * t) * scale;
    arcaneBlastGraphics
      .circle(cx, cy, (15 + 7 * t) * scale).fill({ color: tint, alpha: 0.5 * fade })
      .circle(cx, cy, ringR).stroke({ color: rim, width: 6 * scale, alpha: 0.85 * fade })
      .circle(cx, cy, ringR).stroke({ color: core, width: 3 * scale, alpha: 1 * fade });
    // A plus that rises a little as it fades.
    const lift = (reducedMotion ? 0 : 14 * t) * scale;
    const arm = 5 * scale;
    const px = cx;
    const py = cy - 0.35 * playerHeightPx - lift;
    arcaneBlastGraphics
      .moveTo(px - arm, py).lineTo(px + arm, py)
      .moveTo(px, py - arm).lineTo(px, py + arm)
      .stroke({ color: rim, width: 5.5 * scale, alpha: 0.9 * fade });
    arcaneBlastGraphics
      .moveTo(px - arm, py).lineTo(px + arm, py)
      .moveTo(px, py - arm).lineTo(px, py + arm)
      .stroke({ color: core, width: 2.5 * scale, alpha: 1 * fade });
  };
  /**
   * Flies each active shot arrow from the shooter along its bearing to the hit point (or full range) over the shot's flight time;
   * arcane blasts draw procedurally instead (drawArcaneBlast).
   */
  const drawShotProjectiles = (nowMs: number): void => {
    projectileShadowGraphics.clear();
    clearGraphicsIfDrawn(arcaneBlastGraphics);
    const shots = swingEffects.shots;
    for (let index = 0; index < shots.length; index += 1) {
      const shot = shots[index]!;
      const sprite = shotSprites[index] ?? null;
      const elapsed = nowMs - shot.startMs;
      if (shot.active && shot.kind === "heal") {
        if (sprite) sprite.visible = false;
        if (elapsed >= 0) drawHealBurst(shot, elapsed);
        continue;
      }
      if (shot.active && shot.kind === "arcane" && elapsed >= 0) {
        if (sprite) sprite.visible = false;
        drawArcaneBlast(shot, elapsed);
        continue;
      }
      if (!shot.active || !shot.transform || elapsed < 0) {
        if (sprite) sprite.visible = false;
        continue;
      }
      if (!sprite) {
        if (!pendingShotTextures.has(index)) {
          pendingShotTextures.add(index);
          void loadProjectileTexture(shot.assetKey).then((texture) => {
            pendingShotTextures.delete(index);
            if (!texture || shotSprites[index]) return;
            const created = new Sprite(texture);
            created.visible = false;
            projectileImpactLayer.addChild(created);
            shotSprites[index] = created;
          });
        }
        continue;
      }
      const rad = (shot.bearingDeg * Math.PI) / 180;
      const metersPerDegLat = 111_320;
      const cosLat = safeCosLatitude(shot.lat);
      const endLat = shot.lat + (Math.cos(rad) * shot.distanceM) / metersPerDegLat;
      const endLon = shot.lon + (Math.sin(rad) * shot.distanceM) / (metersPerDegLat * cosLat);
      const start = map.project([shot.lon, shot.lat]);
      const end = map.project([endLon, endLat]);
      // The ground points are the feet (the path the server tests); the arrow flies at the shooter's chest height
      // and a soft shadow traces the ground path under it.
      const playerHeightPx = spriteHeightForZoom(
        mapGroundScaleZoom(map),
        SPRITE_BASE_ZOOM,
        SPRITE_PRESENTATION.player
      );
      const bodyLiftPx = combatChestLiftPx(playerHeightPx, "player");
      shotStart.x = start.x; shotStart.y = start.y - bodyLiftPx;
      shotEnd.x = end.x; shotEnd.y = end.y - bodyLiftPx;
      const progress = shotFlightProgress(elapsed, shot.flightMs);
      const lifted = liftedProjectilePoint(start, end, progress, bodyLiftPx, liftedScratch);
      const at = { x: lifted.body.x, y: lifted.body.y };
      const scale = spriteHeightForZoom(
        mapGroundScaleZoom(map),
        SPRITE_BASE_ZOOM,
        SPRITE_PRESENTATION.player
      ) / PLAYER_BASE_HEIGHT_PX;
      const transform = resolveProjectileSpriteTransform(shot.transform, projectileAimRadians(shotStart, shotEnd), at, scale);
      sprite.visible = true;
      sprite.alpha = reducedMotion || elapsed < shot.flightMs ? 1 : Math.max(0, 1 - (elapsed - shot.flightMs) / 120);
      sprite.anchor.set(transform.anchorX, transform.anchorY);
      sprite.rotation = transform.rotationRadians;
      // The art is much longer than a bow at the catalog scale: shrink the flying arrow to about half the
      // character's height (tip stays on the anchor, so it still lands on the target).
      const arrowLengthPx = Math.max(1, (shot.transform.tailY - shot.transform.impactY) * sprite.texture.height * Math.abs(transform.scaleY));
      const shrink = Math.min(1, (SHOT_ARROW_LENGTH_FRACTION * playerHeightPx) / arrowLengthPx);
      sprite.scale.set(transform.scaleX * shrink, transform.scaleY * shrink);
      sprite.position.set(transform.positionX, transform.positionY);
      drawProjectileShadow(lifted.ground.x, lifted.ground.y, Math.max(0.6, scale), sprite.alpha);
      if (hitGeometryProbe) hitGeometryProbe.playerShot = { ground: { ...lifted.ground }, body: { ...lifted.body }, liftPx: bodyLiftPx, playerHeightPx, atMs: nowMs };
    }
  };

  const drawProjectileImpacts = (nowMs: number): void => {
    projectileImpacts.prune(nowMs);
    const activeIds = new Set<string>();
    for (const impact of projectileImpacts.impacts()) {
      activeIds.add(impact.eventId);
      const targetCenter = dynamicEntityCenter(impact.targetEntityId);
      // A tower is not a rendered entity: aim from its projected world position.
      const sourceCenter = impact.sourcePosition
        ? map.project([impact.sourcePosition.lon, impact.sourcePosition.lat])
        : dynamicEntityCenter(impact.sourceEntityId);
      const sprite = renderedProjectileImpacts.get(impact.eventId);
      if (!targetCenter) {
        if (sprite) sprite.visible = false;
        continue;
      }
      if (!sprite) {
        if (!pendingProjectileTextures.has(impact.eventId)) {
          pendingProjectileTextures.add(impact.eventId);
          void loadProjectileTexture(impact.assetKey).then((texture) => {
            pendingProjectileTextures.delete(impact.eventId);
            if (!texture || !projectileImpacts.has(impact.eventId)) return;
            const created = new Sprite(texture);
            projectileImpactLayer.addChild(created);
            renderedProjectileImpacts.set(impact.eventId, created);
          });
        }
        continue;
      }
      const scale = spriteHeightForZoom(
        mapGroundScaleZoom(map),
        SPRITE_BASE_ZOOM,
        SPRITE_PRESENTATION.player
      ) / PLAYER_BASE_HEIGHT_PX;
      const presentation = projectileImpactPresentation(impact, nowMs, reducedMotion);
      sprite.visible = true;
      sprite.alpha = presentation.alpha;
      const transform = projectileImpactSpriteTransform(
        impact,
        sourceCenter && targetCenter ? sourceCenter : null,
        targetCenter,
        scale
      );
      sprite.anchor.set(transform.anchorX, transform.anchorY);
      sprite.rotation = transform.rotationRadians;
      sprite.scale.set(transform.scaleX, transform.scaleY);
      sprite.position.set(transform.positionX, transform.positionY);
    }
    for (const [eventId, sprite] of renderedProjectileImpacts) {
      if (activeIds.has(eventId)) continue;
      renderedProjectileImpacts.delete(eventId);
      sprite.destroy();
    }
  };

  const drawPetPing = (nowMs: number): void => {
    clearGraphicsIfDrawn(petPingGraphics);
    if (!petPing) return;
    const elapsed = nowMs - petPing.startedAt;
    if (elapsed >= PET_PING_DURATION_MS || elapsed < 0) {
      petPing = null;
      return;
    }
    const point = map.project([petPing.position.lon, petPing.position.lat]);
    const opacity = globeOverlayOpacityForMap(map, petPing.position) * Math.min(1, (PET_PING_DURATION_MS - elapsed) / 5_000);
    const phase = reducedMotion ? 0.5 : (elapsed % 1_600) / 1_600;
    petPingGraphics
      .circle(point.x, point.y, 14 + phase * 26)
      .stroke({ color: 0xe7c982, width: 3, alpha: (1 - phase) * 0.85 * opacity })
      .moveTo(point.x, point.y)
      .lineTo(point.x, point.y - 30)
      .stroke({ color: 0x2b1d0e, width: 3, alpha: opacity })
      .circle(point.x, point.y - 34, 7)
      .fill({ color: 0xc9a45e, alpha: opacity })
      .stroke({ color: 0x2b1d0e, width: 2, alpha: opacity })
      .circle(point.x, point.y, 4)
      .fill({ color: 0xe7c982, alpha: opacity });
  };

  const drawTauntPulse = (nowMs: number): void => {
    clearGraphicsIfDrawn(classAbilityZoneGraphics);
    for (const [eventId, zone] of classAbilityZones) {
      if (zone.expiresAt <= nowMs) {
        classAbilityZones.delete(eventId);
        continue;
      }
      const center = map.project([zone.position.lon, zone.position.lat]);
      const radiusPx = screenRadiusForMeters(map, zone.position, zone.radiusM);
      const globeOpacity = globeOverlayOpacityForMap(map, zone.position);
      classAbilityZoneGraphics
        .circle(center.x, center.y, radiusPx)
        .fill({ color: 0xc9a45e, alpha: 0.12 * globeOpacity })
        .stroke({ color: 0xe7c982, width: 2, alpha: 0.78 * globeOpacity });
    }
    clearGraphicsIfDrawn(tauntPulseGraphics);
    clearGraphicsIfDrawn(petAbilityEffectGraphics);
    if (petAbilityEffects.size > 0) petAbilityEffects.forEach(nowMs, drawPetAbilityEffectFrame);
    clearGraphicsIfDrawn(classAbilityActivationGraphics);
    for (const pulse of classAbilityActivationPulses.presentations(nowMs)) {
      const center = map.project([pulse.position.lon, pulse.position.lat]);
      const globeOpacity = globeOverlayOpacityForMap(map, pulse.position);
      if (pulse.radiusM === null) {
        classAbilityActivationGraphics
          .circle(center.x, center.y, 18)
          .fill({ color: pulse.color, alpha: 0.22 * pulse.opacity * globeOpacity })
          .stroke({ color: pulse.color, width: 3, alpha: 0.9 * pulse.opacity * globeOpacity });
        continue;
      }
      const radiusPx = screenRadiusForMeters(map, pulse.position, pulse.radiusM);
      classAbilityActivationGraphics
        .circle(center.x, center.y, radiusPx)
        .fill({ color: pulse.color, alpha: 0.08 * pulse.opacity * globeOpacity })
        .stroke({ color: pulse.color, width: 3, alpha: 0.82 * pulse.opacity * globeOpacity });
      if (!reducedMotion) {
        classAbilityActivationGraphics
          .circle(center.x, center.y, radiusPx * (0.7 + pulse.progress * 0.3))
          .stroke({ color: pulse.color, width: 2, alpha: 0.62 * pulse.opacity * globeOpacity });
      }
    }
    const pulse = tauntPulse.presentation(nowMs);
    if (!pulse) return;
    const center = map.project([pulse.position.lon, pulse.position.lat]);
    const radiusPx = screenRadiusForMeters(map, pulse.position, pulse.radiusM);
    const globeOpacity = globeOverlayOpacityForMap(map, pulse.position);
    tauntPulseGraphics
      .circle(center.x, center.y, radiusPx)
      .fill({ color: 0xf59e0b, alpha: 0.08 * pulse.opacity * globeOpacity })
      .stroke({ color: 0xfbbf24, width: 3, alpha: 0.8 * pulse.opacity * globeOpacity })
      .circle(center.x, center.y, radiusPx * (0.72 + pulse.progress * 0.28))
      .stroke({ color: 0xfef3c7, width: 2, alpha: 0.65 * pulse.opacity * globeOpacity });
  };

  const FLAG_COLLAPSE_EFFECT_MS = 700;
  const FLAG_COLLAPSE_EFFECT_LIMIT = 1_000;
  const drawFlagCollapseEffects = (now: number): void => {
    clearGraphicsIfDrawn(flagCollapseGraphics);
    if (flagCollapseEffects.size === 0) return;
    const durationMs = reducedMotion ? FLAG_COLLAPSE_EFFECT_MS / 2 : FLAG_COLLAPSE_EFFECT_MS;
    for (const [id, effect] of flagCollapseEffects) {
      const progress = (now - effect.startedAt) / durationMs;
      if (progress >= 1 || progress < 0) {
        if (progress >= 1) flagCollapseEffects.delete(id);
        continue;
      }
      const fade = 1 - progress;
      const center = map.project([effect.lon, effect.lat]);
      const radiusPx = screenRadiusForMeters(map, effect, effect.claimRadiusM);
      // Reduced motion: a plain fade with no shrinking or falling rubble.
      const shrink = reducedMotion ? 1 : 1 - 0.2 * progress;
      flagCollapseGraphics
        .circle(center.x, center.y, radiusPx * shrink)
        .fill({ color: 0x6b5d4f, alpha: 0.22 * fade })
        .stroke({ color: 0xb8a48a, width: 2, alpha: 0.7 * fade });
      if (reducedMotion) continue;
      for (let index = 0; index < 6; index += 1) {
        const angle = (index / 6) * Math.PI * 2 + 0.4;
        const distance = 4 + 16 * progress;
        const x = center.x + Math.cos(angle) * distance;
        const y = center.y - 10 + Math.sin(angle) * distance * 0.5 + 18 * progress * progress;
        flagCollapseGraphics
          .rect(x - 1.5, y - 1.5, 3, 3)
          .fill({ color: 0x8a7a68, alpha: fade });
      }
    }
  };

  const SPARK_RAY_COUNT = 6;
  const sparkRayCos = Array.from({ length: SPARK_RAY_COUNT }, (_, index) => Math.cos(0.5 + (index * Math.PI * 2) / SPARK_RAY_COUNT));
  const sparkRaySin = Array.from({ length: SPARK_RAY_COUNT }, (_, index) => Math.sin(0.5 + (index * Math.PI * 2) / SPARK_RAY_COUNT));
  const SWING_HALF_ANGLE_RAD = (SWING_HALF_ANGLE_DEG * Math.PI) / 180;
  /** Draws the pooled slash arcs and sparks into the one swing Graphics (a fill and a stroke batch at most). */
  const drawSwingFx = (nowMs: number): void => {
    clearGraphicsIfDrawn(swingFxGraphics);
    swingEffects.prune(nowMs);
    if (!swingEffects.hasActive(nowMs)) return;
    // One Graphics: a fill batch and a stroke batch at most.
    perfMetrics.noteSwingDrawCalls(2);
    const bearingDeg = map.getBearing();
    const aimSlot = swingEffects.aimIndicator;
    if (aimSlot.active) {
      // Manual-aim sector at the player's feet: same 110 m x 120 degrees as the hit test, scaled to zoom.
      const center = map.project([aimSlot.lon, aimSlot.lat]);
      const radius = screenRadiusForMeters(map, aimSlot, SWING_RANGE_M);
      const aim = ((aimSlot.bearingDeg - bearingDeg) * Math.PI) / 180 - Math.PI / 2;
      swingFxGraphics
        .moveTo(center.x, center.y)
        .arc(center.x, center.y, radius, aim - SWING_HALF_ANGLE_RAD, aim + SWING_HALF_ANGLE_RAD)
        .closePath()
        .fill({ color: 0xffd98a, alpha: 0.22 })
        .stroke({ color: 0xffe9a8, width: 2, alpha: 0.8 });
    }
    for (const arc of swingEffects.arcs) {
      if (!arc.active) continue;
      // The slash arc freezes with its swinger's hitstop.
      const arcNowMs = arc.ownerId ? swingEffects.sampleNowMs(arc.ownerId, nowMs) : nowMs;
      const fade = arcFade(arcNowMs - arc.startMs);
      if (fade <= 0) continue;
      // The arc rides its swinger every frame (a walking player no longer leaves it behind); the press point is the fallback.
      const owner = arc.ownerId ? renderedDynamicEntities.get(arc.ownerId) : undefined;
      const center = owner && owner.container.visible ? owner.container.position : map.project([arc.lon, arc.lat]);
      const grow = 0.85 + 0.15 * (1 - fade);
      const outer = screenRadiusForMeters(map, arc, SWING_RANGE_M) * grow * (arc.finisher ? 1.12 : 1);
      const inner = outer * 0.55;
      // Canvas angle of a world bearing: screen direction is (sin, -cos) of the bearing minus the map bearing.
      const aim = ((arc.bearingDeg - bearingDeg) * Math.PI) / 180 - Math.PI / 2;
      const brightness = arc.finisher ? 1 : 0.7;
      swingFxGraphics
        .arc(center.x, center.y, outer, aim - SWING_HALF_ANGLE_RAD, aim + SWING_HALF_ANGLE_RAD)
        .arc(center.x, center.y, inner, aim + SWING_HALF_ANGLE_RAD, aim - SWING_HALF_ANGLE_RAD, true)
        .closePath()
        .fill({ color: arc.finisher ? 0xfff1b8 : 0xe8f2ff, alpha: 0.4 * brightness * fade })
        .arc(center.x, center.y, outer, aim - SWING_HALF_ANGLE_RAD, aim + SWING_HALF_ANGLE_RAD)
        .stroke({ color: 0xffffff, width: arc.finisher ? 4 : 3, alpha: 0.95 * brightness * fade });
    }
    for (const spark of swingEffects.sparks) {
      if (!spark.active) continue;
      const elapsed = nowMs - spark.startMs;
      const progress = elapsed / SPARK_DURATION_MS;
      if (progress < 0 || progress >= 1) continue;
      const point = dynamicEntityCenterInto(spark.entityId, sparkPoint) ?? map.project([spark.lon, spark.lat]);
      const size = spark.big ? 1.45 : 1;
      // Contact point: a little toward the attacker from the target's middle.
      const cx = point.x - spark.dirX * 6 * size;
      const cy = point.y - spark.dirY * 6 * size;
      if (!hitFeedbackStats.disabled && progress < 0.35) {
        // Impact star: a bright 4-point burst for the first few frames.
        const burst = progress / 0.35;
        const outer = (9 + 8 * burst) * size;
        const inner = outer * 0.3;
        const alpha = 1 - burst * burst;
        swingFxGraphics.moveTo(cx, cy - outer).lineTo(cx + inner, cy - inner).lineTo(cx + outer, cy)
          .lineTo(cx + inner, cy + inner).lineTo(cx, cy + outer).lineTo(cx - inner, cy + inner)
          .lineTo(cx - outer, cy).lineTo(cx - inner, cy - inner).closePath()
          .fill({ color: 0xffffff, alpha });
      }
      const near = (4 + 8 * progress) * size;
      const far = (12 + 16 * progress) * size;
      for (let ray = 0; ray < SPARK_RAY_COUNT; ray += 1) {
        const cos = sparkRayCos[ray]!;
        const sin = sparkRaySin[ray]!;
        swingFxGraphics.moveTo(cx + cos * near, cy + sin * near).lineTo(cx + cos * far, cy + sin * far);
      }
      swingFxGraphics.stroke({ color: spark.big ? 0xfff1b8 : 0xffe9a8, width: spark.big ? 3 : 2, alpha: 1 - progress });
      if (!hitFeedbackStats.disabled && elapsed < IMPACT_SLASH_MS && (spark.dirX !== 0 || spark.dirY !== 0)) {
        // Slash mark across the target, square to the swing, drawn on fast and fading.
        const slash = elapsed / IMPACT_SLASH_MS;
        const length = 30 * size * Math.min(1, slash * 3);
        const px = -spark.dirY;
        const py = spark.dirX;
        const tilt = 0.35;
        const ux = px + spark.dirX * tilt;
        const uy = py + spark.dirY * tilt;
        swingFxGraphics.moveTo(point.x - ux * length * 0.5, point.y - uy * length * 0.5)
          .lineTo(point.x + ux * length * 0.5, point.y + uy * length * 0.5)
          .stroke({ color: 0xffffff, width: (spark.big ? 4 : 3) * (1 - slash * 0.6), alpha: 1 - slash * slash });
      }
    }
  };

  const drawTimedDynamicPresentation = (
    now: number,
    deltaSeconds: number
  ): void => {
    drawDynamicEntities(displayStateForDynamicEntities(), deltaSeconds, now);
    gatherTargetReactions.update(now, gatherReactionMarker);
    drawFishingCastPresentation();
    drawFlagCollapseEffects(now);
    drawMultiTargetHighlights();
    drawPetPing(now);
    drawTauntPulse(now);
    drawProjectileImpacts(now);
    drawShotProjectiles(now);
    drawSwingFx(now);
    drawDeathGhosts(now);
    drawDamageFloaters(now);
    applyScreenShake(now);
  };

  /** Screen shake: translates the map host (map tiles and this overlay together; the HUD stays still). */
  const applyScreenShake = (nowMs: number): void => {
    const running = !hitFeedbackStats.disabled && presentation.screenShake.sample(nowMs, shakeScratch);
    if (swingEffects.anyHeld(nowMs)) hitFeedbackStats.heldFrames += 1;
    if (running) {
      const x = Math.round(shakeScratch.x * 2) / 2;
      const y = Math.round(shakeScratch.y * 2) / 2;
      hitFeedbackStats.shakeFrames += 1;
      const magnitude = Math.hypot(x, y);
      if (magnitude > hitFeedbackStats.maxShakePx) hitFeedbackStats.maxShakePx = magnitude;
      if (!shakeApplied || x !== shakeLastX || y !== shakeLastY) {
        container.style.transform = x === 0 && y === 0 ? "" : `translate3d(${x}px, ${y}px, 0)`;
        shakeLastX = x;
        shakeLastY = y;
        shakeApplied = true;
      }
    } else if (shakeApplied) {
      container.style.transform = "";
      shakeApplied = false;
    }
  };

  let walkHiddenFrame = false;
  const setWalkHidden = (hidden: boolean): void => {
    if (hidden === walkHiddenFrame) return;
    walkHiddenFrame = hidden;
    app.canvas.style.visibility = hidden ? "hidden" : "";
  };
  const drawFrame = (frameTimeMs?: number): void => {
    let paintedByMapRender = false;
    paintSynchronizedOverlayFrame(() => {
      const { now, deltaSeconds } = takeFrameTiming(frameTimeMs);
      if (preFrameHook) {
        const moved = preFrameHook(now);
        // Diagnostic (ash-atlas:overlay-walk=hidden): no overlay work or canvas while the camera follows.
        setWalkHidden(moved && overlayWalkMode() === "hidden");
        if (moved) {
          // This frame owns the MapLibre render (see ownMapRender): exactly one synchronous render with the new camera.
          ownMapRender = true;
          mapRepaintDeferred = false;
          map.redraw();
          const mapInternals = map as unknown as { _frameRequest?: AbortController | null };
          mapInternals._frameRequest?.abort();
          mapInternals._frameRequest = null;
        } else if (ownMapRender) {
          // The camera stopped: render once more if MapLibre asked for it meanwhile, then hand rendering back to MapLibre.
          ownMapRender = false;
          if (mapRepaintDeferred) {
            mapRepaintDeferred = false;
            map.redraw();
          }
        }
      }
      if (!walkHiddenFrame) {
        if (flagTravelPresentationActive) {
          applyFlagTravelTransform();
        }
        paintedByMapRender =
          now - lastFlagTravelMapRenderPaintAtMs < FLAG_TRAVEL_SAME_FRAME_PAINT_MS;
        if (flagTravelPresentationActive || flagTravelVisibilityTransition) {
          // The MapLibre render event already redrew the live layers for this display frame, and nothing
          // moves when the camera is idle and the reveal has not started.
          if (
            !paintedByMapRender &&
            (flagTravelVisibilityTransition?.timing || map.isMoving())
          ) {
            markFlagTravelLiveStaticLayersDirty();
          }
        }
        drawDirtyStaticLayers(
          displayStateForStaticLayers(),
          flagTravelPresentationActive || flagTravelVisibilityTransition
            ? "flag-travel-live"
            : "full"
        );
        const dynamicStartedAt = performance.now();
        drawTimedDynamicPresentation(now, deltaSeconds);
        hitFeedbackStats.frameWorkMs += performance.now() - dynamicStartedAt;
        hitFeedbackStats.frames += 1;
        if (flagTravelPresentationActive) {
          updateFlagTravelPlayerMotion(
            flagTravelPlayerMotion?.cameraGeneration ?? null,
            now
          );
          observeFlagTravelFrame();
        }
      }
    }, () => {
      if (walkHiddenFrame) {
        // Diagnostic: the overlay renders nothing.
      } else if (flagTravelPresentationActive && !paintedByMapRender) renderOverlay();
      else renderOverlayWhenDirty();
    });
  };

  let preFrameHook: ((nowMs: number) => boolean) | null = null;
  /**
   * While the pre-frame hook moves the camera, this frame loop is the only thing that renders the map: one synchronous render
   * per display frame, after the camera moved. MapLibre's own repaint requests (its re-arm after a render, tile loads, source
   * updates, fades) are held as mapRepaintDeferred instead of scheduling MapLibre's own requestAnimationFrame. That frame could
   * be queued ahead of the overlay's and render the old camera first (two map renders in one frame, or the ground a frame
   * behind the sprites, depending on WebKit's callback order). Released as soon as the camera stops.
   */
  let ownMapRender = false;
  let mapRepaintDeferred = false;
  const mapTriggerRepaint = map.triggerRepaint.bind(map);
  map.triggerRepaint = function triggerRepaintOwned(this: maplibregl.Map) {
    if (ownMapRender && dynamicAnimation.isActive()) {
      mapRepaintDeferred = true;
      return this;
    }
    ownMapRender = false;
    return mapTriggerRepaint();
  } as typeof map.triggerRepaint;
  const dynamicAnimation = createAnimationFrameLoop(drawFrame);
  const syncDynamicAnimationState = (): void => {
    dynamicAnimation.setActive(
      renderingActive &&
      !manualViewportInteractionActive &&
      !flagTravelVisibilityTransition
    );
  };

  /** The local player took a hit: light hitstop, push away from the attacker, shake on a big hit or a signature move. */
  const noteIncomingHit = (event: CombatEvent, nowMs: number): void => {
    const localId = latestState.localPlayerId;
    const sourceId = event.sourceEntityId;
    const target = renderedDynamicEntities.get(localId);
    const source = sourceId ? renderedDynamicEntities.get(sourceId) : undefined;
    let dirX = 0;
    let dirY = 0;
    if (target && source) {
      const dx = target.container.x - source.container.x;
      const dy = target.container.y - source.container.y;
      const length = Math.hypot(dx, dy);
      if (length > 0.5) {
        dirX = dx / length;
        dirY = dy / length;
      }
    }
    swingEffects.addIncomingHit(localId, sourceId, nowMs, dirX, dirY);
    if (hitFeedbackStats.disabled) return;
    const maxHealth = combatByIdScratch.get(localId)?.maxHealth ?? 0;
    const big = maxHealth > 0 && (event.amount ?? 0) >= maxHealth * BIG_HIT_HEALTH_SHARE;
    let signature = false;
    if (sourceId) {
      const telegraphs = combatByIdScratch.get(sourceId)?.telegraphs;
      if (telegraphs) for (const cast of telegraphs) if (isMobSignatureAbilityId(cast.abilityId)) signature = true;
      const actions = mobActionRenders.get(sourceId)?.state;
      if (actions && actions.programId !== null && actions.castInstanceId !== null) signature = true;
    }
    playCombatCue("hurt", { heavy: big || signature });
    if (big || signature) presentation.screenShake.start(nowMs, signature ? "signature" : "bigHit", currentShakeScale());
  };

  /**
   * A mob was defeated (MOB_REMOVED rides the delta of the killing DAMAGE). The death beat starts at the killing blow's contact
   * frame; the local player's own kill also gets extra hitstop, a bigger shake and kick, and the kill cue (haptic and sound).
   */
  const noteMobDefeated = (event: CombatEvent, events: readonly CombatEvent[], nowMs: number): void => {
    const mobId = event.targetEntityId ?? event.sourceEntityId;
    if (!mobId) return;
    const localId = latestState.localPlayerId;
    const hit = swingEffects.hitRecord(mobId);
    const contactAtMs = hit && hit.strength !== "incoming" ? Math.max(nowMs, hit.startMs) : nowMs;
    deathMarks.set(mobId, contactAtMs);
    noteMobTelegraphsGone(mobId, nowMs);
    for (const [castId, view] of telegraphViews) {
      if (!castId.startsWith(mobId + ":")) continue;
      view.destroy();
      telegraphViews.delete(castId);
    }
    mobProjectileGraphics.clear();
    // The killing blow's DAMAGE usually rides an earlier delta (or the swing result); this delta carries DEFEATED with the killer.
    const localKill = events.some((other) => (other.type === "DEFEATED" || other.type === "DAMAGE") && other.targetEntityId === mobId && other.sourceEntityId === localId);
    if (!localKill) return;
    if (!hitFeedbackStats.disabled && !hitFeedbackStats.legacyDeathBeat) {
      swingEffects.addKillHitstop(localId, contactAtMs, KILL_HITSTOP_MS);
      const scale = currentShakeScale();
      presentation.screenShake.start(contactAtMs, "kill", scale);
      if (hit && hit.strength !== "incoming") presentation.screenShake.kick(contactAtMs, hit.dirX, hit.dirY, "kill", scale);
    }
    playCombatCueAfter(contactAtMs - nowMs, "kill");
  };

  const enqueueCombatAncillaryEffects = (events: readonly CombatEvent[]): void => {
    const nowMs = performance.now();
    for (const event of events) {
      if (
        event.type === "DAMAGE" && (event.amount ?? 0) > 0 && event.targetEntityId &&
        event.targetEntityId === latestState.localPlayerId
      ) {
        noteIncomingHit(event, nowMs);
      }
      if (event.type === "MOB_REMOVED") noteMobDefeated(event, events, nowMs);
      if (event.type === "CLASS_ABILITY_ZONE_ENDED") {
        classAbilityZones.delete(event.eventId);
      } else if (
        event.type === "CLASS_ABILITY_ZONE_STARTED"
        && event.abilityId
        && event.position
        && event.radiusM !== undefined
        && event.durationMs !== undefined
      ) {
        classAbilityZones.set(event.eventId, {
          abilityId: event.abilityId,
          position: event.position,
          radiusM: event.radiusM,
          expiresAt: nowMs + event.durationMs
        });
      }
    }
    tauntPulse.enqueue(events, latestState.localPlayerId, nowMs);
    classAbilityActivationPulses.enqueue(events, nowMs);
    petAbilityEffects.enqueue(events, nowMs, petEffectOrigin);
  };

  const overlayApi: PixiGameOverlay = {
    update(state: RenderState): void {
      collectibleFirstAppearances.observeAuthoritativeIds(
        state.collectibles.map((collectible) => collectible.id),
        performance.now()
      );
      const nextGameplayViewCircleSignature = gameplayViewCircleSignature(state);
      if (nextGameplayViewCircleSignature !== lastGameplayViewCircleSignature) {
        lastGameplayViewCircleSignature = nextGameplayViewCircleSignature;
        markAllStaticLayersDirty();
      }
      if (state.flags !== lastFlagsInput) {
        lastFlagsInput = state.flags;
        const nextFlagsSignature = flagsSignature(state.flags);
        if (nextFlagsSignature !== lastFlagsSignature) {
          lastFlagsSignature = nextFlagsSignature;
          needsFlagRedraw = true;
          needsTerritoryRedraw = true;
          needsSelectionRedraw = true;
        }
      }
      const nextCitiesSignature = citiesSignature(state.cities);
      if (nextCitiesSignature !== lastCitiesSignature) {
        lastCitiesSignature = nextCitiesSignature;
        needsCityRedraw = true;
        needsSelectionRedraw = true;
      }
      const nextCityStructuresSignature = cityStructuresSignature(state.cityStructures);
      if (nextCityStructuresSignature !== lastCityStructuresSignature) {
        lastCityStructuresSignature = nextCityStructuresSignature;
        needsCityStructureRedraw = true;
      }
      const nextDungeonEntrancesSignature = dungeonEntrancesSignature(state.dungeonEntrances);
      state.dungeonEntrances.forEach(loadDungeonEntranceTexture);
      if (nextDungeonEntrancesSignature !== lastDungeonEntrancesSignature) {
        lastDungeonEntrancesSignature = nextDungeonEntrancesSignature;
        needsDungeonEntranceRedraw = true;
        needsSelectionRedraw = true;
      }
      const nextManorsSignature = manorsSignature(state.manors);
      if (nextManorsSignature !== lastManorsSignature) {
        lastManorsSignature = nextManorsSignature;
        needsManorRedraw = true;
        needsSelectionRedraw = true;
      }
      const nextGreenhousesSignature = greenhousesSignature(state.greenhouses ?? []);
      if (nextGreenhousesSignature !== lastGreenhousesSignature) {
        lastGreenhousesSignature = nextGreenhousesSignature;
        needsGreenhouseRedraw = true;
      }
      const nextFurnacesSignature = furnacesSignature(state.furnaces);
      if (nextFurnacesSignature !== lastFurnacesSignature) {
        lastFurnacesSignature = nextFurnacesSignature;
        needsFurnaceRedraw = true;
        needsSelectionRedraw = true;
      }
      const nextTanneriesSignature = tanneriesSignature(state.tanneries);
      if (nextTanneriesSignature !== lastTanneriesSignature) {
        lastTanneriesSignature = nextTanneriesSignature;
        needsTanneryRedraw = true;
        needsSelectionRedraw = true;
      }
      const nextLoomsSignature = loomsSignature(state.looms);
      if (nextLoomsSignature !== lastLoomsSignature) {
        lastLoomsSignature = nextLoomsSignature;
        needsLoomRedraw = true;
        needsSelectionRedraw = true;
      }
      const nextKitchensSignature = kitchensSignature(state.kitchens ?? []);
      if (nextKitchensSignature !== lastKitchensSignature) {
        lastKitchensSignature = nextKitchensSignature;
        needsKitchenRedraw = true;
        needsSelectionRedraw = true;
      }
      const nextFishingHutsSignature = fishingHutsSignature(state.fishingHuts ?? []);
      if (nextFishingHutsSignature !== lastFishingHutsSignature) {
        lastFishingHutsSignature = nextFishingHutsSignature;
        needsFishingHutRedraw = true;
        needsSelectionRedraw = true;
      }
      const nextSaplingsSignature = saplingsSignature(state.saplings ?? []);
      if (nextSaplingsSignature !== lastSaplingsSignature) {
        lastSaplingsSignature = nextSaplingsSignature;
        needsSaplingRedraw = true;
      }
      if (state.collectibles !== lastCollectiblesInput) {
        lastCollectiblesInput = state.collectibles;
        const nextCollectiblesSignature = collectiblesSignature(state.collectibles);
        if (nextCollectiblesSignature !== lastCollectiblesSignature) {
          lastCollectiblesSignature = nextCollectiblesSignature;
          needsCollectibleRedraw = true;
          const activeCollectibleIds = new Set(
            state.collectibles.map((collectible) => collectible.id)
          );
          for (let index = collectibleHitBoxes.length - 1; index >= 0; index -= 1) {
            const hitBox = collectibleHitBoxes[index];
            if (hitBox && !activeCollectibleIds.has(hitBox.collectible.id)) {
              collectibleHitBoxes.splice(index, 1);
            }
          }
        }
      }
      const nextDroppedItemsSignature = droppedItemsSignature(state.droppedItems);
      if (nextDroppedItemsSignature !== lastDroppedItemsSignature) {
        lastDroppedItemsSignature = nextDroppedItemsSignature;
        needsDroppedItemRedraw = true;
      }
      const nextWaterHighlightsSignature = waterHighlightsSignature(state);
      if (nextWaterHighlightsSignature !== lastWaterHighlightsSignature) {
        lastWaterHighlightsSignature = nextWaterHighlightsSignature;
        needsWaterHighlightRedraw = true;
      }
      if (state.selectedFlagId !== lastSelectedFlagId) {
        lastSelectedFlagId = state.selectedFlagId;
        needsSelectionRedraw = true;
      }
      if (state.selectedCityId !== lastSelectedCityId) {
        lastSelectedCityId = state.selectedCityId;
        needsSelectionRedraw = true;
      }
      if (state.selectedDungeonEntranceId !== lastSelectedDungeonEntranceId) {
        lastSelectedDungeonEntranceId = state.selectedDungeonEntranceId;
        needsSelectionRedraw = true;
      }
      if (state.selectedManorId !== lastSelectedManorId) {
        lastSelectedManorId = state.selectedManorId;
        needsSelectionRedraw = true;
      }
      if (state.selectedGreenhouseId !== lastSelectedGreenhouseId) {
        lastSelectedGreenhouseId = state.selectedGreenhouseId ?? null;
        needsSelectionRedraw = true;
      }
      if (state.selectedFurnaceId !== lastSelectedFurnaceId) {
        lastSelectedFurnaceId = state.selectedFurnaceId;
        needsSelectionRedraw = true;
      }
      if (state.selectedTanneryId !== lastSelectedTanneryId) {
        lastSelectedTanneryId = state.selectedTanneryId;
        needsSelectionRedraw = true;
      }
      if (state.selectedLoomId !== lastSelectedLoomId) {
        lastSelectedLoomId = state.selectedLoomId;
        needsSelectionRedraw = true;
      }
      if (state.selectedKitchenId !== lastSelectedKitchenId) {
        lastSelectedKitchenId = state.selectedKitchenId ?? null;
        needsSelectionRedraw = true;
      }
      if (state.selectedFishingHutId !== lastSelectedFishingHutId) {
        lastSelectedFishingHutId = state.selectedFishingHutId ?? null;
        needsSelectionRedraw = true;
      }
      if (state.selectedDroppedItemId !== lastSelectedDroppedItemId) {
        lastSelectedDroppedItemId = state.selectedDroppedItemId;
        needsDroppedItemRedraw = true;
      }
      if ((state.selectedMilitaryGroupId ?? null) !== lastSelectedMilitaryGroupId) {
        lastSelectedMilitaryGroupId = state.selectedMilitaryGroupId ?? null;
        needsSelectionRedraw = true;
      }
      const nextFlagPlacementPreviewSignature = flagPlacementPreviewSignature(state);
      if (nextFlagPlacementPreviewSignature !== lastFlagPlacementPreviewSignature) {
        lastFlagPlacementPreviewSignature = nextFlagPlacementPreviewSignature;
        needsSelectionRedraw = true;
      }
      const nextSiegeDeploymentPreviewSignature = siegeDeploymentPreviewSignature(state);
      if (nextSiegeDeploymentPreviewSignature !== lastSiegeDeploymentPreviewSignature) {
        lastSiegeDeploymentPreviewSignature = nextSiegeDeploymentPreviewSignature;
        needsSelectionRedraw = true;
      }
      const nextSiegeTargetSignature = siegeTargetSignature(state);
      if (nextSiegeTargetSignature !== lastSiegeTargetSignature) {
        lastSiegeTargetSignature = nextSiegeTargetSignature;
        needsSelectionRedraw = true;
      }
      const nextLeashSignature = localPlayerLeashSignature(state);
      if (nextLeashSignature !== lastLeashSignature) {
        lastLeashSignature = nextLeashSignature;
        needsLeashRedraw = true;
      }
      observeMilitaryRenderSamples(state.militaryGroups);
      latestState = state;
    },
    paintCurrentFrame(): boolean {
      if (!renderingActive) return false;
      drawFrame();
      return true;
    },
    async settleCurrentFrame(): Promise<boolean> {
      if (!renderingActive) return false;
      drawFrame();
      const localPlayer = renderedDynamicEntities.get(latestState.localPlayerId);
      if (localPlayer?.kind === "player" && localPlayer.playerRenderer) {
        let pending = pendingAppearanceUpdates.get(localPlayer.entityId);
        if (!pending && !localPlayer.playerRenderer.appearanceComplete) {
          const snapshot = latestState.players.find(
            (player) => player.playerId === localPlayer.entityId
          )?.appearance;
          pending = localPlayer.playerRenderer.updateAppearance(snapshot);
          trackAppearanceUpdate(localPlayer.entityId, pending);
        }
        if (pending) {
          await settleWithinBudget(
            pending,
            LOCAL_APPEARANCE_SETTLE_BUDGET_MS
          );
        }
      }
      if (!renderingActive) return false;
      drawFrame();
      return true;
    },
    renderedMobPosition(entityId: string): LatLon | null {
      const rendered = renderedDynamicEntities.get(entityId);
      return rendered?.container.visible ? rendered.mobPosition : null;
    },
    setMobPresentationReady(ready: boolean): void {
      if (mobPresentationReady === ready) return;
      mobPresentationReady = ready;
      drawFrame();
    },
    localPlayerArtworkHeightPx(): number | null {
      const entity = renderedDynamicEntities.get(latestState.localPlayerId);
      if (!entity || !entity.container.visible) return null;
      const height = entity.artwork.getBounds().height / (app.renderer.resolution || 1);
      return Number.isFinite(height) && height > 0 ? height : null;
    },
    reconcileLocalPlayer(): boolean {
      if (!renderingActive) return false;
      if (!flagTravelVisibilityTransition) {
        dynamicAnimation.restart();
      }
      const now = performance.now();
      drawDynamicEntities(displayStateForDynamicEntities(), 0, now);
      const localPlayer = retainedLocalPlayer();
      if (!localPlayer) return false;
      if (localPlayer.container.parent !== localPlayerLayer) {
        localPlayerLayer.addChild(localPlayer.container);
      }
      renderOverlay();
      return localPlayer.container.visible;
    },
    setPendingSelection(selection: WorldMapSelectionState | null): void {
      pendingSelection = selection;
      needsSelectionRedraw = true;
      needsDroppedItemRedraw = true;
    },
    setViewportInteractionActive(active: boolean): void {
      if (active) {
        endFollowReuse();
        lastStaticArtworkCorrection = null;
        manualViewportInteractionActive = true;
        syncDynamicAnimationState();
        frozenStaticState ??=
          lastDrawnVisibleStaticState ?? visibleStaticStateForMap(map, container, latestState);
        staticLayersFrozen = true;
        frozenTransformReference ??=
          staticGeometryReference ?? captureStaticOverlayTransformReference(map);
        applyLiveStaticLayerTransform();
        return;
      }
      if (frozenStaticState || staticLayersFrozen) {
        frozenStaticState = null;
        staticLayersFrozen = false;
        frozenTransformReference = null;
        resetStaticOverlayContainerTransform(staticLayer);
        resetStaticOverlayContainerTransform(kingdomSeatLayer);
        markAllStaticLayersDirty();
        pendingTransformRedraw = false;
      }
      lastFrameAt = performance.now();
      manualViewportInteractionActive = false;
      syncDynamicAnimationState();
    },
    setProgrammaticCameraMoveActive(active: boolean): void {
      if (active) {
        endFollowReuse();
        lastStaticArtworkCorrection = null;
        frozenStaticState ??=
          lastDrawnVisibleStaticState ?? visibleStaticStateForMap(map, container, latestState);
        staticLayersFrozen = true;
        frozenTransformReference ??=
          staticGeometryReference ?? captureStaticOverlayTransformReference(map);
        applyLiveStaticLayerTransform();
        return;
      }
      if (frozenStaticState || staticLayersFrozen) {
        frozenStaticState = null;
        staticLayersFrozen = false;
        frozenTransformReference = null;
        resetStaticOverlayContainerTransform(staticLayer);
        resetStaticOverlayContainerTransform(kingdomSeatLayer);
        markAllStaticLayersDirty();
        pendingTransformRedraw = false;
        drawDirtyStaticLayers(latestState);
      }
    },
    beginFlagTravelPresentation(
      destinationFlagId?: string | null,
      destinationPlayer?: LatLon,
      destinationAnchor?: LatLon,
      destinationCurrentFlagId?: string | null
    ): FlagTravelPresentationCapture {
      const capture: FlagTravelPresentationCapture = {
        id: nextFlagTravelCaptureId,
        newlyFrozen: !flagTravelPresentationActive
      };
      nextFlagTravelCaptureId += 1;
      if (flagTravelPresentationActive) {
        return capture;
      }
      if (flagTravelVisibilityTransition) {
        flagTravelVisibilityTransition = null;
        flagTravelOriginCombatEntities = [];
        resetFlagTravelDurableTransforms();
        markAllStaticLayersDirty();
        const now = performance.now();
        drawDirtyStaticLayers(stateWithPendingSelection(latestState));
        drawDynamicEntities(stateWithPendingSelection(latestState), 0, now);
        drawTauntPulse(now);
        drawDamageFloaters(now);
        renderOverlay();
      }
      flagTravelDestinationFlagId = destinationFlagId ?? null;
      flagTravelDestinationCurrentFlagId = destinationCurrentFlagId;
      flagTravelDestinationPlayer = destinationPlayer ?? null;
      flagTravelDestinationAnchor = destinationAnchor ?? destinationPlayer ?? null;
      restoreStaticPresentationForFlagTravel();
      const originLocalPlayer = retainedLocalPlayer();
      flagTravelOriginLocalPlayerScreen = originLocalPlayer?.container.visible
        ? {
            x: originLocalPlayer.container.x,
            y: originLocalPlayer.container.y
          }
        : null;
      const originStaticState = lastDrawnVisibleStaticState ?? latestState;
      flagTravelOriginStaticState = {
        ...originStaticState,
        selectedCollectibleId: null,
        selectedDroppedItemId: null,
        selectedCombatEntityId: null
      };
      flagTravelOriginCombatEntities = [...(combatStore?.entities() ?? [])];
      flagTravelVisibilityTransition = {
        captureId: capture.id,
        timing: null,
        cleanupAtMs: null,
        originState: flagTravelOriginStaticState,
        originCombatEntities: flagTravelOriginCombatEntities,
        firstSeenAtMs: new Map()
      };
      flagTravelVisibilityFrameNowMs = performance.now();
      mobPresentationReady = false;
      flagTravelPresentationActive = true;
      syncDynamicAnimationState();
      flagTravelTransformReference = captureStaticOverlayTransformReference(map);
      markAllStaticLayersDirty();
      const now = performance.now();
      drawDirtyStaticLayers(displayStateForStaticLayers());
      drawDynamicEntities(displayStateForDynamicEntities(), 0, now);
      renderOverlay();
      flagTravelPresentationInstrumentation.reset();
      flagTravelPresentationInstrumentation.event("origin-presentation-frozen");
      observeFlagTravelFrame();
      return capture;
    },
    startFlagTravelVisibilityTransition(
      captureId,
      startedAtMs,
      durationMs
    ): boolean {
      if (
        !flagTravelPresentationActive ||
        !flagTravelOriginStaticState ||
        captureId !== nextFlagTravelCaptureId - 1 ||
        flagTravelVisibilityTransition?.captureId !== captureId
      ) {
        return false;
      }
      const timing = { startedAtMs, durationMs };
      flagTravelVisibilityTransition = {
        captureId,
        timing,
        cleanupAtMs: flagTravelVisibilityCleanupAt(timing),
        originState: flagTravelVisibilityTransition.originState,
        originCombatEntities:
          flagTravelVisibilityTransition.originCombatEntities,
        firstSeenAtMs: new Map()
      };
      flagTravelVisibilityFrameNowMs = startedAtMs;
      markFlagTravelLiveStaticLayersDirty();
      syncDynamicAnimationState();
      return true;
    },
    clearFlagTravelVisibilityTransition(): void {
      if (!flagTravelVisibilityTransition) return;
      flagTravelVisibilityTransition = null;
      flagTravelOriginCombatEntities = [];
      markFlagTravelLiveStaticLayersDirty();
      syncDynamicAnimationState();
    },
    startFlagTravelPlayerMotion(input): boolean {
      if (
        !flagTravelPresentationActive ||
        !flagTravelDestinationPlayer ||
        !flagTravelOriginLocalPlayerScreen ||
        input.captureId !== nextFlagTravelCaptureId - 1
      ) {
        return false;
      }
      const canvas = map.getCanvas();
      const padding = map.getPadding();
      const destinationScreen = paddedViewportCenter({
        width: canvas.clientWidth || app.screen.width,
        height: canvas.clientHeight || app.screen.height,
        padding: {
          top: padding.top ?? 0,
          right: padding.right ?? 0,
          bottom: padding.bottom ?? 0,
          left: padding.left ?? 0
        }
      });
      flagTravelPlayerMotion = {
        captureId: input.captureId,
        cameraGeneration: input.cameraGeneration,
        originScreen: flagTravelOriginLocalPlayerScreen,
        destinationScreen,
        destination: flagTravelDestinationPlayer,
        startedAtMs: input.startedAtMs,
        durationMs: input.durationMs,
        easing: input.easing
      };
      flagTravelPlannedLocalPlayerPosition =
        flagTravelPlayerMotion.originScreen;
      flagTravelPresentationInstrumentation.setCameraGeneration(
        input.cameraGeneration
      );
      return true;
    },
    updateFlagTravelTransform(_cameraGeneration: number | null): void {
      void _cameraGeneration;
      if (!flagTravelPresentationActive && !flagTravelVisibilityTransition) return;
      const visibilityNow = performance.now();
      flagTravelVisibilityFrameNowMs = visibilityNow;
      if (
        flagTravelVisibilityTransition &&
        flagTravelVisibilityTransition.cleanupAtMs !== null &&
        visibilityNow >= flagTravelVisibilityTransition.cleanupAtMs
      ) {
        flagTravelVisibilityTransition = null;
        flagTravelOriginCombatEntities = [];
        syncDynamicAnimationState();
      }
      if (staticLayersFrozen) {
        if (flagTravelVisibilityTransition?.timing) map.triggerRepaint();
        return;
      }
      paintSynchronizedOverlayFrame(() => {
        const { now, deltaSeconds } = takeFrameTiming();
        flagTravelVisibilityFrameNowMs = now;
        applyFlagTravelTransform();
        markFlagTravelLiveStaticLayersDirty();
        drawDirtyStaticLayers(
          displayStateForStaticLayers(),
          "flag-travel-live"
        );
        drawTimedDynamicPresentation(now, deltaSeconds);
        observeFlagTravelFrame();
      }, renderOverlay);
      lastFlagTravelMapRenderPaintAtMs = performance.now();
      if (flagTravelVisibilityTransition?.timing) map.triggerRepaint();
    },
    completeFlagTravelPlayerMotion(cameraGeneration: number): boolean {
      if (
        !flagTravelPresentationActive ||
        !flagTravelPlayerMotion ||
        !isCurrentFlagTravelPlayerMotion(
          flagTravelPlayerMotion,
          cameraGeneration
        )
      ) {
        return false;
      }
      updateFlagTravelPlayerMotion(
        cameraGeneration,
        flagTravelPlayerMotion.startedAtMs +
          flagTravelPlayerMotion.durationMs
      );
      observeFlagTravelFrame(false, false, true);
      return true;
    },
    commitFlagTravelDestination(): boolean {
      if (!flagTravelPresentationActive) return false;
      flagTravelPresentationInstrumentation.event("destination-state-committed");
      if (flagTravelVisibilityTransition?.timing === null) {
        flagTravelVisibilityTransition = null;
        flagTravelOriginCombatEntities = [];
        syncDynamicAnimationState();
      }
      mobPresentationReady = true;
      flagTravelPresentationActive = false;
      flagTravelOriginStaticState = null;
      flagTravelTransformReference = null;
      flagTravelOriginLocalPlayerScreen = null;
      flagTravelPlayerMotion = null;
      flagTravelPlannedLocalPlayerPosition = null;
      resetFlagTravelDurableTransforms();
      markAllStaticLayersDirty();
      pendingTransformRedraw = false;
      const now = performance.now();
      drawDirtyStaticLayers(displayStateForStaticLayers());
      drawDynamicEntities(displayStateForDynamicEntities(), 0, now);
      drawTauntPulse(now);
      drawDamageFloaters(now);
      observeFlagTravelFrame(true, true);
      renderOverlay();
      flagTravelDestinationFlagId = null;
      flagTravelDestinationCurrentFlagId = undefined;
      flagTravelDestinationPlayer = null;
      flagTravelDestinationAnchor = null;
      flagTravelPresentationInstrumentation.event("first-destination-pixi-paint");
      return true;
    },
    cancelFlagTravelPresentation(capture: FlagTravelPresentationCapture): void {
      if (!capture.newlyFrozen || !flagTravelPresentationActive) return;
      flagTravelPresentationActive = false;
      flagTravelVisibilityTransition = null;
      flagTravelDestinationFlagId = null;
      flagTravelDestinationCurrentFlagId = undefined;
      flagTravelDestinationPlayer = null;
      flagTravelDestinationAnchor = null;
      flagTravelOriginStaticState = null;
      flagTravelOriginCombatEntities = [];
      flagTravelTransformReference = null;
      flagTravelOriginLocalPlayerScreen = null;
      flagTravelPlayerMotion = null;
      flagTravelPlannedLocalPlayerPosition = null;
      syncDynamicAnimationState();
      resetFlagTravelDurableTransforms();
      markAllStaticLayersDirty();
      const now = performance.now();
      drawDirtyStaticLayers(stateWithPendingSelection(latestState));
      drawDynamicEntities(stateWithPendingSelection(latestState), 0, now);
      drawTauntPulse(now);
      drawDamageFloaters(now);
      renderOverlay();
    },
    flagTravelPresentationMetrics(): FlagTravelPresentationMetrics {
      return flagTravelPresentationInstrumentation.snapshot();
    },
    setRenderingActive(active: boolean): void {
      if (renderingActive === active) return;
      renderingActive = active;
      if (active) {
        lastFrameAt = performance.now();
        markAllStaticLayersDirty();
      }
      syncDynamicAnimationState();
    },
    setPreFrameHook(hook: ((nowMs: number) => boolean) | null): void { preFrameHook = hook; },
    isRenderingActive(): boolean { return renderingActive; },
    resizeViewport(): void { app.resize(); },
    markMapTransformDirty: (): void => { endFollowReuse(); markMapTransformDirty(); },
    markFollowTransformDirty,
    pickMilitaryGroupAt(point: { x: number; y: number }): MilitaryUnitGroupSnapshot | null {
      for (let index = militaryGroupHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = militaryGroupHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return (latestState.militaryGroups ?? []).find(
            (group) => group.groupId === hit.group.groupId
          ) ?? hit.group;
        }
      }
      return null;
    },
    pickWarCampAt(point: { x: number; y: number }): WarCampSnapshot | null {
      for (let index = warCampHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = warCampHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return (latestState.warCamps ?? []).find((camp) => camp.campId === hit.camp.campId) ?? hit.camp;
        }
      }
      return null;
    },
    pickFlagAt(point: { x: number; y: number }): FlagSnapshot | null {
      for (let index = flagHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = flagHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return lastFlags.find((flag) => flag.id === hit.flag.id) ?? hit.flag;
        }
      }
      return null;
    },
    pickCityAt(point: { x: number; y: number }): CitySnapshot | null {
      for (let index = cityHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = cityHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return lastCities.find((city) => city.id === hit.city.id) ?? hit.city;
        }
      }
      return null;
    },
    pickCityStructureAt(point: { x: number; y: number }): CityStructureSnapshot | null {
      for (let index = cityStructureHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = cityStructureHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return lastCityStructures.find(
            (structure) => structure.structureId === hit.structure.structureId
          ) ?? hit.structure;
        }
      }
      return null;
    },
    pickDungeonEntranceAt(point: { x: number; y: number }): DungeonEntranceSnapshot | null {
      for (let index = dungeonEntranceHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = dungeonEntranceHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return lastDungeonEntrances.find(
            (entrance) => entrance.entranceId === hit.entrance.entranceId
          ) ?? hit.entrance;
        }
      }
      return null;
    },
    pickManorAt(point: { x: number; y: number }): ManorWorldSnapshot | null {
      return pickManorHitBox(point, manorHitBoxes, lastManors);
    },
    pickGreenhouseAt(point: { x: number; y: number }): GreenhouseSnapshot | null {
      for (let index = greenhouseHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = greenhouseHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return lastGreenhouses.find(
            (greenhouse) => greenhouse.greenhouseId === hit.greenhouse.greenhouseId
          ) ?? hit.greenhouse;
        }
      }
      return null;
    },
    pickFurnaceAt(point: { x: number; y: number }): FurnaceWorldSnapshot | null {
      for (let index = furnaceHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = furnaceHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return lastFurnaces.find(
            (furnace) => furnace.furnaceId === hit.furnace.furnaceId
          ) ?? hit.furnace;
        }
      }
      return null;
    },
    pickTanneryAt(point: { x: number; y: number }): TanneryWorldSnapshot | null {
      for (let index = tanneryHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = tanneryHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return lastTanneries.find(
            (tannery) => tannery.tanneryId === hit.tannery.tanneryId
          ) ?? hit.tannery;
        }
      }
      return null;
    },
    pickLoomAt(point: { x: number; y: number }): LoomWorldSnapshot | null {
      for (let index = loomHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = loomHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return lastLooms.find((loom) => loom.loomId === hit.loom.loomId) ?? hit.loom;
        }
      }
      return null;
    },
    pickKitchenAt(point: { x: number; y: number }): KitchenWorldSnapshot | null {
      for (let index = kitchenHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = kitchenHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return lastKitchens.find(
            (kitchen) => kitchen.kitchenId === hit.kitchen.kitchenId
          ) ?? hit.kitchen;
        }
      }
      return null;
    },
    pickSaplingAt(point: { x: number; y: number }): string | null {
      for (let index = saplingHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = saplingHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit, 6)) return hit.saplingId;
      }
      return null;
    },
    pickFishingHutAt(point: { x: number; y: number }): FishingHutWorldSnapshot | null {
      for (let index = fishingHutHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = fishingHutHitBoxes[index];
        if (hit && containsScreenHitBox(point, hit)) {
          return lastFishingHuts.find(
            (fishingHut) => fishingHut.fishingHutId === hit.fishingHut.fishingHutId
          ) ?? hit.fishingHut;
        }
      }
      return null;
    },
    pickCollectibleAt(point: { x: number; y: number }): CollectibleNode | null {
      const pickPoint = staticLayersFrozen
        ? staticLayer.toLocal(point)
        : point;
      for (let index = collectibleHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = collectibleHitBoxes[index];
        if (!hit) {
          continue;
        }
        if (containsScreenHitBox(pickPoint, hit)) {
          const current = authoritativeCollectibleForHit(
            lastCollectibles,
            hit.collectible.id
          );
          if (current) return current;
        }
      }
      return null;
    },
    pickDroppedItemAt(point: { x: number; y: number }): DroppedItemSnapshot | null {
      for (let index = droppedItemHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = droppedItemHitBoxes[index];
        if (!hit) {
          continue;
        }
        if (containsScreenHitBox(point, hit)) {
          return lastDroppedItems.find((drop) => drop.dropId === hit.drop.dropId) ?? hit.drop;
        }
      }
      return null;
    },
    pickCombatEntityAt(point: { x: number; y: number }): CombatEntitySnapshot | null {
      let nearest: (typeof combatEntityHitBoxes)[number] | null = null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const hit of combatEntityHitBoxes) {
        const center = screenHitBoxCenter(hit);
        const distance = Math.hypot(point.x - center.x, point.y - center.y);
        if (containsScreenHitBox(point, hit) && distance < nearestDistance) {
          nearest = hit;
          nearestDistance = distance;
        }
      }
      return nearest?.entity ?? null;
    },
    whenInteriorReady(spaceKey: string): Promise<boolean> {
      interiorRoom.update(latestState.interior ?? null);
      return interiorRoom.whenReady(spaceKey);
    },
    pickPlayerAt(point: { x: number; y: number }): PlayerSnapshot | null {
      let nearest: (typeof playerHitBoxes)[number] | null = null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const hit of playerHitBoxes) {
        const center = screenHitBoxCenter(hit);
        const distance = Math.hypot(point.x - center.x, point.y - center.y);
        if (containsScreenHitBox(point, hit) && distance < nearestDistance) {
          nearest = hit;
          nearestDistance = distance;
        }
      }
      return nearest?.player ?? null;
    },
    pickWorldObjectsAt(
      point: { x: number; y: number },
      assistancePaddingPx = DEFAULT_WORLD_MULTI_SELECT_PADDING_PX
    ): WorldObjectPick[] {
      const candidates: WorldObjectPickCandidate[] = [];
      const seen = new Set<string>();
      const append = (key: string, pick: WorldObjectPick, distancePx: number): void => {
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ key, pick, distancePx });
      };

      for (let index = droppedItemHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = droppedItemHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, assistancePaddingPx)) continue;
        const value = lastDroppedItems.find((drop) => drop.dropId === hit.drop.dropId) ?? hit.drop;
        const center = screenHitBoxCenter(hit);
        append(
          `dropped_item:${value.pileId ?? value.dropId}`,
          { kind: "dropped_item", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }

      const collectiblePoint = staticLayersFrozen ? staticLayer.toLocal(point) : point;
      for (let index = collectibleHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = collectibleHitBoxes[index];
        if (!hit) continue;
        if (!containsScreenHitBox(
          collectiblePoint,
          hit,
          assistancePaddingPx
        )) continue;
        const value = authoritativeCollectibleForHit(
          lastCollectibles,
          hit.collectible.id
        );
        if (value) {
          const localCenter = screenHitBoxCenter(hit);
          const center = staticLayersFrozen
            ? staticLayer.toGlobal(localCenter)
            : localCenter;
          append(
            `collectible:${value.id}`,
            { kind: "collectible", value },
            Math.hypot(point.x - center.x, point.y - center.y)
          );
        }
      }

      for (const hit of playerHitBoxes) {
        if (containsScreenHitBox(point, hit, assistancePaddingPx)) {
          const center = screenHitBoxCenter(hit);
          append(
            `player:${hit.player.playerId}`,
            { kind: "player", value: hit.player },
            Math.hypot(point.x - center.x, point.y - center.y)
          );
        }
      }

      for (const hit of combatEntityHitBoxes) {
        if (containsScreenHitBox(point, hit, assistancePaddingPx)) {
          const center = screenHitBoxCenter(hit);
          append(`combat_entity:${hit.entity.entityId}`, {
            kind: "combat_entity",
            value: hit.entity
          }, Math.hypot(point.x - center.x, point.y - center.y));
        }
      }

      for (let index = manorHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = manorHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, assistancePaddingPx)) continue;
        const value = lastManors.find((manor) => manor.manorId === hit.manor.manorId) ?? hit.manor;
        const center = screenHitBoxCenter(hit);
        append(
          `manor:${value.manorId}`,
          { kind: "manor", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }

      for (let index = greenhouseHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = greenhouseHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, assistancePaddingPx)) continue;
        const value = lastGreenhouses.find(
          (greenhouse) => greenhouse.greenhouseId === hit.greenhouse.greenhouseId
        ) ?? hit.greenhouse;
        const center = screenHitBoxCenter(hit);
        append(
          `greenhouse:${value.greenhouseId}`,
          { kind: "greenhouse", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }

      for (let index = furnaceHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = furnaceHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, assistancePaddingPx)) continue;
        const value = lastFurnaces.find(
          (furnace) => furnace.furnaceId === hit.furnace.furnaceId
        ) ?? hit.furnace;
        const center = screenHitBoxCenter(hit);
        append(
          `furnace:${value.furnaceId}`,
          { kind: "furnace", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }

      for (let index = tanneryHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = tanneryHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, assistancePaddingPx)) continue;
        const value = lastTanneries.find(
          (tannery) => tannery.tanneryId === hit.tannery.tanneryId
        ) ?? hit.tannery;
        const center = screenHitBoxCenter(hit);
        append(
          `tannery:${value.tanneryId}`,
          { kind: "tannery", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }

      for (let index = loomHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = loomHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, assistancePaddingPx)) continue;
        const value = lastLooms.find(
          (loom) => loom.loomId === hit.loom.loomId
        ) ?? hit.loom;
        const center = screenHitBoxCenter(hit);
        append(
          `loom:${value.loomId}`,
          { kind: "loom", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }

      for (let index = kitchenHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = kitchenHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, assistancePaddingPx)) continue;
        const value = lastKitchens.find(
          (kitchen) => kitchen.kitchenId === hit.kitchen.kitchenId
        ) ?? hit.kitchen;
        const center = screenHitBoxCenter(hit);
        append(
          `kitchen:${value.kitchenId}`,
          { kind: "kitchen", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }

      for (let index = fishingHutHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = fishingHutHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, assistancePaddingPx)) continue;
        const value = lastFishingHuts.find(
          (fishingHut) => fishingHut.fishingHutId === hit.fishingHut.fishingHutId
        ) ?? hit.fishingHut;
        const center = screenHitBoxCenter(hit);
        append(
          `fishing_hut:${value.fishingHutId}`,
          { kind: "fishing_hut", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }

      for (let index = flagHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = flagHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, assistancePaddingPx)) continue;
        const value = lastFlags.find((flag) => flag.id === hit.flag.id) ?? hit.flag;
        const center = screenHitBoxCenter(hit);
        append(
          `flag:${value.id}`,
          { kind: "flag", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }

      for (let index = cityHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = cityHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, assistancePaddingPx)) continue;
        const value = lastCities.find((city) => city.id === hit.city.id) ?? hit.city;
        const center = screenHitBoxCenter(hit);
        append(
          `city:${value.id}`,
          { kind: "city", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }
      for (let index = cityStructureHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = cityStructureHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, assistancePaddingPx)) continue;
        const value = lastCityStructures.find(
          (structure) => structure.structureId === hit.structure.structureId
        ) ?? hit.structure;
        const center = screenHitBoxCenter(hit);
        append(
          `city_structure:${value.structureId}`,
          { kind: "city_structure", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }

      for (let index = dungeonEntranceHitBoxes.length - 1; index >= 0; index -= 1) {
        const hit = dungeonEntranceHitBoxes[index];
        if (!hit || !containsScreenHitBox(point, hit, DEFAULT_WORLD_MULTI_SELECT_PADDING_PX)) continue;
        const value = lastDungeonEntrances.find(
          (entrance) => entrance.entranceId === hit.entrance.entranceId
        ) ?? hit.entrance;
        const center = screenHitBoxCenter(hit);
        append(
          `dungeon_entrance:${value.entranceId}`,
          { kind: "dungeon_entrance", value },
          Math.hypot(point.x - center.x, point.y - center.y)
        );
      }

      for (const { object, distancePx } of interiorRoom.pickObjectsAt(point, assistancePaddingPx)) {
        append(`interior_object:${object.id}`, { kind: "interior_object", value: object }, distancePx);
      }

      return prioritizeWorldObjectPicks(candidates);
    },
    showPetPing(ping: Readonly<{ lat: number; lon: number }>): void {
      petPing = { position: { lat: ping.lat, lon: ping.lon }, startedAt: performance.now() };
    },
    setHurtCircleDebug(enabled: boolean): void {
      hurtCircleDebugEnabled = enabled;
      if (!enabled) hurtCircleGraphics.clear();
      if (renderingActive) renderOverlay();
    },
    setMultiTargetHighlights(
      targets: readonly WorldObjectPick[],
      activeKey: string | null
    ): void {
      multiTargetHighlights = [...targets];
      activeMultiTargetHighlightKey = activeKey;
      drawMultiTargetHighlights();
      if (renderingActive) renderOverlay();
    },
    enqueueCombatEvents(events: readonly CombatEvent[]): void {
      const nowMs = performance.now();
      presentation.enqueueCombatEvents(events, {
        localPlayerId: latestState.localPlayerId,
        nowMs,
        appearanceForEntity: (entityId) => latestState.players.find(
          (player) => player.playerId === entityId
        )?.appearance,
        pointForEntity: dynamicEntityCenter,
        mapBearingDeg: map.getBearing(),
        maxHealthForEntity: (entityId) => combatByIdScratch.get(entityId)?.maxHealth
      });
      enqueueCombatAncillaryEffects(events);
    },
    enqueueCombatAncillaryEvents(events: readonly CombatEvent[]): void {
      enqueueCombatAncillaryEffects(events);
    },
    enqueueFloatingFeedback(feedback: FloatingFeedbackInput): void {
      presentation.enqueueFloatingFeedback(feedback);
    },
    enqueueFlagCollapse(flags): void {
      const startedAt = performance.now();
      for (const flag of flags) {
        if (flagCollapseEffects.size >= FLAG_COLLAPSE_EFFECT_LIMIT) break;
        flagCollapseEffects.set(flag.id, {
          lat: flag.lat,
          lon: flag.lon,
          claimRadiusM: flag.claimRadiusM,
          startedAt
        });
      }
    },
    noteHarvestTarget(nodeId: string): void {
      const node = latestState.collectibles.find((candidate) => candidate.id === nodeId);
      if (node) harvestTargetSpot = { lat: node.lat, lon: node.lon, atMs: performance.now() };
    },
    enqueueResourceGain(gain: ResourceGain): void {
      const itemName = resourceDisplayName(gain.itemId);
      const spot = harvestTargetSpot && performance.now() - harvestTargetSpot.atMs <= 20_000 ? harvestTargetSpot : null;
      presentation.enqueueFloatingFeedback({
        eventId: gain.eventId,
        targetEntityId: latestState.localPlayerId,
        kind: "resource",
        amount: gain.quantity,
        icon: gain.itemId,
        subject: itemName,
        ...(spot ? { worldPosition: { lat: spot.lat, lon: spot.lon } } : {}),
        label: `+${gain.quantity.toLocaleString()} ${itemName}`
      });
    },
    removeCombatTargets(entityIds: readonly string[]): void {
      // Loot icons pop out of the spot where the mob died.
      const killedMob = entityIds.map((entityId) => renderedDynamicEntities.get(entityId))
        .find((rendered) => rendered?.kind === "mob" && rendered.mobPosition);
      if (killedMob?.mobPosition) {
        const point = map.project([killedMob.mobPosition.lon, killedMob.mobPosition.lat]);
        const bounds = container.getBoundingClientRect();
        presentation.noteKillSpot(bounds.left + point.x, bounds.top + point.y);
      }
      // The last number of a defeated mob stays where the mob stood.
      if (!hitFeedbackStats.legacyDeathBeat) presentation.anchorFloaterTargets(entityIds, (entityId) => {
        const rendered = renderedDynamicEntities.get(entityId);
        if (!rendered || rendered.kind !== "mob" || !rendered.mobPosition) return null;
        return {
          lat: rendered.mobPosition.lat,
          lon: rendered.mobPosition.lon,
          chestLiftPx: combatChestLiftPx(rendered.visualArtworkHeightPx, "mob")
        };
      });
      presentation.removeCombatTargets(entityIds);
    },
    clearCombatFeedback(): void {
      clearDeathGhosts();
      presentation.clearScene();
      tauntPulse.clear();
      classAbilityActivationPulses.clear();
      petAbilityEffects.clear();
      tauntPulseGraphics.clear();
      swingFxGraphics.clear();
      classAbilityActivationGraphics.clear();
      clearTelegraphViews();
      classAbilityZones.clear();
      classAbilityZoneGraphics.clear();
      clearLayer(damageFloaterLayer);
      clearLayer(projectileImpactLayer);
      renderedFloaters.clear();
      // The layer clear destroyed the pooled labels too.
      floaterPool.clear();
      floaterPoolKeys.clear();
      renderedProjectileImpacts.clear();
      pendingProjectileTextures.clear();
      shotSprites.length = 0;
      pendingShotTextures.clear();
    },
    retainedDynamicObjectCount(): number {
      return renderedDynamicEntities.size;
    },
    staticMarkerMetrics() {
      return { ...staticMarkerMetrics };
    },
    destroy(): void {
      dynamicAnimation.stop();
      ownMapRender = false;
      map.triggerRepaint = mapTriggerRepaint;
      clearDeathGhosts();
      restorePromotedDynamicTarget();
      gatherTargetReactions.clear();
      damageFloaters.clear();
      projectileImpacts.clear();
      tauntPulse.clear();
      classAbilityActivationPulses.clear();
      petAbilityEffects.clear();
      classAbilityZones.clear();
      playerAppearancePoses.clear();
      mobActionRenders.clear();
      renderedFloaters.clear();
      floaterPool.clear();
      floaterPoolKeys.clear();
      renderedProjectileImpacts.clear();
      pendingProjectileTextures.clear();
      multiTargetHighlights = [];
      playerAppearanceTextures.clear();
      bossAppearanceTextures.clear();
      overlayDestroyed = true;
      interiorRoom.destroy();
      heartPuzzle.destroy();
      perfMetrics.setTextureStatsProvider(null);
      perfMetrics.setOverlayResolution(null);
      endFollowReuse();
      setPlayerSheetRenderer(null);
      app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
    }
  };
  // Hit boxes are recorded where the static geometry was drawn: end any follow translation before a static pick.
  for (const key of Object.keys(overlayApi) as Array<keyof PixiGameOverlay>) {
    if (!/^pick/.test(key) || key === "pickPlayerAt" || key === "pickCombatEntityAt") continue;
    const pick = overlayApi[key] as unknown as (...args: unknown[]) => unknown;
    (overlayApi as unknown as Record<string, unknown>)[key] = (...args: unknown[]): unknown => { settleFollowReuse(); return pick(...args); };
  }
  return overlayApi;

  function displayStateForStaticLayers(): RenderState {
    let state = frozenStaticState
      ? staleWhileInteractingRenderState(frozenStaticState, latestState)
      : latestState;
    if (flagTravelPresentationActive && flagTravelOriginStaticState) {
      state = staleWhileInteractingRenderState(
        flagTravelOriginStaticState,
        latestState
      );
    }
    if (flagTravelVisibilityTransition) {
      state = flagTravelVisibilityState(latestState);
    }
    if (
      flagTravelPresentationActive &&
      !flagTravelVisibilityTransition &&
      flagTravelDestinationPlayer
    ) {
      const destination = flagTravelDestinationPlayer;
      const anchor = flagTravelDestinationAnchor ?? destination;
      const destinationFlag = flagTravelDestinationFlagId
        ? latestState.flags.find(
            (flag) => flag.id === flagTravelDestinationFlagId
          )
        : null;
      const players = state.players.map((player) =>
        player.playerId === state.localPlayerId
          ? {
              ...player,
              lat: destination.lat,
              lon: destination.lon,
              anchorLat: anchor.lat,
              anchorLon: anchor.lon,
              currentFlagId:
                flagTravelDestinationCurrentFlagId !== undefined
                  ? flagTravelDestinationCurrentFlagId
                  : flagTravelDestinationFlagId ?? player.currentFlagId ?? null
            }
          : player
      );
      const localPlayer = players.find(
        (player) => player.playerId === state.localPlayerId
      );
      state = {
        ...state,
        players,
        resourceVision: null,
        gameplayViewCircle: localPlayer
          ? {
              center: anchor,
              radiusM:
                destinationFlag?.resourceVisionRadiusM ??
                state.gameplayViewCircle?.radiusM ??
                localPlayer.moveLeashRadiusM
            }
          : state.gameplayViewCircle ?? null
      };
    }
    return stateWithPendingSelection(state);
  }

  function displayStateForDynamicEntities(): RenderState {
    const state = stateWithPendingSelection(
      flagTravelVisibilityTransition
        ? flagTravelVisibilityState(latestState)
        : latestState
    );
    if (!flagTravelPresentationActive || flagTravelVisibilityTransition) {
      return state;
    }
    return {
      ...state,
      players: state.players.filter(
        (player) => player.playerId === state.localPlayerId
      ),
      selectedCombatEntityId: null,
      selectedPlayerId: null
    };
  }

  function flagTravelVisibilityState(destination: RenderState): RenderState {
    const transition = flagTravelVisibilityTransition;
    if (!transition) return destination;
    const origin = transition.originState;
    return {
      ...destination,
      players: visibilityUnion(
        origin.players,
        destination.players,
        (player) => player.playerId,
        "player",
        destination.localPlayerId
      ),
      collectibles: visibilityUnion(
        origin.collectibles,
        destination.collectibles,
        (item) => item.id,
        "collectible"
      ),
      droppedItems: visibilityUnion(
        origin.droppedItems,
        destination.droppedItems,
        (item) => item.dropId,
        "drop"
      ),
      waterHighlights: visibilityUnion(
        origin.waterHighlights,
        destination.waterHighlights,
        (item) => item.id,
        "water"
      ),
      gameplayViewCircle:
        (visibilityDecision("player", destination.localPlayerId, true)
          .useDestination
          ? destination.gameplayViewCircle
          : origin.gameplayViewCircle) ?? null,
      resourceVision:
        visibilityDecision("player", destination.localPlayerId, true)
          .useDestination
          ? destination.resourceVision
          : origin.resourceVision
    };
  }

  function visibilityUnion<T>(
    originItems: readonly T[],
    destinationItems: readonly T[],
    idFor: (item: T) => string,
    kind: string,
    relocatingId?: string
  ): T[] {
    const originById = new Map(originItems.map((item) => [idFor(item), item]));
    const destinationById = new Map(
      destinationItems.map((item) => [idFor(item), item])
    );
    const ids = new Set([...originById.keys(), ...destinationById.keys()]);
    return [...ids].flatMap((id) => {
      const decision = visibilityDecision(kind, id, id === relocatingId);
      const selected = decision.useDestination
        ? destinationById.get(id)
        : originById.get(id);
      return selected && decision.alpha > 0 ? [selected] : [];
    });
  }

  function visibilityDecision(
    kind: string,
    id: string,
    relocating = false
  ) {
    const transition = flagTravelVisibilityTransition;
    if (!transition) {
      return { alpha: 1, useDestination: true, interactive: true };
    }
    const inOrigin = visibilityOriginHas(transition, kind, id);
    const inDestination = visibilityDestinationHas(kind, id);
    if (inDestination && !inOrigin) {
      const key = `${kind}:${id}`;
      if (!transition.firstSeenAtMs.has(key)) {
        transition.firstSeenAtMs.set(key, flagTravelVisibilityFrameNowMs);
      }
    }
    const firstSeenAtMs = transition.firstSeenAtMs.get(`${kind}:${id}`);
    return flagTravelVisibilityDecision(
      transition.timing,
      {
        inOrigin,
        inDestination,
        ...(inDestination && !inOrigin && firstSeenAtMs !== undefined
          ? { firstSeenAtMs }
          : {}),
        ...(relocating ? { relocating: true } : {})
      },
      flagTravelVisibilityFrameNowMs
    );
  }

  function visibilityOriginHas(
    transition: NonNullable<typeof flagTravelVisibilityTransition>,
    kind: string,
    id: string
  ): boolean {
    switch (kind) {
      case "player": return transition.originState.players.some((item) => item.playerId === id);
      case "mob": return transition.originCombatEntities.some((item) => item.kind === "mob" && item.entityId === id);
      case "collectible": return transition.originState.collectibles.some((item) => item.id === id);
      case "drop": return transition.originState.droppedItems.some((item) => item.dropId === id);
      case "water": return transition.originState.waterHighlights.some((item) => item.id === id);
      default: return false;
    }
  }

  function visibilityDestinationHas(kind: string, id: string): boolean {
    switch (kind) {
      case "player": return latestState.players.some((item) => item.playerId === id);
      case "mob": return (combatStore?.entities() ?? []).some((item) => item.kind === "mob" && item.entityId === id);
      case "collectible": return latestState.collectibles.some((item) => item.id === id);
      case "drop": return latestState.droppedItems.some((item) => item.dropId === id);
      case "water": return latestState.waterHighlights.some((item) => item.id === id);
      default: return false;
    }
  }

  function collectibleRemainsAcrossFlagTravel(id: string): boolean {
    const transition = flagTravelVisibilityTransition;
    return Boolean(
      transition?.originState.collectibles.some((item) => item.id === id) &&
      latestState.collectibles.some((item) => item.id === id)
    );
  }

  function stateWithPendingSelection(state: RenderState): RenderState {
    return pendingSelection ? { ...state, ...pendingSelection } : state;
  }

  function hasDirtyStaticLayers(): boolean {
    return (
      needsFlagRedraw ||
      needsCityRedraw ||
      needsCityStructureRedraw ||
      needsManorRedraw ||
      needsGreenhouseRedraw ||
      needsFurnaceRedraw ||
      needsTanneryRedraw ||
      needsLoomRedraw ||
      needsKitchenRedraw ||
      needsFishingHutRedraw ||
      needsSaplingRedraw ||
      needsCollectibleRedraw ||
      needsDroppedItemRedraw ||
      needsWaterHighlightRedraw ||
      needsTerritoryRedraw ||
      needsLeashRedraw ||
      needsSelectionRedraw
    );
  }

  function hasDirtyFlagTravelLiveStaticLayers(): boolean {
    return (
      needsCollectibleRedraw ||
      needsDroppedItemRedraw ||
      needsWaterHighlightRedraw ||
      needsLeashRedraw ||
      needsSelectionRedraw
    );
  }

  function applyLiveStaticLayerTransform(): void {
    if (!staticLayersFrozen) {
      return;
    }
    frozenTransformReference ??=
      staticGeometryReference ?? captureStaticOverlayTransformReference(map);
    const reference = computeLiveStaticOverlayReference(map, frozenTransformReference);
    applyStaticOverlayContainerTransform(staticLayer, reference);
    applyStaticOverlayContainerTransform(kingdomSeatLayer, reference);
    const currentGroundZoom = mapGroundScaleZoom(map);
    const committedGroundZoom = staticReferenceGroundZoom(frozenTransformReference);
    // Nothing the correction reads has moved enough to change a pixel: skip the whole walk.
    const last = lastStaticArtworkCorrection;
    if (
      last &&
      last.reference === frozenTransformReference &&
      Math.abs(last.scale - reference.scale) < STATIC_CORRECTION_SCALE_EPSILON &&
      Math.abs(last.zoom - currentGroundZoom) < STATIC_CORRECTION_ZOOM_EPSILON
    ) {
      return;
    }
    lastStaticArtworkCorrection = {
      reference: frozenTransformReference,
      scale: reference.scale,
      zoom: currentGroundZoom
    };
    for (const layer of STATIC_CORRECTION_LAYERS()) {
      if (layer.children.length === 0) continue;
      applyStaticArtworkScaleCorrection(
        layer,
        reference.scale,
        currentGroundZoom,
        committedGroundZoom
      );
    }
  }

  function restoreStaticPresentationForFlagTravel(): void {
    if (staticLayersFrozen || frozenStaticState) {
      staticLayersFrozen = false;
      frozenStaticState = null;
      frozenTransformReference = null;
      resetStaticOverlayContainerTransform(staticLayer);
      resetStaticOverlayContainerTransform(kingdomSeatLayer);
      markAllStaticLayersDirty();
    }
    resetFlagTravelDurableTransforms();
    staticLayer.visible = true;
    kingdomSeatLayer.visible = true;
  }

  function applyFlagTravelTransform(): void {
    if (!flagTravelPresentationActive || !flagTravelTransformReference) return;
    const reference = computeLiveStaticOverlayReference(
      map,
      flagTravelTransformReference
    );
    applyStaticOverlayContainerTransform(durableStaticUnderlay, reference);
    applyStaticOverlayContainerTransform(durableStaticMarkers, reference);
    applyStaticOverlayContainerTransform(kingdomSeatLayer, reference);
    applyStaticArtworkScaleCorrection(
      durableStaticMarkers,
      reference.scale,
      mapGroundScaleZoom(map),
      staticReferenceGroundZoom(flagTravelTransformReference)
    );
    applyStaticArtworkScaleCorrection(
      kingdomSeatLayer,
      reference.scale,
      mapGroundScaleZoom(map),
      staticReferenceGroundZoom(flagTravelTransformReference)
    );
  }

  function resetFlagTravelDurableTransforms(): void {
    resetStaticOverlayContainerTransform(durableStaticUnderlay);
    resetStaticOverlayContainerTransform(durableStaticMarkers);
    resetStaticOverlayContainerTransform(kingdomSeatLayer);
  }

  function retainedLocalPlayer(): RetainedDynamicEntity | null {
    const localPlayer = renderedDynamicEntities.get(latestState.localPlayerId);
    return localPlayer?.kind === "player" && localPlayer.local
      ? localPlayer
      : null;
  }

  function updateFlagTravelPlayerMotion(
    cameraGeneration: number | null,
    nowMs: number
  ): void {
    if (
      !flagTravelPlayerMotion ||
      !isCurrentFlagTravelPlayerMotion(
        flagTravelPlayerMotion,
        cameraGeneration
      )
    ) {
      return;
    }
    const localPlayer = retainedLocalPlayer();
    if (!localPlayer) return;
    const planned = flagTravelPlayerPositionAt(flagTravelPlayerMotion, nowMs);
    flagTravelPlannedLocalPlayerPosition = planned;
    localPlayer.container.position.set(planned.x, planned.y);
  }

  function observeFlagTravelFrame(
    force = false,
    destination = false,
    finalPreCommit = false
  ): void {
    if (!force && !flagTravelPresentationActive) return;
    const mobsVisible = [...renderedDynamicEntities.values()].some(
      (entity) => entity.kind === "mob" && entity.container.visible
    );
    const localPlayers = [...renderedDynamicEntities.values()].filter(
      (entity) => entity.kind === "player" && entity.local
    );
    const localPlayer = localPlayers[0] ?? null;
    const localPlayerPosition = localPlayer?.container.visible
      ? { x: localPlayer.container.x, y: localPlayer.container.y }
      : null;
    const localPlayerParent =
      localPlayer?.container.parent === localPlayerLayer
        ? "localPlayerLayer"
        : localPlayer?.container.parent === worldDynamicEntityLayer
          ? "worldDynamicEntityLayer"
          : localPlayer
            ? "other"
            : null;
    flagTravelPresentationInstrumentation.frame({
      flagsVisible: staticLayer.visible && flagLayer.visible && flagLayer.children.length > 0,
      leashVisible: staticLayer.visible && leashLayer.visible && leashLayer.children.length > 0,
      mobsVisible,
      retainedObjectCount: renderedDynamicEntities.size,
      plannedLocalPlayerPosition: flagTravelPlannedLocalPlayerPosition,
      localPlayerPosition,
      localPlayerParent,
      localPlayerRetainedCount: localPlayers.length,
      localPlayerInsideViewport:
        localPlayerPosition !== null &&
        localPlayerPosition.x >= 0 &&
        localPlayerPosition.y >= 0 &&
        localPlayerPosition.x <= app.screen.width &&
        localPlayerPosition.y <= app.screen.height,
      destination,
      finalPreCommit
    });
  }
}

export function authoritativeCollectibleForHit(
  collectibles: readonly CollectibleNode[],
  collectibleId: string
): CollectibleNode | null {
  return collectibles.find(
    (collectible) => collectible.id === collectibleId
  ) ?? null;
}


type ScreenPoint = {
  x: number;
  y: number;
};

type RetainedDynamicEntity = {
  entityId: string;
  kind: "player" | "mob";
  archetypeKey: CombatEntitySnapshot["archetypeKey"];
  companionSpecies: CompanionSpeciesId | null;
  appearanceVariant: NonNullable<CombatEntitySnapshot["appearanceVariant"]>;
  container: Container;
  artwork: Container;
  presentation: SpritePresentation;
  baseArtworkHeightPx: number;
  /** Created on first use: most mobs never show a label, speech or timer. */
  label: Text | null;
  aiLabel: Text | null;
  attackBadge: Container;
  attackBadgeGraphics: Graphics;
  attackBadgeText: Text | null;
  attackBadgeKey: string;
  healthBar: Graphics | null;
  healthBarState: HealthBarTransitionState | null;
  healthBarFade: number;
  healthBarFadeAtMs: number | null;
  healthCritical: boolean;
  healthBarVariant: WorldHealthBarVariant;
  healthBarTone: WorldHealthBarTone;
  attackRange: Graphics;
  protectionGlow: Graphics;
  rootEffect: Graphics;
  rootTimer: Text | null;
  statusIcons: Container;
  statusIconIds: readonly HarmfulStatusId[];
  playerPosition: RenderedPlayerPosition | null;
  mobPosition: LatLon | null;
  companionMotion: CompanionRenderMotion | null;
  /** Timestamped server samples of a world mob (the interpolation buffer); null for companions and unstamped (room) mobs. */
  mobTrack: MobSnapshotTrack | null;
  /** The snapshot object the last buffered sample came from (a new object means a new server sample). */
  mobTrackSource: CombatEntitySnapshot | null;
  currentHealth: number | null;
  maxHealth: number | null;
  ward: number | null;
  name: string;
  local: boolean;
  color: number;
  playerRenderer: PlayerRenderer | null;
  /** Jacket B player (pre-rendered Atlas Animator sheets) drawn in place of the player body (render only). */
  jacketRig: JacketRig | null;
  bossRenderer: BossRenderer | null;
  raft: PlayerRaft | null;
  appearanceRevision: number;
  visualArtworkHeightPx: number;
  firstPresentedAtMs: number;
  walkMotion: PlayerWalkMotionState;
  gathering: PlayerGatheringState;
  /** Last arm-swing request played (PlayerAppearancePoseController seq). */
  swingSeq: number;
};

type MobActionRender = {
  state: MobActionState;
  /** The artwork the display objects below belong to (recreated artwork drops them). */
  artwork: Container;
  flash: Sprite | null;
  flashChecked: boolean;
  fx: Graphics | null;
  fxDrawn: boolean;
  tint: number;
  /** Artwork scale before this frame's action pose (the rest scale a death ghost snaps back to); 0 = not sampled yet. */
  restScaleX: number;
  restScaleY: number;
};

/** Additive white copy of a mob's sprite for the hit flash and shell sheen; null for rigged art. */
function createMobFlashSprite(rendered: RetainedDynamicEntity): Sprite | null {
  if (rendered.playerRenderer || rendered.bossRenderer) return null;
  const image = rendered.artwork.children[0];
  if (!(image instanceof Sprite)) return null;
  const flash = new Sprite(image.texture);
  flash.anchor.copyFrom(image.anchor);
  flash.scale.copyFrom(image.scale);
  flash.blendMode = "add";
  flash.alpha = 0;
  rendered.artwork.addChild(flash);
  return flash;
}

const MOB_FX_DUST_COLORS = [0xd6bf94, 0xa98a5f] as const;
const MOB_FX_SMOKE_COLORS = [0x6b7280, 0x9ca3af] as const;

/** Dust, scuffs, slam ring and smoke puff on the ground at (x, y); p is 0..1 through the effect. */
function drawMobActionFx(
  graphics: Graphics,
  kind: MobFxKind | "scuff",
  p: number,
  x: number,
  y: number,
  heightPx: number,
  state: Readonly<Pick<MobActionState, "dirX" | "dirY" | "programId">>
): void {
  const fade = (1 - p) * (1 - p);
  const grow = 1 - (1 - p) * (1 - p);
  if (kind === "ring") {
    const radius = heightPx * (0.2 + 1.1 * grow);
    graphics.ellipse(x, y, radius, radius * 0.42)
      .stroke({ color: 0xfde68a, width: 1 + 3 * (1 - p), alpha: 0.85 * fade });
    graphics.ellipse(x, y, radius * 0.68, radius * 0.68 * 0.42)
      .stroke({ color: 0xd6bf94, width: 1 + 2 * (1 - p), alpha: 0.45 * fade });
    return;
  }
  if (kind === "puff") {
    for (let index = 0; index < 6; index += 1) {
      const angle = index * Math.PI / 3 + 0.4;
      const distance = heightPx * (0.05 + 0.2 * grow);
      graphics.circle(x + Math.cos(angle) * distance, y - heightPx * 0.25 + Math.sin(angle) * distance * 0.7, heightPx * (0.14 + 0.14 * grow))
        .fill({ color: MOB_FX_SMOKE_COLORS[index % 2]!, alpha: 0.8 * fade });
    }
    return;
  }
  const scuff = kind === "scuff";
  const count = scuff ? 2 : 5;
  // Kicked up behind the mob; a slam throws dust all round.
  const backX = state.programId === "slam" ? 0 : -state.dirX;
  const backY = state.programId === "slam" ? 0 : -state.dirY;
  for (let index = 0; index < count; index += 1) {
    const angle = index * Math.PI * 2 / count + 0.6;
    const spread = heightPx * (scuff ? 0.05 + 0.06 * grow : 0.1 + 0.22 * grow);
    const back = heightPx * (scuff ? 0.12 : 0.15 + 0.2 * grow);
    const radius = heightPx * (scuff ? 0.035 + 0.04 * grow : 0.05 + 0.09 * grow) * (1 - index * 0.08);
    graphics.circle(x + backX * back + Math.cos(angle) * spread, y + backY * back * 0.45 + Math.sin(angle) * spread * 0.45 - radius * 0.5, radius)
      .fill({ color: MOB_FX_DUST_COLORS[index % 2]!, alpha: (scuff ? 0.4 : 0.5) * fade });
  }
}

function destroyRetainedEntity(rendered: RetainedDynamicEntity): void {
  rendered.container.removeFromParent();
  if (rendered.playerRenderer) {
    rendered.artwork.removeFromParent();
    rendered.jacketRig?.destroy();
    rendered.playerRenderer.destroy();
  }
  if (rendered.raft) {
    rendered.raft.root.removeFromParent();
    rendered.raft.destroy();
  }
  if (rendered.bossRenderer) {
    rendered.artwork.removeFromParent();
    rendered.bossRenderer.destroy();
  }
  rendered.container.destroy({ children: true });
}

type StaticOverlayMapTransformReference = {
  screen: StaticOverlayTransformReference;
  zoom: number;
  originLng: number;
  originLat: number;
  axisLng: number;
  axisLat: number;
};

const MOVEMENT_LEASH_CIRCLE_POINT_COUNT = 96;
const STATIC_OVERLAY_AXIS_LON_OFFSET = 0.001;

// Graphics.clear() marks the view dirty even when nothing was drawn, which would defeat
// idle-frame skipping; only clear when there is something to clear.
function clearGraphicsIfDrawn(graphics: Graphics): void {
  if (graphics.context.instructions.length > 0) graphics.clear();
}

/**
 * Pixi 8 frees a Graphics own GraphicsContext (and its batched geometry) only when destroy() gets no options or
 * context:true; destroy({ children: true }) alone leaked every redrawn layer (about 100 KB per redraw, 6 MB/s while the
 * camera pans every frame). Redrawn layers hold only Graphics and Sprites, so context:true is safe.
 */
function clearLayer(layer: Container): void {
  const removed = layer.removeChildren();
  if (removed.length === 0) return;
  queueMicrotask(() => {
    for (const child of removed) child.destroy({ children: true, context: true });
  });
}

export function flagsSignature(flags: FlagSnapshot[]): string {
  return flags
    .map(
      (flag) =>
        `${flag.id}:${flag.name}:${flag.controlType}:${flag.ownerId}:${flag.ownerColor ?? ""}:${flag.cityId ?? ""}:${flag.kingdomId ?? ""}:${flag.kingdomColor ?? ""}:${flag.kingdomEmblemKey ?? ""}:${flag.kingdomSeatId ?? ""}:${flag.kingdomSeatConstructionState ?? ""}:${flag.kingdomSeatLat ?? ""}:${flag.kingdomSeatLon ?? ""}:${flag.lat}:${flag.lon}:${flag.claimRadiusM}:${flag.accessMode ?? ""}:${flag.jumpTollGold ?? ""}:${flag.accessRevision ?? ""}:${flag.upgradeTier ?? "base"}:${flag.health ?? ""}:${flag.maximumHealth ?? ""}:${flag.burning ? "burning" : ""}:${flag.burningUntil ?? ""}:${flag.developerTestTarget ? "developer-test" : ""}`
    )
    .join("|");
}

function flagPlacementPreviewSignature(state: RenderState): string {
  const preview = state.flagPlacementPreview;
  return preview
    ? `${preview.lat}:${preview.lon}:${preview.radiusM}:${preview.state}`
    : "";
}

function siegeDeploymentPreviewSignature(state: RenderState): string {
  return [...new Set(state.siegeDeploymentPreviewFlagIds ?? [])].sort().join("|");
}

function siegeTargetSignature(state: RenderState): string {
  const selectedGroup = (state.militaryGroups ?? []).find(
    (group) => group.groupId === state.selectedMilitaryGroupId
  ) ?? null;
  if (!selectedGroup) return "";
  const targetIds = siegeTargetFlagIds(selectedGroup, state.flags);
  const targetPositions = targetIds.map((targetId) => {
    const target = state.flags.find((flag) => flag.id === targetId);
    return target ? `${target.id}:${target.lat}:${target.lon}` : targetId;
  }).join("|");
  return [
    selectedGroup.groupId,
    selectedGroup.unitType,
    selectedGroup.locationState,
    selectedGroup.ownerPlayerId,
    selectedGroup.lat ?? "",
    selectedGroup.lon ?? "",
    selectedGroup.revision,
    targetPositions
  ].join(":");
}

function gameplayViewCircleSignature(state: RenderState): string {
  const circle = state.gameplayViewCircle;
  const waypoint = state.mapWaypoint;
  const waypointPart = waypoint ? `:${waypoint.lat}:${waypoint.lon}` : "";
  return circle
    ? `${circle.center.lat}:${circle.center.lon}:${circle.radiusM}${waypointPart}`
    : "";
}

function visibleStaticStateForMap(
  map: maplibregl.Map,
  container: HTMLElement,
  state: RenderState,
  alwaysIncludeFlagId: string | null = null,
  padPx = 0
): RenderState {
  const mapCanvas = map.getCanvas();
  const visibleState = visibleStaticRenderState(state, {
    padPx,
    width: container.clientWidth || mapCanvas.clientWidth,
    height: container.clientHeight || mapCanvas.clientHeight,
    project: (point) => {
      const projected = map.project([point.lon, point.lat]);
      return {
        x: projected.x,
        y: projected.y
      };
    },
    radiusPixels: (center, radiusM) => screenRadiusForMeters(map, center, radiusM)
  });
  const destinationFlag = alwaysIncludeFlagId
    ? state.flags.find((flag) => flag.id === alwaysIncludeFlagId)
    : null;
  if (
    !destinationFlag ||
    visibleState.flags.some((flag) => flag.id === destinationFlag.id)
  ) {
    return visibleState;
  }
  return {
    ...visibleState,
    flags: [...visibleState.flags, destinationFlag]
  };
}

function screenRadiusForMeters(map: maplibregl.Map, center: LatLon, radiusM: number): number {
  const centerPoint = map.project([center.lon, center.lat]);
  const edge = destinationPoint(center, radiusM, 90);
  const edgePoint = map.project([edge.lon, edge.lat]);
  return Math.hypot(edgePoint.x - centerPoint.x, edgePoint.y - centerPoint.y);
}

function captureStaticOverlayTransformReference(
  map: maplibregl.Map
): StaticOverlayMapTransformReference {
  const center = map.getCenter();
  return projectStaticOverlayReference(map, center.lng, center.lat);
}

function computeLiveStaticOverlayReference(
  map: maplibregl.Map,
  frozen: StaticOverlayMapTransformReference
) {
  return computeStaticOverlayContainerTransform(frozen.screen, {
    origin: projectMapPoint(map, {
      lng: frozen.originLng,
      lat: frozen.originLat
    }),
    axis: projectMapPoint(map, {
      lng: frozen.axisLng,
      lat: frozen.axisLat
    })
  });
}

function projectStaticOverlayReference(
  map: maplibregl.Map,
  lng: number,
  lat: number
): StaticOverlayMapTransformReference {
  return {
    screen: {
      origin: projectMapPoint(map, { lng, lat }),
      axis: projectMapPoint(map, { lng: lng + STATIC_OVERLAY_AXIS_LON_OFFSET, lat })
    },
    zoom: map.getZoom(),
    originLng: lng,
    originLat: lat,
    axisLng: lng + STATIC_OVERLAY_AXIS_LON_OFFSET,
    axisLat: lat
  };
}

function projectMapPoint(
  map: maplibregl.Map,
  lngLat: { lng: number; lat: number }
): ScreenPoint {
  const point = map.project([lngLat.lng, lngLat.lat]);
  return {
    x: point.x,
    y: point.y
  };
}

export function collectiblesSignature(collectibles: CollectibleNode[]): string {
  return collectibles
    .map(
      (collectible) =>
        `${collectible.id}:${collectible.type}:${collectible.lat}:${collectible.lon}:${collectible.quantity}:${collectible.state}:${collectible.repeatableNodeType ?? "ambient"}:${collectible.repeatableState ?? ""}:${collectible.repeatableReadyAt ?? ""}:${collectible.repeatableTimerVisibility ?? ""}:${collectible.repeatableRevision ?? ""}:${collectible.repeatableOwnerPlayerId ?? ""}:${collectible.repeatableAccessMode ?? ""}:${collectible.berryAvailable ?? ""}:${collectible.resinAvailable ?? ""}:${collectible.treeLifeRevision ?? ""}:${collectible.sapReadyAt === undefined ? "" : `${collectible.sapReadyAt}:${treeProduceAvailable(collectible, Date.now())}`}`
    )
    .join("|");
}

function citiesSignature(cities: CitySnapshot[]): string {
  return cities
    .map((city) => `${city.id}:${city.name}:${city.lat}:${city.lon}:${city.active}:${city.jumpable}:${city.constructionPhase ?? "complete"}`)
    .join("|");
}

function cityStructuresSignature(structures: CityStructureSnapshot[]): string {
  return structures.map((structure) => [
    structure.structureId,
    structure.type,
    structure.tier,
    structure.state,
    structure.placementRevision,
    structure.lat,
    structure.lon,
    structure.warfare
      ? [
          structure.warfare.health,
          structure.warfare.healthAt ?? "",
          structure.warfare.burning ? "burning" : "",
          structure.warfare.repairing ? "repairing" : "",
          // Burning and repairing bars move continuously; refresh them every 30 s.
          structure.warfare.burning || structure.warfare.repairing ? Math.floor(Date.now() / 30_000) : ""
        ].join(",")
      : ""
  ].join(":")).join("|");
}

export function dungeonEntrancesSignature(entrances: DungeonEntranceSnapshot[]): string {
  return entrances.map((entrance) => [
    entrance.entranceId,
    entrance.dungeonId,
    entrance.name,
    entrance.description,
    entrance.portalId,
    entrance.portalRevision,
    entrance.interactionLabel,
    entrance.lat,
    entrance.lon,
    entrance.interactionRadiusM,
    entrance.footprintRadiusM,
    entrance.presentation,
    entrance.assetKey ?? ""
  ].join(":")).join("|");
}

function manorsSignature(manors: ManorWorldSnapshot[]): string {
  return manors.map((manor) =>
    `${manor.manorId}:${manor.ownerPlayerId}:${manor.ownerUsername}:${manor.regionCode}:${manor.lat}:${manor.lon}:${manor.builtAt}:${manor.placementRevision}:${manor.manorTypeId ?? ""}:` +
    `${manor.warfare?.health ?? ""}:${manor.warfare?.healthAt ?? ""}:${manor.warfare?.burning ?? ""}:${manor.warfare?.repairing ?? ""}`
  ).join("|");
}

function greenhousesSignature(greenhouses: GreenhouseSnapshot[]): string {
  return greenhouses.map((greenhouse) =>
    `${greenhouse.greenhouseId}:${greenhouse.ownerPlayerId}:${greenhouse.regionCode}:${greenhouse.lat}:${greenhouse.lon}:${greenhouse.builtAt}:${greenhouse.placementRevision}`
  ).join("|");
}

function furnacesSignature(furnaces: FurnaceWorldSnapshot[]): string {
  return furnaces.map((furnace) =>
    `${furnace.furnaceId}:${furnace.ownerPlayerId}:${furnace.lat}:${furnace.lon}:${furnace.placementRevision}`
  ).join("|");
}

function tanneriesSignature(tanneries: TanneryWorldSnapshot[]): string {
  return tanneries.map((tannery) =>
    `${tannery.tanneryId}:${tannery.ownerPlayerId}:${tannery.lat}:${tannery.lon}:${tannery.placementRevision}`
  ).join("|");
}

function loomsSignature(looms: LoomWorldSnapshot[]): string {
  return looms.map((loom) =>
    `${loom.loomId}:${loom.ownerPlayerId}:${loom.lat}:${loom.lon}:${loom.placementRevision}`
  ).join("|");
}

function kitchensSignature(kitchens: KitchenWorldSnapshot[]): string {
  return kitchens.map((kitchen) =>
    `${kitchen.kitchenId}:${kitchen.ownerPlayerId}:${kitchen.lat}:${kitchen.lon}:${kitchen.placementRevision}`
  ).join("|");
}

function saplingsSignature(saplings: readonly SaplingRenderItem[]): string {
  return saplings.map((sapling) =>
    `${sapling.id}:${sapling.lat}:${sapling.lon}:${sapling.state}:${sapling.phase}:${Math.round(sapling.growth * 20)}:${sapling.berryAvailable ? 1 : 0}`
  ).join("|");
}

function fishingHutsSignature(fishingHuts: FishingHutWorldSnapshot[]): string {
  return fishingHuts.map((fishingHut) =>
    `${fishingHut.fishingHutId}:${fishingHut.ownerPlayerId}:${fishingHut.lat}:${fishingHut.lon}:${fishingHut.placementRevision}:${fishingHut.waterbody.kind}:${fishingHut.waterbody.sourceId}:${fishingHut.passiveStoredQuantity}:${fishingHut.passiveReadyQuantity}`
  ).join("|");
}

function droppedItemsSignature(drops: DroppedItemSnapshot[]): string {
  return drops
    .map(
      (drop) =>
        `${drop.dropId}:${drop.itemId}:${drop.variant ?? ""}:${drop.quantity}:${drop.status}:${drop.lat}:${drop.lon}:${drop.expiresAt}`
    )
    .join("|");
}

function waterHighlightsSignature(state: RenderState): string {
  return [
    state.resourceVision
      ? `${state.resourceVision.flagId}:${state.resourceVision.center.lat}:${state.resourceVision.center.lon}:${state.resourceVision.radiusM}`
      : "none",
    ...state.waterHighlights.map(
      (highlight) =>
        `${highlight.id}:${highlight.waterSourceType}:${highlight.lat}:${highlight.lon}:${highlight.collectible}`
    )
  ].join("|");
}

function localPlayerFromState(state: RenderState): PlayerSnapshot | undefined {
  return state.players.find((player) => player.playerId === state.localPlayerId);
}

function localPlayerLeashSignature(state: RenderState): string {
  const player = localPlayerFromState(state);
  return player
    ? `${player.playerId}:${player.anchorLat}:${player.anchorLon}:${player.moveLeashRadiusM}`
    : "";
}

const TERRITORY_BOUNDARY_STROKE_WIDTH = 1.5;

function renderTerritoryLayer(
  map: maplibregl.Map,
  territoryLayer: Container,
  territoryGroups: TerritoryRenderGroup[]
): void {
  clearLayer(territoryLayer);
  for (const group of territoryGroups) {
    const fillColor = hexToNumber(group.ownerColor);
    const outlineColor = darkenColor(fillColor, 0.62);
    for (const polygon of group.polygons) {
      const outerRing = polygon[0];
      if (!outerRing || outerRing.length < 3) {
        continue;
      }
      const territoryShape = new Graphics();
      drawPolygonPath(territoryShape, polygon);
      territoryShape.fill({ color: fillColor, alpha: 0.11 });
      territoryShape.alpha = globeOverlayOpacityForScreenGeometry(map, polygon.flat());
      territoryLayer.addChild(territoryShape);
    }
    if (group.zoneCells.length > 0) {
      const zoneSeams = new Graphics();
      for (const zoneCell of group.zoneCells) {
        drawPolygonPath(zoneSeams, zoneCell);
      }
      zoneSeams.stroke({ color: outlineColor, width: TERRITORY_BOUNDARY_STROKE_WIDTH, alpha: 0.32, cap: "round", join: "round" });
      zoneSeams.alpha = globeOverlayOpacityForScreenGeometry(
        map,
        group.zoneCells.flat(2)
      );
      territoryLayer.addChild(zoneSeams);
    }
    for (const polygon of group.polygons) {
      const outerBoundary = new Graphics();
      drawPolygonPath(outerBoundary, polygon);
      outerBoundary.stroke({ color: outlineColor, width: TERRITORY_BOUNDARY_STROKE_WIDTH, alpha: 0.86, cap: "round", join: "round" });
      outerBoundary.alpha = globeOverlayOpacityForScreenGeometry(map, polygon.flat());
      territoryLayer.addChild(outerBoundary);
    }
  }
}

function globeOverlayOpacityForScreenGeometry(
  map: maplibregl.Map,
  points: ReadonlyArray<Readonly<[number, number]>>
): number {
  if (points.length === 0) return 0;
  let visibleOpacity = 1;
  for (const [x, y] of points) {
    const position = map.unproject([x, y]);
    visibleOpacity = Math.min(
      visibleOpacity,
      globeOverlayOpacityForMap(map, { lat: position.lat, lon: position.lng })
    );
    if (visibleOpacity <= 0) return 0;
  }
  return visibleOpacity;
}

function renderMovementLeashLayer(
  map: maplibregl.Map,
  leashLayer: Container,
  localPlayer: PlayerSnapshot | undefined,
  gameplayViewCircle: NonNullable<RenderState["gameplayViewCircle"]> | null,
  mapWaypoint: RenderState["mapWaypoint"] = null
): void {
  clearLayer(leashLayer);
  if (localPlayer) {
    const movementLeashCirclePoints = createGeodesicCircleScreenPoints(
      map,
      { lat: localPlayer.anchorLat, lon: localPlayer.anchorLon },
      localPlayer.moveLeashRadiusM,
      MOVEMENT_LEASH_CIRCLE_POINT_COUNT
    );
    const movementLeashCircle = new Graphics()
      .poly(flattenScreenPoints(movementLeashCirclePoints), true)
      .fill({ color: 0x1d4ed8, alpha: 0.018 });
    const movementLeashBoundary = new Graphics()
      .poly(flattenScreenPoints(movementLeashCirclePoints), true)
      .stroke({ color: 0x000000, width: 1.25, alpha: 1 });
    const globeOpacity = globeOverlayOpacityForMap(map, {
      lat: localPlayer.anchorLat,
      lon: localPlayer.anchorLon
    });
    movementLeashCircle.alpha = globeOpacity;
    movementLeashBoundary.alpha = globeOpacity;
    leashLayer.addChild(movementLeashCircle, movementLeashBoundary);
  }
  if (!gameplayViewCircle) return;
  const gameplayViewCirclePoints = createGeodesicCircleScreenPoints(
    map,
    gameplayViewCircle.center,
    gameplayViewCircle.radiusM,
    MOVEMENT_LEASH_CIRCLE_POINT_COUNT
  );
  const gameplayViewBoundary = new Graphics();
  for (const dash of closedPolylineDashSegments(gameplayViewCirclePoints, 9, 5)) {
    const first = dash[0];
    if (!first) continue;
    gameplayViewBoundary.moveTo(first.x, first.y);
    for (const point of dash.slice(1)) {
      gameplayViewBoundary.lineTo(point.x, point.y);
    }
  }
  gameplayViewBoundary.stroke({ color: 0x38bdf8, width: 1.25, alpha: 0.85 });
  gameplayViewBoundary.alpha = globeOverlayOpacityForMap(map, gameplayViewCircle.center);
  leashLayer.addChild(gameplayViewBoundary);
  if (mapWaypoint) renderWaypointArrow(map, leashLayer, gameplayViewCircle, mapWaypoint);
}

/** Compass waypoint: an arrow on the gameplay view circle edge pointing at it, with its distance. */
function renderWaypointArrow(
  map: maplibregl.Map,
  layer: Container,
  circle: NonNullable<RenderState["gameplayViewCircle"]>,
  waypoint: NonNullable<RenderState["mapWaypoint"]>
): void {
  const bearing = waypointBearingDegrees(circle.center, waypoint);
  const edgeLatLon = destinationPoint(circle.center, circle.radiusM, bearing);
  const centerScreen = map.project([circle.center.lon, circle.center.lat]);
  const edgeScreen = map.project([edgeLatLon.lon, edgeLatLon.lat]);
  const triangle = waypointArrowTriangle(
    { x: centerScreen.x, y: centerScreen.y },
    { x: edgeScreen.x, y: edgeScreen.y }
  );
  if (!triangle) return;
  const arrow = new Graphics()
    .poly([triangle.tip.x, triangle.tip.y, triangle.left.x, triangle.left.y, triangle.right.x, triangle.right.y], true)
    .fill({ color: 0xfacc15, alpha: 0.96 })
    .stroke({ color: 0x0d0b08, width: 1.5, alpha: 1 });
  const text = formatWaypointDistance(waypointDistanceMeters(circle.center, waypoint));
  const label = new Text({
    text: text ? `${waypoint.label} · ${text}` : waypoint.label,
    resolution: OVERLAY_RENDER_RESOLUTION,
    roundPixels: true,
    style: {
      fill: 0xfef3c7,
      fontFamily: "Inter, Arial, sans-serif",
      fontSize: 11,
      fontWeight: "700",
      stroke: { color: 0x0d0b08, width: 3 },
      dropShadow: { color: 0x0d0b08, alpha: 0.65, blur: 2, distance: 1 }
    }
  });
  label.anchor.set(0.5 + 0.5 * triangle.direction.x, 0.5 + 0.5 * triangle.direction.y);
  label.position.set(triangle.label.x, triangle.label.y);
  label.eventMode = "none";
  arrow.eventMode = "none";
  const opacity = globeOverlayOpacityForMap(map, circle.center);
  arrow.alpha = opacity;
  label.alpha = opacity;
  layer.addChild(arrow, label);
}

function renderSelectionLayer(
  map: maplibregl.Map,
  selectionLayer: Container,
  siegePreviewLayer: Container,
  state: RenderState
): void {
  clearLayer(selectionLayer);
  clearLayer(siegePreviewLayer);
  const addSelectionGraphic = (graphics: Graphics, position: LatLon): void => {
    graphics.alpha = globeOverlayOpacityForMap(map, position);
    selectionLayer.addChild(graphics);
  };
  const preview = state.flagPlacementPreview;
  if (preview) {
    const color = preview.state === "overlap"
      ? 0xef4444
      : preview.state === "touching"
        ? 0xf59e0b
        : 0x22c55e;
    addSelectionGraphic(
      new Graphics()
        .poly(
          flattenRing(
            createGeodesicCircleScreenRing(
              map,
              { lat: preview.lat, lon: preview.lon },
              preview.radiusM,
              TERRITORY_CIRCLE_SEGMENTS
            )
          ),
          true
        )
        .fill({ color, alpha: 0.14 })
        .stroke({ color, width: 3, alpha: 0.98 }),
      preview
    );
  }
  const selectedSiege = (state.militaryGroups ?? []).find(
    (group) => group.groupId === state.selectedMilitaryGroupId
  ) ?? null;
  const siegePreviewFlagIds = new Set([
    ...(state.siegeDeploymentPreviewFlagIds ?? []),
    ...siegeTargetFlagIds(selectedSiege, state.flags)
  ]);
  for (const flag of state.flags) {
    if (!siegePreviewFlagIds.has(flag.id)) continue;
    const point = map.project([flag.lon, flag.lat]);
    const marker = new Graphics();
    marker
      .circle(point.x, point.y, 16)
      .fill({ color: 0x22c55e, alpha: 0.16 })
      .stroke({ color: 0x22c55e, width: 3, alpha: 1 })
      .circle(point.x, point.y, 5)
      .fill({ color: 0x22c55e, alpha: 1 })
      .moveTo(point.x - 24, point.y)
      .lineTo(point.x - 8, point.y)
      .moveTo(point.x + 8, point.y)
      .lineTo(point.x + 24, point.y)
      .moveTo(point.x, point.y - 24)
      .lineTo(point.x, point.y - 8)
      .moveTo(point.x, point.y + 8)
      .lineTo(point.x, point.y + 24)
      .stroke({ color: 0x22c55e, width: 3, alpha: 1 });
    marker.eventMode = "none";
    siegePreviewLayer.addChild(marker);
  }
  const selectedFlag = state.flags.find((flag) => flag.id === state.selectedFlagId);
  if (selectedFlag) {
    const selectedFlagHighlight = new Graphics()
      .poly(
        flattenRing(
          createGeodesicCircleScreenRing(
            map,
            { lat: selectedFlag.lat, lon: selectedFlag.lon },
            selectedFlag.claimRadiusM,
            TERRITORY_CIRCLE_SEGMENTS
          )
        ),
        true
      )
      .stroke({ color: 0xfff1f2, width: 4, alpha: 0.95 });
    addSelectionGraphic(selectedFlagHighlight, selectedFlag);
  }
}

export function flagInteractionHitBox(
  flag: FlagSnapshot,
  point: { x: number; y: number },
  zoom: number
): ScreenHitBox {
  if (flag.anchorKind === "buoy") {
    return spriteInteractionHitBox({
      x: point.x,
      y: point.y,
      textureWidth: BUOY_ARTWORK_URLS.canvas.width,
      textureHeight: BUOY_ARTWORK_URLS.canvas.height,
      zoom,
      presentation: WORLD_SPRITE_PRESENTATION.buoy,
      paddingPx: 0
    });
  }
  const layout = spriteLayoutForZoom(point.x, point.y, FLAG_MARKER_HEIGHT_PX, zoom, WORLD_SPRITE_PRESENTATION.flag);
  return territoryStructureInteractionBounds(
    territoryStructureTypeForFlag(flag.upgradeTier), TERRITORY_STRUCTURE_CATALOG,
    point.x, point.y, layout.scaleX, layout.scaleY
  );
}

function renderFlagLayers(
  map: maplibregl.Map,
  flagLayer: Container,
  kingdomSeatLayer: Container,
  flags: FlagSnapshot[],
  flagHitBoxes: Array<ScreenHitBox & { flag: FlagSnapshot }>,
  kingdomSeatTexture: Texture,
  territoryTextures: Readonly<Record<string, Texture>>,
  flagArtworkTextures: Readonly<{
    buoy: Readonly<{ color: Texture; hardware: Texture }>;
  }>,
  retainedMarkers: Map<
    string,
    { signature: string; container: Container & ZoomScaledDisplay }
  >,
  metrics: {
    created: number;
    updated: number;
    retained: number;
    destroyed: number;
  }
): void {
  flagHitBoxes.length = 0;
  const activeKeys = new Set<string>();
  const zoom = mapGroundScaleZoom(map);
  for (const flag of flags) {
    const point = map.project([flag.lon, flag.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, flag);
    const key = `flag:${flag.id}`;
    const signature = flagsSignature([flag]);
    activeKeys.add(key);
    const retained = retainedMarkers.get(key);
    if (retained?.signature === signature) {
      metrics.retained += 1;
      const presentation = flag.anchorKind === "buoy"
        ? WORLD_SPRITE_PRESENTATION.buoy
        : WORLD_SPRITE_PRESENTATION.flag;
      applyZoomScaledPresentation(
        retained.container,
        point.x,
        point.y,
        flag.anchorKind === "buoy"
          ? BUOY_ARTWORK_URLS.canvas.height
          : FLAG_MARKER_HEIGHT_PX,
        presentation,
        zoom
      );
      retained.container.alpha = globeOpacity;
      if (globeOpacity >= 0.5) {
        flagHitBoxes.push({ flag, ...flagInteractionHitBox(flag, point, zoom) });
      }
      continue;
    }
    if (retained) {
      flagLayer.removeChild(retained.container);
      retained.container.destroy({ children: true });
      metrics.destroyed += 1;
      metrics.updated += 1;
    }
    const controlColor = hexToNumber(flagAccessRenderColor(flag));
    const marker = new Container() as Container & ZoomScaledDisplay;
    if (flag.anchorKind === "buoy") {
      const color = new Sprite(flagArtworkTextures.buoy.color);
      color.anchor.set(
        WORLD_SPRITE_PRESENTATION.buoy.anchorX,
        WORLD_SPRITE_PRESENTATION.buoy.anchorY
      );
      color.width = BUOY_ARTWORK_URLS.canvas.width;
      color.height = BUOY_ARTWORK_URLS.canvas.height;
      color.tint = controlColor;
      const hardware = new Sprite(flagArtworkTextures.buoy.hardware);
      hardware.anchor.set(
        WORLD_SPRITE_PRESENTATION.buoy.anchorX,
        WORLD_SPRITE_PRESENTATION.buoy.anchorY
      );
      hardware.width = BUOY_ARTWORK_URLS.canvas.width;
      hardware.height = BUOY_ARTWORK_URLS.canvas.height;
      marker.addChild(color, hardware);
    } else {
      marker.addChild(createTerritoryStructureRoot(
        territoryStructureVisual(territoryStructureTypeForFlag(flag.upgradeTier)),
        (asset) => territoryTextures[asset]!,
        {
          controlColor,
          burning: flag.burning === true,
          ...(flag.controlType === "kingdom" ? { emblem: flag.kingdomEmblemKey ?? "K" } : {}),
          resolution: OVERLAY_RENDER_RESOLUTION
        }
      ));
    }
    if (flag.burning && flag.anchorKind === "buoy") {
      const burningEffect = new Graphics()
        .poly([-8, -30, -3, -40, 0, -33, 5, -43, 9, -30, 5, -24, -4, -24])
        .fill({ color: 0xff6b00, alpha: 0.95 })
        .stroke({ color: 0xffd166, width: 1.5, alpha: 0.95 });
      marker.addChild(burningEffect);
    }
    if (shouldRenderFlagHealthBar(flag)) {
      const healthBar = new Graphics();
      drawFlagHealthBar(healthBar, flag);
      const healthBarY = flagHealthBarOffsetBelowAnchor(flag);
      healthBar.position.set(0, healthBarY);
      marker.addChild(healthBar);
    }
    if (flag.controlType === "kingdom" && flag.anchorKind === "buoy") {
      const emblem = new Text({
        text: Array.from(flag.kingdomEmblemKey ?? "K")[0]?.toUpperCase() ?? "K",
        resolution: OVERLAY_RENDER_RESOLUTION,
        roundPixels: true,
        style: {
          fill: 0xffffff,
          fontFamily: "system-ui, sans-serif",
          fontSize: 10,
          fontWeight: "800"
        }
      });
      emblem.anchor.set(0.5);
      emblem.position.set(
        10,
        -14
      );
      marker.addChild(emblem);
    }
    const presentation = flag.anchorKind === "buoy"
      ? WORLD_SPRITE_PRESENTATION.buoy
      : WORLD_SPRITE_PRESENTATION.flag;
    applyZoomScaledPresentation(
      marker,
      point.x,
      point.y,
      flag.anchorKind === "buoy"
        ? BUOY_ARTWORK_URLS.canvas.height
        : FLAG_MARKER_HEIGHT_PX,
      presentation,
      zoom
    );
    marker.alpha = globeOpacity;
    flagLayer.addChild(marker);
    retainedMarkers.set(key, { signature, container: marker });
    metrics.created += 1;
    if (globeOpacity >= 0.5) {
      flagHitBoxes.push({ flag, ...flagInteractionHitBox(flag, point, zoom) });
    }
  }
  for (const flag of flags.filter(({ controlType }) => controlType === "kingdom_seat")) {
    const seatPosition = kingdomSeatMarkerPosition(flag);
    const point = map.project([seatPosition.lon, seatPosition.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, seatPosition);
    const key = `seat:${flag.id}`;
    const signature = flagsSignature([flag]);
    activeKeys.add(key);
    const retained = retainedMarkers.get(key);
    if (retained?.signature === signature) {
      metrics.retained += 1;
      applyZoomScaledPresentation(
        retained.container,
        point.x,
        point.y,
        KINGDOM_SEAT_MARKER_SIZE_PX,
        WORLD_SPRITE_PRESENTATION.kingdomSeat,
        zoom
      );
      retained.container.alpha = globeOpacity;
      if (globeOpacity >= 0.5) {
        flagHitBoxes.push({
          flag,
          ...spriteInteractionHitBox({
            x: point.x,
            y: point.y,
            textureWidth: kingdomSeatTexture.width,
            textureHeight: kingdomSeatTexture.height,
            zoom,
            presentation: WORLD_SPRITE_PRESENTATION.kingdomSeat,
            paddingPx: 0
          })
        });
      }
      continue;
    }
    if (retained) {
      kingdomSeatLayer.removeChild(retained.container);
      retained.container.destroy({ children: true });
      metrics.destroyed += 1;
      metrics.updated += 1;
    }
    const alpha = kingdomSeatMarkerAlpha(flag.kingdomSeatConstructionState);
    const markerContainer = new Container() as Container & ZoomScaledDisplay;
    const shadow = new Sprite(kingdomSeatTexture);
    shadow.anchor.set(
      WORLD_SPRITE_PRESENTATION.kingdomSeat.anchorX,
      WORLD_SPRITE_PRESENTATION.kingdomSeat.anchorY
    );
    shadow.position.set(3, 3);
    shadow.width = KINGDOM_SEAT_MARKER_SIZE_PX;
    shadow.height = KINGDOM_SEAT_MARKER_SIZE_PX;
    shadow.tint = 0x111827;
    shadow.alpha = alpha * 0.9;
    const marker = new Sprite(kingdomSeatTexture);
    marker.anchor.set(
      WORLD_SPRITE_PRESENTATION.kingdomSeat.anchorX,
      WORLD_SPRITE_PRESENTATION.kingdomSeat.anchorY
    );
    marker.position.set(0, 0);
    marker.width = KINGDOM_SEAT_MARKER_SIZE_PX;
    marker.height = KINGDOM_SEAT_MARKER_SIZE_PX;
    marker.alpha = alpha;
    // A Castle at 0 HP lies in rubble until its leader rebuilds it. No rubble
    // art exists yet: the Castle sprite is darkened instead.
    if (flag.health === 0) marker.tint = KINGDOM_SEAT_RUBBLE_TINT;
    markerContainer.addChild(shadow, marker);
    if (flag.kingdomSeatConstructionState === "under_construction") {
      markerContainer.addChild(
        new Graphics()
          .rect(-14, 13, 28, 3)
          .fill({ color: 0xf59e0b, alpha: 0.95 })
          .rect(-10, 10, 3, 9)
          .rect(7, 10, 3, 9)
          .fill({ color: 0x78350f, alpha: 0.95 })
      );
    }
    applyZoomScaledPresentation(
      markerContainer,
      point.x,
      point.y,
      KINGDOM_SEAT_MARKER_SIZE_PX,
      WORLD_SPRITE_PRESENTATION.kingdomSeat,
      zoom
    );
    markerContainer.alpha = globeOpacity;
    kingdomSeatLayer.addChild(markerContainer);
    retainedMarkers.set(key, { signature, container: markerContainer });
    metrics.created += 1;
    if (globeOpacity >= 0.5) {
      flagHitBoxes.push({
        flag,
        ...spriteInteractionHitBox({
          x: point.x,
          y: point.y,
          textureWidth: kingdomSeatTexture.width,
          textureHeight: kingdomSeatTexture.height,
          zoom,
          presentation: WORLD_SPRITE_PRESENTATION.kingdomSeat,
          paddingPx: 0
        })
      });
    }
  }
  for (const [key, retained] of retainedMarkers) {
    if (activeKeys.has(key)) continue;
    retainedMarkers.delete(key);
    retained.container.parent?.removeChild(retained.container);
    retained.container.destroy({ children: true });
    metrics.destroyed += 1;
  }
}

export function shouldRenderFlagHealthBar(flag: FlagSnapshot): boolean {
  const health = flag.health;
  const maximumHealth = flag.maximumHealth;
  return flag.burning === true ||
    (health !== undefined && maximumHealth !== undefined && health < maximumHealth);
}

export const FLAG_HEALTH_BAR_HEIGHT_PX = 5;
export const FLAG_HEALTH_BAR_LABEL_GAP_PX = 2;

export function flagHealthBarOffsetBelowAnchor(
  flag: Pick<FlagSnapshot, "anchorKind" | "upgradeTier">
): number {
  if (flag.anchorKind === "buoy") {
    return worldHealthBarOffsetBelowAnchor(
      BUOY_ARTWORK_URLS.canvas.height,
      WORLD_SPRITE_PRESENTATION.buoy.anchorY
    );
  }
  const visual = territoryStructureVisual(territoryStructureTypeForFlag(flag.upgradeTier));
  const bottom = Math.max(...territoryStructurePieceBounds(visual).filter((piece) => piece.visible).map((piece) => piece.top + piece.height));
  return worldHealthBarOffsetBelowAnchor(Math.max(0, bottom), 0);
}

function drawFlagHealthBar(graphics: Graphics, flag: FlagSnapshot): void {
  const maximumHealth = Math.max(1, flag.maximumHealth ?? 100);
  const health = Math.max(0, Math.min(maximumHealth, flag.health ?? maximumHealth));
  const width = 46;
  const height = FLAG_HEALTH_BAR_HEIGHT_PX;
  const left = -width / 2;
  const ratio = health / maximumHealth;
  graphics
    .clear()
    .roundRect(left, 0, width, height, 1)
    .fill({ color: HEALTH_BAR_COLORS.frame, alpha: 0.98 })
    .roundRect(left + 1, 1, width - 2, height - 2, 0.75)
    .fill({ color: HEALTH_BAR_COLORS.track, alpha: 1 });
  if (ratio > 0) {
    graphics
      .roundRect(left + 1, 1, (width - 2) * ratio, height - 2, 0.75)
      .fill({
        color: ratio <= 0.25 ? HEALTH_BAR_COLORS.criticalFrame : HEALTH_BAR_COLORS.fillBottom,
        alpha: 1
      });
  }
}

function renderCityLayer(
  map: maplibregl.Map,
  cityLayer: Container,
  cities: CitySnapshot[],
  cityHitBoxes: Array<ScreenHitBox & { city: CitySnapshot }>,
  cityTextures: Readonly<Record<"blueprint" | "foundation" | "framing" | "complete" | "goblinComplete", Texture>>
): void {
  clearLayer(cityLayer);
  cityHitBoxes.length = 0;
  const zoom = mapGroundScaleZoom(map);
  for (const city of cities) {
    const point = map.project([city.lon, city.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, city);
    const cityMarkerTexture = city.controllerKind === "npc" && city.culture === "goblin"
      ? cityTextures.goblinComplete
      : cityTextures[city.constructionPhase ?? "complete"];
    const presentation = city.controllerKind === "npc" && city.culture === "goblin"
      ? SPRITE_PRESENTATION.goblinHall
      : WORLD_SPRITE_PRESENTATION.city;
    const building = new Sprite(cityMarkerTexture);
    building.anchor.set(presentation.anchorX, presentation.anchorY);
    applyZoomScaledPresentation(
      building,
      point.x,
      point.y,
      building.texture.height,
      presentation,
      zoom
    );
    const label = new Text({
      text: city.name,
      resolution: OVERLAY_RENDER_RESOLUTION,
      roundPixels: true,
      style: {
        fill: 0xeee5d3,
        fontFamily: "Inter, Arial, sans-serif",
        fontSize: 12,
        fontWeight: "700",
        stroke: { color: 0x0d0b08, width: 2 },
        dropShadow: { color: 0x0d0b08, alpha: 0.6, blur: 2, distance: 1 }
      }
    });
    label.anchor.set(0.5, 0);
    label.eventMode = "none";
    const hitBox = spriteInteractionHitBox({
      x: point.x,
      y: point.y,
      textureWidth: cityMarkerTexture.width,
      textureHeight: cityMarkerTexture.height,
      zoom,
      presentation,
      paddingPx: 0
    });
    const labelPosition = worldLabelPositionBelowHitBox(hitBox);
    const labelMarker = new Container({ x: point.x, y: point.y }) as ZoomScaledDisplay;
    label.position.set(labelPosition.x - point.x, labelPosition.y - point.y);
    labelMarker.addChild(label);
    labelMarker[staticLabelLayoutKey] = (currentZoom) => {
      const position = worldLabelPositionBelowHitBox(spriteInteractionHitBox({
        x: 0, y: 0, textureWidth: cityMarkerTexture.width,
        textureHeight: cityMarkerTexture.height, zoom: currentZoom, presentation, paddingPx: 0
      }));
      label.position.set(position.x, position.y);
    };
    building.alpha = globeOpacity;
    label.alpha = globeOpacity;
    cityLayer.addChild(building, labelMarker);
    if (globeOpacity >= 0.5) cityHitBoxes.push({ city, ...hitBox });
  }
}

function renderCityStructureLayer(
  map: maplibregl.Map,
  artworkLayer: Container,
  labelLayer: Container,
  structures: CityStructureSnapshot[],
  hitBoxes: Array<{
    structure: CityStructureSnapshot;
  } & ScreenHitBox>,
  textures: CityStructureTextures
): void {
  clearLayer(artworkLayer);
  clearLayer(labelLayer);
  hitBoxes.length = 0;
  const zoom = mapGroundScaleZoom(map);
  for (const structure of structures) {
    if (structure.state !== "active") continue;
    if (!isRenderableCityStructureType(structure.type)) continue;
    const point = map.project([structure.lon, structure.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, structure);
    const marker = new Container({ x: point.x, y: point.y });
    const presentationKey = cityStructurePresentationKey(structure);
    if (presentationKey === null) continue;
    const buildingTexture = structure.type === "market" && structure.cityCulture === "goblin"
      ? textures.goblin_market
      : textures[presentationKey];
    const building = new Sprite(buildingTexture);
    const presentation = structure.type === "market" && structure.cityCulture === "goblin"
      ? WORLD_PNG_PRESENTATION.cityStructures.goblin_market
      : WORLD_PNG_PRESENTATION.cityStructures[presentationKey];
    building.anchor.set(
      presentation.anchorX,
      presentation.anchorY
    );
    applyZoomScaledPresentation(
      building,
      0,
      0,
      building.texture.height,
      presentation,
      zoom
    );
    const hitBox = worldPngInteractionHitBox({
      x: point.x,
      y: point.y,
      zoom,
      presentation
    });
    const labelPosition = worldLabelPositionBelowHitBox(hitBox);
    const labelParts = cityStructureWorldLabelParts(structure);
    const war = cityBuildingWarfareView(structure, Date.now());
    const primaryLabel = new Text({
      text: labelParts.primary,
      resolution: OVERLAY_RENDER_RESOLUTION,
      roundPixels: true,
      style: {
        fill: 0xeee5d3,
        fontFamily: "Inter, Arial, sans-serif",
        fontSize: 10,
        fontWeight: "700",
        stroke: { color: 0x0d0b08, width: 2 },
        dropShadow: { color: 0x0d0b08, alpha: 0.6, blur: 2, distance: 1 }
      }
    });
    primaryLabel.anchor.set(0.5, 0);
    primaryLabel.eventMode = "none";
    primaryLabel.position.set(labelPosition.x - point.x, labelPosition.y - point.y);
    marker.addChild(building);
    if (war?.burning) {
      building.tint = 0xffb38a;
      const flame = new Sprite(textures.burning);
      flame.anchor.set(0.5, 1);
      flame.width = 24;
      flame.height = flame.texture.height / Math.max(1, flame.texture.width) * flame.width;
      flame.position.set(0, -building.height * 0.45);
      flame.alpha = war.repairing ? 0.5 : 1;
      flame.eventMode = "none";
      marker.addChild(flame);
    }
    if (war?.damaged) {
      const bar = new Graphics();
      drawCityBuildingHealthBar(bar, war.ratio, war.repairing);
      bar.position.set(0, labelPosition.y - point.y - FLAG_HEALTH_BAR_HEIGHT_PX - 3);
      bar.eventMode = "none";
      marker.addChild(bar);
    }
    const labelMarker = new Container({ x: point.x, y: point.y }) as ZoomScaledDisplay;
    labelMarker.addChild(primaryLabel);
    if (labelParts.secondary) {
      const secondaryLabel = new Text({
        text: labelParts.secondary,
        resolution: OVERLAY_RENDER_RESOLUTION,
        roundPixels: true,
        style: {
          fill: 0xb49d75,
          fontFamily: "Inter, Arial, sans-serif",
          fontSize: 8,
          fontWeight: "600",
          stroke: { color: 0x0d0b08, width: 1 },
          dropShadow: { color: 0x0d0b08, alpha: 0.6, blur: 2, distance: 1 }
        }
      });
      secondaryLabel.anchor.set(0.5, 0);
      secondaryLabel.eventMode = "none";
      secondaryLabel.position.set(primaryLabel.x, primaryLabel.y + primaryLabel.height + 1);
      labelMarker.addChild(secondaryLabel);
    }
    labelMarker[staticLabelLayoutKey] = (currentZoom) => {
      const position = worldLabelPositionBelowHitBox(worldPngInteractionHitBox({
        x: 0, y: 0, zoom: currentZoom, presentation
      }));
      primaryLabel.position.set(position.x, position.y);
      const secondaryLabel = labelMarker.children[1];
      secondaryLabel?.position.set(position.x, position.y + primaryLabel.height + 1);
    };
    marker.alpha = globeOpacity;
    labelMarker.alpha = globeOpacity;
    artworkLayer.addChild(marker);
    labelLayer.addChild(labelMarker);
    if (globeOpacity >= 0.5) {
      hitBoxes.push({
        structure,
        ...hitBox
      });
    }
  }
}

function drawCityBuildingHealthBar(graphics: Graphics, ratio: number, repairing: boolean): void {
  const width = 46;
  const height = FLAG_HEALTH_BAR_HEIGHT_PX;
  const left = -width / 2;
  graphics
    .clear()
    .roundRect(left, 0, width, height, 1)
    .fill({ color: HEALTH_BAR_COLORS.frame, alpha: 0.98 })
    .roundRect(left + 1, 1, width - 2, height - 2, 0.75)
    .fill({ color: HEALTH_BAR_COLORS.track, alpha: 1 });
  if (ratio > 0) {
    graphics
      .roundRect(left + 1, 1, (width - 2) * ratio, height - 2, 0.75)
      .fill({
        color: repairing
          ? 0x7cc46a
          : ratio <= 0.25 ? HEALTH_BAR_COLORS.criticalFrame : HEALTH_BAR_COLORS.fillBottom,
        alpha: 1
      });
  }
}

function renderDungeonEntranceLayer(
  map: maplibregl.Map,
  layer: Container,
  entrances: DungeonEntranceSnapshot[],
  hitBoxes: Array<{ entrance: DungeonEntranceSnapshot } & ScreenHitBox>,
  textureForEntrance: (entrance: DungeonEntranceSnapshot) => Texture
): void {
  clearLayer(layer);
  hitBoxes.length = 0;
  for (const entrance of entrances) {
    const point = map.project([entrance.lon, entrance.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, entrance);
    const marker = new Container({ x: point.x, y: point.y });
    if (entrance.wanderingMerchant) {
      // No merchant art yet: a name pin only, no placeholder sprite.
      const pin = new Text({
        text: entrance.name,
        resolution: OVERLAY_RENDER_RESOLUTION,
        style: {
          fill: 0xfde68a,
          fontFamily: "system-ui, sans-serif",
          fontSize: 12,
          fontWeight: "700",
          stroke: { color: 0x1f160f, width: 3 }
        }
      });
      pin.anchor.set(0.5, 1);
      marker.alpha = globeOpacity;
      marker.addChild(pin);
      layer.addChild(marker);
      if (globeOpacity >= 0.5) {
        hitBoxes.push({
          entrance,
          ...pngInteractionHitBox({
            x: point.x, y: point.y, width: Math.max(80, pin.width), height: 28, anchorX: 0.5, anchorY: 1,
            geometry: { shape: "rectangle", width: 1, height: 1, centerX: 0.5, centerY: 0.5 }
          })
        });
      }
      continue;
    }
    const artwork = new Sprite(textureForEntrance(entrance));
    artwork.anchor.set(0.5, 1);
    artwork.width = 112;
    artwork.height = artwork.texture.height / artwork.texture.width * artwork.width;
    const label = new Text({
      text: entrance.name,
      resolution: OVERLAY_RENDER_RESOLUTION,
      style: {
        fill: 0xfffbeb,
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        fontWeight: "700",
        stroke: { color: 0x1f160f, width: 3 }
      }
    });
    label.anchor.set(0.5, 1);
    label.position.set(0, -artwork.height + 4);
    marker.alpha = globeOpacity;
    // The Fallen Prison is hunted by sight: a tall smoke column rises from the crash.
    if (entrance.dungeonId === "fallen_prison") marker.addChild(fallenPrisonSmokeColumn(artwork.height));
    marker.addChild(artwork, label);
    layer.addChild(marker);
    if (globeOpacity >= 0.5) {
      hitBoxes.push({
        entrance,
        ...pngInteractionHitBox({
          x: point.x,
          y: point.y,
          width: artwork.width,
          height: artwork.height,
          anchorX: 0.5,
          anchorY: 1,
          geometry: { shape: "rectangle", width: 1, height: 1, centerX: 0.5, centerY: 0.5 }
        })
      });
    }
  }
}

/** Stacked, drifting grey puffs from the crash up to FALLEN_PRISON_SMOKE_COLUMN_PX (deterministic, no texture). */
function fallenPrisonSmokeColumn(baseHeight: number): Graphics {
  const smoke = new Graphics();
  const top = FALLEN_PRISON_SMOKE_COLUMN_PX;
  for (let index = 0; index < 18; index += 1) {
    const t = index / 17;
    const y = -baseHeight * 0.55 - t * (top - baseHeight * 0.55);
    const x = Math.sin(index * 1.7) * 6 + t * t * 26;
    const radius = 10 + t * 22;
    smoke.circle(x, y, radius).fill({ color: index % 2 === 0 ? 0x3f3a36 : 0x57514b, alpha: 0.5 - t * 0.32 });
  }
  return smoke;
}

function renderManorLayer(
  map: maplibregl.Map,
  manorLayer: Container,
  manors: ManorWorldSnapshot[],
  manorHitBoxes: ManorHitBox[],
  manorTexture: Texture,
  manorTypeTextures: ReadonlyMap<string, Readonly<{ texture: Texture; scale: number }>>,
  burningTexture: Texture
): void {
  clearLayer(manorLayer);
  manorHitBoxes.length = 0;
  const zoom = mapGroundScaleZoom(map);
  for (const manor of manors) {
    const point = map.project([manor.lon, manor.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, manor);
    const marker = new Container({ x: point.x, y: point.y });
    const typeArt = manorTypeTextures.get(resolveManorTypeId(manor.manorTypeId));
    const house = new Sprite(typeArt?.texture ?? manorTexture);
    const presentation = WORLD_PNG_PRESENTATION.manor;
    const typeScale = typeArt?.scale ?? 1;
    house.anchor.set(presentation.anchorX, presentation.anchorY);
    house.position.set(0, 8);
    house.width = presentation.width * typeScale;
    house.height = presentation.height * typeScale;
    applyZoomScaledPresentation(
      marker,
      point.x,
      point.y,
      presentation.height,
      presentation,
      zoom
    );
    marker.alpha = globeOpacity;
    marker.addChild(house);
    // Manor warfare: the city-building burn flame and HP bar; a burnt Manor is darkened.
    const war = manorWarfareView(manor, Date.now());
    if (war.burnt) {
      house.tint = 0x5a4a40;
    } else if (war.burning) {
      house.tint = 0xffb38a;
      const flame = new Sprite(burningTexture);
      flame.anchor.set(0.5, 1);
      flame.width = 24;
      flame.height = flame.texture.height / Math.max(1, flame.texture.width) * flame.width;
      flame.position.set(0, -house.height * 0.45);
      flame.alpha = war.repairing ? 0.5 : 1;
      flame.eventMode = "none";
      marker.addChild(flame);
    }
    if (war.damaged) {
      const bar = new Graphics();
      drawCityBuildingHealthBar(bar, war.ratio, war.repairing);
      bar.position.set(0, -house.height - FLAG_HEALTH_BAR_HEIGHT_PX - 3);
      bar.eventMode = "none";
      marker.addChild(bar);
    }
    manorLayer.addChild(marker);
    if (globeOpacity >= 0.5) {
      manorHitBoxes.push({ manor, ...worldPngInteractionHitBox({
        x: point.x,
        y: point.y + 8 * worldPngScaleForZoom(presentation, zoom),
        zoom,
        presentation
      }) });
    }
  }
}

function renderGreenhouseLayer(
  map: maplibregl.Map,
  greenhouseLayer: Container,
  greenhouses: GreenhouseSnapshot[],
  greenhouseHitBoxes: GreenhouseHitBox[],
  greenhouseTexture: Texture
): void {
  clearLayer(greenhouseLayer);
  greenhouseHitBoxes.length = 0;
  const zoom = mapGroundScaleZoom(map);
  for (const greenhouse of greenhouses) {
    const point = map.project([greenhouse.lon, greenhouse.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, greenhouse);
    const marker = new Container({ x: point.x, y: point.y });
    const house = new Sprite(greenhouseTexture);
    const presentation = WORLD_PNG_PRESENTATION.greenhouse;
    house.anchor.set(presentation.anchorX, presentation.anchorY);
    house.position.set(0, 8);
    house.width = presentation.width;
    house.height = presentation.height;
    applyZoomScaledPresentation(
      marker,
      point.x,
      point.y,
      presentation.height,
      presentation,
      zoom
    );
    marker.alpha = globeOpacity;
    marker.addChild(house);
    greenhouseLayer.addChild(marker);
    if (globeOpacity >= 0.5) {
      greenhouseHitBoxes.push({ greenhouse, ...worldPngInteractionHitBox({
        x: point.x,
        y: point.y + 8 * worldPngScaleForZoom(presentation, zoom),
        zoom,
        presentation
      }) });
    }
  }
}

function renderFurnaceLayer(
  map: maplibregl.Map,
  layer: Container,
  furnaces: FurnaceWorldSnapshot[],
  hitBoxes: FurnaceHitBox[],
  texture: Texture
): void {
  clearLayer(layer);
  hitBoxes.length = 0;
  const zoom = mapGroundScaleZoom(map);
  for (const furnace of furnaces) {
    const point = map.project([furnace.lon, furnace.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, furnace);
    const marker = new Container({ x: point.x, y: point.y });
    const sprite = new Sprite(texture);
    const presentation = WORLD_PNG_PRESENTATION.furnace;
    sprite.anchor.set(presentation.anchorX, presentation.anchorY);
    sprite.position.set(0, 8);
    sprite.width = presentation.width;
    sprite.height = presentation.height;
    applyZoomScaledPresentation(
      marker,
      point.x,
      point.y,
      presentation.height,
      presentation,
      zoom
    );
    marker.alpha = globeOpacity;
    marker.addChild(sprite);
    layer.addChild(marker);
    if (globeOpacity >= 0.5) {
      hitBoxes.push({ furnace, ...worldPngInteractionHitBox({
        x: point.x,
        y: point.y + 8 * worldPngScaleForZoom(presentation, zoom),
        zoom,
        presentation
      }) });
    }
  }
}

function renderTanneryLayer(
  map: maplibregl.Map,
  layer: Container,
  tanneries: TanneryWorldSnapshot[],
  hitBoxes: TanneryHitBox[],
  texture: Texture
): void {
  clearLayer(layer);
  hitBoxes.length = 0;
  const zoom = mapGroundScaleZoom(map);
  const presentation = WORLD_PNG_PRESENTATION.tannery;
  for (const tannery of tanneries) {
    const point = map.project([tannery.lon, tannery.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, tannery);
    const marker = new Container({ x: point.x, y: point.y });
    const sprite = new Sprite(texture);
    sprite.anchor.set(presentation.anchorX, presentation.anchorY);
    sprite.width = presentation.width;
    sprite.height = presentation.height;
    applyZoomScaledPresentation(
      marker,
      point.x,
      point.y,
      presentation.height,
      presentation,
      zoom
    );
    marker.alpha = globeOpacity;
    marker.addChild(sprite);
    layer.addChild(marker);
    const hitBox = worldPngInteractionHitBox({
      x: point.x,
      y: point.y,
      zoom,
      presentation
    });
    if (globeOpacity >= 0.5) hitBoxes.push({ tannery, ...hitBox });
  }
}

function renderLoomLayer(
  map: maplibregl.Map,
  layer: Container,
  looms: LoomWorldSnapshot[],
  hitBoxes: LoomHitBox[],
  texture: Texture
): void {
  clearLayer(layer);
  hitBoxes.length = 0;
  const zoom = mapGroundScaleZoom(map);
  const presentation = WORLD_PNG_PRESENTATION.loom;
  for (const loom of looms) {
    const point = map.project([loom.lon, loom.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, loom);
    const marker = new Container({ x: point.x, y: point.y });
    const sprite = new Sprite(texture);
    sprite.anchor.set(presentation.anchorX, presentation.anchorY);
    sprite.width = presentation.width;
    sprite.height = presentation.height;
    applyZoomScaledPresentation(
      marker,
      point.x,
      point.y,
      presentation.height,
      presentation,
      zoom
    );
    marker.alpha = globeOpacity;
    marker.addChild(sprite);
    layer.addChild(marker);
    const hitBox = worldPngInteractionHitBox({
      x: point.x,
      y: point.y,
      zoom,
      presentation
    });
    if (globeOpacity >= 0.5) hitBoxes.push({ loom, ...hitBox });
  }
}

/** Kitchen uses the canonical food item artwork as a safe development fallback until production station art lands. */
function renderKitchenLayer(
  map: maplibregl.Map,
  layer: Container,
  kitchens: KitchenWorldSnapshot[],
  hitBoxes: KitchenHitBox[],
  texture: Texture
): void {
  clearLayer(layer);
  hitBoxes.length = 0;
  const zoom = mapGroundScaleZoom(map);
  const presentation = WORLD_PNG_PRESENTATION.kitchen;
  for (const kitchen of kitchens) {
    const point = map.project([kitchen.lon, kitchen.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, kitchen);
    const marker = new Container({ x: point.x, y: point.y });
    const sprite = new Sprite(texture);
    sprite.anchor.set(presentation.anchorX, presentation.anchorY);
    sprite.position.set(0, 8);
    sprite.width = presentation.width;
    sprite.height = presentation.height;
    applyZoomScaledPresentation(
      marker,
      point.x,
      point.y,
      presentation.height,
      presentation,
      zoom
    );
    marker.alpha = globeOpacity;
    marker.addChild(sprite);
    layer.addChild(marker);
    if (globeOpacity >= 0.5) {
      hitBoxes.push({ kitchen, ...worldPngInteractionHitBox({
        x: point.x,
        y: point.y + 8 * worldPngScaleForZoom(presentation, zoom),
        zoom,
        presentation
      }) });
    }
  }
}

/**
 * Sapling growth art: sprout, young sapling and young tree, each a third of the growth. All three
 * share the Giving Tree's 1254 px canvas and ground line, so they draw at the tree's presentation
 * and only the picture changes as it grows.
 */
const GIVING_SAPLING_STAGE_URLS = {
  givingSaplingStage1: givingSaplingStage1Url,
  givingSaplingStage2: givingSaplingStage2Url,
  givingSaplingStage3: givingSaplingStage3Url
} as const;
type GivingSaplingStageKey = keyof typeof GIVING_SAPLING_STAGE_URLS;
/** How much of the full tree's height each stage's art fills (for the tap circle). */
const GIVING_SAPLING_STAGE_HEIGHT: Readonly<Record<GivingSaplingStageKey, number>> = {
  givingSaplingStage1: 0.37,
  givingSaplingStage2: 0.63,
  givingSaplingStage3: 0.9
};

export function givingSaplingStageKey(growth: number): GivingSaplingStageKey {
  return growth < 1 / 3 ? "givingSaplingStage1" : growth < 2 / 3 ? "givingSaplingStage2" : "givingSaplingStage3";
}

/**
 * Player-planted saplings draw their growth-stage art, tinted yellow-brown once tending is due and
 * darker as they near death. Grown player trees draw as ordinary Giving Trees, with berries while
 * one is ready to gather.
 */
function renderSaplingLayer(
  map: maplibregl.Map,
  layer: Container,
  saplings: readonly SaplingRenderItem[],
  textures: WorldTextures,
  hitBoxes: Array<ScreenHitBox & { saplingId: string }>
): void {
  clearLayer(layer);
  hitBoxes.length = 0;
  const zoom = mapGroundScaleZoom(map);
  const base = WORLD_SPRITE_PRESENTATION.tree;
  for (const sapling of saplings) {
    const point = map.project([sapling.lon, sapling.lat]);
    const stage = sapling.state === "grown" ? null : givingSaplingStageKey(sapling.growth);
    const texture = stage ? textures[stage]! : sapling.berryAvailable ? textures.resinTree : textures.tree;
    const fill = stage ? GIVING_SAPLING_STAGE_HEIGHT[stage] : 1;
    const presentation = base;
    addArtworkSprite(layer, texture, point.x, point.y, presentation, zoom, 1);
    const sprite = layer.children[layer.children.length - 1] as Sprite | undefined;
    if (sprite && sapling.state === "sapling") {
      sprite.tint = sapling.phase === "dying" ? 0xa8845a : sapling.phase === "needs_tending" ? 0xd9d08a : 0xffffff;
    }
    // Tappable like other map objects: a circle over the drawn tree body.
    const heightPx = spriteHeightForZoom(zoom, SPRITE_BASE_ZOOM, presentation) * fill;
    hitBoxes.push({
      saplingId: sapling.id,
      shape: "circle",
      x: point.x,
      y: point.y - heightPx * 0.45,
      radius: Math.max(16, heightPx * 0.45)
    });
  }
}

/**
 * Temporary vector fallback for the Fishing Hut. A dedicated production PNG
 * can be wired into this layer without changing the world-PNG zoom/hitbox
 * policy or the durable object identity.
 */
function renderFishingHutLayer(
  map: maplibregl.Map,
  layer: Container,
  fishingHuts: FishingHutWorldSnapshot[],
  hitBoxes: FishingHutHitBox[]
): void {
  clearLayer(layer);
  hitBoxes.length = 0;
  const zoom = mapGroundScaleZoom(map);
  const presentation = WORLD_PNG_PRESENTATION.kitchen;
  for (const fishingHut of fishingHuts) {
    const point = map.project([fishingHut.lon, fishingHut.lat]);
    const marker = new Container({ x: point.x, y: point.y });
    let artwork: Sprite | Graphics;
    if (FISHING_HUT_ARTWORK_URL) {
      const sprite = new Sprite(Texture.from(FISHING_HUT_ARTWORK_URL));
      sprite.anchor.set(0.5, 1);
      sprite.width = 42;
      sprite.height = 32;
      artwork = sprite;
    } else {
      artwork = new Graphics()
        .rect(-18, -24, 36, 22)
        .fill({ color: 0x245c68, alpha: 0.98 })
        .rect(-21, -27, 42, 5)
        .fill({ color: 0x123640, alpha: 1 })
        .rect(-12, -16, 8, 9)
        .fill({ color: 0xf3c969, alpha: 0.95 })
        .rect(4, -16, 8, 9)
        .fill({ color: 0xf3c969, alpha: 0.95 })
        .rect(-3, -7, 6, 5)
        .fill({ color: 0x0b2027, alpha: 1 });
      artwork.position.set(0, 8);
    }
    applyZoomScaledPresentation(
      marker,
      point.x,
      point.y,
      presentation.height,
      presentation,
      zoom
    );
    marker.addChild(artwork);
    layer.addChild(marker);
    hitBoxes.push({ fishingHut, ...worldPngInteractionHitBox({
      x: point.x,
      y: point.y + 8 * worldPngScaleForZoom(presentation, zoom),
      zoom,
      presentation
    }) });
  }
}

export function pickManorHitBox(
  point: { x: number; y: number },
  hitBoxes: readonly ManorHitBox[],
  currentManors: readonly ManorWorldSnapshot[]
): ManorWorldSnapshot | null {
  for (let index = hitBoxes.length - 1; index >= 0; index -= 1) {
    const hit = hitBoxes[index];
    if (hit && containsScreenHitBox(point, hit)) {
      return currentManors.find((manor) => manor.manorId === hit.manor.manorId) ?? hit.manor;
    }
  }
  return null;
}

function renderWaterHighlightLayer(
  map: maplibregl.Map,
  waterHighlightGraphics: Graphics,
  waterHighlights: WaterSourceHighlight[],
  resourceVision: ResourceVision | null,
  alphaForId: (id: string) => number
): void {
  waterHighlightGraphics.alpha = 1;
  waterHighlightGraphics.clear();
  if (!resourceVision) {
    return;
  }
  for (const highlight of waterHighlights) {
    if (!highlight.collectible) {
      continue;
    }
    const point = map.project([highlight.lon, highlight.lat]);
    const isLake = highlight.waterSourceType.includes("lake") || highlight.waterSourceType.includes("reservoir");
    const alpha = alphaForId(highlight.id) * globeOverlayOpacityForMap(map, highlight);
    waterHighlightGraphics
      .circle(point.x, point.y, isLake ? 12 : 9)
      .fill({ color: isLake ? 0x0ea5e9 : 0x22d3ee, alpha: (isLake ? 0.26 : 0.18) * alpha })
      .stroke({ color: 0x67e8f9, width: isLake ? 2.5 : 2, alpha: 0.86 * alpha })
      .circle(point.x, point.y, isLake ? 4.5 : 3.5)
      .fill({ color: 0xe0f2fe, alpha: 0.86 * alpha });
  }
}

function renderCollectibleLayer(
  map: maplibregl.Map,
  spriteLayer: Container,
  collectibleGraphics: Graphics,
  collectibles: CollectibleNode[],
  collectibleHitBoxes: CollectibleHitBox[],
  textures: WorldTextures,
  retainedMarkers: Map<
    string,
    { signature: string; container: Container }
  >,
  metrics: {
    created: number;
    updated: number;
    retained: number;
    destroyed: number;
  },
  treeTextureFor: (collectible: CollectibleNode) => Texture | null,
  treeArtRevision: number,
  visibilityForId: (id: string) => Readonly<{
    alpha: number;
    interactive: boolean;
  }>
): void {
  const startedAt = performance.now();
  collectibleGraphics.clear();
  collectibleHitBoxes.length = 0;
  const retainedIds = new Set<string>();
  const zoom = mapGroundScaleZoom(map);
  for (const collectible of collectibles) {
    if (!shouldRenderCollectibleMarker(collectible)) {
      continue;
    }
    retainedIds.add(collectible.id);
    const point = map.project([collectible.lon, collectible.lat]);
    const signature = `${collectiblesSignature([collectible])}:${zoom.toFixed(3)}:${treeArtRevision}`;
    let retained = retainedMarkers.get(collectible.id);
    if (!retained || retained.signature !== signature) {
      if (retained) {
        spriteLayer.removeChild(retained.container);
        retained.container.destroy({ children: true });
        metrics.destroyed += 1;
        metrics.updated += 1;
      }
      const container = new Container();
      const graphics = new Graphics();
      container.addChild(graphics);
      drawCollectibleMarker(
        container,
        graphics,
        0,
        0,
        collectible,
        textures,
        zoom,
        treeTextureFor(collectible)
      );
      spriteLayer.addChild(container);
      retained = { signature, container };
      retainedMarkers.set(collectible.id, retained);
      metrics.created += 1;
    } else {
      metrics.retained += 1;
    }
    retained.container.position.set(point.x, point.y);
    const visibility = visibilityForId(collectible.id);
    const globeOpacity = globeOverlayOpacityForMap(map, collectible);
    retained.container.alpha = visibility.alpha * globeOpacity;
    if (
      visibility.interactive &&
      globeOpacity >= 0.5 &&
      (collectible.state === "available" || collectible.repeatableNodeType !== undefined)
    ) {
      collectibleHitBoxes.push(collectibleHitBox(
        collectible,
        point,
        zoom,
        textures
      ));
    }
  }
  for (const [entityId, retained] of retainedMarkers) {
    if (retainedIds.has(entityId)) continue;
    retainedMarkers.delete(entityId);
    spriteLayer.removeChild(retained.container);
    retained.container.destroy({ children: true });
    metrics.destroyed += 1;
  }
  perfMetrics.noteCollectibleRedraw(performance.now() - startedAt);
}

export function shouldRenderCollectibleMarker(collectible: CollectibleNode): boolean {
  return collectible.type !== "water" &&
    (collectible.type !== "stone" || collectible.repeatableNodeType !== undefined) &&
    (collectible.state === "available" || collectible.repeatableNodeType !== undefined);
}

function renderDroppedItemLayer(
  map: maplibregl.Map,
  spriteLayer: Container,
  graphics: Graphics,
  drops: DroppedItemSnapshot[],
  hitBoxes: Array<ScreenHitBox & { drop: DroppedItemSnapshot }>,
  selectedDropId: string | null,
  textures: WorldTextures,
  visibilityForId: (id: string) => Readonly<{
    alpha: number;
    interactive: boolean;
  }>
): void {
  clearLayer(spriteLayer);
  graphics.clear();
  hitBoxes.length = 0;
  const pileOffsets = new Map<string, number>();
  const stacks = stackDroppedItemsForWorld(
    drops.filter((drop) => drop.status === "active")
  );
  for (const stack of stacks) {
    const drop = stack.displayDrop;
    const visibility = visibilityForId(drop.dropId);
    const point = map.project([drop.lon, drop.lat]);
    const globeOpacity = globeOverlayOpacityForMap(map, drop);
    const alpha = visibility.alpha * globeOpacity;
    const pileId = drop.pileId ?? drop.dropId;
    const pileIndex = pileOffsets.get(pileId) ?? 0;
    pileOffsets.set(pileId, pileIndex + 1);
    const displayX = point.x + ((pileIndex % 3) - 1) * 12;
    const displayY = point.y - Math.floor(pileIndex / 3) * 10;
    if (stack.drops.some((member) => member.dropId === selectedDropId)) {
      const pickupRadiusPx = screenRadiusForMeters(map, drop, DROPPED_ITEM_PICKUP_RADIUS_M);
      graphics
        .circle(point.x, point.y, pickupRadiusPx)
        .fill({ color: 0xfacc15, alpha: 0.07 * alpha })
        .stroke({ color: 0xfacc15, width: 2, alpha: 0.88 * alpha });
    }
    const artworkKey = droppedItemArtworkKey(drop.itemId, drop.variant);
    if (artworkKey) {
      const presentation = itemSpritePresentationForArtwork(artworkKey);
      const texture = textures[artworkKey] ?? Texture.WHITE;
      const worldPresentation = WORLD_SPRITE_PRESENTATION[artworkKey as keyof typeof WORLD_SPRITE_PRESENTATION]
        ?? presentation;
      const groundHeight = worldGroundItemVisualHeight(worldPresentation, mapGroundScaleZoom(map));
      // The shared helper already includes the world PNG master scale. Mark
      // this resolved frame as fixed so the renderer cannot apply that scale
      // a second time while a static map transform is in flight.
      const groundPresentation: RuntimeSpritePresentation & {
        masterScaleEligible?: boolean;
      } = {
        ...worldPresentation,
        baseHeightPx: groundHeight,
        minHeightPx: groundHeight,
        maxHeightPx: null,
        zoomStrength: 0,
        masterScaleEligible: false
      };
      addArtworkSprite(
        spriteLayer,
        texture,
        displayX,
        displayY,
        groundPresentation,
        mapGroundScaleZoom(map),
        alpha
      );
      if (visibility.interactive && globeOpacity >= 0.5) hitBoxes.push({
        drop,
        ...spriteInteractionHitBox({
          x: displayX,
          y: displayY,
          textureWidth: texture.width,
          textureHeight: texture.height,
          zoom: mapGroundScaleZoom(map),
          presentation: groundPresentation,
          paddingPx: 0
        })
      });
    } else {
      const color = droppedItemColor(drop.itemId);
      graphics
        .circle(displayX, displayY + 1, 12)
        .fill({ color: 0x020617, alpha: 0.78 * alpha })
        .stroke({ color: 0xfef3c7, width: 1.5, alpha: 0.92 * alpha })
        .rect(displayX - 7, displayY - 5, 14, 12)
        .fill({ color, alpha: 0.98 * alpha })
        .stroke({ color: 0xfef3c7, width: 1.5, alpha: 0.92 * alpha })
        .circle(displayX, displayY - 6, 4)
        .stroke({ color: 0xfef3c7, width: 2, alpha: 0.92 * alpha });
    }
    if (!artworkKey && visibility.interactive && globeOpacity >= 0.5) hitBoxes.push({
      drop,
      shape: "circle",
      x: displayX,
      y: displayY,
      radius: droppedItemHitRadiusForArtwork(artworkKey)
    });
  }
}

export function droppedItemArtworkKey(
  itemId: DroppedItemSnapshot["itemId"],
  variant: DroppedItemSnapshot["variant"] = null
): string | null {
  // Backpack ground drops (death drops) share the inventory satchel art.
  if ((BACKPACK_DEFINITION_IDS as readonly string[]).includes(itemId)) return "pack";
  if (
    itemId === "frog_legs" ||
    itemId === "frost_frog_legs" ||
    itemId === "poison_frog_legs" ||
    itemId === "desert_toad_legs" ||
    itemId === "crab_meat" ||
    itemId === "ice_crab_meat" ||
    itemId === "sand_crab_meat" ||
    itemId === "mangrove_crab_meat" ||
    itemId === "small_catch" ||
    itemId === "jellyfish_jelly" ||
    itemId === "crawler_flesh" ||
    itemId === "squid_cut" ||
    itemId === "wolf_cut" ||
    itemId === "frost_wolf_cut" ||
    itemId === "dune_wolf_cut" ||
    itemId === "jungle_wolf_cut" ||
    itemId === "bog_wolf_cut" ||
    itemId === "deer_cut" ||
    itemId === "frost_deer_cut" ||
    itemId === "jungle_deer_cut" ||
    itemId === "marsh_deer_cut" ||
    itemId === "sand_deer_cut" ||
    itemId === "hog_cut" ||
    itemId === "woolly_hog_cut" ||
    itemId === "warthog_cut" ||
    itemId === "jungle_hog_cut" ||
    itemId === "mud_hog_cut" ||
    itemId === "javelina_cut" ||
    itemId === "alligator_tail" ||
    itemId === "caiman_tail" ||
    itemId === "crocodile_tail" ||
    itemId === "bear_cut" ||
    itemId === "snow_bear_cut" ||
    itemId === "black_bear_cut" ||
    itemId === "sun_bear_cut" ||
    itemId === "jungle_tapir_cut" ||
    itemId === "jaguar_cut" ||
    itemId === "mandrill_cut" ||
    itemId === "capercaillie_meat" ||
    itemId === "elk_cut" ||
    itemId === "red_squirrel_cut" ||
    itemId === "badger_cut" ||
    itemId === "grey_squirrel_cut" ||
    itemId === "stag_beetle_cut" ||
    itemId === "great_grey_owl_meat" ||
    itemId === "flying_squirrel_cut" ||
    itemId === "plains_bison_cut" ||
    itemId === "prairie_dog_cut" ||
    itemId === "burrowing_owl_meat" ||
    itemId === "giraffe_cut" ||
    itemId === "lioness_cut" ||
    itemId === "spotted_hyena_cut" ||
    itemId === "sitatunga_cut" ||
    itemId === "emperor_dragonfly_cut" ||
    itemId === "mountain_ibex_cut" ||
    itemId === "wild_yak_cut" ||
    itemId === "alpine_marmot_cut" ||
    itemId === "wild_scrub_goat_cut" ||
    itemId === "crested_porcupine_cut" ||
    itemId === "spur_thighed_tortoise_cut" ||
    itemId === "dromedary_cut" ||
    itemId === "fennec_fox_cut" ||
    itemId === "sidewinder_cut" ||
    itemId === "field_hare_cut" ||
    itemId === "arctic_hare_cut" ||
    itemId === "capybara_cut" ||
    itemId === "armadillo_cut" ||
    itemId === "red_fox_cut" ||
    itemId === "wolverine_cut" ||
    itemId === "ostrich_cut" ||
    itemId === "golden_eagle_cut" ||
    itemId === "musk_ox_cut" ||
    itemId === "seal_cut" ||
    itemId === "desert_lion_cut" ||
    itemId === "saiga_cut" ||
    itemId === "wild_horse_cut" ||
    itemId === "steppe_marmot_cut" ||
    itemId === "lemming_cut" ||
    itemId === "snow_goose_meat" ||
    itemId === "mammoth_cut" ||
    itemId === "dire_wolf_cut" ||
    itemId === "drake_cut" ||
    itemId === "dragon_cut" ||
    itemId === "grub_meat" ||
    itemId === "emperor_penguin_meat" ||
    itemId === "peary_caribou_cut" ||
    itemId === "ice_worm_cut" ||
    itemId === "sea_otter_cut" ||
    itemId === "herring_gull_meat" ||
    itemId === "spiny_lobster_tail" ||
    itemId === "hammerhead_shark_steak" ||
    itemId === "manta_ray_wing" ||
    itemId === "humpback_whale_cut" ||
    itemId === "muskellunge_fillet" ||
    itemId === "mute_swan_meat" ||
    itemId === "pike_fillet" ||
    itemId === "snapping_turtle_cut" ||
    itemId === "beaver_cut" ||
    itemId === "otter_cut" ||
    itemId === "salmon_fillet" ||
    itemId === "elemental_ration" ||
    itemId === "scorching_bird_meat" ||
    itemId === "zappy_bird_meat" ||
    itemId === "freezing_bird_meat" ||
    itemId === "field_ration" ||
    itemId === "hearty_ration" ||
    itemId === "xoral_essence"
  ) return "food";
  return itemId === "enchantment_stone" && variant
    ? `enchantment_stone:${variant}`
    : itemId === "enchantment_stone"
      ? null
      : itemId;
}

export function droppedItemHitRadiusForArtwork(artworkKey: string | null): number {
  return DROPPED_ITEM_HIT_RADIUS_PX * (artworkKey ? worldPngMasterScale() : 1);
}

function droppedItemColor(itemId: string): number {
  switch (itemId) {
    case "wood":
      return 0x92400e;
    case "stone":
      return 0x94a3b8;
    case "coal":
      return 0x1f2937;
    case "iron":
      return 0x78716c;
    case "sulfur":
      return 0xfacc15;
    case "slag":
      return 0x57534e;
    case "iron_bar":
      return 0xa8a29e;
    case "food":
      return 0x84cc16;
    case "ore":
      return 0xf59e0b;
    case "water":
      return 0x38bdf8;
    case "leather":
      return 0x92400e;
    case "flax_fiber":
      return 0xa3e635;
    case "cloth":
      return 0xf0d9a6;
    case "giving_berry":
    case "balsam_resin":
      return 0x65a30d;
    case "crude_oil":
      return 0x1f2937;
    case "jellyfish_venom":
      return 0x84cc16;
    case "brood_silk":
      return 0xe5e7eb;
    case "raptor_scale":
      return 0xb45309;
    case "giant_egg":
    case "brood_egg":
    case "clutch_egg":
    case "crawler_egg":
      return 0xfef3c7;
    case "broken_whistle":
    case "bonewrought_blade":
    case "bonewrought_mail":
      return 0xa8a29e;
    case "elder_acorn":
      return 0xa16207;
    case "wyrm_egg":
      return 0xdc2626;
    case "dragon_scale":
      return 0xea580c;
    case "zephyr":
      return 0xfde68a;
    case "refined_oil":
      return 0xf59e0b;
    case "bricks":
      return 0xb4532a;
    case "crystal":
      return 0xa78bfa;
    case "pearl":
      return 0xf1f5f9;
    case "atlas_shrine_shard":
      return 0x22d3ee;
    case "enchantment_stone":
      return 0x10b981;
    default:
      return 0x64748b;
  }
}

function territoryClaimShapesForFlags(
  map: maplibregl.Map,
  flags: FlagSnapshot[]
): TerritoryClaimShape[] {
  return flags.map((flag) => {
    const center = map.project([flag.lon, flag.lat]);
    const ring = createGeodesicCircleScreenRing(
      map,
      { lat: flag.lat, lon: flag.lon },
      flag.claimRadiusM,
      TERRITORY_CIRCLE_SEGMENTS
    );
    const centerPoint: [number, number] = [center.x, center.y];
    const claim: TerritoryClaimShape = {
      id: flag.id,
      ownerId: flagTerritoryPresentationKey(flag),
      center: centerPoint,
      radius: screenRadiusForRing(centerPoint, ring),
      ring
    };
    claim.ownerColor = flagAccessRenderColor(flag);
    return claim;
  });
}

function createGeodesicCircleScreenRing(
  map: maplibregl.Map,
  center: LatLon,
  radiusM: number,
  pointCount: number
): Ring {
  const ring = Array.from({ length: pointCount }, (_, index): [number, number] => {
    const bearingDegrees = (index / pointCount) * 360;
    const point = destinationPoint(center, radiusM, bearingDegrees);
    const projected = map.project([point.lon, point.lat]);
    return [projected.x, projected.y];
  });
  const first = ring[0];
  if (first) {
    ring.push(first);
  }
  return ring;
}

function createGeodesicCircleScreenPoints(
  map: maplibregl.Map,
  center: LatLon,
  radiusM: number,
  minPointCount: number
): ScreenPoint[] {
  // Chords of at most ~6 CSS px at any zoom, so a large circle never shows corners (a fixed 96 gave ~30 px chords).
  const edge = destinationPoint(center, radiusM, 90);
  const c0 = map.project([center.lon, center.lat]);
  const c1 = map.project([edge.lon, edge.lat]);
  const radiusPx = Math.hypot(c1.x - c0.x, c1.y - c0.y);
  const adaptive = Number.isFinite(radiusPx) ? Math.ceil((2 * Math.PI * radiusPx) / 6) : minPointCount;
  const pointCount = Math.min(1024, Math.max(minPointCount, adaptive));
  return Array.from({ length: pointCount }, (_, index) => {
    const bearingDegrees = (index / pointCount) * 360;
    const point = destinationPoint(center, radiusM, bearingDegrees);
    const projected = map.project([point.lon, point.lat]);
    return {
      x: projected.x,
      y: projected.y
    };
  });
}

function flattenScreenPoints(points: ScreenPoint[]): number[] {
  return points.flatMap((point) => [point.x, point.y]);
}

function flattenRing(ring: Ring): number[] {
  return ring.flatMap(([x, y]) => [x, y]);
}

function screenRadiusForRing(center: [number, number], ring: Ring): number {
  return Math.max(...ring.map(([x, y]) => Math.hypot(x - center[0], y - center[1])));
}

function drawPolygonPath(graphics: Graphics, polygon: Ring[]): void {
  for (const command of polygonToPathCommands(polygon)) {
    if (command.type === "moveTo") {
      graphics.moveTo(command.point[0], command.point[1]);
    } else if (command.type === "lineTo") {
      graphics.lineTo(command.point[0], command.point[1]);
    } else {
      graphics.closePath();
    }
  }
}

function createRetainedDynamicEntity(input: {
  entityId: string;
  kind: "player" | "mob";
  name: string;
  local: boolean;
  color: number;
  archetypeKey?: CombatEntitySnapshot["archetypeKey"];
  npcPresentationKey?: string | null;
  companionSpecies?: CompanionSpeciesId | null;
  appearanceVariant?: NonNullable<CombatEntitySnapshot["appearanceVariant"]>;
  mobTextures: MobTextures;
  playerAppearanceTextures: PixiTextureCache;
  bossAppearanceTextures?: PixiTextureCache;
  firstPresentedAtMs?: number;
}): RetainedDynamicEntity {
  const container = new Container();
  const attackRange = new Graphics();
  attackRange.visible = false;
  const protectionGlow = new Graphics();
  protectionGlow.visible = false;
  const rootEffect = new Graphics();
  rootEffect.visible = false;
  const statusIcons = new Container();
  statusIcons.position.set(0, 2 + HARMFUL_STATUS_TILE_SIZE_PX / 2);
  const artworkKey = input.kind === "mob"
    ? mobArtworkKey(input.archetypeKey ?? null, input.npcPresentationKey)
    : null;
  const appearanceVariant = input.appearanceVariant ?? "normal";
  const bossAppearance = input.kind === "mob" && appearanceVariant === "normal"
    ? bossAppearanceForArchetype(
        DEFAULT_BOSS_APPEARANCE_CATALOG,
        input.archetypeKey ?? null
      )
    : null;
  const presentation = input.kind === "player"
    ? SPRITE_PRESENTATION.player
    : input.companionSpecies
      ? SPRITE_PRESENTATION[petPresentationKey(input.companionSpecies)]
    : bossAppearance
      ? bossAppearance.presentation
    : artworkKey
      ? MOB_SPRITE_PRESENTATION[artworkKey]
      : MOB_SPRITE_PRESENTATION.generic;
  const playerRenderer = input.kind === "player"
    ? new PlayerRenderer({
        local: input.local,
        color: input.color,
        textureLoader: input.playerAppearanceTextures,
        diagnostic: (message, detail) => {
          console.warn(message, detail);
        }
      })
    : null;
  // Jacket B rig: sits in the player artwork (feet at the origin, inherits lunge, tint and scale).
  const jacketRig = playerRenderer ? createJacketRig(input.entityId, OVERLAY_RENDERER_RESOLUTION) : null;
  if (jacketRig && playerRenderer) playerRenderer.root.addChild(jacketRig.root);
  const bossRenderer = bossAppearance && input.bossAppearanceTextures
    ? new BossRenderer({
        bossId: bossAppearance.bossId,
        textureLoader: input.bossAppearanceTextures,
        diagnostic: (message, detail) => console.warn(message, detail)
      })
    : null;
  const artwork = playerRenderer?.root ?? bossRenderer?.root ??
    createMobSprite(
      input.archetypeKey ?? null,
      artworkKey,
      input.color,
      input.mobTextures,
      input.companionSpecies
    );
  const baseArtworkHeightPx =
    playerRenderer?.baseHeightPx ??
    bossRenderer?.baseHeightPx ??
    (input.kind === "mob" && artworkKey === null ? 50 : presentation.baseHeightPx);
  const healthBar = shouldAllocateOverheadHealthBar(input.kind, input.local) ? new Graphics() : null;
  const healthBarState = healthBar ? new HealthBarTransitionState() : null;
  if (healthBar && healthBarState) drawHealthBar(healthBar, healthBarState, input.kind, "friendly", 0, 0, 1, 1);
  // Players always show a name label; mob label, speech, root timer and badge text are created on first use.
  const label = input.kind === "player" ? createPlayerNameLabel(0, -28, input.name) : null;
  if (label) label.visible = !input.local;
  // Water travel: the raft sits behind the body, centred on the feet (container origin).
  const raft = input.kind === "player" ? new PlayerRaft() : null;
  container.addChild(attackRange, protectionGlow);
  if (raft) container.addChild(raft.root);
  container.addChild(artwork, rootEffect, statusIcons);
  if (healthBar) container.addChild(healthBar);
  const attackBadge = new Container();
  const attackBadgeGraphics = new Graphics();
  attackBadge.addChild(attackBadgeGraphics);
  attackBadge.visible = false;
  if (label) container.addChild(label);
  container.addChild(attackBadge);
  return {
    entityId: input.entityId,
    kind: input.kind,
    archetypeKey: input.archetypeKey ?? null,
    companionSpecies: input.companionSpecies ?? null,
    appearanceVariant,
    container,
    artwork,
    presentation,
    baseArtworkHeightPx,
    label,
    aiLabel: null,
    attackBadge,
    attackBadgeGraphics,
    attackBadgeText: null,
    attackBadgeKey: "",
    healthBar,
    healthBarState,
    healthBarFade: 0,
    healthBarFadeAtMs: null,
    healthCritical: false,
    healthBarVariant: input.kind,
    healthBarTone: "friendly",
    attackRange,
    protectionGlow,
    rootEffect,
    rootTimer: null,
    statusIcons,
    statusIconIds: [],
    playerPosition: null,
    mobPosition: null,
    companionMotion: null,
    mobTrack: null,
    mobTrackSource: null,
    currentHealth: null,
    maxHealth: null,
    ward: null,
    name: input.name,
    local: input.local,
    color: input.color,
    playerRenderer,
    jacketRig,
    bossRenderer,
    raft,
    appearanceRevision: -1,
    visualArtworkHeightPx: 0,
    firstPresentedAtMs: input.firstPresentedAtMs ?? 0,
    walkMotion: createPlayerWalkMotionState(),
    gathering: createPlayerGatheringState(),
    swingSeq: 0
  };
}

type OverheadHealthBarCombatState = Pick<
  CombatEntitySnapshot,
  "entityId" | "currentHealth" | "maxHealth" | "targetEntityId" | "activityState"
> & Partial<Pick<CombatEntitySnapshot, "undead">>;

/**
 * Share of a mob texture's width the creature actually covers (frames carry transparent padding): the hit box width
 * for rectangle hit geometry, else the whole frame.
 */
function mobVisibleWidthShare(presentation: { hitGeometry?: { shape: string; width?: number } } | null | undefined): number {
  const hit = presentation?.hitGeometry;
  return hit?.shape === "rectangle" && typeof hit.width === "number" && hit.width > 0 ? Math.min(1, hit.width) : 1;
}

function shouldAllocateOverheadHealthBar(kind: "player" | "mob", local: boolean): boolean {
  return !(kind === "player" && local);
}

const HEALTH_BAR_FADE_IN_MS = 120;
const HEALTH_BAR_FADE_OUT_MS = 100;

export function shouldRenderOverheadHealthBar(
  kind: "player" | "mob",
  local: boolean,
  combat: OverheadHealthBarCombatState | null = null,
  healthBarEntityIds: ReadonlySet<string> = new Set(),
  localPlayerId: string | null = null
): boolean {
  if (kind === "player" && local) return false;
  if (!combat) return false;
  // Mob bars follow the local player: selected, attacked by them, or attacking them.
  // Clicking off an idle mob closes its bar even if it is damaged or fighting someone else.
  // Revenant Metal undead never heal, so everyone always sees how much of them is left.
  if (kind === "mob") {
    if (combat.undead) return true;
    return healthBarEntityIds.has(combat.entityId) ||
      (localPlayerId !== null && combat.targetEntityId === localPlayerId);
  }
  return combat.currentHealth < combat.maxHealth ||
    combat.targetEntityId !== null ||
    combat.activityState === "chasing" ||
    combat.activityState === "attacking" ||
    healthBarEntityIds.has(combat.entityId);
}

export function shouldRenderMilitaryGroupHealthBar(
  group: Pick<
    MilitaryUnitGroupSnapshot,
    "groupId" | "currentHp" | "maxHp" | "targetFlagId" | "nextFireAt"
  >,
  selectedGroupId: string | null = null
): boolean {
  return group.currentHp < group.maxHp ||
    group.targetFlagId !== null ||
    group.nextFireAt !== null ||
    group.groupId === selectedGroupId;
}

const groupAlphaFilters = new WeakMap<Container, AlphaFilter>();
// Bumped whenever a group-alpha filter changes; filter uniforms do not dirty Pixi's render group.
let groupAlphaVersion = 0;

/**
 * Fades a layered sprite (player body, head, hair, gear; pets) as one image. Pixi multiplies
 * container alpha into every child, so lower layers would show through upper ones; a single
 * AlphaFilter composites the group first. At full opacity the filter is removed (no cost).
 */
export function applyGroupAlpha(container: Container, alpha: number): void {
  const clamped = Math.max(0, Math.min(1, alpha));
  container.alpha = 1;
  if (clamped >= 0.999) {
    if (container.filters) {
      container.filters = null;
      groupAlphaVersion += 1;
    }
    return;
  }
  let filter = groupAlphaFilters.get(container);
  if (!filter) {
    filter = new AlphaFilter({ alpha: clamped });
    groupAlphaFilters.set(container, filter);
  }
  if (filter.alpha !== clamped) groupAlphaVersion += 1;
  filter.alpha = clamped;
  if (!container.filters || (container.filters as readonly unknown[])[0] !== filter) container.filters = [filter];
}

export function playerInvisibilityPresentation(
  combat: CombatEntitySnapshot | null,
  local: boolean,
  serverNow: number
): { visible: boolean; pickable: boolean; alpha: number } {
  const invisible = (combat?.invisibleUntil ?? 0) > serverNow;
  if (!invisible) return { visible: true, pickable: true, alpha: 1 };
  return local
    ? { visible: true, pickable: true, alpha: 0.62 }
    : { visible: false, pickable: false, alpha: 0 };
}

/** Status box: square dark rounded tile, subtle border, icon centered. */
export const HARMFUL_STATUS_TILE_SIZE_PX = 20;
export const HARMFUL_STATUS_ICON_SIZE_PX = 14;
const HARMFUL_STATUS_TILE_GAP_PX = 3;
const HARMFUL_STATUS_TILE_RADIUS_PX = 4;
export const HARMFUL_STATUS_TILES_PER_ROW = 6;
const HARMFUL_STATUS_TILE_FILL = 0x0f172a;
const HARMFUL_STATUS_TILE_BORDER = 0x94a3b8;
const HARMFUL_STATUS_ORDER = [
  "poison",
  "gloom",
  "burning",
  "storm",
  "ice_slow",
  "quarry_sign",
  "exposed",
  "weakened",
  "whetted_defense",
  "whetted_attack",
  "fleet_slow",
  "immobilized",
  "vengeance_mark",
  "stunned"
] as const satisfies readonly HarmfulStatusId[];

export function harmfulStatusIconLayout(
  activeStatusIds: readonly HarmfulStatusId[]
): readonly Readonly<{ statusId: HarmfulStatusId; x: number; y: number }>[] {
  const ordered = HARMFUL_STATUS_ORDER.filter((statusId) =>
    activeStatusIds.includes(statusId)
  );
  const step = HARMFUL_STATUS_TILE_SIZE_PX + HARMFUL_STATUS_TILE_GAP_PX;
  return ordered.map((statusId, index) => {
    const row = Math.floor(index / HARMFUL_STATUS_TILES_PER_ROW);
    const rowStart = row * HARMFUL_STATUS_TILES_PER_ROW;
    const inRow = Math.min(HARMFUL_STATUS_TILES_PER_ROW, ordered.length - rowStart);
    return {
      statusId,
      x: (index - rowStart - (inRow - 1) / 2) * step,
      y: row * step
    };
  });
}

function updateHarmfulStatusIcons(
  rendered: RetainedDynamicEntity,
  activeStatusIds: readonly HarmfulStatusId[],
  textures: HarmfulStatusTextures
): void {
  const layout = harmfulStatusIconLayout(activeStatusIds);
  if (
    layout.length === rendered.statusIconIds.length &&
    layout.every((entry, index) => entry.statusId === rendered.statusIconIds[index])
  ) return;
  for (const child of rendered.statusIcons.removeChildren()) child.destroy();
  rendered.statusIconIds = layout.map((entry) => entry.statusId);
  for (const entry of layout) {
    const tile = new Container();
    tile.position.set(entry.x, entry.y);
    tile.label = `${harmfulStatusDisplayName(entry.statusId)} status`;
    const half = HARMFUL_STATUS_TILE_SIZE_PX / 2;
    const box = new Graphics()
      .roundRect(-half, -half, HARMFUL_STATUS_TILE_SIZE_PX, HARMFUL_STATUS_TILE_SIZE_PX, HARMFUL_STATUS_TILE_RADIUS_PX)
      .fill({ color: HARMFUL_STATUS_TILE_FILL, alpha: 0.88 })
      .stroke({ width: 1, color: HARMFUL_STATUS_TILE_BORDER, alpha: 0.55, alignment: 1 });
    const sprite = new Sprite(textures[entry.statusId]);
    sprite.anchor.set(0.5);
    sprite.width = HARMFUL_STATUS_ICON_SIZE_PX;
    sprite.height = HARMFUL_STATUS_ICON_SIZE_PX;
    tile.addChild(box, sprite);
    rendered.statusIcons.addChild(tile);
  }
}

/** Glow tint per mob buff: warm for aggression, cool for defence. */
const MOB_BUFF_GLOW_COLORS: Readonly<Record<MobBuffKind, number>> = {
  shell: 0x93c5fd,
  enraged: 0xf87171,
  howl: 0xfbbf24,
  war_roar: 0xfbbf24,
  reassembling: 0xd6d3d1,
  backstab: 0xc084fc,
  death_roll: 0x4ade80,
  awake: 0xfbbf24,
  staggered: 0xfde68a,
  warded: 0xfdba74
};

export type MobBuffPresentation = Readonly<{
  kind: MobBuffKind;
  remainingMs: number;
  timerText: string;
}>;

/** The first live mob buff (shell, enrage, howl...) as a glow tint plus a short label. */
export function mobBuffPresentation(entity: CombatEntitySnapshot, nowMs: number): MobBuffPresentation | null {
  const buff = entity.mobBuffs?.find((candidate) => candidate.endsAt > nowMs);
  if (!buff) return null;
  const remainingMs = buff.endsAt - nowMs;
  const name = MOB_BUFF_DISPLAY_NAMES[buff.kind];
  return {
    kind: buff.kind,
    remainingMs,
    // Open-ended buffs (enrage, primed death roll) show the name alone.
    timerText: remainingMs > 60_000 ? name : `${name} ${(remainingMs / 1_000).toFixed(1)}s`
  };
}

/** ms left on a live buff of `kind`, or -1. */
export function mobBuffRemainingMs(entity: CombatEntitySnapshot, kind: MobBuffKind, nowMs: number): number {
  const buffs = entity.mobBuffs;
  if (!buffs) return -1;
  for (let index = 0; index < buffs.length; index += 1) {
    if (buffs[index]!.kind === kind && buffs[index]!.endsAt > nowMs) return buffs[index]!.endsAt - nowMs;
  }
  return -1;
}

export type RootedControlEffectPresentation = Readonly<{
  remainingMs: number;
  timerText: string;
}>;

/** Flag-arrival protection shows as a soft white glow around the player until it ends. */
export function playerProtectionGlowPresentation(
  combat: CombatEntitySnapshot | null,
  nowMs: number
): Readonly<{ remainingMs: number }> | null {
  const until = combat?.flagArrivalProtectionUntil ?? 0;
  return until > nowMs ? { remainingMs: until - nowMs } : null;
}

/** Final seconds of protection blink so players can see it is about to drop. */
export const PROTECTION_GLOW_WARNING_MS = 3_000;

function drawProtectionGlow(
  graphics: Graphics,
  artworkHeightPx: number,
  remainingMs: number,
  frameNowMs: number,
  reducedMotion: boolean,
  tint = 0xfffbeb
): void {
  const pulse = reducedMotion ? 0.5 : (Math.sin(frameNowMs / 420) + 1) / 2;
  const ending = remainingMs < PROTECTION_GLOW_WARNING_MS;
  const fade = !ending ? 1 : reducedMotion ? 0.55 : 0.3 + 0.7 * Math.abs(Math.sin(frameNowMs / 150));
  const height = Math.max(24, artworkHeightPx);
  const centerY = -height * 0.46;
  const radiusX = height * 0.36;
  const radiusY = height * 0.56;
  graphics.clear();
  // Layered, low-alpha ellipses read as a soft halo without washing the sprite out.
  for (let layer = 0; layer < 4; layer += 1) {
    const spread = 1 + layer * 0.14 + pulse * 0.04;
    graphics
      .ellipse(0, centerY, radiusX * spread, radiusY * spread)
      .fill({ color: tint, alpha: (0.17 - layer * 0.035) * fade });
  }
  graphics
    .ellipse(0, 1, radiusX * 1.15, Math.max(4, height * 0.09))
    .stroke({ color: tint === 0xfffbeb ? 0xffffff : tint, width: 2, alpha: (0.6 + pulse * 0.25) * fade });
}

export function rootedControlEffectPresentation(
  entity: CombatEntitySnapshot,
  nowMs: number
): RootedControlEffectPresentation | null {
  const rooted = entity.controlEffects?.find((effect) => effect.kind === "rooted");
  if (!rooted || rooted.endsAt <= nowMs) return null;
  const remainingMs = rooted.endsAt - nowMs;
  return {
    remainingMs,
    timerText: `Rooted ${(remainingMs / 1_000).toFixed(1)}s`
  };
}

function drawBossAttackRange(
  graphics: Graphics,
  map: maplibregl.Map,
  position: LatLon,
  entity: CombatEntitySnapshot | null
): void {
  clearGraphicsIfDrawn(graphics);
  const attackRangeM = entity?.attackRangeM ?? 0;
  const visible =
    entity?.boss === true &&
    entity.bossEventState === "active" &&
    attackRangeM > 0;
  graphics.visible = visible;
  if (!visible) return;

  const center = map.project([position.lon, position.lat]);
  const ring = createGeodesicCircleScreenRing(map, position, attackRangeM, 64);
  const first = ring[0];
  if (!first) return;
  graphics.moveTo(first[0] - center.x, first[1] - center.y);
  for (const point of ring.slice(1)) {
    graphics.lineTo(point[0] - center.x, point[1] - center.y);
  }
  graphics.closePath()
    .fill({ color: 0xef4444, alpha: 0.1 })
    .stroke({ color: 0xf87171, width: 2, alpha: 0.62 });
}

/** Screen-space shape for a telegraph, written into `out` (one shared instance, no allocation of its own). */
function projectTelegraphShape(
  map: maplibregl.Map,
  geometry: BossCastSnapshot["geometry"],
  out: TelegraphScreenShape
): void {
  if (geometry.kind === "circle") {
    const center = map.project([geometry.center.lon, geometry.center.lat]);
    const edgePoint = wgs84DestinationPoint(geometry.center, geometry.radiusM, 90);
    const edge = map.project([edgePoint.lon, edgePoint.lat]);
    out.kind = "circle";
    out.ox = center.x;
    out.oy = center.y;
    out.radius = Math.hypot(edge.x - center.x, edge.y - center.y);
    return;
  }
  const origin = map.project([geometry.origin.lon, geometry.origin.lat]);
  const reachM = geometry.kind === "cone" ? geometry.rangeM : geometry.lengthM;
  const tipPoint = wgs84DestinationPoint(geometry.origin, reachM, geometry.facingDegrees);
  const tip = map.project([tipPoint.lon, tipPoint.lat]);
  out.ox = origin.x;
  out.oy = origin.y;
  out.reach = Math.hypot(tip.x - origin.x, tip.y - origin.y);
  out.dir = Math.atan2(tip.y - origin.y, tip.x - origin.x);
  if (geometry.kind === "cone") {
    out.kind = "cone";
    out.halfAngle = geometry.angleDegrees / 2 * Math.PI / 180;
    return;
  }
  out.kind = "line";
  // Web Mercator is conformal, so the lane's px-per-metre across equals the one along it.
  out.halfWidth = out.reach * geometry.widthM / 2 / Math.max(1, geometry.lengthM);
}

function drawRootEffect(
  graphics: Graphics,
  frameNowMs: number,
  reducedMotion: boolean
): void {
  const pulse = reducedMotion ? 0.5 : (Math.sin(frameNowMs / 135) + 1) / 2;
  const radius = 19 + pulse * 3;
  graphics.clear()
    .ellipse(0, 1, radius, 7 + pulse)
    .fill({ color: 0x7f1d1d, alpha: 0.16 })
    .stroke({ color: 0xb45309, width: 2, alpha: 0.9 });
  for (let index = 0; index < 6; index += 1) {
    const angle = index / 6 * Math.PI * 2;
    const innerX = Math.cos(angle) * 8;
    const innerY = Math.sin(angle) * 3;
    const outerX = Math.cos(angle) * radius;
    const outerY = Math.sin(angle) * 7 - 2 - pulse * 2;
    graphics
      .moveTo(innerX, innerY)
      .bezierCurveTo(
        innerX * 1.4,
        innerY - 5 - pulse * 2,
        outerX * 0.72,
        outerY + 5,
        outerX,
        outerY
      )
      .stroke({ color: 0x92400e, width: 2.5, alpha: 0.95 });
  }
}

export function mobAiPresentationText(
  entity: CombatEntitySnapshot,
  nowMs: number
): string | null {
  if (entity.ambientSpeech && entity.ambientSpeech.expiresAt > nowMs) {
    return entity.ambientSpeech.text;
  }
  return null;
}

export function createMobSprite(
  archetypeKey: CombatEntitySnapshot["archetypeKey"],
  artworkKey: MobArtworkKey | null,
  color: number,
  textures: MobTextures,
  companionSpecies?: CompanionSpeciesId | null
): Container {
  const sprite = new Container();
  if (companionSpecies) {
    const presentation = SPRITE_PRESENTATION[petPresentationKey(companionSpecies)];
    const image = new Sprite(textures[petTextureKey(companionSpecies)]);
    image.anchor.set(presentation.anchorX, presentation.anchorY);
    image.scale.set(textureScaleForHeight(presentation.baseHeightPx, image.texture.height));
    sprite.addChild(image);
    return sprite;
  }
  if (artworkKey) {
    const presentation = MOB_SPRITE_PRESENTATION[artworkKey];
    const image = new Sprite(textures[artworkKey]);
    if (artworkKey === "grandmasterClone") image.tint = SHADOW_CLONE_TINT;
    image.anchor.set(presentation.anchorX, presentation.anchorY);
    image.scale.set(textureScaleForHeight(presentation.baseHeightPx, image.texture.height));
    sprite.addChild(image);
    return sprite;
  }
  const descriptor = archetypeKey ? mobVisualDescriptor(archetypeKey) : null;
  if (descriptor?.kind === "placeholder_square") {
    const half = descriptor.sizePx / 2;
    sprite.addChild(new Graphics()
      .rect(-half, -half, descriptor.sizePx, descriptor.sizePx)
      .fill({ color: descriptor.colorNumber })
      .stroke({ color: 0x111827, width: 2 }));
    const letter = new Text({
      text: descriptor.label,
      resolution: OVERLAY_RENDER_RESOLUTION,
      style: { fill: 0xffffff, fontFamily: "system-ui, sans-serif", fontSize: Math.round(descriptor.sizePx * 0.6), fontWeight: "800" }
    });
    letter.anchor.set(0.5);
    sprite.addChild(letter);
    return sprite;
  }
  if (descriptor?.kind === "silhouette" && descriptor.silhouette === "training_dummy") {
    const dummy = new Graphics()
      .rect(-4, -16, 8, 31)
      .fill({ color: 0x92400e })
      .circle(0, -18, 8)
      .fill({ color: descriptor.primaryColorNumber })
      .moveTo(-15, -6)
      .lineTo(15, -6)
      .stroke({ color: 0xfef3c7, width: 4 })
      .moveTo(-10, 19)
      .lineTo(10, 19)
      .stroke({ color: 0x451a03, width: 5 });
    sprite.addChild(dummy);
    return sprite;
  }
  if (descriptor?.kind === "silhouette" && descriptor.silhouette === "orc_brute") {
    sprite.addChild(new Graphics()
      .moveTo(-22, -8).quadraticCurveTo(-16, -29, 0, -29)
      .quadraticCurveTo(16, -29, 22, -8).lineTo(17, 8).lineTo(-17, 8).closePath()
      .fill({ color: descriptor.primaryColorNumber }).stroke({ color: 0x17230b, width: 3 })
      .poly([-14, -3, -7, 0, -14, 4], true).poly([14, -3, 7, 0, 14, 4], true)
      .fill({ color: 0xfef3c7 })
      .moveTo(-25, 6).quadraticCurveTo(0, -4, 25, 6).lineTo(29, 25).lineTo(-29, 25)
      .closePath().fill({ color: 0x365314 }).stroke({ color: 0x17230b, width: 3 })
      .moveTo(20, -16).lineTo(20, 23).moveTo(20, -14).lineTo(28, -19)
      .stroke({ color: 0x713f12, width: 6 }));
    return sprite;
  }
  const unknown = new Graphics()
    .circle(0, 0, 16)
    .fill({ color })
    .stroke({ color: 0x111827, width: 2 });
  sprite.addChild(unknown);
  return sprite;
}

/** The Grandmaster's shadow clones are his own art, drawn dark. */
export const SHADOW_CLONE_TINT = 0x3b3350;

export function shouldRecreateRetainedMobArtwork(
  rendered: Readonly<Pick<
    RetainedDynamicEntity,
    "kind" | "archetypeKey" | "appearanceVariant" | "companionSpecies"
  >>,
  entity: Pick<CombatEntitySnapshot, "archetypeKey" | "appearanceVariant" | "companion">
): boolean {
  return rendered.kind !== "mob" ||
    rendered.archetypeKey !== entity.archetypeKey ||
    rendered.appearanceVariant !== (entity.appearanceVariant ?? "normal") ||
    rendered.companionSpecies !== (entity.companion?.species ?? null);
}

function drawHealthBar(
  graphics: Graphics,
  transition: HealthBarTransitionState,
  kind: WorldHealthBarVariant,
  tone: WorldHealthBarTone,
  criticalFrameEmphasis: number,
  ward: number,
  currentHealth: number,
  maxHealth: number
): void {
  const metrics = WORLD_HEALTH_BAR_METRICS[kind];
  const left = -metrics.width / 2;
  const trackLeft = left + metrics.inset;
  const trackTop = metrics.inset;
  const trackWidth = metrics.width - metrics.inset * 2;
  const trackHeight = metrics.height - metrics.inset * 2;
  const frameColor = criticalFrameEmphasis > 0
    ? HEALTH_BAR_COLORS.criticalFrame
    : HEALTH_BAR_COLORS.gildedRim;
  HEALTH_BAR_FRAME_STROKE.color = frameColor;
  HEALTH_BAR_FRAME_STROKE.alpha = criticalFrameEmphasis > 0 ? criticalFrameEmphasis : 0.9;
  const fillTone = WORLD_HEALTH_BAR_TONES[tone];
  HEALTH_BAR_FILL_BOTTOM.color = fillTone.bottom;
  HEALTH_BAR_FILL_TOP.color = fillTone.top;
  HEALTH_BAR_FILL_HIGHLIGHT.color = fillTone.highlight;

  graphics
    .clear()
    .poly(WORLD_HEALTH_BAR_FRAME_POINTS[kind], true)
    .fill(HEALTH_BAR_FRAME_FILL)
    .stroke(HEALTH_BAR_FRAME_STROKE)
    .roundRect(trackLeft, trackTop, trackWidth, trackHeight, 0.75)
    .fill(HEALTH_BAR_TRACK_FILL);

  const trailWidth = visibleHealthWidth(trackWidth, transition.currentDamageTrailRatio());
  if (transition.isDamageTrailActive() && trailWidth > 0) {
    graphics
      .roundRect(trackLeft, trackTop, trailWidth, trackHeight, 0.6)
      .fill(HEALTH_BAR_DAMAGE_TRAIL_FILL);
  }

  const fillWidth = visibleHealthWidth(trackWidth, transition.currentFillRatio());
  if (fillWidth > 0) {
    graphics
      .roundRect(trackLeft, trackTop, fillWidth, trackHeight, 0.6)
      .fill(HEALTH_BAR_FILL_BOTTOM)
      .rect(trackLeft, trackTop, fillWidth, trackHeight * 0.56)
      .fill(HEALTH_BAR_FILL_TOP)
      .rect(trackLeft, trackTop, fillWidth, Math.min(0.75, trackHeight * 0.24))
      .fill(HEALTH_BAR_FILL_HIGHLIGHT);
  }
  const wardPresentation = wardBarPresentation(currentHealth, maxHealth, ward);
  const wardWidth = visibleHealthWidth(trackWidth, wardPresentation.widthRatio);
  if (wardWidth > 0) {
    const wardLeft = trackLeft + trackWidth * wardPresentation.leftRatio;
    graphics
      .roundRect(wardLeft, trackTop, wardWidth, trackHeight, 0.6)
      .fill(HEALTH_BAR_WARD_BOTTOM)
      .rect(wardLeft, trackTop, wardWidth, trackHeight * 0.56)
      .fill(HEALTH_BAR_WARD_TOP)
      .rect(wardLeft, trackTop, wardWidth, Math.min(0.75, trackHeight * 0.24))
      .fill(HEALTH_BAR_WARD_HIGHLIGHT);
  }
}

function visibleHealthWidth(trackWidth: number, ratio: number): number {
  return ratio <= 0 ? 0 : Math.min(trackWidth, Math.max(1, trackWidth * ratio));
}

const HEALTH_BAR_FRAME_FILL = { color: HEALTH_BAR_COLORS.frame, alpha: 0.98 };
const HEALTH_BAR_FRAME_STROKE: { color: number; width: number; alpha: number } = {
  color: HEALTH_BAR_COLORS.frameBorder,
  width: 1,
  alpha: 0.88
};
const HEALTH_BAR_TRACK_FILL = { color: HEALTH_BAR_COLORS.track, alpha: 1 };
const HEALTH_BAR_DAMAGE_TRAIL_FILL = {
  color: HEALTH_BAR_COLORS.damageTrail,
  alpha: 0.92
};
const HEALTH_BAR_FILL_BOTTOM: { color: number; alpha: number } = { color: HEALTH_BAR_COLORS.fillBottom, alpha: 1 };
const HEALTH_BAR_FILL_TOP: { color: number; alpha: number } = { color: HEALTH_BAR_COLORS.fillTop, alpha: 1 };
const HEALTH_BAR_FILL_HIGHLIGHT: { color: number; alpha: number } = {
  color: HEALTH_BAR_COLORS.fillHighlight,
  alpha: 0.48
};
const HEALTH_BAR_WARD_BOTTOM = { color: 0x2563eb, alpha: 1 };
const HEALTH_BAR_WARD_TOP = { color: 0x60a5fa, alpha: 1 };
const HEALTH_BAR_WARD_HIGHLIGHT = { color: 0xbfdbfe, alpha: 0.62 };

function destinationPoint(center: LatLon, distanceM: number, bearingDegrees: number): LatLon {
  return wgs84DestinationPoint(center, distanceM, bearingDegrees);
}

function ensureRootTimer(rendered: RetainedDynamicEntity): Text {
  if (rendered.rootTimer) return rendered.rootTimer;
  const rootTimer = new Text({
    text: "",
    resolution: OVERLAY_RENDER_RESOLUTION,
    roundPixels: true,
    style: {
      fill: 0xfef2f2,
      fontFamily: "system-ui, sans-serif",
      fontSize: 12,
      fontWeight: "800",
      stroke: { color: 0x450a0a, width: 3 }
    }
  });
  rootTimer.anchor.set(0.5, 0);
  rootTimer.position.set(0, 11);
  rendered.container.addChildAt(rootTimer, rendered.container.getChildIndex(rendered.statusIcons));
  rendered.rootTimer = rootTimer;
  return rootTimer;
}

function ensureNameLabel(rendered: RetainedDynamicEntity): Text {
  if (rendered.label) return rendered.label;
  const label = createPlayerNameLabel(0, -28, rendered.name);
  label.visible = false;
  const before = rendered.aiLabel ?? rendered.attackBadge;
  rendered.container.addChildAt(label, rendered.container.getChildIndex(before));
  rendered.label = label;
  return label;
}

function ensureAiLabel(rendered: RetainedDynamicEntity): Text {
  if (rendered.aiLabel) return rendered.aiLabel;
  const aiLabel = new Text({
    text: "",
    style: {
      fill: 0xfef3c7,
      fontFamily: "system-ui, sans-serif",
      fontSize: 12,
      fontWeight: "700",
      align: "center",
      wordWrap: true,
      wordWrapWidth: 220,
      stroke: { color: 0x111827, width: 3 }
    }
  });
  aiLabel.anchor.set(0.5, 1);
  aiLabel.visible = false;
  rendered.container.addChildAt(aiLabel, rendered.container.getChildIndex(rendered.attackBadge));
  rendered.aiLabel = aiLabel;
  return aiLabel;
}

function ensureAttackBadgeText(rendered: RetainedDynamicEntity): Text {
  if (rendered.attackBadgeText) return rendered.attackBadgeText;
  const text = new Text({
    text: "",
    resolution: OVERLAY_RENDER_RESOLUTION,
    style: {
      fill: 0xfafaf9,
      fontFamily: "system-ui, sans-serif",
      fontSize: 13,
      fontWeight: "800",
      stroke: { color: 0x0c0a09, width: 3 }
    }
  });
  text.anchor.set(0.5);
  rendered.attackBadge.addChild(text);
  rendered.attackBadgeText = text;
  return text;
}

function createPlayerNameLabel(x: number, y: number, username: string): Text {
  const label = new Text({
    text: username,
    resolution: OVERLAY_RENDER_RESOLUTION,
    roundPixels: true,
    style: {
      fill: 0xe0f2fe,
      fontFamily: "Inter, Arial, sans-serif",
      fontSize: 13,
      fontWeight: "700",
      stroke: {
        color: 0x020617,
        width: 3
      }
    }
  });
  label.anchor.set(0.5, 1);
  label.position.set(x, y);
  return label;
}

function drawCollectibleMarker(
  spriteLayer: Container,
  graphics: Graphics,
  x: number,
  y: number,
  collectible: CollectibleNode,
  textures: WorldTextures,
  currentZoom: number,
  /** Biome tree art for a Giving Tree or Elder Fern once loaded; same framing as tree.png. */
  treeTexture: Texture | null = null
): void {
  const resourceType = collectible.type;
  if (collectible.repeatableNodeType !== undefined) {
    const depleted = collectible.repeatableState === "depleted";
    const artworkKey = collectibleArtworkKey(collectible);
    if (artworkKey) {
      addArtworkSprite(
        spriteLayer,
        textures[artworkKey],
        x,
        y,
        WORLD_SPRITE_PRESENTATION[artworkKey],
        currentZoom,
        depleted ? 0.48 : 1
      );
    } else {
      const style = collectibleStyle(resourceType);
      graphics
        .circle(x, y, 15)
        .fill({ color: style.fill, alpha: depleted ? 0.28 : 0.9 })
        .stroke({ color: style.stroke, width: 2, alpha: 0.96 });
      graphics
        .poly([x, y - 10, x + 10, y, x, y + 10, x - 10, y], true)
        .fill({ color: style.fill, alpha: depleted ? 0.22 : 0.96 })
        .stroke({ color: style.stroke, width: 2, alpha: 0.96 });
    }
    if (collectible.repeatableOwnerPlayerId && collectible.repeatableAccessMode) {
      const markerY = artworkKey
        ? y - spriteHeightForZoom(
          currentZoom,
          SPRITE_BASE_ZOOM,
          WORLD_SPRITE_PRESENTATION[artworkKey]
        ) * WORLD_SPRITE_PRESENTATION[artworkKey].anchorY - 10
        : y - 25;
      if (collectible.repeatableAccessMode === "public") {
        graphics
          .poly([
            x - 3, markerY - 8,
            x + 3, markerY - 8,
            x + 3, markerY - 2,
            x + 8, markerY - 2,
            x, markerY + 8,
            x - 8, markerY - 2,
            x - 3, markerY - 2
          ], true)
          .fill({ color: 0x22c55e, alpha: 1 })
          .stroke({ color: 0x052e16, width: 2, alpha: 0.96 });
      } else {
        graphics
          .circle(x, markerY, 7)
          .fill({ color: 0xdc2626, alpha: 1 })
          .stroke({ color: 0x450a0a, width: 2, alpha: 0.96 });
      }
    }
    if (depleted) {
      graphics
        .moveTo(x - 11, y - 12)
        .lineTo(x + 11, y + 3)
        .moveTo(x + 11, y - 12)
        .lineTo(x - 11, y + 3)
        .stroke({ color: 0xdc2626, width: 3, alpha: 1 });
    }
    return;
  }
  const artworkKey = collectibleArtworkKey(collectible);
  if (artworkKey) {
    addArtworkSprite(
      spriteLayer,
      treeTexture ?? textures[artworkKey],
      x,
      y,
      WORLD_SPRITE_PRESENTATION[artworkKey],
      currentZoom
    );
    return;
  }
  const style = collectibleStyle(resourceType);
  graphics
    .circle(x, y, 13)
    .fill({ color: style.fill, alpha: 0.18 })
    .stroke({ color: style.stroke, width: 1, alpha: 0.56 });
  switch (resourceType) {
    case "stone":
      graphics.poly([x, y - 9, x + 9, y, x, y + 9, x - 9, y], true);
      break;
    case "food":
      graphics.circle(x, y, 8);
      break;
    case "ore":
      graphics.poly(
        [x - 8, y - 5, x - 2, y - 10, x + 8, y - 4, x + 6, y + 7, x - 6, y + 8],
        true
      );
      break;
    case "water":
      graphics.circle(x, y, 8);
      break;
    case "flax_fiber":
      graphics
        .moveTo(x, y + 9)
        .lineTo(x - 1, y - 10)
        .stroke({ color: 0x365314, width: 2.4, alpha: 0.96 });
      graphics
        .poly([x - 1, y - 1, x - 10, y - 8, x - 4, y + 1], true)
        .fill({ color: style.fill, alpha: 0.96 })
        .stroke({ color: style.stroke, width: 1.2, alpha: 0.92 });
      graphics
        .poly([x, y - 4, x + 9, y - 11, x + 5, y - 2], true)
        .fill({ color: style.fill, alpha: 0.96 })
        .stroke({ color: style.stroke, width: 1.2, alpha: 0.92 });
      graphics
        .circle(x - 1, y - 10, 2.1)
        .fill({ color: 0xfef3c7, alpha: 0.82 });
      return;
    case "wood":
    case "leather":
      return;
  }
  graphics.fill({ color: style.fill, alpha: 0.96 }).stroke({
    color: style.stroke,
    width: 2,
    alpha: 0.92
  });
  graphics
    .circle(x - 3, y - 3, 2.2)
    .fill({ color: 0xffffff, alpha: 0.72 });
}

export function collectibleArtworkKey(
  collectible: Pick<
    CollectibleNode,
    "id" | "type" | "repeatableNodeType" | "resinAvailable" | "berryAvailable" | "sapReadyAt"
  >
):
  | "tree"
  | "resinTree"
  | "willowTree"
  | "chinesePistache"
  | "flax"
  | "stoneMine"
  | "coalMine"
  | "ironMine"
  | "sulfurMine"
  | "stone"
  | "leather"
  | null {
  if (collectible.repeatableNodeType === "stone_mine") return "stoneMine";
  if (collectible.repeatableNodeType === "coal_mine") return "coalMine";
  if (collectible.repeatableNodeType === "iron_mine") return "ironMine";
  if (collectible.repeatableNodeType === "sulfur_mine") return "sulfurMine";
  if (collectible.type === "flax_fiber") return "flax";
  if (collectible.type === "wood") {
    switch (treeVarietyForStableId(collectible.id)) {
      case "giving_tree": return collectible.berryAvailable ? "resinTree" : "tree";
      // Shown until the fern's biome art loads (same framing as the Giving Tree art).
      case "elder_fern": return treeProduceAvailable(collectible, Date.now()) ? "resinTree" : "tree";
      case "willow": return "willowTree";
      case "chinese_pistache": return "chinesePistache";
    }
  }
  // Dungeon resin nodes use the overworld resin tree art.
  if (collectible.type === "balsam_resin") return "resinTree";
  // Hollin orchard trees (giving_berry plants) use the giving berry tree art.
  if (collectible.type === "giving_berry") return "resinTree";
  if (collectible.type === "stone") return "stone";
  if (collectible.type === "leather") return "leather";
  return null;
}

function collectibleHitRadius(): number {
  return 16;
}

export function treeSpriteRectangle(input: Readonly<{
  x: number;
  y: number;
  textureWidth: number;
  textureHeight: number;
  zoom: number;
  paddingPx?: number;
}>): Extract<ScreenHitBox, { shape: "rectangle" }> {
  const hit = spriteInteractionHitBox({
    ...input,
    presentation: WORLD_SPRITE_PRESENTATION.tree
  });
  if (hit.shape !== "rectangle") {
    throw new Error("Tree interaction geometry must remain rectangular");
  }
  return hit;
}

export function spriteInteractionHitBox(input: Readonly<{
  x: number;
  y: number;
  textureWidth: number;
  textureHeight: number;
  zoom: number;
  presentation: RuntimeSpritePresentation;
  paddingPx?: number;
}>): ScreenHitBox {
  const presentation = input.presentation;
  const height = spriteHeightForZoom(
    input.zoom,
    SPRITE_BASE_ZOOM,
    presentation
  );
  const width = (input.textureHeight > 0
    ? input.textureWidth * height / input.textureHeight
    : height) * spriteHorizontalScale(presentation);
  const paddingPx = presentation.hitGeometry.shape === "rectangle"
    ? input.paddingPx === undefined
      ? Math.min(8, Math.max(4, SPRITE_HITBOX_PADDING_PX))
      : Math.max(0, input.paddingPx)
    : 0;
  const geometry = presentation.hitGeometry.shape === "circle"
    ? {
        ...presentation.hitGeometry,
        radiusPx: presentation.hitGeometry.radiusPx *
          worldPngSpriteMasterScale(presentation)
      }
    : presentation.hitGeometry;
  return pngInteractionHitBox({
    x: input.x,
    y: input.y,
    width,
    height,
    anchorX: presentation.anchorX,
    anchorY: presentation.anchorY,
    geometry,
    paddingPx
  });
}

function collectibleHitBox(
  collectible: CollectibleNode,
  point: Readonly<{ x: number; y: number }>,
  zoom: number,
  textures: WorldTextures
): CollectibleHitBox {
  const artworkKey = collectibleArtworkKey(collectible);
  if (artworkKey) {
    return {
      collectible,
      ...spriteInteractionHitBox({
        x: point.x,
        y: point.y,
        textureWidth: textures[artworkKey].width,
        textureHeight: textures[artworkKey].height,
        zoom,
        presentation: WORLD_SPRITE_PRESENTATION[artworkKey]
      })
    };
  }
  return {
    shape: "circle",
    collectible,
    x: point.x,
    y: point.y,
    radius: collectibleHitRadius()
  };
}

function containsScreenHitBox(
  point: Readonly<{ x: number; y: number }>,
  hit: Readonly<
    | { shape: "circle"; x: number; y: number; radius: number }
    | {
        shape: "rectangle";
        left: number;
        top: number;
        right: number;
        bottom: number;
      }
  >,
  paddingPx = 0
): boolean {
  return hit.shape === "circle"
    ? Math.hypot(point.x - hit.x, point.y - hit.y) <= hit.radius + paddingPx
    : point.x >= hit.left - paddingPx
      && point.x <= hit.right + paddingPx
      && point.y >= hit.top - paddingPx
      && point.y <= hit.bottom + paddingPx;
}

function screenHitBoxCenter(hit: Readonly<
  | { shape: "circle"; x: number; y: number }
  | { shape: "rectangle"; left: number; top: number; right: number; bottom: number }
>): { x: number; y: number } {
  return hit.shape === "circle"
    ? { x: hit.x, y: hit.y }
    : { x: (hit.left + hit.right) / 2, y: (hit.top + hit.bottom) / 2 };
}

function addArtworkSprite(
  layer: Container,
  texture: Texture,
  x: number,
  y: number,
  presentation: SpritePresentation,
  currentZoom: number,
  alpha = 1
): void {
  const sprite = new Sprite(texture) as Sprite & ZoomScaledDisplay;
  sprite.anchor.set(presentation.anchorX, presentation.anchorY);
  applyZoomScaledPresentation(
    sprite,
    x,
    y,
    sprite.texture.height,
    presentation,
    currentZoom
  );
  sprite.alpha = alpha;
  layer.addChild(sprite);
}

function applyZoomScaledPresentation(
  display: ZoomScaledDisplay,
  x: number,
  y: number,
  sourceHeight: number,
  presentation: SpritePresentation,
  currentZoom: number
): void {
  const layout = spriteLayoutForZoom(
    x,
    y,
    sourceHeight,
    currentZoom,
    presentation
  );
  display.position.set(layout.x, layout.y);
  display.scale.set(layout.scaleX, layout.scaleY);
  display[staticSpritePresentationKey] = presentation;
  display[staticSpriteCommittedScaleKey] = layout.scale;
}

const staticLabelLayoutZoom = new WeakMap<object, { layout: unknown; zoom: number }>();

function applyStaticArtworkScaleCorrection(
  layer: Container,
  parentTransformScale: number,
  currentZoom: number,
  committedZoom: number
): void {
  for (const child of layer.children) {
    const sprite = child as ZoomScaledDisplay;
    const labelLayout = sprite[staticLabelLayoutKey];
    if (labelLayout) {
      // Labels are CSS-pixel sized, even while their cached geographic anchor
      // follows the frozen layer across a globe-to-local zoom transition.
      sprite.scale.set(1 / Math.max(Number.EPSILON, parentTransformScale));
      const laidOut = staticLabelLayoutZoom.get(sprite);
      if (!laidOut || laidOut.layout !== labelLayout || laidOut.zoom !== currentZoom) {
        labelLayout(currentZoom);
        staticLabelLayoutZoom.set(sprite, { layout: labelLayout, zoom: currentZoom });
      }
      continue;
    }
    const presentation = sprite[staticSpritePresentationKey];
    const committedScale = sprite[staticSpriteCommittedScaleKey];
    if (presentation && committedScale !== undefined) {
      const correctedScale = staticSpriteLocalScaleDuringTransform(
        committedScale,
        parentTransformScale,
        currentZoom,
        committedZoom,
        presentation
      );
      sprite.scale.set(
        correctedScale * spriteHorizontalScale(presentation),
        correctedScale
      );
    }
    if (sprite.children.length === 0) continue;
    applyStaticArtworkScaleCorrection(
      sprite,
      parentTransformScale,
      currentZoom,
      committedZoom
    );
  }
}

/** Pool key of a label-only floater: same key = same Text style, so a released label can be reused. */
function floaterStyleKey(floater: Pick<FloatingFeedbackInput, "kind" | "emphasis" | "label">): string {
  return isDodgeFeedback(floater) ? "dodge" : floater.emphasis === "big" ? `${floater.kind}!` : floater.kind;
}

function floatingFeedbackStyle(kind: FloatingFeedbackKind, big = false, dodge = false): {
  fill: number;
  stroke: number;
  fontSize: number;
} {
  // Hit feedback: finisher / big-hit numbers are larger and brighter; DODGE is a cool cyan.
  if (dodge) return { fill: 0x9be8ff, stroke: 0x062a3a, fontSize: 16 };
  if (big && kind === "damage_dealt") return { fill: 0xffe27a, stroke: 0x4a1500, fontSize: 20 };
  if (big && kind === "damage_taken") return { fill: 0xff4a4a, stroke: 0x2a0000, fontSize: 20 };
  switch (kind) {
    case "damage_dealt": return { fill: 0xffb06b, stroke: 0x351207, fontSize: 17 };
    case "damage_taken": return { fill: 0xff5d5d, stroke: 0x2a0000, fontSize: 17 };
    case "damage_other": return { fill: 0xff786f, stroke: 0x250607, fontSize: 16 };
    case "healing": return { fill: 0x86efac, stroke: 0x052e16, fontSize: 16 };
    case "healing_blocked": return { fill: 0xc4b5fd, stroke: 0x2e1065, fontSize: 14 };
    case "gold": return { fill: 0xfde68a, stroke: 0x422006, fontSize: 16 };
    case "character_xp": return { fill: 0x93c5fd, stroke: 0x172554, fontSize: 15 };
    case "class_xp": return { fill: 0xf0abfc, stroke: 0x3b0764, fontSize: 15 };
      case "profession_xp": return { fill: 0x6ee7b7, stroke: 0x064e3b, fontSize: 15 };
      case "profession_proc": return { fill: 0xfcd34d, stroke: 0x451a03, fontSize: 16 };
      case "class_innate": return { fill: 0x93c5fd, stroke: 0x172554, fontSize: 16 };
      case "harvesting_notice": return { fill: 0xfcd34d, stroke: 0x451a03, fontSize: 15 };
    case "resource": return { fill: 0xfef08a, stroke: 0x1c1917, fontSize: 15 };
    case "resource_missing": return { fill: 0xff786f, stroke: 0x250607, fontSize: 15 };
    case "resource_spent": return { fill: 0xfef3c7, stroke: 0x422006, fontSize: 15 };
    case "resin_spent": return { fill: 0xfef3c7, stroke: 0x422006, fontSize: 16 };
  }
  throw new Error(`Unknown floating feedback kind: ${kind}`);
}

function collectibleStyle(resourceType: ResourceType): { fill: number; stroke: number } {
  switch (resourceType) {
    case "wood":
      return { fill: 0x8b5a2b, stroke: 0x3f2412 };
    case "stone":
      return { fill: 0x94a3b8, stroke: 0x334155 };
    case "coal":
      return { fill: 0x1f2937, stroke: 0x030712 };
    case "iron":
      return { fill: 0x78716c, stroke: 0x292524 };
    case "sulfur":
      return { fill: 0xfacc15, stroke: 0x854d0e };
    case "slag":
      return { fill: 0x57534e, stroke: 0x292524 };
    case "iron_bar":
      return { fill: 0xa8a29e, stroke: 0x44403c };
    case "venomsteel_bar":
      return { fill: 0x65a30d, stroke: 0x1a2e05 };
    case "venomsteel_core":
      return { fill: 0x4d7c0f, stroke: 0x142000 };
    case "fire_feather":
    case "fire_bar":
    case "fire_core":
      return { fill: 0xf97316, stroke: 0x7c2d12 };
    case "tempest_quill":
    case "lightning_bar":
    case "lightning_core":
      return { fill: 0xfacc15, stroke: 0x713f12 };
    case "ice_feather":
    case "ice_bar":
    case "ice_core":
      return { fill: 0x7dd3fc, stroke: 0x075985 };
    case "deer_hide":
    case "hog_hide":
    case "wolf_pelt":
    case "bear_hide":
    case "alligator_hide":
    case "squid_flesh":
    case "squid_meat":
    case "deer_meat":
    case "wolf_meat":
    case "hog_meat":
    case "bear_meat":
    case "alligator_meat":
    case "wild_meat":
    case "crab_carapace":
    case "raw_meat":
    case "shell":
    case "chitin":
    case "frog_legs":
    case "frost_frog_legs":
    case "poison_frog_legs":
    case "desert_toad_legs":
    case "crab_meat":
    case "ice_crab_meat":
    case "sand_crab_meat":
    case "mangrove_crab_meat":
    case "small_catch":
    case "jellyfish_jelly":
    case "crawler_flesh":
    case "squid_cut":
    case "wolf_cut":
    case "frost_wolf_cut":
    case "dune_wolf_cut":
    case "jungle_wolf_cut":
    case "bog_wolf_cut":
    case "deer_cut":
    case "frost_deer_cut":
    case "jungle_deer_cut":
    case "marsh_deer_cut":
    case "sand_deer_cut":
    case "hog_cut":
    case "woolly_hog_cut":
    case "warthog_cut":
    case "jungle_hog_cut":
    case "mud_hog_cut":
    case "javelina_cut":
    case "alligator_tail":
    case "caiman_tail":
    case "crocodile_tail":
    case "bear_cut":
    case "snow_bear_cut":
    case "black_bear_cut":
    case "sun_bear_cut":
    case "jungle_tapir_cut":
    case "jaguar_cut":
    case "mandrill_cut":
    case "capercaillie_meat":
    case "elk_cut":
    case "red_squirrel_cut":
    case "badger_cut":
    case "grey_squirrel_cut":
    case "stag_beetle_cut":
    case "great_grey_owl_meat":
    case "flying_squirrel_cut":
    case "plains_bison_cut":
    case "prairie_dog_cut":
    case "burrowing_owl_meat":
    case "giraffe_cut":
    case "lioness_cut":
    case "spotted_hyena_cut":
    case "sitatunga_cut":
    case "emperor_dragonfly_cut":
    case "mountain_ibex_cut":
    case "wild_yak_cut":
    case "alpine_marmot_cut":
    case "wild_scrub_goat_cut":
    case "crested_porcupine_cut":
    case "spur_thighed_tortoise_cut":
    case "dromedary_cut":
    case "fennec_fox_cut":
    case "sidewinder_cut":
    case "field_hare_cut":
    case "arctic_hare_cut":
    case "capybara_cut":
    case "armadillo_cut":
    case "red_fox_cut":
    case "wolverine_cut":
    case "ostrich_cut":
    case "golden_eagle_cut":
    case "musk_ox_cut":
    case "seal_cut":
    case "desert_lion_cut":
    case "saiga_cut":
    case "wild_horse_cut":
    case "steppe_marmot_cut":
    case "lemming_cut":
    case "snow_goose_meat":
    case "mammoth_cut":
    case "dire_wolf_cut":
    case "drake_cut":
    case "dragon_cut":
    case "grub_meat":
    case "emperor_penguin_meat":
    case "peary_caribou_cut":
    case "ice_worm_cut":
    case "sea_otter_cut":
    case "herring_gull_meat":
    case "spiny_lobster_tail":
    case "hammerhead_shark_steak":
    case "manta_ray_wing":
    case "humpback_whale_cut":
    case "muskellunge_fillet":
    case "mute_swan_meat":
    case "pike_fillet":
    case "snapping_turtle_cut":
    case "beaver_cut":
    case "otter_cut":
    case "salmon_fillet":
    case "elemental_ration":
    case "scorching_bird_meat":
    case "zappy_bird_meat":
    case "freezing_bird_meat":
    case "field_ration":
    case "hearty_ration":
    case "xoral_essence":
      return { fill: 0x8b6b45, stroke: 0x3f2a19 };
    case "food":
      return { fill: 0x65a30d, stroke: 0x365314 };
    case "simple_food":
      return { fill: 0xf59e0b, stroke: 0x7c2d12 };
    case "freshwater_fish":
      return { fill: 0x38bdf8, stroke: 0x075985 };
    case "ashen_fish":
      return { fill: 0x38bdf8, stroke: 0x075985 };
    case "ore":
      return { fill: 0xf97316, stroke: 0x7c2d12 };
    case "water":
      return { fill: 0x0ea5e9, stroke: 0x075985 };
    case "leather":
      return { fill: 0x92400e, stroke: 0x451a03 };
    case "flax_fiber":
      return { fill: 0xf5deb3, stroke: 0x8b7355 };
    case "cloth":
      return { fill: 0xe7e5e4, stroke: 0x57534e };
    case "giving_berry":
    case "balsam_resin":
      return { fill: 0x65a30d, stroke: 0x365314 };
    case "repair_kit":
      return { fill: 0xc4b5fd, stroke: 0x4c1d95 };
    case "torch":
      return { fill: 0xf59e0b, stroke: 0x7c2d12 };
    case "crude_oil":
      return { fill: 0x1f2937, stroke: 0x030712 };
    case "jellyfish_venom":
      return { fill: 0x84cc16, stroke: 0x365314 };
    case "brood_silk":
      return { fill: 0xe5e7eb, stroke: 0x4b5563 };
    case "raptor_scale":
      return { fill: 0xb45309, stroke: 0x451a03 };
    case "giant_egg":
    case "brood_egg":
    case "clutch_egg":
    case "crawler_egg":
      return { fill: 0xfef3c7, stroke: 0x92400e };
    case "broken_whistle":
    case "bonewrought_blade":
    case "bonewrought_mail":
      return { fill: 0xa8a29e, stroke: 0x44403c };
    case "elder_acorn":
      return { fill: 0xa16207, stroke: 0x422006 };
    case "wyrm_egg":
      return { fill: 0xdc2626, stroke: 0x450a0a };
    case "dragon_scale":
      return { fill: 0xea580c, stroke: 0x431407 };
    case "zephyr":
      return { fill: 0xfde68a, stroke: 0xb45309 };
    case "refined_oil":
      return { fill: 0xf59e0b, stroke: 0x78350f };
    case "bricks":
      return { fill: 0xb4532a, stroke: 0x4a1d0f };
    case "crystal":
      return { fill: 0xa78bfa, stroke: 0x4c1d95 };
    case "pearl":
      return { fill: 0xf1f5f9, stroke: 0x64748b };
    case "atlas_shrine_shard":
      return { fill: 0x22d3ee, stroke: 0x155e75 };
    case "enchantment_stone":
      return { fill: 0x10b981, stroke: 0x064e3b };
  }
  throw new Error(`Unknown collectible resource type: ${resourceType}`);
}

function hexToNumber(value: string): number {
  return Number.parseInt(value.slice(1), 16);
}

/** Elite label tint while a shielded elite's shield is up (the old DOM layer's shield badge colour). */
const ELITE_SHIELD_LABEL_TINT = 0x8fd3ff;

function mobNameplate(entity: CombatEntitySnapshot): string {
  const tier = entity.challengeTier
    ? entity.challengeTier[0]!.toUpperCase() + entity.challengeTier.slice(1)
    : "Common";
  return `${entity.name} · ${tier} · Lv ${entity.level}`;
}

function darkenColor(color: number, amount: number): number {
  const red = Math.round(((color >> 16) & 0xff) * amount);
  const green = Math.round(((color >> 8) & 0xff) * amount);
  const blue = Math.round((color & 0xff) * amount);
  return (red << 16) | (green << 8) | blue;
}

function staticReferenceGroundZoom(
  reference: StaticOverlayMapTransformReference
): number {
  return groundScaleZoom(reference.zoom, reference.originLat);
}

