import {
  SAPLING_PLANT_TARGET_RANGE_M,
  distanceMeters,
  nearestTreeLatticePoint,
  treeLatticePoint,
  type LatLon
} from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it } from "vitest";

import { GivingSaplingService, SaplingError } from "./givingSaplings.js";
import type { InventoryService } from "./inventory.js";

/**
 * Planting with a planner `target`: the re-snap and range check run before any database access, so
 * these need no database (the full plant path is covered by givingSaplings.integration.test.ts).
 */
const PLAYER: LatLon = { lat: 35.0844, lon: -106.6504 };
const stand = nearestTreeLatticePoint(PLAYER);
const lattice: LatLon = { lat: stand.lat, lon: stand.lon };

function makeService(deps: { terrainAt?: (position: LatLon) => Promise<"land">; nearbyTrees?: () => { id: string; position: LatLon }[] }) {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as pg.Pool;
  return new GivingSaplingService(pool, {} as InventoryService, {
    terrainAt: deps.terrainAt ?? (async () => "land"),
    territoryOwnerAt: async () => null,
    nearbyTrees: deps.nearbyTrees ?? (() => [])
  } as never);
}

const args = (service: { plant: GivingSaplingService["plant"] }, target: LatLon | undefined, position = lattice) =>
  service.plant({
    playerId: "p1", requestId: "r1", regionCode: "GLOBAL", position, source: "berry", target,
    aggressive: false, worldPresent: true
  });

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(SaplingError);
  return (error as SaplingError).code;
}

describe("planting with a planner target", () => {
  it("re-snaps the target to the lattice before applying the world rules", async () => {
    const seen: LatLon[] = [];
    const service = makeService({ terrainAt: async (position) => { seen.push(position); throw new SaplingError("STOP", "stop"); } });
    // Three metres off the lattice point the player stands on.
    const sloppy = { lat: lattice.lat + 3 / 111_195, lon: lattice.lon };
    expect(await code(args(service, sloppy))).toBe("STOP");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.lat).toBeCloseTo(lattice.lat, 12);
    expect(seen[0]!.lon).toBeCloseTo(lattice.lon, 12);
    // A player 90 m away from that point (a lattice neighbour) is out of planting reach.
    const neighbour = treeLatticePoint(stand.row, stand.col + 1);
    expect(await code(args(service, sloppy, neighbour))).toBe("SAPLING_OUT_OF_RANGE");
  });

  it("refuses a target whose lattice point is out of the player's range", async () => {
    let touched = false;
    const service = makeService({ terrainAt: async () => { touched = true; return "land"; } });
    const far = { lat: lattice.lat + 220 / 111_195, lon: lattice.lon };
    expect(distanceMeters(nearestTreeLatticePoint(far), lattice)).toBeGreaterThan(SAPLING_PLANT_TARGET_RANGE_M);
    expect(await code(args(service, far))).toBe("SAPLING_OUT_OF_RANGE");
    expect(touched).toBe(false);
  });

  it("keeps the 90 m spacing rule against known trees at the snapped point", async () => {
    // A known tree 5 m from the snapped point is too close.
    const tree = { lat: lattice.lat + 5 / 111_195, lon: lattice.lon };
    expect(await code(args(makeService({ nearbyTrees: () => [{ id: "wild", position: tree }] }), lattice)))
      .toBe("SAPLING_TOO_CLOSE");
  });
});
