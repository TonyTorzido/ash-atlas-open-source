import type { WorldMapDestination } from "@ash-atlas/shared";

export const WORLD_MAP_CLUSTER_RADIUS_PX = 62;

type ScreenPoint = Readonly<{ x: number; y: number }>;

export type WorldMapDestinationCluster = Readonly<{
  id: string;
  destinations: readonly WorldMapDestination[];
  screenCenter: ScreenPoint;
}>;

type MutableCluster = {
  seed: ScreenPoint;
  points: Array<Readonly<{ destination: WorldMapDestination; point: ScreenPoint }>>;
};

export function clusterWorldMapDestinations(
  destinations: readonly WorldMapDestination[],
  project: (destination: WorldMapDestination) => ScreenPoint,
  radiusPx = WORLD_MAP_CLUSTER_RADIUS_PX,
  /** Pinned destinations (major hubs) are never absorbed into a cluster. */
  isPinned: (destination: WorldMapDestination) => boolean = () => false
): WorldMapDestinationCluster[] {
  const pinnedClusters: WorldMapDestinationCluster[] = destinations
    .filter(isPinned)
    .map((destination) => ({
      id: destinationKey(destination),
      destinations: [destination],
      screenCenter: project(destination)
    }));
  const points = destinations
    .filter((destination) => !isPinned(destination))
    .map((destination) => ({ destination, point: project(destination) }))
    .sort((left, right) =>
      left.point.x - right.point.x ||
      left.point.y - right.point.y ||
      destinationKey(left.destination).localeCompare(destinationKey(right.destination))
    );
  const clusters: MutableCluster[] = [];

  for (const candidate of points) {
    let closest: MutableCluster | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const cluster of clusters) {
      const distance = Math.hypot(
        candidate.point.x - cluster.seed.x,
        candidate.point.y - cluster.seed.y
      );
      if (distance <= radiusPx && distance < closestDistance) {
        closest = cluster;
        closestDistance = distance;
      }
    }
    if (closest) closest.points.push(candidate);
    else clusters.push({ seed: candidate.point, points: [candidate] });
  }

  return [...pinnedClusters, ...clusters.map((cluster) => {
    const screenCenter = {
      x: cluster.points.reduce((sum, item) => sum + item.point.x, 0) / cluster.points.length,
      y: cluster.points.reduce((sum, item) => sum + item.point.y, 0) / cluster.points.length
    };
    const clusteredDestinations = cluster.points
      .map(({ destination }) => destination)
      .sort((left, right) => destinationKey(left).localeCompare(destinationKey(right)));
    return {
      id: clusteredDestinations.map(destinationKey).join("|"),
      destinations: clusteredDestinations,
      screenCenter
    };
  })];
}

function destinationKey(destination: WorldMapDestination): string {
  return `${destination.kind}:${destination.id}`;
}
