import { describe, expect, it } from "vitest";
import type { Polygon, Ring } from "polygon-clipping";

import {
  FALLBACK_TERRITORY_COLOR,
  TERRITORY_CIRCLE_SEGMENTS,
  clipClaimRingAgainstOpponents,
  createCircleRing,
  isValidClosedRing,
  mergeOwnerTerritoriesWithBoundaries,
  ownerColorForClaim,
  polygonToPathCommands,
  type TerritoryClaimShape
} from "./territoryGeometry.js";

describe("territoryGeometry", () => {
  it("generates a smooth closed circle ring with the configured segment count", () => {
    const ring = createCircleRing([0, 0], 10);

    expect(TERRITORY_CIRCLE_SEGMENTS).toBe(192);
    expect(ring).toHaveLength(TERRITORY_CIRCLE_SEGMENTS + 1);
    expect(isValidClosedRing(ring)).toBe(true);
  });

  it("merges same-owner overlapping territories", () => {
    const groups = mergeOwnerTerritoriesWithBoundaries([
      claim({ id: "a1", ownerId: "owner-a", center: [0, 0], ownerColor: "#aa0000" }),
      claim({ id: "a2", ownerId: "owner-a", center: [7, 0], ownerColor: "#aa0000" })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.ownerId).toBe("owner-a");
    expect(groups[0]?.polygons).toHaveLength(1);
    expect(groups[0]?.zoneCells).toHaveLength(2);
    expect(maxX(groups[0]?.zoneCells.slice(0, 1))).toBeCloseTo(3.5, 6);
    expect(minX(groups[0]?.zoneCells.slice(1))).toBeCloseTo(3.5, 6);
  });

  it("does not create zone seams between different owners", () => {
    const groups = mergeOwnerTerritoriesWithBoundaries([
      claim({ id: "a", ownerId: "owner-a", center: [0, 0] }),
      claim({ id: "b", ownerId: "owner-b", center: [7, 0] })
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every(({ zoneCells }) => zoneCells.length === 0)).toBe(true);
  });

  it("splits opposing equal-radius territories at the midpoint line", () => {
    const left = claim({ id: "a", ownerId: "owner-a", center: [0, 0] });
    const right = claim({ id: "b", ownerId: "owner-b", center: [12, 0] });

    const leftRing = clipClaimRingAgainstOpponents(left, [left, right]);
    const rightRing = clipClaimRingAgainstOpponents(right, [left, right]);

    expect(Math.max(...leftRing.map(([x]) => x))).toBeCloseTo(6, 6);
    expect(Math.min(...rightRing.map(([x]) => x))).toBeCloseTo(6, 6);
    expect(leftRing.every(([x]) => x <= 6.000001)).toBe(true);
    expect(rightRing.every(([x]) => x >= 5.999999)).toBe(true);
    expect(isValidClosedRing(leftRing)).toBe(true);
    expect(isValidClosedRing(rightRing)).toBe(true);
  });

  it("does not create huge stray edges when clipping overlapping circles", () => {
    const left = claim({ id: "a", ownerId: "owner-a", center: [0, 0] });
    const right = claim({ id: "b", ownerId: "owner-b", center: [12, 0] });
    const clipped = clipClaimRingAgainstOpponents(left, [left, right]);

    expect(maxEdgeLength(clipped)).toBeLessThanOrEqual(20.1);
  });

  it("leaves non-overlapping opposing territories unchanged", () => {
    const left = claim({ id: "a", ownerId: "owner-a", center: [0, 0], radius: 10 });
    const right = claim({ id: "b", ownerId: "owner-b", center: [30, 0], radius: 10 });

    expect(clipClaimRingAgainstOpponents(left, [left, right])).toEqual(left.ring);
  });

  it("clips three flags with two owners so opposing territories do not cross the shared boundary", () => {
    const groups = mergeOwnerTerritoriesWithBoundaries([
      claim({ id: "a1", ownerId: "owner-a", center: [0, 0], ownerColor: "#aa0000" }),
      claim({ id: "a2", ownerId: "owner-a", center: [-7, 0], ownerColor: "#aa0000" }),
      claim({ id: "b", ownerId: "owner-b", center: [12, 0], ownerColor: "#0000aa" })
    ]);

    expect(groups).toHaveLength(2);
    const ownerA = groups.find((group) => group.ownerId === "owner-a");
    const ownerB = groups.find((group) => group.ownerId === "owner-b");
    expect(maxX(ownerA?.polygons)).toBeLessThanOrEqual(6.000001);
    expect(minX(ownerB?.polygons)).toBeGreaterThanOrEqual(5.999999);
  });

  it("emits separate path commands for separate polygon rings", () => {
    const commands = polygonToPathCommands([squareRing([0, 0], 2), squareRing([10, 0], 2)]);
    const moveCommands = commands.filter((command) => command.type === "moveTo");
    const closeCommands = commands.filter((command) => command.type === "closePath");

    expect(moveCommands).toHaveLength(2);
    expect(closeCommands).toHaveLength(2);
    expect(commands.findIndex((command) => command.type === "closePath")).toBeLessThan(
      lastIndexOfCommand(commands, "moveTo")
    );
  });

  it("uses fallback owner color for invalid or missing colors", () => {
    expect(ownerColorForClaim({})).toBe(FALLBACK_TERRITORY_COLOR);
    expect(ownerColorForClaim({ ownerColor: "blue" })).toBe(FALLBACK_TERRITORY_COLOR);
    expect(ownerColorForClaim({ ownerColor: "#ABCDEF" })).toBe("#abcdef");
  });
});

function claim(overrides: Partial<TerritoryClaimShape>): TerritoryClaimShape {
  const center = overrides.center ?? [0, 0];
  const radius = overrides.radius ?? 10;
  return {
    id: "claim",
    ownerId: "owner",
    ownerColor: "#d83a3a",
    center,
    radius,
    ring: createCircleRing(center, radius),
    ...overrides
  };
}

function squareRing(center: [number, number], radius: number): Ring {
  return [
    [center[0] - radius, center[1] - radius],
    [center[0] + radius, center[1] - radius],
    [center[0] + radius, center[1] + radius],
    [center[0] - radius, center[1] + radius],
    [center[0] - radius, center[1] - radius]
  ];
}

function maxEdgeLength(ring: Ring): number {
  let max = 0;
  for (let index = 1; index < ring.length; index += 1) {
    const previous = ring[index - 1];
    const current = ring[index];
    if (!previous || !current) {
      continue;
    }
    max = Math.max(max, Math.hypot(current[0] - previous[0], current[1] - previous[1]));
  }
  return max;
}

function maxX(polygons: Polygon[] | undefined): number {
  return Math.max(...(polygons?.flat(2).map(([x]) => x) ?? []));
}

function minX(polygons: Polygon[] | undefined): number {
  return Math.min(...(polygons?.flat(2).map(([x]) => x) ?? []));
}

function lastIndexOfCommand(
  commands: Array<{ type: string }>,
  type: string
): number {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    if (commands[index]?.type === type) {
      return index;
    }
  }
  return -1;
}
