import type { WorldMapDestination } from "@ash-atlas/shared";

export function compareWorldMapDestinations(
  left: WorldMapDestination,
  right: WorldMapDestination
): number {
  const priority = destinationPriority(left.kind) - destinationPriority(right.kind);
  return priority || left.name.localeCompare(
    right.name,
    undefined,
    { sensitivity: "base" }
  );
}

function destinationPriority(kind: WorldMapDestination["kind"]): number {
  if (kind === "manor") return 0;
  if (kind === "atlas_shrine") return 1;
  return 2;
}
