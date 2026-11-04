import type {
  FlagPlacementTerrain,
  FlagSnapshot,
  PersonalAnchorKind,
  PlayerSnapshot
} from "@ash-atlas/shared";
import {
  distanceMeters,
  resolveTerritoryAtPoint
} from "@ash-atlas/shared";

export type FlagPlacementPreviewState = "valid" | "touching" | "overlap";

export type BuildableStatus = {
  buildable: boolean;
  reason: string | null;
  edgeDistanceM: number | null;
  territoryOwnerId: string | null;
  territoryOwnerName: string | null;
  territoryOwnerColor: string | null;
  territoryLabel: string;
  label: string;
  guidance: string;
  serverMessage: string | null;
  previewState: FlagPlacementPreviewState;
};

export function personalAnchorKindForTerrain(
  terrain: FlagPlacementTerrain
): PersonalAnchorKind | null {
  return terrain === "land" ? "flag" : terrain === "water" ? "buoy" : null;
}

export function isFlagPlacementTargetClaimed(
  point: { lat: number; lon: number },
  flags: FlagSnapshot[]
): boolean {
  return resolveTerritoryAtPoint({
    ...point,
    flags
  }).claimed;
}

export function getBuildableStatus(
  player: PlayerSnapshot | null,
  flags: FlagSnapshot[],
  terrain: FlagPlacementTerrain = "land",
  anchorKind: PersonalAnchorKind = "flag"
): BuildableStatus {
  if (!player) {
    return {
      buildable: false,
      reason: "no player position",
      edgeDistanceM: null,
      territoryOwnerId: null,
      territoryOwnerName: null,
      territoryOwnerColor: null,
      territoryLabel: "Unknown",
      label: "Buildable: No - no player position",
      guidance: "No player position yet.",
      serverMessage: null,
      previewState: "overlap"
    };
  }
  if (terrain === "water" && anchorKind === "flag") {
    return {
      buildable: false,
      reason: "water",
      edgeDistanceM: null,
      territoryOwnerId: null,
      territoryOwnerName: null,
      territoryOwnerColor: null,
      territoryLabel: "Water",
      label: "Buildable: No - water",
      guidance: "Cannot place flag on water",
      serverMessage: "Cannot place flag on water",
      previewState: "overlap"
    };
  }
  if (terrain !== "water" && anchorKind === "buoy") {
    const pending = terrain === "unknown";
    return {
      buildable: false,
      reason: pending ? "terrain unknown" : "land",
      edgeDistanceM: null,
      territoryOwnerId: null,
      territoryOwnerName: null,
      territoryOwnerColor: null,
      territoryLabel: pending ? "Unknown" : "Land",
      label: pending ? "Buildability: water check pending" : "Buildable: No - land",
      guidance: pending ? "Water check pending; the server will verify placement" : "Buoys can only be placed on water",
      serverMessage: pending ? null : "Cannot place buoy on land",
      previewState: "overlap"
    };
  }
  const playerPoint = { lat: player.lat, lon: player.lon };
  const territory = resolveTerritoryAtPoint({
    ...playerPoint,
    flags
  });
  if (!territory.claimed) {
    const nearest = territory.distanceToNearestClaimEdgeM;
    if (terrain === "unknown") {
      return {
        buildable: true,
        reason: "terrain unknown",
        edgeDistanceM: nearest,
        territoryOwnerId: null,
        territoryOwnerName: null,
        territoryOwnerColor: null,
        territoryLabel: "Open",
        label: "Buildability: terrain check pending",
        guidance: "Terrain check pending; the server will verify placement",
        serverMessage: null,
        previewState: "valid"
      };
    }
    if (nearest !== null) {
      return {
        buildable: true,
        reason: null,
        edgeDistanceM: nearest,
        territoryOwnerId: null,
        territoryOwnerName: null,
        territoryOwnerColor: null,
        territoryLabel: "Open",
        label: `Buildable: Yes - nearest territory edge ${formatDistance(nearest)}`,
        guidance: anchorKind === "buoy" ? "Open water: ready to build" : "Open land: ready to build",
        serverMessage: null,
        previewState: "valid"
      };
    }
    return {
      buildable: true,
      reason: null,
      edgeDistanceM: null,
      territoryOwnerId: null,
      territoryOwnerName: null,
      territoryOwnerColor: null,
      territoryLabel: "Open",
      label: "Buildable: Yes - no claimed territory nearby",
      guidance: anchorKind === "buoy" ? "Open water: ready to build" : "Open land: ready to build",
      serverMessage: null,
      previewState: "valid"
    };
  }

  const ownerName = territory.ownerUsername ?? territory.ownerPlayerId;
  const ownTerritory = territory.ownerPlayerId === player.playerId;
  const distance = formatDistance(territory.distanceToNearestClaimEdgeM ?? 0);
  const ownerLabel = ownTerritory
    ? "your claimed territory"
    : ownerName
      ? `${ownerName}'s claimed territory`
      : "claimed territory";
  const flagLabel = territory.nearestFlagName ?? "Flag";
  const serverMessage = ownTerritory
    ? "Cannot build here: inside your claimed territory"
    : ownerName
      ? `Cannot build here: inside ${ownerName}'s claimed territory`
      : "Cannot build here: inside claimed territory";

  return {
    buildable: false,
    reason: ownTerritory ? "inside own territory" : "inside other territory",
    edgeDistanceM: -(territory.distanceToNearestClaimEdgeM ?? 0),
    territoryOwnerId: territory.ownerPlayerId,
    territoryOwnerName: territory.ownerUsername,
    territoryOwnerColor: territory.ownerColor,
    territoryLabel: ownTerritory ? "Yours" : ownerName ?? "Claimed",
    label: `Buildable: No - inside ${ownerLabel} by ${distance}`,
    guidance: `Inside ${flagLabel} (${ownerLabel}) by ${distance}. Move outside its boundary to build.`,
    serverMessage,
    previewState: "overlap"
  };
}

export function nearestTerritoryEdgeDistanceM(
  point: { lat: number; lon: number },
  flags: FlagSnapshot[]
): number | null {
  let nearest: number | null = null;
  for (const flag of flags) {
    const edgeDistance =
      distanceMeters(point, { lat: flag.lat, lon: flag.lon }) - flag.claimRadiusM;
    nearest = nearest === null ? edgeDistance : Math.min(nearest, edgeDistance);
  }
  return nearest;
}

export function formatDistance(distanceM: number): string {
  if (distanceM < 1_000) {
    return `${Math.round(distanceM)} m`;
  }
  return `${(distanceM / 1_609.344).toFixed(2)} mi`;
}
