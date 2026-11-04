import {
  DEEPSTONE_MINED_RESOURCES,
  GATHERING_TOOL_SLOT_BY_KIND,
  gatheringToolKindForDefinition,
  type EquipmentSnapshotV2,
  type FishingEncounterSnapshot,
  type GatheringToolKind,
  type HarvestSessionSnapshot,
  type LatLon,
  type PlayerGatheringActivity
} from "@ash-atlas/shared";

export type GatheringHarvestSource = "collectible" | "mine" | "resin";

/**
 * Trees are chopped; stone, ore and mines are mined. Resin tapping, plants and every other
 * harvest show no gathering pose.
 */
export function gatheringKindForHarvest(
  resourceType: string,
  source: GatheringHarvestSource
): GatheringToolKind | null {
  if (source === "mine") return "mine";
  if (source === "resin") return null;
  if (resourceType === "wood") return "chop";
  if (DEEPSTONE_MINED_RESOURCES.has(resourceType)) return "mine";
  return null;
}

/** The tool equipped in the action's slot (axe/pickaxe/pole), else null (bare hand). */
export function gatheringToolFor(
  equipment: Pick<EquipmentSnapshotV2, "active"> | null | undefined,
  kind: GatheringToolKind
): string | null {
  const tool = equipment?.active[GATHERING_TOOL_SLOT_BY_KIND[kind]] ?? null;
  return tool && gatheringToolKindForDefinition(tool.definitionId) === kind
    ? tool.definitionId
    : null;
}

export function gatheringActivityForHarvest(input: Readonly<{
  session: HarvestSessionSnapshot;
  source: GatheringHarvestSource;
  target: LatLon | null;
  equipment: Pick<EquipmentSnapshotV2, "active"> | null | undefined;
}>): PlayerGatheringActivity | null {
  const kind = gatheringKindForHarvest(input.session.resourceType, input.source);
  if (!kind || !input.target || input.session.status !== "active") return null;
  return {
    kind,
    toolDefinitionId: gatheringToolFor(input.equipment, kind),
    targetLat: input.target.lat,
    targetLon: input.target.lon,
    startedAt: input.session.startedAt,
    completesAt: input.session.completesAt
  };
}

const FISHING_LIVE_PHASES: ReadonlySet<FishingEncounterSnapshot["phase"]> =
  new Set(["cast", "bite", "hooked", "fighting"]);

/** Fishing shows once a cast is accepted and lasts until the encounter ends. */
export function gatheringActivityForFishing(
  encounter: FishingEncounterSnapshot | null | undefined,
  equipment: Pick<EquipmentSnapshotV2, "active"> | null | undefined,
  previous: PlayerGatheringActivity | null
): PlayerGatheringActivity | null {
  if (!encounter?.castPoint || !FISHING_LIVE_PHASES.has(encounter.phase)) return null;
  const sameCast = previous?.kind === "fish" &&
    previous.targetLat === encounter.castPoint.lat &&
    previous.targetLon === encounter.castPoint.lon;
  return {
    kind: "fish",
    toolDefinitionId: gatheringToolFor(equipment, "fish"),
    targetLat: encounter.castPoint.lat,
    targetLon: encounter.castPoint.lon,
    startedAt: sameCast ? previous.startedAt : new Date(encounter.serverTime).toISOString(),
    completesAt: null
  };
}
