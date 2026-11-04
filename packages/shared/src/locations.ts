export const LOCATION_TYPES = ["manor", "salon", "cistern_warrens", "dungeon", "greenhouse"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export type WorldLocationSnapshot = Readonly<{
  kind: "world";
  regionCode: string;
  zoneId: string;
  position: Readonly<{ lat: number; lon: number }>;
  revision: number;
  lastPortalId?: string;
}>;

export type InteriorLocationSnapshot = Readonly<{
  kind: "interior";
  locationType: LocationType;
  locationId: string;
  instanceId: string;
  spaceId: string;
  regionCode: string;
  zoneId: string;
  position: Readonly<{ x: number; y: number }>;
  facing?: number;
  revision: number;
  lastPortalId: string;
}>;

export type PlayerLocationSnapshot = WorldLocationSnapshot | InteriorLocationSnapshot;

export type LocationCapabilities = Readonly<{
  movement: boolean;
  inventory: boolean;
  equipment: boolean;
  chat: boolean;
  party: boolean;
  abilities: boolean;
  combat: boolean;
  building: boolean;
  worldMap: boolean;
  appearanceEditor: boolean;
}>;

export const WORLD_LOCATION_CAPABILITIES: LocationCapabilities = Object.freeze({
  movement: true, inventory: true, equipment: true, chat: true, party: true,
  abilities: true, combat: true, building: true, worldMap: true,
  appearanceEditor: false
});

export const INTERIOR_LOCATION_CAPABILITIES = Object.freeze({
  manor: Object.freeze({
    movement: true, inventory: true, equipment: true, chat: true, party: true,
    abilities: false, combat: false, building: false, worldMap: false,
    appearanceEditor: false
  }),
  salon: Object.freeze({
    movement: true, inventory: true, equipment: true, chat: true, party: true,
    abilities: false, combat: false, building: false, worldMap: false,
    appearanceEditor: true
  }),
  cistern_warrens: Object.freeze({
    movement: true, inventory: true, equipment: true, chat: true, party: true,
    abilities: true, combat: true, building: false, worldMap: false,
    appearanceEditor: false
  }),
  dungeon: Object.freeze({
    movement: true, inventory: true, equipment: true, chat: true, party: true,
    abilities: true, combat: true, building: false, worldMap: false,
    appearanceEditor: false
  }),
  greenhouse: Object.freeze({
    movement: true, inventory: true, equipment: true, chat: true, party: true,
    abilities: false, combat: false, building: false, worldMap: false,
    appearanceEditor: false
  })
} satisfies Record<LocationType, LocationCapabilities>);

export function interiorRegionCode(instanceId: string): string {
  return `interior:${instanceId}`;
}

export function interiorZoneId(instanceId: string, spaceId: string): string {
  return `${interiorRegionCode(instanceId)}:${spaceId}`;
}

export type PortalPresentation = "door" | "stairs" | "ladder" | "hatch" | "cave";

export type PortalWorldEndpoint = Readonly<{
  kind: "world";
  regionCode: string;
  position: Readonly<{ lat: number; lon: number }>;
}>;

export type PortalInteriorEndpoint = Readonly<{
  kind: "interior";
  locationType: LocationType;
  locationId: string;
  instanceId: string;
  spaceId: string;
  position: Readonly<{ x: number; y: number }>;
  facing?: number;
}>;

export type PortalEndpoint = PortalWorldEndpoint | PortalInteriorEndpoint;

export type PortalDefinition = Readonly<{
  portalId: string;
  source: PortalEndpoint;
  destination: PortalEndpoint;
  sourceApproach: PortalEndpoint["position"];
  sourceThreshold: PortalEndpoint["position"];
  destinationArrival: PortalEndpoint["position"];
  /** Some explicit actions may commit without an approach movement. */
  approachPolicy?: "required" | "immediate";
  pairedPortalId?: string;
  interactionLabel: string;
  transitionPresentation: PortalPresentation;
  accessPolicyId?: string;
  preloadSceneKey?: string;
  enabled: boolean;
  revision: string;
}>;

export type PortalTransitionPhase =
  | "approaching"
  | "threshold_reached"
  | "waiting_for_destination"
  | "covered"
  | "committing";

export function sameLocationInstance(
  left: PlayerLocationSnapshot,
  right: PlayerLocationSnapshot
): boolean {
  return left.kind === "interior" && right.kind === "interior" &&
    left.instanceId === right.instanceId;
}

export const portalIds = Object.freeze({
  manorWorldToMain: (manorId: string) => `manor:${manorId}:world-to-main`,
  manorMainToWorld: (manorId: string) => `manor:${manorId}:main-to-world`,
  manorWorldToFoyer: (manorId: string) => `manor:${manorId}:world-to-foyer`,
  manorFoyerToWorld: (manorId: string) => `manor:${manorId}:foyer-to-world`,
  manorFoyerToMain: (manorId: string) => `manor:${manorId}:foyer-to-main`,
  manorMainToFoyer: (manorId: string) => `manor:${manorId}:main-to-foyer`,
  salonWorldToMain: (structureId: string) => `salon:${structureId}:world-to-main`,
  salonMainToWorld: (structureId: string) => `salon:${structureId}:main-to-world`,
  sewerWorldToEntrance: (structureId: string) => `sewer:${structureId}:world-to-entrance`,
  sewerEntranceToWorld: (structureId: string) => `sewer:${structureId}:entrance-to-world`,
  sewerHatchToOverflow: (structureId: string) => `sewer:${structureId}:hatch-to-overflow`,
  sewerOverflowToHatch: (structureId: string) => `sewer:${structureId}:overflow-to-hatch`
  ,
  greenhouseWorldToMain: (greenhouseId: string) => `greenhouse:${greenhouseId}:world-to-main`,
  greenhouseMainToWorld: (greenhouseId: string) => `greenhouse:${greenhouseId}:main-to-world`,
  dungeon: (entranceId: string, portalId: string) => `dungeon:${entranceId}:${portalId}`
});
