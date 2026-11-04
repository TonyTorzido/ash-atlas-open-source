import { describe, expect, it } from "vitest";

import { destinationPoint, distanceMeters, type LatLon } from "@ash-atlas/shared";

import {
  allocateFlagArrivalPositions,
  FLAG_ARRIVAL_RADIUS_M,
  FlagArrivalReservations
} from "./flagArrivalAllocator.js";

const FLAG_CENTER = { lat: 35.0844, lon: -106.6504 } satisfies LatLon;

describe("flag arrival allocation", () => {
  it("places a solo arrival on the 75 metre ring using server randomness", () => {
    const north = allocateFlagArrivalPositions({
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: ["solo"],
      random: () => 0
    });
    const east = allocateFlagArrivalPositions({
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: ["solo"],
      random: () => 0.25
    });

    expect(distanceMeters(FLAG_CENTER, north[0]!.position)).toBeCloseTo(FLAG_ARRIVAL_RADIUS_M, 2);
    expect(distanceMeters(FLAG_CENTER, east[0]!.position)).toBeCloseTo(FLAG_ARRIVAL_RADIUS_M, 2);
    expect(distanceMeters(north[0]!.position, east[0]!.position)).toBeGreaterThan(105);
  });

  it.each([
    [2, 150],
    [3, 129.90],
    [4, 106.07],
    [5, 88.17],
    [8, 57.40]
  ])("spaces a %i-player party evenly without duplicate positions", (size, adjacentDistanceM) => {
    const playerIds = Array.from({ length: size }, (_, index) => `p${index}`);
    const arrivals = allocateFlagArrivalPositions({
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: playerIds,
      random: () => 0.37
    });

    expect(arrivals.map((arrival) => arrival.playerId)).toEqual(playerIds);
    expect(new Set(arrivals.map((arrival) => `${arrival.position.lat},${arrival.position.lon}`)).size).toBe(size);
    for (const arrival of arrivals) {
      expect(distanceMeters(FLAG_CENTER, arrival.position)).toBeCloseTo(75, 2);
    }
    for (let index = 0; index < arrivals.length; index += 1) {
      const next = (index + 1) % arrivals.length;
      expect(distanceMeters(arrivals[index]!.position, arrivals[next]!.position)).toBeCloseTo(
        adjacentDistanceM,
        1
      );
    }
  });

  it("keeps leader slot zero and follower slot ordering stable", () => {
    const order = ["leader", "follower-b", "follower-a"];
    const arrivals = allocateFlagArrivalPositions({
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: order,
      random: () => 0.5
    });

    expect(arrivals.map((arrival) => arrival.playerId)).toEqual(order);
    expect(arrivals[0]!.angleRadians).toBeCloseTo(Math.PI, 8);
    expect(arrivals[1]!.angleRadians).toBeCloseTo(Math.PI * 5 / 3, 8);
    expect(arrivals[2]!.angleRadians).toBeCloseTo(Math.PI / 3, 8);
  });

  it("rotates a solo arrival away from an existing occupant", () => {
    const occupant = destinationPoint(FLAG_CENTER, 75, 0);
    const [arrival] = allocateFlagArrivalPositions({
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: ["solo"],
      existingPlayerPositions: [occupant],
      random: () => 0
    });

    expect(distanceMeters(occupant, arrival!.position)).toBeCloseTo(150, 1);
  });

  it("rotates an evenly spaced party group to maximize clearance from occupants", () => {
    const occupant = destinationPoint(FLAG_CENTER, 75, 0);
    const arrivals = allocateFlagArrivalPositions({
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: ["leader", "follower"],
      existingPlayerPositions: [occupant],
      random: () => 0
    });

    expect(Math.min(...arrivals.map((arrival) => distanceMeters(arrival.position, occupant))))
      .toBeCloseTo(106.07, 1);
    expect(distanceMeters(arrivals[0]!.position, arrivals[1]!.position)).toBeCloseTo(150, 1);
  });

  it("reserves positions atomically so concurrent solo arrivals do not stack", () => {
    const reservations = new FlagArrivalReservations();
    const first = reservations.reserve({
      flagId: "flag-1",
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: ["first"],
      random: () => 0,
      now: 1_000
    });
    const second = reservations.reserve({
      flagId: "flag-1",
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: ["second"],
      random: () => 0,
      now: 1_001
    });

    expect(distanceMeters(first.allocations[0]!.position, second.allocations[0]!.position)).toBeCloseTo(150, 1);
    expect(reservations.reservedPositions("flag-1", 1_002)).toHaveLength(2);
    first.release();
    expect(reservations.reservedPositions("flag-1", 1_003)).toHaveLength(1);
    second.release();
    expect(reservations.reservedPositions("flag-1", 1_004)).toEqual([]);
  });

  it("tries alternate angles before changing radius", () => {
    const blockedNorth = destinationPoint(FLAG_CENTER, 75, 0);
    const [arrival] = allocateFlagArrivalPositions({
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: ["solo"],
      random: () => 0,
      validateCandidate: (candidate) => distanceMeters(candidate, blockedNorth) > 2
    });

    expect(arrival!.fallback).toBe(false);
    expect(distanceMeters(FLAG_CENTER, arrival!.position)).toBeCloseTo(75, 2);
    expect(distanceMeters(arrival!.position, blockedNorth)).toBeGreaterThan(2);
  });

  it("falls back through the 70-80 metre band when the preferred ring is invalid", () => {
    const [arrival] = allocateFlagArrivalPositions({
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: ["solo"],
      random: () => 0,
      validateCandidate: (candidate) => distanceMeters(FLAG_CENTER, candidate) >= 79
    });

    expect(arrival!.fallback).toBe(true);
    expect(arrival!.radiusM).toBe(80);
    expect(distanceMeters(FLAG_CENTER, arrival!.position)).toBeCloseTo(80, 2);
  });

  it("uses a safe, unique center fallback when no ring candidate is valid", () => {
    const arrivals = allocateFlagArrivalPositions({
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: ["leader", "follower"],
      random: () => 0,
      validateCandidate: () => false
    });

    expect(arrivals[0]!.position).toEqual(FLAG_CENTER);
    expect(distanceMeters(arrivals[0]!.position, arrivals[1]!.position)).toBeCloseTo(0.5, 1);
    expect(arrivals.every((arrival) => arrival.fallback)).toBe(true);
  });

  it("rejects duplicate arriving player IDs", () => {
    expect(() => allocateFlagArrivalPositions({
      flagCenter: FLAG_CENTER,
      arrivingPlayerIds: ["same", "same"]
    })).toThrow("unique");
  });
});
