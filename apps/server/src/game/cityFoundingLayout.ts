import {
  TERRITORY_EDGE_TOLERANCE_M,
  wgs84DestinationPoint,
  wgs84DistanceMeters,
  type LatLon
} from "@ash-atlas/shared";

export const CITY_FOUNDING_EXPANSION_COUNT = 5;
export const CITY_FOUNDING_INITIAL_FLAG_COUNT = CITY_FOUNDING_EXPANSION_COUNT + 1;
export const CITY_FOUNDING_ROTATION_STEP_DEGREES = 4;
export const CITY_FOUNDING_MAX_RADIAL_ADJUSTMENT_M = 100;

export type CityFoundingLayoutCandidate = {
  rotationDegrees: number;
  radiusM: number;
  slots: Array<{
    index: number;
    bearingDegrees: number;
    position: LatLon;
  }>;
};

export type CityFoundingPersonalCircle = {
  id: string;
  ownerId: string;
  position: LatLon;
  radiusM: number;
};

export type CityFoundingBlockingCircle = {
  id: string;
  position: LatLon;
  radiusM: number;
};

export type CityFoundingResolvedSlot = {
  index: number;
  bearingDegrees: number;
  position: LatLon;
  radiusM: number;
  worldPointIndex: number;
};

export type CityFoundingResolvedLayout = {
  rotationDegrees: number;
  radiusM: number;
  annexedFlagIds: string[];
  slots: CityFoundingResolvedSlot[];
};

type IndexedCandidate = CityFoundingResolvedSlot & {
  rotationDegrees: number;
  ringRadiusM: number;
  order: number;
};

export function buildCityFoundingLayoutCandidates(
  center: LatLon,
  centerRadiusM: number,
  expansionRadiusM: number
): CityFoundingLayoutCandidate[] {
  const pentagonNeighborFactor = 2 * Math.sin(Math.PI / CITY_FOUNDING_EXPANSION_COUNT);
  const legalCenterDistanceM = Math.max(
    centerRadiusM,
    expansionRadiusM / pentagonNeighborFactor
  ) + TERRITORY_EDGE_TOLERANCE_M + 0.01;
  const maximumConnectedDistanceM =
    centerRadiusM + expansionRadiusM + TERRITORY_EDGE_TOLERANCE_M;
  const maximumAdjustmentM = Math.min(
    CITY_FOUNDING_MAX_RADIAL_ADJUSTMENT_M,
    Math.max(0, maximumConnectedDistanceM - legalCenterDistanceM)
  );
  const radialAdjustments = [...new Set([
    0,
    Math.min(25, maximumAdjustmentM),
    Math.min(50, maximumAdjustmentM),
    Math.min(75, maximumAdjustmentM),
    maximumAdjustmentM
  ].map((value) => Number(value.toFixed(6))))];
  const layouts: CityFoundingLayoutCandidate[] = [];
  for (const radialAdjustmentM of radialAdjustments) {
    const radiusM = legalCenterDistanceM + radialAdjustmentM;
    for (
      let rotationDegrees = 0;
      rotationDegrees < 360 / CITY_FOUNDING_EXPANSION_COUNT;
      rotationDegrees += CITY_FOUNDING_ROTATION_STEP_DEGREES
    ) {
      layouts.push({
        rotationDegrees,
        radiusM,
        slots: Array.from({ length: CITY_FOUNDING_EXPANSION_COUNT }, (_, index) => {
          const bearingDegrees =
            rotationDegrees + index * 360 / CITY_FOUNDING_EXPANSION_COUNT;
          return {
            index,
            bearingDegrees,
            position: wgs84DestinationPoint(center, radiusM, bearingDegrees)
          };
        })
      });
    }
  }
  return layouts;
}

export function resolveCityFoundingLayout(input: {
  center: LatLon;
  centerRadiusM: number;
  expansionRadiusM: number;
  layouts: CityFoundingLayoutCandidate[];
  personalCircles: CityFoundingPersonalCircle[];
  blockingCircles: CityFoundingBlockingCircle[];
  protectedCircles: CityFoundingBlockingCircle[];
  isNewCircleTerrainLegal(worldPointIndex: number): boolean;
}): CityFoundingResolvedLayout | null {
  const annexedFlagIds = input.personalCircles
    .map(({ id }) => id)
    .sort((left, right) => left.localeCompare(right));
  const missingCount = Math.max(
    0,
    CITY_FOUNDING_EXPANSION_COUNT - annexedFlagIds.length
  );
  if (missingCount === 0) {
    return {
      rotationDegrees: 0,
      radiusM: input.layouts[0]?.radiusM ?? input.centerRadiusM,
      annexedFlagIds,
      slots: []
    };
  }

  const candidates = indexCandidates(input.layouts, input.expansionRadiusM);
  if (input.personalCircles.length === 0) {
    const fullRing = resolveExistingFullRing(input, candidates);
    if (fullRing) return { ...fullRing, annexedFlagIds };
  }

  const coverageBearings = input.personalCircles.map(({ position }) =>
    initialBearingDegrees(input.center, position)
  );
  const legalCandidates = candidates.filter((candidate) =>
    isCandidateLegal(input, candidate, [])
  );
  const selected = selectWeakSideCandidates(
    legalCandidates,
    [],
    coverageBearings,
    missingCount,
    buildCandidateCompatibility(legalCandidates)
  );
  if (!selected) return null;

  return {
    rotationDegrees: selected[0]?.rotationDegrees ?? 0,
    radiusM: selected[0]?.ringRadiusM ?? input.layouts[0]?.radiusM ?? input.centerRadiusM,
    annexedFlagIds,
    slots: selected.map((candidate, index) => ({
      index,
      bearingDegrees: candidate.bearingDegrees,
      position: candidate.position,
      radiusM: candidate.radiusM,
      worldPointIndex: candidate.worldPointIndex
    }))
  };
}

function selectWeakSideCandidates(
  candidates: IndexedCandidate[],
  selected: IndexedCandidate[],
  coverageBearings: number[],
  targetCount: number,
  compatibility: Map<number, Set<number>>
): IndexedCandidate[] | null {
  if (selected.length === targetCount) return selected;
  const remainingCount = targetCount - selected.length;
  if (candidates.length < remainingCount) return null;
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      weakSideScore: coverageBearings.length === 0
        ? 360
        : Math.min(...coverageBearings.map((bearing) =>
            angularDistanceDegrees(candidate.bearingDegrees, bearing)
          ))
    }))
    .sort((left, right) =>
      right.weakSideScore - left.weakSideScore ||
      left.candidate.order - right.candidate.order
    );
  for (let index = 0; index < ranked.length; index += 1) {
    const candidate = ranked[index]!.candidate;
    const compatibleOrders = compatibility.get(candidate.order)!;
    const remainingCandidates = ranked
      .slice(index + 1)
      .map(({ candidate: remainingCandidate }) => remainingCandidate)
      .filter((remainingCandidate) => compatibleOrders.has(remainingCandidate.order));
    if (remainingCandidates.length < remainingCount - 1) continue;
    const resolved = selectWeakSideCandidates(
      remainingCandidates,
      [...selected, candidate],
      [...coverageBearings, candidate.bearingDegrees],
      targetCount,
      compatibility
    );
    if (resolved) return resolved;
  }
  return null;
}

function buildCandidateCompatibility(
  candidates: IndexedCandidate[]
): Map<number, Set<number>> {
  const compatibility = new Map<number, Set<number>>(
    candidates.map((candidate) => [candidate.order, new Set<number>()])
  );
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex]!;
      if (hasIllegalSpacing([left, right])) continue;
      compatibility.get(left.order)!.add(right.order);
      compatibility.get(right.order)!.add(left.order);
    }
  }
  return compatibility;
}

function resolveExistingFullRing(
  input: Parameters<typeof resolveCityFoundingLayout>[0],
  candidates: IndexedCandidate[]
): Omit<CityFoundingResolvedLayout, "annexedFlagIds"> | null {
  for (const layout of input.layouts) {
    const slots = candidates.filter((candidate) =>
      candidate.rotationDegrees === layout.rotationDegrees &&
      candidate.ringRadiusM === layout.radiusM
    );
    if (
      slots.length === CITY_FOUNDING_EXPANSION_COUNT &&
      slots.every((candidate) => isCandidateLegal(input, candidate, [])) &&
      !hasIllegalSpacing(slots)
    ) {
      return {
        rotationDegrees: layout.rotationDegrees,
        radiusM: layout.radiusM,
        slots: slots.map((candidate) => ({
          index: candidate.index,
          bearingDegrees: candidate.bearingDegrees,
          position: candidate.position,
          radiusM: candidate.radiusM,
          worldPointIndex: candidate.worldPointIndex
        }))
      };
    }
  }
  return null;
}

function indexCandidates(
  layouts: CityFoundingLayoutCandidate[],
  expansionRadiusM: number
): IndexedCandidate[] {
  let worldPointIndex = 0;
  return layouts.flatMap((layout) =>
    layout.slots.map((slot) => ({
      index: slot.index,
      bearingDegrees: normalizeBearingDegrees(slot.bearingDegrees),
      position: slot.position,
      radiusM: expansionRadiusM,
      worldPointIndex: worldPointIndex,
      rotationDegrees: layout.rotationDegrees,
      ringRadiusM: layout.radiusM,
      order: worldPointIndex++
    }))
  );
}

function isCandidateLegal(
  input: Parameters<typeof resolveCityFoundingLayout>[0],
  candidate: IndexedCandidate,
  selected: IndexedCandidate[]
): boolean {
  if (!input.isNewCircleTerrainLegal(candidate.worldPointIndex)) return false;
  const centerDistanceM = wgs84DistanceMeters(input.center, candidate.position);
  if (
    centerDistanceM <= input.centerRadiusM + TERRITORY_EDGE_TOLERANCE_M ||
    centerDistanceM >
      input.centerRadiusM + candidate.radiusM + TERRITORY_EDGE_TOLERANCE_M
  ) return false;
  if (input.blockingCircles.some((circle) =>
    wgs84DistanceMeters(candidate.position, circle.position) <=
      circle.radiusM + TERRITORY_EDGE_TOLERANCE_M
  )) return false;
  if (input.protectedCircles.some((circle) =>
    wgs84DistanceMeters(candidate.position, circle.position) <
      candidate.radiusM + circle.radiusM - TERRITORY_EDGE_TOLERANCE_M
  )) return false;
  return !hasIllegalSpacing([...selected, candidate]);
}

function hasIllegalSpacing(slots: Array<Pick<CityFoundingResolvedSlot, "position" | "radiusM">>): boolean {
  for (let leftIndex = 0; leftIndex < slots.length; leftIndex += 1) {
    const left = slots[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < slots.length; rightIndex += 1) {
      const right = slots[rightIndex]!;
      if (
        wgs84DistanceMeters(left.position, right.position) <=
          Math.max(left.radiusM, right.radiusM) + TERRITORY_EDGE_TOLERANCE_M
      ) return true;
    }
  }
  return false;
}

function initialBearingDegrees(from: LatLon, to: LatLon): number {
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat * Math.PI / 180;
  const deltaLon = (to.lon - from.lon) * Math.PI / 180;
  return normalizeBearingDegrees(Math.atan2(
    Math.sin(deltaLon) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon)
  ) * 180 / Math.PI);
}

function angularDistanceDegrees(left: number, right: number): number {
  const distance = Math.abs(normalizeBearingDegrees(left) - normalizeBearingDegrees(right));
  return Math.min(distance, 360 - distance);
}

function normalizeBearingDegrees(bearing: number): number {
  return ((bearing % 360) + 360) % 360;
}
