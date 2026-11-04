import type { LatLon } from "@ash-atlas/shared";
import type pg from "pg";

import { SpatialHashGrid } from "./combat/spatialGrid.js";

/** How far a player sees a building; Voyager Tactics build speed needs none within this range. */
export const PLAYER_BUILDING_VISIBLE_RADIUS_M = 280;
const DEFAULT_REFRESH_MS = 60_000;
const CELL_SIZE_M = 500;

type BuildingRow = { id: string; lat: number; lon: number };
type Queryable = Pick<pg.Pool, "query">;

/**
 * An in-memory spatial index of player buildings (flags, active city structures, built manors),
 * reloaded from one query on an interval. Combat reads it synchronously, so the Tactics tick never
 * touches the database. Until the first load completes it reports buildings everywhere, which
 * only withholds the bonus.
 */
export class PlayerBuildingIndex {
  private grid: SpatialHashGrid | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly pool: Queryable,
    private readonly refreshMs: number = DEFAULT_REFRESH_MS
  ) {}

  start(): void {
    if (this.timer) return;
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  hasBuildingNear(position: LatLon, radiusM: number = PLAYER_BUILDING_VISIBLE_RADIUS_M): boolean {
    if (!this.grid) return true;
    return this.grid.query(position, radiusM).length > 0;
  }

  private async load(): Promise<void> {
    const result = await this.pool.query<BuildingRow>(
      `SELECT 'flag:' || id::text AS id, lat, lon FROM flags
       UNION ALL
       SELECT 'structure:' || structure_id::text, lat, lon FROM city_structures WHERE state <> 'destroyed'
       UNION ALL
       SELECT 'manor:' || id::text, world_lat, world_lon FROM player_manors
        WHERE built_at IS NOT NULL AND world_lat IS NOT NULL AND world_lon IS NOT NULL`
    );
    const grid = new SpatialHashGrid(CELL_SIZE_M);
    for (const row of result.rows) grid.insert(row.id, { lat: Number(row.lat), lon: Number(row.lon) });
    this.grid = grid;
  }
}
