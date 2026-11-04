import {
  GAMEPLAY_AREA_ARRIVAL_TOLERANCE_M,
  distanceMeters,
  type LatLon,
  type PlayerSnapshot
} from "@ash-atlas/shared";

export const QUEUED_FLAG_BUILD_ARRIVAL_TOLERANCE_M = Math.max(
  GAMEPLAY_AREA_ARRIVAL_TOLERANCE_M,
  6
);

export type QueuedMapBuildAction =
  | Readonly<{ kind: "anchor"; anchorKind?: "flag" | "buoy" }>
  | Readonly<{ kind: "manor" | "furnace" | "tannery" | "butcher" | "loom" | "kitchen" | "fishing" }>
  | Readonly<{ kind: "decoration"; typeId: string }>;

export type QueuedMapFlagBuild = Readonly<{
  requestId: string;
  target: LatLon;
  requested: LatLon;
  authority: {
    anchorLat: number;
    anchorLon: number;
    moveLeashRadiusM: number;
    relocationRevision: number;
  };
  createdAt: number;
  status: "queued" | "accepted";
  acceptedMovementRevision: number | null;
  action: QueuedMapBuildAction;
}>;

export type QueuedMapFlagBuildObservation =
  | "waiting"
  | "arrived"
  | "authority-changed"
  | "movement-stopped-away";

export class QueuedMapFlagBuildController {
  private current: QueuedMapFlagBuild | null = null;

  queue(input: Omit<QueuedMapFlagBuild, "status" | "acceptedMovementRevision">): QueuedMapFlagBuild {
    this.current = { ...input, status: "queued", acceptedMovementRevision: null };
    return this.snapshot()!;
  }

  accept(requestId: string, movementRevision: number): QueuedMapFlagBuild | null {
    if (!this.current || this.current.requestId !== requestId) return null;
    this.current = {
      ...this.current,
      status: "accepted",
      acceptedMovementRevision: movementRevision
    };
    return this.snapshot();
  }

  reject(requestId: string | undefined): boolean {
    if (!this.current || this.current.requestId !== requestId) return false;
    this.current = null;
    return true;
  }

  observe(
    player: PlayerSnapshot,
    placementSurfaceReady = true
  ): QueuedMapFlagBuildObservation {
    const queued = this.current;
    if (!queued) return "waiting";
    if (!sameAuthority(queued, player)) {
      this.current = null;
      return "authority-changed";
    }
    if (
      queued.status !== "accepted" ||
      queued.acceptedMovementRevision === null ||
      player.movementRevision < queued.acceptedMovementRevision ||
      player.moving
    ) {
      return "waiting";
    }
    if (
      distanceMeters(player, queued.target) >
        QUEUED_FLAG_BUILD_ARRIVAL_TOLERANCE_M
    ) {
      this.current = null;
      return "movement-stopped-away";
    }
    if (!placementSurfaceReady) return "waiting";
    this.current = null;
    return "arrived";
  }

  cancel(): boolean {
    if (!this.current) return false;
    this.current = null;
    return true;
  }

  snapshot(): QueuedMapFlagBuild | null {
    return this.current
      ? {
          ...this.current,
          target: { ...this.current.target },
          requested: { ...this.current.requested },
          authority: { ...this.current.authority }
        }
      : null;
  }
}

function sameAuthority(queued: QueuedMapFlagBuild, player: PlayerSnapshot): boolean {
  return queued.authority.anchorLat === player.anchorLat &&
    queued.authority.anchorLon === player.anchorLon &&
    queued.authority.moveLeashRadiusM === player.moveLeashRadiusM &&
    queued.authority.relocationRevision === (player.relocationRevision ?? 0);
}
