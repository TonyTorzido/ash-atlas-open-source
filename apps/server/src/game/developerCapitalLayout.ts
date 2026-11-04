import { distanceMeters, destinationPoint } from "@ash-atlas/shared";

import { goblinVillageHexPositions } from "./goblinVillage.js";

type Position = Readonly<{ lat: number; lon: number }>;

/** Three full hex rings (37 slots) around the City Center. */
export const DEVELOPER_CAPITAL_FULL_RING_SLOTS = 37;
/** Closest ring-4 slots added to reach the ~50 flag capital footprint. */
export const DEVELOPER_CAPITAL_RING_FOUR_SLOTS = 13;
export const DEVELOPER_CAPITAL_FLAG_SLOTS =
  DEVELOPER_CAPITAL_FULL_RING_SLOTS + DEVELOPER_CAPITAL_RING_FOUR_SLOTS;

/**
 * Capital flag slots: slot 0 is the City Center, then rings 1-3, then the 13 ring-4
 * positions closest to the seat. Spacing matches goblinVillageHexPositions.
 */
export function developerCapitalFlagSlots(hall: Position, spacingM: number): Position[] {
  const all = goblinVillageHexPositions(hall, spacingM, 4);
  const inner = all.slice(0, DEVELOPER_CAPITAL_FULL_RING_SLOTS);
  const ringFour = all
    .slice(DEVELOPER_CAPITAL_FULL_RING_SLOTS)
    .map((position, index) => ({ position, index, distanceM: distanceMeters(hall, position) }))
    .sort((left, right) => left.distanceM - right.distanceM || left.index - right.index)
    .slice(0, DEVELOPER_CAPITAL_RING_FOUR_SLOTS)
    .sort((left, right) => left.index - right.index)
    .map(({ position }) => position);
  return [...inner, ...ringFour];
}

/**
 * Seat snap candidates: the anchor first, then rings every 25 m out to 500 m.
 * Callers pick the first candidate with legal land.
 */
export function developerCapitalSeatCandidates(anchor: Position): Position[] {
  const candidates: Position[] = [anchor];
  for (let distanceM = 25; distanceM <= 500; distanceM += 25) {
    for (let bearing = 0; bearing < 360; bearing += 30) {
      candidates.push(destinationPoint(anchor, distanceM, bearing));
    }
  }
  return candidates;
}

/**
 * Marks nodes reachable from node 0 (the City Center) through usable nodes whose
 * territory circles touch, matching the city flag network connectivity rule.
 */
export function developerCapitalConnectedNodes(
  nodes: ReadonlyArray<Readonly<{ position: Position; radiusM: number; usable: boolean }>>,
  toleranceM: number
): boolean[] {
  const connected = nodes.map(() => false);
  if (!nodes[0]?.usable) return connected;
  connected[0] = true;
  const queue = [0];
  while (queue.length > 0) {
    const current = nodes[queue.shift()!]!;
    for (const [index, node] of nodes.entries()) {
      if (connected[index] || !node.usable) continue;
      if (
        distanceMeters(current.position, node.position) <=
          current.radiusM + node.radiusM + toleranceM
      ) {
        connected[index] = true;
        queue.push(index);
      }
    }
  }
  return connected;
}
