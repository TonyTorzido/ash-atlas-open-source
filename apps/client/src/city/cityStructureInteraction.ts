import {
  CITY_MARKET_INTERACTION_RADIUS_M,
  OIL_WELL_INTERACTION_RADIUS_M,
  CITY_STRUCTURE_INTERACTION_RADIUS_M,
  CITY_WAREHOUSE_INTERACTION_RADIUS_M,
  distanceMeters,
  interpolateLatLon,
  type CityStructureSnapshot,
  type OilWellSnapshot
} from "@ash-atlas/shared";

export type CityStructureInteractionKind =
  | "warehouse"
  | "market"
  | "oil_well"
  | "city_kennel"
  | "library"
  | "salon";
export type CityStructureInteractionSource = "city" | "build" | "world";

export type CityStructureInteractionIntent = Readonly<{
  kind: CityStructureInteractionKind;
  action: "open";
  structureId: string;
  placementRevision: string;
  connectionGeneration: number;
  source: CityStructureInteractionSource;
  movementRequestId: string | null;
}>;

export type CityStructureInteractionDecision =
  | { kind: "open_now"; intent: CityStructureInteractionIntent }
  | {
      kind: "approach";
      intent: CityStructureInteractionIntent;
      target: Readonly<{ lat: number; lon: number }>;
    };

export type CityStructureInteractionTransition =
  | "waiting"
  | "ready"
  | "cancel"
  | "unreachable";

export type OilWellHarvestPromptState = Readonly<{
  label: string;
  enabled: boolean;
  disabledReason: string | null;
}>;

export function oilWellHarvestPromptState(input: {
  /** Absent means an Oil Well. */
  structureType?: "oil_well" | "quartz_hut";
  owner: boolean;
  publicAccess?: boolean;
  active: boolean;
  online: boolean;
  busy: boolean;
  inactiveReason: string | null;
  well: OilWellSnapshot | null;
}): OilWellHarvestPromptState {
  const crystal = input.structureType === "quartz_hut";
  const name = crystal ? "Quartz Hut" : "Oil Well";
  const disabledReason = !input.owner && !input.publicAccess
    ? `This ${name} is private.`
    : !input.active
      ? input.inactiveReason ?? `This ${name} is not active.`
      : !input.online
        ? `The ${name} is unavailable while disconnected.`
        : input.well && !input.well.canHarvest
          ? `No ${crystal ? "Crystal" : "Crude Oil"} is ready yet.`
          : null;
  return {
    label: input.well
      ? `${crystal ? "Collect" : "Harvest"} ${input.well.storedCrudeOil}/${input.well.capacity}${input.well.isOwner === false ? ` · ${input.well.tollGold ?? "0"} Gold` : ""}`
      : crystal ? "Approach to Collect" : "Approach to Harvest",
    enabled: disabledReason === null && !input.busy,
    disabledReason
  };
}

export function beginCityStructureInteraction(input: {
  kind: CityStructureInteractionKind;
  structure: CityStructureSnapshot;
  player: Readonly<{ lat: number; lon: number }>;
  connectionGeneration: number;
  source: CityStructureInteractionSource;
}): CityStructureInteractionDecision {
  const intent: CityStructureInteractionIntent = {
    kind: input.kind,
    action: "open",
    structureId: input.structure.structureId,
    placementRevision: input.structure.placementRevision,
    connectionGeneration: input.connectionGeneration,
    source: input.source,
    movementRequestId: null
  };
  const radius = interactionRadius(input.kind);
  if (distanceMeters(input.player, input.structure) <= radius) {
    return { kind: "open_now", intent };
  }
  return {
    kind: "approach",
    intent,
    target: cityStructureApproachPoint(input.player, input.structure, radius)
  };
}

export function attachCityStructureMovement(
  intent: CityStructureInteractionIntent,
  movementRequestId: string
): CityStructureInteractionIntent {
  return { ...intent, movementRequestId };
}

export function advanceCityStructureInteraction(input: {
  intent: CityStructureInteractionIntent;
  structure: CityStructureSnapshot | null;
  player: Readonly<{ lat: number; lon: number; moving: boolean }> | null;
  movement: Readonly<{ requestId: string; accepted: boolean }> | null;
  connectionGeneration: number;
}): CityStructureInteractionTransition {
  if (!cityStructureIntentStillValid(input)) return "cancel";
  if (
    input.intent.movementRequestId === null ||
    input.movement === null ||
    input.movement.requestId !== input.intent.movementRequestId
  ) return "cancel";
  if (!input.player || !input.movement.accepted || input.player.moving) return "waiting";
  return cityStructureInteractionReady(input) ? "ready" : "unreachable";
}

export function cityStructureInteractionReady(input: {
  intent: CityStructureInteractionIntent;
  structure: CityStructureSnapshot | null;
  player: Readonly<{ lat: number; lon: number; moving: boolean }> | null;
  connectionGeneration: number;
}): boolean {
  const { intent, structure, player } = input;
  return Boolean(
    structure &&
    player &&
    !player.moving &&
    structure.structureId === intent.structureId &&
    structure.type === intent.kind &&
    structure.state === "active" &&
    structure.placementRevision === intent.placementRevision &&
    input.connectionGeneration === intent.connectionGeneration &&
    distanceMeters(player, structure) <= interactionRadius(intent.kind)
  );
}

export function cityStructureIntentStillValid(input: {
  intent: CityStructureInteractionIntent;
  structure: CityStructureSnapshot | null;
  connectionGeneration: number;
}): boolean {
  return Boolean(
    input.structure &&
    input.structure.structureId === input.intent.structureId &&
    input.structure.type === input.intent.kind &&
    input.structure.state === "active" &&
    input.structure.placementRevision === input.intent.placementRevision &&
    input.connectionGeneration === input.intent.connectionGeneration
  );
}

export function cityStructureApproachPoint(
  player: Readonly<{ lat: number; lon: number }>,
  structure: Readonly<{
    lat: number;
    lon: number;
    footprintRadiusM: number;
  }>,
  interactionRadiusM: number
): { lat: number; lon: number } {
  const distance = distanceMeters(player, structure);
  if (distance <= interactionRadiusM) return { lat: player.lat, lon: player.lon };
  const targetCenterDistanceM = Math.max(
    structure.footprintRadiusM + 2,
    interactionRadiusM - 2
  );
  const travelFraction = Math.max(0, (distance - targetCenterDistanceM) / distance);
  return interpolateLatLon(player, structure, travelFraction);
}

function interactionRadius(kind: CityStructureInteractionKind): number {
  return kind === "market"
    ? CITY_MARKET_INTERACTION_RADIUS_M
    : kind === "oil_well"
      ? OIL_WELL_INTERACTION_RADIUS_M
      : kind === "city_kennel" || kind === "salon"
        ? CITY_STRUCTURE_INTERACTION_RADIUS_M
        : CITY_WAREHOUSE_INTERACTION_RADIUS_M;
}
