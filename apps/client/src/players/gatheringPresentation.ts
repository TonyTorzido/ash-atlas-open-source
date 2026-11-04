import {
  appearanceAssetParts,
  baseAppearanceForEquipment,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  GATHERING_TOOL_SLOT_BY_KIND,
  gatheringToolKindForDefinition,
  territoryStructureVisual,
  TERRITORY_STRUCTURE_REFERENCE_HEIGHT,
  type CollectibleNode,
  type EquipmentDefinitionId,
  type EquipmentSlot,
  type FishingEncounterSnapshot,
  type LatLon
} from "@ash-atlas/shared";
import {
  PLAYER_BASE_HEIGHT_PX,
  gatherFishPhaseForEncounter,
  gatherSideForTarget,
  type FlagBuildArt,
  type GatherActionKind,
  type GatherFishPhase,
  type GatherKind,
  type GatherSide,
  type PlayerRenderer
} from "@ash-atlas/player-renderer";
import type { Texture } from "pixi.js";

import { collectibleProduceAvailable, harvestActivityLabel, type HarvestTask } from "../collectibles/harvest.js";
import { SPRITE_PRESENTATION } from "../map/spritePresentation.js";

/**
 * What a player is visibly working on. Built for the local player from client
 * state, and for remote players from their broadcast gathering snapshot.
 */
export type GatheringPresentation = Readonly<{
  /** "flag" = building a flag (local player only; no tool). */
  kind: GatherActionKind;
  /** Held-tool appearance asset key; null = bare hands. */
  toolAssetKey: string | null;
  target: LatLon;
  /** Collectible id of the worked object when known (local harvests); remote ones resolve from target. */
  targetId?: string;
  /** Changes when a new action starts (restarts the cycle). */
  actionKey: string;
  fishPhase?: GatherFishPhase;
  /** Flag builds: when the build completes (performance.now() ms), for the final plant animation. */
  flagCompletesAtMs?: number;
}>;

/** Fishing needs a pole: with none equipped the starter pole is shown (owner decision). */
const STARTER_POLE_DEFINITION_ID = "starter_fishing_pole";

/** Held-tool art asset key for a gathering tool definition (from the appearance catalog), or null. */
export function gatheringToolAssetKeyForDefinition(definitionId: string): string | null {
  if (gatheringToolKindForDefinition(definitionId) === null) return null;
  const appearance = baseAppearanceForEquipment(
    DEFAULT_PLAYER_APPEARANCE_CATALOG,
    definitionId as EquipmentDefinitionId
  );
  return appearance ? appearanceAssetParts(appearance)[0]?.assetKey ?? null : null;
}

/** The local player's equipped items by slot (EquipmentSnapshotV2.active). */
export type EquippedToolSlots = Partial<Record<EquipmentSlot, Readonly<{ definitionId: string }> | null>>;

/**
 * Held-tool art for the tool in the slot of this kind (axe for chop, pickaxe
 * for mine, pole for fish). Chop/mine without one are bare-handed (null);
 * fishing falls back to the starter pole.
 */
export function equippedGatheringToolAssetKey(
  kind: GatherKind,
  active: EquippedToolSlots | null | undefined
): string | null {
  const equippedToolDefinitionId = active?.[GATHERING_TOOL_SLOT_BY_KIND[kind]]?.definitionId;
  if (equippedToolDefinitionId && gatheringToolKindForDefinition(equippedToolDefinitionId) === kind) {
    return gatheringToolAssetKeyForDefinition(equippedToolDefinitionId);
  }
  return kind === "fish" ? gatheringToolAssetKeyForDefinition(STARTER_POLE_DEFINITION_ID) : null;
}

/** Broadcast gathering snapshot shape for other players (wired by the gathering-tools branch). */
export type RemoteGatheringSnapshot = Readonly<{
  kind: GatherKind;
  toolDefinitionId: string | null;
  targetLat: number;
  targetLon: number;
  /** ISO timestamp. */
  startedAt: string;
  completesAt: string | null;
}> | null;

/**
 * Chop for trees, mine for repeatable nodes, and the bare-hand picking
 * animation ("harvest") for everything else: berries, plants, herbs, fibre,
 * and the berries or sap taken from a Giving Tree or Elder Fern ("resin").
 */
export function harvestGatherKind(
  collectible: Pick<CollectibleNode, "repeatableNodeType" | "type">,
  action: HarvestTask["action"]
): Exclude<GatherActionKind, "fish" | "flag"> {
  if (action === "resin") return "harvest";
  const activity = harvestActivityLabel(collectible);
  return activity === "Chopping" ? "chop" : activity === "Mining" ? "mine" : "harvest";
}

/** The local player's running flag construction (the build countdown is active). */
export type LocalFlagBuild = Readonly<{
  buildId: string;
  position: LatLon;
  anchorKind?: "flag" | "buoy";
  /** Local completion deadline (performance.now() ms). */
  completesAtMs?: number;
}>;

/**
 * Local player's gathering presentation. toolAssetKeyFor is the seam for the
 * equipped tool slot: return the tool's held-art asset key for a kind, or null.
 * A running flag build shows the flag-building animation (buoys are built
 * afloat and show none).
 */
export function localGatheringPresentation(input: Readonly<{
  harvestTask: HarvestTask | null;
  harvestTarget: CollectibleNode | null;
  fishingEncounter: FishingEncounterSnapshot | null;
  /** Where the local player stands (fishing aims at the cast point or ahead). */
  playerPosition: LatLon | null;
  toolAssetKeyFor(kind: GatherKind): string | null;
  flagBuild?: LocalFlagBuild | null;
  /** Wall clock (ms) for the Elder Frond sap timer; defaults to Date.now(). */
  nowMs?: number;
}>): GatheringPresentation | null {
  const flagBuild = input.flagBuild;
  if (flagBuild && flagBuild.anchorKind !== "buoy") {
    return {
      kind: "flag",
      toolAssetKey: null,
      target: flagBuild.position,
      actionKey: `flag:${flagBuild.buildId}`,
      ...(flagBuild.completesAtMs !== undefined ? { flagCompletesAtMs: flagBuild.completesAtMs } : {})
    };
  }
  const encounter = input.fishingEncounter;
  if (encounter) {
    const fishPhase = gatherFishPhaseForEncounter(encounter.phase, encounter.castPoint !== null);
    const target = encounter.castPoint ?? input.playerPosition;
    if (fishPhase && target) {
      return {
        kind: "fish",
        toolAssetKey: input.toolAssetKeyFor("fish"),
        target,
        actionKey: `fish:${encounter.encounterId}`,
        fishPhase
      };
    }
  }
  const task = input.harvestTask;
  const node = input.harvestTarget;
  if (!task || !node || (task.phase !== "harvesting" && task.phase !== "completing")) return null;
  const kind = harvestGatherKind(node, task.action);
  // Owner 2026-10-20: picking (frond sap, berries, plants) stops the moment the produce is gone. "completing" starts
  // when the harvest timer ends (the client hides the berries then and asks the server to finish), so the player
  // stands instead of picking at an empty node through the round trip; produce taken while picking stops it too.
  if (kind === "harvest" && (task.phase === "completing" || (task.action === "resin" && !collectibleProduceAvailable(node, input.nowMs ?? Date.now())))) {
    return null;
  }
  return {
    kind,
    // Picking is bare-handed.
    toolAssetKey: kind === "harvest" ? null : input.toolAssetKeyFor(kind),
    target: node,
    targetId: task.nodeId,
    actionKey: `${kind}:${task.nodeId}:${task.sessionId ?? task.startedAtMs ?? ""}`
  };
}

/**
 * Remote player's gathering presentation from the broadcast snapshot.
 * toolAssetKeyForDefinition maps a tool definition id to its held-art asset key.
 */
export function remoteGatheringPresentation(
  gathering: RemoteGatheringSnapshot | undefined,
  toolAssetKeyForDefinition: (toolDefinitionId: string) => string | null
): GatheringPresentation | null {
  if (!gathering) return null;
  return {
    kind: gathering.kind,
    toolAssetKey: (gathering.toolDefinitionId ? toolAssetKeyForDefinition(gathering.toolDefinitionId) : null) ??
      (gathering.kind === "fish" ? toolAssetKeyForDefinition(STARTER_POLE_DEFINITION_ID) : null),
    target: { lat: gathering.targetLat, lon: gathering.targetLon },
    actionKey: `${gathering.kind}:${gathering.startedAt}`,
    ...(gathering.kind === "fish" ? { fishPhase: "wait" as const } : {})
  };
}

/**
 * Height of a Soft Flag piece canvas in PlayerRenderer root units: the size
 * the placed flag has on the map next to the player. Flags and players share
 * one zoom curve, so the ratio of their base heights holds at every zoom.
 */
export function flagBuildHeightUnits(pieceHeight: number, pieceScale: number): number {
  const visual = territoryStructureVisual("soft_flag");
  const flagScreenPerUnit = SPRITE_PRESENTATION.flag.baseHeightPx / TERRITORY_STRUCTURE_REFERENCE_HEIGHT;
  const playerScreenPerRootUnit = SPRITE_PRESENTATION.player.baseHeightPx / PLAYER_BASE_HEIGHT_PX;
  return pieceHeight * pieceScale * visual.root.scale * flagScreenPerUnit / playerScreenPerRootUnit;
}

/**
 * Held flag for the flag-building animation, from the active pack's Soft Flag
 * art (pole hardware + cloth on one canvas), at the placed flag's size. The
 * cloth takes the flag's tint mode: "control" uses clothColor (the player's
 * flag colour). Null while the art is not loaded.
 */
export function flagBuildArtFromTextures(
  textureFor: (asset: string) => Texture | undefined,
  clothColor: number
): FlagBuildArt | null {
  const pieces = territoryStructureVisual("soft_flag").pieces;
  const hardware = pieces.find((piece) => piece.role === "hardware" && piece.visible);
  const cloth = pieces.find((piece) => piece.role === "cloth" && piece.visible);
  const pole = hardware ? textureFor(hardware.asset) : undefined;
  if (!hardware || !pole) return null;
  const clothTexture = cloth ? textureFor(cloth.asset) ?? null : null;
  const clothTint = cloth?.tint === "control"
    ? clothColor
    : cloth?.tint === "fixed"
      ? Number.parseInt(cloth.tintColor.slice(1), 16)
      : 0xffffff;
  return {
    pole,
    cloth: clothTexture,
    baseX: hardware.anchorX,
    baseY: hardware.anchorY,
    clothTint,
    heightUnits: flagBuildHeightUnits(hardware.height, hardware.scale)
  };
}

/** Per-player state the overlay keeps so the side and cycle stay stable. */
export type PlayerGatheringState = {
  actionKey: string | null;
  side: GatherSide | null;
  startedAtMs: number;
  /** Last values handed to the renderer; unchanged frames allocate nothing. */
  sentSide: GatherSide | null;
  sentFishPhase: GatherFishPhase | null;
  sentTool: string | null;
  sentReduced: boolean;
  /** Renderer impacts already turned into target reactions. */
  impactsSeen: number;
  /** Worked collectible resolved for actionKey (null = none found). */
  targetActionKey: string | null;
  targetId: string | null;
};

export function createPlayerGatheringState(): PlayerGatheringState {
  return {
    actionKey: null,
    side: null,
    startedAtMs: 0,
    sentSide: null,
    sentFishPhase: null,
    sentTool: null,
    sentReduced: false,
    impactsSeen: 0,
    targetActionKey: null,
    targetId: null
  };
}

/**
 * Drives one player renderer from a presentation. Screen x values are in the
 * same space; the side keeps hysteresis and is locked per action.
 * Returns whether the renderer needs updateAnimation this frame.
 */
export function applyPlayerGathering(
  renderer: PlayerRenderer,
  state: PlayerGatheringState,
  presentation: GatheringPresentation | null,
  playerScreenX: number,
  targetScreenX: number,
  frameNowMs: number,
  reducedMotion: boolean
): boolean {
  if (!presentation) {
    if (state.actionKey !== null) {
      state.actionKey = null;
      state.side = null;
      renderer.setGatheringAction(null);
    }
    return renderer.animating;
  }
  const fresh = presentation.actionKey !== state.actionKey;
  if (fresh) {
    state.actionKey = presentation.actionKey;
    state.startedAtMs = frameNowMs;
    state.side = null;
  }
  state.side = gatherSideForTarget(playerScreenX, targetScreenX, state.side);
  const fishPhase = presentation.fishPhase ?? null;
  if (
    !fresh &&
    state.sentSide === state.side &&
    state.sentFishPhase === fishPhase &&
    state.sentTool === presentation.toolAssetKey &&
    state.sentReduced === reducedMotion
  ) {
    return true;
  }
  state.sentSide = state.side;
  state.sentFishPhase = fishPhase;
  state.sentTool = presentation.toolAssetKey;
  state.sentReduced = reducedMotion;
  renderer.setGatheringAction({
    kind: presentation.kind,
    tool: presentation.toolAssetKey,
    side: state.side,
    startedAtMs: state.startedAtMs,
    ...(presentation.fishPhase ? { fishPhase: presentation.fishPhase } : {}),
    reducedMotion
  });
  return true;
}
