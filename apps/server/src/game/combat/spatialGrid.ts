import { distanceMeters, type LatLon } from "@ash-atlas/shared";

const EARTH_RADIUS_M = 6_371_008.8;
const MAX_MERCATOR_LAT = 85.05112878;
const WORLD_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;
const MAX_DENSE_CELL_RADIUS = 256;

export class SpatialHashGrid {
  private readonly cells = new Map<string, Set<string>>();
  private readonly entityCells = new Map<string, string>();
  private readonly positions = new Map<string, LatLon>();
  private queryCount = 0;

  constructor(readonly cellSizeM: number) {
    if (!Number.isFinite(cellSizeM) || cellSizeM <= 0) {
      throw new Error("spatial cell size must be positive");
    }
  }

  insert(entityId: string, position: LatLon): void {
    this.remove(entityId);
    const cell = this.cellKeyFor(position);
    this.entityCells.set(entityId, cell);
    this.positions.set(entityId, { ...position });
    let members = this.cells.get(cell);
    if (!members) {
      members = new Set();
      this.cells.set(cell, members);
    }
    members.add(entityId);
  }

  update(entityId: string, position: LatLon): void {
    const nextCell = this.cellKeyFor(position);
    const previousCell = this.entityCells.get(entityId);
    this.positions.set(entityId, { ...position });
    if (previousCell === nextCell) {
      return;
    }
    if (previousCell) {
      this.removeFromCell(previousCell, entityId);
    }
    this.entityCells.set(entityId, nextCell);
    let members = this.cells.get(nextCell);
    if (!members) {
      members = new Set();
      this.cells.set(nextCell, members);
    }
    members.add(entityId);
  }

  remove(entityId: string): void {
    const cell = this.entityCells.get(entityId);
    if (cell) {
      this.removeFromCell(cell, entityId);
    }
    this.entityCells.delete(entityId);
    this.positions.delete(entityId);
  }

  query(position: LatLon, radiusM: number): string[] {
    this.queryCount += 1;
    const projectedRadiusM = projectedSearchRadiusM(position, radiusM);
    return this.filterCandidates(
      position,
      radiusM,
      this.candidatesForProjectedPosition(
        position,
        Math.ceil(projectedRadiusM / this.cellSizeM) + 1
      )
    );
  }

  candidatesForCell(cellKey: string, radiusM: number): string[] {
    this.queryCount += 1;
    return this.candidatesForCellRadius(cellKey, Math.ceil(radiusM / this.cellSizeM) + 1);
  }

  candidatesForPosition(position: LatLon, radiusM: number): string[] {
    this.queryCount += 1;
    const projectedRadiusM = projectedSearchRadiusM(position, radiusM);
    return this.candidatesForProjectedPosition(
      position,
      Math.ceil(projectedRadiusM / this.cellSizeM) + 1
    );
  }

  private candidatesForProjectedPosition(
    position: LatLon,
    radiusCells: number
  ): string[] {
    const projected = projectMeters(position);
    const cellY = Math.floor(projected.y / this.cellSizeM);
    // Reuse the occupied-cell scan when it visits fewer cells than all three wrapped windows.
    const windowCellCount = 3 * (2 * radiusCells + 1) ** 2;
    if (radiusCells > MAX_DENSE_CELL_RADIUS || this.cells.size < windowCellCount) {
      return this.candidatesFromOccupiedCells(projected.x, cellY, radiusCells);
    }
    const candidates = new Set<string>();
    for (const xOffsetM of [-WORLD_CIRCUMFERENCE_M, 0, WORLD_CIRCUMFERENCE_M]) {
      const cellX = Math.floor((projected.x + xOffsetM) / this.cellSizeM);
      for (const entityId of this.candidatesForCellRadius(
        `${cellX}:${cellY}`,
        radiusCells
      )) {
        candidates.add(entityId);
      }
    }
    return [...candidates].sort();
  }

  private candidatesFromOccupiedCells(
    projectedX: number,
    cellY: number,
    radiusCells: number
  ): string[] {
    const queryCellXs = [-WORLD_CIRCUMFERENCE_M, 0, WORLD_CIRCUMFERENCE_M]
      .map((offsetM) => Math.floor((projectedX + offsetM) / this.cellSizeM));
    const candidates = new Set<string>();
    for (const [cellKey, entityIds] of this.cells) {
      const [cellX, occupiedCellY] = cellKey.split(":").map(Number);
      if (
        !Number.isInteger(cellX) ||
        !Number.isInteger(occupiedCellY) ||
        Math.abs(occupiedCellY! - cellY) > radiusCells ||
        !queryCellXs.some((queryCellX) => Math.abs(cellX! - queryCellX) <= radiusCells)
      ) {
        continue;
      }
      for (const entityId of entityIds) candidates.add(entityId);
    }
    return [...candidates].sort();
  }

  private candidatesForCellRadius(cellKey: string, radiusCells: number): string[] {
    const [cellX, cellY] = cellKey.split(":").map(Number);
    if (!Number.isInteger(cellX) || !Number.isInteger(cellY)) {
      return [];
    }
    const candidates = new Set<string>();
    for (let x = cellX! - radiusCells; x <= cellX! + radiusCells; x += 1) {
      for (let y = cellY! - radiusCells; y <= cellY! + radiusCells; y += 1) {
        for (const entityId of this.cells.get(`${x}:${y}`) ?? []) {
          candidates.add(entityId);
        }
      }
    }
    return [...candidates].sort();
  }

  filterCandidates(position: LatLon, radiusM: number, candidates: Iterable<string>): string[] {
    return [...candidates]
      .filter((entityId) => {
        const candidate = this.positions.get(entityId);
        return candidate ? distanceMeters(position, candidate) <= radiusM : false;
      })
      .sort();
  }

  consumeQueryCount(): number {
    const count = this.queryCount;
    this.queryCount = 0;
    return count;
  }

  get size(): number {
    return this.positions.size;
  }

  cellKeyFor(position: LatLon): string {
    const projected = projectMeters(position);
    return `${Math.floor(projected.x / this.cellSizeM)}:${Math.floor(
      projected.y / this.cellSizeM
    )}`;
  }

  private removeFromCell(cell: string, entityId: string): void {
    const members = this.cells.get(cell);
    members?.delete(entityId);
    if (members?.size === 0) {
      this.cells.delete(cell);
    }
  }
}

function projectMeters(position: LatLon): { x: number; y: number } {
  const lat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, position.lat));
  const lonRadians = (position.lon * Math.PI) / 180;
  const latRadians = (lat * Math.PI) / 180;
  return {
    x: EARTH_RADIUS_M * lonRadians,
    y: EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latRadians / 2))
  };
}

function projectedSearchRadiusM(position: LatLon, radiusM: number): number {
  const latitude = Math.max(-90, Math.min(90, position.lat));
  return radiusM / Math.max(
    Math.abs(Math.cos((latitude * Math.PI) / 180)),
    Number.EPSILON
  );
}
