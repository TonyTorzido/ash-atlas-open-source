import { destinationPoint, distanceMeters, type LatLon } from "@ash-atlas/shared";

export const FLAG_ARRIVAL_RADIUS_M = 75;
const ROTATION_CANDIDATE_COUNT = 32;
const POSITION_EPSILON_M = 0.05;

export type FlagArrivalAllocation = Readonly<{
  playerId: string;
  position: LatLon;
  angleRadians: number | null;
  radiusM: number;
  fallback: boolean;
}>;

export function allocateFlagArrivalPositions(input: {
  flagCenter: LatLon;
  arrivingPlayerIds: readonly string[];
  existingPlayerPositions?: readonly LatLon[];
  reservedPositions?: readonly LatLon[];
  radiusM?: number;
  random?: () => number;
  validateCandidate?: (position: LatLon) => boolean;
}): FlagArrivalAllocation[] {
  const playerIds = [...new Set(input.arrivingPlayerIds)];
  if (playerIds.length !== input.arrivingPlayerIds.length) {
    throw new TypeError("arriving player IDs must be unique");
  }
  if (playerIds.length === 0) return [];
  const radiusM = input.radiusM ?? FLAG_ARRIVAL_RADIUS_M;
  if (!Number.isFinite(radiusM) || radiusM <= 0) throw new TypeError("arrival radius must be positive");
  const random = input.random ?? Math.random;
  const randomUnit = normalizeRandom(random());
  const initialAngle = randomUnit * Math.PI * 2;
  const occupied = [...(input.existingPlayerPositions ?? []), ...(input.reservedPositions ?? [])];
  const validate = input.validateCandidate ?? (() => true);

  let best: { score: number; angle: number; positions: LatLon[] } | null = null;
  for (let rotationIndex = 0; rotationIndex < ROTATION_CANDIDATE_COUNT; rotationIndex += 1) {
    const angle = normalizeAngle(initialAngle + (rotationIndex * Math.PI * 2) / ROTATION_CANDIDATE_COUNT);
    const positions = playerIds.map((_, index) => destinationPoint(
      input.flagCenter,
      radiusM,
      radiansToDegrees(angle + (index * Math.PI * 2) / playerIds.length)
    ));
    if (!positions.every(validate) || hasDuplicatePositions(positions)) continue;
    const score = minimumOccupiedSeparation(positions, occupied);
    if (!best || score > best.score + POSITION_EPSILON_M) best = { score, angle, positions };
  }

  if (best) {
    return playerIds.map((playerId, index) => ({
      playerId,
      position: best!.positions[index]!,
      angleRadians: normalizeAngle(best!.angle + (index * Math.PI * 2) / playerIds.length),
      radiusM,
      fallback: false
    }));
  }

  const allocated: FlagArrivalAllocation[] = [];
  for (let index = 0; index < playerIds.length; index += 1) {
    const desiredAngle = normalizeAngle(initialAngle + (index * Math.PI * 2) / playerIds.length);
    const position = findNearbyValidPosition({
      flagCenter: input.flagCenter,
      desiredAngle,
      preferredRadiusM: radiusM,
      validate,
      occupied: [...occupied, ...allocated.map((entry) => entry.position)]
    });
    if (position) {
      allocated.push({ playerId: playerIds[index]!, ...position, fallback: true });
      continue;
    }
    const fallbackRadiusM = index === 0 ? 0 : 0.5;
    allocated.push({
      playerId: playerIds[index]!,
      position: fallbackRadiusM === 0
        ? { ...input.flagCenter }
        : destinationPoint(input.flagCenter, fallbackRadiusM, (index * 360) / playerIds.length),
      angleRadians: fallbackRadiusM === 0 ? null : (index * Math.PI * 2) / playerIds.length,
      radiusM: fallbackRadiusM,
      fallback: true
    });
  }
  return allocated;
}

type Reservation = { playerId: string; position: LatLon; token: symbol; createdAt: number };

export class FlagArrivalReservations {
  private readonly byFlag = new Map<string, Map<string, Reservation>>();

  reserve(input: Parameters<typeof allocateFlagArrivalPositions>[0] & { flagId: string; now?: number }): {
    allocations: FlagArrivalAllocation[];
    release(): void;
  } {
    const now = input.now ?? Date.now();
    this.expire(now);
    const token = Symbol(`flag-arrival:${input.flagId}`);
    const reservations = this.byFlag.get(input.flagId) ?? new Map<string, Reservation>();
    const arriving = new Set(input.arrivingPlayerIds);
    const allocations = allocateFlagArrivalPositions({
      ...input,
      reservedPositions: [
        ...(input.reservedPositions ?? []),
        ...[...reservations.values()]
          .filter((reservation) => !arriving.has(reservation.playerId))
          .map((reservation) => reservation.position)
      ]
    });
    for (const allocation of allocations) {
      reservations.set(allocation.playerId, {
        playerId: allocation.playerId,
        position: allocation.position,
        token,
        createdAt: now
      });
    }
    this.byFlag.set(input.flagId, reservations);
    return {
      allocations,
      release: () => {
        const current = this.byFlag.get(input.flagId);
        if (!current) return;
        for (const playerId of input.arrivingPlayerIds) {
          if (current.get(playerId)?.token === token) current.delete(playerId);
        }
        if (current.size === 0) this.byFlag.delete(input.flagId);
      }
    };
  }

  reservedPositions(flagId: string, now = Date.now()): LatLon[] {
    this.expire(now);
    return [...(this.byFlag.get(flagId)?.values() ?? [])].map((entry) => ({ ...entry.position }));
  }

  private expire(now: number): void {
    for (const [flagId, reservations] of this.byFlag) {
      for (const [playerId, reservation] of reservations) {
        if (now - reservation.createdAt > 30_000) reservations.delete(playerId);
      }
      if (reservations.size === 0) this.byFlag.delete(flagId);
    }
  }
}

function findNearbyValidPosition(input: {
  flagCenter: LatLon;
  desiredAngle: number;
  preferredRadiusM: number;
  validate(position: LatLon): boolean;
  occupied: readonly LatLon[];
}): { position: LatLon; angleRadians: number; radiusM: number } | null {
  const angleOffsets = [0, 5, -5, 10, -10, 20, -20, 30, -30].map((degrees) => degrees * Math.PI / 180);
  const radii = [...new Set([input.preferredRadiusM, 72, 78, 70, 80])];
  for (const radiusM of radii) {
    for (const angleOffset of angleOffsets) {
      const angleRadians = normalizeAngle(input.desiredAngle + angleOffset);
      const position = destinationPoint(input.flagCenter, radiusM, radiansToDegrees(angleRadians));
      if (input.validate(position) && input.occupied.every((occupied) =>
        distanceMeters(position, occupied) > POSITION_EPSILON_M
      )) return { position, angleRadians, radiusM };
    }
  }
  return null;
}

function minimumOccupiedSeparation(positions: readonly LatLon[], occupied: readonly LatLon[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const position of positions) {
    for (const existing of occupied) minimum = Math.min(minimum, distanceMeters(position, existing));
  }
  return minimum;
}

function hasDuplicatePositions(positions: readonly LatLon[]): boolean {
  return positions.some((position, index) => positions.slice(index + 1).some((other) =>
    distanceMeters(position, other) <= POSITION_EPSILON_M
  ));
}

function normalizeRandom(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 1) + 1) % 1;
}

function normalizeAngle(value: number): number {
  return ((value % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}
